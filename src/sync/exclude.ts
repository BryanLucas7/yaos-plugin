/** Paths that are always excluded, regardless of user settings. */
const ALWAYS_EXCLUDED = [".obsidian/", ".obsidian\\", ".trash/", ".trash\\"];

/**
 * Check if a vault-relative path should be excluded from sync.
 * Always excludes .obsidian/ and .trash/, plus any user-configured prefixes.
 *
 * @param path - Vault-relative path (e.g. "templates/daily.md")
 * @param patterns - Parsed exclude prefixes (e.g. ["templates/", ".trash/"])
 * @returns true if the path matches any exclude pattern
 */
export function isExcluded(path: string, patterns: string[]): boolean {
	for (const prefix of ALWAYS_EXCLUDED) {
		if (path.startsWith(prefix)) return true;
	}
	for (const prefix of patterns) {
		if (path.startsWith(prefix)) return true;
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
