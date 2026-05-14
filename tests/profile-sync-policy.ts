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
	assert(isBlobSyncable(".obsidian/workspace-mobile.json", [], configDir, publish), "workspace-mobile is uploadable in publish mode");
	assert(isBlobSyncable(".obsidian/plugins/yaos/main.js", [], configDir, publish), "YAOS main.js is uploadable in publish mode");
	assert(isBlobSyncable(".obsidian/plugins/dataview/main.js", [], configDir, publish), "approved plugin payload is uploadable in publish mode");
}

console.log("\n--- Test 3: subscribe mode downloads but does not upload profile files ---");
{
	assert(!isBlobSyncable(".obsidian/workspace-mobile.json", [], configDir, subscribeUpload), "subscribe mode blocks profile uploads");
	assert(isBlobSyncable(".obsidian/workspace-mobile.json", [], configDir, subscribeDownload), "subscribe mode allows profile downloads");
}

console.log("\n--- Test 4: sensitive and backup paths are always blocked ---");
{
	for (const path of [
		".obsidian/plugins/yaos/data.json",
		".obsidian/plugins/yaos/logs/today.log",
		".obsidian/plugins/yaos/diagnostics/report.json",
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
