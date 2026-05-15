/**
 * Profile policy tests (Etapa 2, RED/GREEN cycles 1-3).
 *
 * Cycle 1 — Policy bloqueia arquivos perigosos.
 * Cycle 2 — Policy permite plugin mobile-safe aprovado.
 * Cycle 3 — Desktop-only nao entra no mobile.
 */

import {
	createProfilePolicy,
	type PluginManifestLike,
} from "../src/profile/profilePolicy";

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

function manifest(overrides: Partial<PluginManifestLike> = {}): PluginManifestLike {
	return {
		id: overrides.id ?? "dataview",
		version: overrides.version ?? "0.5.68",
		isDesktopOnly: overrides.isDesktopOnly,
		...overrides,
	};
}

const policy = createProfilePolicy();

// ── Cycle 1 — denylist blocks dangerous paths ───────────────────────────
console.log("\n--- Cycle 1: denylist blocks dangerous paths ---");
{
	assert(!policy.isPathAllowedForProfile("plugins/yaos/data.json", "desktop"),
		"plugins/yaos/data.json blocked on desktop");
	assert(!policy.isPathAllowedForProfile("plugins/yaos/data.json", "mobile"),
		"plugins/yaos/data.json blocked on mobile");
	assert(!policy.isPathAllowedForProfile("plugins/obsidian42-brat/data.json", "desktop"),
		"plugins/obsidian42-brat/data.json blocked on desktop");
	assert(!policy.isPathAllowedForProfile("plugins/obsidian42-brat/main.js", "mobile"),
		"plugins/obsidian42-brat/main.js blocked on mobile");
	assert(!policy.isPathAllowedForProfile("plugins/agent-client/main.js", "mobile"),
		"plugins/agent-client/main.js blocked on mobile");
	assert(!policy.isPathAllowedForProfile("plugins/rich-text-editor/data.json", "mobile"),
		"plugins/rich-text-editor/data.json blocked on mobile");

	assert(!policy.isPathAllowedForProfile("logs/error.log", "desktop"),
		"logs/* blocked");
	assert(!policy.isPathAllowedForProfile("cache/blob/aa", "desktop"),
		"cache/* blocked");
	assert(!policy.isPathAllowedForProfile("diagnostics/bundle.json", "desktop"),
		"diagnostics/* blocked");
	assert(!policy.isPathAllowedForProfile("sessions/abc", "desktop"),
		"sessions/* blocked");
	assert(!policy.isPathAllowedForProfile("restore/old", "desktop"),
		"restore/* blocked");
	assert(!policy.isPathAllowedForProfile("restore-backups/x", "desktop"),
		"restore-backups/* blocked");
	assert(!policy.isPathAllowedForProfile("backup/x", "desktop"),
		"backup/* blocked");
	assert(!policy.isPathAllowedForProfile("flight-logs/x", "desktop"),
		"flight-logs/* blocked");

	assert(!policy.isPathAllowedForProfile("notes/conflict-1.md", "desktop"),
		"any path containing 'conflict' blocked");
	assert(!policy.isPathAllowedForProfile("themes/before-revert/x.css", "desktop"),
		"any path containing 'before' blocked");
	assert(!policy.isPathAllowedForProfile("plugins/x/broken.js", "desktop"),
		"any path containing 'broken' blocked");
	assert(!policy.isPathAllowedForProfile("plugins/x/restore.js", "desktop"),
		"any path containing 'restore' blocked");
	assert(!policy.isPathAllowedForProfile("plugins/x/backup.json", "desktop"),
		"any path containing 'backup' blocked");

	assert(!policy.isPathAllowedForProfile("../escape.json", "desktop"),
		"path-traversal blocked");
	assert(!policy.isPathAllowedForProfile("plugins/x/../escape", "desktop"),
		"embedded path-traversal blocked");
	assert(!policy.isPathAllowedForProfile("/abs/path", "desktop"),
		"absolute path blocked");
	assert(!policy.isPathAllowedForProfile("C:\\abs", "desktop"),
		"windows absolute path blocked");
	assert(!policy.isPathAllowedForProfile("", "desktop"),
		"empty path blocked");

	assert(!policy.isPluginAllowedForProfile("yaos", manifest({ id: "yaos" }), "desktop"),
		"yaos plugin id never allowed");
	assert(!policy.isPluginAllowedForProfile("obsidian42-brat", manifest({ id: "obsidian42-brat" }), "desktop"),
		"obsidian42-brat plugin id never allowed");
}

// ── Cycle 2 — approved mobile-safe plugin is accepted ───────────────────
console.log("\n--- Cycle 2: approved mobile-safe plugin is accepted ---");
{
	const dataview = manifest({ id: "dataview", isDesktopOnly: false });
	assert(policy.isPluginAllowedForProfile("dataview", dataview, "desktop"),
		"dataview accepted on desktop");
	assert(policy.isPluginAllowedForProfile("dataview", dataview, "mobile"),
		"dataview accepted on mobile (not desktop-only, not denylisted)");

	assert(policy.isPathAllowedForProfile("plugins/dataview/main.js", "mobile"),
		"dataview/main.js path allowed on mobile");
	assert(policy.isPathAllowedForProfile("plugins/dataview/manifest.json", "mobile"),
		"dataview/manifest.json path allowed on mobile");
	assert(policy.isPathAllowedForProfile("plugins/dataview/data.json", "mobile"),
		"dataview/data.json path allowed on mobile");

	assert(policy.isAllowedRootConfigFile("app.json"), "app.json allowed");
	assert(policy.isAllowedRootConfigFile("appearance.json"), "appearance.json allowed");
	assert(policy.isAllowedRootConfigFile("core-plugins.json"), "core-plugins.json allowed");
	assert(policy.isAllowedRootConfigFile("daily-notes.json"), "daily-notes.json allowed");
	assert(policy.isAllowedRootConfigFile("graph.json"), "graph.json allowed");
	assert(policy.isAllowedRootConfigFile("hotkeys.json"), "hotkeys.json allowed");
	assert(policy.isAllowedRootConfigFile("types.json"), "types.json allowed");
	assert(policy.isAllowedRootConfigFile("webviewer.json"), "webviewer.json allowed");
	assert(policy.isAllowedRootConfigFile("workspace.json"), "workspace.json allowed");
	assert(policy.isAllowedRootConfigFile("workspace-mobile.json"), "workspace-mobile.json allowed");
	assert(policy.isAllowedRootConfigFile("workspaces.json"), "workspaces.json allowed");

	assert(!policy.isAllowedRootConfigFile("community-plugins.json"),
		"community-plugins.json is synthesized, NOT bulk-copied");
	assert(!policy.isAllowedRootConfigFile("random.json"),
		"random root file rejected");

	assert(policy.isPathAllowedForProfile("snippets/my-snippet.css", "mobile"),
		"snippets/* allowed");
	assert(policy.isPathAllowedForProfile("themes/Minimal/manifest.json", "mobile"),
		"themes/* allowed");
	assert(policy.isPathAllowedForProfile("icons/custom.svg", "mobile"),
		"icons/* allowed");
}

// ── Cycle 3 — desktop-only excluded from mobile ─────────────────────────
console.log("\n--- Cycle 3: desktop-only excluded from mobile ---");
{
	const desktopOnlyPlugin = manifest({ id: "obsidian-shellcommands", isDesktopOnly: true });
	assert(policy.isPluginAllowedForProfile("obsidian-shellcommands", desktopOnlyPlugin, "desktop"),
		"desktop-only plugin allowed on desktop");
	assert(!policy.isPluginAllowedForProfile("obsidian-shellcommands", desktopOnlyPlugin, "mobile"),
		"desktop-only plugin EXCLUDED from mobile");

	const mobileSafe = manifest({ id: "dataview", isDesktopOnly: false });
	assert(policy.isPluginAllowedForProfile("dataview", mobileSafe, "mobile"),
		"isDesktopOnly false stays accepted on mobile");

	const omitted = manifest({ id: "templater-obsidian" });
	assert(policy.isPluginAllowedForProfile("templater-obsidian", omitted, "mobile"),
		"isDesktopOnly missing treated as false (mobile-safe)");

	assert(!policy.isPluginAllowedForProfile("agent-client",
		manifest({ id: "agent-client", isDesktopOnly: false }), "mobile"),
		"agent-client never allowed on mobile even with isDesktopOnly=false");
	assert(!policy.isPluginAllowedForProfile("rich-text-editor",
		manifest({ id: "rich-text-editor", isDesktopOnly: false }), "mobile"),
		"rich-text-editor never allowed on mobile");
	assert(policy.isPluginAllowedForProfile("agent-client",
		manifest({ id: "agent-client" }), "desktop"),
		"agent-client still allowed on desktop");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
