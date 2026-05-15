/**
 * Profile lock CAS tests (Etapa 3, RED/GREEN cycles 4, 4.0, 4.0.1).
 *
 * Cycle 4   — publish with stale baseGeneration is rejected, current
 *             lock is returned, dirty set local is preserved (no write).
 * Cycle 4.0 — manifest completo NUNCA infla o Y.Doc / lock; apenas
 *             manifestHash + counters.
 * Cycle 4.0.1 — plugin code manifest NUNCA infla o lock; apenas
 *               codeManifestHash + counters.
 */

import {
	ProfileLockStore,
	type ProfileLockDTO,
	type ProfileLockStorageLike,
} from "../server/src/profileLockStore";

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

class FakeStorage implements ProfileLockStorageLike {
	private readonly data = new Map<string, unknown>();
	puts = 0;
	async get<T = unknown>(key: string): Promise<T | undefined> {
		return this.data.get(key) as T | undefined;
	}
	async put<T>(key: string, value: T): Promise<void> {
		this.puts++;
		this.data.set(key, value);
	}
}

function makeLock(overrides: Partial<ProfileLockDTO> = {}): ProfileLockDTO {
	return {
		version: 1,
		generation: "gen-1",
		previousGeneration: "",
		publishedAt: "2026-05-15T00:00:00.000Z",
		publishedByDeviceId: "device-pc-1",
		publishedByDeviceName: "PC",
		baseGeneration: "",
		pluginLocks: {},
		profileManifests: {},
		...overrides,
	};
}

// ── Cycle 4 — stale baseGeneration is rejected ──────────────────────────
console.log("\n--- Cycle 4: stale baseGeneration rejected, dirty preserved ---");
{
	const storage = new FakeStorage();
	const store = new ProfileLockStore(storage);

	// Initial publish from empty state.
	const accepted1 = await store.cas("", makeLock({ generation: "gen-1", baseGeneration: "" }));
	assert(accepted1.kind === "accepted", "initial publish accepted");
	assert(storage.puts === 1, "initial publish wrote storage exactly once");

	// Second publisher publishes ahead.
	const accepted2 = await store.cas("gen-1",
		makeLock({ generation: "gen-2", baseGeneration: "gen-1", publishedByDeviceId: "device-mobile-1", publishedByDeviceName: "Mobile" }));
	assert(accepted2.kind === "accepted", "second publish accepted at gen-1 base");
	assert(storage.puts === 2, "second publish wrote storage");

	// Third publisher tries with stale base (gen-1 is no longer current).
	const stale = await store.cas("gen-1",
		makeLock({ generation: "gen-3", baseGeneration: "gen-1" }));
	assert(stale.kind === "stale-base", "stale base rejected with stale-base");
	if (stale.kind === "stale-base") {
		assert(stale.current?.generation === "gen-2",
			"stale-base returns CURRENT remote (gen-2) so client can rebase");
	}
	assert(storage.puts === 2, "rejected publish DID NOT write storage (no data loss)");

	// Fourth attempt: same publisher rebases on gen-2 and retries.
	const retry = await store.cas("gen-2",
		makeLock({ generation: "gen-3", baseGeneration: "gen-2" }));
	assert(retry.kind === "accepted", "rebased publish accepted");
	assert(storage.puts === 3, "rebased publish wrote storage");
}

// ── Cycle 4.0 — manifest completo NÃO infla o lock ──────────────────────
console.log("\n--- Cycle 4.0: profile manifest stays as hash reference ---");
{
	const storage = new FakeStorage();
	const store = new ProfileLockStore(storage);

	const manifestHash = "a".repeat(64);
	const lock = makeLock({
		generation: "gen-1",
		baseGeneration: "",
		profileManifests: {
			mobile: {
				profile: "mobile",
				kind: "real",
				manifestHash,
				fileCount: 248,
				totalBytes: 12_500_000,
				createdAt: "2026-05-15T00:00:00.000Z",
				sourceDeviceId: "device-pc-1",
			},
		},
	});

	const result = await store.cas("", lock);
	assert(result.kind === "accepted", "manifest reference accepted");

	const stored = await store.read();
	const ref = stored?.profileManifests?.mobile;
	assert(!!ref, "mobile manifest ref present");
	assert(ref?.manifestHash === manifestHash, "manifest stored as hash, not file list");
	assert(ref?.fileCount === 248, "fileCount counter present");
	assert(ref?.totalBytes === 12_500_000, "totalBytes counter present");
	const refKeys = ref ? Object.keys(ref) : [];
	assert(!refKeys.includes("files"),
		"profile manifest ref has no `files` array — full list lives in blob JSON");
	const stringified = JSON.stringify(stored);
	assert(stringified.length < 2_000,
		`stored lock stays small even with 248-file manifest (was ${stringified.length} bytes)`);
}

// ── Cycle 4.0.1 — plugin code manifest NÃO infla o lock ─────────────────
console.log("\n--- Cycle 4.0.1: plugin code manifest stays as hash reference ---");
{
	const storage = new FakeStorage();
	const store = new ProfileLockStore(storage);

	const codeManifestHash = "b".repeat(64);
	const lock = makeLock({
		generation: "gen-1",
		baseGeneration: "",
		pluginLocks: {
			dataview: {
				pluginId: "dataview",
				version: "0.5.68",
				isDesktopOnly: false,
				allowedProfiles: ["desktop", "mobile"],
				codeManifestHash,
				fileCount: 47,
				totalBytes: 1_650_000,
				updatedAt: "2026-05-15T00:00:00.000Z",
				sourceDeviceId: "device-pc-1",
			},
		},
	});

	const result = await store.cas("", lock);
	assert(result.kind === "accepted", "plugin lock accepted");

	const stored = await store.read();
	const dataviewLock = stored?.pluginLocks.dataview;
	assert(!!dataviewLock, "dataview plugin lock present");
	assert(dataviewLock?.codeManifestHash === codeManifestHash,
		"plugin lock stores codeManifestHash, not file list");
	assert(dataviewLock?.fileCount === 47, "fileCount counter present");
	const lockKeys = dataviewLock ? Object.keys(dataviewLock) : [];
	assert(!lockKeys.includes("files"),
		"plugin lock has no `files` array — full list lives in PluginCodeManifest blob");
}

// ── Concurrency probe — two near-simultaneous CAS attempts serialize ────
console.log("\n--- Bonus: concurrent CAS requests serialize correctly ---");
{
	const storage = new FakeStorage();
	const store = new ProfileLockStore(storage);

	await store.cas("", makeLock({ generation: "gen-1", baseGeneration: "" }));

	const a = store.cas("gen-1", makeLock({ generation: "gen-A", baseGeneration: "gen-1", publishedByDeviceId: "A" }));
	const b = store.cas("gen-1", makeLock({ generation: "gen-B", baseGeneration: "gen-1", publishedByDeviceId: "B" }));
	const [resA, resB] = await Promise.all([a, b]);

	const winners = [resA, resB].filter((r) => r.kind === "accepted").length;
	const losers = [resA, resB].filter((r) => r.kind === "stale-base").length;
	assert(winners === 1, "exactly one publish wins under concurrency");
	assert(losers === 1, "exactly one publish gets stale-base under concurrency");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
