/**
 * QA harness API implementation.
 * Registered as window.__YAOS_QA__ by the harness plugin.
 */

import type { App } from "obsidian";
import type { YaosQaDebugApi } from "../../src/qaDebugApi";
import type {
	QaConsoleApi,
	QaContext,
	QaResult,
	QaRunOptions,
	QaScenario,
	VaultManifest,
	ManifestDiff,
} from "./types";
import { sleep, waitForIdle, waitForMemoryReceipt, waitForFile } from "./wait";
import {
	createFile,
	modifyFile,
	appendToFile,
	deleteFile,
	renameFile,
	writeAdapterFile,
	deleteAdapterFile,
} from "./vault-ops";
import {
	openFile,
	closeFile,
	typeIntoFile,
	replaceFileContent,
	runCommand,
} from "./editor-ops";
import {
	assertFileExists,
	assertFileNotExists,
	assertFileContent,
	assertFileHash,
	assertDiskEqualsCrdt,
	assertNoConflictCopies,
} from "./assertions";
import { buildVaultManifest, diffManifests } from "./manifest-builder";

const DEFAULT_IDLE_TIMEOUT = 15_000;
const DEFAULT_RECEIPT_TIMEOUT = 30_000;
const DEFAULT_FILE_TIMEOUT = 15_000;

function getYaos(): YaosQaDebugApi {
	const api = (window as unknown as Record<string, unknown>).__YAOS_DEBUG__ as YaosQaDebugApi | undefined;
	if (!api) throw new Error("window.__YAOS_DEBUG__ not found — is YAOS loaded with qaDebugMode enabled?");
	return api;
}

function buildContext(app: App): QaContext {
	const yaos = getYaos();
	return {
		app,
		yaos,

		createFile: (path, content) => createFile(app, path, content),
		modifyFile: (path, content) => modifyFile(app, path, content),
		appendToFile: (path, text) => appendToFile(app, path, text),
		deleteFile: (path, mode) => deleteFile(app, path, mode),
		renameFile: (old, next) => renameFile(app, old, next),

		writeAdapterFile: (path, content) => writeAdapterFile(app, path, content),
		deleteAdapterFile: (path) => deleteAdapterFile(app, path),

		openFile: (path) => openFile(app, path),
		closeFile: (path) => closeFile(app, path),
		typeIntoFile: (path, text) => typeIntoFile(app, path, text),
		replaceFileContent: (path, content) => replaceFileContent(app, path, content),
		runCommand: (id) => runCommand(app, id),

		waitForIdle: (ms) => waitForIdle(yaos, ms ?? DEFAULT_IDLE_TIMEOUT),
		waitForMemoryReceipt: (ms) => waitForMemoryReceipt(yaos, ms ?? DEFAULT_RECEIPT_TIMEOUT),
		waitForFile: (path, ms) => waitForFile(yaos, path, ms ?? DEFAULT_FILE_TIMEOUT),
		sleep,

		assert: {
			fileExists: (path) => assertFileExists(app, path),
			fileNotExists: (path) => assertFileNotExists(app, path),
			fileContent: (path, content) => assertFileContent(app, path, content),
			fileHash: (path, hash) => assertFileHash(app, yaos, path, hash),
			diskEqualsCrdt: (path) => assertDiskEqualsCrdt(yaos, path),
			noConflictCopies: (dir) => assertNoConflictCopies(app, dir),
		},
	};
}

export function buildQaConsoleApi(app: App, scenarioRegistry: Map<string, QaScenario>): QaConsoleApi {

	const api: QaConsoleApi = {
		help(): void {
			const methods = [
				"help()                             — show this message",
				"scenarios()                        — list registered scenario IDs",
				"run(id, opts?)                     — run a scenario",
				"createFile(path, content)          — create/overwrite via Obsidian API",
				"modifyFile(path, content)          — modify via Obsidian API",
				"appendToFile(path, text)           — append via Obsidian API",
				"deleteFile(path)                   — delete via Obsidian API",
				"renameFile(old, new)               — rename via Obsidian API",
			"writeAdapterFile(path, content)    — write via Obsidian adapter (NOT real external; use Node controller for true external)",
			"deleteAdapterFile(path)            — delete via Obsidian adapter",
				"openFile(path)                     — open in MarkdownView",
				"closeFile(path)                    — close leaf",
				"typeIntoFile(path, text)           — type character-by-character into editor",
				"replaceFileContent(path, content)  — editor.setValue() (blunt — setup only)",
				"runCommand(commandId)              — execute Obsidian command",
				"waitForIdle(ms?)                   — wait for YAOS idle state",
				"yaos.getReceiptSnapshot()          — snapshot receipt state before an action",
			"yaos.waitForReceiptAfter(ts, ms)   — action-relative receipt wait (preferred)",
			"yaos.disconnectProvider(reason?)   — real offline disconnect",
			"yaos.connectProvider(reason?)      — reconnect provider",
			"yaos.waitForProviderDisconnected(ms) — wait for confirmed disconnect",
			"waitForMemoryReceipt(ms?)          — [deprecated] global receipt wait (use yaos.waitForReceiptAfter)",
				"waitForFile(path, ms?)             — wait for file to appear on disk",
				"assertFileExists(path)             — throws if not found",
				"assertFileNotExists(path)          — throws if found",
				"assertFileHash(path, hash)         — throws if disk hash mismatches",
				"assertDiskEqualsCrdt(path)         — throws if disk ≠ CRDT",
				"assertNoConflictCopies(dir?)       — throws if conflict copies found",
				"manifest()                         — snapshot current vault",
				"compareManifest(expected)          — diff two manifests",
				"startTrace(mode?, secret?)         — start QA flight trace",
				"stopTrace()                        — stop flight trace",
				"exportTrace(privacy?)              — export flight trace (returns path)",
				"plugins()                          — list installed plugins",
			];
			console.log("[YAOS QA]\n" + methods.join("\n"));
		},

		scenarios(): string[] {
			return [...scenarioRegistry.keys()];
		},

		async run(id, opts?: QaRunOptions): Promise<QaResult> {
			const scenario = scenarioRegistry.get(id);
			if (!scenario) {
				return { id, passed: false, durationMs: 0, errors: [`Unknown scenario: ${id}`], warnings: [] };
			}
			const ctx = buildContext(app);
			const errors: string[] = [];
			const warnings: string[] = [];
			const start = Date.now();

			try {
				await scenario.setup(ctx);
				await scenario.run(ctx);
				await scenario.assert(ctx);
			} catch (err) {
				errors.push(err instanceof Error ? err.message : String(err));
			} finally {
				try {
					await scenario.cleanup?.(ctx);
				} catch (cleanErr) {
					warnings.push(`cleanup error: ${String(cleanErr)}`);
				}
			}

			const durationMs = Date.now() - start;
			const passed = errors.length === 0;
			const result: QaResult = { id, passed, durationMs, errors, warnings };
			const icon = passed ? "✓" : "✗";
			console.log(`[YAOS QA] ${icon} ${id} (${durationMs}ms)${errors.length ? "\n  " + errors.join("\n  ") : ""}`);
			return result;
		},

		// Vault ops
		createFile: (path, content) => createFile(app, path, content),
		modifyFile: (path, content) => modifyFile(app, path, content),
		appendToFile: (path, text) => appendToFile(app, path, text),
		deleteFile: (path, mode) => deleteFile(app, path, mode),
		renameFile: (old, next) => renameFile(app, old, next),
		writeAdapterFile: (path, content) => writeAdapterFile(app, path, content),
		deleteAdapterFile: (path) => deleteAdapterFile(app, path),

		// Editor ops
		openFile: (path) => openFile(app, path),
		closeFile: (path) => closeFile(app, path),
		typeIntoFile: (path, text, opts) => typeIntoFile(app, path, text, opts),
		replaceFileContent: (path, content) => replaceFileContent(app, path, content),
		runCommand: (id) => runCommand(app, id),

		// Wait
		waitForIdle: (ms) => waitForIdle(getYaos(), ms ?? DEFAULT_IDLE_TIMEOUT),
		waitForMemoryReceipt: (ms) => waitForMemoryReceipt(getYaos(), ms ?? DEFAULT_RECEIPT_TIMEOUT),
		waitForFile: (path, ms) => waitForFile(getYaos(), path, ms ?? DEFAULT_FILE_TIMEOUT),

		// Assertions
		assertFileExists: (path) => assertFileExists(app, path),
		assertFileNotExists: (path) => assertFileNotExists(app, path),
		assertFileHash: (path, hash) => assertFileHash(app, getYaos(), path, hash),
		assertDiskEqualsCrdt: (path) => assertDiskEqualsCrdt(getYaos(), path),
		assertNoConflictCopies: (dir) => assertNoConflictCopies(app, dir),

		// Manifests
		manifest: () => buildVaultManifest(app),
		async compareManifest(expected: VaultManifest): Promise<ManifestDiff> {
			const current = await buildVaultManifest(app);
			return diffManifests(expected, current);
		},

		// Flight trace
		async startTrace(mode = "qa-safe", secret?: string): Promise<void> {
			await getYaos().startFlightTrace(mode, secret);
		},
		async stopTrace(): Promise<void> {
			await getYaos().stopFlightTrace();
		},
		async exportTrace(privacy: "safe" | "full" = "safe"): Promise<string> {
			return getYaos().exportFlightTrace(privacy);
		},

		// Plugin state
		plugins() {
			const installedPlugins = (app as unknown as {
				plugins: { plugins: Record<string, { manifest: { version: string } }> };
			}).plugins.plugins;
			return Object.entries(installedPlugins).map(([id, p]) => ({
				id,
				version: p.manifest.version,
				enabled: true,
			}));
		},
	};

	return api;
}
