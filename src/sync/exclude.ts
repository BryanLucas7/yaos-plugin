import {
	type ConfigProfileSyncPolicy,
	isConfigProfilePath,
	isConfigProfilePathSyncable,
	normalizeSyncPath,
} from "./profileSyncPolicy";

/** Paths that are always excluded, regardless of user settings. */
function normalizePrefix(path: string): string {
	return normalizeSyncPath(path);
}

/**
 * Check if a vault-relative path should be excluded from sync.
 * Always excludes the current config directory and .trash/, plus any
 * user-configured prefixes.
 *
 * @param path - Vault-relative path (e.g. "templates/daily.md")
 * @param patterns - Parsed exclude prefixes (e.g. ["templates/", ".trash/"])
 * @param configDir - Obsidian config directory name
 * @returns true if the path matches any exclude pattern
 */
export function isExcluded(path: string, patterns: string[], configDir: string): boolean {
	const normalizedPath = normalizePrefix(path);
	if (normalizedPath.startsWith(".trash/")) return true;
	if (isConfigProfilePath(path, configDir)) return true;
	for (const prefix of patterns) {
		if (normalizedPath.startsWith(normalizePrefix(prefix))) return true;
	}
	return false;
}

export function isExcludedForDirection(
	path: string,
	patterns: string[],
	configDir: string,
	configProfilePolicy?: ConfigProfileSyncPolicy,
): boolean {
	const normalizedPath = normalizePrefix(path);
	if (normalizedPath.startsWith(".trash/")) return true;
	if (isConfigProfilePath(path, configDir)) {
		return !isConfigProfilePathSyncable(path, configDir, configProfilePolicy);
	}
	for (const prefix of patterns) {
		if (normalizedPath.startsWith(normalizePrefix(prefix))) return true;
	}
	return false;
}

/**
 * Parse the comma-separated excludePatterns setting into a list of
 * trimmed, non-empty prefixes.
 */
export function parseExcludePatterns(raw: string): string[] {
	return raw
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}
