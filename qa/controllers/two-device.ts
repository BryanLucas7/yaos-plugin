#!/usr/bin/env bun
/**
 * qa:two-device — Run a two-device QA scenario against two live Obsidian instances.
 *
 * Usage:
 *   bun run qa:two-device --scenario offline-handoff-create \
 *     --port-a 9222 --port-b 9223 \
 *     --vault-a /path/to/vault-a --vault-b /path/to/vault-b \
 *     [--trace qa-safe] [--out-dir qa-runs/]
 *
 * Both Obsidian instances must be started with:
 *   /path/to/Obsidian --remote-debugging-port=922X --user-data-dir=/tmp/obs-X
 *
 * Exit code 0 = PASS on both devices. Exit code 1 = any failure.
 */

import { resolve, join } from "path";
import { existsSync, readFileSync } from "fs";
import { ObsidianClient } from "./obsidian-client";
import { ArtifactCollector } from "./collect-artifacts";
import { analyzeTrace } from "../analyzers/analyzer";
import { formatReport } from "../analyzers/report";

function parseArgs(args: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--") && args[i + 1] && !args[i + 1]!.startsWith("--")) {
			result[a.slice(2)] = args[i + 1]!;
			i++;
		}
	}
	return result;
}

// -----------------------------------------------------------------------
// Two-device scenario definitions
// -----------------------------------------------------------------------

type TwoDeviceScenarioFn = (
	a: ObsidianClient,
	b: ObsidianClient,
	log: (msg: string) => void,
) => Promise<{ passedA: boolean; passedB: boolean; errors: string[] }>;

const TWO_DEVICE_SCENARIOS: Record<string, TwoDeviceScenarioFn> = {
	/**
	 * Offline handoff:
	 *   A creates file while B is offline → A confirms receipt → B reconnects → B has file
	 */
	"offline-handoff-create": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s02-two-device-offline-handoff.md";

		// 1. Hard offline hold on B — blocks ALL auto-reconnect paths
		log("Device B: activating offline hold…");
		await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("offline")`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForProviderDisconnected(10000)`);
		log("Device B: provider disconnected.");

		// 2. A creates the file and waits for server receipt
		log("Device A: creating file…");
		await a.evalRaw(
			`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, "# Offline Handoff\\n\\nCreated on A while B offline.\\n")`
		);
		log("Device A: waiting for server receipt…");
		try {
			const actionTs = Date.now();
			await a.evalRaw(`
				(async () => {
					const d = window.__YAOS_DEBUG__;
					if (!d) throw new Error("no debug API on A");
					await d.waitForReceiptAfter(${actionTs}, 30000);
				})()
			`);
			log("Device A: receipt confirmed ✓");
		} catch (e) {
			errors.push(`Device A receipt wait failed: ${String(e)}`);
		}

		// 3. Release B offline hold and reconnect
		log("Device B: releasing offline hold and reconnecting…");
		await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("online")`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(30000)`).catch((e: unknown) => {
			errors.push(`Device B idle wait after reconnect failed: ${String(e)}`);
		});
		log("Device B: reconnected and idle.");

		// 4. Assert file arrived on B
		const fileExistsOnB = await b.evalRaw<boolean>(
			`app.vault.getAbstractFileByPath(${JSON.stringify(scratch)}) !== null`,
		).catch(() => false);

		if (!fileExistsOnB) {
			errors.push(`File did not arrive on device B after reconnect: ${scratch}`);
		} else {
			log("Device B: file arrived ✓");
		}

		// 5. Assert disk == CRDT on B
		if (fileExistsOnB) {
			const diskEqCrdt = await b.evalRaw<boolean>(`
				(async () => {
					const d = window.__YAOS_DEBUG__;
					if (!d) return false;
					const dh = await d.getDiskHash(${JSON.stringify(scratch)});
					const ch = await d.getCrdtHash(${JSON.stringify(scratch)});
					return dh !== null && dh === ch;
				})()
			`).catch(() => false);
			if (!diskEqCrdt) {
				errors.push(`Device B: disk != CRDT for ${scratch} after sync`);
			} else {
				log("Device B: disk == CRDT ✓");
			}
		}

		// Cleanup
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});
		await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	/**
	 * Delete does not resurrect:
	 *   B goes stale → A deletes and confirms → B reconnects → file must NOT reappear
	 */
	"delete-does-not-resurrect": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s03-two-device-delete.md";

		// Setup: create on A, wait for sync to both
		log("Device A: creating test file…");
		await a.evalRaw(
			`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, "# S03 Two-Device Delete\\n")`
		);
		const actionTs = Date.now();
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForReceiptAfter(${actionTs}, 30000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 20000)`);

		// Verify B has the file
		const existsOnBBefore = await b.evalRaw<boolean>(
			`app.vault.getAbstractFileByPath(${JSON.stringify(scratch)}) !== null`,
		).catch(() => false);
		if (!existsOnBBefore) {
			errors.push("File did not sync to device B before delete test");
		}

		// Hard offline hold on B (B goes stale — all reconnect paths blocked)
		log("Device B: activating offline hold (going stale)…");
		await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("offline")`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForProviderDisconnected(10000)`);
		log("Device B: disconnected.");

		// A deletes and confirms
		log("Device A: deleting file…");
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`);
		await a.evalRaw(`window.__YAOS_QA__?.waitForIdle(10000)`);
		log("Device A: file deleted.");

		// Release B's offline hold
		log("Device B: releasing offline hold…");
		await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("online")`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(20000)`).catch((e: unknown) => {
			errors.push(`Device B idle wait after reconnect failed: ${String(e)}`);
		});
		log("Device B: reconnected.");

		// Assert file is ABSENT on B
		const existsOnBAfter = await b.evalRaw<boolean>(
			`app.vault.getAbstractFileByPath(${JSON.stringify(scratch)}) !== null`,
		).catch(() => false);
		if (existsOnBAfter) {
			errors.push("RESURRECT BUG: file still present on device B after delete on device A");
		} else {
			log("Device B: file correctly absent ✓");
		}

		// Cleanup
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});
		await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},
};

// -----------------------------------------------------------------------
// Collect trace from vault and run analyzer
// -----------------------------------------------------------------------

async function collectAndAnalyze(
	client: ObsidianClient,
	collector: ArtifactCollector,
	vaultPath: string | null,
	device: string,
	scenario: string,
	log: (msg: string) => void,
): Promise<boolean> {
	let analyzerPassed = true;
	try {
		const tracePath = await client.stopAndExportTrace("safe");
		log(`Device ${device} trace export path: ${tracePath}`);

		if (tracePath && vaultPath) {
			const fullTracePath = tracePath.startsWith("/")
				? tracePath
				: join(vaultPath, ".obsidian", tracePath);
			await collector.collectTrace(fullTracePath).catch((e) =>
				log(`Warning: could not collect trace for ${device}: ${e}`),
			);

			const traceInArtifacts = join(collector.runDirectory, "flight-trace.ndjson");
			if (existsSync(traceInArtifacts)) {
				const raw = readFileSync(traceInArtifacts, "utf-8");
				const report = analyzeTrace(raw, { traceFile: traceInArtifacts, scenarioId: scenario });
				await collector.saveAnalyzerReport(report);
				log(`Device ${device} analyzer: ${report.passed ? "PASS" : "FAIL"}`);
				log(formatReport(report));
				if (!report.passed) analyzerPassed = false;
			}
		}
	} catch (e) {
		log(`Warning: trace collection failed for device ${device}: ${String(e)}`);
	}
	return analyzerPassed;
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const scenario = args.scenario;
	const portA = Number(args["port-a"] ?? 9222);
	const portB = Number(args["port-b"] ?? 9223);
	const vaultA = args["vault-a"] ? resolve(args["vault-a"]) : null;
	const vaultB = args["vault-b"] ? resolve(args["vault-b"]) : null;
	const traceMode = args.trace ?? "qa-safe";
	const outDir = resolve(args["out-dir"] ?? "qa-runs");

	if (!scenario) {
		console.error(
			"Usage: bun run qa:two-device --scenario <id> --port-a 9222 --port-b 9223 " +
			"[--vault-a /path] [--vault-b /path] [--trace qa-safe] [--out-dir qa-runs/]",
		);
		console.error("Available scenarios:", Object.keys(TWO_DEVICE_SCENARIOS).join(", "));
		process.exit(1);
	}

	const scenarioFn = TWO_DEVICE_SCENARIOS[scenario];
	if (!scenarioFn) {
		console.error(`Unknown two-device scenario: ${scenario}`);
		console.error("Available:", Object.keys(TWO_DEVICE_SCENARIOS).join(", "));
		process.exit(1);
	}

	const collectorA = new ArtifactCollector(outDir, scenario, "A", vaultA ?? "unknown");
	const collectorB = new ArtifactCollector(outDir, scenario, "B", vaultB ?? "unknown");
	await collectorA.init();
	await collectorB.init();

	const logLines: string[] = [];
	function log(msg: string): void {
		const line = `[${new Date().toISOString()}] ${msg}`;
		console.log(line);
		logLines.push(line);
	}

	const clientA = new ObsidianClient({ port: portA });
	const clientB = new ObsidianClient({ port: portB });

	try {
		log(`Connecting to Obsidian A (port ${portA})…`);
		await clientA.connect();
		log(`Connecting to Obsidian B (port ${portB})…`);
		await clientB.connect();
		log("Connected to both instances.");

		log("Waiting for QA APIs on both devices…");
		await Promise.all([clientA.waitForQaReady(30_000), clientB.waitForQaReady(30_000)]);
		log("QA APIs ready on both devices.");

		// Pre-run manifests
		const [maniA, maniB] = await Promise.all([
			clientA.manifest().catch(() => null),
			clientB.manifest().catch(() => null),
		]);
		if (maniA) await collectorA.saveManifest(maniA, "manifest-pre");
		if (maniB) await collectorB.saveManifest(maniB, "manifest-pre");
		log("Pre-run manifests saved.");

		// Start traces
		await clientA.startTrace(traceMode);
		await clientB.startTrace(traceMode);
		log(`Flight traces started (mode=${traceMode}) on both devices.`);

		// Run the two-device scenario
		log(`Running two-device scenario: ${scenario}…`);
		const start = Date.now();
		const { passedA, passedB, errors } = await scenarioFn(clientA, clientB, log);
		const durationMs = Date.now() - start;
		log(`Scenario done in ${durationMs}ms. A: ${passedA ? "PASS" : "FAIL"}, B: ${passedB ? "PASS" : "FAIL"}`);
		if (errors.length > 0) {
			for (const e of errors) log(`  ERROR: ${e}`);
		}

		// Collect post-run manifests
		const [postManiA, postManiB] = await Promise.all([
			clientA.manifest().catch(() => null),
			clientB.manifest().catch(() => null),
		]);
		if (postManiA) await collectorA.saveManifest(postManiA, "manifest-post");
		if (postManiB) await collectorB.saveManifest(postManiB, "manifest-post");
		log("Post-run manifests saved.");

		// Collect traces and run analyzer on each
		const [analyzerPassedA, analyzerPassedB] = await Promise.all([
			collectAndAnalyze(clientA, collectorA, vaultA, "A", scenario, log),
			collectAndAnalyze(clientB, collectorB, vaultB, "B", scenario, log),
		]);

		const overallPassed = passedA && passedB && analyzerPassedA && analyzerPassedB;
		const result = { passed: overallPassed, durationMs, errors, warnings: [] as string[] };
		if (!analyzerPassedA) result.errors.push("Device A: analyzer found hard failures");
		if (!analyzerPassedB) result.errors.push("Device B: analyzer found hard failures");

		await collectorA.saveResult({ passed: passedA && analyzerPassedA, durationMs, errors, warnings: [] });
		await collectorB.saveResult({ passed: passedB && analyzerPassedB, durationMs, errors, warnings: [] });

		await collectorA.writeLog(logLines.join("\n"));
		log(`Artifacts A: ${collectorA.runDirectory}`);
		log(`Artifacts B: ${collectorB.runDirectory}`);

		process.exit(overallPassed ? 0 : 1);
	} catch (err) {
		log(`Fatal error: ${String(err)}`);
		await collectorA.writeLog(logLines.join("\n"));
		process.exit(1);
	} finally {
		await clientA.close();
		await clientB.close();
	}
}

await main();
