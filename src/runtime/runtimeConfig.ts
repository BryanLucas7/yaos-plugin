import type { ExternalEditPolicy, VaultSyncSettings } from "../settings";
import { parseExcludePatterns } from "../sync/exclude";
import type { ConfigProfileAllowlistPreset, ConfigProfileMode } from "../sync/profileSyncPolicy";

export interface RuntimeConfig {
	host: string;
	token: string;
	vaultId: string;
	deviceName: string;
	debug: boolean;
	frontmatterGuardEnabled: boolean;
	excludePatterns: string[];
	maxFileSizeBytes: number;
	maxFileSizeKB: number;
	externalEditPolicy: ExternalEditPolicy;
	enableAttachmentSync: boolean;
	attachmentSyncExplicitlyConfigured: boolean;
	maxAttachmentSizeKB: number;
	attachmentConcurrency: number;
	showRemoteCursors: boolean;
	configProfileSyncEnabled: boolean;
	configProfileMode: ConfigProfileMode;
	configProfileAllowlistPreset: ConfigProfileAllowlistPreset;
	configProfileInitialAutoApply: boolean;
	configProfileManualApplyAfterInitial: boolean;
	configProfileLastSeenGeneration: string;
	configProfileLastAppliedGeneration: string;
	configProfileLastBackupGeneration: string;
	updateRepoUrl: string;
	updateRepoBranch: string;
	vaultConfigDir: string;
}

export function buildRuntimeConfig(
	settings: VaultSyncSettings,
	vaultConfigDir: string,
): RuntimeConfig {
	return {
		host: settings.host.trim(),
		token: settings.token.trim(),
		vaultId: settings.vaultId.trim(),
		deviceName: settings.deviceName.trim(),
		debug: settings.debug,
		frontmatterGuardEnabled: settings.frontmatterGuardEnabled,
		excludePatterns: parseExcludePatterns(settings.excludePatterns),
		maxFileSizeBytes: settings.maxFileSizeKB * 1024,
		maxFileSizeKB: settings.maxFileSizeKB,
		externalEditPolicy: settings.externalEditPolicy,
		enableAttachmentSync: settings.enableAttachmentSync,
		attachmentSyncExplicitlyConfigured: settings.attachmentSyncExplicitlyConfigured,
		maxAttachmentSizeKB: settings.maxAttachmentSizeKB,
		attachmentConcurrency: settings.attachmentConcurrency,
		showRemoteCursors: settings.showRemoteCursors,
		configProfileSyncEnabled: settings.configProfileSyncEnabled,
		configProfileMode: settings.configProfileMode,
		configProfileAllowlistPreset: settings.configProfileAllowlistPreset,
		configProfileInitialAutoApply: settings.configProfileInitialAutoApply,
		configProfileManualApplyAfterInitial: settings.configProfileManualApplyAfterInitial,
		configProfileLastSeenGeneration: settings.configProfileLastSeenGeneration,
		configProfileLastAppliedGeneration: settings.configProfileLastAppliedGeneration,
		configProfileLastBackupGeneration: settings.configProfileLastBackupGeneration,
		updateRepoUrl: settings.updateRepoUrl.trim(),
		updateRepoBranch: settings.updateRepoBranch.trim() || "main",
		vaultConfigDir,
	};
}
