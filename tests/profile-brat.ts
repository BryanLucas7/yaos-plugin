/**
 * BRAT filter tests (Etapa 8 — RED/GREEN cycle 11).
 */

import {
	filterBratBetaList,
	PROTECTED_BRAT_REPO,
	type BratBetaEntry,
} from "../src/profile/bratFilter";
import { createProfilePolicy } from "../src/profile/profilePolicy";

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

const policy = createProfilePolicy();

const FIXTURE: BratBetaEntry[] = [
	{ repo: PROTECTED_BRAT_REPO, pluginId: "yaos" },
	{ repo: "blacksmithgu/obsidian-dataview", pluginId: "dataview", manifest: { id: "dataview", version: "0.5.68" } },
	{ repo: "obsidian-tasks-group/obsidian-tasks", pluginId: "obsidian-tasks-plugin", manifest: { id: "obsidian-tasks-plugin", version: "7.18.0" } },
	{ repo: "internal/agent-client", pluginId: "agent-client", manifest: { id: "agent-client", version: "1.0.0" } },
	{ repo: "internal/rich-text-editor", pluginId: "rich-text-editor", manifest: { id: "rich-text-editor", version: "1.0.0" } },
	{ repo: "Vinzent03/obsidian-shellcommands", pluginId: "obsidian-shellcommands", manifest: { id: "obsidian-shellcommands", version: "0.20.0", isDesktopOnly: true } },
];

console.log("\n--- Cycle 11: BRAT beta list filtered per profile, BRAT data.json never copied ---");
{
	const desktopList = filterBratBetaList({ entries: FIXTURE, profile: "desktop", policy });
	const ids = new Set(desktopList.map((e) => e.pluginId));

	assert(ids.has("yaos"), "BryanLucas7/yaos-plugin preserved on desktop");
	assert(ids.has("dataview"), "dataview preserved on desktop");
	assert(ids.has("obsidian-tasks-plugin"), "tasks preserved on desktop");
	assert(ids.has("agent-client"), "agent-client kept on desktop (not denied there)");
	assert(ids.has("obsidian-shellcommands"), "desktop-only plugin kept on desktop");

	const mobileList = filterBratBetaList({ entries: FIXTURE, profile: "mobile", policy });
	const mobileIds = new Set(mobileList.map((e) => e.pluginId));

	assert(mobileIds.has("yaos"), "BryanLucas7/yaos-plugin preserved on mobile");
	assert(mobileIds.has("dataview"), "dataview preserved on mobile");
	assert(!mobileIds.has("agent-client"), "agent-client EXCLUDED from mobile");
	assert(!mobileIds.has("rich-text-editor"), "rich-text-editor EXCLUDED from mobile");
	assert(!mobileIds.has("obsidian-shellcommands"), "desktop-only EXCLUDED from mobile");
}

console.log("\n--- BryanLucas7/yaos-plugin is preserved even when missing from input ---");
{
	const stripped = FIXTURE.filter((e) => e.repo !== PROTECTED_BRAT_REPO);
	const list = filterBratBetaList({ entries: stripped, profile: "mobile", policy });
	assert(list[0]?.repo === PROTECTED_BRAT_REPO,
		"BRAT update channel re-added at the front when missing");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
