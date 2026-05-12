/**
 * YAOS QA Harness — Obsidian plugin entry point.
 *
 * This plugin:
 *   1. Registers window.__YAOS_QA__ with the full QaConsoleApi
 *   2. Registers Obsidian commands for common QA operations
 *   3. Loads all known scenarios into the registry
 *
 * Install this plugin alongside YAOS in a QA vault with qaDebugMode enabled.
 * DO NOT use in production vaults.
 */

import { Plugin, Notice } from "obsidian";
import { buildQaConsoleApi } from "./api";
import type { QaScenario } from "./types";

// Scenario imports
import { s01SingleDeviceBasicEdit } from "./scenarios/s01-single-device-basic-edit";
import { s02OfflineHandoffCreate } from "./scenarios/s02-offline-handoff-create";
import { s03DeleteDoesNotResurrect } from "./scenarios/s03-delete-does-not-resurrect";
import { s04aBulkImportSmoke, s04bBulkImportStorm } from "./scenarios/s04-bulk-import-after-delete";
import { s05aFrontmatterClosedFile, s05bFrontmatterOpenEditor } from "./scenarios/s05-frontmatter-safety-loop";

const ALL_SCENARIOS: QaScenario[] = [
	s01SingleDeviceBasicEdit,
	s02OfflineHandoffCreate,
	s03DeleteDoesNotResurrect,
	s04aBulkImportSmoke,
	s04bBulkImportStorm,
	s05aFrontmatterClosedFile,
	s05bFrontmatterOpenEditor,
];

export default class YaosQaHarnessPlugin extends Plugin {
	private scenarioRegistry = new Map<string, QaScenario>();

	async onload(): Promise<void> {
		// Register all scenarios
		for (const scenario of ALL_SCENARIOS) {
			this.scenarioRegistry.set(scenario.id, scenario);
		}

		// Mount global API
		const api = buildQaConsoleApi(this.app, this.scenarioRegistry);
		(window as unknown as Record<string, unknown>).__YAOS_QA__ = api;

		new Notice("YAOS QA Harness loaded. window.__YAOS_QA__ is available.", 5000);
		console.log(
			"[YAOS QA] Harness loaded. " +
			`${this.scenarioRegistry.size} scenarios registered. ` +
			"Type YAOS_QA.help() in console.",
		);

		// Register command-palette commands
		this.addCommand({
			id: "qa-help",
			name: "Show QA harness help",
			callback: () => {
				(window as unknown as Record<string, unknown>).__YAOS_QA__ &&
					(api as { help: () => void }).help();
			},
		});

		this.addCommand({
			id: "qa-list-scenarios",
			name: "List QA scenarios",
			callback: () => {
				const ids = api.scenarios();
				new Notice(`QA scenarios (${ids.length}):\n${ids.join(", ")}`, 8000);
				console.log("[YAOS QA] Scenarios:", ids);
			},
		});

		this.addCommand({
			id: "qa-start-trace",
			name: "Start QA flight trace (qa-safe)",
			callback: async () => {
				await api.startTrace("qa-safe");
				new Notice("QA trace started (qa-safe).", 3000);
			},
		});

		this.addCommand({
			id: "qa-stop-trace",
			name: "Stop QA flight trace",
			callback: async () => {
				await api.stopTrace();
				new Notice("QA trace stopped.", 3000);
			},
		});

		this.addCommand({
			id: "qa-export-trace-safe",
			name: "Export QA flight trace (safe)",
			callback: async () => {
				try {
					const path = await api.exportTrace("safe");
					new Notice(`Trace exported: ${path.split("/").pop()}`, 6000);
				} catch (err) {
					new Notice(`Trace export failed: ${String(err)}`, 8000);
				}
			},
		});

		this.addCommand({
			id: "qa-vault-manifest",
			name: "Print vault manifest to console",
			callback: async () => {
				const m = await api.manifest();
				console.log("[YAOS QA] Vault manifest:", JSON.stringify(m, null, 2));
				new Notice(`Vault manifest: ${m.fileCount} files (see console).`, 5000);
			},
		});

		// Register per-scenario commands for quick manual runs
		for (const [id] of this.scenarioRegistry) {
			const scenarioId = id;
			this.addCommand({
				id: `qa-run-${scenarioId}`,
				name: `Run QA scenario: ${scenarioId}`,
				callback: async () => {
					new Notice(`Running scenario: ${scenarioId}…`, 3000);
					const result = await api.run(scenarioId);
					if (result.passed) {
						new Notice(`✓ PASS: ${scenarioId} (${result.durationMs}ms)`, 5000);
					} else {
						new Notice(
							`✗ FAIL: ${scenarioId}\n${result.errors.slice(0, 2).join("\n")}`,
							10000,
						);
					}
				},
			});
		}
	}

	onunload(): void {
		delete (window as unknown as Record<string, unknown>).__YAOS_QA__;
		console.log("[YAOS QA] Harness unloaded.");
	}
}
