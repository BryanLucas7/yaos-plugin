/**
 * Profile transport + GC tests (Etapa 4, RED/GREEN cycles 16, 17 + integrity).
 */

import {
	canonicalJson,
	canonicalJsonBytes,
	isValidHash,
	sha256Hex,
} from "../src/profile/profileTransport";
import {
	computeRetainedHashes,
	isBootstrapProtected,
	planLocalGc,
} from "../src/profile/profileGarbageCollector";
import type {
	PluginCodeManifest,
	ProfileLock,
	ProfileManifest,
} from "../src/profile/profileLock";

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

function makeLock(refsByProfile: Record<string, string>, pluginCodes: Record<string, string>): ProfileLock {
	return {
		version: 1,
		generation: "g",
		previousGeneration: "",
		publishedAt: "",
		publishedByDeviceId: "",
		publishedByDeviceName: "",
		baseGeneration: "",
		pluginLocks: Object.fromEntries(Object.entries(pluginCodes).map(([id, hash]) => [id, {
			pluginId: id,
			version: "1.0",
			isDesktopOnly: false,
			allowedProfiles: ["desktop", "mobile"] as const,
			codeManifestHash: hash,
			fileCount: 1,
			totalBytes: 1,
			updatedAt: "",
			sourceDeviceId: "",
		}])),
		profileManifests: Object.fromEntries(Object.entries(refsByProfile).map(([profile, hash]) => [profile, {
			profile: profile as "desktop" | "mobile",
			kind: "real" as const,
			manifestHash: hash,
			fileCount: 1,
			totalBytes: 1,
			createdAt: "",
			sourceDeviceId: "",
		}])),
	};
}

function makeProfileManifest(profile: "desktop" | "mobile", hashes: string[]): ProfileManifest {
	return {
		version: 1,
		profile,
		generation: "g",
		baseGeneration: "",
		createdAt: "",
		sourceDeviceId: "",
		files: hashes.map((h) => ({
			path: `dummy/${h.slice(0, 6)}.json`,
			hash: h,
			size: 1,
			kind: "config" as const,
			applyPhase: "safe-now" as const,
		})),
	};
}

function makeCodeManifest(pluginId: string, hashes: string[]): PluginCodeManifest {
	return {
		version: 1,
		pluginId,
		pluginVersion: "1.0",
		generation: "g",
		createdAt: "",
		sourceDeviceId: "",
		files: hashes.map((h) => ({
			path: `plugins/${pluginId}/${h.slice(0, 6)}.js`,
			hash: h,
			size: 1,
			applyPhase: "plugin-code" as const,
		})),
	};
}

function fakeHash(seed: string): string {
	const c = (seed.charCodeAt(0) % 16).toString(16);
	return c.repeat(64);
}

// ── Transport: canonical JSON, hash, validation ─────────────────────────
console.log("\n--- Transport: canonical JSON + hash invariants ---");
{
	assert(canonicalJson({ b: 2, a: 1 }) === '{"a":1,"b":2}', "keys are sorted");
	assert(canonicalJson({ a: { y: 2, x: 1 } }) === '{"a":{"x":1,"y":2}}', "sorting is recursive");
	assert(canonicalJson([3, 1, 2]) === "[3,1,2]", "array order preserved");
	assert(canonicalJson({ a: undefined, b: 1 }) === '{"b":1}', "undefined keys dropped");

	const a = canonicalJsonBytes({ generation: "g1", version: 1 });
	const b = canonicalJsonBytes({ version: 1, generation: "g1" });
	const ah = await sha256Hex(a);
	const bh = await sha256Hex(b);
	assert(ah === bh, "key order does not affect hash");
	assert(isValidHash(ah), "sha256Hex returns valid hash format");

	assert(!isValidHash("zz"), "isValidHash rejects junk");
	assert(!isValidHash("A".repeat(64)), "isValidHash rejects uppercase");
}

// ── Cycle 16 — local GC removes lixo without removing referenced data ───
console.log("\n--- Cycle 16: local GC keeps current+last N, prunes the rest ---");
{
	const hCurrentManifest = fakeHash("a");
	const hCurrentCode = fakeHash("b");
	const hOldManifest = fakeHash("c");
	const hOldCode = fakeHash("d");
	const hOrphan1 = fakeHash("e");
	const hOrphan2 = fakeHash("f");
	const hOrphanInsideYaos = fakeHash("9");
	const hUnresolved = fakeHash("8");

	const currentLock = makeLock({ mobile: hCurrentManifest }, { dataview: hCurrentCode });
	const oldLock = makeLock({ mobile: hOldManifest }, { dataview: hOldCode });
	const currentManifest = makeProfileManifest("mobile", [hCurrentManifest]);
	const oldManifest = makeProfileManifest("mobile", [hOldManifest]);
	const currentCodeManifest = makeCodeManifest("dataview", [hCurrentCode]);
	const oldCodeManifest = makeCodeManifest("dataview", [hOldCode]);

	const retained = computeRetainedHashes({
		locks: [currentLock, oldLock],
		profileManifests: [currentManifest, oldManifest],
		pluginCodeManifests: [currentCodeManifest, oldCodeManifest],
		preservedUnresolvedHashes: [hUnresolved],
	});

	assert(retained.has(hCurrentManifest), "current manifest hash retained");
	assert(retained.has(hCurrentCode), "current plugin code hash retained");
	assert(retained.has(hOldManifest), "previous manifest hash retained (within window)");
	assert(retained.has(hOldCode), "previous plugin code hash retained");
	assert(retained.has(hUnresolved), "preserved-unresolved hash retained");
	assert(!retained.has(hOrphan1), "orphan hash not retained");

	const cachedPaths = new Map<string, string>([
		[hOrphanInsideYaos, "plugins/yaos/staging/old.js"],
	]);
	const report = planLocalGc({
		cachedHashes: [
			hCurrentManifest, hCurrentCode, hOldManifest, hOldCode,
			hOrphan1, hOrphan2, hOrphanInsideYaos, hUnresolved,
		],
		cachedPathsByHash: cachedPaths,
		retained,
	});

	assert(report.deletedHashes.includes(hOrphan1), "orphan #1 scheduled for deletion");
	assert(report.deletedHashes.includes(hOrphan2), "orphan #2 scheduled for deletion");
	assert(!report.deletedHashes.includes(hCurrentManifest), "current manifest NOT deleted");
	assert(!report.deletedHashes.includes(hOldManifest), "old (still in window) manifest NOT deleted");
	assert(!report.deletedHashes.includes(hUnresolved), "unresolved blob NOT deleted");
	assert(!report.deletedHashes.includes(hOrphanInsideYaos),
		"YAOS-bootstrap path preserved even when unreferenced");
	assert(report.preservedBootstrapPaths.includes("plugins/yaos/staging/old.js"),
		"bootstrap preservation reported");
}

console.log("\n--- isBootstrapProtected covers the documented prefixes ---");
{
	assert(isBootstrapProtected("plugins/yaos/data.json"), "yaos protected");
	assert(isBootstrapProtected("plugins/yaos"), "exact match protected");
	assert(isBootstrapProtected("plugins/obsidian42-brat/data.json"), "BRAT protected");
	assert(!isBootstrapProtected("plugins/dataview/main.js"), "dataview NOT protected");
}

// ── Cycle 17 — remote GC computes referenced set ────────────────────────
console.log("\n--- Cycle 17: remote GC retains current + last N, prunes outside ---");
{
	const h = (n: number) => n.toString(16).padStart(64, "0");

	const lockN = makeLock({ desktop: h(1), mobile: h(2) }, { dataview: h(3) });
	const lockN1 = makeLock({ desktop: h(4), mobile: h(5) }, { dataview: h(6) });
	const lockN2 = makeLock({ desktop: h(7), mobile: h(8) }, { dataview: h(9) });

	const manifests = [
		makeProfileManifest("desktop", [h(10), h(11)]),
		makeProfileManifest("mobile", [h(12), h(13)]),
		makeProfileManifest("desktop", [h(14)]),
	];

	const codeManifests = [
		makeCodeManifest("dataview", [h(20), h(21)]),
		makeCodeManifest("dataview", [h(22)]),
	];

	const retained = computeRetainedHashes({
		locks: [lockN, lockN1, lockN2],
		profileManifests: manifests,
		pluginCodeManifests: codeManifests,
	});

	for (let i = 1; i <= 9; i++) {
		assert(retained.has(h(i)), `manifest/code reference h(${i}) retained`);
	}
	for (let i = 10; i <= 14; i++) {
		assert(retained.has(h(i)), `profile manifest file h(${i}) retained`);
	}
	for (let i = 20; i <= 22; i++) {
		assert(retained.has(h(i)), `plugin code file h(${i}) retained`);
	}

	const orphan = h(99);
	assert(!retained.has(orphan), "blob outside the retention window NOT retained");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
