import { MarkdownView, Modal, Notice, Plugin, TFile, arrayBufferToHex, normalizePath } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VaultSyncSettingTab,
	generateVaultId,
	type VaultSyncSettings,
} from "./settings";
import { SettingsStore } from "./settings/settingsStore";
import { VaultSync, type ReconcileMode } from "./sync/vaultSync";
import { SCHEMA_VERSION } from "./sync/vaultSync";
import { EditorBindingManager } from "./sync/editorBinding";
import { DiskMirror } from "./sync/diskMirror";
import { BlobSyncManager, type BlobQueueSnapshot } from "./sync/blobSync";
import {
	type ServerCapabilities,
} from "./sync/serverCapabilities";
import { isMarkdownSyncable, isBlobSyncable } from "./types";
import { applyDiffToYText } from "./sync/diff";
import { decideExternalEditImport } from "./sync/externalEditPolicy";
import {
	isFrontmatterBlocked,
	validateFrontmatterTransition,
	extractFrontmatter,
	type FrontmatterValidationResult,
} from "./sync/frontmatterGuard";
import {
	clearFrontmatterQuarantinePath,
	readPersistedFrontmatterQuarantine,
	upsertFrontmatterQuarantineEntry,
	type FrontmatterQuarantineEntry,
} from "./sync/frontmatterQuarantine";
import {
	type DiskIndex,
	moveIndexEntries,
	waitForDiskQuiet,
} from "./sync/diskIndex";
import {
	type BlobHashCache,
	moveCachedHashes,
} from "./sync/blobHashCache";
import {
	SnapshotService,
} from "./snapshots/snapshotService";
import {
	appendTraceParams,
	PersistentTraceLogger,
	type TraceEventDetails,
	type TraceHttpContext,
} from "./debug/trace";
import { DiagnosticsService } from "./diagnostics/diagnosticsService";
import {
	CapabilityUpdateService,
	readPersistedServerCapabilitiesCache,
	readPersistedUpdateManifestCache,
	type PersistedServerCapabilitiesCache,
	type PersistedUpdateManifestCache,
	type UpdateState,
} from "./runtime/capabilityUpdateService";
import {
	ConnectionController,
	type ConnectionState,
} from "./runtime/connectionController";
import {
	buildRuntimeConfig,
	type RuntimeConfig,
} from "./runtime/runtimeConfig";
import {
	ReconciliationController,
} from "./runtime/reconciliationController";
import { registerCommands } from "./commands";
import {
	getSyncStatusLabel,
	renderSyncStatus,
	type SyncStatus,
} from "./status/statusBarController";
import { formatUnknown, yTextToString } from "./utils/format";
import { obsidianRequest } from "./utils/http";

type PersistedPluginState = Partial<VaultSyncSettings> & {
	_diskIndex?: DiskIndex;
	_blobHashCache?: BlobHashCache;
	_blobQueue?: BlobQueueSnapshot;
	_serverCapabilitiesCache?: PersistedServerCapabilitiesCache;
	_updateManifestCache?: PersistedUpdateManifestCache;
	_frontmatterQuarantine?: FrontmatterQuarantineEntry[];
};

const MARKDOWN_DIRTY_SETTLE_MS = 350;
const OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS = 1200;
const BOUND_RECOVERY_LOCK_MS = 1500;

export default class VaultCrdtSyncPlugin extends Plugin {
	settings: VaultSyncSettings = DEFAULT_SETTINGS;
	private readonly settingsStore = new SettingsStore<PersistedPluginState>({
		loadData: () => this.loadData(),
		saveData: (data) => this.saveData(data),
	});
	private runtimeConfig: RuntimeConfig = buildRuntimeConfig(
		DEFAULT_SETTINGS,
		".obsidian",
	);

	private vaultSync: VaultSync | null = null;
	private connectionController: ConnectionController | null = null;
	private editorBindings: EditorBindingManager | null = null;
	private diskMirror: DiskMirror | null = null;
	private blobSync: BlobSyncManager | null = null;
	private snapshotService: SnapshotService | null = null;
	private diagnosticsService: DiagnosticsService | null = null;
	private reconciliationController!: ReconciliationController;
	private statusBarEl: HTMLElement | null = null;
	private statusInterval: ReturnType<typeof setInterval> | null = null;

	/** Track the set of currently observed file paths for disk mirror cleanup. */
	private openFilePaths = new Set<string>();
	private activeMarkdownPath: string | null = null;

	/** Parsed exclude patterns from settings. */
	private excludePatterns: string[] = [];

	/** Max file size in characters (derived from settings KB). */
	private maxFileSize = 0;

	/** Persisted disk index: {path -> {mtime, size}}. */
	private diskIndex: DiskIndex = {};

	/** Persisted blob hash cache: {path -> {mtime, size, hash}}. */
	private blobHashCache: BlobHashCache = {};

	/** True once we've shown the R2 nudge notice this session. */
	private shownAttachmentNudge = false;

	/** Persisted blob queue snapshot for crash resilience. */
	private savedBlobQueue: BlobQueueSnapshot | null = null;
	private persistedState: PersistedPluginState = {};
	private persistWriteChain: Promise<void> = Promise.resolve();

	/** Pending stability checks for newly created/dropped files. */
	private pendingStabilityChecks = new Set<string>();
	/** Coalesced markdown disk events awaiting import into CRDT. */
	private dirtyMarkdownPaths = new Map<string, "create" | "modify">();
	private closedOnlyDeferredImports = new Set<string>();
	private markdownDrainPromise: Promise<void> | null = null;
	private markdownDrainTimer: ReturnType<typeof setTimeout> | null = null;
	private lastMarkdownDirtyAt = 0;
	private boundRecoveryLocks = new Map<string, number>();

	/** In-memory ring of recent high-level plugin events. */
	private eventRing: Array<{ ts: string; msg: string }> = [];

	/** Persistent trace journal/state writer (active when debug is enabled). */
	private traceLogger: PersistentTraceLogger | null = null;
	private traceStateInterval: ReturnType<typeof setInterval> | null = null;
	private traceStateTimer: ReturnType<typeof setTimeout> | null = null;
	private traceServerInterval: ReturnType<typeof setInterval> | null = null;
	private traceServerInFlight = false;
	private recentServerTrace: unknown[] = [];
	private capabilityUpdateService: CapabilityUpdateService | null = null;
	private commandsRegistered = false;
	private idbDegradedHandled = false;
	private lastMetadataRaceRejectionAt = 0;
	private frontmatterGuardNoticeFingerprints = new Map<string, string>();
	private frontmatterQuarantineEntries: FrontmatterQuarantineEntry[] = [];

	/**
	 * True when startup timed out waiting for provider sync.
	 * We use this to force one authoritative reconcile on the first late
	 * provider sync event, even if connection generation did not change.
	 */
	private awaitingFirstProviderSyncAfterStartup = false;
	/** Host workspace/layout reached a usable post-boot state. */
	private blobDownloadGateLayoutReady = false;
	/** YAOS startup/reconciliation has completed enough to trust local attachment presence checks. */
	private blobDownloadGateStartupReady = false;

	private createReconciliationController(): ReconciliationController {
		this.reconciliationController = new ReconciliationController({
			app: this.app,
			getSettings: () => this.settings,
			getRuntimeConfig: () => this.runtimeConfig,
			getVaultSync: () => this.vaultSync,
			getDiskMirror: () => this.diskMirror,
			getBlobSync: () => this.blobSync,
			getDiskIndex: () => this.diskIndex,
			setDiskIndex: (index) => {
				this.diskIndex = index;
			},
			isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
			refreshServerCapabilities: (reason) => this.refreshServerCapabilities(reason),
			validateAllOpenBindings: (reason) => this.validateAllOpenBindings(reason),
			bindAllOpenEditors: () => this.bindAllOpenEditors(),
			getAwaitingFirstProviderSyncAfterStartup: () => this.awaitingFirstProviderSyncAfterStartup,
			setAwaitingFirstProviderSyncAfterStartup: (value) => {
				this.awaitingFirstProviderSyncAfterStartup = value;
			},
			saveDiskIndex: () => this.saveDiskIndex(),
			refreshStatusBar: () => this.refreshStatusBar(),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			log: (message) => this.log(message),
		});
		return this.reconciliationController;
	}

	private isMarkdownPathSyncable(path: string): boolean {
		return isMarkdownSyncable(path, this.excludePatterns, this.runtimeConfig.vaultConfigDir);
	}

	private isBlobPathSyncable(path: string): boolean {
		return isBlobSyncable(path, this.excludePatterns, this.runtimeConfig.vaultConfigDir);
	}

	async onload() {
		const onloadStartedAt = Date.now();
		this.capabilityUpdateService = new CapabilityUpdateService({
			getSettings: () => this.settings,
			pluginVersion: this.manifest.version,
			schemaVersion: SCHEMA_VERSION,
			trace: (source, msg, details) => this.trace(source, msg, details),
			log: (message) => this.log(message),
			persistPluginState: () => this.persistPluginState(),
			hasSyncRuntime: () => this.vaultSync !== null,
			isSyncConnectedAndProviderSynced: () => !!this.vaultSync?.connected && !!this.vaultSync?.providerSynced,
			refreshAttachmentSyncRuntime: (reason) => this.refreshAttachmentSyncRuntime(reason),
			triggerDailySnapshot: () => { void this.snapshotService?.triggerDailySnapshot(); },
			stopSyncRuntimeForCompatibility: () => {
				if (this.vaultSync) {
					this.teardownSync();
				}
			},
			setStatusError: () => this.updateStatusBar("error"),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			updateSettings: (mutator, reason) => this.updateSettings(mutator, reason),
		});
		await this.loadSettings();
		this.applyRuntimeSettings("load-settings");
		this.createReconciliationController();
		this.snapshotService = new SnapshotService({
			app: this.app,
			getSettings: () => this.settings,
			getTraceHttpContext: () => this.getTraceHttpContext(),
			getVaultSync: () => this.vaultSync,
			getDiskMirror: () => this.diskMirror,
			getBlobSync: () => this.blobSync,
			getServerSupportsSnapshots: () => this.serverSupportsSnapshots,
			log: (message) => this.log(message),
			bindAllOpenEditors: () => this.bindAllOpenEditors(),
			validateAllOpenBindings: (reason) => this.validateAllOpenBindings(reason),
		});
		this.diagnosticsService = new DiagnosticsService({
			app: this.app,
			getSettings: () => this.settings,
			getTraceHttpContext: () => this.getTraceHttpContext(),
			getVaultSync: () => this.vaultSync,
			getDiskMirror: () => this.diskMirror,
			getBlobSync: () => this.blobSync,
			getEventRing: () => this.eventRing,
			getRecentServerTrace: () => this.recentServerTrace,
			getFrontmatterQuarantineEntries: () => this.frontmatterQuarantineEntries,
			getState: () => ({
				reconciled: this.reconciliationController.getState().reconciled,
				reconcileInFlight: this.reconciliationController.getState().reconcileInFlight,
				reconcilePending: this.reconciliationController.getState().reconcilePending,
				lastReconcileStats: this.reconciliationController.getState().lastReconcileStats,
				awaitingFirstProviderSyncAfterStartup: this.awaitingFirstProviderSyncAfterStartup,
				lastReconciledGeneration: this.reconciliationController.getState().lastReconciledGeneration,
				untrackedFileCount: this.reconciliationController.getState().untrackedFileCount,
				openFileCount: this.openFilePaths.size,
			}),
			isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
			collectOpenFileTraceState: () => this.collectOpenFileTraceState(),
			sha256Hex: (text) => this.sha256Hex(text),
			log: (message) => this.log(message),
		});
		this.registerObsidianProtocolHandler("yaos", (params) => {
			void this.handleSetupLink(params);
		});

		let generatedVaultId = false;
		if (!this.settings.vaultId) {
			await this.updateSettings((settings) => {
				settings.vaultId = generateVaultId();
			}, "startup-generate-vault-id");
			generatedVaultId = true;
		}

		if (!this.settings.deviceName) {
			await this.updateSettings((settings) => {
				settings.deviceName = `device-${Date.now().toString(36)}`;
			}, "startup-generate-device-name");
		}

		this.setupTraceLogger();
		this.blobDownloadGateLayoutReady = this.app.workspace.layoutReady;
		this.app.workspace.onLayoutReady(() => {
			const firstReady = !this.blobDownloadGateLayoutReady;
			this.blobDownloadGateLayoutReady = true;
			if (firstReady) {
				this.trace("trace", "blob-download-layout-ready", {});
				this.log("Blob download gate: workspace layout ready");
			}
			this.maybeOpenBlobDownloadGate("layout-ready");
		});
		if (generatedVaultId) {
			this.log(`Generated vault ID: ${this.settings.vaultId}`);
		}

		this.addSettingTab(new VaultSyncSettingTab(this.app, this, this));

		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar("disconnected");

		const finishOnload = (outcome: string): void => {
			const durationMs = Date.now() - onloadStartedAt;
			this.trace("trace", "startup-onload-complete", {
				durationMs,
				outcome,
				hostConfigured: !!this.settings.host,
				tokenConfigured: !!this.settings.token,
			});
			this.log(`Startup onload complete (${outcome}) in ${durationMs}ms`);
		};

		if (this.settings.host) {
			void this.refreshServerCapabilities("startup-background");
			void this.refreshUpdateManifest("startup-background");
			void this.syncUpdateMetadataToServer("startup-background");
		}

		if (!this.settings.host) {
			this.log("Host not configured — sync disabled");
			new Notice("Configure the server host in settings to enable sync.");
			finishOnload("missing-host");
			return;
		}

		if (!this.settings.token) {
			this.log("Token not configured — sync disabled");
			const message = this.serverAuthMode === "env"
				? "YAOS: configure the server token in settings to enable sync."
				: this.serverAuthMode === "claim" || this.serverAuthMode === "unclaimed"
						? "YAOS: claim the server in a browser, then use the YAOS setup link to fill in the token."
						: "YAOS: configure a token in settings, or claim the server in a browser first.";
			new Notice(message, 10000);
			finishOnload("missing-token");
			return;
		}

		// Parse exclude patterns and file size limit from settings
		this.applyRuntimeSettings("onload-pre-sync");

		// Warn about insecure connections to non-localhost hosts
		if (this.settings.host) {
			try {
				const url = new URL(this.settings.host);
				const h = url.hostname;
				if (url.protocol === "http:" && h !== "localhost" && h !== "127.0.0.1" && h !== "[::1]") {
						this.log("WARNING: connecting over unencrypted HTTP to a remote host — token sent in plaintext");
						new Notice(
							"Connecting over unencrypted HTTP. Your token will be sent in plaintext. Use HTTPS for production.",
							8000,
						);
					}
			} catch { /* invalid URL, will fail at connect */ }
		}

		void this.initSync();
		finishOnload("sync-started");
	}

	private async initSync(): Promise<void> {
		const initSyncStartedAt = Date.now();
		this.blobDownloadGateStartupReady = false;
		this.trace("trace", "startup-init-sync-start", {
			hostConfigured: !!this.settings.host,
			tokenConfigured: !!this.settings.token,
			hasCachedCapabilities: this.capabilityUpdateService?.hasCachedCapabilities ?? false,
		});
		try {
			this.idbDegradedHandled = false;
			this.applyRuntimeSettings("init-sync");
			if (this.enforceCompatibilityGuard("init-sync-preflight")) {
				return;
			}

			// 1. Create VaultSync (Y.Doc + IndexedDB + provider in parallel)
			this.vaultSync = new VaultSync(this.settings, {
				traceContext: this.getTraceHttpContext(),
				trace: (source, msg, details) => this.trace(source, msg, details),
			});

			// 2. EditorBindingManager
			this.editorBindings = new EditorBindingManager(
				this.vaultSync,
				this.settings.debug,
				(source, msg, details) => this.trace(source, msg, details),
			);

			// 3. Global CM6 extension
			this.registerEditorExtension(
				this.editorBindings.getBaseExtension(),
			);

			// 4. DiskMirror
			this.diskMirror = new DiskMirror(
				this.app,
				this.vaultSync,
				this.editorBindings,
				this.settings.debug,
				(source, msg, details) => this.trace(source, msg, details),
				() => this.settings.frontmatterGuardEnabled,
				(path, direction, reason, validation, previousContent, nextContent) =>
					this.handleFrontmatterValidation(
						path,
						direction,
						reason,
						validation,
						previousContent,
						nextContent,
					),
			);
			this.diskMirror.startMapObservers();

			// 4b. BlobSyncManager (if attachment sync is enabled)
			this.startBlobSyncEngine("startup", false);

			// 5. Status tracking
			this.connectionController = new ConnectionController({
				getVaultSync: () => this.vaultSync,
				isReconciled: () => this.reconciliationController.isReconciled,
				getAwaitingFirstProviderSyncAfterStartup: () => this.awaitingFirstProviderSyncAfterStartup,
				setAwaitingFirstProviderSyncAfterStartup: (value) => {
					this.awaitingFirstProviderSyncAfterStartup = value;
				},
				getLastReconciledGeneration: () => this.reconciliationController.lastGeneration,
				setReconnectPending: () => {
					this.reconciliationController.markPending();
				},
				isReconcileInFlight: () => this.reconciliationController.isReconcileInFlight,
				runReconnectReconciliation: (generation) => {
					void this.reconciliationController.runReconnectReconciliation(generation);
				},
				refreshServerCapabilities: (reason) => {
					void this.refreshServerCapabilities(reason);
				},
				flushOpenWrites: (reason) => {
					void this.diskMirror?.flushOpenWrites(reason);
				},
				updateOfflineStatus: () => this.updateStatusBar("offline"),
				refreshStatusBar: () => this.refreshStatusBar(),
				scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
				log: (message) => this.log(message),
				trace: (source, msg, details) => this.trace(source, msg, details),
				registerCleanup: (cleanup) => this.register(cleanup),
			});
			this.connectionController.start();
			this.statusInterval = setInterval(() => {
				this.refreshStatusBar();
				if (this.reconciliationController.isReconciled && this.editorBindings) {
					const touched = this.editorBindings.auditBindings("status-tick");
					if (touched > 0) {
						this.log(`Binding health audit (status-tick) — touched ${touched}`);
						this.scheduleTraceStateSnapshot("binding-audit:status-tick");
					}
				}
				// Periodically persist blob queue if transfers are active,
				// or clear persisted queue if transfers completed
				if (this.blobSync) {
					if (this.blobSync.pendingUploads > 0 || this.blobSync.pendingDownloads > 0) {
						void this.saveBlobQueue();
					} else {
						void this.clearSavedBlobQueue();
					}
				}
				const capabilityState = this.capabilityUpdateService?.capabilities ?? null;
				const waitingForR2 =
					!!this.settings.host &&
					(!capabilityState || !capabilityState.attachments || !capabilityState.snapshots);
				if (waitingForR2 && (this.capabilityUpdateService?.shouldRefreshCapabilities() ?? false)) {
					void this.refreshServerCapabilities("background-poll");
				}
			}, 3000);
			this.register(() => {
				if (this.statusInterval) clearInterval(this.statusInterval);
			});

			// 6. Vault events (gated by reconciliation state)
			this.registerVaultEvents();

			// 7. Commands
			if (!this.commandsRegistered) {
				registerCommands(this, {
					getVaultSync: () => this.vaultSync,
					getConnectionController: () => this.connectionController,
					getDiagnosticsService: () => this.diagnosticsService,
					getSnapshotService: () => this.snapshotService,
					getUntrackedFileCount: () => this.reconciliationController.untrackedFileCount,
					isDebugEnabled: () => this.settings.debug,
					runReconciliation: (mode) => this.runReconciliation(mode),
					bindAllOpenEditors: () => this.bindAllOpenEditors(),
					validateAllOpenBindings: (reason) => this.validateAllOpenBindings(reason),
					runSchemaMigrationToV2: () => this.runSchemaMigrationToV2(),
					runVfsTortureTest: () => this.runVfsTortureTest(),
					importUntrackedFiles: () => this.importUntrackedFiles(),
					resetLocalCache: () => this.resetLocalCache(),
					nuclearReset: () => this.nuclearReset(),
				});
				this.commandsRegistered = true;
			}

			// 8. Rename batch callback → update editor bindings + disk mirror observers + disk index + blob hash cache
			this.vaultSync.onRenameBatchFlushed((renames) => {
				this.editorBindings?.updatePathsAfterRename(renames);

				// Move disk index entries
				moveIndexEntries(this.diskIndex, renames);

				// Move blob hash cache entries
				moveCachedHashes(this.blobHashCache, renames);

				// Move disk mirror observers and openFilePaths tracking
				// for any paths that were open before the rename.
				for (const [oldPath, newPath] of renames) {
					if (this.activeMarkdownPath === oldPath) {
						this.activeMarkdownPath = newPath;
					}
					if (this.openFilePaths.has(oldPath)) {
						this.diskMirror?.notifyFileClosed(oldPath);
						this.openFilePaths.delete(oldPath);
						this.diskMirror?.notifyFileOpened(newPath);
						this.openFilePaths.add(newPath);
						this.log(`Rename batch: moved observer "${oldPath}" -> "${newPath}"`);
					}
				}
			});

			// -----------------------------------------------------------
			// STARTUP SEQUENCE
			// -----------------------------------------------------------

			this.updateStatusBar("loading");
			this.log("Waiting for IndexedDB persistence...");
			const localLoaded = await this.vaultSync.waitForLocalPersistence();
			this.log(`IndexedDB: ${localLoaded ? "loaded" : "timed out"}`);

			// Schema version check — refuse to run if a newer plugin wrote this data
			const schemaError = this.vaultSync.checkSchemaVersion();
			if (schemaError) {
				console.error(`[yaos] ${schemaError}`);
				new Notice(`YAOS: ${schemaError}`);
				this.updateStatusBar("error");
				return;
			}

			// Check for fatal auth error before waiting for provider
			if (this.vaultSync.fatalAuthError) {
				this.log("Fatal auth error during startup");
				if (this.vaultSync.fatalAuthCode === "update_required") {
					this.updateStatusBar("error");
					this.showFatalSyncNotice();
					return;
				}
				this.updateStatusBar("unauthorized");
				this.showFatalSyncNotice();
				// Still reconcile with whatever we have locally
				const mode = this.vaultSync.getSafeReconcileMode();
				await this.runReconciliation(mode);
				this.bindAllOpenEditors();
				this.validateAllOpenBindings("startup-auth-fallback");
				return;
			}

			this.updateStatusBar("syncing");
			this.log("Waiting for provider sync...");
			const providerSynced = await this.vaultSync.waitForProviderSync();
			this.log(`Provider: ${providerSynced ? "synced" : "timed out (offline)"}`);
			this.awaitingFirstProviderSyncAfterStartup = !providerSynced;
			this.log(
				`Startup sync gate: awaitingFirstProviderSyncAfterStartup=${this.awaitingFirstProviderSyncAfterStartup} ` +
				`(gen=${this.vaultSync.connectionGeneration})`,
			);

			if (this.vaultSync.fatalAuthError) {
				this.updateStatusBar(this.vaultSync.fatalAuthCode === "update_required" ? "error" : "unauthorized");
				this.showFatalSyncNotice();
				return;
			}

			const mode = this.vaultSync.getSafeReconcileMode();
			this.log(`Reconciliation mode: ${mode}`);

			await this.runReconciliation(mode);
			this.reconciliationController.lastGeneration = this.vaultSync.connectionGeneration;
			if (providerSynced) {
				this.awaitingFirstProviderSyncAfterStartup = false;
			}

			this.bindAllOpenEditors();
			this.validateAllOpenBindings("startup");

			this.refreshStatusBar();
			this.trace("trace", "startup-init-sync-complete", {
				durationMs: Date.now() - initSyncStartedAt,
			});
			this.log("Startup complete");
			this.scheduleTraceStateSnapshot("startup-complete");
			this.markBlobDownloadStartupReady("startup-complete");
			void this.refreshServerTrace();

			// Trigger daily snapshot (noop if already taken today).
			// Fire-and-forget — don't block startup on snapshot creation.
			if (providerSynced && this.serverSupportsSnapshots) {
				void this.snapshotService?.triggerDailySnapshot();
			}
		} catch (err) {
			console.error("[yaos] Failed to initialize sync:", err);
			new Notice(`YAOS: failed to initialize — ${formatUnknown(err)}`);
			this.updateStatusBar("error");
		}
	}

	private async runReconciliation(mode: ReconcileMode): Promise<void> {
		await this.reconciliationController.runReconciliation(mode);
	}

	private async importUntrackedFiles(): Promise<void> {
		await this.reconciliationController.importUntrackedFiles();
	}

	// -------------------------------------------------------------------
	// Editor binding
	// -------------------------------------------------------------------

	private bindAllOpenEditors(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				this.editorBindings?.bind(leaf.view, this.settings.deviceName);
				if (leaf.view.file) {
					this.trackOpenFile(leaf.view.file.path);
				}
			}
		});
		this.activeMarkdownPath = this.getActiveMarkdownPath();
	}

	private validateAllOpenBindings(reason: string): void {
		let touched = 0;

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) {
				return;
			}

			const binding = this.editorBindings?.getBindingDebugInfoForView(leaf.view) ?? null;
			const health = this.editorBindings?.getBindingHealthForView(leaf.view) ?? null;

			if (health?.bound && (health.healthy || health.settling)) {
				return;
			}

			touched += 1;
			if (!binding || !health?.bound) {
				this.editorBindings?.bind(leaf.view, this.settings.deviceName);
				return;
			}

			const repaired = this.editorBindings?.repair(
				leaf.view,
				this.settings.deviceName,
				`validate:${reason}`,
			) ?? false;
			if (!repaired) {
				this.editorBindings?.rebind(
					leaf.view,
					this.settings.deviceName,
					`validate:${reason}`,
				);
			}
		});

		if (touched > 0) {
			this.log(`Validated open bindings (${reason}) — touched ${touched}`);
			this.scheduleTraceStateSnapshot(`validate-open-bindings:${reason}`);
		}
	}

	/**
	 * Track that a file is open. Notifies diskMirror to start observing.
	 * Also cleans up observers for files that are no longer open in any leaf.
	 */
	private trackOpenFile(path: string): void {
		// Notify disk mirror for the newly opened file
		if (!this.openFilePaths.has(path)) {
			this.diskMirror?.notifyFileOpened(path);
			this.openFilePaths.add(path);
		}

		this.reconcileTrackedOpenFiles("track-open-file");
		this.scheduleTraceStateSnapshot("track-open-file");
	}

	private reconcileTrackedOpenFiles(reason: string): void {
		// Scan all leaves to find which files are actually still open
		const currentlyOpen = new Set<string>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				currentlyOpen.add(leaf.view.file.path);
			}
		});

		// Close observers for files no longer open in any leaf
		for (const tracked of this.openFilePaths) {
			if (!currentlyOpen.has(tracked)) {
				this.diskMirror?.notifyFileClosed(tracked);
				this.openFilePaths.delete(tracked);
				this.log(`${reason}: closed observer for "${tracked}"`);
				this.maybeImportDeferredClosedOnlyPath(tracked, reason);
			}
		}
	}

	private maybeImportDeferredClosedOnlyPath(path: string, reason: string): void {
		if (!this.reconciliationController.isReconciled) return;
		if (this.settings.externalEditPolicy !== "closed-only") return;
		if (!this.isMarkdownPathSyncable(path)) return;
		if (this.closedOnlyDeferredImports.has(path)) return;
		if (this.getOpenMarkdownViewsForPath(path).length > 0) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		this.closedOnlyDeferredImports.add(path);
		this.trace("trace", "closed-only-deferred-import-queued", {
			path,
			reason,
		});

		void this.processDirtyMarkdownPath(path, "modify")
			.catch((err) => {
				console.error(
					`[yaos] closed-only deferred import failed for "${path}" (${reason}):`,
					err,
				);
			})
			.finally(() => {
				this.closedOnlyDeferredImports.delete(path);
			});
	}

	private getActiveMarkdownPath(): string | null {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		return activeView?.file?.path ?? null;
	}

	private updateActiveMarkdownPath(nextPath: string | null, reason: string): void {
		const previousPath = this.activeMarkdownPath;
		this.activeMarkdownPath = nextPath;

		if (!previousPath || previousPath === nextPath) {
			return;
		}

		this.editorBindings?.clearLocalCursor(reason);
		void this.diskMirror?.flushOpenPath(previousPath, reason);
	}

	// -------------------------------------------------------------------
	// Vault event handlers
	// -------------------------------------------------------------------

	private registerVaultEvents(): void {
		// Layout change: clean up observers for closed files
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (!this.reconciliationController.isReconciled) return;
				this.editorBindings?.clearLocalCursor("layout-change");
				this.reconcileTrackedOpenFiles("layout-change");
				this.updateActiveMarkdownPath(
					this.getActiveMarkdownPath(),
					"layout-change-active-blur",
				);
				const touched = this.editorBindings?.auditBindings("layout-change") ?? 0;
				if (touched > 0) {
					this.log(`Binding health audit (layout-change) — touched ${touched}`);
					this.scheduleTraceStateSnapshot("binding-audit:layout-change");
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!this.reconciliationController.isReconciled) return;
				const nextPath =
					leaf?.view instanceof MarkdownView ? (leaf.view.file?.path ?? null) : null;
				this.updateActiveMarkdownPath(nextPath, "active-leaf-change");
				this.reconcileTrackedOpenFiles("active-leaf-change");
				if (!leaf) return;
				const view = leaf.view;
				if (view instanceof MarkdownView) {
					this.editorBindings?.bind(view, this.settings.deviceName);
					if (view.file) {
						this.trackOpenFile(view.file.path);
					}
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				this.updateActiveMarkdownPath(
					file?.path ?? null,
					"file-open-active-change",
				);
				if (!file) return;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view && view.file?.path === file.path) {
					this.editorBindings?.bind(view, this.settings.deviceName);
					this.trackOpenFile(file.path);
				}

				// Prefetch embedded attachments for the opened note
				if (file.path.endsWith(".md") && this.blobSync) {
					this.prefetchEmbeddedAttachments(file);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					void this.markMarkdownDirty(file, "modify");
				} else if (this.blobSync && this.isBlobPathSyncable(file.path) && !this.blobSync.isSuppressed(file.path)) {
					this.blobSync.handleFileChange(file);
				}
			}),
		);

		// Rename: use batched queueRename for atomic folder renames.
		// Both markdown and blob files go through the same rename batch
		// since folder renames affect both types atomically.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.reconciliationController.isReconciled) return;
				if (!(file instanceof TFile)) return;
				// Rename is relevant if either the old or new path is syncable
				const newSyncable = this.isMarkdownPathSyncable(file.path)
					|| this.isBlobPathSyncable(file.path);
				const oldSyncable = this.isMarkdownPathSyncable(oldPath)
					|| this.isBlobPathSyncable(oldPath);
				if (!newSyncable && !oldSyncable) return;
				this.vaultSync?.queueRename(oldPath, file.path);
				this.log(`Rename queued: "${oldPath}" -> "${file.path}"`);
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					if (this.diskMirror?.consumeDeleteSuppression(file.path)) {
						this.log(`Suppressed delete event for "${file.path}"`);
						return;
					}
					this.editorBindings?.unbindByPath(file.path);
					this.diskMirror?.notifyFileClosed(file.path);
					this.openFilePaths.delete(file.path);

					this.vaultSync?.handleDelete(
						file.path,
						this.settings.deviceName,
					);
					this.log(`Delete: "${file.path}"`);
				} else if (this.blobSync && this.isBlobPathSyncable(file.path) && !this.blobSync.isSuppressed(file.path)) {
					this.blobSync.handleFileDelete(file.path, this.settings.deviceName);
					this.log(`Delete (blob): "${file.path}"`);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					void this.markMarkdownDirty(file, "create");
				} else if (this.isBlobPathSyncable(file.path)) {
					if (this.blobSync && !this.blobSync.isSuppressed(file.path)) {
						// For blob files, use the same stability check before uploading
						if (this.pendingStabilityChecks.has(file.path)) return;
						this.pendingStabilityChecks.add(file.path);

						void waitForDiskQuiet(this.app, file.path).then((stable) => {
							this.pendingStabilityChecks.delete(file.path);
							if (stable) {
								this.blobSync?.handleFileChange(file);
							} else {
								this.log(`Create (blob): "${file.path}" unstable after timeout, skipping`);
							}
						});
					} else if (!this.serverSupportsAttachments && !this.shownAttachmentNudge) {
						this.shownAttachmentNudge = true;
						new Notice(
							"YAOS: This file won't sync yet — attachment sync needs a Cloudflare R2 bucket. Open YAOS settings for a 1-minute setup guide.",
							10000,
						);
					}
				}
			}),
		);
	}

	// -------------------------------------------------------------------
	// Teardown + reinit (for reset commands)
	// -------------------------------------------------------------------

	/**
	 * Cleanly tear down all sync state: unbind editors, stop disk mirror,
	 * destroy provider + persistence + ydoc, reset all flags.
	 * After this, the plugin is in the same state as before initSync().
	 */
	private teardownSync(): void {
		this.log("teardownSync: tearing down all sync state");

		this.editorBindings?.unbindAll();
		this.diskMirror?.destroy();

		// Persist blob queue before destroying (crash resilience)
		if (this.blobSync) {
			const snapshot = this.blobSync.exportQueue();
			if (snapshot.uploads.length > 0 || snapshot.downloads.length > 0) {
				// Fire-and-forget — teardown can't be async
				void this.saveBlobQueue();
			}
		}
		this.blobSync?.destroy();

		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		this.reconciliationController.reset();
		if (this.markdownDrainTimer) {
			clearTimeout(this.markdownDrainTimer);
			this.markdownDrainTimer = null;
		}
		this.connectionController?.stop();

		this.vaultSync?.destroy();

		this.vaultSync = null;
		this.connectionController = null;
		this.editorBindings = null;
		this.diskMirror = null;
		this.blobSync = null;
		this.shownAttachmentNudge = false;
		this.awaitingFirstProviderSyncAfterStartup = false;
		this.openFilePaths.clear();
		this.activeMarkdownPath = null;
		this.dirtyMarkdownPaths.clear();
		this.idbDegradedHandled = false;

		this.updateStatusBar("disconnected");
	}

	private resetLocalCache(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		const vaultId = this.settings.vaultId;
		new ConfirmModal(
			this.app,
			"Reset local cache",
			"This will clear the local IndexedDB cache and re-sync from the server. " +
			"Your disk files and server state are not affected. Continue?",
			async () => {
				this.log("Reset cache: starting");
				new Notice("Clearing cache and syncing again...");

				this.teardownSync();

				try {
					await VaultSync.deleteIdb(vaultId);
					this.log("Reset cache: IDB deleted");
				} catch (err) {
					console.error("[yaos] Failed to delete IDB:", err);
				}

				this.log("Reset cache: reinitializing");
				await this.initSync();
				new Notice("Cache reset complete.");
			},
		).open();
	}

	private nuclearReset(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		const pathCount = this.vaultSync.getActiveMarkdownPaths().length;
		new ConfirmModal(
			this.app,
			"Nuclear reset",
			`This will wipe all CRDT state (${pathCount} files) on both this device and the server, ` +
			`clear the local cache, then re-seed everything from your current disk files. ` +
			`Other connected devices will also see the reset. This cannot be undone. Continue?`,
			async () => {
				this.log("Nuclear reset: starting");
				new Notice("Nuclear reset in progress...");

				// Clear CRDT maps before teardown so deletions propagate while connected.
				const counts = this.vaultSync!.clearAllMaps();
				this.log(
					`Nuclear reset: cleared ${counts.pathCount} paths, ` +
					`${counts.idCount} texts, ${counts.metaCount} meta, ` +
					`${counts.blobCount} blob paths`,
				);

				await new Promise((r) => setTimeout(r, 500));

				const vaultId = this.settings.vaultId;
				this.teardownSync();

				try {
					await VaultSync.deleteIdb(vaultId);
					this.log("Nuclear reset: IDB deleted");
				} catch (err) {
					console.error("[yaos] Failed to delete IDB:", err);
				}

				this.log("Nuclear reset: reinitializing (will re-seed from disk)");
				await this.initSync();
				new Notice(
					`YAOS: nuclear reset complete. ` +
					`Re-seeded ${this.vaultSync?.getActiveMarkdownPaths().length ?? 0} files from disk.`,
				);
			},
		).open();
	}

	// -------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------

	/**
	 * When a note opens, parse its embedded links (![[...]]) via Obsidian's
	 * metadata cache and prefetch any missing blob attachments from R2.
	 * This ensures images/PDFs render immediately rather than waiting for
	 * the next reconcile or CRDT observer to trigger the download.
	 */
	private prefetchEmbeddedAttachments(file: TFile): void {
		if (!this.blobSync) return;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.embeds) return;

		const pathsToFetch: string[] = [];

		for (const embed of cache.embeds) {
			// Resolve the link to an actual vault path.
			// getFirstLinkpathDest handles relative paths, aliases, etc.
			const resolved = this.app.metadataCache.getFirstLinkpathDest(
				embed.link,
				file.path,
			);

			if (resolved) {
				// File already exists on disk — skip
				continue;
			}

			// File doesn't exist on disk. Try to find it in the CRDT blob map.
			// The link could be just a filename (e.g. "image.png") or a path.
			// Check both the raw link text and common attachment patterns.
			const linkPath = (embed.link.split("#")[0] ?? "").split("|")[0] ?? ""; // strip anchors/aliases

			// Search pathToBlob for a matching path
			let blobPath: string | null = null;
			this.vaultSync?.pathToBlob.forEach((_ref, candidatePath) => {
				if (blobPath) return; // already found
				// Exact match
				if (candidatePath === linkPath) {
					blobPath = candidatePath;
					return;
				}
				// Filename-only match (Obsidian's default "shortest path" mode)
				const candidateFilename = candidatePath.split("/").pop();
				if (candidateFilename === linkPath) {
					blobPath = candidatePath;
				}
			});

			if (blobPath) {
				pathsToFetch.push(blobPath);
			}
		}

		if (pathsToFetch.length > 0) {
			const queued = this.blobSync.prioritizeDownloads(pathsToFetch);
			if (queued > 0) {
				this.log(`prefetch: queued ${queued} attachments for "${file.path}"`);
			}
		}
	}

	private markMarkdownDirty(file: TFile, reason: "create" | "modify"): void {
		// Coalesce local markdown filesystem bursts by path and only start the
		// drain once the path set has been quiet for a short settle window.
		const previous = this.dirtyMarkdownPaths.get(file.path);
		if (previous !== "create") {
			this.dirtyMarkdownPaths.set(file.path, reason);
		}
		this.lastMarkdownDirtyAt = Date.now();
		this.scheduleMarkdownDrain();
	}

	private scheduleMarkdownDrain(): void {
		if (this.markdownDrainTimer) {
			clearTimeout(this.markdownDrainTimer);
		}
		const elapsed = Date.now() - this.lastMarkdownDirtyAt;
		const delay = Math.max(0, MARKDOWN_DIRTY_SETTLE_MS - elapsed);
		this.markdownDrainTimer = setTimeout(() => {
			this.markdownDrainTimer = null;
			const sinceLastDirty = Date.now() - this.lastMarkdownDirtyAt;
			if (sinceLastDirty < MARKDOWN_DIRTY_SETTLE_MS) {
				// Enforce a strict trailing-edge quiet window before ingest.
				this.scheduleMarkdownDrain();
				return;
			}
			this.kickMarkdownDrain();
		}, delay);
	}

	private kickMarkdownDrain(): void {
		if (this.markdownDrainPromise) return;
		this.markdownDrainPromise = this.drainDirtyMarkdownPaths()
			.catch((err) => {
				console.error("[yaos] markdown drain failed:", err);
			})
			.finally(() => {
				this.markdownDrainPromise = null;
				if (this.dirtyMarkdownPaths.size > 0) {
					this.scheduleMarkdownDrain();
				}
			});
	}

	private async drainDirtyMarkdownPaths(): Promise<void> {
		if (this.dirtyMarkdownPaths.size === 0) return;
		// Process one snapshot batch only. Any new events that arrive while this
		// batch is in flight are handled by the next trailing-edge timer window.
		const batch = Array.from(this.dirtyMarkdownPaths.entries());
		this.dirtyMarkdownPaths.clear();

		for (const [path, reason] of batch) {
			await this.processDirtyMarkdownPath(path, reason);
		}
	}

	private async processDirtyMarkdownPath(
		path: string,
		reason: "create" | "modify",
	): Promise<void> {
		const abstractFile = this.app.vault.getAbstractFileByPath(path);
		if (!(abstractFile instanceof TFile)) {
			this.log(`Markdown ${reason}: "${path}" no longer exists, skipping`);
			return;
		}

		if (reason === "create") {
			if (await this.diskMirror?.shouldSuppressCreate(abstractFile)) {
				this.log(`Suppressed create event for "${path}"`);
				return;
			}

			if (this.vaultSync?.isPendingRenameTarget(path)) {
				this.log(`Create: "${path}" is a pending rename target, skipping import`);
				return;
			}
		} else {
			if (await this.diskMirror?.shouldSuppressModify(abstractFile)) {
				this.log(`Suppressed modify event for "${path}"`);
				return;
			}
		}

		await this.syncFileFromDisk(abstractFile, reason);
	}

	private async syncFileFromDisk(
		file: TFile,
		sourceReason: "create" | "modify" = "modify",
	): Promise<void> {
		if (!this.vaultSync) return;
		if (!this.isMarkdownPathSyncable(file.path)) return;

		let wasBound = this.editorBindings?.isBound(file.path) ?? false;
		const openViews = this.getOpenMarkdownViewsForPath(file.path);
		const isOpenInEditor = openViews.length > 0;
		if (wasBound && !isOpenInEditor) {
			this.trace("trace", "stale-bound-path-without-open-view", {
				path: file.path,
			});
			this.editorBindings?.unbindByPath(file.path);
			this.log(`syncFileFromDisk: cleared stale bound state for "${file.path}" (no live view)`);
			wasBound = false;
		}

		// External edit policy gate: control whether disk changes are
		// imported into the CRDT.
		const policy = this.settings.externalEditPolicy;
		const policyDecision = decideExternalEditImport(policy, isOpenInEditor);
		if (!policyDecision.allowImport) {
			const reason = policyDecision.reason === "policy-never"
				? "external edit policy: never"
				: "external edit policy: closed-only (file is open; deferred)";
			this.log(`syncFileFromDisk: skipping "${file.path}" (${reason})`);
			if (policyDecision.reason === "policy-never") {
				await this.updateDiskIndexForPath(file.path);
			}
			return;
		}

		try {
			const content = await this.app.vault.read(file);

			// File size guard
			if (this.maxFileSize > 0 && content.length > this.maxFileSize) {
				this.log(`syncFileFromDisk: skipping "${file.path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
				return;
			}
			const existingText = this.vaultSync.getTextForPath(file.path);

			if (wasBound && isOpenInEditor) {
				const handledBound = this.handleBoundFileSyncGap(
					file,
					content,
					existingText,
					openViews,
					sourceReason,
				);
				if (handledBound) {
					await this.updateDiskIndexForPath(file.path);
					return;
				}
			}

			if (existingText) {
				const crdtContent = existingText.toJSON();
				if (crdtContent === content) return;
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent,
					content,
					"disk-to-crdt",
				)) {
					await this.updateDiskIndexForPath(file.path);
					return;
				}

				// Apply a line-level diff to the Y.Text instead of delete-all + insert-all.
				// This preserves CRDT history, cursor positions, and awareness state.
				// Works for both editor-bound files (external edit merges into live editor)
				// and unbound files (background sync).
				this.log(
					`syncFileFromDisk: applying diff to "${file.path}" (${crdtContent.length} -> ${content.length} chars)`,
				);
				applyDiffToYText(existingText, crdtContent, content, "disk-sync");
			} else {
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"disk-to-crdt-seed",
				)) {
					await this.updateDiskIndexForPath(file.path);
					return;
				}
				this.vaultSync.ensureFile(
					file.path,
					content,
					this.settings.deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
			}

			await this.updateDiskIndexForPath(file.path);
		} catch (err) {
			console.error(
				`[yaos] syncFileFromDisk failed for "${file.path}":`,
				err,
			);
		}
	}

	private getOpenMarkdownViewsForPath(path: string): MarkdownView[] {
		const views: MarkdownView[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (
				leaf.view instanceof MarkdownView
				&& leaf.view.file?.path === path
			) {
				views.push(leaf.view);
			}
		});
		return views;
	}

	private handleBoundFileSyncGap(
		file: TFile,
		content: string,
		existingText: ReturnType<VaultSync["getTextForPath"]>,
		openViews: MarkdownView[] = this.getOpenMarkdownViewsForPath(file.path),
		sourceReason: "create" | "modify" = "modify",
	): boolean {
		const now = Date.now();
		const lockUntil = this.boundRecoveryLocks.get(file.path) ?? 0;
		if (lockUntil > now) {
			this.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, recovery lock)`);
			return true;
		}
		if (lockUntil > 0) {
			this.boundRecoveryLocks.delete(file.path);
		}

		if (openViews.length === 0) {
			this.trace("trace", "stale-bound-path-without-open-view", {
				path: file.path,
			});
			this.editorBindings?.unbindByPath(file.path);
			this.log(`syncFileFromDisk: cleared stale bound state for "${file.path}" (no live view)`);
			return false;
		}

		const crdtContent = yTextToString(existingText);
		if (crdtContent === content) {
			this.boundRecoveryLocks.delete(file.path);
			this.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, crdt-current)`);
			return true;
		}

		const viewStates = openViews.map((view) => {
			const editorContent = view.editor.getValue();
			const binding = this.editorBindings?.getBindingDebugInfoForView(view) ?? null;
			const collab = this.editorBindings?.getCollabDebugInfoForView(view) ?? null;
			return {
				view,
				editorContent,
				editorMatchesDisk: editorContent === content,
				editorMatchesCrdt: crdtContent != null && editorContent === crdtContent,
				binding,
				collab,
			};
		});

		const localOnlyViews = viewStates.filter(
			(state) => state.editorMatchesDisk && !state.editorMatchesCrdt,
		);
		if (localOnlyViews.length > 0) {
			this.trace("trace", "bound-file-local-only-divergence", {
				path: file.path,
				diskLength: content.length,
				crdtLength: crdtContent?.length ?? null,
				viewCount: localOnlyViews.length,
				views: localOnlyViews.map((state) => ({
					leafId: state.binding?.leafId ?? null,
					storedCmId: state.binding?.storedCmId ?? null,
					liveCmId: state.binding?.liveCmId ?? null,
					cmMatches: state.binding?.cmMatches ?? null,
					hasSyncFacet: state.collab?.hasSyncFacet ?? null,
					awarenessMatchesProvider: state.collab?.awarenessMatchesProvider ?? null,
					yTextMatchesExpected: state.collab?.yTextMatchesExpected ?? null,
					undoManagerMatchesFacet: state.collab?.undoManagerMatchesFacet ?? null,
					facetFileId: state.collab?.facetFileId ?? null,
					expectedFileId: state.collab?.expectedFileId ?? null,
				})),
			});

			if (existingText) {
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-local-only-divergence",
				)) {
					this.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound local-only divergence: ${crdtContent?.length ?? 0} -> ${content.length} chars)`,
				);
				this.trace("trace", "bound-file-recovery-source-selected", {
					path: file.path,
					reason: "bound-file-local-only-divergence",
					chosenSource: "disk",
					action: "applied-repair-only",
					editorLengths: localOnlyViews.map((state) => state.editorContent.length),
					diskLength: content.length,
					crdtLength: crdtContent?.length ?? null,
				});
				applyDiffToYText(existingText, crdtContent ?? "", content, "disk-sync-recover-bound");
			} else {
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"bound-file-local-only-seed",
				)) {
					this.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound, missing CRDT text: seeding ${content.length} chars)`,
				);
				this.vaultSync?.ensureFile(
					file.path,
					content,
					this.settings.deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
			}
			this.boundRecoveryLocks.set(file.path, Date.now() + BOUND_RECOVERY_LOCK_MS);

			for (const state of localOnlyViews) {
				const repaired = this.editorBindings?.repair(
					state.view,
					this.settings.deviceName,
					"bound-file-local-only-divergence",
				) ?? false;
				if (!repaired) {
					this.editorBindings?.rebind(
						state.view,
						this.settings.deviceName,
						"bound-file-local-only-divergence",
					);
				}
			}

			this.scheduleTraceStateSnapshot("bound-file-desync-recovery");
			return true;
		}

		const crdtOnlyViews = viewStates.filter(
			(state) => state.editorMatchesCrdt && !state.editorMatchesDisk,
		);
		if (crdtOnlyViews.length > 0) {
			const lastEditorActivity = this.editorBindings?.getLastEditorActivityForPath(file.path) ?? null;
			const hasRecentEditorActivity = lastEditorActivity != null
				&& (Date.now() - lastEditorActivity) < OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS;
			if (hasRecentEditorActivity) {
				this.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, disk lag)`);
				return true;
			}

			// Active editor is open but idle; treat disk as an external edit
			// and ingest it into CRDT instead of deferring forever.
			if (existingText) {
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-open-idle-disk-recovery",
				)) {
					this.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound external disk edit while idle: ${crdtContent?.length ?? 0} -> ${content.length} chars)`,
				);
				applyDiffToYText(existingText, crdtContent ?? "", content, "disk-sync-open-idle-recover");
			} else {
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"bound-file-open-idle-seed",
				)) {
					this.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound idle disk edit, missing CRDT text: seeding ${content.length} chars)`,
				);
				this.vaultSync?.ensureFile(
					file.path,
					content,
					this.settings.deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
			}
			this.boundRecoveryLocks.set(file.path, Date.now() + BOUND_RECOVERY_LOCK_MS);
			this.scheduleTraceStateSnapshot("bound-file-open-idle-disk-recovery");
			return true;
		}

		this.trace("trace", "bound-file-ambiguous-divergence", {
			path: file.path,
			diskLength: content.length,
			crdtLength: crdtContent?.length ?? null,
			views: viewStates.map((state) => ({
				leafId: state.binding?.leafId ?? null,
				storedCmId: state.binding?.storedCmId ?? null,
				liveCmId: state.binding?.liveCmId ?? null,
				cmMatches: state.binding?.cmMatches ?? null,
				editorMatchesDisk: state.editorMatchesDisk,
				editorMatchesCrdt: state.editorMatchesCrdt,
				hasSyncFacet: state.collab?.hasSyncFacet ?? null,
				awarenessMatchesProvider: state.collab?.awarenessMatchesProvider ?? null,
				yTextMatchesExpected: state.collab?.yTextMatchesExpected ?? null,
				undoManagerMatchesFacet: state.collab?.undoManagerMatchesFacet ?? null,
				facetFileId: state.collab?.facetFileId ?? null,
				expectedFileId: state.collab?.expectedFileId ?? null,
			})),
		});
		this.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, ambiguous divergence)`);
		this.scheduleTraceStateSnapshot("bound-file-ambiguous");
		return true;
	}

	private shouldBlockFrontmatterIngest(
		path: string,
		previousContent: string | null,
		nextContent: string,
		reason: string,
	): boolean {
		if (!this.settings.frontmatterGuardEnabled) return false;

		const validation = validateFrontmatterTransition(previousContent, nextContent);
		this.handleFrontmatterValidation(
			path,
			"disk-to-crdt",
			reason,
			validation,
			previousContent,
			nextContent,
		);
		if (!isFrontmatterBlocked(validation)) return false;
		this.log(
			`Frontmatter ingest blocked for "${path}" ` +
			`(${validation.reasons.join(", ") || validation.risk})`,
		);
		return true;
	}

	private handleFrontmatterValidation(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		reason: string,
		validation: FrontmatterValidationResult,
		previousContent: string | null,
		nextContent: string,
	): void {
		if (validation.risk === "ok") {
			this.clearFrontmatterNoticeFingerprint(path, direction);
			void this.clearFrontmatterQuarantine(path, `${direction}:${reason}`);
			return;
		}

		if (!isFrontmatterBlocked(validation)) return;

		const noticeFingerprint = this.buildFrontmatterNoticeFingerprint(
			validation,
		);
		const shouldNotify = this.shouldNotifyFrontmatterQuarantine(
			path,
			direction,
			noticeFingerprint,
		);
		const notifiedAt = shouldNotify ? Date.now() : null;

		this.traceFrontmatterQuarantine(
			path,
			direction,
			reason,
			validation,
			previousContent?.length ?? null,
			nextContent.length,
		);
		if (shouldNotify) {
			this.showFrontmatterGuardNotice(path);
		}
		void this.persistFrontmatterQuarantine(
			path,
			direction,
			validation,
			previousContent,
			nextContent,
			noticeFingerprint,
			notifiedAt,
		);
	}

	private showFrontmatterGuardNotice(path: string): void {
		new Notice(
			`YAOS paused a properties update in "${path}" because the frontmatter looked unsafe. Check diagnostics before accepting the change.`,
			12_000,
		);
	}

	private buildFrontmatterNoticeFingerprint(
		validation: FrontmatterValidationResult,
	): string {
		const reasons = [...validation.reasons].sort().join("|");
		return [
			reasons,
			String(validation.previousFrontmatterLength ?? "none"),
			String(validation.frontmatterLength ?? "none"),
		].join("#");
	}

	private shouldNotifyFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		noticeFingerprint: string,
	): boolean {
		const key = `${direction}:${path}`;
		const previousFingerprint = this.frontmatterGuardNoticeFingerprints.get(key);
		if (previousFingerprint === noticeFingerprint) {
			return false;
		}
		this.frontmatterGuardNoticeFingerprints.set(key, noticeFingerprint);
		return true;
	}

	private clearFrontmatterNoticeFingerprint(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
	): void {
		const key = `${direction}:${path}`;
		this.frontmatterGuardNoticeFingerprints.delete(key);
	}

	private traceFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		reason: string,
		validation: FrontmatterValidationResult,
		previousLength: number | null,
		nextLength: number,
	): void {
		this.trace("trace", "frontmatter-quarantined", {
			path,
			direction,
			reason,
			risk: validation.risk,
			reasons: validation.reasons,
			previousLength,
			nextLength,
			previousFrontmatterLength: validation.previousFrontmatterLength ?? null,
			nextFrontmatterLength: validation.frontmatterLength,
		});
	}

	private async persistFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		validation: FrontmatterValidationResult,
		previousContent: string | null,
		nextContent: string,
		lastNotifiedFingerprint: string,
		lastNoticeAt: number | null,
	): Promise<void> {
		const now = Date.now();
		const prevHash = await this.hashFrontmatterContent(previousContent);
		const nextHash = await this.hashFrontmatterContent(nextContent);
		this.frontmatterQuarantineEntries = upsertFrontmatterQuarantineEntry(
			this.frontmatterQuarantineEntries,
			{
				path,
				firstSeenAt: now,
				lastSeenAt: now,
				direction,
				reasons: validation.reasons,
				prevHash,
				nextHash,
				lastNotifiedFingerprint,
				lastNoticeAt: lastNoticeAt ?? undefined,
				count: 1,
			},
		);
		await this.persistPluginState();
	}

	private async clearFrontmatterQuarantine(path: string, reason: string): Promise<void> {
		if (this.frontmatterQuarantineEntries.length === 0) return;
		const nextEntries = clearFrontmatterQuarantinePath(this.frontmatterQuarantineEntries, path);
		if (nextEntries.length === this.frontmatterQuarantineEntries.length) return;
		this.frontmatterQuarantineEntries = nextEntries;
		this.trace("trace", "frontmatter-quarantine-cleared", {
			path,
			reason,
		});
		await this.persistPluginState();
	}

	private async updateDiskIndexForPath(path: string): Promise<void> {
		try {
			const stat = await this.app.vault.adapter.stat(path);
			if (stat) {
				this.diskIndex[path] = { mtime: stat.mtime, size: stat.size };
			}
		} catch {
			// Stat failed, index will be stale for this path.
		}
	}

	/**
	 * Toggle remote cursor visibility via a CSS class on the document body.
	 * The actual cursor styles from y-codemirror.next are hidden when the
	 * class is absent; we add it when showRemoteCursors is true.
	 */
	applyCursorVisibility(): void {
		document.body.toggleClass(
			"vault-crdt-show-cursors",
			this.settings.showRemoteCursors,
		);
	}

	private refreshStatusBar(): void {
		const state = this.computeSyncStatus();
		if (state === "error" && this.vaultSync?.idbError) {
			this.handleIndexedDbDegraded("status-check");
		}
		this.updateStatusBar(state);
	}

	private computeSyncStatus(): SyncStatus {
		if (this.vaultSync?.idbError) {
			return "error";
		}

		return this.syncStatusFromConnectionState(this.connectionController?.getState() ?? { kind: "disconnected" });
	}

	private syncStatusFromConnectionState(state: ConnectionState): SyncStatus {
		switch (state.kind) {
			case "disconnected":
				return "disconnected";
			case "loading_cache":
				return "loading";
			case "connecting":
				return "syncing";
			case "online":
				return "connected";
			case "offline":
				return "offline";
			case "auth_failed":
				return "unauthorized";
			case "server_update_required":
				return "error";
		}
	}

	getSettingsStatusSummary(): { state: SyncStatus; label: string } {
		const state = this.computeSyncStatus();
		return {
			state,
			label: getSyncStatusLabel(state).replace(/^CRDT:\s*/, ""),
		};
	}

	private updateStatusBar(state: SyncStatus): void {
		if (!this.statusBarEl) return;
		renderSyncStatus(this.statusBarEl, state, this.blobSync?.transferStatus);
	}

	private setupTraceLogger(): void {
		if (!this.settings.debug) return;

		this.traceLogger = new PersistentTraceLogger(this.app, {
			enabled: this.settings.debug,
			deviceName: this.settings.deviceName || "unknown-device",
			vaultId: this.settings.vaultId || "unknown-vault",
		});
		this.trace(
			"trace",
			"trace-session-start",
			{
				host: this.settings.host,
				enableAttachmentSync: this.settings.enableAttachmentSync,
				externalEditPolicy: this.settings.externalEditPolicy,
			},
		);

		this.traceStateInterval = setInterval(() => {
			this.scheduleTraceStateSnapshot("interval");
		}, 5000);
		this.traceServerInterval = setInterval(() => {
			void this.refreshServerTrace();
		}, 15000);

		const errorHandler = (event: ErrorEvent) => {
			if (this.isIndexedDbRelatedError(event.error ?? event.message)) {
				this.trace("trace", "window-error-indexeddb", {
					message: event.message,
					filename: event.filename,
					lineno: event.lineno,
					colno: event.colno,
				});
				this.handleIndexedDbDegraded("window-error", event.error ?? event.message);
				this.scheduleTraceStateSnapshot("window-error-indexeddb");
				event.preventDefault();
				return;
			}
			this.trace("trace", "window-error", {
				message: event.message,
				filename: event.filename,
				lineno: event.lineno,
				colno: event.colno,
			});
			this.traceLogger?.captureCrash("window-error", event.error ?? event.message, {
				filename: event.filename,
				lineno: event.lineno,
				colno: event.colno,
			});
			this.scheduleTraceStateSnapshot("window-error");
		};

		const rejectionHandler = (event: PromiseRejectionEvent) => {
			if (this.isIndexedDbRelatedError(event.reason)) {
				this.trace("trace", "unhandled-rejection-indexeddb", {
					reason: String(event.reason),
				});
				this.handleIndexedDbDegraded("unhandled-rejection", event.reason);
				this.scheduleTraceStateSnapshot("unhandled-rejection-indexeddb");
				event.preventDefault();
				return;
			}
			if (this.isObsidianFileMetadataRaceError(event.reason)) {
				const now = Date.now();
				if (now - this.lastMetadataRaceRejectionAt >= 5000) {
					this.lastMetadataRaceRejectionAt = now;
					this.trace("trace", "unhandled-rejection-file-metadata-race", {
						reason: String(event.reason),
					});
					this.scheduleTraceStateSnapshot("unhandled-rejection-file-metadata-race");
				}
				event.preventDefault();
				return;
			}
			this.trace("trace", "unhandled-rejection", {
				reason: String(event.reason),
			});
			this.traceLogger?.captureCrash("unhandled-rejection", event.reason);
			this.scheduleTraceStateSnapshot("unhandled-rejection");
		};

		window.addEventListener("error", errorHandler);
		window.addEventListener("unhandledrejection", rejectionHandler);
		this.register(() => {
			window.removeEventListener("error", errorHandler);
			window.removeEventListener("unhandledrejection", rejectionHandler);
		});

		this.register(() => {
			if (this.traceStateInterval) {
				clearInterval(this.traceStateInterval);
				this.traceStateInterval = null;
			}
			if (this.traceServerInterval) {
				clearInterval(this.traceServerInterval);
				this.traceServerInterval = null;
			}
		});
		this.scheduleTraceStateSnapshot("plugin-load");
	}

	private getTraceHttpContext(): TraceHttpContext | undefined {
		return this.traceLogger?.httpContext;
	}

	private trace(
		source: string,
		msg: string,
		details?: TraceEventDetails,
	): void {
		this.traceLogger?.record(source, msg, details);
	}

	private scheduleTraceStateSnapshot(reason: string): void {
		if (!this.traceLogger?.isEnabled) return;
		if (this.traceStateTimer) clearTimeout(this.traceStateTimer);
		this.traceStateTimer = setTimeout(() => {
			this.traceStateTimer = null;
			void this.writeTraceStateSnapshot(reason);
		}, 250);
	}

	private async writeTraceStateSnapshot(reason: string): Promise<void> {
		if (!this.traceLogger?.isEnabled) return;
		const snapshot = await this.buildTraceStateSnapshot(reason);
		this.traceLogger.updateCurrentState(snapshot);
	}

	private async refreshServerTrace(): Promise<void> {
		if (!this.traceLogger?.isEnabled) return;
		if (!this.settings.host || !this.settings.token || !this.settings.vaultId) return;
		if (this.traceServerInFlight) return;

		this.traceServerInFlight = true;
		try {
			const host = this.settings.host.replace(/\/$/, "");
			const roomId = this.settings.vaultId;
			const url = appendTraceParams(
				`${host}/vault/${encodeURIComponent(roomId)}/debug/recent`,
				this.getTraceHttpContext(),
			);
			const res = await obsidianRequest({
				url,
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.settings.token}`,
				},
			});
			if (res.status !== 200) {
				throw new Error(`server debug fetch failed (${res.status})`);
			}

			const payload = res.json as {
				recent?: unknown[];
				roomId?: unknown;
			};
			if (typeof payload.roomId === "string" && payload.roomId !== roomId) {
				throw new Error(
					`server debug fetch returned mismatched room (${payload.roomId})`,
				);
			}

			this.recentServerTrace = Array.isArray(payload.recent)
				? payload.recent.slice(-120)
				: [];
			this.scheduleTraceStateSnapshot("server-trace-refresh");
			return;
		} catch (err) {
			this.trace("trace", "server-trace-fetch-failed", {
				error: String(err),
			});
		} finally {
			this.traceServerInFlight = false;
		}
	}

	private async buildTraceStateSnapshot(reason: string): Promise<Record<string, unknown>> {
		return {
			generatedAt: new Date().toISOString(),
			reason,
			trace: this.getTraceHttpContext() ?? null,
			settings: {
				host: this.settings.host,
				vaultId: this.settings.vaultId,
				deviceName: this.settings.deviceName,
				debug: this.settings.debug,
				enableAttachmentSync: this.settings.enableAttachmentSync,
				externalEditPolicy: this.settings.externalEditPolicy,
			},
			state: {
				reconciled: this.reconciliationController.getState().reconciled,
				reconcileInFlight: this.reconciliationController.getState().reconcileInFlight,
				reconcilePending: this.reconciliationController.getState().reconcilePending,
				awaitingFirstProviderSyncAfterStartup: this.awaitingFirstProviderSyncAfterStartup,
				lastReconciledGeneration: this.reconciliationController.getState().lastReconciledGeneration,
				openFileCount: this.openFilePaths.size,
			},
			sync: this.vaultSync?.getDebugSnapshot() ?? null,
			diskMirror: this.diskMirror?.getDebugSnapshot() ?? null,
			blobSync: this.blobSync?.getDebugSnapshot() ?? null,
			openFiles: await this.collectOpenFileTraceState(),
			recentEvents: {
				plugin: this.eventRing.slice(-120),
				sync: this.vaultSync?.getRecentEvents(120) ?? [],
			},
			serverTrace: this.recentServerTrace,
		};
	}

	private async collectOpenFileTraceState(): Promise<Array<Record<string, unknown>>> {
		if (!this.vaultSync) return [];

		const probes: Array<Record<string, unknown>> = [];
		const leaves: MarkdownView[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				leaves.push(leaf.view);
			}
		});

		for (const view of leaves) {
			const file = view.file;
			if (!file) continue;

			const path = file.path;
			const editorContent = view.editor.getValue();
			const diskContent = await this.app.vault.read(file).catch(() => null);
			const crdtContent = yTextToString(this.vaultSync.getTextForPath(path));
			const binding = this.editorBindings?.getBindingDebugInfoForView(view) ?? null;
			const collab = this.editorBindings?.getCollabDebugInfoForView(view) ?? null;

			const [editorHash, diskHash, crdtHash] = await Promise.all([
				this.hashIfPresent(editorContent),
				this.hashIfPresent(diskContent),
				this.hashIfPresent(crdtContent),
			]);

			probes.push({
				path,
				leafId: binding?.leafId ?? ((view.leaf as unknown as { id?: string }).id ?? path),
				binding,
				collab,
				hashes: {
					editor: editorHash,
					disk: diskHash,
					crdt: crdtHash,
				},
				lengths: {
					editor: editorContent.length,
					disk: diskContent?.length ?? null,
					crdt: crdtContent?.length ?? null,
				},
				editorVsDisk: this.describeContentDiff(editorContent, diskContent),
				editorVsCrdt: this.describeContentDiff(editorContent, crdtContent),
				diskVsCrdt: this.describeContentDiff(diskContent, crdtContent),
			});
		}

		return probes;
	}

	private async hashIfPresent(text: string | null): Promise<string | null> {
		if (text == null) return null;
		return this.sha256Hex(text);
	}

	private describeContentDiff(
		left: string | null,
		right: string | null,
	): Record<string, unknown> {
		if (left == null || right == null) {
			return {
				comparable: false,
				leftLength: left?.length ?? null,
				rightLength: right?.length ?? null,
			};
		}

		const firstDiffIndex = this.findFirstDiffIndex(left, right);
		return {
			comparable: true,
			matches: firstDiffIndex === -1,
			firstDiffIndex: firstDiffIndex === -1 ? null : firstDiffIndex,
			leftLength: left.length,
			rightLength: right.length,
			leftSnippet: firstDiffIndex === -1 ? "" : left.slice(firstDiffIndex, firstDiffIndex + 160),
			rightSnippet: firstDiffIndex === -1 ? "" : right.slice(firstDiffIndex, firstDiffIndex + 160),
		};
	}

	private findFirstDiffIndex(left: string, right: string): number {
		const max = Math.min(left.length, right.length);
		for (let i = 0; i < max; i++) {
			if (left[i] !== right[i]) return i;
		}
		return left.length === right.length ? -1 : max;
	}

	onunload() {
		this.log("Unloading plugin");
		if (this.traceStateTimer) {
			clearTimeout(this.traceStateTimer);
			this.traceStateTimer = null;
		}
		if (this.traceStateInterval) {
			clearInterval(this.traceStateInterval);
			this.traceStateInterval = null;
		}
		if (this.traceServerInterval) {
			clearInterval(this.traceServerInterval);
			this.traceServerInterval = null;
		}
		void this.traceLogger?.shutdown();
		document.body.removeClass("vault-crdt-show-cursors");
		this.teardownSync();
	}

	async loadSettings() {
		const { settings, persistedState, migrated } = await this.settingsStore.load();
		const data = persistedState;
		this.persistedState = persistedState;
		this.settings = settings;
		// Load disk index from plugin data (stored under _diskIndex key)
		if (data && typeof data._diskIndex === "object" && data._diskIndex !== null) {
			this.diskIndex = data._diskIndex;
		}
		// Load blob hash cache
		if (data && typeof data._blobHashCache === "object" && data._blobHashCache !== null) {
			this.blobHashCache = data._blobHashCache;
		}
		// Load persisted blob queue
		if (data && typeof data._blobQueue === "object" && data._blobQueue !== null) {
			this.savedBlobQueue = data._blobQueue;
		}
		const cachedCapabilities = readPersistedServerCapabilitiesCache(data?._serverCapabilitiesCache);
		const cachedUpdateManifest = readPersistedUpdateManifestCache(data?._updateManifestCache);
		this.capabilityUpdateService?.hydratePersistedCaches(cachedCapabilities, cachedUpdateManifest);
		this.frontmatterQuarantineEntries = readPersistedFrontmatterQuarantine(data?._frontmatterQuarantine);
		this.refreshPersistedState();
		if (migrated) {
			await this.persistPluginState();
		}
	}

	async saveSettings(reason = "settings-save") {
		await this.persistPluginState();
		this.applyRuntimeSettings(reason);
		this.refreshStatusBar();
		void this.syncUpdateMetadataToServer(reason);
	}

	async updateSettings(
		mutator: (settings: VaultSyncSettings) => void,
		reason = "settings-update",
	): Promise<void> {
		mutator(this.settings);
		await this.saveSettings(reason);
	}

	private applyRuntimeSettings(reason: string): void {
		this.runtimeConfig = buildRuntimeConfig(this.settings, this.app.vault.configDir);
		this.excludePatterns = this.runtimeConfig.excludePatterns;
		this.maxFileSize = this.runtimeConfig.maxFileSizeBytes;
		this.applyCursorVisibility();
		this.trace("trace", "runtime-settings-applied", {
			reason,
			hostConfigured: !!this.runtimeConfig.host,
			vaultIdConfigured: !!this.runtimeConfig.vaultId,
			enableAttachmentSync: this.runtimeConfig.enableAttachmentSync,
			externalEditPolicy: this.runtimeConfig.externalEditPolicy,
			maxFileSizeKB: this.runtimeConfig.maxFileSizeKB,
			excludePatternCount: this.runtimeConfig.excludePatterns.length,
		});
	}

	get serverAuthMode(): ServerCapabilities["authMode"] | "unknown" {
		return this.capabilityUpdateService?.authMode ?? "unknown";
	}

	get serverSupportsAttachments(): boolean {
		return this.capabilityUpdateService?.supportsAttachments ?? true;
	}

	get serverSupportsSnapshots(): boolean {
		return this.capabilityUpdateService?.supportsSnapshots ?? true;
	}

	buildSetupDeepLink(): string | null {
		const host = this.settings.host?.trim().replace(/\/$/, "");
		const token = this.settings.token?.trim();
		const vaultId = this.settings.vaultId?.trim();
		if (!host || !token || !vaultId) return null;
		const params = new URLSearchParams({
			action: "setup",
			host,
			token,
			vaultId,
		});
		return `obsidian://yaos?${params.toString()}`;
	}

	buildMobileSetupUrl(): string | null {
		const host = this.settings.host?.trim().replace(/\/$/, "");
		const token = this.settings.token?.trim();
		const vaultId = this.settings.vaultId?.trim();
		if (!host || !token || !vaultId) return null;
		const hash = new URLSearchParams({
			host,
			token,
			vaultId,
		});
		return `${host}/mobile-setup#${hash.toString()}`;
	}

	buildRecoveryKitText(): string | null {
		const host = this.settings.host?.trim().replace(/\/$/, "");
		const token = this.settings.token?.trim();
		const vaultId = this.settings.vaultId?.trim();
		if (!host || !token || !vaultId) return null;
		return [
			"YAOS Recovery Kit",
			`Created: ${new Date().toISOString()}`,
			"",
			`Host: ${host}`,
			`Token: ${token}`,
			`Vault ID: ${vaultId}`,
			"",
			"Keep this in a password manager. You need host + token + vault ID to recover this sync room on a new device.",
		].join("\n");
	}

	private createBlobSyncManager(): BlobSyncManager | null {
		if (!this.vaultSync) return null;
		if (!this.runtimeConfig.host || !this.runtimeConfig.token) return null;
		return new BlobSyncManager(
			this.app,
			this.vaultSync,
			{
				host: this.runtimeConfig.host,
				token: this.runtimeConfig.token,
				vaultId: this.runtimeConfig.vaultId,
				maxAttachmentSizeKB: this.runtimeConfig.maxAttachmentSizeKB,
				attachmentConcurrency: this.runtimeConfig.attachmentConcurrency,
				debug: this.runtimeConfig.debug,
				trace: this.getTraceHttpContext(),
			},
			this.blobHashCache,
			(source, msg, details) => this.trace(source, msg, details),
		);
	}

	private startBlobSyncEngine(reason: string, runInitialReconcile: boolean): void {
		if (this.blobSync) return;
		if (!this.runtimeConfig.enableAttachmentSync || !this.serverSupportsAttachments) return;

		const blobSync = this.createBlobSyncManager();
		if (!blobSync) return;

		this.blobSync = blobSync;
		this.blobSync.startObservers();
		this.log(`Attachment sync engine started (${reason})`);

		// Restore persisted queue from previous session
		if (this.savedBlobQueue) {
			this.blobSync.importQueue(this.savedBlobQueue);
			this.savedBlobQueue = null;
		}

		this.maybeOpenBlobDownloadGate(`engine-start:${reason}`);

		if (runInitialReconcile) {
			try {
				const result = this.blobSync.reconcile("authoritative", this.excludePatterns);
				this.log(
					`Attachment reconcile (${reason}): queued ` +
					`${result.uploadQueued} uploads, ${result.downloadQueued} downloads, ${result.skipped} skipped`,
				);
			} catch (err) {
				this.log(`Attachment reconcile (${reason}) failed: ${formatUnknown(err)}`);
			}
		}
	}

	private async stopBlobSyncEngine(reason: string): Promise<void> {
		if (!this.blobSync) return;
		const snapshot = this.blobSync.exportQueue();
		if (snapshot.uploads.length > 0 || snapshot.downloads.length > 0) {
			await this.saveBlobQueue();
		}
		this.blobSync.destroy();
		this.blobSync = null;
		this.log(`Attachment sync engine stopped (${reason})`);
	}

	private maybeOpenBlobDownloadGate(reason: string): void {
		if (!this.blobSync) return;
		if (this.blobSync.isDownloadGateOpen) return;
		if (!this.blobDownloadGateLayoutReady || !this.blobDownloadGateStartupReady) return;
		this.trace("trace", "blob-download-gate-open", {
			reason,
			pendingDownloads: this.blobSync.pendingDownloads,
		});
		this.blobSync.openDownloadGate(reason);
		this.scheduleTraceStateSnapshot(`blob-download-gate:${reason}`);
	}

	private markBlobDownloadStartupReady(reason: string): void {
		if (this.blobDownloadGateStartupReady) return;
		this.blobDownloadGateStartupReady = true;
		this.trace("trace", "blob-download-startup-ready", { reason });
		this.log(`Blob download gate: startup ready (${reason})`);
		this.maybeOpenBlobDownloadGate(`startup-ready:${reason}`);
	}

	async refreshAttachmentSyncRuntime(reason = "settings-change"): Promise<void> {
		if (!this.vaultSync) return;
		if (this.runtimeConfig.enableAttachmentSync && this.serverSupportsAttachments) {
			this.startBlobSyncEngine(reason, true);
		} else {
			await this.stopBlobSyncEngine(reason);
		}
		this.refreshStatusBar();
	}

	private enforceCompatibilityGuard(reason: string): boolean {
		return this.capabilityUpdateService?.enforceCompatibilityGuard(reason) ?? false;
	}

	async refreshServerCapabilities(reason = "manual"): Promise<void> {
		await this.capabilityUpdateService?.refreshServerCapabilities(reason);
	}

	async refreshUpdateManifest(reason = "manual", force = false): Promise<void> {
		await this.capabilityUpdateService?.refreshUpdateManifest(reason, force);
	}

	getUpdateState(): UpdateState {
		return this.capabilityUpdateService?.getUpdateState() ?? {
			serverVersion: null,
			latestServerVersion: null,
			serverUpdateAvailable: false,
			pluginVersion: this.manifest.version,
			latestPluginVersion: null,
			pluginUpdateRecommended: false,
			migrationRequired: false,
			updateProvider: "unknown",
			updateRepoUrl: null,
			updateActionUrl: null,
			updateBootstrapUrl: null,
			updateActionLabel: "YAOS settings",
			legacyServerDetected: false,
			pluginCompatibilityWarning: null,
		};
	}

	buildServerUpdateUrl(): string | null {
		return this.capabilityUpdateService?.buildServerUpdateUrl() ?? null;
	}

	buildGithubUpdaterBootstrapUrl(): string | null {
		return this.capabilityUpdateService?.buildGithubUpdaterBootstrapUrl() ?? null;
	}

	private async syncUpdateMetadataToServer(reason: string): Promise<void> {
		await this.capabilityUpdateService?.syncUpdateMetadataToServer(reason);
	}

		private async confirmVaultIdSwitch(
			currentVaultId: string,
			incomingVaultId: string,
			localMarkdownCount: number,
		): Promise<boolean> {
			return await new Promise((resolve) => {
				new ConfirmModal(
					this.app,
					"Switch vault ID",
					`This pairing link points to a different vault ID. ` +
					`Current vault ID: ${currentVaultId}. Incoming vault ID: ${incomingVaultId}. ` +
					`This vault currently has ${localMarkdownCount} local markdown files. ` +
					`Switching rooms may pull a different remote state. Continue and switch to the incoming vault ID?`,
				() => resolve(true),
				"Switch vault ID",
				"Keep current vault ID",
				() => resolve(false),
			).open();
		});
	}

		private async handleSetupLink(params: Record<string, string>): Promise<void> {
			const host = typeof params.host === "string" ? params.host.trim() : "";
			const token = typeof params.token === "string" ? params.token.trim() : "";
			const incomingVaultId = typeof params.vaultId === "string" ? params.vaultId.trim() : "";
			if (!host || !token) {
				new Notice("Setup link is missing a host or token.");
				return;
			}
			if (!incomingVaultId) {
				new Notice(
					"Setup link is missing the vault ID. This may create a separate sync room on this device.",
					8000,
				);
			}

		const currentVaultId = this.settings.vaultId?.trim() ?? "";
		if (incomingVaultId && currentVaultId && incomingVaultId !== currentVaultId) {
			const localMarkdownCount = this.app.vault
				.getMarkdownFiles()
				.filter((file) => this.isMarkdownPathSyncable(file.path))
				.length;
			if (localMarkdownCount > 5) {
				const confirmed = await this.confirmVaultIdSwitch(
					currentVaultId,
					incomingVaultId,
					localMarkdownCount,
					);
					if (!confirmed) {
						new Notice("Pairing cancelled. Vault ID unchanged.", 6000);
						return;
					}
				}
		}

		await this.updateSettings((settings) => {
			settings.host = host.replace(/\/$/, "");
			settings.token = token;
			if (incomingVaultId) {
				settings.vaultId = incomingVaultId;
			}
		}, "setup-link");
		await this.refreshServerCapabilities();
			new Notice("Server linked. Starting sync...", 6000);

		if (!this.vaultSync) {
			void this.initSync();
			return;
		}

			new Notice("Settings saved. Reload the plugin to reconnect with the new server.", 8000);
		}

		private showFatalSyncNotice(): void {
			const code = this.vaultSync?.fatalAuthCode;
			if (code === "unclaimed") {
				new Notice(
					"This server is unclaimed. Open the server URL in a browser, then use the setup link.",
					10000,
				);
				return;
			}

			if (code === "server_misconfigured") {
				new Notice("Server misconfigured.");
				return;
			}
		if (code === "update_required") {
			const details = this.vaultSync?.fatalAuthDetails;
			const detailText =
				details && (details.roomSchemaVersion !== null || details.clientSchemaVersion !== null)
					? ` (client=${details.clientSchemaVersion ?? "unknown"}, room=${details.roomSchemaVersion ?? "unknown"})`
					: "";
			new Notice(
				`YAOS: this vault was upgraded by a newer plugin schema${detailText}. ` +
				"Update YAOS on this device to continue syncing.",
				12000,
			);
			return;
		}

			new Notice("Unauthorized. Check your token in settings.");
		}

	private async saveDiskIndex(): Promise<void> {
		await this.persistPluginState();
	}

	private async saveBlobQueue(): Promise<void> {
		if (!this.blobSync) return;
		const snapshot = this.blobSync.exportQueue();
		// Only write if there's actually something to persist
		if (snapshot.uploads.length === 0 && snapshot.downloads.length === 0) return;
		await this.persistPluginState((state) => {
			state._blobQueue = snapshot;
		});
	}

	/**
	 * Clear the persisted blob queue once all transfers are done.
	 * Only writes if there was previously a saved queue.
	 */
	private async clearSavedBlobQueue(): Promise<void> {
		if (!this.persistedState._blobQueue) return;
		await this.persistPluginState((state) => {
			delete state._blobQueue;
		});
	}

	private refreshPersistedState(): void {
		const nextState: PersistedPluginState = {
			...this.settingsStore.withSettings(this.persistedState, this.settings),
			_diskIndex: this.diskIndex,
			_blobHashCache: this.blobHashCache,
		};
		const cachedCapabilities = this.capabilityUpdateService?.getPersistedServerCapabilitiesCache();
		if (cachedCapabilities) {
			nextState._serverCapabilitiesCache = cachedCapabilities;
		} else {
			delete nextState._serverCapabilitiesCache;
		}
		const cachedUpdateManifest = this.capabilityUpdateService?.getPersistedUpdateManifestCache();
		if (cachedUpdateManifest) {
			nextState._updateManifestCache = cachedUpdateManifest;
		} else {
			delete nextState._updateManifestCache;
		}
		if (this.frontmatterQuarantineEntries.length > 0) {
			nextState._frontmatterQuarantine = this.frontmatterQuarantineEntries;
		} else {
			delete nextState._frontmatterQuarantine;
		}
		this.persistedState = nextState;
	}

	private async persistPluginState(
		mutate?: (state: PersistedPluginState) => void,
	): Promise<void> {
		// Serialize all plugin data writes so settings/index/blob queue updates
		// cannot clobber each other with interleaved load/merge/save cycles.
		const write = async () => {
			this.refreshPersistedState();
			mutate?.(this.persistedState);
			await this.settingsStore.save(this.persistedState);
		};

		this.persistWriteChain = this.persistWriteChain
			.catch(() => undefined)
			.then(write);
		await this.persistWriteChain;
	}

	private async sha256Hex(text: string): Promise<string> {
		const data = new TextEncoder().encode(text);
		const digest = await crypto.subtle.digest("SHA-256", data);
		return arrayBufferToHex(digest);
	}

	private async hashFrontmatterContent(content: string | null): Promise<string | undefined> {
		if (content == null) return undefined;
		const block = extractFrontmatter(content);
		if (block.kind !== "present") return undefined;
		return await this.sha256Hex(block.frontmatterText);
	}

	private runSchemaMigrationToV2(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized.");
			return;
		}

			const fromVersion = this.vaultSync.storedSchemaVersion;
			if (fromVersion !== null && fromVersion >= 2) {
				new Notice("This vault is already on schema v2.");
				return;
			}

		new ConfirmModal(
			this.app,
			"Migrate sync schema to v2",
			"This will switch this vault to schema v2 and block older YAOS clients from syncing " +
			"until they are upgraded. YAOS will export diagnostics before and after migration. Continue?",
			async () => {
				if (!this.vaultSync) return;

					try {
						new Notice("Exporting pre-migration diagnostics...", 7000);
						await this.diagnosticsService?.exportDiagnostics();
					} catch (err) {
						this.log(`schema migration: preflight diagnostics export failed: ${String(err)}`);
				}

				const result = this.vaultSync.migrateSchemaToV2(this.settings.deviceName);
				this.log(
					`schema migration result: ${JSON.stringify(result)}`,
				);
				const loserCleanupCount = await this.cleanupMigrationLoserPaths(result.loserPaths);
				if (loserCleanupCount > 0) {
					this.log(`schema migration: removed ${loserCleanupCount} loser-path file(s) from disk`);
				}

				const mode = this.vaultSync.getSafeReconcileMode();
				await this.runReconciliation(mode);
				this.bindAllOpenEditors();
				this.validateAllOpenBindings("schema-migration");

					try {
						new Notice("Exporting post-migration diagnostics...", 7000);
						await this.diagnosticsService?.exportDiagnostics();
					} catch (err) {
						this.log(`schema migration: postflight diagnostics export failed: ${String(err)}`);
				}

				new Notice(
					`YAOS: schema v2 migration complete` +
					(loserCleanupCount > 0 ? ` (${loserCleanupCount} local alias file(s) cleaned).` : ".") +
					" Update YAOS on your other devices before reconnecting them.",
					12000,
				);
			},
		).open();
	}

	private async cleanupMigrationLoserPaths(paths: string[]): Promise<number> {
		if (paths.length === 0) return 0;
		let removed = 0;
		for (const path of paths) {
			const node = this.app.vault.getAbstractFileByPath(path);
			if (!(node instanceof TFile)) continue;
			try {
				await this.app.fileManager.trashFile(node);
				removed++;
			} catch (err) {
				this.log(`schema migration: failed to remove loser path "${path}": ${String(err)}`);
			}
		}
		return removed;
	}

	private async runVfsTortureTest(): Promise<void> {
		if (!this.vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		const startedAt = Date.now();
		const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
		const rootDir = normalizePath(`YAOS QA/vfs-torture-${runId}`);
		const steps: Array<{
			name: string;
			status: "ok" | "error" | "skipped";
			timestamp: string;
			durationMs: number;
			detail: string;
		}> = [];

		const ensureFolder = async (folderPath: string): Promise<void> => {
			const normalized = normalizePath(folderPath);
			if (!normalized) return;
			const segments = normalized.split("/").filter(Boolean);
			let current = "";
			for (const segment of segments) {
				current = current ? `${current}/${segment}` : segment;
				if (!this.app.vault.getAbstractFileByPath(current)) {
					await this.app.vault.createFolder(current);
				}
			}
		};

		const runStep = async (
			name: string,
			fn: () => Promise<string | void>,
		): Promise<void> => {
			const stepStartedAt = Date.now();
			try {
				const detail = (await fn()) ?? "";
				steps.push({
					name,
					status: "ok",
					timestamp: new Date().toISOString(),
					durationMs: Date.now() - stepStartedAt,
					detail,
				});
			} catch (err) {
				const detail = err instanceof Error ? err.stack ?? err.message : String(err);
				steps.push({
					name,
					status: "error",
					timestamp: new Date().toISOString(),
					durationMs: Date.now() - stepStartedAt,
					detail,
				});
				this.log(`VFS torture step failed [${name}]: ${detail}`);
			}
		};

			new Notice("Running filesystem torture test...");
		this.log(`VFS torture: starting run ${runId} in "${rootDir}"`);

		await runStep("Create sandbox folder structure", async () => {
			await ensureFolder(rootDir);
			await ensureFolder(`${rootDir}/rename-source/nested`);
			return `Created sandbox at ${rootDir}`;
		});

		await runStep("Burst edit markdown file", async () => {
			const burstPath = normalizePath(`${rootDir}/burst.md`);
			const burstFile = await this.app.vault.create(
				burstPath,
				"# YAOS burst test\n\nStart of burst edits.",
			);
			for (let i = 1; i <= 10; i++) {
				const current = await this.app.vault.read(burstFile);
				await this.app.vault.modify(
					burstFile,
					`${current}\n- burst edit ${i} @ ${new Date().toISOString()}`,
				);
			}
			return `Applied 10 rapid app-level writes to ${burstPath}`;
		});

		await runStep("Rapid create/rename/edit sequence", async () => {
			const untitledPath = normalizePath(`${rootDir}/Untitled.md`);
			const renamedPath = normalizePath(`${rootDir}/Meeting Notes.md`);
			const untitledFile = await this.app.vault.create(
				untitledPath,
				"# Quick rename flow\n\nseed",
			);
			await this.app.vault.modify(untitledFile, "# Quick rename flow\n\nseed\nline 1");
			await this.app.fileManager.renameFile(untitledFile, renamedPath);
			const renamedFile = this.app.vault.getAbstractFileByPath(renamedPath);
			if (!(renamedFile instanceof TFile)) {
				throw new Error(`Expected renamed file at "${renamedPath}"`);
			}
			const current = await this.app.vault.read(renamedFile);
			await this.app.vault.modify(renamedFile, `${current}\nline 2`);
			return `Renamed ${untitledPath} -> ${renamedPath} and appended a post-rename edit`;
		});

		await runStep("Folder rename cascade with post-rename edit", async () => {
			const sourceFolder = normalizePath(`${rootDir}/rename-source`);
			const destinationFolder = normalizePath(`${rootDir}/rename-destination`);
			const targetPath = normalizePath(`${sourceFolder}/nested/target.md`);
			await this.app.vault.create(targetPath, "# Rename target\n\nbefore rename");

			const sourceNode = this.app.vault.getAbstractFileByPath(sourceFolder);
			if (!sourceNode) {
				throw new Error(`Folder missing: ${sourceFolder}`);
			}
			await this.app.fileManager.renameFile(sourceNode, destinationFolder);

			const movedTargetPath = normalizePath(`${destinationFolder}/nested/target.md`);
			const movedTarget = this.app.vault.getAbstractFileByPath(movedTargetPath);
			if (!(movedTarget instanceof TFile)) {
				throw new Error(`Renamed target missing: ${movedTargetPath}`);
			}
			const current = await this.app.vault.read(movedTarget);
			await this.app.vault.modify(movedTarget, `${current}\npost-rename line`);
			return `Renamed folder ${sourceFolder} -> ${destinationFolder}`;
		});

		await runStep("Delete and recreate same path", async () => {
			const tombstonePath = normalizePath(`${rootDir}/tombstone.md`);
			const file = await this.app.vault.create(
				tombstonePath,
				"# Tombstone test\n\noriginal content",
			);
			await this.app.fileManager.trashFile(file);
			await this.app.vault.create(
				tombstonePath,
				"# Tombstone test\n\nrecreated content",
			);
			return `Deleted and recreated ${tombstonePath}`;
		});

		await runStep("Create 3 MB binary attachment", async () => {
			const blobPath = normalizePath(`${rootDir}/attachment-3mb.bin`);
			const bytes = new Uint8Array(3 * 1024 * 1024);
			for (let i = 0; i < bytes.length; i++) {
				bytes[i] = i % 251;
			}
			await this.app.vault.createBinary(blobPath, bytes.buffer);
			if (!this.settings.enableAttachmentSync) {
				return `Created ${blobPath} (${bytes.length} bytes). Attachment sync is disabled in settings.`;
			}
			return `Created ${blobPath} (${bytes.length} bytes) for attachment sync path`;
		});

		const failures = steps.filter((step) => step.status === "error");
		const report = {
			generatedAt: new Date().toISOString(),
			durationMs: Date.now() - startedAt,
			runId,
			rootDir,
			trace: this.getTraceHttpContext() ?? null,
			settings: {
				host: this.settings.host,
				vaultId: this.settings.vaultId,
				deviceName: this.settings.deviceName,
				enableAttachmentSync: this.settings.enableAttachmentSync,
				externalEditPolicy: this.settings.externalEditPolicy,
				debug: this.settings.debug,
			},
			syncState: {
				connected: this.vaultSync.connected,
				providerSynced: this.vaultSync.providerSynced,
				localReady: this.vaultSync.localReady,
				connectionGeneration: this.vaultSync.connectionGeneration,
				reconciled: this.reconciliationController.getState().reconciled,
				openFileCount: this.openFilePaths.size,
				pathToIdCount: this.vaultSync.pathToId.size,
				activePathCount: this.vaultSync.getActiveMarkdownPaths().length,
				pathToBlobCount: this.vaultSync.pathToBlob.size,
				pendingUploads: this.blobSync?.pendingUploads ?? 0,
				pendingDownloads: this.blobSync?.pendingDownloads ?? 0,
			},
			steps,
			recentEvents: {
				plugin: this.eventRing.slice(-120),
				sync: this.vaultSync.getRecentEvents(120),
			},
		};

		const diagDir = await this.diagnosticsService?.ensureDiagnosticsDir()
			?? normalizePath(`${this.app.vault.configDir}/plugins/yaos/diagnostics`);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const outPath = normalizePath(
			`${diagDir}/vfs-torture-${stamp}-${this.settings.deviceName || "device"}.json`,
		);
		await this.app.vault.adapter.write(outPath, JSON.stringify(report, null, 2));

		if (failures.length > 0) {
			new Notice(
				`YAOS VFS torture run finished with ${failures.length} failed step(s). Report: ${outPath}`,
				12000,
			);
			this.log(
				`VFS torture: completed with ${failures.length} failures. Report=${outPath}`,
			);
			return;
		}

		new Notice(`YAOS VFS torture run completed. Report: ${outPath}`, 10000);
		this.log(`VFS torture: completed successfully. Report=${outPath}`);
	}

	private log(msg: string): void {
		this.eventRing.push({ ts: new Date().toISOString(), msg });
		if (this.eventRing.length > 600) {
			this.eventRing.splice(0, this.eventRing.length - 600);
		}
		this.trace("plugin", msg);
		if (this.settings.debug) {
				console.debug(`[yaos] ${msg}`);
		}
	}

	private isIndexedDbRelatedError(err: unknown): boolean {
		if (!err) return false;
		const name =
			typeof (err as { name?: unknown })?.name === "string"
				? (err as { name: string }).name
				: "";
		const message =
			typeof (err as { message?: unknown })?.message === "string"
				? (err as { message: string }).message
				: formatUnknown(err);
		const haystack = `${name} ${message}`.toLowerCase();
		return haystack.includes("quotaexceeded")
			|| haystack.includes("quota exceeded")
			|| haystack.includes("indexeddb")
			|| haystack.includes("idb");
	}

	private isObsidianFileMetadataRaceError(err: unknown): boolean {
		if (!err) return false;
		const message =
			typeof (err as { message?: unknown })?.message === "string"
				? (err as { message: string }).message
				: formatUnknown(err);
		const haystack = message.toLowerCase();
		return haystack.includes("cannot index file, since it has no obsidian file metadata")
			|| (haystack.includes("failed to index file") && haystack.includes("no obsidian file metadata"));
	}

	private handleIndexedDbDegraded(source: string, err?: unknown): void {
		if (!this.vaultSync) return;
		if (err) {
			this.vaultSync.reportIndexedDbError(err, "runtime");
		}
		if (!this.vaultSync.idbError || this.idbDegradedHandled) return;

		this.idbDegradedHandled = true;
		const kind = this.vaultSync.idbErrorDetails?.kind ?? "unknown";
		this.log(`IndexedDB degraded (${source}): kind=${kind}`);
		this.scheduleTraceStateSnapshot("idb-degraded");

		if (this.blobSync) {
			void this.stopBlobSyncEngine("idb-degraded");
		}

		const notice = kind === "quota_exceeded"
			? "YAOS: Device storage is full. Sync durability is degraded and attachment transfers are paused. Free up storage, then restart Obsidian."
			: "YAOS: IndexedDB persistence failed. Sync durability is degraded and attachment transfers are paused.";
		new Notice(notice, 12000);
	}
}

/**
 * Simple confirmation modal with a message and confirm/cancel buttons.
 */
class ConfirmModal extends Modal {
	private title: string;
	private message: string;
	private onConfirm: () => void | Promise<void>;
	private confirmText: string;
	private cancelText: string;
	private onCancel?: () => void | Promise<void>;
	private confirmed = false;

	constructor(
		app: import("obsidian").App,
		title: string,
		message: string,
		onConfirm: () => void | Promise<void>,
		confirmText = "Confirm",
		cancelText = "Cancel",
		onCancel?: () => void | Promise<void>,
	) {
		super(app);
		this.title = title;
		this.message = message;
		this.onConfirm = onConfirm;
		this.confirmText = confirmText;
		this.cancelText = cancelText;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.message });

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		buttonRow
			.createEl("button", { text: this.cancelText })
			.addEventListener("click", () => this.close());

		const confirmBtn = buttonRow.createEl("button", {
			text: this.confirmText,
			cls: "mod-warning",
		});
		confirmBtn.addEventListener("click", () => {
			this.confirmed = true;
			this.close();
			void this.onConfirm();
		});
	}

	onClose() {
		this.contentEl.empty();
		if (!this.confirmed && this.onCancel) {
			void this.onCancel();
		}
	}
}
