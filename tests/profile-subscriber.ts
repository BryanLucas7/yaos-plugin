/**
 * Profile subscriber tests (Etapa 6 — RED/GREEN cycles 6, 13, 14, 14.1).
 *
 * Cycle 10 (community-plugins.json shape) is exercised via Etapa 5 already.
 */

import {
	ProfileSubscriber,
	type SubscriberFs,
	type SubscriberStateStore,
	type SubscriberTransport,
	type SubscriberRuntime,
} from "../src/profile/profileSubscriber";
import {
	type ProfileLock,
	type ProfileManifest,
	type PluginCodeManifest,
} from "../src/profile/profileLock";
import { sha256Hex } from "../src/profile/profileTransport";

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

class MemoryFs implements SubscriberFs {
	private liveBytes = new Map<string, Uint8Array>();
	stageWrites: string[] = [];
	liveWrites: string[] = [];
	deletes: string[] = [];

	seedLive(path: string, bytes: Uint8Array): void {
		this.liveBytes.set(path, bytes);
	}
	getLive(path: string): Uint8Array | undefined {
		return this.liveBytes.get(path);
	}
	async hashOf(path: string): Promise<string | null> {
		const bytes = this.liveBytes.get(path);
		if (!bytes) return null;
		return sha256Hex(bytes);
	}
	async writeStaging(path: string, _bytes: Uint8Array): Promise<void> {
		this.stageWrites.push(path);
	}
	async writeLive(path: string, bytes: Uint8Array): Promise<void> {
		this.liveBytes.set(path, bytes);
		this.liveWrites.push(path);
	}
	async listLiveUnder(prefix: string): Promise<string[]> {
		return [...this.liveBytes.keys()].filter((p) => p === prefix || p.startsWith(prefix + "/"));
	}
	async deleteLive(path: string): Promise<void> {
		this.liveBytes.delete(path);
		this.deletes.push(path);
	}
}

class MemoryState implements SubscriberStateStore {
	private appliedGen: string | null = null;
	private pendingIds: string[] = [];
	setAppliedHistory: string[] = [];

	async getLastAppliedGeneration(): Promise<string | null> { return this.appliedGen; }
	async setLastAppliedGeneration(generation: string): Promise<void> {
		this.appliedGen = generation;
		this.setAppliedHistory.push(generation);
	}
	async getPendingPluginRestartIds(): Promise<string[]> { return [...this.pendingIds]; }
	async setPendingPluginRestartIds(ids: string[]): Promise<void> { this.pendingIds = [...ids]; }
}

class MemoryTransport implements SubscriberTransport {
	blobs = new Map<string, Uint8Array>();
	jsons = new Map<string, unknown>();
	downloadFailNextN = 0;

	async downloadBlob(hash: string): Promise<Uint8Array> {
		if (this.downloadFailNextN > 0) {
			this.downloadFailNextN--;
			throw new Error("simulated download crash");
		}
		const got = this.blobs.get(hash);
		if (!got) throw new Error(`missing blob ${hash}`);
		return got;
	}
	async downloadJsonBlob<T>(hash: string): Promise<T> {
		const got = this.jsons.get(hash);
		if (!got) throw new Error(`missing json ${hash}`);
		return got as T;
	}
}

const runtime = (active: ReadonlySet<string>): SubscriberRuntime => ({
	isPluginActive: (id) => active.has(id),
});

async function bytesOf(s: string): Promise<{ bytes: Uint8Array; hash: string; size: number }> {
	const bytes = new TextEncoder().encode(s);
	return { bytes, hash: await sha256Hex(bytes), size: bytes.byteLength };
}

// Build a profile lock + manifest + plugin code over an in-memory transport.
async function setup(active: ReadonlySet<string> = new Set()) {
	const fs = new MemoryFs();
	const state = new MemoryState();
	const transport = new MemoryTransport();

	const app = await bytesOf("app.json contents v1");
	const dataviewData = await bytesOf("dataview data v1");
	const community = await bytesOf(JSON.stringify(["yaos", "obsidian42-brat", "lazy-plugins", "dataview"]));
	const dataviewMain = await bytesOf("// dataview main.js v1");
	const dataviewManifest = await bytesOf(JSON.stringify({ id: "dataview", version: "0.5.68" }));

	transport.blobs.set(app.hash, app.bytes);
	transport.blobs.set(dataviewData.hash, dataviewData.bytes);
	transport.blobs.set(community.hash, community.bytes);
	transport.blobs.set(dataviewMain.hash, dataviewMain.bytes);
	transport.blobs.set(dataviewManifest.hash, dataviewManifest.bytes);

	const profileManifest: ProfileManifest = {
		version: 1,
		profile: "mobile",
		generation: "g-1",
		baseGeneration: "",
		createdAt: "now",
		sourceDeviceId: "pc-1",
		files: [
			{ path: "app.json", hash: app.hash, size: app.size, kind: "config", applyPhase: "safe-now" },
			{ path: "plugins/dataview/data.json", hash: dataviewData.hash, size: dataviewData.size, kind: "plugin-behavior", pluginId: "dataview", applyPhase: "safe-now" },
			{ path: "community-plugins.json", hash: community.hash, size: community.size, kind: "config", applyPhase: "activation-last" },
		],
	};

	const codeManifest: PluginCodeManifest = {
		version: 1,
		pluginId: "dataview",
		pluginVersion: "0.5.68",
		generation: "g-1",
		createdAt: "now",
		sourceDeviceId: "pc-1",
		files: [
			{ path: "plugins/dataview/main.js", hash: dataviewMain.hash, size: dataviewMain.size, applyPhase: "plugin-code" },
			{ path: "plugins/dataview/manifest.json", hash: dataviewManifest.hash, size: dataviewManifest.size, applyPhase: "plugin-code" },
		],
	};

	const profileManifestHash = "p".repeat(64);
	const codeManifestHash = "c".repeat(64);
	transport.jsons.set(profileManifestHash, profileManifest);
	transport.jsons.set(codeManifestHash, codeManifest);

	const lock: ProfileLock = {
		version: 1,
		generation: "g-1",
		previousGeneration: "",
		publishedAt: "now",
		publishedByDeviceId: "pc-1",
		publishedByDeviceName: "PC",
		baseGeneration: "",
		profileManifests: {
			mobile: {
				profile: "mobile", kind: "real",
				manifestHash: profileManifestHash,
				fileCount: profileManifest.files.length,
				totalBytes: profileManifest.files.reduce((s, f) => s + f.size, 0),
				createdAt: "now", sourceDeviceId: "pc-1",
			},
		},
		pluginLocks: {
			dataview: {
				pluginId: "dataview", version: "0.5.68",
				isDesktopOnly: false,
				allowedProfiles: ["desktop", "mobile"],
				codeManifestHash,
				fileCount: codeManifest.files.length,
				totalBytes: codeManifest.files.reduce((s, f) => s + f.size, 0),
				updatedAt: "now", sourceDeviceId: "pc-1",
			},
		},
	};

	const subscriber = new ProfileSubscriber({
		profile: "mobile",
		fs, state, transport,
		runtime: runtime(active),
	});

	return { subscriber, fs, state, transport, lock, profileManifest, codeManifest };
}

// ── Cycle 13 — apply order: community is last, plugin code defers ───────
console.log("\n--- Cycle 13: community-plugins.json is the last write ---");
{
	const { subscriber, fs, lock } = await setup(new Set(["dataview"]));
	const out = await subscriber.applyLock(lock);

	assert(out.appliedFiles.length > 0, "some files were applied");
	const lastWrite = fs.liveWrites[fs.liveWrites.length - 1];
	assert(lastWrite === "community-plugins.json",
		`community-plugins.json must be the last live write (was ${lastWrite})`);
}

// ── Cycle 6 — subscriber applies plugin code without breaking apply order ────
console.log("\n--- Cycle 6: applying without touching live plugin code mid-session ---");
{
	const { subscriber, fs, lock } = await setup(new Set(["dataview"]));
	const out = await subscriber.applyLock(lock);

	assert(out.deferredPluginIds.includes("dataview"),
		"active dataview plugin code deferred to next-startup (no live overwrite)");
	assert(!fs.liveWrites.includes("plugins/dataview/main.js"),
		"main.js NOT written live while dataview is active");
	assert(fs.liveWrites.includes("plugins/dataview/data.json"),
		"data.json (plugin BEHAVIOR) IS written live — it is per-profile");
}

console.log("\n--- Inactive plugin: code applied immediately ---");
{
	const { subscriber, fs, lock } = await setup(new Set()); // dataview NOT active
	const out = await subscriber.applyLock(lock);

	assert(!out.deferredPluginIds.includes("dataview"),
		"inactive dataview plugin code NOT deferred");
	assert(fs.liveWrites.includes("plugins/dataview/main.js"),
		"main.js written live because plugin is inactive");
}

// ── Cycle 14 — subscriber does not crash bootstrap (active deferred) ─────
console.log("\n--- Cycle 14: active plugin code deferral keeps onload safe ---");
{
	const { subscriber, state, lock } = await setup(new Set(["dataview"]));
	await subscriber.applyLock(lock);
	const pending = await state.getPendingPluginRestartIds();
	assert(pending.includes("dataview"),
		"pending plugin restart status surfaced (status bar would read this)");
}

// ── Cycle 14.1 — partial apply is recoverable + idempotent ───────────────
console.log("\n--- Cycle 14.1: crash mid-apply leaves lastAppliedGeneration unchanged ---");
{
	const ctx = await setup(new Set());
	const communityHash = ctx.profileManifest.files.find((f) => f.path === "community-plugins.json")!.hash;
	const original = ctx.transport.downloadBlob.bind(ctx.transport);
	// Allow the staging phase (which downloads each file once) to finish for
	// every file. Then make the LATE re-download for community fail, so the
	// crash happens during APPLY not during STAGE.
	const callsByHash = new Map<string, number>();
	ctx.transport.downloadBlob = async (hash: string) => {
		const n = (callsByHash.get(hash) ?? 0) + 1;
		callsByHash.set(hash, n);
		if (hash === communityHash && n >= 2) {
			throw new Error("simulated mid-apply crash");
		}
		return original(hash);
	};

	let crashed = false;
	try {
		await ctx.subscriber.applyLock(ctx.lock);
	} catch {
		crashed = true;
	}
	assert(crashed, "applyLock surfaced the mid-apply failure");
	const applied = await ctx.state.getLastAppliedGeneration();
	assert(applied === null,
		"lastAppliedGeneration was NOT advanced on partial failure");
	assert(ctx.fs.liveWrites.includes("app.json"),
		"app.json was applied live before the crash (proves crash happened mid-apply)");
	assert(!ctx.fs.liveWrites.includes("community-plugins.json"),
		"community-plugins.json was NOT yet written when the crash happened");

	// Recovery on next boot: same transport (community ok), retry — already-correct files skipped.
	ctx.transport.downloadBlob = original;
	const retry = await ctx.subscriber.applyLock(ctx.lock);
	assert(retry.community.wrote, "community-plugins.json finally written on recovery");
	const finalApplied = await ctx.state.getLastAppliedGeneration();
	assert(finalApplied === "g-1",
		"lastAppliedGeneration advanced to g-1 only after the full apply finished");
	assert(retry.skippedFiles.includes("app.json"),
		"files already applied on first attempt are skipped (idempotent)");
}

// ── Bootstrap protection — YAOS data is NEVER overwritten ────────────────
console.log("\n--- Bootstrap protection: YAOS/BRAT data files never overwritten ---");
{
	const { subscriber, fs, transport, lock, profileManifest } = await setup(new Set());
	const evil = await bytesOf("malicious yaos data");
	transport.blobs.set(evil.hash, evil.bytes);
	profileManifest.files.push({
		path: "plugins/yaos/data.json",
		hash: evil.hash, size: evil.size,
		kind: "plugin-behavior", pluginId: "yaos",
		applyPhase: "safe-now",
	});
	transport.jsons.set(lock.profileManifests.mobile!.manifestHash, profileManifest);

	fs.seedLive("plugins/yaos/data.json", new TextEncoder().encode("real yaos data"));
	await subscriber.applyLock(lock);

	const live = fs.getLive("plugins/yaos/data.json");
	assert(live !== undefined && new TextDecoder().decode(live) === "real yaos data",
		"YAOS data preserved despite hostile manifest entry");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
