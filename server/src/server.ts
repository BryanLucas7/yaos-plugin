import type * as Party from "partykit/server";
import { onConnect, unstable_getYDoc } from "y-partykit";
import { getR2Config, presignPut, presignGet, checkExists } from "./presign";
import {
	createSnapshot,
	listSnapshots,
	presignSnapshotGet,
	type SnapshotResult,
} from "./snapshot";

/** DO storage key for daily snapshot coordination. */
const LAST_SNAPSHOT_DAY_KEY = "lastSnapshotDay";
const LAST_SNAPSHOT_ID_KEY = "lastSnapshotId";

/**
 * PartyKit server for vault CRDT sync.
 *
 * - One room per vault: roomId = "v1:<vaultId>"
 * - Auth: ?token= query param compared to env SYNC_TOKEN
 * - Persistence: y-partykit snapshot mode (survives room hibernation)
 * - Hibernation: enabled for cost/scalability
 * - Blob endpoints: presign PUT/GET/exists for R2 attachment storage
 * - Snapshot endpoints: daily/on-demand CRDT snapshots to R2
 *
 * Auth failure:
 *   Sends a structured error message BEFORE closing with 1008,
 *   so the client can reliably detect auth failures even if the
 *   close code/reason gets swallowed by the transport layer.
 */
export default class VaultSyncServer implements Party.Server {
	static options: Party.ServerOptions = {
		hibernate: true,
	};

	constructor(readonly room: Party.Room) {}

	// -------------------------------------------------------------------
	// WebSocket handler (Yjs sync)
	// -------------------------------------------------------------------

	onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
		const url = new URL(ctx.request.url);
		const token = url.searchParams.get("token");
		const expected = this.room.env.SYNC_TOKEN as string | undefined;

		if (!expected) {
			console.error(
				`[vault-sync] SYNC_TOKEN env var is not set — rejecting connection to room ${this.room.id}`,
			);
			conn.send(JSON.stringify({ type: "error", code: "server_misconfigured" }));
			conn.close(1008, "server misconfigured");
			return;
		}

		if (!token || token !== expected) {
			console.warn(
				`[vault-sync] Unauthorized connection attempt to room ${this.room.id}`,
			);
			conn.send(JSON.stringify({ type: "error", code: "unauthorized" }));
			conn.close(1008, "unauthorized");
			return;
		}

		console.log(
			`[vault-sync] Client connected to room ${this.room.id}`,
		);

		// Delegate to y-partykit for Yjs sync + snapshot persistence
		return onConnect(conn, this.room, {
			persist: { mode: "snapshot" },
		});
	}

	// -------------------------------------------------------------------
	// HTTP handler (blob presign + snapshot endpoints)
	// -------------------------------------------------------------------

	async onRequest(req: Party.Request): Promise<Response> {
		// Auth: same token-based auth as WebSocket
		const url = new URL(req.url);
		const token = url.searchParams.get("token");
		const expected = this.room.env.SYNC_TOKEN as string | undefined;

		if (!expected || !token || token !== expected) {
			return json({ error: "unauthorized" }, 401);
		}

		// Extract vaultId from room ID (format: "v1:<vaultId>")
		// The room ID may be URL-encoded when received via HTTP (v1%3A...).
		const rawRoomId = decodeURIComponent(this.room.id);
		const vaultId = rawRoomId.replace(/^v1:/, "");
		if (!vaultId || vaultId === rawRoomId) {
			return json({ error: "invalid room id" }, 400);
		}

		// Route based on path suffix
		const path = url.pathname;

		// --- Blob endpoints ---
		const r2 = getR2Config(this.room.env as Record<string, unknown>);

		if (req.method === "POST" && path.endsWith("/blob/presign-put")) {
			if (!r2) return r2NotConfigured();
			return this.handlePresignPut(req, r2, vaultId);
		}
		if (req.method === "POST" && path.endsWith("/blob/presign-get")) {
			if (!r2) return r2NotConfigured();
			return this.handlePresignGet(req, r2, vaultId);
		}
		if (req.method === "POST" && path.endsWith("/blob/exists")) {
			if (!r2) return r2NotConfigured();
			return this.handleExists(req, r2, vaultId);
		}

		// --- Snapshot endpoints ---
		if (req.method === "POST" && path.endsWith("/snapshot/maybe")) {
			if (!r2) return json({ status: "unavailable", reason: "R2 not configured" } satisfies SnapshotResult);
			return this.handleSnapshotMaybe(req, r2, vaultId);
		}
		if (req.method === "POST" && path.endsWith("/snapshot/now")) {
			if (!r2) return json({ status: "unavailable", reason: "R2 not configured" } satisfies SnapshotResult);
			return this.handleSnapshotNow(req, r2, vaultId);
		}
		if (req.method === "GET" && path.endsWith("/snapshot/list")) {
			if (!r2) return json({ status: "unavailable", reason: "R2 not configured" });
			return this.handleSnapshotList(r2, vaultId);
		}
		if (req.method === "POST" && path.endsWith("/snapshot/presign-get")) {
			if (!r2) return json({ error: "R2 not configured" }, 503);
			return this.handleSnapshotPresignGet(req, r2, vaultId);
		}

		return json({ error: "not found" }, 404);
	}

	// -------------------------------------------------------------------
	// Blob endpoint handlers
	// -------------------------------------------------------------------

	/**
	 * POST /blob/presign-put
	 * Body: { hash: string, contentType: string, contentLength: number }
	 * Server derives key from (vaultId, hash) — client can't write arbitrary keys.
	 */
	private async handlePresignPut(
		req: Party.Request,
		r2: ReturnType<typeof getR2Config> & object,
		vaultId: string,
	): Promise<Response> {
		let body: { hash?: string; contentType?: string; contentLength?: number };
		try {
			body = await req.json() as typeof body;
		} catch {
			return json({ error: "invalid json" }, 400);
		}

		const { hash, contentType, contentLength } = body;

		if (!hash || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
			return json({ error: "invalid hash: must be 64 hex chars (SHA-256)" }, 400);
		}
		if (!contentType || typeof contentType !== "string") {
			return json({ error: "missing contentType" }, 400);
		}
		if (!contentLength || typeof contentLength !== "number" || contentLength <= 0) {
			return json({ error: "invalid contentLength" }, 400);
		}

		try {
			const result = await presignPut(r2, vaultId, hash, contentType, contentLength);
			return json(result);
		} catch (err) {
			console.error("[vault-sync] presignPut error:", err);
			return json({ error: "presign failed" }, 500);
		}
	}

	/**
	 * POST /blob/presign-get
	 * Body: { hash: string }
	 */
	private async handlePresignGet(
		req: Party.Request,
		r2: ReturnType<typeof getR2Config> & object,
		vaultId: string,
	): Promise<Response> {
		let body: { hash?: string };
		try {
			body = await req.json() as typeof body;
		} catch {
			return json({ error: "invalid json" }, 400);
		}

		const { hash } = body;

		if (!hash || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
			return json({ error: "invalid hash: must be 64 hex chars (SHA-256)" }, 400);
		}

		try {
			const result = await presignGet(r2, vaultId, hash);
			return json(result);
		} catch (err) {
			console.error("[vault-sync] presignGet error:", err);
			return json({ error: "presign failed" }, 500);
		}
	}

	/**
	 * POST /blob/exists
	 * Body: { hashes: string[] }
	 * Returns: { present: string[] }
	 */
	private async handleExists(
		req: Party.Request,
		r2: ReturnType<typeof getR2Config> & object,
		vaultId: string,
	): Promise<Response> {
		let body: { hashes?: string[] };
		try {
			body = await req.json() as typeof body;
		} catch {
			return json({ error: "invalid json" }, 400);
		}

		const { hashes } = body;

		if (!hashes || !Array.isArray(hashes)) {
			return json({ error: "missing hashes array" }, 400);
		}

		// Cap batch size to prevent abuse
		const MAX_BATCH = 50;
		const toCheck = hashes.slice(0, MAX_BATCH).filter(
			(h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h),
		);

		try {
			const present = await checkExists(r2, vaultId, toCheck);
			return json({ present });
		} catch (err) {
			console.error("[vault-sync] exists check error:", err);
			return json({ error: "exists check failed" }, 500);
		}
	}

	// -------------------------------------------------------------------
	// Snapshot endpoint handlers
	// -------------------------------------------------------------------

	/**
	 * POST /snapshot/maybe
	 * Body: { device?: string }
	 *
	 * Creates a snapshot if one hasn't been taken today. Otherwise returns noop.
	 * Uses DO room.storage to coordinate across devices.
	 */
	private async handleSnapshotMaybe(
		req: Party.Request,
		r2: ReturnType<typeof getR2Config> & object,
		vaultId: string,
	): Promise<Response> {
		let body: { device?: string } = {};
		try {
			body = await req.json() as typeof body;
		} catch { /* empty body is fine */ }

		const currentDay = new Date().toISOString().slice(0, 10);
		const lastDay = await this.room.storage.get<string>(LAST_SNAPSHOT_DAY_KEY);

		if (lastDay === currentDay) {
			const lastId = await this.room.storage.get<string>(LAST_SNAPSHOT_ID_KEY);
			return json({
				status: "noop",
				snapshotId: lastId,
				reason: `Snapshot already taken today (${currentDay})`,
			} satisfies SnapshotResult);
		}

		try {
			const ydoc = await unstable_getYDoc(this.room, {
				persist: { mode: "snapshot" },
			});

			const index = await createSnapshot(ydoc, vaultId, r2, body.device);

			// Record that we snapshotted today
			await this.room.storage.put(LAST_SNAPSHOT_DAY_KEY, currentDay);
			await this.room.storage.put(LAST_SNAPSHOT_ID_KEY, index.snapshotId);

			console.log(
				`[vault-sync] Snapshot created: ${index.snapshotId} ` +
				`(${index.markdownFileCount} md, ${index.blobFileCount} blobs, ` +
				`${Math.round(index.crdtSizeBytes / 1024)} KB compressed)`,
			);

			return json({
				status: "created",
				snapshotId: index.snapshotId,
				index,
			} satisfies SnapshotResult);
		} catch (err) {
			console.error("[vault-sync] snapshot/maybe error:", err);
			return json({ error: "snapshot failed", detail: String(err) }, 500);
		}
	}

	/**
	 * POST /snapshot/now
	 * Body: { device?: string }
	 *
	 * Always creates a snapshot, regardless of whether one was already taken today.
	 * For "Take snapshot now" command (pre-agent, pre-refactor).
	 */
	private async handleSnapshotNow(
		req: Party.Request,
		r2: ReturnType<typeof getR2Config> & object,
		vaultId: string,
	): Promise<Response> {
		let body: { device?: string } = {};
		try {
			body = await req.json() as typeof body;
		} catch { /* empty body is fine */ }

		try {
			const ydoc = await unstable_getYDoc(this.room, {
				persist: { mode: "snapshot" },
			});

			const index = await createSnapshot(ydoc, vaultId, r2, body.device);

			// Update last snapshot day tracking
			const currentDay = new Date().toISOString().slice(0, 10);
			await this.room.storage.put(LAST_SNAPSHOT_DAY_KEY, currentDay);
			await this.room.storage.put(LAST_SNAPSHOT_ID_KEY, index.snapshotId);

			console.log(
				`[vault-sync] Snapshot (manual) created: ${index.snapshotId} ` +
				`(${index.markdownFileCount} md, ${index.blobFileCount} blobs, ` +
				`${Math.round(index.crdtSizeBytes / 1024)} KB compressed)`,
			);

			return json({
				status: "created",
				snapshotId: index.snapshotId,
				index,
			} satisfies SnapshotResult);
		} catch (err) {
			console.error("[vault-sync] snapshot/now error:", err);
			return json({ error: "snapshot failed", detail: String(err) }, 500);
		}
	}

	/**
	 * GET /snapshot/list
	 *
	 * Returns all snapshot indexes for this vault, newest first.
	 */
	private async handleSnapshotList(
		r2: ReturnType<typeof getR2Config> & object,
		vaultId: string,
	): Promise<Response> {
		try {
			const snapshots = await listSnapshots(vaultId, r2);
			return json({ snapshots });
		} catch (err) {
			console.error("[vault-sync] snapshot/list error:", err);
			return json({ error: "list failed", detail: String(err) }, 500);
		}
	}

	/**
	 * POST /snapshot/presign-get
	 * Body: { snapshotId: string, day: string }
	 *
	 * Returns a presigned URL for downloading the crdt.bin.gz of a specific snapshot.
	 */
	private async handleSnapshotPresignGet(
		req: Party.Request,
		r2: ReturnType<typeof getR2Config> & object,
		vaultId: string,
	): Promise<Response> {
		let body: { snapshotId?: string; day?: string };
		try {
			body = await req.json() as typeof body;
		} catch {
			return json({ error: "invalid json" }, 400);
		}

		const { snapshotId, day } = body;
		if (!snapshotId || typeof snapshotId !== "string") {
			return json({ error: "missing snapshotId" }, 400);
		}
		if (!day || typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
			return json({ error: "invalid day format (expected YYYY-MM-DD)" }, 400);
		}

		try {
			const result = await presignSnapshotGet(vaultId, snapshotId, day, r2);
			return json(result);
		} catch (err) {
			console.error("[vault-sync] snapshot/presign-get error:", err);
			return json({ error: "presign failed" }, 500);
		}
	}
}

VaultSyncServer satisfies Party.Worker;

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

function r2NotConfigured(): Response {
	return json({
		error: "R2 not configured",
		detail: "Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME env vars on the server.",
	}, 503);
}
