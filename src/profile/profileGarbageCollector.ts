/**
 * Profile garbage collection.
 *
 * Local GC: walks the staging/cache directories the subscriber uses and
 * deletes blobs (and stale staging entries) that are not referenced by any
 * of the recent generations the subscriber still needs to apply or roll
 * back to.
 *
 * Remote GC computation: pure helper that returns the set of blob hashes
 * that must be retained, given a window of recent locks plus their
 * referenced manifests and plugin code manifests. Caller is responsible
 * for actually issuing the deletes against R2 (driven by an opt-in route).
 *
 * No fancy distributed coordination — retention is window-based and
 * locks-of-record drive the reachable set.
 */

import type {
	PluginCodeManifest,
	ProfileLock,
	ProfileManifest,
} from "./profileLock";

export const PROFILE_RETAINED_GENERATIONS = 3;

/**
 * Bootstrap items that local GC must NEVER prune even if no recent
 * generation references them. Keeps YAOS sync alive after a wrong manifest
 * generation accidentally drops the YAOS plugin reference.
 */
export const BOOTSTRAP_PROTECTED_PATH_PREFIXES: ReadonlySet<string> = new Set([
	"plugins/yaos",
	"plugins/obsidian42-brat",
]);

export interface RetainedHashesInput {
	/** Locks to retain — typically the current lock + last N. */
	locks: readonly ProfileLock[];
	/** Manifests already downloaded for those locks. */
	profileManifests: readonly ProfileManifest[];
	/** Plugin code manifests already downloaded for those locks. */
	pluginCodeManifests: readonly PluginCodeManifest[];
	/** Hashes flagged as unresolved-conflict — preserved unconditionally. */
	preservedUnresolvedHashes?: readonly string[];
}

/**
 * Compute the union of hashes referenced by the supplied locks/manifests.
 * Anything outside this set is a candidate for deletion (after the caller
 * also excludes its own bootstrap-protected items).
 */
export function computeRetainedHashes(input: RetainedHashesInput): Set<string> {
	const retained = new Set<string>();

	for (const lock of input.locks) {
		for (const ref of Object.values(lock.profileManifests)) {
			if (ref) retained.add(ref.manifestHash);
		}
		for (const plock of Object.values(lock.pluginLocks)) {
			retained.add(plock.codeManifestHash);
		}
	}

	for (const manifest of input.profileManifests) {
		for (const file of manifest.files) retained.add(file.hash);
	}

	for (const codeManifest of input.pluginCodeManifests) {
		for (const file of codeManifest.files) retained.add(file.hash);
	}

	for (const hash of input.preservedUnresolvedHashes ?? []) {
		retained.add(hash);
	}

	return retained;
}

export interface LocalGcReport {
	keptHashes: number;
	deletedHashes: string[];
	preservedBootstrapPaths: string[];
}

export interface LocalGcInput {
	/** All locally-cached blob hashes (from staging+cache). */
	cachedHashes: readonly string[];
	/** Optional path-side index (for bootstrap protection). */
	cachedPathsByHash?: ReadonlyMap<string, string>;
	retained: ReadonlySet<string>;
}

export function planLocalGc(input: LocalGcInput): LocalGcReport {
	const deletedHashes: string[] = [];
	const preservedBootstrapPaths: string[] = [];
	let keptHashes = 0;

	for (const hash of input.cachedHashes) {
		if (input.retained.has(hash)) {
			keptHashes++;
			continue;
		}
		const path = input.cachedPathsByHash?.get(hash);
		if (path && isBootstrapProtected(path)) {
			preservedBootstrapPaths.push(path);
			keptHashes++;
			continue;
		}
		deletedHashes.push(hash);
	}

	return { keptHashes, deletedHashes, preservedBootstrapPaths };
}

export function isBootstrapProtected(path: string): boolean {
	for (const prefix of BOOTSTRAP_PROTECTED_PATH_PREFIXES) {
		if (path === prefix || path.startsWith(prefix + "/")) return true;
	}
	return false;
}
