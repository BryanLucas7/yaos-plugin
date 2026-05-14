import { isBlobSyncable } from "../src/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

const configDir = ".obsidian";
const publish = {
	enabled: true,
	mode: "publish" as const,
	preset: "mobile" as const,
	direction: "upload" as const,
};
const subscribeUpload = {
	enabled: true,
	mode: "subscribe" as const,
	preset: "mobile" as const,
	direction: "upload" as const,
};
const subscribeDownload = {
	enabled: true,
	mode: "subscribe" as const,
	preset: "mobile" as const,
	direction: "download" as const,
};
const off = {
	enabled: false,
	mode: "off" as const,
	preset: "mobile" as const,
	direction: "upload" as const,
};

console.log("\n--- Test 1: profile sync stays off by default ---");
{
	assert(!isBlobSyncable(".obsidian/workspace-mobile.json", [], configDir), ".obsidian is blocked without profile policy");
	assert(!isBlobSyncable(".obsidian/workspace-mobile.json", [], configDir, off), ".obsidian is blocked when profile sync is off");
}

console.log("\n--- Test 2: publish mode can upload mobile profile files ---");
{
	assert(isBlobSyncable(".obsidian/appearance.json", [], configDir, publish), "appearance.json is uploadable in publish mode");
	assert(isBlobSyncable(".obsidian/graph.json", [], configDir, publish), "graph.json is uploadable in publish mode");
	assert(isBlobSyncable(".obsidian/snippets/mobile.css", [], configDir, publish), "snippets are uploadable in publish mode");
	assert(isBlobSyncable(".obsidian/themes/FastPpuccin/theme.css", [], configDir, publish), "themes are uploadable in publish mode");
}

console.log("\n--- Test 3: subscribe mode downloads but does not upload profile files ---");
{
	assert(!isBlobSyncable(".obsidian/appearance.json", [], configDir, subscribeUpload), "subscribe mode blocks profile uploads");
	assert(isBlobSyncable(".obsidian/appearance.json", [], configDir, subscribeDownload), "subscribe mode allows profile downloads");
}

console.log("\n--- Test 4: live plugin, workspace, activation, and backup paths are always blocked ---");
{
	for (const path of [
		".obsidian/community-plugins.json",
		".obsidian/workspace-mobile.json",
		".obsidian/workspaces.json",
		".obsidian/plugins/yaos/main.js",
		".obsidian/plugins/yaos/manifest.json",
		".obsidian/plugins/yaos/styles.css",
		".obsidian/plugins/yaos/data.json",
		".obsidian/plugins/yaos/logs/today.log",
		".obsidian/plugins/yaos/diagnostics/report.json",
		".obsidian/plugins/dataview/main.js",
		".obsidian/plugins/obsidian42-brat/data.json",
		".obsidian/plugins/agent-client/main.js",
		".obsidian/plugins/rich-text-editor/main.js",
		".obsidian/workspace-mobile.before-clear.json",
		".obsidian/workspace-mobile (conflict 2026-05-09).json",
	]) {
		assert(!isBlobSyncable(path, [], configDir, publish), `${path} is blocked`);
		assert(!isBlobSyncable(path, [], configDir, subscribeDownload), `${path} is not downloaded`);
	}
}

console.log("\n--- Test 5: normal vault files keep original sync behavior ---");
{
	assert(isBlobSyncable("Anexos/file.pdf", [], configDir, off), "normal attachments still sync when profile sync is off");
	assert(!isBlobSyncable("Anexos/file.md", [], configDir, publish), "markdown remains outside blob sync");
	assert(!isBlobSyncable(".trash/file.pdf", [], configDir, publish), ".trash remains blocked");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
