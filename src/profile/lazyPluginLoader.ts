/**
 * Lazy Plugin Loader integration.
 *
 * Lazy stores its config in lazy-plugins/data.json with a structure that
 * supports per-profile overrides ("dualConfigs" with desktop / mobile
 * sections). The Profile Mirror needs two behaviours:
 *
 * 1. First time a mobile device pairs, clone the desktop config block to
 *    the mobile section so the mobile starts identical to the PC.
 * 2. After that initial clone, NEVER overwrite the mobile section
 *    automatically — the user may have ajusted timings, instant lists,
 *    etc. A user-triggered "Reset mobile Lazy from desktop" command
 *    re-clones manually.
 *
 * The transformation is pure: given the existing data.json contents and a
 * flag pair (initialCloneEnabled, alreadyInitialised) it returns the new
 * data.json contents plus a boolean indicating whether the
 * "lazyMobileInitialized" setting should now flip to true.
 */

export type PluginActivationMode = "instant" | "short" | "long" | "disabled";

export interface LazyProfileSection {
	plugins?: Record<string, PluginActivationMode>;
	shortDelaySeconds?: number;
	longDelaySeconds?: number;
	delayBetweenPlugins?: number;
}

export interface LazyData {
	dualConfigs?: boolean;
	desktop?: LazyProfileSection;
	mobile?: LazyProfileSection;
	[other: string]: unknown;
}

export interface CloneInput {
	current: LazyData | null;
	initialCloneEnabled: boolean;
	alreadyInitialised: boolean;
}

export interface CloneOutput {
	next: LazyData;
	didClone: boolean;
}

export function applyLazyDesktopToMobileClone(input: CloneInput): CloneOutput {
	const current = input.current ?? {};
	const next: LazyData = { ...current };
	if (!input.initialCloneEnabled) return { next, didClone: false };
	if (input.alreadyInitialised) return { next, didClone: false };
	if (!current.desktop) return { next, didClone: false };

	next.mobile = cloneSection(current.desktop);
	next.dualConfigs = true;
	return { next, didClone: true };
}

function cloneSection(section: LazyProfileSection): LazyProfileSection {
	return {
		plugins: section.plugins ? { ...section.plugins } : {},
		shortDelaySeconds: section.shortDelaySeconds,
		longDelaySeconds: section.longDelaySeconds,
		delayBetweenPlugins: section.delayBetweenPlugins,
	};
}

/**
 * Returns the plugin ids that should appear as `instant` for `profile`,
 * given the (possibly already-cloned) Lazy data. Used by the publisher
 * to synthesize community-plugins.json.
 */
export function getInstantPluginIdsFromLazy(
	data: LazyData | null,
	profile: "desktop" | "mobile",
): string[] {
	const section = data?.[profile];
	if (!section?.plugins) return [];
	return Object.entries(section.plugins)
		.filter(([, mode]) => mode === "instant")
		.map(([id]) => id);
}

/** Force-reset mobile back to whatever desktop currently looks like. */
export function resetMobileLazyFromDesktop(data: LazyData | null): LazyData {
	const next: LazyData = { ...(data ?? {}) };
	if (!data?.desktop) return next;
	next.mobile = cloneSection(data.desktop);
	next.dualConfigs = true;
	return next;
}
