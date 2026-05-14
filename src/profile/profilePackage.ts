import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ConfigProfileAllowlistPreset } from "../sync/profileSyncPolicy";

export const PROFILE_PACKAGE_MAP_KEY = "mobile";
export const PROFILE_PACKAGE_MANIFEST_PATH = "yaos-profile-manifest.json";
export const PROFILE_PACKAGE_SCHEMA_VERSION = 1;

export interface ProfilePackageFileInput {
	path: string;
	data: Uint8Array;
}

export interface ProfilePackageManifestFile {
	path: string;
	size: number;
	sha256: string;
}

export interface ProfilePackageManifest {
	schemaVersion: 1;
	preset: ConfigProfileAllowlistPreset;
	generation: string;
	createdAt: string;
	deviceName: string;
	files: ProfilePackageManifestFile[];
}

export interface ProfilePackageRef {
	schemaVersion: 1;
	preset: ConfigProfileAllowlistPreset;
	generation: string;
	createdAt: string;
	deviceName: string;
	hash: string;
	size: number;
	fileCount: number;
	manifestHash: string;
}

export interface BuiltProfilePackage {
	bytes: Uint8Array;
	hash: string;
	manifestHash: string;
	manifest: ProfilePackageManifest;
	ref: ProfilePackageRef;
}

export interface ValidatedProfilePackage {
	hash: string;
	manifest: ProfilePackageManifest;
	files: ProfilePackageFileInput[];
}

const PROFILE_ROOT_CONFIG_FILES = new Set([
	"app.json",
	"appearance.json",
	"community-plugins.json",
	"core-plugins.json",
	"daily-notes.json",
	"graph.json",
	"hotkeys.json",
	"types.json",
	"webviewer.json",
	"workspace-mobile.json",
	"workspaces.json",
]);

const PROFILE_ROOT_CONFIG_PREFIXES = [
	"snippets/",
	"themes/",
	"icons/",
];

export const MOBILE_PROFILE_PLUGIN_IDS = [
	"lazy-plugins",
	"homepage",
	"recent-files-obsidian",
	"folder-notes",
	"obsidian-style-settings",
	"templater-obsidian",
	"dataview",
	"obsidian-tasks-plugin",
	"obsidian-meta-bind-plugin",
	"buttons",
	"auto-note-mover",
	"table-editor-obsidian",
	"obsidian42-brat",
	"obsidian-icon-folder",
	"obsidian-excalidraw-plugin",
	"chronology",
	"keep-the-rhythm",
	"file-explorer-note-count",
	"image-converter",
	"obsidian-fullscreen-plugin",
] as const;

const MOBILE_PROFILE_PLUGIN_ID_SET = new Set<string>(MOBILE_PROFILE_PLUGIN_IDS);

export const MOBILE_COMMUNITY_PLUGIN_IDS = [
	"yaos",
	...MOBILE_PROFILE_PLUGIN_IDS,
];

const BLOCKED_PLUGIN_IDS = new Set([
	"yaos",
	"agent-client",
	"rich-text-editor",
]);

const BLOCKED_NAME_FRAGMENTS = [
	"conflict",
	"before",
	"broken",
	"restore",
	"backup",
];

const BLOCKED_SEGMENTS = new Set([
	"logs",
	"diagnostics",
	"flight-logs",
	"restore-backups",
	"sessions",
	"session",
	"cache",
	"caches",
	".git",
	"node_modules",
]);

const LAZY_PLUGIN_MOBILE_STARTUP: Record<string, "instant" | "short" | "long" | "disabled"> = {
	yaos: "instant",
	"lazy-plugins": "instant",
	homepage: "instant",
	"recent-files-obsidian": "instant",
	"folder-notes": "instant",
	"obsidian-style-settings": "instant",
	"templater-obsidian": "instant",
	dataview: "instant",
	"obsidian-tasks-plugin": "instant",
	"obsidian-meta-bind-plugin": "instant",
	buttons: "instant",
	"auto-note-mover": "instant",
	"table-editor-obsidian": "short",
	"obsidian42-brat": "short",
	"obsidian-icon-folder": "short",
	"obsidian-excalidraw-plugin": "short",
	chronology: "short",
	"keep-the-rhythm": "short",
	"file-explorer-note-count": "short",
	"image-converter": "short",
	"obsidian-fullscreen-plugin": "short",
};

export function normalizeProfilePackagePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "")
		.replace(/\/$/, "");
}

export function profilePackageRelativePath(path: string, configDir = ".obsidian"): string | null {
	const normalized = normalizeProfilePackagePath(path);
	const normalizedConfigDir = normalizeProfilePackagePath(configDir);
	if (normalized === normalizedConfigDir) return "";
	if (!normalized.startsWith(`${normalizedConfigDir}/`)) return null;
	return normalized.slice(normalizedConfigDir.length + 1);
}

export function isSafeProfilePackagePath(path: string): boolean {
	const normalized = normalizeProfilePackagePath(path);
	if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return false;
	const parts = normalized.split("/");
	return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function hasBlockedNameFragment(path: string): boolean {
	const lower = path.toLowerCase();
	return BLOCKED_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function hasBlockedSegment(path: string): boolean {
	const parts = path.toLowerCase().split("/");
	return parts.some((part) => BLOCKED_SEGMENTS.has(part));
}

export function isProfilePackagePathAllowed(path: string, configDir = ".obsidian"): boolean {
	const normalized = normalizeProfilePackagePath(path);
	if (!isSafeProfilePackagePath(normalized)) return false;
	const relative = profilePackageRelativePath(normalized, configDir);
	if (!relative) return false;
	const lower = relative.toLowerCase();
	if (hasBlockedNameFragment(lower) || hasBlockedSegment(lower)) return false;

	if (PROFILE_ROOT_CONFIG_FILES.has(relative)) return true;
	if (PROFILE_ROOT_CONFIG_PREFIXES.some((prefix) => relative.startsWith(prefix))) return true;

	if (!relative.startsWith("plugins/")) return false;
	const [, pluginId, ...rest] = relative.split("/");
	if (!pluginId || rest.length === 0) return false;
	if (BLOCKED_PLUGIN_IDS.has(pluginId)) return false;
	if (!MOBILE_PROFILE_PLUGIN_ID_SET.has(pluginId)) return false;
	const pluginSubPath = rest.join("/");
	if (!pluginSubPath || hasBlockedNameFragment(pluginSubPath) || hasBlockedSegment(pluginSubPath)) return false;
	return true;
}

export function isProfilePackagePluginPath(path: string, configDir = ".obsidian"): boolean {
	const relative = profilePackageRelativePath(path, configDir);
	return !!relative?.startsWith("plugins/");
}

export function pluginIdFromProfilePackagePath(path: string, configDir = ".obsidian"): string | null {
	const relative = profilePackageRelativePath(path, configDir);
	if (!relative?.startsWith("plugins/")) return null;
	const parts = relative.split("/");
	return parts[1] ?? null;
}

export function buildMobileCommunityPluginsJson(packagedPluginIds?: Iterable<string>): string {
	const packaged = packagedPluginIds ? new Set(packagedPluginIds) : null;
	const ids = MOBILE_COMMUNITY_PLUGIN_IDS.filter((pluginId) => pluginId === "yaos" || !packaged || packaged.has(pluginId));
	return `${JSON.stringify(ids, null, 2)}\n`;
}

export function buildMobileLazyPluginDataJson(existingJson?: string | null): string {
	let parsed: Record<string, unknown> = {};
	if (existingJson) {
		try {
			const value = JSON.parse(existingJson);
			if (value && typeof value === "object" && !Array.isArray(value)) {
				parsed = { ...(value as Record<string, unknown>) };
			}
		} catch {
			parsed = {};
		}
	}
	const mobilePlugins: Record<string, { startupType: string }> = {};
	for (const pluginId of MOBILE_COMMUNITY_PLUGIN_IDS) {
		mobilePlugins[pluginId] = {
			startupType: LAZY_PLUGIN_MOBILE_STARTUP[pluginId] ?? "short",
		};
	}
	const next = {
		...parsed,
		dualConfigs: true,
		mobile: {
			shortDelaySeconds: 5,
			longDelaySeconds: 15,
			delayBetweenPlugins: 40,
			defaultStartupType: null,
			showDescriptions: true,
			enableDependencies: false,
			plugins: mobilePlugins,
		},
	};
	return `${JSON.stringify(next, null, 2)}\n`;
}

export function buildMobileBratDataJson(existingJson?: string | null): string {
	let parsed: Record<string, unknown> = {};
	if (existingJson) {
		try {
			const value = JSON.parse(existingJson);
			if (value && typeof value === "object" && !Array.isArray(value)) {
				parsed = { ...(value as Record<string, unknown>) };
			}
		} catch {
			parsed = {};
		}
	}
	const next = {
		...parsed,
		pluginList: ["BryanLucas7/yaos-plugin"],
		pluginSubListFrozenVersion: [
			{ repo: "BryanLucas7/yaos-plugin", version: "" },
		],
		themesList: [],
		updateAtStartup: false,
		updateThemesAtStartup: false,
		enableAfterInstall: true,
		loggingEnabled: false,
		loggingVerboseEnabled: false,
		debuggingMode: false,
	};
	return `${JSON.stringify(next, null, 2)}\n`;
}

export function shouldSynthesizeProfilePackageFile(path: string, configDir = ".obsidian"): boolean {
	const normalized = normalizeProfilePackagePath(path);
	const normalizedConfigDir = normalizeProfilePackagePath(configDir);
	return normalized === `${normalizedConfigDir}/community-plugins.json`
		|| normalized === `${normalizedConfigDir}/plugins/lazy-plugins/data.json`
		|| normalized === `${normalizedConfigDir}/plugins/obsidian42-brat/data.json`;
}

export function synthesizeProfilePackageFile(path: string, existingText: string | null, configDir = ".obsidian"): Uint8Array | null {
	const normalized = normalizeProfilePackagePath(path);
	const normalizedConfigDir = normalizeProfilePackagePath(configDir);
	if (normalized === `${normalizedConfigDir}/community-plugins.json`) {
		return strToU8(buildMobileCommunityPluginsJson());
	}
	if (normalized === `${normalizedConfigDir}/plugins/lazy-plugins/data.json`) {
		return strToU8(buildMobileLazyPluginDataJson(existingText));
	}
	if (normalized === `${normalizedConfigDir}/plugins/obsidian42-brat/data.json`) {
		return strToU8(buildMobileBratDataJson(existingText));
	}
	return null;
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("crypto.subtle is unavailable");
	}
	const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? bytes.buffer
		: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sortProfileFiles(files: ProfilePackageFileInput[]): ProfilePackageFileInput[] {
	return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

export async function buildProfilePackageArchive(
	files: ProfilePackageFileInput[],
	options: {
		generation: string;
		createdAt: string;
		deviceName: string;
		preset?: ConfigProfileAllowlistPreset;
		configDir?: string;
	},
): Promise<BuiltProfilePackage> {
	const configDir = options.configDir ?? ".obsidian";
	const normalizedFiles = sortProfileFiles(files.map((file) => ({
		path: normalizeProfilePackagePath(file.path),
		data: file.data,
	})));
	const manifestFiles: ProfilePackageManifestFile[] = [];
	const zipEntries: Record<string, Uint8Array> = {};
	for (const file of normalizedFiles) {
		if (!isProfilePackagePathAllowed(file.path, configDir)) {
			throw new Error(`Profile package path is not allowed: ${file.path}`);
		}
		if (zipEntries[file.path]) {
			throw new Error(`Duplicate profile package path: ${file.path}`);
		}
		zipEntries[file.path] = file.data;
		manifestFiles.push({
			path: file.path,
			size: file.data.byteLength,
			sha256: await sha256HexBytes(file.data),
		});
	}
	const manifest: ProfilePackageManifest = {
		schemaVersion: PROFILE_PACKAGE_SCHEMA_VERSION,
		preset: options.preset ?? "mobile",
		generation: options.generation,
		createdAt: options.createdAt,
		deviceName: options.deviceName,
		files: manifestFiles,
	};
	const manifestBytes = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
	const manifestHash = await sha256HexBytes(manifestBytes);
	zipEntries[PROFILE_PACKAGE_MANIFEST_PATH] = manifestBytes;
	const bytes = zipSync(zipEntries, { level: 6 });
	const hash = await sha256HexBytes(bytes);
	return {
		bytes,
		hash,
		manifestHash,
		manifest,
		ref: {
			schemaVersion: PROFILE_PACKAGE_SCHEMA_VERSION,
			preset: manifest.preset,
			generation: manifest.generation,
			createdAt: manifest.createdAt,
			deviceName: manifest.deviceName,
			hash,
			size: bytes.byteLength,
			fileCount: manifest.files.length,
			manifestHash,
		},
	};
}

function parseProfilePackageManifest(bytes: Uint8Array): ProfilePackageManifest {
	const parsed = JSON.parse(strFromU8(bytes)) as unknown;
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Profile package manifest is not an object");
	}
	const manifest = parsed as Partial<ProfilePackageManifest>;
	if (manifest.schemaVersion !== PROFILE_PACKAGE_SCHEMA_VERSION) {
		throw new Error("Unsupported profile package schema version");
	}
	if (manifest.preset !== "mobile") {
		throw new Error("Unsupported profile package preset");
	}
	if (typeof manifest.generation !== "string" || !manifest.generation) {
		throw new Error("Profile package generation is missing");
	}
	if (typeof manifest.createdAt !== "string" || !manifest.createdAt) {
		throw new Error("Profile package createdAt is missing");
	}
	if (typeof manifest.deviceName !== "string") {
		throw new Error("Profile package deviceName is invalid");
	}
	if (!Array.isArray(manifest.files)) {
		throw new Error("Profile package file list is missing");
	}
	return manifest as ProfilePackageManifest;
}

export async function validateProfilePackageArchive(
	bytes: Uint8Array,
	options?: {
		expectedHash?: string;
		expectedManifestHash?: string;
		configDir?: string;
	},
): Promise<ValidatedProfilePackage> {
	const configDir = options?.configDir ?? ".obsidian";
	const hash = await sha256HexBytes(bytes);
	if (options?.expectedHash && hash !== options.expectedHash) {
		throw new Error("Profile package hash does not match metadata");
	}
	const entries = unzipSync(bytes);
	const manifestBytes = entries[PROFILE_PACKAGE_MANIFEST_PATH];
	if (!manifestBytes) {
		throw new Error("Profile package manifest is missing");
	}
	const manifestHash = await sha256HexBytes(manifestBytes);
	if (options?.expectedManifestHash && manifestHash !== options.expectedManifestHash) {
		throw new Error("Profile package manifest hash does not match metadata");
	}
	const manifest = parseProfilePackageManifest(manifestBytes);
	const expectedPaths = new Set<string>();
	const files: ProfilePackageFileInput[] = [];
	for (const file of manifest.files) {
		if (!file || typeof file.path !== "string") {
			throw new Error("Profile package manifest contains an invalid path");
		}
		const path = normalizeProfilePackagePath(file.path);
		if (expectedPaths.has(path)) {
			throw new Error(`Profile package manifest has duplicate path: ${path}`);
		}
		if (!isProfilePackagePathAllowed(path, configDir)) {
			throw new Error(`Profile package manifest contains blocked path: ${path}`);
		}
		const data = entries[path];
		if (!data) {
			throw new Error(`Profile package is missing file: ${path}`);
		}
		if (data.byteLength !== file.size) {
			throw new Error(`Profile package size mismatch: ${path}`);
		}
		const fileHash = await sha256HexBytes(data);
		if (fileHash !== file.sha256) {
			throw new Error(`Profile package hash mismatch: ${path}`);
		}
		expectedPaths.add(path);
		files.push({ path, data });
	}
	for (const path of Object.keys(entries)) {
		if (path === PROFILE_PACKAGE_MANIFEST_PATH) continue;
		if (!expectedPaths.has(path)) {
			throw new Error(`Profile package contains unlisted file: ${path}`);
		}
	}
	return {
		hash,
		manifest,
		files: sortProfileFiles(files),
	};
}
