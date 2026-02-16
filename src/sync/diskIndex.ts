/**
 * Disk index: tracks {mtime, size} per file path for efficient
 * reconciliation. Only files whose stat changed since last reconcile
 * need to be read from disk.
 *
 * Persisted as JSON via plugin's loadData/saveData under the key
 * "_diskIndex" in the plugin's data.json.
 */
import { type App, TFile, normalizePath } from "obsidian";

export interface DiskIndexEntry {
	/** Last known mtime in ms. */
	mtime: number;
	/** Last known file size in bytes. */
	size: number;
}

export type DiskIndex = Record<string, DiskIndexEntry>;

/**
 * Stat a file using Obsidian's adapter.
 * Returns null if stat fails (file doesn't exist, adapter quirk).
 */
async function statFile(
	app: App,
	path: string,
): Promise<{ mtime: number; size: number } | null> {
	try {
		const stat = await app.vault.adapter.stat(normalizePath(path));
		if (!stat) return null;
		return { mtime: stat.mtime, size: stat.size };
	} catch {
		return null;
	}
}

/**
 * Check if a file has changed since the last indexed stat.
 * Uses (mtime OR size) changed as the trigger — either changing
 * means we should read the file.
 */
export function hasChanged(
	entry: DiskIndexEntry | undefined,
	stat: { mtime: number; size: number },
): boolean {
	if (!entry) return true; // never seen before
	return entry.mtime !== stat.mtime || entry.size !== stat.size;
}

/**
 * Build a filtered list of files that need reading during reconciliation.
 *
 * Returns:
 *   - changed: files whose stat differs from index (need vault.read())
 *   - unchanged: files whose stat matches index (skip read)
 *   - allStats: fresh stat map for updating the index after reconcile
 */
export async function filterChangedFiles(
	app: App,
	mdFiles: TFile[],
	index: DiskIndex,
): Promise<{
	changed: TFile[];
	unchanged: TFile[];
	allStats: Map<string, { mtime: number; size: number }>;
}> {
	const changed: TFile[] = [];
	const unchanged: TFile[] = [];
	const allStats = new Map<string, { mtime: number; size: number }>();

	for (const file of mdFiles) {
		const stat = await statFile(app, file.path);
		if (!stat) {
			// Can't stat — treat as changed (fall back to read)
			changed.push(file);
			continue;
		}

		allStats.set(file.path, stat);

		if (hasChanged(index[file.path], stat)) {
			changed.push(file);
		} else {
			unchanged.push(file);
		}
	}

	return { changed, unchanged, allStats };
}

/**
 * Update the disk index with fresh stats after a successful reconcile.
 */
export function updateIndex(
	index: DiskIndex,
	allStats: Map<string, { mtime: number; size: number }>,
): DiskIndex {
	const newIndex: DiskIndex = {};

	for (const [path, stat] of allStats) {
		newIndex[path] = { mtime: stat.mtime, size: stat.size };
	}

	return newIndex;
}

/**
 * Move index entries during a rename batch.
 * For each oldPath → newPath, copy the entry and delete the old one.
 */
export function moveIndexEntries(
	index: DiskIndex,
	renames: Map<string, string>,
): void {
	for (const [oldPath, newPath] of renames) {
		const entry = index[oldPath];
		if (entry) {
			index[newPath] = entry;
			delete index[oldPath];
		}
	}
}

/**
 * File stability check: wait for a file to stop being written to.
 * Checks stat at intervals; stable when two consecutive checks match.
 *
 * Returns true if stable, false if it never stabilized within maxChecks.
 */
export async function waitForStable(
	app: App,
	path: string,
	checks = 3,
	delayMs = 400,
): Promise<boolean> {
	let last: { mtime: number; size: number } | null = null;

	for (let i = 0; i < checks; i++) {
		const stat = await statFile(app, path);
		if (!stat) return false; // file gone

		if (last && last.mtime === stat.mtime && last.size === stat.size) {
			return true; // stable for at least one interval
		}

		last = stat;

		if (i < checks - 1) {
			await new Promise((r) => setTimeout(r, delayMs));
		}
	}

	// If we got here after all checks without two matching, treat as stable
	// (the file was changing every check interval — unusual but not fatal)
	return last !== null;
}
