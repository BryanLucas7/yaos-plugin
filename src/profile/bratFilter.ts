/**
 * BRAT (obsidian42-brat) integration.
 *
 * BRAT is local bootstrap: it always lives on disk, BRAT's data.json is
 * NEVER copied verbatim across devices, and the only thing the Profile
 * Mirror touches is a synthesised, filtered beta-list. The mobile beta
 * list excludes any plugin that is desktop-only or any plugin denied on
 * mobile (agent-client, rich-text-editor).
 *
 * BryanLucas7/yaos-plugin is always preserved — that is the channel BRAT
 * uses to install/update YAOS itself.
 */

import {
	type PluginManifestLike,
	type Profile,
	type ProfilePolicy,
} from "./profilePolicy";

export const PROTECTED_BRAT_REPO = "BryanLucas7/yaos-plugin";

/** A single BRAT beta entry — only the bits we filter on. */
export interface BratBetaEntry {
	repo: string;
	pluginId: string;
	manifest?: PluginManifestLike;
}

export interface FilterBetaListInput {
	entries: readonly BratBetaEntry[];
	profile: Profile;
	policy: ProfilePolicy;
}

export function filterBratBetaList(input: FilterBetaListInput): BratBetaEntry[] {
	const out: BratBetaEntry[] = [];
	const seenRepos = new Set<string>();

	for (const entry of input.entries) {
		if (entry.repo === PROTECTED_BRAT_REPO) {
			if (!seenRepos.has(entry.repo)) {
				out.push(entry);
				seenRepos.add(entry.repo);
			}
			continue;
		}
		const manifest = entry.manifest ?? { id: entry.pluginId, version: "0.0.0" };
		if (!input.policy.isPluginAllowedForProfile(entry.pluginId, manifest, input.profile)) continue;
		if (seenRepos.has(entry.repo)) continue;
		out.push(entry);
		seenRepos.add(entry.repo);
	}

	if (!seenRepos.has(PROTECTED_BRAT_REPO)) {
		// Always re-add the YAOS update channel even if it was missing.
		out.unshift({ repo: PROTECTED_BRAT_REPO, pluginId: "yaos" });
	}

	return out;
}
