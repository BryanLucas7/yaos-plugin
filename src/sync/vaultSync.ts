import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { normalizePath } from "obsidian";
import { type FileMeta, type BlobRef, type BlobMeta, type BlobTombstone, ORIGIN_SEED } from "../types";
import type { VaultSyncSettings } from "../settings";
import type { TraceHttpContext, TraceRecord } from "../debug/trace";
import { randomBase64Url } from "../utils/base64url";

/** Current schema version. Stored in sys.schemaVersion. */
const SCHEMA_VERSION = 1;

/** Timeouts for the startup sequence. */
const LOCAL_PERSISTENCE_TIMEOUT_MS = 3_000;
const PROVIDER_SYNC_TIMEOUT_MS = 10_000;

/**
 * Reconnection config.
 * y-partyserver uses `2^n * 100ms` capped at `maxBackoffTime`.
 * Default is 2500ms which is aggressive for mobile. We raise it to 30s
 * and the natural jitter from network latency + varying reconnect
 * timing provides sufficient de-correlation.
 */
const MAX_BACKOFF_TIME_MS = 30_000;

/** Debounce window for batching rename events (folder renames). */
const RENAME_BATCH_MS = 50;

/** Reconciliation mode determines what operations are safe. */
export type ReconcileMode = "conservative" | "authoritative";

/**
 * Manages the vault-wide Y.Doc, the Worker sync provider, IndexedDB
 * persistence, and the shared Yjs maps.
 *
 * Schema:
 *   pathToId:        Y.Map<string>         — vault-relative path -> stable fileId (markdown)
 *   idToText:        Y.Map<Y.Text>         — fileId -> Y.Text (markdown content)
 *   meta:            Y.Map<FileMeta>       — fileId -> metadata { path, deleted?, mtime? }
 *   sys:             Y.Map<any>            — sentinel/bookkeeping { initialized, lastSync }
 *   pathToBlob:      Y.Map<BlobRef>        — vault-relative path -> { hash, size }
 *   blobMeta:        Y.Map<BlobMeta>       — sha256 hex -> { size, mime, createdAt }
 *   blobTombstones:  Y.Map<BlobTombstone>  — vault-relative path -> { deletedAt, device? }
 */
export class VaultSync {
	readonly ydoc: Y.Doc;
	readonly provider: YSyncProvider;
	readonly persistence: IndexeddbPersistence;

	readonly pathToId: Y.Map<string>;
	readonly idToText: Y.Map<Y.Text>;
	readonly meta: Y.Map<FileMeta>;
	readonly sys: Y.Map<unknown>;

	// Blob / attachment maps (additive — schema version stays at 1)
	readonly pathToBlob: Y.Map<BlobRef>;
	readonly blobMeta: Y.Map<BlobMeta>;
	readonly blobTombstones: Y.Map<BlobTombstone>;

	/**
	 * In-memory reverse map: Y.Text instance -> fileId.
	 * Populated when texts are created/resolved. WeakMap so GC'd
	 * Y.Text instances don't leak. Used by DiskMirror for O(1)
	 * reverse lookups instead of scanning idToText.
	 */
	private _textToFileId = new WeakMap<Y.Text, string>();

	private _localReady = false;
	private _providerSynced = false;

	/**
	 * Increments each time the provider connects. Used to distinguish
	 * first connect (gen 0) from reconnects (gen > 0).
	 */
	private _connectionGeneration = 0;

	/**
	 * True if the server sent an explicit auth error message.
	 * When set, the plugin should stop reconnecting.
	 */
	private _fatalAuthError = false;
	private _fatalAuthCode: "unauthorized" | "server_misconfigured" | "unclaimed" | null = null;

	/** True if IndexedDB encountered an error (unavailable, quota, etc). */
	private _idbError = false;

	/** Buffered renames for batch flush. */
	private _renameBatch: Map<string, string> = new Map(); // oldPath -> newPath
	private _renameBatchNewToOld: Map<string, string> = new Map(); // newPath -> oldPath
	private _renameTimer: ReturnType<typeof setTimeout> | null = null;
	/** Callback invoked after a rename batch is flushed. */
	private _onRenameBatchFlushed: ((renames: Map<string, string>) => void) | null = null;

	private readonly _device: string | undefined;
	private readonly debug: boolean;
	private _eventRing: Array<{ ts: string; msg: string }> = [];
	private readonly trace?: TraceRecord;

	constructor(
		settings: VaultSyncSettings,
		options?: {
			traceContext?: TraceHttpContext;
			trace?: TraceRecord;
		},
	) {
		this.debug = settings.debug;
		this._device = settings.deviceName || undefined;
		this.trace = options?.trace;

		this.ydoc = new Y.Doc();
		this.pathToId = this.ydoc.getMap<string>("pathToId");
		this.idToText = this.ydoc.getMap<Y.Text>("idToText");
		this.meta = this.ydoc.getMap<FileMeta>("meta");
		this.sys = this.ydoc.getMap("sys");

		this.pathToBlob = this.ydoc.getMap<BlobRef>("pathToBlob");
		this.blobMeta = this.ydoc.getMap<BlobMeta>("blobMeta");
		this.blobTombstones = this.ydoc.getMap<BlobTombstone>("blobTombstones");

		const roomId = settings.vaultId;
		const idbName = `yaos:${settings.vaultId}`;

		this.log(`Connecting to ${settings.host} room=${roomId}`);
		this.log(`IndexedDB database: ${idbName}`);

		// Start both persistence and provider in parallel.
		this.persistence = new IndexeddbPersistence(idbName, this.ydoc);

		// Catch IndexedDB open/write failures (unavailable, quota, permissions).
		// y-indexeddb's internal _db promise rejects if IDB can't open.
		// We also listen for unhandled IDB transaction errors.
		(this.persistence as unknown as { _db: Promise<IDBDatabase> })._db
			.catch((err: unknown) => {
				this._idbError = true;
				console.error("[yaos] IndexedDB failed to open:", err);
			});

		const params: Record<string, string> = { token: settings.token };
		if (options?.traceContext) {
			params.device = options.traceContext.deviceName;
			params.trace = options.traceContext.traceId;
			params.boot = options.traceContext.bootId;
		}
		const syncPrefix = `/vault/sync/${encodeURIComponent(roomId)}`;

		this.provider = new YSyncProvider(settings.host, roomId, this.ydoc, {
			prefix: syncPrefix,
			params,
			connect: true,
			maxBackoffTime: MAX_BACKOFF_TIME_MS,
		});

		// Track connection generations for reconnect detection
		this.provider.on("status", (event: { status: string }) => {
			this.log(
				`Provider status=${event.status} ` +
				`(wsconnected=${this.provider.wsconnected}, synced=${this.provider.synced})`,
			);
			if (event.status === "connected") {
				this._connectionGeneration++;
				this.log(`Connection generation: ${this._connectionGeneration}`);
			}
		});

		// Listen for auth error messages from the server.
		// The server sends { type: "error", code: "unauthorized" } as a
		// text message BEFORE closing the socket, because close codes/reasons
		// aren't always reliably delivered through transport layers.
		this.provider.on("message", (event: MessageEvent) => {
			if (typeof event.data !== "string") return;
			try {
				const msg = JSON.parse(event.data);
				if (
					msg.type === "error"
					&& (msg.code === "unauthorized" || msg.code === "server_misconfigured" || msg.code === "unclaimed")
				) {
					this._fatalAuthError = true;
					this._fatalAuthCode = msg.code;
					this.log(`Fatal auth error: ${msg.code} — stopping reconnection`);
					this.provider.disconnect();
				}
			} catch {
				// Not JSON — likely a Yjs sync message, ignore
			}
		});
	}

	// -------------------------------------------------------------------
	// Startup gates
	// -------------------------------------------------------------------

	waitForLocalPersistence(): Promise<boolean> {
		if (this._localReady) return Promise.resolve(true);
		if (this._idbError) return Promise.resolve(false);

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				this.log("IndexedDB persistence timed out — proceeding without cache");
				resolve(false);
			}, LOCAL_PERSISTENCE_TIMEOUT_MS);

			// Resolve on successful sync
			this.persistence.once("synced", () => {
				clearTimeout(timeout);
				this._localReady = true;
				this.log(
					`IndexedDB loaded (pathToId: ${this.pathToId.size}, ` +
					`initialized: ${this.isInitialized})`,
				);
				resolve(true);
			});

			// Also resolve (false) if IDB errors out after we started waiting
			(this.persistence as unknown as { _db: Promise<IDBDatabase> })._db
				.catch(() => {
					clearTimeout(timeout);
					this._idbError = true;
					this.log("IndexedDB errored during wait — proceeding without cache");
					resolve(false);
				});
		});
	}

	waitForProviderSync(): Promise<boolean> {
		if (this._providerSynced) return Promise.resolve(true);
		if (this._fatalAuthError) return Promise.resolve(false);

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				this.log("Provider sync timed out — entering offline mode");
				resolve(false);
			}, PROVIDER_SYNC_TIMEOUT_MS);

			const check = (synced: boolean) => {
				this.log(`Provider sync event: synced=${synced} (gen=${this._connectionGeneration})`);
				if (!synced) return;
				clearTimeout(timeout);
				this._providerSynced = true;
				this.provider.off("sync", check);
				this.log("Provider synced — room state received");
				resolve(true);
			};
			this.provider.on("sync", check);
		});
	}

	/**
	 * Register a callback for when the provider syncs AFTER the initial
	 * startup sequence. Fires on both late first-sync and reconnections.
	 * The callback receives the connection generation number.
	 */
	onProviderSync(callback: (generation: number) => void): void {
		this.provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			this._providerSynced = true;
			this.log(`onProviderSync callback firing (gen=${this._connectionGeneration})`);
			callback(this._connectionGeneration);
		});
	}

	// -------------------------------------------------------------------
	// Sentinel
	// -------------------------------------------------------------------

	get isInitialized(): boolean {
		return this.sys.get("initialized") === true;
	}

	markInitialized(): void {
		const alreadyInitialized = this.isInitialized;
		this.sys.set("initialized", true);
		this.sys.set("schemaVersion", SCHEMA_VERSION);
		if (!alreadyInitialized) {
			this.sys.set("lastSync", Date.now());
			this.log("Marked Y.Doc as initialized (sentinel set)");
		}
	}

	/**
	 * Check if the persisted schema version is compatible with this code.
	 * Returns null if OK, or an error string if incompatible.
	 *
	 * Rules:
	 *   - No version stored (first run or pre-versioning): OK, we'll set it
	 *   - Version <= SCHEMA_VERSION: OK (same or older, we can read it)
	 *   - Version > SCHEMA_VERSION: INCOMPATIBLE (newer plugin wrote this)
	 */
	checkSchemaVersion(): string | null {
		const stored = this.sys.get("schemaVersion");
		if (stored === undefined || stored === null) return null; // first run
		if (typeof stored !== "number") return null; // corrupt, treat as first run
		if (stored > SCHEMA_VERSION) {
			return (
				`CRDT schema version ${stored} is newer than this plugin supports (v${SCHEMA_VERSION}). ` +
				`Update the plugin or risk data corruption.`
			);
		}
		return null; // same or older version, OK
	}

	// -------------------------------------------------------------------
	// Path normalization
	// -------------------------------------------------------------------

	/** Normalize a vault-relative path for consistent CRDT keys. */
	private normPath(path: string): string {
		return normalizePath(path);
	}

	// -------------------------------------------------------------------
	// Integrity checks
	// -------------------------------------------------------------------

	/**
	 * Run integrity checks on the CRDT maps. Call after reconciliation.
	 *
	 * Checks:
	 *   1. Two paths pointing to the same fileId → keep first, remap second
	 *   2. idToText/meta entries with no pathToId reference → orphan garbage
	 *
	 * Returns counts for logging.
	 */
	runIntegrityChecks(): { duplicateIds: number; orphansCleaned: number } {
		let duplicateIds = 0;
		let orphansCleaned = 0;

		// 1. Check for duplicate fileIds (two paths → one id)
		const idToPaths = new Map<string, string[]>();
		this.pathToId.forEach((fileId, path) => {
			const paths = idToPaths.get(fileId);
			if (paths) {
				paths.push(path);
			} else {
				idToPaths.set(fileId, [path]);
			}
		});

		for (const [fileId, paths] of idToPaths) {
			if (paths.length <= 1) continue;

			duplicateIds++;
			this.log(
				`integrity: fileId ${fileId} shared by ${paths.length} paths: ${paths.join(", ")}`,
			);

			// Keep the first path, give the others new IDs.
			// We can't easily re-seed content here (no disk access), so we
			// clone the Y.Text for the duplicate paths.
			const keepPath = paths[0]!;
			const sourceText = this.idToText.get(fileId);

			for (let i = 1; i < paths.length; i++) {
				const dupPath = paths[i]!;
				const newId = this.generateFileId();
				const newText = new Y.Text();

				this.ydoc.transact(() => {
					if (sourceText) {
						newText.insert(0, sourceText.toString());
					}
					this.pathToId.set(dupPath, newId);
					this.idToText.set(newId, newText);
					this.meta.set(newId, {
						path: dupPath,
						mtime: Date.now(),
						device: this._device,
					});
				}, ORIGIN_SEED);

				this.log(
					`integrity: gave "${dupPath}" new id=${newId} (was sharing ${fileId} with "${keepPath}")`,
				);
			}
		}

		// 2. Orphan GC: find idToText/meta entries with no pathToId reference
		const referencedIds = new Set<string>();
		this.pathToId.forEach((fileId) => {
			referencedIds.add(fileId);
		});

		// Also keep tombstoned IDs (they're intentionally orphaned from pathToId)
		const tombstonedIds = new Set<string>();
		this.meta.forEach((meta, fileId) => {
			if (meta.deleted) {
				tombstonedIds.add(fileId);
			}
		});

		// Clean orphans from idToText
		const orphanTextIds: string[] = [];
		this.idToText.forEach((_text, fileId) => {
			if (!referencedIds.has(fileId) && !tombstonedIds.has(fileId)) {
				orphanTextIds.push(fileId);
			}
		});

		// Clean orphans from meta (non-tombstoned only)
		const orphanMetaIds: string[] = [];
		this.meta.forEach((meta, fileId) => {
			if (!referencedIds.has(fileId) && !tombstonedIds.has(fileId)) {
				orphanMetaIds.push(fileId);
			}
		});

		const allOrphanIds = new Set([...orphanTextIds, ...orphanMetaIds]);
		if (allOrphanIds.size > 0) {
			this.ydoc.transact(() => {
				for (const fileId of allOrphanIds) {
					this.idToText.delete(fileId);
					this.meta.delete(fileId);
				}
			}, ORIGIN_SEED);

			orphansCleaned = allOrphanIds.size;
			this.log(
				`integrity: cleaned ${orphansCleaned} orphaned entries ` +
				`(${orphanTextIds.length} from idToText, ${orphanMetaIds.length} from meta)`,
			);
		}

		return { duplicateIds, orphansCleaned };
	}

	// -------------------------------------------------------------------
	// Reconciliation
	// -------------------------------------------------------------------

	/**
	 * Determine which reconciliation mode is safe given current state.
	 *
	 * Authoritative when:
	 *   - Provider synced (we have the full server state), OR
	 *   - Local cache loaded AND sentinel says initialized AND
	 *     pathToId is non-empty (protects against partial IndexedDB persistence)
	 *
	 * Conservative otherwise.
	 */
	getSafeReconcileMode(): ReconcileMode {
		if (this._providerSynced) return "authoritative";
		// Use schemaVersion presence (set atomically with initialized) as
		// proof that IDB loaded real data. Unlike pathToId.size > 0 this
		// correctly handles legitimately-empty-but-initialized vaults.
		if (this._localReady && this.isInitialized && this.sys.get("schemaVersion") !== undefined) {
			return "authoritative";
		}
		return "conservative";
	}

	reconcileVault(
		diskFiles: Map<string, string>,
		diskPresentPaths: Set<string>,
		mode: ReconcileMode,
		device?: string,
	): ReconcileResult {
		const createdOnDisk: string[] = [];
		const updatedOnDisk: string[] = [];
		const seededToCrdt: string[] = [];
		const untracked: string[] = [];
		let skipped = 0;

		const crdtPaths = new Set<string>();
		const tombstonedIds = new Set<string>();

		this.meta.forEach((meta, fileId) => {
			if (meta.deleted) {
				tombstonedIds.add(fileId);
			}
		});

		this.pathToId.forEach((fileId, path) => {
			if (!tombstonedIds.has(fileId)) {
				crdtPaths.add(path);
			}
		});

		// CRDT files not on disk → create on disk
		// IMPORTANT: use diskPresentPaths (all known disk paths), not
		// diskFiles (only the subset whose content was read this run).
		for (const path of crdtPaths) {
			if (!diskPresentPaths.has(path)) {
				createdOnDisk.push(path);
			}
		}

		// Files present in both disk and CRDT whose content differs.
		// In authoritative mode, CRDT is source of truth and should be
		// flushed to disk so reopened clients converge reliably.
		if (mode === "authoritative") {
			for (const [path, diskContent] of diskFiles) {
				if (!crdtPaths.has(path)) continue;
				const ytext = this.getTextForPath(path);
				if (!ytext) continue;
				const crdtContent = ytext.toString();
				if (crdtContent !== diskContent) {
					updatedOnDisk.push(path);
				}
			}
		}

		// Disk files not in CRDT
		for (const path of diskPresentPaths) {
			if (crdtPaths.has(path)) continue;

			let wasTombstoned = false;
			this.meta.forEach((meta) => {
				if (meta.path === path && meta.deleted) {
					wasTombstoned = true;
				}
			});

			if (wasTombstoned) {
				this.log(`reconcile: "${path}" was tombstoned, skipping`);
				skipped++;
				continue;
			}

			if (mode === "authoritative") {
				const content = diskFiles.get(path);
				if (content === undefined) {
					// Presence is known, but content wasn't read this pass. Skip seeding
					// to avoid accidentally creating empty/incorrect files.
					this.log(`reconcile: "${path}" present on disk but content not loaded, skipping seed`);
					continue;
				}
				this.ensureFile(path, content, device);
				seededToCrdt.push(path);
			} else {
				untracked.push(path);
			}
		}

		if (mode === "authoritative") {
			this.markInitialized();
		}

		this.log(
			`reconcile [${mode}]: ` +
			`${seededToCrdt.length} seeded, ` +
			`${createdOnDisk.length} need disk creation, ` +
			`${updatedOnDisk.length} need disk update, ` +
			`${untracked.length} untracked, ` +
			`${skipped} tombstoned`,
		);

		return { mode, createdOnDisk, updatedOnDisk, seededToCrdt, untracked, skipped };
	}

	// -------------------------------------------------------------------
	// File operations
	// -------------------------------------------------------------------

	private generateFileId(): string {
		return randomBase64Url(12);
	}

	ensureFile(path: string, currentContent: string, device?: string): Y.Text | null {
		path = this.normPath(path);

		const existingId = this.pathToId.get(path);
		if (!existingId) {
			this.promotePendingRenameTarget(path, device);
		}
		const resolvedId = this.pathToId.get(path);
		if (resolvedId) {
			const existingText = this.idToText.get(resolvedId);
			if (existingText) {
				const cleared = this.clearMarkdownTombstonesForPath(path, resolvedId);
				if (cleared > 0) {
					this.log(`ensureFile: cleared ${cleared} stale tombstone(s) for "${path}"`);
				}
				this.log(`ensureFile: "${path}" already exists (id=${resolvedId})`);
				this._textToFileId.set(existingText, resolvedId);
				return existingText;
			}
			// Orphaned mapping — clean up old entries before recreating
			this.log(
				`ensureFile: "${path}" has id=${resolvedId} but no Y.Text — cleaning up orphan`,
			);
			this.ydoc.transact(() => {
				this.pathToId.delete(path);
				this.idToText.delete(resolvedId);
				this.meta.delete(resolvedId);
			}, ORIGIN_SEED);
		}

		// Check tombstones — never resurrect a deleted path unless it is already
		// backed by a live pathToId entry handled above.
		const tombstoneIds = this.getMarkdownTombstoneIds(path);
		if (tombstoneIds.length > 0) {
			this.trace?.("sync", "ensureFile-tombstone-blocked", {
				path,
				tombstoneIds,
				device: device ?? null,
			});
			this.log(`ensureFile: "${path}" is tombstoned, refusing to create`);
			return null;
		}

		const fileId = this.generateFileId();
		const ytext = new Y.Text();

		this.ydoc.transact(() => {
			ytext.insert(0, currentContent);
			this.pathToId.set(path, fileId);
			this.idToText.set(fileId, ytext);
			this.meta.set(fileId, {
				path,
				mtime: Date.now(),
				device,
			});
		}, ORIGIN_SEED);

		this.log(`ensureFile: created "${path}" (id=${fileId})`);
		this._textToFileId.set(ytext, fileId);
		return ytext;
	}

	isMarkdownTombstoned(path: string): boolean {
		return this.getMarkdownTombstoneIds(path).length > 0;
	}

	getTextForPath(path: string): Y.Text | null {
		path = this.normPath(path);
		const fileId = this.pathToId.get(path);
		if (!fileId) return null;
		const text = this.idToText.get(fileId) ?? null;
		if (text) this._textToFileId.set(text, fileId);
		return text;
	}

	getFileId(path: string): string | undefined {
		return this.pathToId.get(this.normPath(path));
	}

	/**
	 * O(1) reverse lookup: given a Y.Text, get its fileId.
	 * Returns undefined if the text isn't tracked (shouldn't happen
	 * for texts created via ensureFile/getTextForPath).
	 */
	getFileIdForText(ytext: Y.Text): string | undefined {
		return this._textToFileId.get(ytext);
	}

	// -------------------------------------------------------------------
	// Blob operations
	// -------------------------------------------------------------------

	/**
	 * Record a blob reference for a vault path. Called after a successful
	 * R2 upload. Sets pathToBlob + blobMeta in a single transaction.
	 * Only sets blobMeta if the hash isn't already tracked (dedup).
	 */
	setBlobRef(
		path: string,
		hash: string,
		size: number,
		mime: string,
		device?: string,
	): void {
		path = this.normPath(path);

		this.ydoc.transact(() => {
			this.pathToBlob.set(path, { hash, size });
			// Only set blobMeta if this content hash is new
			if (!this.blobMeta.has(hash)) {
				this.blobMeta.set(hash, {
					size,
					mime,
					createdAt: Date.now(),
					device,
				});
			}
			// Clear any existing tombstone for this path
			if (this.blobTombstones.has(path)) {
				this.blobTombstones.delete(path);
			}
		}, ORIGIN_SEED);

		this.log(`setBlobRef: "${path}" hash=${hash.slice(0, 12)}… (${size} bytes)`);
	}

	/**
	 * Get the blob reference for a vault path, if any.
	 */
	getBlobRef(path: string): BlobRef | undefined {
		return this.pathToBlob.get(this.normPath(path));
	}

	/**
	 * Get blob metadata for a content hash.
	 */
	getBlobMeta(hash: string): BlobMeta | undefined {
		return this.blobMeta.get(hash);
	}

	/**
	 * Tombstone-delete a blob path. Removes from pathToBlob and records
	 * a tombstone to prevent resurrection from stale disk scans.
	 * Does NOT delete the R2 blob (content-addressed = may be shared).
	 */
	deleteBlobRef(path: string, device?: string): void {
		path = this.normPath(path);

		if (!this.pathToBlob.has(path)) {
			this.log(`deleteBlobRef: "${path}" not in CRDT, ignoring`);
			return;
		}

		this.ydoc.transact(() => {
			this.pathToBlob.delete(path);
			this.blobTombstones.set(path, {
				deletedAt: Date.now(),
				device,
			});
		}, ORIGIN_SEED);

		this.log(`deleteBlobRef: "${path}" tombstoned`);
	}

	/**
	 * Check if a path is blob-tombstoned (deleted).
	 */
	isBlobTombstoned(path: string): boolean {
		return this.blobTombstones.has(this.normPath(path));
	}

	/**
	 * Rename a blob path. Moves the entry in pathToBlob.
	 * Called from the rename batch flush for non-markdown files.
	 */
	renameBlobRef(oldPath: string, newPath: string): void {
		oldPath = this.normPath(oldPath);
		newPath = this.normPath(newPath);

		const ref = this.pathToBlob.get(oldPath);
		if (!ref) return;

		this.ydoc.transact(() => {
			this.pathToBlob.delete(oldPath);
			this.pathToBlob.set(newPath, ref);
			// Clear any tombstone at the new path
			if (this.blobTombstones.has(newPath)) {
				this.blobTombstones.delete(newPath);
			}
		}, ORIGIN_SEED);

		this.log(`renameBlobRef: "${oldPath}" -> "${newPath}"`);
	}

	// -------------------------------------------------------------------
	// Rename batching
	// -------------------------------------------------------------------

	/**
	 * Queue a rename for batched application. Multiple renames arriving
	 * within RENAME_BATCH_MS (e.g. folder rename) are collected and
	 * applied in a single ydoc.transact().
	 *
	 * Transitive chains are resolved: if A→B and B→C arrive in the same
	 * batch, they collapse to A→C.
	 */
	queueRename(oldPath: string, newPath: string): void {
		oldPath = this.normPath(oldPath);
		newPath = this.normPath(newPath);

		const rootOldPath = this._renameBatchNewToOld.get(oldPath) ?? oldPath;
		if (rootOldPath === newPath) {
			this.deletePendingRenameByOldPath(rootOldPath);
		} else {
			this.setPendingRename(rootOldPath, newPath);
		}
		if (rootOldPath !== oldPath) {
			this.deletePendingRenameByOldPath(oldPath);
		}

		// Reset the debounce timer
		if (this._renameTimer) clearTimeout(this._renameTimer);
		this._renameTimer = setTimeout(() => this.flushRenameBatch(), RENAME_BATCH_MS);
	}

	isPendingRenameTarget(path: string): boolean {
		path = this.normPath(path);
		return this._renameBatchNewToOld.has(path);
	}

	/**
	 * Register a callback invoked after each rename batch flush.
	 * Receives the map of old→new paths that were applied.
	 */
	onRenameBatchFlushed(callback: (renames: Map<string, string>) => void): void {
		this._onRenameBatchFlushed = callback;
	}

	private flushRenameBatch(): void {
		this._renameTimer = null;
		if (this._renameBatch.size === 0) return;

		const batch = new Map(this._renameBatch);
		this.clearPendingRenames();

		this.log(`Flushing rename batch: ${batch.size} renames`);
		this.applyRenameBatch(batch, this._device);
	}

	/** Direct single rename (kept for programmatic use). */
	handleRename(oldPath: string, newPath: string, device?: string): void {
		oldPath = this.normPath(oldPath);
		newPath = this.normPath(newPath);

		const fileId = this.pathToId.get(oldPath);
		if (!fileId) {
			this.log(`handleRename: "${oldPath}" not in CRDT, ignoring`);
			return;
		}

		this.ydoc.transact(() => {
			this.pathToId.delete(oldPath);
			this.pathToId.set(newPath, fileId);
			this.clearMarkdownTombstonesForPath(newPath, fileId);
			this.meta.set(fileId, {
				path: newPath,
				mtime: Date.now(),
				device,
			});
		}, ORIGIN_SEED);

		this.log(`handleRename: "${oldPath}" -> "${newPath}" (id=${fileId})`);
	}

	private promotePendingRenameTarget(path: string, device?: string): void {
		const normalizedPath = this.normPath(path);
		const pendingOldPath = this._renameBatchNewToOld.get(normalizedPath);
		if (!pendingOldPath) return;

		this.deletePendingRenameByOldPath(pendingOldPath);
		if (this._renameBatch.size === 0 && this._renameTimer) {
			clearTimeout(this._renameTimer);
			this._renameTimer = null;
		}

		const batch = new Map([[pendingOldPath, normalizedPath]]);
		this.log(`Promoting pending rename target: "${pendingOldPath}" -> "${normalizedPath}"`);
		this.applyRenameBatch(batch, device ?? this._device);
	}

	private applyRenameBatch(batch: Map<string, string>, device?: string): void {
		if (batch.size === 0) return;

		this.ydoc.transact(() => {
			for (const [oldPath, newPath] of batch) {
				const fileId = this.pathToId.get(oldPath);
				if (fileId) {
					this.pathToId.delete(oldPath);
					this.pathToId.set(newPath, fileId);
					this.clearMarkdownTombstonesForPath(newPath, fileId);
					this.meta.set(fileId, {
						path: newPath,
						mtime: Date.now(),
						device,
					});
					this.log(`renameBatch: "${oldPath}" -> "${newPath}" (id=${fileId})`);
				}

				const blobRef = this.pathToBlob.get(oldPath);
				if (blobRef) {
					this.pathToBlob.delete(oldPath);
					this.pathToBlob.set(newPath, blobRef);
					if (this.blobTombstones.has(newPath)) {
						this.blobTombstones.delete(newPath);
					}
					this.log(`renameBatch: blob "${oldPath}" -> "${newPath}"`);
				}
			}
		}, ORIGIN_SEED);

		this._onRenameBatchFlushed?.(batch);
	}

	private clearMarkdownTombstonesForPath(path: string, keepFileId?: string): number {
		const tombstonedIds: string[] = [];
		this.meta.forEach((meta, fileId) => {
			if (
				fileId !== keepFileId
				&& meta.path === path
				&& meta.deleted
			) {
				tombstonedIds.push(fileId);
			}
		});

		for (const tombstonedId of tombstonedIds) {
			this.meta.delete(tombstonedId);
		}

		return tombstonedIds.length;
	}

	private getMarkdownTombstoneIds(path: string): string[] {
		const normalizedPath = this.normPath(path);
		const tombstonedIds: string[] = [];
		this.meta.forEach((meta, fileId) => {
			if (meta.path === normalizedPath && meta.deleted) {
				tombstonedIds.push(fileId);
			}
		});
		return tombstonedIds;
	}

	handleDelete(path: string, device?: string): void {
		path = this.normPath(path);

		// Check pending rename batch for races:
		// 1. If a pending rename maps X → path (our delete target is the
		//    NEW name), cancel the rename and delete from the old path.
		// 2. If a pending rename maps path → Y (our delete target is the
		//    OLD name, rename hasn't flushed), cancel the rename and
		//    delete from path (it's still in pathToId).
		let resolvedPath = path;
		const pendingOldPath = this._renameBatchNewToOld.get(path);
		if (pendingOldPath) {
			const pendingNewPath = this._renameBatch.get(pendingOldPath) ?? path;
			this.trace?.("sync", "delete-cancelled-pending-rename", {
				requestedPath: path,
				pendingOldPath,
				pendingNewPath,
				case: "rename-target",
			});
			this.log(`handleDelete: "${path}" is a pending rename target from "${pendingOldPath}" — cancelling rename`);
			this.deletePendingRenameByOldPath(pendingOldPath);
			resolvedPath = pendingOldPath;
		} else if (this._renameBatch.has(path)) {
			const pendingNewPath = this._renameBatch.get(path)!;
			this.trace?.("sync", "delete-cancelled-pending-rename", {
				requestedPath: path,
				pendingOldPath: path,
				pendingNewPath,
				case: "rename-source",
			});
			this.log(`handleDelete: "${path}" has pending rename to "${pendingNewPath}" — cancelling rename`);
			this.deletePendingRenameByOldPath(path);
			resolvedPath = path;
		}

		const fileId = this.pathToId.get(resolvedPath);
		if (!fileId) {
			// Not a markdown file — might be a blob
			if (this.pathToBlob.has(resolvedPath)) {
				this.deleteBlobRef(resolvedPath, device);
			} else {
				this.log(`handleDelete: "${resolvedPath}" not in CRDT, ignoring`);
			}
			return;
		}

		this.ydoc.transact(() => {
			this.pathToId.delete(resolvedPath);
			this.meta.set(fileId, {
				path: resolvedPath,
				deleted: true,
				mtime: Date.now(),
				device,
			});
		}, ORIGIN_SEED);

		this.trace?.("sync", "markdown-tombstoned", {
			requestedPath: path,
			resolvedPath,
			fileId,
			device: device ?? null,
		});

		this.log(`handleDelete: "${resolvedPath}" marked deleted (id=${fileId})`);
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	get localReady(): boolean {
		return this._localReady;
	}

	get providerSynced(): boolean {
		return this._providerSynced;
	}

	get connected(): boolean {
		return this.provider.wsconnected;
	}

	get connectionGeneration(): number {
		return this._connectionGeneration;
	}

	get fatalAuthError(): boolean {
		return this._fatalAuthError;
	}

	get fatalAuthCode(): "unauthorized" | "server_misconfigured" | "unclaimed" | null {
		return this._fatalAuthCode;
	}

	get idbError(): boolean {
		return this._idbError;
	}

	/** The IndexedDB database name for this vault. */
	get idbName(): string {
		return `yaos:${this.sys.get("vaultId") ?? "unknown"}`;
	}

	/**
	 * Wipe all CRDT maps (pathToId, idToText, meta, sys) in a single
	 * transaction. Collects keys first to avoid mutating during iteration.
	 * This propagates to the server via the provider (intentional for nuclear reset).
	 */
	clearAllMaps(): { pathCount: number; idCount: number; metaCount: number; blobCount: number } {
		const pathKeys = Array.from(this.pathToId.keys());
		const idKeys = Array.from(this.idToText.keys());
		const metaKeys = Array.from(this.meta.keys());
		const sysKeys = Array.from(this.sys.keys());
		const blobPathKeys = Array.from(this.pathToBlob.keys());
		const blobMetaKeys = Array.from(this.blobMeta.keys());
		const blobTombKeys = Array.from(this.blobTombstones.keys());

		this.ydoc.transact(() => {
			for (const k of pathKeys) this.pathToId.delete(k);
			for (const k of idKeys) this.idToText.delete(k);
			for (const k of metaKeys) this.meta.delete(k);
			for (const k of sysKeys) this.sys.delete(k);
			for (const k of blobPathKeys) this.pathToBlob.delete(k);
			for (const k of blobMetaKeys) this.blobMeta.delete(k);
			for (const k of blobTombKeys) this.blobTombstones.delete(k);
		}, ORIGIN_SEED);

		this.log(
			`clearAllMaps: removed ${pathKeys.length} paths, ` +
			`${idKeys.length} texts, ${metaKeys.length} meta entries, ` +
			`${blobPathKeys.length} blob paths`,
		);

		return {
			pathCount: pathKeys.length,
			idCount: idKeys.length,
			metaCount: metaKeys.length,
			blobCount: blobPathKeys.length,
		};
	}

	/**
	 * Delete the IndexedDB database for this vault.
	 * Safe to call after destroy() — uses the raw IDB deleteDatabase API.
	 */
	static deleteIdb(vaultId: string): Promise<void> {
		const name = `yaos:${vaultId}`;
		return new Promise((resolve, reject) => {
			const req = indexedDB.deleteDatabase(name);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
			req.onblocked = () => {
				console.warn(`[yaos] IDB delete blocked for "${name}"`);
				// Resolve anyway — it'll be deleted when connections close
				resolve();
			};
		});
	}

	destroy(): void {
		this.log("Destroying VaultSync");
		if (this._renameTimer) clearTimeout(this._renameTimer);
		this.clearPendingRenames();
		this.provider.destroy();
		this.persistence.destroy();
		this.ydoc.destroy();
	}

	private setPendingRename(oldPath: string, newPath: string): void {
		if (oldPath === newPath) {
			this.deletePendingRenameByOldPath(oldPath);
			return;
		}

		const existingOldForTarget = this._renameBatchNewToOld.get(newPath);
		if (existingOldForTarget && existingOldForTarget !== oldPath) {
			this.deletePendingRenameByOldPath(existingOldForTarget);
		}

		const previousTarget = this._renameBatch.get(oldPath);
		if (previousTarget) {
			this._renameBatchNewToOld.delete(previousTarget);
		}

		this._renameBatch.set(oldPath, newPath);
		this._renameBatchNewToOld.set(newPath, oldPath);
	}

	private deletePendingRenameByOldPath(oldPath: string): void {
		const existingTarget = this._renameBatch.get(oldPath);
		if (!existingTarget) return;
		this._renameBatch.delete(oldPath);
		this._renameBatchNewToOld.delete(existingTarget);
	}

	private clearPendingRenames(): void {
		this._renameBatch.clear();
		this._renameBatchNewToOld.clear();
	}

	getRecentEvents(limit = 120): Array<{ ts: string; msg: string }> {
		if (limit <= 0) return [];
		return this._eventRing.slice(-limit);
	}

	getDebugSnapshot(): {
		connected: boolean;
		providerSynced: boolean;
		localReady: boolean;
		connectionGeneration: number;
		fatalAuthError: boolean;
		idbError: boolean;
		pathToIdCount: number;
		blobPathCount: number;
	} {
		return {
			connected: this.connected,
			providerSynced: this.providerSynced,
			localReady: this.localReady,
			connectionGeneration: this.connectionGeneration,
			fatalAuthError: this.fatalAuthError,
			idbError: this.idbError,
			pathToIdCount: this.pathToId.size,
			blobPathCount: this.pathToBlob.size,
		};
	}

	private log(msg: string): void {
		this._eventRing.push({ ts: new Date().toISOString(), msg });
		if (this._eventRing.length > 600) {
			this._eventRing.splice(0, this._eventRing.length - 600);
		}
		this.trace?.("sync", msg);
		if (this.debug) {
			console.log(`[yaos] ${msg}`);
		}
	}
}

export interface ReconcileResult {
	mode: ReconcileMode;
	createdOnDisk: string[];
	updatedOnDisk: string[];
	seededToCrdt: string[];
	untracked: string[];
	skipped: number;
}
