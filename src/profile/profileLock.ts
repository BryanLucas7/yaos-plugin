/**
 * Profile lock — the canonical remote state of the Obsidian profile.
 *
 * The lock lives EXCLUSIVELY in the Durable Object's transactional storage.
 * It is NEVER stored in the Y.Doc. Clients read it via GET /profile-lock and
 * write it via PUT /profile-lock with compare-and-swap. After a successful
 * PUT, the server broadcasts a "__YAOS_PROFILE:lock-updated" custom message
 * to connected WebSockets.
 *
 * Profile manifests and plugin code manifests are content-addressed JSON
 * blobs referenced by hash from this lock. The lock itself stays small:
 * only references and counters.
 */

import type { Profile } from "./profilePolicy";

export const PROFILE_LOCK_VERSION = 1;
export const PROFILE_MANIFEST_VERSION = 1;
export const PLUGIN_CODE_MANIFEST_VERSION = 1;

/** WebSocket custom-message prefix used by the profile-mirror channel. */
export const PROFILE_WS_MESSAGE_PREFIX = "__YAOS_PROFILE:";
export const PROFILE_WS_LOCK_UPDATED = `${PROFILE_WS_MESSAGE_PREFIX}lock-updated`;

export interface PluginVersionLock {
	pluginId: string;
	version: string;
	repo?: string;
	isDesktopOnly: boolean;
	allowedProfiles: Profile[];
	codeManifestHash: string;
	fileCount: number;
	totalBytes: number;
	updatedAt: string;
	sourceDeviceId: string;
}

export interface ProfileManifestRef {
	profile: Profile;
	kind: "real" | "bootstrap";
	manifestHash: string;
	fileCount: number;
	totalBytes: number;
	createdAt: string;
	sourceDeviceId: string;
}

export interface ProfileLock {
	version: typeof PROFILE_LOCK_VERSION;
	generation: string;
	previousGeneration: string;
	publishedAt: string;
	publishedByDeviceId: string;
	publishedByDeviceName: string;
	baseGeneration: string;
	pluginLocks: Record<string, PluginVersionLock>;
	profileManifests: Partial<Record<Profile, ProfileManifestRef>>;
}

export type ProfileApplyPhase =
	| "safe-now"
	| "next-startup"
	| "activation-last";

export type ProfileFileKind =
	| "config"
	| "plugin-behavior"
	| "theme"
	| "snippet"
	| "icon";

export interface ProfileManifestFile {
	path: string;
	hash: string;
	size: number;
	kind: ProfileFileKind;
	pluginId?: string;
	applyPhase: ProfileApplyPhase;
}

export interface ProfileManifest {
	version: typeof PROFILE_MANIFEST_VERSION;
	profile: Profile;
	generation: string;
	baseGeneration: string;
	createdAt: string;
	sourceDeviceId: string;
	files: ProfileManifestFile[];
}

export interface PluginCodeFile {
	path: string;
	hash: string;
	size: number;
	applyPhase: "plugin-code";
}

export interface PluginCodeManifest {
	version: typeof PLUGIN_CODE_MANIFEST_VERSION;
	pluginId: string;
	pluginVersion: string;
	generation: string;
	createdAt: string;
	sourceDeviceId: string;
	files: PluginCodeFile[];
}

/**
 * Result of a CAS attempt against the Durable Object.
 * "stale-base" means the publisher's baseGeneration no longer matches the
 * current generation; the publisher must rebase locally and retry.
 */
export type ProfileLockCasResult =
	| { kind: "accepted"; lock: ProfileLock }
	| { kind: "stale-base"; current: ProfileLock };

export interface ProfileLockPutBody {
	baseGeneration: string;
	nextLock: ProfileLock;
}

export function emptyProfileLock(generation = ""): ProfileLock {
	return {
		version: PROFILE_LOCK_VERSION,
		generation,
		previousGeneration: "",
		publishedAt: "",
		publishedByDeviceId: "",
		publishedByDeviceName: "",
		baseGeneration: "",
		pluginLocks: {},
		profileManifests: {},
	};
}

export function isProfileLock(value: unknown): value is ProfileLock {
	if (typeof value !== "object" || value === null) return false;
	const v = value as ProfileLock;
	if (v.version !== PROFILE_LOCK_VERSION) return false;
	if (typeof v.generation !== "string") return false;
	if (typeof v.previousGeneration !== "string") return false;
	if (typeof v.publishedAt !== "string") return false;
	if (typeof v.publishedByDeviceId !== "string") return false;
	if (typeof v.publishedByDeviceName !== "string") return false;
	if (typeof v.baseGeneration !== "string") return false;
	if (typeof v.pluginLocks !== "object" || v.pluginLocks === null) return false;
	if (typeof v.profileManifests !== "object" || v.profileManifests === null) return false;
	return true;
}
