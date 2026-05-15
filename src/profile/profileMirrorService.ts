/**
 * ProfileMirrorService — top-level state machine that wires settings to
 * Publisher and Subscriber and reacts to WebSocket lock-updated messages.
 *
 * Pure orchestration, no Obsidian-specific code; an adapter layer in
 * main.ts plugs Vault/PluginManager APIs in on top.
 */

import {
	PROFILE_WS_LOCK_UPDATED,
	type ProfileLock,
} from "./profileLock";
import type { Profile } from "./profilePolicy";

export interface ProfileMirrorSettings {
	configProfileSyncEnabled: boolean;
	configProfileMode: "off" | "publish" | "subscribe";
	configProfileTrustedPublisher: boolean;
	configProfileCanPublishProfile: boolean;
	configProfileCanPublishPluginCode: boolean;
	configProfileCurrentProfile: Profile;
	configProfileAutoModeInitialized: boolean;
}

export interface ProfileMirrorAdapter {
	/** Subscribe-side: download manifest+plugin code and apply to configDir. */
	applyLock(lock: ProfileLock): Promise<void>;
	/** Publish-side: read configDir, build manifests, CAS publish. */
	publish(): Promise<void>;
	/** Read the current remote lock (used on first run / reconnect). */
	getRemoteLock(): Promise<ProfileLock | null>;
	/** Persist a settings field. */
	updateSettings(mutate: (s: ProfileMirrorSettings) => void, reason: string): Promise<void>;
	/** True if this is a mobile device (used to decide auto-subscribe). */
	isMobileDevice(): boolean;
	/** Log a non-fatal status line. */
	log(message: string): void;
}

export interface ProfileMirrorWsMessage {
	raw: string;
}

/**
 * Should this device auto-bootstrap into subscribe mode?
 * The mobile-first heuristic from the plan: if this is a mobile device and
 * the user has not yet been through configProfileAutoModeInitialized, flip
 * sync on, mode subscribe, currentProfile mobile.
 */
export function computeAutoBootstrap(settings: ProfileMirrorSettings, isMobile: boolean): null | Partial<ProfileMirrorSettings> {
	if (!isMobile) return null;
	if (settings.configProfileAutoModeInitialized) return null;
	return {
		configProfileSyncEnabled: true,
		configProfileMode: "subscribe",
		configProfileCurrentProfile: "mobile",
		configProfileAutoModeInitialized: true,
	};
}

/**
 * Decode a WebSocket payload that may carry a __YAOS_PROFILE:lock-updated
 * message. Returns the lock if recognised, null otherwise.
 */
export function tryDecodeLockUpdatedMessage(raw: string): ProfileLock | null {
	if (!raw.startsWith(`${PROFILE_WS_LOCK_UPDATED}:`)) return null;
	const json = raw.slice(PROFILE_WS_LOCK_UPDATED.length + 1);
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as ProfileLock;
	} catch {
		return null;
	}
}

export type EffectiveMode =
	| { kind: "off" }
	| { kind: "publish"; canPublishProfile: boolean; canPublishPluginCode: boolean }
	| { kind: "subscribe" };

export function effectiveMode(settings: ProfileMirrorSettings): EffectiveMode {
	if (!settings.configProfileSyncEnabled) return { kind: "off" };
	if (settings.configProfileMode === "off") return { kind: "off" };
	if (settings.configProfileMode === "subscribe") return { kind: "subscribe" };
	if (!settings.configProfileTrustedPublisher) return { kind: "off" };
	return {
		kind: "publish",
		canPublishProfile: settings.configProfileCanPublishProfile,
		canPublishPluginCode: settings.configProfileCanPublishPluginCode,
	};
}

export class ProfileMirrorService {
	constructor(private readonly adapter: ProfileMirrorAdapter) {}

	async onSettingsLoaded(settings: ProfileMirrorSettings): Promise<void> {
		const bootstrap = computeAutoBootstrap(settings, this.adapter.isMobileDevice());
		if (bootstrap) {
			await this.adapter.updateSettings((s) => Object.assign(s, bootstrap), "profile-auto-bootstrap");
			this.adapter.log("Profile Mirror: mobile auto-mode initialized (subscribe).");
		}
	}

	async refreshFromRemote(settings: ProfileMirrorSettings): Promise<void> {
		const mode = effectiveMode(settings);
		if (mode.kind !== "subscribe") return;
		const lock = await this.adapter.getRemoteLock();
		if (!lock) return;
		await this.adapter.applyLock(lock);
	}

	async onWebSocketMessage(raw: string, settings: ProfileMirrorSettings): Promise<void> {
		const lock = tryDecodeLockUpdatedMessage(raw);
		if (!lock) return;
		const mode = effectiveMode(settings);
		if (mode.kind !== "subscribe") return;
		await this.adapter.applyLock(lock);
	}

	async publishNow(settings: ProfileMirrorSettings): Promise<void> {
		const mode = effectiveMode(settings);
		if (mode.kind !== "publish") return;
		await this.adapter.publish();
	}
}
