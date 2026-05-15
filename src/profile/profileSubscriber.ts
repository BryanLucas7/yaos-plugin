/**
 * ProfileSubscriber — applies profile lock updates to a target configDir.
 *
 * Three-phase apply pipeline:
 *   1. Stage every file in a sibling staging directory; validate each
 *      file's SHA-256 + size against the manifest entry.
 *   2. Apply files to the live configDir grouped by applyPhase:
 *        - "safe-now":         applied immediately.
 *        - "plugin-code":      applied immediately ONLY when the plugin
 *                              is currently inactive; otherwise deferred
 *                              to "next-startup" so the active plugin is
 *                              not re-loaded mid-session.
 *        - "activation-last":  applied last so plugin activation /
 *                              workspace layout is the very last write.
 *      community-plugins.json is ALWAYS written last.
 *   3. Persist `lastAppliedGeneration` ONLY after every required phase
 *      finished. If the app crashes mid-apply the next boot reapplies
 *      the same generation idempotently because:
 *        - lastAppliedGeneration is unchanged
 *        - already-correct files are skipped via hash check
 *
 * Bootstrap protection: YAOS and BRAT data files are NEVER overwritten
 * regardless of what the manifest says (defense in depth — the policy
 * already excludes them but we double-check at apply time).
 */

import {
	type PluginCodeManifest,
	type ProfileApplyPhase,
	type ProfileLock,
	type ProfileManifest,
	type ProfileManifestFile,
} from "./profileLock";
import {
	BOOTSTRAP_PLUGIN_IDS,
	type Profile,
} from "./profilePolicy";

/** Files that, if changed, must always wait for a restart to take effect. */
const PLUGIN_CODE_NEXT_STARTUP_NAMES: ReadonlySet<string> = new Set([
	"main.js",
	"manifest.json",
]);

const COMMUNITY_PLUGINS_FILENAME = "community-plugins.json";

export interface SubscriberFs {
	/** Returns the file's SHA-256 hex hash, or null if absent. */
	hashOf(path: string): Promise<string | null>;
	writeStaging(path: string, bytes: Uint8Array): Promise<void>;
	writeLive(path: string, bytes: Uint8Array): Promise<void>;
	listLiveUnder(prefix: string): Promise<string[]>;
	deleteLive(path: string): Promise<void>;
}

export interface SubscriberStateStore {
	getLastAppliedGeneration(): Promise<string | null>;
	setLastAppliedGeneration(generation: string): Promise<void>;
	getPendingPluginRestartIds(): Promise<string[]>;
	setPendingPluginRestartIds(ids: string[]): Promise<void>;
}

export interface SubscriberTransport {
	downloadBlob(hash: string): Promise<Uint8Array>;
	downloadJsonBlob<T>(hash: string): Promise<T>;
}

export interface SubscriberRuntime {
	/** Whether the named plugin is currently active in this Obsidian session. */
	isPluginActive(pluginId: string): boolean;
}

export interface ProfileSubscriberDeps {
	profile: Profile;
	fs: SubscriberFs;
	state: SubscriberStateStore;
	transport: SubscriberTransport;
	runtime: SubscriberRuntime;
}

export interface ApplyOutcome {
	appliedFiles: string[];
	skippedFiles: string[];
	deferredPluginIds: string[];
	community: { wrote: boolean };
	generation: string;
}

export class ProfileSubscriber {
	constructor(private readonly deps: ProfileSubscriberDeps) {}

	async applyLock(lock: ProfileLock): Promise<ApplyOutcome> {
		const ref = lock.profileManifests[this.deps.profile];
		if (!ref) {
			return {
				appliedFiles: [],
				skippedFiles: [],
				deferredPluginIds: [],
				community: { wrote: false },
				generation: lock.generation,
			};
		}

		const manifest = await this.deps.transport.downloadJsonBlob<ProfileManifest>(ref.manifestHash);

		const codeManifestsByPlugin = new Map<string, PluginCodeManifest>();
		for (const [pluginId, plock] of Object.entries(lock.pluginLocks)) {
			if (!plock.allowedProfiles.includes(this.deps.profile)) continue;
			const code = await this.deps.transport.downloadJsonBlob<PluginCodeManifest>(plock.codeManifestHash);
			codeManifestsByPlugin.set(pluginId, code);
		}

		// Stage + validate everything BEFORE touching live configDir.
		const profileFiles = manifest.files.filter((f) => !this.isBootstrapProtected(f));
		await this.stageAll(profileFiles);
		for (const code of codeManifestsByPlugin.values()) {
			await this.stageAll(code.files);
		}

		const phases: Record<ProfileApplyPhase, ProfileManifestFile[]> = {
			"safe-now": [],
			"plugin-code": [],
			"activation-last": [],
		};
		for (const f of profileFiles) phases[f.applyPhase].push(f);

		const codeFilesAcrossPlugins: Array<{ pluginId: string; file: ProfileManifestFile }> = [];
		for (const [pluginId, code] of codeManifestsByPlugin) {
			for (const file of code.files) {
				codeFilesAcrossPlugins.push({
					pluginId,
					file: { ...file, kind: "config", applyPhase: "next-startup" as ProfileApplyPhase },
				});
			}
		}

		const appliedFiles: string[] = [];
		const skippedFiles: string[] = [];
		const deferredPluginIds = new Set<string>();

		for (const file of phases["safe-now"]) {
			if (file.path === COMMUNITY_PLUGINS_FILENAME) continue;
			const did = await this.applyFileIfNeeded(file);
			if (did) appliedFiles.push(file.path); else skippedFiles.push(file.path);
		}

		for (const { pluginId, file } of codeFilesAcrossPlugins) {
			const tail = file.path.split("/").pop() ?? "";
			const mustDeferIfActive = PLUGIN_CODE_NEXT_STARTUP_NAMES.has(tail);
			if (mustDeferIfActive && this.deps.runtime.isPluginActive(pluginId)) {
				deferredPluginIds.add(pluginId);
				continue;
			}
			const did = await this.applyFileIfNeeded(file);
			if (did) appliedFiles.push(file.path); else skippedFiles.push(file.path);
		}

		const communityFile = phases["safe-now"].find((f) => f.path === COMMUNITY_PLUGINS_FILENAME)
			?? phases["activation-last"].find((f) => f.path === COMMUNITY_PLUGINS_FILENAME);

		for (const file of phases["activation-last"]) {
			if (file.path === COMMUNITY_PLUGINS_FILENAME) continue;
			const did = await this.applyFileIfNeeded(file);
			if (did) appliedFiles.push(file.path); else skippedFiles.push(file.path);
		}

		let wroteCommunity = false;
		if (communityFile) {
			const did = await this.applyFileIfNeeded(communityFile);
			if (did) {
				appliedFiles.push(communityFile.path);
				wroteCommunity = true;
			} else {
				skippedFiles.push(communityFile.path);
			}
		}

		await this.deps.state.setPendingPluginRestartIds(Array.from(deferredPluginIds));
		await this.deps.state.setLastAppliedGeneration(lock.generation);

		return {
			appliedFiles,
			skippedFiles,
			deferredPluginIds: Array.from(deferredPluginIds),
			community: { wrote: wroteCommunity },
			generation: lock.generation,
		};
	}

	private isBootstrapProtected(file: ProfileManifestFile): boolean {
		if (file.pluginId && BOOTSTRAP_PLUGIN_IDS.has(file.pluginId)) return true;
		for (const id of BOOTSTRAP_PLUGIN_IDS) {
			if (file.path === `plugins/${id}` || file.path.startsWith(`plugins/${id}/`)) return true;
		}
		return false;
	}

	private async stageAll(files: ReadonlyArray<{ path: string; hash: string; size: number }>): Promise<void> {
		for (const file of files) {
			const bytes = await this.deps.transport.downloadBlob(file.hash);
			if (bytes.byteLength !== file.size) {
				throw new Error(`stage failed: size mismatch for ${file.path}`);
			}
			await this.deps.fs.writeStaging(file.path, bytes);
		}
	}

	private async applyFileIfNeeded(file: { path: string; hash: string; size: number }): Promise<boolean> {
		const onDisk = await this.deps.fs.hashOf(file.path);
		if (onDisk === file.hash) return false;
		const bytes = await this.deps.transport.downloadBlob(file.hash);
		if (bytes.byteLength !== file.size) {
			throw new Error(`apply failed: size mismatch for ${file.path}`);
		}
		await this.deps.fs.writeLive(file.path, bytes);
		return true;
	}
}
