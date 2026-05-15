/**
 * Lazy Plugin Loader integration tests (Etapa 7 — RED/GREEN cycles 7, 8).
 */

import {
	applyLazyDesktopToMobileClone,
	getInstantPluginIdsFromLazy,
	resetMobileLazyFromDesktop,
	type LazyData,
} from "../src/profile/lazyPluginLoader";

let passed = 0;
let failed = 0;

function assert(cond: unknown, name: string): void {
	if (cond) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

const DESKTOP_FIXTURE: LazyData["desktop"] = {
	plugins: {
		"yaos": "instant",
		"lazy-plugins": "instant",
		"homepage": "instant",
		"recent-files-obsidian": "instant",
		"folder-notes": "instant",
		"obsidian-style-settings": "instant",
		"templater-obsidian": "instant",
		"dataview": "instant",
		"obsidian-tasks-plugin": "instant",
		"obsidian-meta-bind-plugin": "instant",
		"buttons": "instant",
		"auto-note-mover": "instant",
		"table-editor-obsidian": "short",
		"obsidian42-brat": "short",
		"obsidian-icon-folder": "short",
		"obsidian-excalidraw-plugin": "short",
		"chronology": "short",
		"keep-the-rhythm": "short",
		"file-explorer-note-count": "short",
		"image-converter": "short",
		"obsidian-fullscreen-plugin": "short",
		"agent-client": "instant",       // user has this on desktop
		"rich-text-editor": "instant",   // user has this on desktop
	},
	shortDelaySeconds: 5,
	longDelaySeconds: 30,
	delayBetweenPlugins: 0.4,
};

// ── Cycle 7 — first pass clones desktop → mobile ────────────────────────
console.log("\n--- Cycle 7: lazyMobileInitialized=false → desktop is cloned to mobile ---");
{
	const result = applyLazyDesktopToMobileClone({
		current: { dualConfigs: false, desktop: DESKTOP_FIXTURE },
		initialCloneEnabled: true,
		alreadyInitialised: false,
	});

	assert(result.didClone, "clone reported as performed");
	assert(result.next.mobile !== undefined, "mobile section now exists");
	assert(result.next.mobile?.shortDelaySeconds === 5, "delays cloned (short)");
	assert(result.next.mobile?.longDelaySeconds === 30, "delays cloned (long)");
	assert(result.next.mobile?.delayBetweenPlugins === 0.4, "delays cloned (between)");
	assert(result.next.mobile?.plugins?.dataview === "instant", "dataview cloned as instant");
	assert(result.next.dualConfigs === true, "dualConfigs flipped on by clone");
}

// Inactive guards
console.log("\n--- Clone is a no-op when initialCloneEnabled is false ---");
{
	const result = applyLazyDesktopToMobileClone({
		current: { dualConfigs: false, desktop: DESKTOP_FIXTURE },
		initialCloneEnabled: false,
		alreadyInitialised: false,
	});
	assert(!result.didClone, "no clone when feature disabled");
	assert(result.next.mobile === undefined, "mobile remains untouched");
}

// ── Cycle 8 — second generation does NOT overwrite mobile ────────────────
console.log("\n--- Cycle 8: lazyMobileInitialized=true → mobile preserved ---");
{
	const mobileEdits = {
		plugins: { dataview: "short" as const, "obsidian-tasks-plugin": "instant" as const },
		shortDelaySeconds: 12,
	};
	const result = applyLazyDesktopToMobileClone({
		current: { dualConfigs: true, desktop: DESKTOP_FIXTURE, mobile: mobileEdits },
		initialCloneEnabled: true,
		alreadyInitialised: true,   // <-- already done
	});
	assert(!result.didClone, "no second clone after init flag set");
	assert(result.next.mobile?.plugins?.dataview === "short",
		"user's mobile override (dataview short) preserved");
	assert(result.next.mobile?.shortDelaySeconds === 12,
		"user's mobile override (delay 12s) preserved");
}

// Reset command re-clones explicitly
console.log("\n--- Manual reset re-clones desktop → mobile even after init ---");
{
	const reset = resetMobileLazyFromDesktop({
		desktop: DESKTOP_FIXTURE,
		mobile: { plugins: { dataview: "short" }, shortDelaySeconds: 12 },
		dualConfigs: true,
	});
	assert(reset.mobile?.plugins?.dataview === "instant",
		"manual reset overwrote mobile override back to desktop's instant");
	assert(reset.mobile?.shortDelaySeconds === 5,
		"manual reset restored desktop delay");
}

// Instant id helper feeds the publisher
console.log("\n--- getInstantPluginIdsFromLazy returns the live mobile section ---");
{
	const data: LazyData = {
		desktop: DESKTOP_FIXTURE,
		mobile: {
			plugins: {
				homepage: "instant",
				dataview: "short",
				"obsidian-tasks-plugin": "instant",
				"agent-client": "disabled",
				"rich-text-editor": "disabled",
			},
		},
	};
	const ids = getInstantPluginIdsFromLazy(data, "mobile");
	assert(ids.includes("homepage"), "homepage instant");
	assert(ids.includes("obsidian-tasks-plugin"), "obsidian-tasks-plugin instant");
	assert(!ids.includes("dataview"), "dataview short → NOT instant");
	assert(!ids.includes("agent-client"), "agent-client disabled → NOT instant");
	assert(!ids.includes("rich-text-editor"), "rich-text-editor disabled → NOT instant");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
