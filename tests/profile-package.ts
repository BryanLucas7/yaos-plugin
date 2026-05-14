import { strToU8 } from "fflate";
import {
	buildMobileBratDataJson,
	buildMobileCommunityPluginsJson,
	buildMobileLazyPluginDataJson,
	buildProfilePackageArchive,
	isProfilePackagePathAllowed,
	validateProfilePackageArchive,
} from "../src/profile/profilePackage";

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

async function assertRejects(fn: () => Promise<unknown>, msg: string) {
	try {
		await fn();
		assert(false, msg);
	} catch {
		assert(true, msg);
	}
}

console.log("\n--- Test 1: package allowlist includes mobile profile and approved plugins ---");
{
	for (const path of [
		".obsidian/community-plugins.json",
		".obsidian/workspace-mobile.json",
		".obsidian/workspaces.json",
		".obsidian/snippets/mobile.css",
		".obsidian/themes/Minimal/theme.css",
		".obsidian/icons/custom.json",
		".obsidian/plugins/dataview/main.js",
		".obsidian/plugins/dataview/data.json",
		".obsidian/plugins/obsidian-meta-bind-plugin/main.js",
		".obsidian/plugins/obsidian42-brat/data.json",
		".obsidian/plugins/obsidian-icon-folder/main.js",
	]) {
		assert(isProfilePackagePathAllowed(path), `${path} is allowed in profile package`);
	}
}

console.log("\n--- Test 2: package denylist blocks YAOS identity, unsafe plugins, and stale backups ---");
{
	for (const path of [
		".obsidian/plugins/yaos/data.json",
		".obsidian/plugins/yaos/main.js",
		".obsidian/plugins/yaos/manifest.json",
		".obsidian/plugins/agent-client/main.js",
		".obsidian/plugins/rich-text-editor/main.js",
		".obsidian/plugins/dataview/cache/index.json",
		".obsidian/plugins/dataview/logs/today.log",
		".obsidian/workspace-mobile.before-clear.json",
		".obsidian/workspace-mobile (conflict 2026-05-09).json",
		".obsidian/restore-backups/workspace.json",
		"../.obsidian/app.json",
	]) {
		assert(!isProfilePackagePathAllowed(path), `${path} is blocked in profile package`);
	}
}

console.log("\n--- Test 3: synthesized mobile plugin activation is filtered ---");
{
	const ids = JSON.parse(buildMobileCommunityPluginsJson(["dataview", "obsidian-meta-bind-plugin"])) as string[];
	assert(ids.includes("yaos"), "community plugin list keeps YAOS enabled");
	assert(ids.includes("dataview"), "community plugin list includes packaged approved plugin");
	assert(ids.includes("obsidian-meta-bind-plugin"), "community plugin list includes Meta Bind when packaged");
	assert(!ids.includes("agent-client"), "community plugin list excludes Agent Client");
	assert(!ids.includes("rich-text-editor"), "community plugin list excludes Rich Text Editor");
}

console.log("\n--- Test 4: Lazy Plugin Loader and BRAT configs are mobile-safe ---");
{
	const lazy = JSON.parse(buildMobileLazyPluginDataJson(JSON.stringify({
		mobile: {
			plugins: {
				"agent-client": { startupType: "instant" },
				"rich-text-editor": { startupType: "instant" },
			},
		},
	}))) as { mobile: { plugins: Record<string, { startupType: string }> } };
	assert(lazy.mobile.plugins.yaos?.startupType === "instant", "Lazy config keeps YAOS instant");
	assert(lazy.mobile.plugins.dataview?.startupType === "instant", "Lazy config keeps Dataview instant");
	assert(lazy.mobile.plugins["obsidian-excalidraw-plugin"]?.startupType === "short", "Lazy config delays Excalidraw");
	assert(!("agent-client" in lazy.mobile.plugins), "Lazy config removes Agent Client");
	assert(!("rich-text-editor" in lazy.mobile.plugins), "Lazy config removes Rich Text Editor");

	const brat = JSON.parse(buildMobileBratDataJson(JSON.stringify({
		pluginList: ["RAIT-09/obsidian-agent-client", "BryanLucas7/yaos-plugin"],
		updateAtStartup: true,
	}))) as { pluginList: string[]; updateAtStartup: boolean };
	assert(brat.pluginList.length === 1 && brat.pluginList[0] === "BryanLucas7/yaos-plugin", "BRAT config only tracks YAOS fork");
	assert(brat.updateAtStartup === false, "BRAT startup updates are disabled on mobile");
}

console.log("\n--- Test 5: archive validation catches hashes and unsafe paths ---");
{
	const pkg = await buildProfilePackageArchive([
		{ path: ".obsidian/app.json", data: strToU8("{}\n") },
		{ path: ".obsidian/plugins/dataview/main.js", data: strToU8("console.log('dv');\n") },
	], {
		generation: "test-generation",
		createdAt: "2026-05-14T00:00:00.000Z",
		deviceName: "test-pc",
	});
	const validated = await validateProfilePackageArchive(pkg.bytes, {
		expectedHash: pkg.hash,
		expectedManifestHash: pkg.manifestHash,
	});
	assert(validated.manifest.files.length === 2, "valid package passes manifest validation");
	await assertRejects(
		() => validateProfilePackageArchive(pkg.bytes, { expectedHash: "0".repeat(64) }),
		"archive validation rejects package hash mismatch",
	);
	await assertRejects(
		() => buildProfilePackageArchive([
			{ path: ".obsidian/plugins/yaos/data.json", data: strToU8("{}\n") },
		], {
			generation: "bad-generation",
			createdAt: "2026-05-14T00:00:00.000Z",
			deviceName: "test-pc",
		}),
		"archive builder rejects YAOS data.json",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
