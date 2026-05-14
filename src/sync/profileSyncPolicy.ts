export type ConfigProfileMode = "publish" | "subscribe" | "off";
export type ConfigProfileAllowlistPreset = "mobile";
export type ProfileSyncDirection = "upload" | "download";

export interface ConfigProfileSyncPolicy {
	enabled: boolean;
	mode: ConfigProfileMode;
	preset: ConfigProfileAllowlistPreset;
	direction: ProfileSyncDirection;
}

const MOBILE_CONFIG_FILES = new Set([
	"app.json",
	"appearance.json",
	"core-plugins.json",
	"daily-notes.json",
	"graph.json",
	"hotkeys.json",
	"types.json",
	"webviewer.json",
]);

const MOBILE_CONFIG_PREFIXES = [
	"snippets/",
	"themes/",
	"icons/",
];

const BLOCKED_NAME_FRAGMENTS = [
	"conflict",
	"before",
	"broken",
	"restore",
	"backup",
];

export function normalizeSyncPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
}

export function isConfigProfilePath(path: string, configDir: string): boolean {
	const normalizedPath = normalizeSyncPath(path);
	const normalizedConfigDir = normalizeSyncPath(configDir).replace(/\/$/, "");
	return normalizedPath === normalizedConfigDir || normalizedPath.startsWith(`${normalizedConfigDir}/`);
}

function stripConfigDir(path: string, configDir: string): string | null {
	const normalizedPath = normalizeSyncPath(path);
	const normalizedConfigDir = normalizeSyncPath(configDir).replace(/\/$/, "");
	if (!normalizedPath.startsWith(`${normalizedConfigDir}/`)) return null;
	return normalizedPath.slice(normalizedConfigDir.length + 1);
}

function isBlockedProfilePath(relativePath: string): boolean {
	const lower = relativePath.toLowerCase();
	if (lower.startsWith("plugins/")) return true;
	const fileName = lower.split("/").pop() ?? lower;
	return BLOCKED_NAME_FRAGMENTS.some((fragment) => fileName.includes(fragment));
}

export function isMobileConfigProfileAllowlisted(path: string, configDir: string): boolean {
	const relativePath = stripConfigDir(path, configDir);
	if (!relativePath) return false;
	if (isBlockedProfilePath(relativePath)) return false;
	if (MOBILE_CONFIG_FILES.has(relativePath)) return true;
	if (MOBILE_CONFIG_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return true;
	return false;
}

export function isConfigProfilePathSyncable(
	path: string,
	configDir: string,
	policy?: ConfigProfileSyncPolicy,
): boolean {
	void path;
	void configDir;
	void policy;
	return false;
}
