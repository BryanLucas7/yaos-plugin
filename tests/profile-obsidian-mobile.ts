/**
 * .obsidian-mobile preparation tests (Etapa 9 — RED/GREEN cycle 12).
 */

import {
	BOOTSTRAP_PLUGIN_DATA_SEEDS,
	FORBIDDEN_GLOBAL_KEYS,
	OBSIDIAN_MOBILE_DIR,
	planMobileFolderPreparation,
	type FsOp,
} from "../src/profile/obsidianMobileFolder";

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

console.log("\n--- Cycle 12: prepare .obsidian-mobile without touching global Obsidian config ---");
{
	const plan = planMobileFolderPreparation({
		currentDesktopFiles: ["plugins/yaos/data.json", "plugins/obsidian42-brat/data.json"],
		existingMobileFiles: [],
		yaosDataPresentInsideMobile: false,
	});

	const dirs = plan.filter((op) => op.kind === "ensureDir").map((op) => op.path);
	assert(dirs.includes(OBSIDIAN_MOBILE_DIR), ".obsidian-mobile directory ensured");
	assert(dirs.includes(".obsidian-mobile/plugins"), "plugins/ subdirectory ensured");
	for (const seed of BOOTSTRAP_PLUGIN_DATA_SEEDS) {
		assert(dirs.includes(`.obsidian-mobile/plugins/${seed.pluginId}`),
			`bootstrap plugin dir ${seed.pluginId} ensured`);
	}

	const writes = plan.filter((op): op is Extract<FsOp, { kind: "writeJson" }> => op.kind === "writeJson");
	assert(writes.some((w) => w.path === ".obsidian-mobile/plugins/yaos/data.json"),
		"yaos data.json seeded when missing");
	assert(writes.some((w) => w.path === ".obsidian-mobile/plugins/obsidian42-brat/data.json"),
		"BRAT data.json seeded when missing");

	const instruct = plan.find((op) => op.kind === "instruct-user");
	assert(instruct !== undefined, "user instruction emitted (manual Override config folder step)");
	if (instruct?.kind === "instruct-user") {
		assert(/Override config folder/i.test(instruct.message),
			"instruction mentions the Obsidian setting the user must flip");
	}

	// Tripwire: planner must NOT touch any global Obsidian key.
	for (const op of plan) {
		const path = "path" in op ? op.path : "";
		for (const forbidden of FORBIDDEN_GLOBAL_KEYS) {
			assert(!path.includes(forbidden),
				`op ${op.kind} did NOT touch forbidden global key ${forbidden}`);
		}
	}
}

console.log("\n--- YAOS data already present in .obsidian-mobile is preserved ---");
{
	const plan = planMobileFolderPreparation({
		currentDesktopFiles: [],
		existingMobileFiles: ["plugins/yaos/data.json"],
		yaosDataPresentInsideMobile: true,
	});
	const writes = plan.filter((op) => op.kind === "writeJson").map((op) => "path" in op ? op.path : "");
	assert(!writes.includes(".obsidian-mobile/plugins/yaos/data.json"),
		"yaos data.json NOT overwritten when already present");
	const preserves = plan.filter((op) => op.kind === "preserve").map((op) => "path" in op ? op.path : "");
	assert(preserves.includes(".obsidian-mobile/plugins/yaos/data.json"),
		"yaos data.json explicitly marked preserved");
}

console.log("\n--- BRAT data already present is preserved too ---");
{
	const plan = planMobileFolderPreparation({
		currentDesktopFiles: [],
		existingMobileFiles: ["plugins/obsidian42-brat/data.json"],
		yaosDataPresentInsideMobile: false,
	});
	const writes = plan.filter((op) => op.kind === "writeJson").map((op) => "path" in op ? op.path : "");
	assert(!writes.includes(".obsidian-mobile/plugins/obsidian42-brat/data.json"),
		"BRAT data.json NOT overwritten when already present");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
