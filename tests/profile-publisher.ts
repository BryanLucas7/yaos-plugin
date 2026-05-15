/**
 * Profile publisher tests (Etapa 5 — RED/GREEN cycles 5, 9, 15, 15.1).
 */

import {
	ProfilePublisher,
	type PublisherTransport,
} from "../src/profile/profilePublisher";
import {
	emptyProfileLock,
	type ProfileLock,
	type ProfileLockCasResult,
} from "../src/profile/profileLock";
import { createProfilePolicy } from "../src/profile/profilePolicy";
import {
	buildProfileManifest,
	synthesizeCommunityPluginsJson,
	type ScannedConfigDir,
} from "../src/profile/profileManifest";

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

function fakeHash(seed: string): string {
	const code = seed.charCodeAt(0).toString(16).padStart(2, "0");
	return code.repeat(32);
}

function makeScan(overrides: Partial<ScannedConfigDir> = {}): ScannedConfigDir {
	return {
		rootConfigFiles: [
			{ name: "app.json", hash: fakeHash("a"), size: 100 },
			{ name: "appearance.json", hash: fakeHash("b"), size: 50 },
			{ name: "core-plugins.json", hash: fakeHash("c"), size: 30 },
		],
		snippetFiles: [],
		themeFiles: [],
		iconFiles: [],
		plugins: [
			{
				pluginId: "dataview",
				manifest: { id: "dataview", version: "0.5.68", isDesktopOnly: false },
				codeFiles: [
					{ path: "plugins/dataview/main.js", hash: fakeHash("d"), size: 50000 },
					{ path: "plugins/dataview/manifest.json", hash: fakeHash("e"), size: 200 },
				],
				dataJson: { hash: fakeHash("f"), size: 300 },
				otherBehaviorFiles: [],
			},
			{
				pluginId: "agent-client",
				manifest: { id: "agent-client", version: "1.0.0", isDesktopOnly: false },
				codeFiles: [
					{ path: "plugins/agent-client/main.js", hash: fakeHash("1"), size: 1000 },
				],
				dataJson: { hash: fakeHash("2"), size: 50 },
				otherBehaviorFiles: [],
			},
			{
				pluginId: "yaos",
				manifest: { id: "yaos", version: "1.6.1", isDesktopOnly: false },
				codeFiles: [
					{ path: "plugins/yaos/main.js", hash: fakeHash("y"), size: 500000 },
				],
				dataJson: { hash: fakeHash("z"), size: 1000 },
				otherBehaviorFiles: [],
			},
		],
		rawCommunityPluginIds: ["dataview", "yaos", "agent-client"],
		...overrides,
	};
}

class InMemoryTransport implements PublisherTransport {
	storedLock: ProfileLock | null = null;
	uploads: unknown[] = [];
	rawUploads = 0;
	preStaleAttempts = 0;
	private staleTimes = 0;

	failNextNCasWithStale(n: number, current: ProfileLock | null): void {
		this.preStaleAttempts = n;
		this.staleOverride = current;
	}
	private staleOverride: ProfileLock | null = null;

	async getLock(): Promise<ProfileLock | null> {
		return this.storedLock;
	}
	async putLock(body: { baseGeneration: string; nextLock: ProfileLock }): Promise<ProfileLockCasResult> {
		if (this.staleTimes < this.preStaleAttempts) {
			this.staleTimes++;
			return { kind: "stale-base", current: this.staleOverride ?? emptyProfileLock() };
		}
		const currentGeneration = this.storedLock?.generation ?? "";
		if (body.baseGeneration !== currentGeneration) {
			return { kind: "stale-base", current: this.storedLock };
		}
		this.storedLock = body.nextLock;
		return { kind: "accepted", lock: body.nextLock };
	}
	async uploadJsonBlob(value: unknown): Promise<string> {
		this.uploads.push(value);
		const seed = JSON.stringify(value).length.toString(16);
		return seed.padStart(64, "0").slice(0, 64);
	}
	async existsBatch(): Promise<Set<string>> { return new Set(); }
	async uploadBlob(): Promise<void> { this.rawUploads++; }
}

const policy = createProfilePolicy();

// ── Cycle 5 — plugin code shared, behavior per profile ───────────────────
console.log("\n--- Cycle 5: plugin code shared, behavior per profile ---");
{
	const scan = makeScan();
	const desktopManifest = buildProfileManifest({
		scan, profile: "desktop", policy,
		generation: "g1", baseGeneration: "", createdAt: "now", sourceDeviceId: "dev",
	});
	const mobileManifest = buildProfileManifest({
		scan, profile: "mobile", policy,
		generation: "g1", baseGeneration: "", createdAt: "now", sourceDeviceId: "dev",
	});

	assert(desktopManifest.files.some((f) => f.path === "plugins/dataview/data.json"),
		"desktop manifest contains dataview/data.json (behavior)");
	assert(mobileManifest.files.some((f) => f.path === "plugins/dataview/data.json"),
		"mobile manifest also contains dataview/data.json (per-profile behavior)");

	assert(!desktopManifest.files.some((f) => f.path === "plugins/dataview/main.js"),
		"manifest does NOT contain plugin code (main.js) — that lives in PluginCodeManifest");
	assert(!desktopManifest.files.some((f) => f.path.startsWith("plugins/yaos/")),
		"manifest never contains YAOS internals");
	assert(!desktopManifest.files.some((f) => f.path.startsWith("plugins/obsidian42-brat")),
		"manifest never contains BRAT internals");
}

// ── Cycle 9 — community-plugins.json synthesized per profile ─────────────
console.log("\n--- Cycle 9: community-plugins.json synthesized per profile ---");
{
	const scan = makeScan();

	const desktopList = synthesizeCommunityPluginsJson({
		scan, profile: "desktop", policy,
	});
	assert(desktopList.includes("yaos"), "desktop list keeps yaos as bootstrap");
	assert(desktopList.includes("lazy-plugins"), "desktop list keeps lazy-plugins");
	assert(desktopList.includes("dataview"), "desktop list keeps dataview");
	assert(desktopList.includes("agent-client"), "desktop list keeps agent-client (allowed on desktop)");

	const mobileList = synthesizeCommunityPluginsJson({
		scan, profile: "mobile", policy,
		instantPluginIdsForProfile: ["dataview", "agent-client", "homepage"],
	});

	assert(mobileList.includes("yaos") && mobileList.includes("obsidian42-brat") && mobileList.includes("lazy-plugins"),
		"mobile list keeps bootstrap (yaos, brat, lazy-plugins)");
	assert(mobileList.includes("dataview"),
		"mobile list keeps instant approved plugin (dataview)");
	assert(!mobileList.includes("agent-client"),
		"mobile list excludes agent-client even when listed instant by Lazy");

	const mobileShortList = synthesizeCommunityPluginsJson({
		scan, profile: "mobile", policy,
		instantPluginIdsForProfile: [],
	});
	assert(!mobileShortList.includes("dataview"),
		"short/long/disabled plugins NOT in community-plugins.json (Lazy loads them via enablePlugin())");
}

// ── Cycle 15 — desktop and mobile publishers are isolated ────────────────
console.log("\n--- Cycle 15: desktop and mobile publishers do not share state ---");
{
	const policyInst = createProfilePolicy();

	let counter = 0;
	const nextGen = (prev: string) => `g-${++counter}-from-${prev || "init"}`;
	const scanFn = async () => makeScan();

	const transportA = new InMemoryTransport();
	const transportB = new InMemoryTransport();

	const desktopPub = new ProfilePublisher({
		profile: "desktop", policy: policyInst, transport: transportA,
		trust: { canPublishProfile: true, canPublishPluginCode: true },
		deviceId: "pc-1", deviceName: "PC",
		now: () => "2026-05-15T00:00:00Z",
		nextGeneration: nextGen,
	});
	const mobilePub = new ProfilePublisher({
		profile: "mobile", policy: policyInst, transport: transportB,
		trust: { canPublishProfile: true, canPublishPluginCode: true },
		deviceId: "phone-1", deviceName: "Phone",
		now: () => "2026-05-15T00:00:00Z",
		nextGeneration: nextGen,
	});

	desktopPub.markDirty("app.json");
	mobilePub.markDirty("workspace-mobile.json");

	assert(desktopPub.hasDirtyPaths(), "desktop publisher has its own dirty");
	assert(mobilePub.hasDirtyPaths(), "mobile publisher has its own dirty");

	desktopPub.clearDirty();
	assert(!desktopPub.hasDirtyPaths(), "clearing desktop did not affect mobile");
	assert(mobilePub.hasDirtyPaths(), "mobile dirty preserved after desktop cleared");

	const result = await desktopPub.publish(scanFn);
	assert(result.kind === "accepted", "desktop publish accepted in isolation");
	assert(transportA.storedLock !== null, "desktop transport stored a lock");
	assert(transportB.storedLock === null, "mobile transport untouched by desktop publish");
}

// ── Cycle 15.1 — trust separates profile and plugin code ────────────────
console.log("\n--- Cycle 15.1: trust separates profile and plugin code ---");
{
	const policyInst = createProfilePolicy();
	const scanFn = async () => makeScan();
	let counter = 0;
	const nextGen = (prev: string) => `gn-${++counter}`;

	// Mobile publisher: profile only, NOT plugin code.
	const transport = new InMemoryTransport();
	const mobilePub = new ProfilePublisher({
		profile: "mobile", policy: policyInst, transport,
		trust: { canPublishProfile: true, canPublishPluginCode: false },
		deviceId: "phone-1", deviceName: "Phone",
		now: () => "now", nextGeneration: nextGen,
	});

	const result = await mobilePub.publish(scanFn);
	assert(result.kind === "accepted", "mobile profile-only publish accepted");
	if (result.kind === "accepted") {
		const lockedPlugins = Object.keys(result.lock.pluginLocks);
		assert(lockedPlugins.length === 0,
			"mobile publish without canPublishPluginCode did NOT touch pluginLocks");
		assert(!!result.lock.profileManifests.mobile,
			"mobile manifest reference present");
	}

	// Desktop publisher: code only, NOT profile.
	const transport2 = new InMemoryTransport();
	transport2.storedLock = {
		...emptyProfileLock("seed"),
		generation: "seed",
		profileManifests: {
			desktop: {
				profile: "desktop", kind: "real", manifestHash: "old".padEnd(64, "0").slice(0, 64),
				fileCount: 1, totalBytes: 1, createdAt: "old", sourceDeviceId: "old",
			},
		},
	};
	const codeOnlyPub = new ProfilePublisher({
		profile: "desktop", policy: policyInst, transport: transport2,
		trust: { canPublishProfile: false, canPublishPluginCode: true },
		deviceId: "pc-1", deviceName: "PC",
		now: () => "now", nextGeneration: nextGen,
	});
	const result2 = await codeOnlyPub.publish(scanFn);
	assert(result2.kind === "accepted", "code-only publish accepted");
	if (result2.kind === "accepted") {
		assert(Object.keys(result2.lock.pluginLocks).length > 0,
			"code-only publish populates pluginLocks");
		assert(result2.lock.profileManifests.desktop?.manifestHash === "old".padEnd(64, "0").slice(0, 64),
			"code-only publish PRESERVED existing desktop profile manifest reference");
	}
}

// ── Stale-base rebases automatically ─────────────────────────────────────
console.log("\n--- Bonus: stale-base triggers rebase + retry ---");
{
	const policyInst = createProfilePolicy();
	const scanFn = async () => makeScan();
	const transport = new InMemoryTransport();
	const remoteAdvanced: ProfileLock = { ...emptyProfileLock("remote-1"), generation: "remote-1" };
	transport.failNextNCasWithStale(1, remoteAdvanced);
	transport.storedLock = remoteAdvanced;

	let counter = 0;
	const pub = new ProfilePublisher({
		profile: "desktop", policy: policyInst, transport,
		trust: { canPublishProfile: true, canPublishPluginCode: true },
		deviceId: "pc-1", deviceName: "PC",
		now: () => "now", nextGeneration: (prev) => `g-${++counter}-${prev}`,
	});
	const outcome = await pub.publish(scanFn);
	assert(outcome.kind === "rebased-and-accepted", "publisher rebased and retried");
	if (outcome.kind === "rebased-and-accepted") {
		assert(outcome.rebases >= 1, "at least one rebase recorded");
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
