/**
 * Shared types for the YAOS QA harness.
 */

import type { App } from "obsidian";
import type { YaosQaDebugApi } from "../../src/qaDebugApi";

// -----------------------------------------------------------------------
// Manifest
// -----------------------------------------------------------------------

export interface VaultManifestEntry {
	path: string;
	sha256: string;
	bytes: number;
	kind: "markdown" | "attachment" | "other";
}

export interface VaultManifest {
	generatedAt: string;
	fileCount: number;
	files: VaultManifestEntry[];
}

export interface ManifestDiff {
	match: boolean;
	differ: Array<{ path: string; aSha: string; bSha: string }>;
	missingOnB: string[];
	extraOnB: string[];
}

// -----------------------------------------------------------------------
// Scenario
// -----------------------------------------------------------------------

export type DeleteMode = "vault-delete" | "trash" | "adapter-remove";

export interface QaRunOptions {
	timeoutMs?: number;
	role?: "A" | "B" | "C";
}

export interface QaResult {
	id: string;
	passed: boolean;
	durationMs: number;
	errors: string[];
	warnings: string[];
}

export interface QaContext {
	app: App;
	yaos: YaosQaDebugApi;

	// Vault operations (real Obsidian APIs)
	createFile(path: string, content: string): Promise<void>;
	modifyFile(path: string, content: string): Promise<void>;
	appendToFile(path: string, text: string): Promise<void>;
	deleteFile(path: string, mode?: DeleteMode): Promise<void>;
	renameFile(oldPath: string, newPath: string): Promise<void>;

	/**
	 * Write via Obsidian adapter — bypasses vault event pipeline but NOT the OS watcher.
	 * Use for: adapter-layer tests. Renamed from writeExternal to avoid confusion.
	 * For real external FS writes (OS watcher path), use the Node controller.
	 */
	writeAdapterFile(path: string, content: string): Promise<void>;
	deleteAdapterFile(path: string): Promise<void>;

	// Editor operations
	openFile(path: string): Promise<void>;
	closeFile(path: string): Promise<void>;
	typeIntoFile(path: string, text: string): Promise<void>;
	replaceFileContent(path: string, content: string): Promise<void>;
	runCommand(commandId: string): Promise<void>;

	// Wait helpers
	waitForIdle(timeoutMs?: number): Promise<void>;
	waitForMemoryReceipt(timeoutMs?: number): Promise<void>;
	waitForFile(path: string, timeoutMs?: number): Promise<void>;
	sleep(ms: number): Promise<void>;

	// Assertions
	assert: {
		fileExists(path: string): Promise<void>;
		fileNotExists(path: string): Promise<void>;
		fileContent(path: string, content: string): Promise<void>;
		fileHash(path: string, expectedHash: string): Promise<void>;
		diskEqualsCrdt(path: string): Promise<void>;
		noConflictCopies(dir?: string): Promise<void>;
	};
}

export interface QaScenario {
	id: string;
	title: string;
	tags: string[];
	requiredPlugins?: string[];

	setup(ctx: QaContext): Promise<void>;
	run(ctx: QaContext): Promise<void>;
	assert(ctx: QaContext): Promise<void>;
	cleanup?(ctx: QaContext): Promise<void>;
}

// -----------------------------------------------------------------------
// Console API
// -----------------------------------------------------------------------

export interface TypingOptions {
	intervalMs?: number;
}

export interface QaConsoleApi {
	help(): void;
	scenarios(): string[];
	run(id: string, opts?: QaRunOptions): Promise<QaResult>;

	// Vault operations
	createFile(path: string, content: string): Promise<void>;
	modifyFile(path: string, content: string): Promise<void>;
	appendToFile(path: string, text: string): Promise<void>;
	deleteFile(path: string, mode?: DeleteMode): Promise<void>;
	renameFile(oldPath: string, newPath: string): Promise<void>;
	writeAdapterFile(path: string, content: string): Promise<void>;
	deleteAdapterFile(path: string): Promise<void>;

	// Editor operations
	openFile(path: string): Promise<void>;
	closeFile(path: string): Promise<void>;
	typeIntoFile(path: string, text: string, opts?: TypingOptions): Promise<void>;
	replaceFileContent(path: string, content: string): Promise<void>;
	runCommand(commandId: string): Promise<void>;

	// Wait
	waitForIdle(timeoutMs?: number): Promise<void>;
	waitForMemoryReceipt(timeoutMs?: number): Promise<void>;
	waitForFile(path: string, timeoutMs?: number): Promise<void>;

	// Assertions
	assertFileExists(path: string): Promise<void>;
	assertFileNotExists(path: string): Promise<void>;
	assertFileHash(path: string, expectedHash: string): Promise<void>;
	assertDiskEqualsCrdt(path: string): Promise<void>;
	assertNoConflictCopies(dirPath?: string): Promise<void>;

	// Manifests
	manifest(): Promise<VaultManifest>;
	compareManifest(expected: VaultManifest): Promise<ManifestDiff>;

	// Flight trace
	startTrace(mode?: string, secret?: string): Promise<void>;
	stopTrace(): Promise<void>;
	exportTrace(privacy?: "safe" | "full"): Promise<string>;

	// Plugin state
	plugins(): Array<{ id: string; version: string; enabled: boolean }>;
}
