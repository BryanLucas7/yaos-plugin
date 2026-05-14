import { Notice, type Plugin } from "obsidian";
import type { DiagnosticsService } from "./diagnostics/diagnosticsService";
import type { ConnectionController } from "./runtime/connectionController";
import type { SnapshotService } from "./snapshots/snapshotService";
import type { ReconcileMode, VaultSync } from "./sync/vaultSync";

export interface CommandsRuntimeHost {
	getVaultSync(): VaultSync | null;
	getConnectionController(): ConnectionController | null;
	getDiagnosticsService(): DiagnosticsService | null;
	getSnapshotService(): SnapshotService | null;
	getFilesNeedingAttentionText(): string;
	getUntrackedFileCount(): number;
	isDebugEnabled(): boolean;
	startQaFlightTrace(mode?: string): Promise<void>;
	stopQaFlightTrace(): Promise<void>;
	exportSafeFlightTrace(): Promise<void>;
	exportFullFlightTrace(): Promise<void>;
	showTimelineForCurrentFile(): void;
	clearFlightLogs(): Promise<void>;
	runReconciliation(mode: ReconcileMode): Promise<void>;
	runSchemaMigrationToV2(): void;
	runVfsTortureTest(): Promise<void>;
	importUntrackedFiles(): Promise<void>;
	publishObsidianProfilePackageNow(): Promise<void>;
	applyLatestObsidianProfilePackage(): Promise<void>;
	restorePreviousObsidianProfilePackage(): Promise<void>;
	clearLocalServerReceiptState(): Promise<"cleared_persistent" | "cleared_memory_only" | "failed" | undefined>;
	resetLocalCache(): void;
	nuclearReset(): void;
	exportFlightLogsToVault(): Promise<{ copied: number; skipped: number; errors: number; targetDir: string }>;
	buildLastBootSummaryText(): Promise<string>;
}

export function registerCommands(
	registrar: Pick<Plugin, "addCommand">,
	host: CommandsRuntimeHost,
): void {
	registrar.addCommand({
		id: "reconnect",
		name: "Reconnect to sync server",
		callback: () => {
			if (host.getVaultSync()) {
				host.getConnectionController()?.reconnect("manual-command");
				new Notice("Reconnecting...");
			}
		},
	});

	registrar.addCommand({
		id: "qa-flight-trace-start",
		name: "Start QA flight trace",
		callback: () => {
			void host.startQaFlightTrace();
		},
	});

	registrar.addCommand({
		id: "qa-flight-trace-stop",
		name: "Stop QA flight trace",
		callback: () => {
			void host.stopQaFlightTrace();
		},
	});

	registrar.addCommand({
		id: "qa-flight-trace-export-safe",
		name: "Export safe QA flight trace",
		callback: () => {
			void host.exportSafeFlightTrace();
		},
	});

	registrar.addCommand({
		id: "qa-flight-trace-export-full",
		name: "Export QA flight trace with filenames",
		callback: () => {
			void host.exportFullFlightTrace();
		},
	});

	registrar.addCommand({
		id: "qa-flight-trace-timeline-current-file",
		name: "Show timeline for current file",
		callback: () => {
			host.showTimelineForCurrentFile();
		},
	});

	registrar.addCommand({
		id: "qa-flight-trace-clear-logs",
		name: "Clear flight logs",
		callback: () => {
			void host.clearFlightLogs().then(() => {
				new Notice("Flight logs cleared.", 4000);
			});
		},
	});

	registrar.addCommand({
		id: "force-reconcile",
		name: "Force reconcile vault with sync state",
		callback: () => {
			const vaultSync = host.getVaultSync();
			if (!vaultSync) return;
			const mode = vaultSync.getSafeReconcileMode();
			void host.runReconciliation(mode);
		},
	});

	registrar.addCommand({
		id: "debug-status",
		name: "Show sync debug info",
		callback: () => {
			const info = host.getDiagnosticsService()?.buildDebugInfo() ?? "Sync not initialized";
			new Notice(info, 10000);
			console.debug("[yaos] Debug status:\n" + info);
		},
	});

	registrar.addCommand({
		id: "copy-debug",
		name: "Copy debug info to clipboard",
		callback: () => {
			const info = host.getDiagnosticsService()?.buildDebugInfo() ?? "Sync not initialized";
			navigator.clipboard.writeText(info).then(
				() => new Notice("Debug info copied to clipboard."),
				() => new Notice("Failed to copy to clipboard. Check console.", 5000),
			);
			console.debug("[yaos] Debug info:\n" + info);
		},
	});

	registrar.addCommand({
		id: "show-recent-events",
		name: "Show recent sync events",
		callback: () => {
			const text = host.getDiagnosticsService()?.buildRecentEventsText(80) ?? "No events recorded yet.";
			new Notice("Recent sync events printed to console.", 5000);
			console.debug("[yaos] Recent sync events:\n" + text);
		},
	});

	registrar.addCommand({
		id: "show-files-needing-attention",
		name: "Show files needing attention",
		callback: () => {
			const text = host.getFilesNeedingAttentionText();
			new Notice("Files needing attention printed to console.", 7000);
			console.debug("[yaos] Files needing attention:\n" + text);
		},
	});

	registrar.addCommand({
		id: "export-diagnostics",
		name: "Export sync diagnostics (safe)",
		callback: () => {
			void host.getDiagnosticsService()?.exportDiagnostics();
		},
	});

	registrar.addCommand({
		id: "export-diagnostics-with-filenames",
		name: "Export sync diagnostics with filenames",
		callback: () => {
			void host.getDiagnosticsService()?.exportDiagnosticsWithFilenames();
		},
	});

	registrar.addCommand({
		id: "migrate-schema-v2",
		name: "Migrate sync schema to v2",
		callback: () => {
			host.runSchemaMigrationToV2();
		},
	});

	registrar.addCommand({
		id: "debug-vfs-torture-test",
		name: "Run filesystem torture test (debug)",
		checkCallback: (checking: boolean) => {
			if (!host.isDebugEnabled()) return false;
			if (!checking) {
				void host.runVfsTortureTest();
			}
			return true;
		},
	});

	registrar.addCommand({
		id: "import-untracked",
		name: "Import untracked files now",
		callback: () => {
			if (!host.getVaultSync()) {
				new Notice("Sync not initialized");
				return;
			}
			const count = host.getUntrackedFileCount();
			if (count === 0) {
				new Notice("No untracked files to import.");
				return;
			}
			void host.importUntrackedFiles().then(() => {
				new Notice(`Imported ${count} untracked file(s).`);
			});
		},
	});

	registrar.addCommand({
		id: "publish-profile-package",
		name: "Publish Obsidian profile package now",
		callback: () => {
			void host.publishObsidianProfilePackageNow();
		},
	});

	registrar.addCommand({
		id: "apply-profile-package",
		name: "Apply latest PC profile package",
		callback: () => {
			void host.applyLatestObsidianProfilePackage();
		},
	});

	registrar.addCommand({
		id: "restore-profile-package-backup",
		name: "Restore previous Obsidian profile package",
		callback: () => {
			void host.restorePreviousObsidianProfilePackage();
		},
	});

	registrar.addCommand({
		id: "clear-local-server-receipt-state",
		name: "Clear local server-receipt state",
		callback: () => {
			const vaultSync = host.getVaultSync();
			if (!vaultSync) {
				new Notice("Sync not initialized");
				return;
			}
			void host.clearLocalServerReceiptState().then(
				(result) => new Notice(
					result === "cleared_persistent"
						? "Local server-receipt state cleared."
						: result === "cleared_memory_only"
							? "Local server-receipt state cleared for this session. Persistent receipt store is unavailable."
							: "Failed to clear local server-receipt state. Check console.",
					result === "cleared_persistent" ? 4000 : 7000,
				),
				() => new Notice("Failed to clear local server-receipt state. Check console.", 5000),
			);
		},
	});

	registrar.addCommand({
		id: "reset-cache",
		name: "Reset local cache (re-sync from server)",
		callback: () => {
			host.resetLocalCache();
		},
	});

	registrar.addCommand({
		id: "snapshot-now",
		name: "Take snapshot now",
		callback: async () => {
			await host.getSnapshotService()?.takeSnapshotNow();
		},
	});

	registrar.addCommand({
		id: "snapshot-list",
		name: "Browse and restore snapshots",
		callback: async () => {
			await host.getSnapshotService()?.showSnapshotList();
		},
	});

	registrar.addCommand({
		id: "nuclear-reset",
		name: "Nuclear reset (wipe sync state and reseed from disk)",
		callback: () => {
			host.nuclearReset();
		},
	});

	registrar.addCommand({
		id: "export-flight-logs-to-vault",
		name: "Export flight logs to vault (for mobile diagnostics)",
		callback: () => {
			void host.exportFlightLogsToVault().then(
				(result) => new Notice(
					`YAOS: mirrored flight logs → ${result.targetDir}/ — copied=${result.copied} skipped=${result.skipped} errors=${result.errors}.`,
					9000,
				),
				(err) => {
					console.error("[yaos] export-flight-logs-to-vault failed", err);
					new Notice("YAOS: failed to export flight logs. See console.", 7000);
				},
			);
		},
	});

	registrar.addCommand({
		id: "copy-last-boot-summary",
		name: "Copy last boot summary to clipboard",
		callback: () => {
			void host.buildLastBootSummaryText().then(
				(text) => navigator.clipboard.writeText(text).then(
					() => new Notice("YAOS: last boot summary copied to clipboard.", 4000),
					() => {
						console.debug("[yaos] last boot summary:\n" + text);
						new Notice("YAOS: clipboard unavailable — printed to console.", 6000);
					},
				),
				(err) => {
					console.error("[yaos] buildLastBootSummaryText failed", err);
					new Notice("YAOS: failed to build last boot summary. See console.", 7000);
				},
			);
		},
	});
}
