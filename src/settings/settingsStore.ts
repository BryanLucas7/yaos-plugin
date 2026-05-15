import { randomBase64Url } from "../utils/base64url";

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
	/** Optional repo URL used to deep-link provider-native update pages. */
	updateRepoUrl: string;
	/** Optional default branch for provider-native update links. */
	updateRepoBranch: string;

	// ── Profile Mirror (Etapa 10) ────────────────────────────────────────
	/** Master switch for the profile-mirror channel. */
	configProfileSyncEnabled: boolean;
	/** Per-device role. */
	configProfileMode: "off" | "publish" | "subscribe";
	/** Whether this device may publish anything at all. */
	configProfileTrustedPublisher: boolean;
	/** May publish profile manifests (configs, themes, snippets, behavior). */
	configProfileCanPublishProfile: boolean;
	/** May publish PluginCodeManifest + pluginLocks updates. */
	configProfileCanPublishPluginCode: boolean;
	/** Which profile this device represents. */
	configProfileCurrentProfile: "desktop" | "mobile";
	/** Optional explicit desktop configDir override (defaults to .obsidian). */
	configProfileDesktopConfigDir: string;
	/** Optional explicit mobile configDir override (defaults to .obsidian-mobile). */
	configProfileMobileConfigDir: string;
	/** True after the first-mobile auto-mode has been applied (subscribe). */
	configProfileAutoModeInitialized: boolean;
	/** Last lock generation observed via WS / GET. */
	configProfileLastSeenGeneration: string;
	/** Last lock generation fully applied to the configDir. */
	configProfileLastAppliedGeneration: string;
	/** Generation the publisher believes the remote is on (for CAS). */
	configProfileBaseGeneration: string;
	/** Optional explicit allowlist of plugin ids the user has chosen. */
	configProfileIncludedPluginIds: string[];
	/** Optional explicit denylist of plugin ids the user has chosen. */
	configProfileExcludedPluginIds: string[];
	/** First-pass clone desktop Lazy section into mobile. */
	configProfileInitialCloneDesktopLazyToMobile: boolean;
	/** True once the desktop->mobile Lazy clone has happened. */
	configProfileLazyMobileInitialized: boolean;
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
	updateRepoUrl: "",
	updateRepoBranch: "main",

	configProfileSyncEnabled: false,
	configProfileMode: "off",
	configProfileTrustedPublisher: false,
	configProfileCanPublishProfile: false,
	configProfileCanPublishPluginCode: false,
	configProfileCurrentProfile: "desktop",
	configProfileDesktopConfigDir: "",
	configProfileMobileConfigDir: ".obsidian-mobile",
	configProfileAutoModeInitialized: false,
	configProfileLastSeenGeneration: "",
	configProfileLastAppliedGeneration: "",
	configProfileBaseGeneration: "",
	configProfileIncludedPluginIds: [],
	configProfileExcludedPluginIds: [],
	configProfileInitialCloneDesktopLazyToMobile: true,
	configProfileLazyMobileInitialized: false,
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
