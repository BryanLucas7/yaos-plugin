/**
 * YAOS QA Debug API
 *
 * Exposes a narrow, deterministic control surface for the QA harness.
 * Only registered when settings.qaDebugMode is true.
 * NEVER enable in production vaults.
 *
 * Usage (Obsidian DevTools console):
 *   const api = window.__YAOS_DEBUG__;
 *   await api.waitForIdle(10000);
 *   const hash = await api.getDiskHash("Notes/test.md");
 */

import type { App } from "obsidian";
import type { VaultSync } from "./sync/vaultSync";
import type { ReconciliationController } from "./runtime/reconciliationController";
import type { ConnectionController } from "./runtime/connectionController";
import type { FlightTraceController } from "./debug/flightTraceController";
import { yTextToString } from "./utils/format";

export interface ReceiptSnapshot {
	/** Opaque ID of the current unconfirmed candidate. Null if none. */
	candidateId: string | null;
	/** Timestamp (ms) when the current candidate was captured. Null if no candidate. */
	capturedAt: number | null;
	/** ID of the last candidate that the server confirmed. Null if never confirmed. */
	lastConfirmedCandidateId: string | null;
	/** Timestamp (ms) of the last confirmed server receipt echo. Null if never confirmed. */
	lastConfirmedAt: number | null;
}

export interface YaosQaDebugApi {
	// Readiness
	isLocalReady(): boolean;
	isProviderSynced(): boolean;
	isProviderConnected(): boolean;
	isReconciled(): boolean;
	isReconcileInFlight(): boolean;

	// Provider control — for real offline simulation in QA scenarios
	disconnectProvider(reason?: string): void;
	connectProvider(reason?: string): void;
	/**
	 * Hard offline hold: blocks ALL reconnect paths (visibility handler, network
	 * handler, reconnect timer, manual reconnect) until explicitly released.
	 * Use this instead of disconnectProvider() for reliable offline simulation.
	 */
	setQaNetworkHold(mode: "offline" | "online"): void;

	// Wait helpers (resolve when condition true, reject on timeout)
	waitForLocalReady(timeoutMs: number): Promise<void>;
	waitForProviderSynced(timeoutMs: number): Promise<void>;
	waitForProviderDisconnected(timeoutMs: number): Promise<void>;
	waitForReconciled(timeoutMs: number): Promise<void>;
	/** local ready + provider synced + reconciled + no reconcile in flight */
	waitForIdle(timeoutMs: number): Promise<void>;
	/**
	 * Waits for a server receipt that was confirmed AFTER `afterTimestamp`.
	 * Use this instead of the global `waitForMemoryReceipt()` to avoid
	 * false-passes from stale confirmations.
	 */
	waitForReceiptAfter(afterTimestamp: number, timeoutMs: number): Promise<void>;
	/** Snapshot the current receipt state for action-relative waiting. */
	getReceiptSnapshot(): ReceiptSnapshot;
	/** @deprecated Use waitForReceiptAfter(timestamp). This checks global state and can give false-passes. */
	waitForMemoryReceipt(timeoutMs: number): Promise<void>;
	/** File appears in the vault (disk) */
	waitForFile(path: string, timeoutMs: number): Promise<void>;

	// Content hashes (SHA-256 hex)
	getDiskHash(path: string): Promise<string | null>;
	getCrdtHash(path: string): Promise<string | null>;
	getEditorHash(path: string): Promise<string | null>;

	// Path sets
	getActiveMarkdownPaths(): string[];
	getDiskMarkdownPaths(): string[];

	// Status
	getServerReceiptState(): "confirmed" | "pending" | "unknown" | "no-candidate";
	getConnectionState(): string;

	// Flight trace
	startFlightTrace(mode: string, secret?: string): Promise<void>;
	stopFlightTrace(): Promise<void>;
	exportFlightTrace(privacy: "safe" | "full"): Promise<string>;

	// Force operations
	forceReconcile(): Promise<void>;
	forceReconnect(): void;
}

// -----------------------------------------------------------------------
// Plugin interface — only the properties we actually touch
// -----------------------------------------------------------------------

interface PluginHandle {
	app: App;
	getVaultSync(): VaultSync | null;
	getReconciliationController(): ReconciliationController;
	getConnectionController(): ConnectionController | null;
	getFlightTraceController(): FlightTraceController | null;
	getDiagnosticsDir(): Promise<string | undefined> | undefined;
	sha256Hex(text: string): Promise<string>;
	startQaFlightTrace(mode?: string): Promise<void>;
	stopQaFlightTrace(): Promise<void>;
	exportFlightTrace(privacy: "safe" | "full"): Promise<string | null>;
	runReconciliation(): Promise<void>;
	disconnectProvider(reason?: string): void;
	connectProvider(reason?: string): void;
}

// -----------------------------------------------------------------------
// Internal poll helper
// -----------------------------------------------------------------------

function waitFor(
	predicate: () => boolean,
	intervalMs: number,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (predicate()) {
			resolve();
			return;
		}
		const start = Date.now();
		const timer = setInterval(() => {
			if (predicate()) {
				clearInterval(timer);
				resolve();
				return;
			}
			if (Date.now() - start >= timeoutMs) {
				clearInterval(timer);
				reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
			}
		}, intervalMs);
	});
}

// -----------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------

export function buildQaDebugApi(plugin: PluginHandle): YaosQaDebugApi {
	const { app } = plugin;
	const POLL_INTERVAL = 250;

	async function sha256(text: string): Promise<string> {
		return plugin.sha256Hex(text);
	}

	const api: YaosQaDebugApi = {
		// -- Readiness ----------------------------------------------------------

		isLocalReady(): boolean {
			return plugin.getVaultSync()?.localReady ?? false;
		},

		isProviderSynced(): boolean {
			return plugin.getVaultSync()?.providerSynced ?? false;
		},

		isProviderConnected(): boolean {
			return plugin.getVaultSync()?.connected ?? false;
		},

		disconnectProvider(reason?: string): void {
			plugin.disconnectProvider(reason ?? "qa-disconnect");
		},

		connectProvider(reason?: string): void {
			plugin.connectProvider(reason ?? "qa-connect");
		},

		setQaNetworkHold(mode: "offline" | "online"): void {
			plugin.getConnectionController()?.setQaNetworkHold(mode);
		},

		isReconciled(): boolean {
			return plugin.getReconciliationController().isReconciled;
		},

		isReconcileInFlight(): boolean {
			return plugin.getReconciliationController().isReconcileInFlight;
		},

		// -- Wait helpers -------------------------------------------------------

		waitForLocalReady(timeoutMs): Promise<void> {
			return waitFor(() => api.isLocalReady(), POLL_INTERVAL, timeoutMs);
		},

		waitForProviderSynced(timeoutMs): Promise<void> {
			return waitFor(() => api.isProviderSynced(), POLL_INTERVAL, timeoutMs);
		},

		waitForProviderDisconnected(timeoutMs): Promise<void> {
			return waitFor(() => !api.isProviderConnected(), POLL_INTERVAL, timeoutMs);
		},

		waitForReconciled(timeoutMs): Promise<void> {
			return waitFor(() => api.isReconciled(), POLL_INTERVAL, timeoutMs);
		},

		waitForIdle(timeoutMs): Promise<void> {
			return waitFor(
				() =>
					api.isLocalReady() &&
					api.isProviderSynced() &&
					api.isReconciled() &&
					!api.isReconcileInFlight(),
				POLL_INTERVAL,
				timeoutMs,
			);
		},

		getReceiptSnapshot(): ReceiptSnapshot {
			const vs = plugin.getVaultSync();
			return {
				candidateId: vs?.serverReceiptCandidateId ?? null,
				capturedAt: vs?.serverReceiptCandidateCapturedAt ?? null,
				lastConfirmedCandidateId: vs?.lastConfirmedReceiptCandidateId ?? null,
				lastConfirmedAt: vs?.lastKnownServerReceiptEchoAt ?? null,
			};
		},

		waitForReceiptAfter(afterTimestamp: number, timeoutMs: number): Promise<void> {
			return waitFor(
				() => {
					const vs = plugin.getVaultSync();
					if (!vs) return false;
					const capturedAt = vs.serverReceiptCandidateCapturedAt;
					const confirmedId = vs.lastConfirmedReceiptCandidateId;
					const candidateId = vs.serverReceiptCandidateId;
					const confirmedAt = vs.lastKnownServerReceiptEchoAt;

					// A candidate must have been captured AFTER the action.
					// That same candidate (by ID) must then be confirmed.
					if (capturedAt !== null && capturedAt > afterTimestamp) {
						if (confirmedId !== null && confirmedId === candidateId) {
							return true;
						}
					}

					// Fallback: if no pending candidate but confirmed timestamp is recent,
					// the server already processed everything before we could observe the ID.
					if (confirmedAt !== null && confirmedAt > afterTimestamp) {
						return true;
					}

					return false;
				},
				POLL_INTERVAL,
				timeoutMs,
			);
		},

		waitForMemoryReceipt(timeoutMs): Promise<void> {
			return waitFor(
				() => plugin.getVaultSync()?.serverAppliedLocalState === true,
				POLL_INTERVAL,
				timeoutMs,
			);
		},

		waitForFile(path, timeoutMs): Promise<void> {
			return waitFor(
				() => app.vault.getAbstractFileByPath(path) !== null,
				POLL_INTERVAL,
				timeoutMs,
			);
		},

		// -- Content hashes -----------------------------------------------------

		async getDiskHash(path): Promise<string | null> {
			const file = app.vault.getFileByPath(path);
			if (!file) return null;
			try {
				const content = await app.vault.read(file);
				return sha256(content);
			} catch {
				return null;
			}
		},

		async getCrdtHash(path): Promise<string | null> {
			const vaultSync = plugin.getVaultSync();
			if (!vaultSync) return null;
			const text = vaultSync.getTextForPath(path);
			if (!text) return null;
			const content = yTextToString(text);
			if (content === null) return null;
			return sha256(content);
		},

		async getEditorHash(path): Promise<string | null> {
			const { MarkdownView } = await import("obsidian");
			let content: string | null = null;
			app.workspace.iterateAllLeaves((leaf) => {
				if (content !== null) return;
				if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) {
					content = leaf.view.editor.getValue();
				}
			});
			if (content === null) return null;
			return sha256(content);
		},

		// -- Path sets ----------------------------------------------------------

		getActiveMarkdownPaths(): string[] {
			return plugin.getVaultSync()?.getActiveMarkdownPaths() ?? [];
		},

		getDiskMarkdownPaths(): string[] {
			return app.vault.getMarkdownFiles().map((f) => f.path);
		},

		// -- Status -------------------------------------------------------------

		getServerReceiptState(): "confirmed" | "pending" | "unknown" | "no-candidate" {
			const vaultSync = plugin.getVaultSync();
			if (!vaultSync) return "no-candidate";
			const state = vaultSync.serverAppliedLocalState;
			if (state === true) return "confirmed";
			if (state === false) return "pending";
			return "no-candidate";
		},

		getConnectionState(): string {
			return plugin.getConnectionController()?.getState().kind ?? "disconnected";
		},

		// -- Flight trace -------------------------------------------------------

		async startFlightTrace(mode, secret): Promise<void> {
			await plugin.startQaFlightTrace(mode);
			void secret; // secret is handled via settings for now
		},

		async stopFlightTrace(): Promise<void> {
			await plugin.stopQaFlightTrace();
		},

		async exportFlightTrace(privacy): Promise<string> {
			const path = await plugin.exportFlightTrace(privacy);
			if (!path) throw new Error("Flight trace export failed — check that a trace is active");
			return path;
		},

		// -- Force operations ---------------------------------------------------

		async forceReconcile(): Promise<void> {
			await plugin.runReconciliation();
		},

		forceReconnect(): void {
			plugin.getConnectionController()?.reconnect("qa-force-reconnect");
		},
	};

	return api;
}
