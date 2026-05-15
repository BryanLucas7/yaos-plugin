/**
 * Blob transport for the Profile Mirror.
 *
 * Reuses the existing /vault/<id>/blobs/<hash> endpoints (PUT to upload,
 * GET to download) so we do not need a parallel storage layer. Manifests
 * are JSON blobs sent via the same channel — content-addressed by SHA-256
 * of their canonical JSON encoding.
 *
 * Validation is strict on download: a server returning the wrong bytes
 * fails the SHA-256 check and is rejected.
 */

export interface BlobEndpoint {
	host: string;
	vaultId: string;
	token: string;
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const digest = await crypto.subtle.digest("SHA-256", view);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

export function isValidHash(hash: string): boolean {
	return /^[0-9a-f]{64}$/.test(hash);
}

function blobUrl(endpoint: BlobEndpoint, hash: string): string {
	const host = endpoint.host.replace(/\/$/, "");
	return `${host}/vault/${encodeURIComponent(endpoint.vaultId)}/blobs/${hash}`;
}

function existsUrl(endpoint: BlobEndpoint): string {
	const host = endpoint.host.replace(/\/$/, "");
	return `${host}/vault/${encodeURIComponent(endpoint.vaultId)}/blobs/exists`;
}

function authHeaders(endpoint: BlobEndpoint, extra: Record<string, string> = {}): HeadersInit {
	return { Authorization: `Bearer ${endpoint.token}`, ...extra };
}

export interface ProfileBlobTransport {
	/** Returns the set of hashes the server already has, from `candidates`. */
	existsBatch(candidates: string[]): Promise<Set<string>>;
	/** Upload bytes; the server validates SHA-256 and size. */
	uploadBlob(bytes: Uint8Array, expectedHash: string): Promise<void>;
	/** Download bytes; throws if SHA-256 does not match `expectedHash`. */
	downloadBlob(expectedHash: string): Promise<Uint8Array>;
	/** Convenience: encode JSON canonical, upload, return the hash. */
	uploadJsonBlob(value: unknown): Promise<string>;
	/** Convenience: download + parse JSON; verifies hash before parse. */
	downloadJsonBlob<T>(expectedHash: string): Promise<T>;
}

export class HttpProfileBlobTransport implements ProfileBlobTransport {
	constructor(private readonly endpoint: BlobEndpoint) {}

	async existsBatch(candidates: string[]): Promise<Set<string>> {
		const filtered = candidates.filter(isValidHash);
		if (filtered.length === 0) return new Set();
		const response = await fetch(existsUrl(this.endpoint), {
			method: "POST",
			headers: authHeaders(this.endpoint, { "Content-Type": "application/json" }),
			body: JSON.stringify({ hashes: filtered }),
		});
		if (!response.ok) throw new Error(`exists failed (${response.status})`);
		const body = (await response.json()) as { present?: string[] };
		const present = Array.isArray(body.present) ? body.present : [];
		return new Set(present);
	}

	async uploadBlob(bytes: Uint8Array, expectedHash: string): Promise<void> {
		if (!isValidHash(expectedHash)) {
			throw new Error("uploadBlob: invalid hash");
		}
		const response = await fetch(blobUrl(this.endpoint, expectedHash), {
			method: "PUT",
			headers: authHeaders(this.endpoint, { "Content-Type": "application/octet-stream" }),
			body: bytes as unknown as BodyInit,
		});
		if (!response.ok) throw new Error(`upload failed (${response.status})`);
	}

	async downloadBlob(expectedHash: string): Promise<Uint8Array> {
		if (!isValidHash(expectedHash)) {
			throw new Error("downloadBlob: invalid hash");
		}
		const response = await fetch(blobUrl(this.endpoint, expectedHash), {
			method: "GET",
			headers: authHeaders(this.endpoint),
		});
		if (!response.ok) throw new Error(`download failed (${response.status})`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const actual = await sha256Hex(bytes);
		if (actual !== expectedHash) {
			throw new Error(`download integrity check failed: expected ${expectedHash}, got ${actual}`);
		}
		return bytes;
	}

	async uploadJsonBlob(value: unknown): Promise<string> {
		const bytes = canonicalJsonBytes(value);
		const hash = await sha256Hex(bytes);
		await this.uploadBlob(bytes, hash);
		return hash;
	}

	async downloadJsonBlob<T>(expectedHash: string): Promise<T> {
		const bytes = await this.downloadBlob(expectedHash);
		const text = new TextDecoder("utf-8").decode(bytes);
		return JSON.parse(text) as T;
	}
}

/**
 * Canonical JSON encoding: stable key order recursively, no whitespace.
 * Required so two devices encoding the same logical manifest produce the
 * same bytes (and therefore the same hash).
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const parts = keys.map((k) => {
		const v = (value as Record<string, unknown>)[k];
		if (v === undefined) return null;
		return `${JSON.stringify(k)}:${canonicalJson(v)}`;
	}).filter((s): s is string => s !== null);
	return `{${parts.join(",")}}`;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(canonicalJson(value));
}
