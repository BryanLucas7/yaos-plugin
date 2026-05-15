/**
 * Builders for ProfileManifest and the per-profile community-plugins.json.
 *
 * Pure logic — operates on a `ScannedConfigDir` snapshot supplied by the
 * Obsidian-side caller. Tests can drive it directly with fixture data.
 */

import {
	BOOTSTRAP_PLUGIN_IDS,
	type PluginManifestLike,
	type Profile,
	type ProfilePolicy,
} from "./profilePolicy";
import {
	PROFILE_MANIFEST_VERSION,
	type ProfileApplyPhase,
	type ProfileFileKind,
	type ProfileManifest,
	type ProfileManifestFile,
} from "./profileLock";

/** Always written last. */
const ACTIVATION_ROOT_FILES: ReadonlySet<string> = new Set([
	"core-plugins.json",
	"workspace.json",
	"workspace-mobile.json",
	"workspaces.json",
]);

/** Files always included in the bootstrap-active list of community-plugins. */
const COMMUNITY_PLUGINS_BOOTSTRAP: ReadonlyArray<string> = [
	"yaos",
	"obsidian42-brat",
	"lazy-plugins",
];

export interface ScannedFile {
	path: string;
	hash: string;
	size: number;
	kind: ProfileFileKind;
	pluginId?: string;
	bytes?: Uint8Array;
}

export interface ScannedPlugin {
	pluginId: string;
	manifest: PluginManifestLike;
	codeFiles: Array<{ path: string; hash: string; size: number; bytes?: Uint8Array }>;
	dataJson: { hash: string; size: number; bytes?: Uint8Array } | null;
	otherBehaviorFiles: Array<{ path: string; hash: string; size: number; bytes?: Uint8Array }>;
}

export interface ScannedConfigDir {
	rootConfigFiles: Array<{ name: string; hash: string; size: number; bytes?: Uint8Array }>;
	snippetFiles: ScannedFile[];
	themeFiles: ScannedFile[];
	iconFiles: ScannedFile[];
	plugins: ScannedPlugin[];
	/** Local community-plugins.json contents (raw plugin id list). */
	rawCommunityPluginIds: string[];
}

export interface BuildProfileManifestInput {
	scan: ScannedConfigDir;
	profile: Profile;
	policy: ProfilePolicy;
	generation: string;
	baseGeneration: string;
	createdAt: string;
	sourceDeviceId: string;
}

/** Order activation-last files come dead-last so apply phase 3 stays simple. */
function applyPhaseFor(file: ScannedFile): ProfileApplyPhase {
	if (file.kind === "config") {
		const tail = file.path.split("/").pop() ?? file.path;
		if (ACTIVATION_ROOT_FILES.has(tail)) return "activation-last";
	}
	if (file.kind === "plugin-behavior") {
		// plugin behavior tied to activation lives next to community-plugins
		const tail = file.path.split("/").pop() ?? file.path;
		if (tail === "data.json") return "safe-now";
	}
	return "safe-now";
}

export function buildProfileManifest(input: BuildProfileManifestInput): ProfileManifest {
	const { scan, profile, policy, generation, baseGeneration, createdAt, sourceDeviceId } = input;
	const files: ProfileManifestFile[] = [];

	for (const root of scan.rootConfigFiles) {
		if (!policy.isAllowedRootConfigFile(root.name)) continue;
		if (!policy.isPathAllowedForProfile(root.name, profile)) continue;
		const f: ScannedFile = { path: root.name, hash: root.hash, size: root.size, kind: "config" };
		files.push({ ...f, applyPhase: applyPhaseFor(f) });
	}

	for (const snippet of scan.snippetFiles) {
		if (!policy.isPathAllowedForProfile(snippet.path, profile)) continue;
		files.push({ ...snippet, kind: "snippet", applyPhase: "safe-now" });
	}
	for (const theme of scan.themeFiles) {
		if (!policy.isPathAllowedForProfile(theme.path, profile)) continue;
		files.push({ ...theme, kind: "theme", applyPhase: "safe-now" });
	}
	for (const icon of scan.iconFiles) {
		if (!policy.isPathAllowedForProfile(icon.path, profile)) continue;
		files.push({ ...icon, kind: "icon", applyPhase: "safe-now" });
	}

	// Plugin BEHAVIOR (data.json + other behavior files) goes per-profile.
	// Plugin CODE goes in PluginCodeManifest, never here.
	for (const plugin of scan.plugins) {
		if (BOOTSTRAP_PLUGIN_IDS.has(plugin.pluginId)) continue;
		if (!policy.isPluginAllowedForProfile(plugin.pluginId, plugin.manifest, profile)) continue;
		if (plugin.dataJson) {
			const path = `plugins/${plugin.pluginId}/data.json`;
			if (policy.isPathAllowedForProfile(path, profile)) {
				files.push({
					path,
					hash: plugin.dataJson.hash,
					size: plugin.dataJson.size,
					kind: "plugin-behavior",
					pluginId: plugin.pluginId,
					applyPhase: "safe-now",
				});
			}
		}
		for (const beh of plugin.otherBehaviorFiles) {
			if (!policy.isPathAllowedForProfile(beh.path, profile)) continue;
			files.push({
				path: beh.path,
				hash: beh.hash,
				size: beh.size,
				kind: "plugin-behavior",
				pluginId: plugin.pluginId,
				applyPhase: "safe-now",
			});
		}
	}

	files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

	return {
		version: PROFILE_MANIFEST_VERSION,
		profile,
		generation,
		baseGeneration,
		createdAt,
		sourceDeviceId,
		files,
	};
}

export interface SynthesizeCommunityPluginsInput {
	scan: ScannedConfigDir;
	profile: Profile;
	policy: ProfilePolicy;
	/** From lazy-plugins/data.json: plugins that should remain "instant" on this profile. */
	instantPluginIdsForProfile?: ReadonlyArray<string>;
}

/**
 * Build the community-plugins.json contents for a given profile.
 *
 * Desktop: filter local raw list by denylist + isDesktopOnly absent → keep order.
 * Mobile: bootstrap (yaos/brat/lazy-plugins) + instant plugins from Lazy ONLY.
 * Short/long/disabled plugins live on disk (their files are still in
 * pluginLocks) but are NOT activated through community-plugins.json — Lazy
 * loads them via enablePlugin() with delay.
 */
export function synthesizeCommunityPluginsJson(input: SynthesizeCommunityPluginsInput): string[] {
	const { scan, profile, policy, instantPluginIdsForProfile } = input;
	if (profile === "desktop") {
		const allowed: string[] = [];
		for (const id of scan.rawCommunityPluginIds) {
			if (BOOTSTRAP_PLUGIN_IDS.has(id)) continue; // bootstrap added below
			const plugin = scan.plugins.find((p) => p.pluginId === id);
			if (!plugin) continue;
			if (!policy.isPluginAllowedForProfile(id, plugin.manifest, profile)) continue;
			allowed.push(id);
		}
		const out = [...COMMUNITY_PLUGINS_BOOTSTRAP.filter((id) => id !== "obsidian42-brat"), ...allowed];
		return dedupeStable(out);
	}

	// mobile
	const out: string[] = [...COMMUNITY_PLUGINS_BOOTSTRAP];
	for (const id of instantPluginIdsForProfile ?? []) {
		if (BOOTSTRAP_PLUGIN_IDS.has(id)) continue;
		const plugin = scan.plugins.find((p) => p.pluginId === id);
		if (!plugin) continue;
		if (!policy.isPluginAllowedForProfile(id, plugin.manifest, profile)) continue;
		out.push(id);
	}
	return dedupeStable(out);
}

function dedupeStable(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}
