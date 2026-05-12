/**
 * Wait helpers for the QA harness.
 * All waiters poll a condition. Never use setTimeout for observable state.
 */

import type { App } from "obsidian";
import type { YaosQaDebugApi } from "../../src/qaDebugApi";

const DEFAULT_IDLE_TIMEOUT = 15_000;
const DEFAULT_RECEIPT_TIMEOUT = 30_000;
const DEFAULT_FILE_TIMEOUT = 15_000;
const POLL_INTERVAL = 250;

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
	label: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = async () => {
			try {
				if (await predicate()) {
					resolve();
					return;
				}
			} catch { /* keep polling */ }
			if (Date.now() - start >= timeoutMs) {
				reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				return;
			}
			setTimeout(check, POLL_INTERVAL);
		};
		void check();
	});
}

export function waitForIdle(
	yaos: YaosQaDebugApi,
	timeoutMs = DEFAULT_IDLE_TIMEOUT,
): Promise<void> {
	return yaos.waitForIdle(timeoutMs);
}

export function waitForMemoryReceipt(
	yaos: YaosQaDebugApi,
	timeoutMs = DEFAULT_RECEIPT_TIMEOUT,
): Promise<void> {
	return yaos.waitForMemoryReceipt(timeoutMs);
}

export function waitForFile(
	yaos: YaosQaDebugApi,
	path: string,
	timeoutMs = DEFAULT_FILE_TIMEOUT,
): Promise<void> {
	return yaos.waitForFile(path, timeoutMs);
}

export function waitForFileContent(
	app: App,
	yaos: YaosQaDebugApi,
	path: string,
	expectedHash: string,
	timeoutMs = DEFAULT_FILE_TIMEOUT,
): Promise<void> {
	return waitForCondition(
		async () => {
			const actual = await yaos.getDiskHash(path);
			return actual === expectedHash;
		},
		timeoutMs,
		`waitForFileContent(${path})`,
	);
}
