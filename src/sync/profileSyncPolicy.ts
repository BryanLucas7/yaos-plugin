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

const MOBILE_CONFIG_PREFIXES = [
	"snippets/",
	"themes/",
	"icons/",
];

const MOBILE_PLUGIN_IDS = new Set([
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
]);

const YAOS_PLUGIN_FILES = new Set([
	"plugins/yaos/main.js",
	"plugins/yaos/manifest.json",
	"plugins/yaos/styles.css",
]);

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
	if (lower === "plugins/yaos/data.json") return true;
	if (lower.startsWith("plugins/yaos/logs/")) return true;
	if (lower.startsWith("plugins/yaos/diagnostics/")) return true;
	if (lower.startsWith("plugins/yaos/flight-logs/")) return true;
	if (lower.startsWith("plugins/yaos/restore-backups/")) return true;
	if (lower.startsWith("plugins/agent-client/")) return true;
	if (lower.startsWith("plugins/rich-text-editor/")) return true;
	const fileName = lower.split("/").pop() ?? lower;
	return BLOCKED_NAME_FRAGMENTS.some((fragment) => fileName.includes(fragment));
}

export function isMobileConfigProfileAllowlisted(path: string, configDir: string): boolean {
	const relativePath = stripConfigDir(path, configDir);
	if (!relativePath) return false;
	if (isBlockedProfilePath(relativePath)) return false;
	if (MOBILE_CONFIG_FILES.has(relativePath)) return true;
	if (MOBILE_CONFIG_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return true;
	if (YAOS_PLUGIN_FILES.has(relativePath)) return true;
	if (relativePath.startsWith("plugins/")) {
		const [, pluginId] = relativePath.split("/");
		return typeof pluginId === "string" && MOBILE_PLUGIN_IDS.has(pluginId);
	}
	return false;
}

export function isConfigProfilePathSyncable(
	path: string,
	configDir: string,
	policy?: ConfigProfileSyncPolicy,
): boolean {
	if (!policy?.enabled) return false;
	if (policy.mode === "off") return false;
	if (policy.preset !== "mobile") return false;
	if (!isMobileConfigProfileAllowlisted(path, configDir)) return false;
	if (policy.direction === "download") {
		return policy.mode === "publish" || policy.mode === "subscribe";
	}
	return policy.mode === "publish";
}
