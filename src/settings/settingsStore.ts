import { randomBase64Url } from "../utils/base64url";
import type { ConfigProfileAllowlistPreset, ConfigProfileMode } from "../sync/profileSyncPolicy";
import {
	DEFAULT_MOBILE_PROFILE_PLUGIN_IDS,
	normalizeProfilePluginIds,
} from "../profile/profilePackage";

/** Controls how external disk edits (git, other editors) are imported into CRDT. */
export type ExternalEditPolicy = "always" | "closed-only" | "never";
export const MAX_ATTACHMENT_SIZE_KB = 100 * 1024;

export function attachmentSizeCapKB(serverMaxBlobUploadBytes?: number | null): number {
	if (
		typeof serverMaxBlobUploadBytes !== "number" ||
		!Number.isFinite(serverMaxBlobUploadBytes) ||
		serverMaxBlobUploadBytes <= 0
	) {
		return MAX_ATTACHMENT_SIZE_KB;
	}
	return Math.max(1, Math.min(MAX_ATTACHMENT_SIZE_KB, Math.floor(serverMaxBlobUploadBytes / 1024)));
}

export interface VaultSyncSettings {
	/** Cloudflare Worker host, e.g. "https://sync.yourdomain.com" */
	host: string;
	/** Shared secret token for auth. */
	token: string;
	/** Unique vault identifier. Generated randomly if empty on first load. */
	vaultId: string;
	/** Human-readable device name shown in awareness/cursors. */
	deviceName: string;
	/** Enable verbose console.log output for debugging. */
	debug: boolean;
	/** Pause propagation of suspicious YAML frontmatter transitions. */
	frontmatterGuardEnabled: boolean;
	/** Comma-separated path prefixes to exclude from sync. */
	excludePatterns: string;
	/** Maximum file size in KB to sync via CRDT. Files larger are skipped. */
	maxFileSizeKB: number;
	/**
	 * How to handle external disk modifications (git pull, other editors).
	 *   "always"      — always import into CRDT (default, current behavior)
	 *   "closed-only" — import only for files not open in an editor
	 *   "never"       — never import (CRDT is sole source of truth)
	 */
	externalEditPolicy: ExternalEditPolicy;
	/** Enable attachment (non-markdown) sync via R2 blob store. */
	enableAttachmentSync: boolean;
	/** True once the user has explicitly changed the attachment sync toggle. */
	attachmentSyncExplicitlyConfigured: boolean;
	/** Maximum attachment size in KB. Files larger are skipped. Capped at 102400 (100 MB). */
	maxAttachmentSizeKB: number;
	/** Number of parallel upload/download slots. */
	attachmentConcurrency: number;
	/** Show remote cursors and selections in the editor. */
	showRemoteCursors: boolean;
	/** Enable explicit allowlisted Obsidian configuration profile sync. */
	configProfileSyncEnabled: boolean;
	/** Publish profile files from this device, subscribe to them, or keep the original YAOS behavior. */
	configProfileMode: ConfigProfileMode;
	/** Active allowlist preset for profile sync. */
	configProfileAllowlistPreset: ConfigProfileAllowlistPreset;
	/** Mobile plugin directories included in the profile package when this device publishes. */
	configProfileMobilePluginIds: string[];
	/** True after YAOS has made its one-time platform-specific profile mode choice. */
	configProfileAutoModeInitialized: boolean;
	/** Automatically apply the first staged PC profile package on a new subscriber. Disabled by default for mobile safety. */
	configProfileInitialAutoApply: boolean;
	/** Require a command/button after the first profile package has been applied. */
	configProfileManualApplyAfterInitial: boolean;
	/** Latest profile package generation seen by this device. */
	configProfileLastSeenGeneration: string;
	/** Latest profile package generation applied to this device. */
	configProfileLastAppliedGeneration: string;
	/** Latest local backup generation created before applying a profile package. */
	configProfileLastBackupGeneration: string;
	/** Enable QA flight recorder tracing. */
	qaTraceEnabled: boolean;
	/** QA trace mode: safe/qa-safe/full/local-private. */
	qaTraceMode: "safe" | "qa-safe" | "full" | "local-private";
	/** Optional shared secret for QA-safe multi-device trace. */
	qaTraceSecret?: string;
	/** Optional repo URL used to deep-link provider-native update pages. */
	updateRepoUrl: string;
	/** Optional default branch for provider-native update links. */
	updateRepoBranch: string;
	/** Expose window.__YAOS_DEBUG__ programmatic control surface for QA. Never ship enabled. */
	qaDebugMode: boolean;
	/**
	 * Internal: number of remaining boots in which the flight recorder must be forced ON
	 * (regardless of `qaTraceEnabled`) and logs mirrored to the vault. Decrements each boot
	 * until 0. Seeded on first 1.6.7 boot to 3 to capture the mobile crash window.
	 */
	_diagBoot3Remaining: number;
	/**
	 * Internal: vault-relative folder where flight logs are mirrored so they can ride along
	 * with normal note sync (the canonical `.obsidian/plugins/yaos/flight-logs` path is not
	 * synced on mobile).
	 */
	diagnosticsDir: string;
	/**
	 * Mobile attachment kill switch (1.6.8). When true, attachment sync is forced OFF on
	 * mobile each boot regardless of `enableAttachmentSync`. Flight logs from 1.6.7 showed
	 * mobile crashing while `pendingBlobDownloads > 0`, so we disable the engine until
	 * the root cause is fixed. Set to false manually in `data.json` to override.
	 */
	mobileAttachmentKillSwitch: boolean;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
	host: "",
	token: "",
	vaultId: "",
	deviceName: "",
	debug: false,
	frontmatterGuardEnabled: true,
	excludePatterns: "",
	maxFileSizeKB: 2048,
	externalEditPolicy: "always",
	enableAttachmentSync: true,
	attachmentSyncExplicitlyConfigured: false,
	maxAttachmentSizeKB: MAX_ATTACHMENT_SIZE_KB,
	// requestUrl cannot be hard-aborted; default to 1 to avoid stacked zombie transfers.
	attachmentConcurrency: 1,
	showRemoteCursors: true,
	configProfileSyncEnabled: false,
	configProfileMode: "off",
	configProfileAllowlistPreset: "mobile",
	configProfileMobilePluginIds: [...DEFAULT_MOBILE_PROFILE_PLUGIN_IDS],
	configProfileAutoModeInitialized: false,
	configProfileInitialAutoApply: false,
	configProfileManualApplyAfterInitial: true,
	configProfileLastSeenGeneration: "",
	configProfileLastAppliedGeneration: "",
	configProfileLastBackupGeneration: "",
	qaTraceEnabled: false,
	qaTraceMode: "safe",
	qaTraceSecret: "",
	updateRepoUrl: "",
	updateRepoBranch: "main",
	qaDebugMode: false,
	_diagBoot3Remaining: 3,
	diagnosticsDir: "YAOS-Diagnostics",
	mobileAttachmentKillSwitch: true,
};

export interface SettingsPersistence {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

export interface SettingsLoadResult<TState extends Partial<VaultSyncSettings>> {
	settings: VaultSyncSettings;
	persistedState: TState;
	migrated: boolean;
}

/** Generate a random vault ID (16 bytes, base64url). */
export function generateVaultId(): string {
	return randomBase64Url(16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readPersistedState<TState extends Partial<VaultSyncSettings>>(value: unknown): TState {
	return isRecord(value) ? { ...value } as TState : {} as TState;
}

export function readVaultSyncSettings(
	data: Partial<VaultSyncSettings> | null | undefined,
): { settings: VaultSyncSettings; migrated: boolean } {
	const settings = Object.assign(
		{},
		DEFAULT_SETTINGS,
		data as Partial<VaultSyncSettings>,
	);
	let migrated = false;
	if (typeof data?.attachmentSyncExplicitlyConfigured !== "boolean") {
		settings.attachmentSyncExplicitlyConfigured = data?.enableAttachmentSync === true;
		if (data?.enableAttachmentSync !== true) {
			settings.enableAttachmentSync = true;
		}
		migrated = true;
	}
	if (
		typeof settings.maxAttachmentSizeKB !== "number" ||
		!Number.isFinite(settings.maxAttachmentSizeKB) ||
		settings.maxAttachmentSizeKB <= 0 ||
		settings.maxAttachmentSizeKB > attachmentSizeCapKB()
	) {
		settings.maxAttachmentSizeKB = Math.min(
			attachmentSizeCapKB(),
			Math.max(1, Math.floor(Number(settings.maxAttachmentSizeKB) || DEFAULT_SETTINGS.maxAttachmentSizeKB)),
		);
		migrated = true;
	}
	if (settings.configProfileMode !== "publish" && settings.configProfileMode !== "subscribe" && settings.configProfileMode !== "off") {
		settings.configProfileMode = DEFAULT_SETTINGS.configProfileMode;
		migrated = true;
	}
	if (settings.configProfileAllowlistPreset !== "mobile") {
		settings.configProfileAllowlistPreset = DEFAULT_SETTINGS.configProfileAllowlistPreset;
		migrated = true;
	}
	if (typeof settings.configProfileSyncEnabled !== "boolean") {
		settings.configProfileSyncEnabled = DEFAULT_SETTINGS.configProfileSyncEnabled;
		migrated = true;
	}
	const normalizedMobilePluginIds = normalizeProfilePluginIds(
		Array.isArray(settings.configProfileMobilePluginIds)
			? settings.configProfileMobilePluginIds.filter((value): value is string => typeof value === "string")
			: undefined,
	);
	if (
		!Array.isArray(settings.configProfileMobilePluginIds) ||
		normalizedMobilePluginIds.length !== settings.configProfileMobilePluginIds.length ||
		normalizedMobilePluginIds.some((pluginId, index) => pluginId !== settings.configProfileMobilePluginIds[index])
	) {
		settings.configProfileMobilePluginIds = normalizedMobilePluginIds;
		migrated = true;
	}
	if (typeof settings.configProfileAutoModeInitialized !== "boolean") {
		settings.configProfileAutoModeInitialized = DEFAULT_SETTINGS.configProfileAutoModeInitialized;
		migrated = true;
	}
	if (typeof settings.configProfileInitialAutoApply !== "boolean") {
		settings.configProfileInitialAutoApply = DEFAULT_SETTINGS.configProfileInitialAutoApply;
		migrated = true;
	}
	if (typeof settings.configProfileManualApplyAfterInitial !== "boolean") {
		settings.configProfileManualApplyAfterInitial = DEFAULT_SETTINGS.configProfileManualApplyAfterInitial;
		migrated = true;
	}
	if (typeof settings.configProfileLastSeenGeneration !== "string") {
		settings.configProfileLastSeenGeneration = DEFAULT_SETTINGS.configProfileLastSeenGeneration;
		migrated = true;
	}
	if (typeof settings.configProfileLastAppliedGeneration !== "string") {
		settings.configProfileLastAppliedGeneration = DEFAULT_SETTINGS.configProfileLastAppliedGeneration;
		migrated = true;
	}
	if (typeof settings.configProfileLastBackupGeneration !== "string") {
		settings.configProfileLastBackupGeneration = DEFAULT_SETTINGS.configProfileLastBackupGeneration;
		migrated = true;
	}
	// 1.6.7 diagnostics: seed forced 3-boot recorder window for users upgrading from <=1.6.6.
	if (
		typeof settings._diagBoot3Remaining !== "number" ||
		!Number.isFinite(settings._diagBoot3Remaining) ||
		settings._diagBoot3Remaining < 0
	) {
		settings._diagBoot3Remaining = DEFAULT_SETTINGS._diagBoot3Remaining;
		migrated = true;
	}
	if (typeof settings.diagnosticsDir !== "string" || settings.diagnosticsDir.trim() === "") {
		settings.diagnosticsDir = DEFAULT_SETTINGS.diagnosticsDir;
		migrated = true;
	}
	// 1.6.8: seed mobile attachment kill switch (default true) for users upgrading.
	if (typeof settings.mobileAttachmentKillSwitch !== "boolean") {
		settings.mobileAttachmentKillSwitch = DEFAULT_SETTINGS.mobileAttachmentKillSwitch;
		migrated = true;
	}
	// 1.6.8: while the mobile crash is unresolved, re-arm the 3-boot window once it
	// reaches 0 so we keep capturing logs across cycles.
	if (settings._diagBoot3Remaining === 0) {
		settings._diagBoot3Remaining = 3;
		migrated = true;
	}
	return { settings, migrated };
}

export class SettingsStore<TState extends Partial<VaultSyncSettings>> {
	constructor(private readonly persistence: SettingsPersistence) {}

	async load(): Promise<SettingsLoadResult<TState>> {
		const persistedState = readPersistedState<TState>(await this.persistence.loadData());
		const { settings, migrated } = readVaultSyncSettings(persistedState);
		return {
			settings,
			persistedState,
			migrated,
		};
	}

	async save(state: TState): Promise<void> {
		await this.persistence.saveData({ ...state });
	}

	withSettings(state: TState, settings: VaultSyncSettings): TState {
		return {
			...state,
			...settings,
		};
	}
}
