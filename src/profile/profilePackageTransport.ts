import { requestUrl } from "obsidian";
import {
	appendTraceParams,
	type TraceHttpContext,
} from "../debug/trace";

const MIN_PROFILE_PACKAGE_TIMEOUT_MS = 30_000;
const MAX_PROFILE_PACKAGE_TIMEOUT_MS = 10 * 60_000;
const PROFILE_PACKAGE_BYTES_PER_SEC = 64 * 1024;
const PROFILE_PACKAGE_SETUP_BUDGET_MS = 15_000;

class ProfilePackageHttpTimeoutError extends Error {
	constructor(
		public readonly operation: string,
		public readonly timeoutMs: number,
	) {
		super(`Timeout (${timeoutMs}ms) during ${operation}`);
		this.name = "ProfilePackageHttpTimeoutError";
	}
}

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	operation: string,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new ProfilePackageHttpTimeoutError(operation, ms));
		}, ms);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

function transferTimeoutMs(sizeBytes?: number): number {
	if (!sizeBytes || sizeBytes <= 0) return MIN_PROFILE_PACKAGE_TIMEOUT_MS;
	const transferMs = Math.ceil((sizeBytes / PROFILE_PACKAGE_BYTES_PER_SEC) * 1000);
	return Math.min(
		MAX_PROFILE_PACKAGE_TIMEOUT_MS,
		Math.max(MIN_PROFILE_PACKAGE_TIMEOUT_MS, PROFILE_PACKAGE_SETUP_BUDGET_MS + transferMs),
	);
}

export class ProfilePackageTransport {
	constructor(
		private readonly host: string,
		private readonly token: string,
		private readonly vaultId: string,
		private readonly trace?: TraceHttpContext,
	) {}

	private url(hash: string): string {
		return appendTraceParams(
			`${this.host}/vault/${encodeURIComponent(this.vaultId)}/blobs/${encodeURIComponent(hash)}`,
			this.trace,
		);
	}

	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
		};
	}

	async upload(hash: string, bytes: Uint8Array): Promise<void> {
		const body = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
			? bytes.buffer
			: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		const res = await withTimeout(
			requestUrl({
				url: this.url(hash),
				method: "PUT",
				headers: this.authHeaders(),
				body,
				contentType: "application/zip",
			}),
			transferTimeoutMs(bytes.byteLength),
			`profile package upload ${hash.slice(0, 12)}`,
		);
		if (res.status !== 204) {
			throw new Error(`profile package upload failed: ${res.status} ${res.text}`);
		}
	}

	async download(hash: string, sizeBytes?: number): Promise<Uint8Array> {
		const res = await withTimeout(
			requestUrl({
				url: this.url(hash),
				method: "GET",
				headers: this.authHeaders(),
			}),
			transferTimeoutMs(sizeBytes),
			`profile package download ${hash.slice(0, 12)}`,
		);
		if (res.status !== 200) {
			throw new Error(`profile package download failed: ${res.status} ${res.text}`);
		}
		return new Uint8Array(res.arrayBuffer);
	}
}
