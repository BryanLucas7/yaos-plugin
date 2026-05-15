/**
 * ProfileMirrorService tests (Etapa 10 — supports the UI-less wiring).
 *
 * These cover the state-machine behaviour that the settings tab and
 * commands rely on.
 */

import {
	computeAutoBootstrap,
	effectiveMode,
	ProfileMirrorService,
	tryDecodeLockUpdatedMessage,
	type ProfileMirrorAdapter,
	type ProfileMirrorSettings,
} from "../src/profile/profileMirrorService";
import { PROFILE_WS_LOCK_UPDATED, type ProfileLock } from "../src/profile/profileLock";

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

function makeSettings(overrides: Partial<ProfileMirrorSettings> = {}): ProfileMirrorSettings {
	return {
		configProfileSyncEnabled: false,
		configProfileMode: "off",
		configProfileTrustedPublisher: false,
		configProfileCanPublishProfile: false,
		configProfileCanPublishPluginCode: false,
		configProfileCurrentProfile: "desktop",
		configProfileAutoModeInitialized: false,
		...overrides,
	};
}

function makeLock(generation: string): ProfileLock {
	return {
		version: 1, generation, previousGeneration: "",
		publishedAt: "", publishedByDeviceId: "", publishedByDeviceName: "",
		baseGeneration: "", pluginLocks: {}, profileManifests: {},
	};
}

class FakeAdapter implements ProfileMirrorAdapter {
	applies: ProfileLock[] = [];
	publishes = 0;
	updates: Array<{ reason: string; before: ProfileMirrorSettings; after: ProfileMirrorSettings }> = [];
	logs: string[] = [];
	private remoteLock: ProfileLock | null = null;
	private mobile: boolean;
	private settings: ProfileMirrorSettings;

	constructor(opts: { mobile: boolean; settings: ProfileMirrorSettings; remoteLock?: ProfileLock | null }) {
		this.mobile = opts.mobile;
		this.settings = opts.settings;
		this.remoteLock = opts.remoteLock ?? null;
	}
	getSettings(): ProfileMirrorSettings { return this.settings; }
	setRemote(lock: ProfileLock | null): void { this.remoteLock = lock; }
	async applyLock(lock: ProfileLock): Promise<void> { this.applies.push(lock); }
	async publish(): Promise<void> { this.publishes++; }
	async getRemoteLock(): Promise<ProfileLock | null> { return this.remoteLock; }
	async updateSettings(mutate: (s: ProfileMirrorSettings) => void, reason: string): Promise<void> {
		const before = { ...this.settings };
		mutate(this.settings);
		this.updates.push({ reason, before, after: { ...this.settings } });
	}
	isMobileDevice(): boolean { return this.mobile; }
	log(message: string): void { this.logs.push(message); }
}

// ── effectiveMode ────────────────────────────────────────────────────────
console.log("\n--- effectiveMode encodes the settings → behaviour mapping ---");
{
	assert(effectiveMode(makeSettings()).kind === "off",
		"sync disabled → off");
	assert(effectiveMode(makeSettings({
		configProfileSyncEnabled: true,
		configProfileMode: "publish",
		configProfileTrustedPublisher: false,
	})).kind === "off",
		"publish without trustedPublisher → off (defense in depth)");

	const mode = effectiveMode(makeSettings({
		configProfileSyncEnabled: true,
		configProfileMode: "publish",
		configProfileTrustedPublisher: true,
		configProfileCanPublishProfile: true,
		configProfileCanPublishPluginCode: false,
	}));
	assert(mode.kind === "publish", "publish + trusted → publish");
	if (mode.kind === "publish") {
		assert(mode.canPublishProfile && !mode.canPublishPluginCode,
			"trust permissions surfaced separately");
	}

	assert(effectiveMode(makeSettings({
		configProfileSyncEnabled: true,
		configProfileMode: "subscribe",
	})).kind === "subscribe", "subscribe mode passes through");
}

// ── computeAutoBootstrap (mobile-first heuristic) ───────────────────────
console.log("\n--- computeAutoBootstrap: mobile is auto-subscribed once ---");
{
	const fresh = makeSettings();
	const result = computeAutoBootstrap(fresh, true);
	assert(result?.configProfileSyncEnabled === true, "mobile fresh enables sync");
	assert(result?.configProfileMode === "subscribe", "mobile fresh subscribes");
	assert(result?.configProfileCurrentProfile === "mobile", "currentProfile = mobile");
	assert(result?.configProfileAutoModeInitialized === true, "init flag flipped");

	const desktop = computeAutoBootstrap(fresh, false);
	assert(desktop === null, "desktop is NOT auto-bootstrapped");

	const already = computeAutoBootstrap(makeSettings({ configProfileAutoModeInitialized: true }), true);
	assert(already === null, "second-run mobile is left alone");
}

// ── WS message decoding ─────────────────────────────────────────────────
console.log("\n--- tryDecodeLockUpdatedMessage parses the broadcast format ---");
{
	const payload = makeLock("g-7");
	const wire = `${PROFILE_WS_LOCK_UPDATED}:${JSON.stringify(payload)}`;
	const decoded = tryDecodeLockUpdatedMessage(wire);
	assert(decoded?.generation === "g-7", "decoded matches original generation");

	assert(tryDecodeLockUpdatedMessage("__YPS:something else") === null,
		"non-profile prefix returns null");
	assert(tryDecodeLockUpdatedMessage(`${PROFILE_WS_LOCK_UPDATED}:{not json`) === null,
		"malformed json returns null");
}

// ── Service: subscribe path applies remote lock ─────────────────────────
console.log("\n--- service.refreshFromRemote applies in subscribe mode ---");
{
	const settings = makeSettings({
		configProfileSyncEnabled: true,
		configProfileMode: "subscribe",
		configProfileCurrentProfile: "mobile",
	});
	const lock = makeLock("g-1");
	const adapter = new FakeAdapter({ mobile: true, settings, remoteLock: lock });
	const service = new ProfileMirrorService(adapter);
	await service.refreshFromRemote(settings);
	assert(adapter.applies.length === 1, "lock applied once");
	assert(adapter.applies[0]?.generation === "g-1", "applied the right lock");
	assert(adapter.publishes === 0, "subscribe does not publish");
}

// ── Service: WS message triggers apply ──────────────────────────────────
console.log("\n--- service.onWebSocketMessage applies decoded lock ---");
{
	const settings = makeSettings({
		configProfileSyncEnabled: true,
		configProfileMode: "subscribe",
	});
	const adapter = new FakeAdapter({ mobile: true, settings });
	const service = new ProfileMirrorService(adapter);
	const wire = `${PROFILE_WS_LOCK_UPDATED}:${JSON.stringify(makeLock("g-9"))}`;
	await service.onWebSocketMessage(wire, settings);
	assert(adapter.applies[0]?.generation === "g-9", "WS-decoded lock applied");

	// Off mode should ignore the message entirely.
	adapter.applies = [];
	const offSettings = makeSettings();
	await service.onWebSocketMessage(wire, offSettings);
	assert(adapter.applies.length === 0, "off mode ignores WS lock-updated");
}

// ── Service: auto-bootstrap on first mobile load ────────────────────────
console.log("\n--- service.onSettingsLoaded auto-bootstraps mobile ---");
{
	const settings = makeSettings();
	const adapter = new FakeAdapter({ mobile: true, settings });
	const service = new ProfileMirrorService(adapter);
	await service.onSettingsLoaded(settings);
	assert(adapter.updates.length === 1, "auto-bootstrap triggered exactly one settings write");
	assert(adapter.updates[0]?.reason === "profile-auto-bootstrap",
		"settings update has expected reason for audit");
}

// ── Service: publishNow gated by trust permissions ──────────────────────
console.log("\n--- service.publishNow respects trust permissions ---");
{
	const adapter = new FakeAdapter({
		mobile: false,
		settings: makeSettings({ configProfileSyncEnabled: true, configProfileMode: "publish" }),
	});
	const service = new ProfileMirrorService(adapter);
	await service.publishNow(adapter.getSettings());
	assert(adapter.publishes === 0, "no publish without trustedPublisher even when mode=publish");

	const trustedAdapter = new FakeAdapter({
		mobile: false,
		settings: makeSettings({
			configProfileSyncEnabled: true,
			configProfileMode: "publish",
			configProfileTrustedPublisher: true,
			configProfileCanPublishProfile: true,
		}),
	});
	const service2 = new ProfileMirrorService(trustedAdapter);
	await service2.publishNow(trustedAdapter.getSettings());
	assert(trustedAdapter.publishes === 1, "trusted publisher publishes");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
