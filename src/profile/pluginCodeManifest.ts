/**
 * Plugin code manifest builder.
 *
 * Plugin CODE (manifest.json + main.js + styles.css + assets) is shared
 * across profiles. The publisher emits one PluginCodeManifest per allowed
 * plugin and publishes the JSON as a hash-addressed blob; the parent
 * ProfileLock only stores the codeManifestHash + counters.
 *
 * Plugin BEHAVIOR (data.json) is per-profile and lives in ProfileManifest.
 */

import {
	BOOTSTRAP_PLUGIN_IDS,
	type Profile,
	type ProfilePolicy,
} from "./profilePolicy";
import {
	PLUGIN_CODE_MANIFEST_VERSION,
	type PluginCodeManifest,
	type PluginVersionLock,
} from "./profileLock";
import type { ScannedPlugin } from "./profileManifest";

export interface BuildPluginCodeManifestsInput {
	plugins: readonly ScannedPlugin[];
	policy: ProfilePolicy;
	generation: string;
	createdAt: string;
	sourceDeviceId: string;
}

export interface BuiltPluginCode {
	manifest: PluginCodeManifest;
	pluginLock: Omit<PluginVersionLock, "codeManifestHash">;
}

export function buildPluginCodeManifests(
	input: BuildPluginCodeManifestsInput,
): BuiltPluginCode[] {
	const { plugins, policy, generation, createdAt, sourceDeviceId } = input;
	const out: BuiltPluginCode[] = [];

	for (const plugin of plugins) {
		if (BOOTSTRAP_PLUGIN_IDS.has(plugin.pluginId)) continue;

		const allowedProfiles: Profile[] = [];
		if (policy.isPluginAllowedForProfile(plugin.pluginId, plugin.manifest, "desktop")) {
			allowedProfiles.push("desktop");
		}
		if (policy.isPluginAllowedForProfile(plugin.pluginId, plugin.manifest, "mobile")) {
			allowedProfiles.push("mobile");
		}
		if (allowedProfiles.length === 0) continue;

		const acceptedFiles = plugin.codeFiles.filter((f) =>
			policy.isPathAllowedForProfile(f.path, "desktop"),
		);
		if (acceptedFiles.length === 0) continue;

		const totalBytes = acceptedFiles.reduce((sum, f) => sum + f.size, 0);

		const manifest: PluginCodeManifest = {
			version: PLUGIN_CODE_MANIFEST_VERSION,
			pluginId: plugin.pluginId,
			pluginVersion: plugin.manifest.version,
			generation,
			createdAt,
			sourceDeviceId,
			files: acceptedFiles
				.map((f) => ({
					path: f.path,
					hash: f.hash,
					size: f.size,
					applyPhase: "plugin-code" as const,
				}))
				.sort((a, b) => a.path.localeCompare(b.path)),
		};

		out.push({
			manifest,
			pluginLock: {
				pluginId: plugin.pluginId,
				version: plugin.manifest.version,
				isDesktopOnly: plugin.manifest.isDesktopOnly === true,
				allowedProfiles,
				fileCount: acceptedFiles.length,
				totalBytes,
				updatedAt: createdAt,
				sourceDeviceId,
			},
		});
	}

	return out;
}
