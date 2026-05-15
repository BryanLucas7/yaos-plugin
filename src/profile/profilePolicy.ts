/**
 * Profile policy — what is allowed inside a profile manifest, per profile.
 *
 * Three jobs:
 *   1. Allowlist of root config files that may be packaged.
 *   2. Denylist of paths and plugin IDs that must never be packaged.
 *   3. Per-profile rules: desktop-only plugins excluded from mobile,
 *      agent-client / rich-text-editor excluded from mobile.
 *
 * community-plugins.json is intentionally NOT in the allowlist — it is
 * synthesized per profile by the publisher (see plan), not bulk-copied.
 */

export type Profile = "desktop" | "mobile";

/** The minimal shape we read from a plugin's manifest.json. */
export interface PluginManifestLike {
	id: string;
	version: string;
	isDesktopOnly?: boolean;
}

/**
 * Plugins preserved locally and never packaged as normal plugins.
 * They are bootstrap (BRAT installs YAOS, YAOS does the sync).
 */
export const BOOTSTRAP_PLUGIN_IDS: ReadonlySet<string> = new Set([
	"yaos",
	"obsidian42-brat",
]);

/** Plugins never packaged on any profile. Bootstrap is a strict subset. */
export const ALWAYS_DENY_PLUGIN_IDS: ReadonlySet<string> = new Set([
	"yaos",
	"obsidian42-brat",
]);

/** Plugins additionally never packaged on mobile. */
export const MOBILE_DENY_PLUGIN_IDS: ReadonlySet<string> = new Set([
	"agent-client",
	"rich-text-editor",
]);

/**
 * Root files inside configDir that may be copied verbatim per profile.
 * NOTE: community-plugins.json is synthesized, not in this list.
 */
export const ALLOWED_ROOT_CONFIG_FILES: ReadonlySet<string> = new Set([
	"app.json",
	"appearance.json",
	"core-plugins.json",
	"daily-notes.json",
	"graph.json",
	"hotkeys.json",
	"types.json",
	"webviewer.json",
	"workspace.json",
	"workspace-mobile.json",
	"workspaces.json",
]);

/**
 * Path prefixes (relative to configDir) that are always denied.
 * Each entry is matched as `path === prefix` or `path.startsWith(prefix + "/")`.
 */
export const DENY_PATH_PREFIXES: readonly string[] = [
	"plugins/yaos",
	"plugins/obsidian42-brat",
	"plugins/agent-client",
	"plugins/rich-text-editor",
	"logs",
	"cache",
	"diagnostics",
	"sessions",
	"restore",
	"restore-backups",
	"backup",
	"flight-logs",
];

/** Substrings that, if present anywhere in the path, deny the path. */
export const DENY_PATH_SUBSTRINGS: readonly string[] = [
	"conflict",
	"before",
	"broken",
	"restore",
	"backup",
];

/** Path prefixes (relative to configDir) that are always denied for mobile only. */
export const MOBILE_DENY_PATH_PREFIXES: readonly string[] = [
	"plugins/agent-client",
	"plugins/rich-text-editor",
];

export interface ProfilePolicy {
	isBootstrapPluginId(pluginId: string): boolean;
	isAllowedRootConfigFile(name: string): boolean;
	isPluginAllowedForProfile(
		pluginId: string,
		manifest: PluginManifestLike,
		profile: Profile,
	): boolean;
	isPathAllowedForProfile(relativePath: string, profile: Profile): boolean;
}

function startsWithPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(prefix + "/");
}

function isPathSyntacticallySafe(path: string): boolean {
	if (path.length === 0) return false;
	if (path.includes("..")) return false;
	if (path.startsWith("/")) return false;
	if (/^[A-Za-z]:[\\/]/.test(path)) return false;
	return true;
}

class DefaultProfilePolicy implements ProfilePolicy {
	isBootstrapPluginId(pluginId: string): boolean {
		return BOOTSTRAP_PLUGIN_IDS.has(pluginId);
	}

	isAllowedRootConfigFile(name: string): boolean {
		return ALLOWED_ROOT_CONFIG_FILES.has(name);
	}

	isPluginAllowedForProfile(
		pluginId: string,
		manifest: PluginManifestLike,
		profile: Profile,
	): boolean {
		if (ALWAYS_DENY_PLUGIN_IDS.has(pluginId)) return false;
		if (profile === "mobile") {
			if (MOBILE_DENY_PLUGIN_IDS.has(pluginId)) return false;
			if (manifest.isDesktopOnly === true) return false;
		}
		return true;
	}

	isPathAllowedForProfile(relativePath: string, profile: Profile): boolean {
		const path = relativePath.replace(/\\/g, "/");
		if (!isPathSyntacticallySafe(path)) return false;

		for (const prefix of DENY_PATH_PREFIXES) {
			if (startsWithPrefix(path, prefix)) return false;
		}
		if (profile === "mobile") {
			for (const prefix of MOBILE_DENY_PATH_PREFIXES) {
				if (startsWithPrefix(path, prefix)) return false;
			}
		}
		const lower = path.toLowerCase();
		for (const needle of DENY_PATH_SUBSTRINGS) {
			if (lower.includes(needle)) return false;
		}
		return true;
	}
}

export function createProfilePolicy(): ProfilePolicy {
	return new DefaultProfilePolicy();
}
