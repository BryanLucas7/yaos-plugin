import { Notice, type App } from "obsidian";
import * as Y from "yjs";
import type { TraceHttpContext } from "../debug/trace";
import type { VaultSyncSettings } from "../settings";
import type { VaultSync } from "../sync/vaultSync";
import { ORIGIN_SEED } from "../sync/origins";
import { formatUnknown } from "../utils/format";
import {
	PROFILE_PACKAGE_MAP_KEY,
	buildMobileBratDataJson,
	buildMobileCommunityPluginsJson,
	buildMobileLazyPluginDataJson,
	buildProfilePackageArchive,
	isBlockedProfilePluginId,
	isProfilePackagePathAllowed,
	normalizeProfilePackagePath,
	normalizeProfilePluginId,
	normalizeProfilePluginIds,
	pluginIdFromProfilePackagePath,
	validateProfilePackageArchive,
	type ProfilePackageFileInput,
	type ProfilePackageManifest,
	type ProfilePackageRef,
} from "./profilePackage";
import { ProfilePackageTransport } from "./profilePackageTransport";

export interface ProfilePackageSummary {
	enabled: boolean;
	mode: VaultSyncSettings["configProfileMode"];
	lastSeenGeneration: string;
	lastAppliedGeneration: string;
	lastBackupGeneration: string;
	latestGeneration: string | null;
	latestCreatedAt: string | null;
	latestFileCount: number | null;
	latestSize: number | null;
	stagedGeneration: string | null;
}

export interface ProfilePackagePluginCandidate {
	id: string;
	name: string;
	version: string | null;
	installed: boolean;
	included: boolean;
	desktopOnly: boolean;
	blocked: boolean;
	reason: string;
}

interface ProfilePackageServiceDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	updateSettings(mutator: (settings: VaultSyncSettings) => void, reason?: string): Promise<void>;
	getVaultSync(): VaultSync | null;
	getTraceHttpContext(): TraceHttpContext | undefined;
	log(message: string): void;
	/**
	 * Optional safe-state gate. Returns null when it is safe to apply a profile package
	 * (vault loaded, sync connected, no reconcile in flight, no pending uploads), or a
	 * short human-readable reason when not. When omitted, defaults to "safe".
	 */
	isSafeToApplyProfile?(): { safe: true } | { safe: false; reason: string };
}

export type ProfileApplyStep =
	| "safe-state-gate"
	| "load-ref"
	| "ensure-staged"
	| "validate"
	| "create-backup"
	| "write-files"
	| "persist-applied-generation";

export class ProfileApplyError extends Error {
	constructor(public readonly step: ProfileApplyStep, public readonly cause: unknown) {
		super(`[${step}] ${formatUnknown(cause)}`);
		this.name = "ProfileApplyError";
	}
}

interface BackupManifest {
	schemaVersion: 1;
	generation: string;
	createdAt: string;
	paths: string[];
	files: string[];
}

interface PluginManifestInfo {
	id: string;
	name: string;
	version: string | null;
	isDesktopOnly: boolean;
}

const PROFILE_PACKAGE_LOCAL_DIR_SUFFIX = "plugins/yaos/profile-packages";
const STAGED_ZIP = "staged-mobile.zip";
const STAGED_REF = "staged-mobile.json";
const BACKUP_DIR = "backups";

function textBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? bytes.buffer
		: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function refIsValid(value: unknown): value is ProfilePackageRef {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ProfilePackageRef>;
	return record.schemaVersion === 1
		&& record.preset === "mobile"
		&& typeof record.generation === "string"
		&& record.generation.length > 0
		&& typeof record.createdAt === "string"
		&& typeof record.hash === "string"
		&& typeof record.size === "number"
		&& typeof record.fileCount === "number"
		&& typeof record.manifestHash === "string";
}

function generationId(): string {
	const date = new Date();
	const stamp = date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${rand}`;
}

export class ProfilePackageService {
	private observer: ((events: Y.YMapEvent<ProfilePackageRef>) => void) | null = null;
	private latestRef: ProfilePackageRef | null = null;
	private started = false;
	private busy = false;

	constructor(private readonly deps: ProfilePackageServiceDeps) {}

	start(): void {
		if (this.started) return;
		this.started = true;
		const map = this.deps.getVaultSync()?.profilePackages;
		if (!map) return;
		this.latestRef = this.readLatestRef();
		this.observer = () => {
			this.latestRef = this.readLatestRef();
			void this.handleLatestRef("remote-update");
		};
		map.observe(this.observer);
		void this.handleLatestRef("startup");
	}

	destroy(): void {
		const map = this.deps.getVaultSync()?.profilePackages;
		if (map && this.observer) {
			map.unobserve(this.observer);
		}
		this.observer = null;
		this.started = false;
	}

	getSummary(): ProfilePackageSummary {
		const settings = this.deps.getSettings();
		return {
			enabled: settings.configProfileSyncEnabled,
			mode: settings.configProfileMode,
			lastSeenGeneration: settings.configProfileLastSeenGeneration,
			lastAppliedGeneration: settings.configProfileLastAppliedGeneration,
			lastBackupGeneration: settings.configProfileLastBackupGeneration,
			latestGeneration: this.latestRef?.generation ?? null,
			latestCreatedAt: this.latestRef?.createdAt ?? null,
			latestFileCount: this.latestRef?.fileCount ?? null,
			latestSize: this.latestRef?.size ?? null,
			stagedGeneration: settings.configProfileLastSeenGeneration || null,
		};
	}

	async getPluginCandidates(): Promise<ProfilePackagePluginCandidate[]> {
		const configured = new Set(this.configuredMobilePluginIds());
		const installed = new Set(await this.listInstalledPluginIds());
		for (const pluginId of configured) installed.add(pluginId);
		const candidates: ProfilePackagePluginCandidate[] = [];
		for (const pluginId of Array.from(installed).sort((a, b) => a.localeCompare(b))) {
			const manifest = await this.readPluginManifest(pluginId);
			const blocked = isBlockedProfilePluginId(pluginId);
			const desktopOnly = manifest?.isDesktopOnly === true;
			const installedPlugin = manifest !== null;
			const included = configured.has(pluginId) && installedPlugin && !blocked && !desktopOnly;
			let reason = "Will be included in the next published mobile profile package.";
			if (blocked) {
				reason = pluginId === "yaos"
					? "YAOS is installed and updated by BRAT; profile packages never overwrite it."
					: "Blocked by the profile package denylist.";
			} else if (!installedPlugin) {
				reason = "Configured, but this plugin folder or manifest is not installed on this device.";
			} else if (desktopOnly) {
				reason = "Excluded automatically because manifest.json has isDesktopOnly: true.";
			} else if (!configured.has(pluginId)) {
				reason = "Installed and mobile-compatible, but not selected for the mobile profile package.";
			}
			candidates.push({
				id: pluginId,
				name: manifest?.name || pluginId,
				version: manifest?.version ?? null,
				installed: installedPlugin,
				included,
				desktopOnly,
				blocked,
				reason,
			});
		}
		return candidates;
	}

	async publishNow(): Promise<void> {
		const settings = this.deps.getSettings();
		if (!settings.configProfileSyncEnabled || settings.configProfileMode !== "publish") {
			new Notice("YAOS: set Obsidian profile mode to Publish on this device first.", 7000);
			return;
		}
		if (!settings.host || !settings.token || !settings.vaultId) {
			new Notice("YAOS: configure server URL, token, and vault ID before publishing a profile package.", 7000);
			return;
		}
		if (this.busy) {
			new Notice("YAOS: profile package operation already running.", 5000);
			return;
		}
		this.busy = true;
		try {
			const generation = generationId();
			const createdAt = new Date().toISOString();
			const allowedPluginIds = await this.effectiveMobilePluginIds();
			const files = await this.collectProfileFiles(allowedPluginIds);
			const pkg = await buildProfilePackageArchive(files, {
				generation,
				createdAt,
				deviceName: settings.deviceName || "Unnamed device",
				configDir: this.configDir,
				allowedPluginIds,
			});
			const transport = this.transport();
			await transport.upload(pkg.hash, pkg.bytes);
			const vaultSync = this.deps.getVaultSync();
			if (!vaultSync) throw new Error("Sync is not initialized");
			vaultSync.ydoc.transact(() => {
				vaultSync.profilePackages.set(PROFILE_PACKAGE_MAP_KEY, pkg.ref);
			}, ORIGIN_SEED);
			this.latestRef = pkg.ref;
			await this.deps.updateSettings((next) => {
				next.configProfileLastSeenGeneration = generation;
			}, "profile-package-publish");
			this.deps.log(
				`Profile package published: generation=${generation} files=${pkg.ref.fileCount} size=${pkg.ref.size}`,
			);
			new Notice(`YAOS: profile package published (${pkg.ref.fileCount} files).`, 7000);
		} catch (err) {
			console.error("[yaos] Profile package publish failed:", err);
			new Notice(`YAOS: profile package publish failed: ${formatUnknown(err)}`, 9000);
		} finally {
			this.busy = false;
		}
	}

	async applyLatestPackage(manual = true): Promise<void> {
		const settings = this.deps.getSettings();
		if (!settings.configProfileSyncEnabled || settings.configProfileMode !== "subscribe") {
			new Notice("YAOS: set Obsidian profile mode to Subscribe on this device first.", 7000);
			return;
		}
		if (this.busy) {
			new Notice("YAOS: profile package operation already running.", 5000);
			return;
		}
		// Safe-state gate (1.6.7): refuse to apply during reconcile/initial-sync to avoid
		// touching .obsidian while the sync engine is still settling.
		const gateProbe = this.deps.isSafeToApplyProfile?.();
		if (gateProbe && !gateProbe.safe) {
			this.deps.log(`Profile package apply blocked by safe-state gate: ${gateProbe.reason}`);
			new Notice(`YAOS: profile apply postponed — ${gateProbe.reason}`, 9000);
			return;
		}
		this.busy = true;
		try {
			const ref = await this.applyStep("load-ref", async () => {
				const candidate = this.latestRef ?? this.readLatestRef();
				if (!candidate) throw new Error("no PC profile package is available yet");
				if (!manual && settings.configProfileManualApplyAfterInitial && settings.configProfileLastAppliedGeneration) {
					throw new Error("manual-apply-required-after-initial");
				}
				return candidate;
			});
			const bytes = await this.applyStep("ensure-staged", () => this.ensureStaged(ref));
			const validated = await this.applyStep("validate", () =>
				validateProfilePackageArchive(bytes, {
					expectedHash: ref.hash,
					expectedManifestHash: ref.manifestHash,
					configDir: this.configDir,
				}),
			);
			const skipped = await this.applyStep("write-files", () =>
				this.applyValidatedPackage(validated.manifest, validated.files),
			);
			await this.applyStep("persist-applied-generation", () =>
				this.deps.updateSettings((next) => {
					next.configProfileLastAppliedGeneration = ref.generation;
				}, "profile-package-apply"),
			);
			const suffix = skipped.length > 0 ? ` ${skipped.length} active plugin file(s) were skipped; see console.` : "";
			this.deps.log(`Profile package applied: generation=${ref.generation}${skipped.length ? ` skipped=${skipped.join(",")}` : ""}`);
			new Notice(`YAOS: PC profile applied. Close and reopen Obsidian.${suffix}`, 12000);
		} catch (err) {
			const step = err instanceof ProfileApplyError ? err.step : "unknown";
			const cause = err instanceof ProfileApplyError ? err.cause : err;
			console.error(`[yaos] Profile package apply failed at step "${step}":`, cause);
			this.deps.log(`Profile package apply failed at step "${step}": ${formatUnknown(cause)}`);
			new Notice(`YAOS: profile apply failed at "${step}": ${formatUnknown(cause)}`, 12000);
		} finally {
			this.busy = false;
		}
	}

	private async applyStep<T>(step: ProfileApplyStep, fn: () => Promise<T>): Promise<T> {
		try {
			this.deps.log(`Profile apply step start: ${step}`);
			const result = await fn();
			this.deps.log(`Profile apply step ok: ${step}`);
			return result;
		} catch (err) {
			throw new ProfileApplyError(step, err);
		}
	}

	async restorePreviousBackup(): Promise<void> {
		if (this.busy) {
			new Notice("YAOS: profile package operation already running.", 5000);
			return;
		}
		this.busy = true;
		try {
			const settings = this.deps.getSettings();
			const generation = settings.configProfileLastBackupGeneration;
			if (!generation) {
				new Notice("YAOS: no profile package backup is available.", 7000);
				return;
			}
			const backupPath = this.backupZipPath(generation);
			const manifestPath = this.backupManifestPath(generation);
			if (!await this.exists(backupPath) || !await this.exists(manifestPath)) {
				new Notice("YAOS: profile package backup files were not found.", 7000);
				return;
			}
			const manifest = JSON.parse(await this.adapter.read(manifestPath)) as BackupManifest;
			const backupBytes = new Uint8Array(await this.adapter.readBinary(backupPath));
			const validated = await validateProfilePackageArchive(backupBytes, {
				configDir: this.configDir,
			});
			const backupPaths = new Set(validated.files.map((file) => file.path));
			for (const path of manifest.paths) {
				if (!backupPaths.has(path) && await this.exists(path)) {
					await this.adapter.remove(path);
				}
			}
			for (const file of validated.files) {
				await this.writeBinaryFile(file.path, file.data);
			}
			await this.deps.updateSettings((next) => {
				next.configProfileLastAppliedGeneration = "";
			}, "profile-package-restore");
			new Notice("YAOS: previous Obsidian profile restored. Close and reopen Obsidian.", 12000);
		} catch (err) {
			console.error("[yaos] Profile package restore failed:", err);
			new Notice(`YAOS: profile package restore failed: ${formatUnknown(err)}`, 9000);
		} finally {
			this.busy = false;
		}
	}

	private async handleLatestRef(reason: string): Promise<void> {
		const settings = this.deps.getSettings();
		const ref = this.latestRef;
		if (!ref || !settings.configProfileSyncEnabled || settings.configProfileMode !== "subscribe") return;
		if (ref.generation === settings.configProfileLastAppliedGeneration) return;
		try {
			await this.deps.updateSettings((next) => {
				next.configProfileLastSeenGeneration = ref.generation;
			}, `profile-package-stage:${reason}`);
			if (settings.configProfileInitialAutoApply && !settings.configProfileLastAppliedGeneration) {
				await this.ensureStaged(ref);
				await this.applyLatestPackage(false);
				return;
			}
			new Notice("YAOS: new PC profile package is available. Use 'Apply latest PC profile package' when ready.", 9000);
		} catch (err) {
			console.error("[yaos] Profile package update handling failed:", err);
			new Notice(`YAOS: profile package update handling failed: ${formatUnknown(err)}`, 9000);
		}
	}

	private readLatestRef(): ProfilePackageRef | null {
		const value = this.deps.getVaultSync()?.profilePackages.get(PROFILE_PACKAGE_MAP_KEY);
		return refIsValid(value) ? value : null;
	}

	private transport(): ProfilePackageTransport {
		const settings = this.deps.getSettings();
		return new ProfilePackageTransport(
			settings.host.replace(/\/$/, ""),
			settings.token,
			settings.vaultId,
			this.deps.getTraceHttpContext(),
		);
	}

	private get adapter() {
		return this.deps.app.vault.adapter;
	}

	private get configDir(): string {
		return this.deps.app.vault.configDir || ".obsidian";
	}

	private get localDir(): string {
		return `${this.configDir}/${PROFILE_PACKAGE_LOCAL_DIR_SUFFIX}`;
	}

	private stagedZipPath(): string {
		return `${this.localDir}/${STAGED_ZIP}`;
	}

	private stagedRefPath(): string {
		return `${this.localDir}/${STAGED_REF}`;
	}

	private backupZipPath(generation: string): string {
		return `${this.localDir}/${BACKUP_DIR}/${generation}.zip`;
	}

	private backupManifestPath(generation: string): string {
		return `${this.localDir}/${BACKUP_DIR}/${generation}.json`;
	}

	private configuredMobilePluginIds(): string[] {
		return normalizeProfilePluginIds(this.deps.getSettings().configProfileMobilePluginIds);
	}

	private async effectiveMobilePluginIds(): Promise<string[]> {
		const result: string[] = [];
		for (const pluginId of this.configuredMobilePluginIds()) {
			if (isBlockedProfilePluginId(pluginId)) continue;
			const manifest = await this.readPluginManifest(pluginId);
			if (!manifest) {
				this.deps.log(`Profile package skipped missing plugin manifest: ${pluginId}`);
				continue;
			}
			if (manifest.isDesktopOnly) {
				this.deps.log(`Profile package skipped desktop-only plugin: ${pluginId}`);
				continue;
			}
			result.push(pluginId);
		}
		return result;
	}

	private async collectProfileFiles(allowedPluginIds: string[]): Promise<ProfilePackageFileInput[]> {
		const configDir = this.configDir;
		const result = new Map<string, Uint8Array>();
		const packagedPluginIds = new Set<string>();
		const rootFiles = [
			"app.json",
			"appearance.json",
			"core-plugins.json",
			"daily-notes.json",
			"graph.json",
			"hotkeys.json",
			"types.json",
			"webviewer.json",
			"workspace-mobile.json",
			"workspaces.json",
		];
		for (const file of rootFiles) {
			const path = `${configDir}/${file}`;
			if (await this.exists(path) && isProfilePackagePathAllowed(path, configDir, allowedPluginIds)) {
				result.set(normalizeProfilePackagePath(path), new Uint8Array(await this.adapter.readBinary(path)));
			}
		}
		for (const folder of ["snippets", "themes", "icons"]) {
			await this.collectFolder(`${configDir}/${folder}`, result, allowedPluginIds);
		}
		for (const pluginId of allowedPluginIds) {
			const pluginDir = `${configDir}/plugins/${pluginId}`;
			if (!await this.exists(pluginDir)) continue;
			const beforeCount = result.size;
			await this.collectFolder(pluginDir, result, allowedPluginIds);
			if (result.size > beforeCount) {
				packagedPluginIds.add(pluginId);
			}
		}
		result.set(
			normalizeProfilePackagePath(`${configDir}/community-plugins.json`),
			textBytes(buildMobileCommunityPluginsJson(packagedPluginIds)),
		);
		await this.applyProfileFileSynthesizers(result, packagedPluginIds);
		return Array.from(result, ([path, data]) => ({ path, data }));
	}

	private async collectFolder(
		path: string,
		result: Map<string, Uint8Array>,
		allowedPluginIds: Iterable<string>,
	): Promise<void> {
		if (!await this.exists(path)) return;
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await this.adapter.list(path);
		} catch {
			return;
		}
		for (const file of listed.files) {
			const normalized = normalizeProfilePackagePath(file);
			if (!isProfilePackagePathAllowed(normalized, this.configDir, allowedPluginIds)) continue;
			result.set(normalized, new Uint8Array(await this.adapter.readBinary(normalized)));
		}
		for (const folder of listed.folders) {
			await this.collectFolder(folder, result, allowedPluginIds);
		}
	}

	private async applyProfileFileSynthesizers(
		result: Map<string, Uint8Array>,
		pluginIds: Iterable<string>,
	): Promise<void> {
		const configDir = this.configDir;
		const lazyPath = normalizeProfilePackagePath(`${configDir}/plugins/lazy-plugins/data.json`);
		if (result.has(lazyPath)) {
			result.set(lazyPath, textBytes(buildMobileLazyPluginDataJson(await this.readTextIfExists(lazyPath), pluginIds)));
		}
		const bratPath = normalizeProfilePackagePath(`${configDir}/plugins/obsidian42-brat/data.json`);
		if (result.has(bratPath)) {
			result.set(bratPath, textBytes(buildMobileBratDataJson(await this.readTextIfExists(bratPath))));
		}
	}

	private async ensureStaged(ref: ProfilePackageRef): Promise<Uint8Array> {
		const stagedRef = await this.readStagedRef();
		if (stagedRef?.generation === ref.generation && await this.exists(this.stagedZipPath())) {
			const stagedBytes = new Uint8Array(await this.adapter.readBinary(this.stagedZipPath()));
			await validateProfilePackageArchive(stagedBytes, {
				expectedHash: ref.hash,
				expectedManifestHash: ref.manifestHash,
				configDir: this.configDir,
			});
			return stagedBytes;
		}
		const bytes = await this.transport().download(ref.hash, ref.size);
		await validateProfilePackageArchive(bytes, {
			expectedHash: ref.hash,
			expectedManifestHash: ref.manifestHash,
			configDir: this.configDir,
		});
		await this.writeBinaryFile(this.stagedZipPath(), bytes);
		await this.writeTextFile(this.stagedRefPath(), `${JSON.stringify(ref, null, 2)}\n`);
		return bytes;
	}

	private async readStagedRef(): Promise<ProfilePackageRef | null> {
		const path = this.stagedRefPath();
		if (!await this.exists(path)) return null;
		try {
			const parsed = JSON.parse(await this.adapter.read(path)) as unknown;
			return refIsValid(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	private async applyValidatedPackage(
		manifest: ProfilePackageManifest,
		files: ProfilePackageFileInput[],
	): Promise<string[]> {
		await this.createBackup(manifest, files.map((file) => file.path));
		const skipped: string[] = [];
		const disabledPlugins = new Set<string>();
		const blockedPlugins = new Set<string>();
		const communityPluginsPath = normalizeProfilePackagePath(`${this.configDir}/community-plugins.json`);
		const orderedFiles = [...files].sort((a, b) => {
			const aIsCommunity = normalizeProfilePackagePath(a.path) === communityPluginsPath;
			const bIsCommunity = normalizeProfilePackagePath(b.path) === communityPluginsPath;
			if (aIsCommunity === bIsCommunity) return a.path.localeCompare(b.path);
			return aIsCommunity ? 1 : -1;
		});
		for (const file of orderedFiles) {
			const pluginId = pluginIdFromProfilePackagePath(file.path, this.configDir);
			if (pluginId && blockedPlugins.has(pluginId)) {
				skipped.push(file.path);
				continue;
			}
			if (pluginId && !disabledPlugins.has(pluginId)) {
				const disabled = await this.disablePluginIfActive(pluginId);
				disabledPlugins.add(pluginId);
				if (!disabled) {
					blockedPlugins.add(pluginId);
					skipped.push(file.path);
					continue;
				}
			}
			await this.writeBinaryFile(file.path, file.data);
		}
		return skipped;
	}

	private async createBackup(manifest: ProfilePackageManifest, targetPaths: string[]): Promise<void> {
		const existingFiles: ProfilePackageFileInput[] = [];
		const backupAllowedPluginIds = new Set(this.configuredMobilePluginIds());
		for (const path of targetPaths) {
			const pluginId = pluginIdFromProfilePackagePath(path, this.configDir);
			if (pluginId) backupAllowedPluginIds.add(pluginId);
		}
		for (const path of targetPaths) {
			if (await this.exists(path)) {
				existingFiles.push({
					path,
					data: new Uint8Array(await this.adapter.readBinary(path)),
				});
			}
		}
		const backup = await buildProfilePackageArchive(existingFiles, {
			generation: manifest.generation,
			createdAt: new Date().toISOString(),
			deviceName: "local-backup",
			configDir: this.configDir,
			allowedPluginIds: backupAllowedPluginIds,
		});
		const backupManifest: BackupManifest = {
			schemaVersion: 1,
			generation: manifest.generation,
			createdAt: new Date().toISOString(),
			paths: targetPaths,
			files: existingFiles.map((file) => file.path),
		};
		await this.writeBinaryFile(this.backupZipPath(manifest.generation), backup.bytes);
		await this.writeTextFile(this.backupManifestPath(manifest.generation), `${JSON.stringify(backupManifest, null, 2)}\n`);
		await this.deps.updateSettings((next) => {
			next.configProfileLastBackupGeneration = manifest.generation;
		}, "profile-package-backup");
	}

	private async disablePluginIfActive(pluginId: string): Promise<boolean> {
		if (pluginId === "yaos") return false;
		const plugins = (this.deps.app as unknown as {
			plugins?: {
				enabledPlugins?: Set<string>;
				disablePlugin?: (id: string) => Promise<void>;
			};
		}).plugins;
		if (!plugins?.enabledPlugins?.has(pluginId)) return true;
		if (typeof plugins.disablePlugin !== "function") return false;
		try {
			await plugins.disablePlugin(pluginId);
			return true;
		} catch (err) {
			console.warn(`[yaos] Failed to disable plugin before profile apply: ${pluginId}`, err);
			return false;
		}
	}

	private async listInstalledPluginIds(): Promise<string[]> {
		const pluginRoot = `${this.configDir}/plugins`;
		if (!await this.exists(pluginRoot)) return [];
		try {
			const listed = await this.adapter.list(pluginRoot);
			return listed.folders
				.map((folder) => normalizeProfilePackagePath(folder).split("/").pop() ?? "")
				.map((pluginId) => normalizeProfilePluginId(pluginId))
				.filter((pluginId): pluginId is string => !!pluginId);
		} catch {
			return [];
		}
	}

	private async readPluginManifest(pluginId: string): Promise<PluginManifestInfo | null> {
		const normalized = normalizeProfilePluginId(pluginId);
		if (!normalized) return null;
		const manifestPath = `${this.configDir}/plugins/${normalized}/manifest.json`;
		if (!await this.exists(manifestPath)) return null;
		try {
			const parsed = JSON.parse(await this.adapter.read(manifestPath)) as Record<string, unknown>;
			const id = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : normalized;
			return {
				id,
				name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : id,
				version: typeof parsed.version === "string" ? parsed.version : null,
				isDesktopOnly: parsed.isDesktopOnly === true,
			};
		} catch {
			return null;
		}
	}

	private async exists(path: string): Promise<boolean> {
		try {
			return await this.adapter.exists(path);
		} catch {
			return false;
		}
	}

	private async readTextIfExists(path: string): Promise<string | null> {
		if (!await this.exists(path)) return null;
		try {
			return await this.adapter.read(path);
		} catch {
			return null;
		}
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const parts = normalizeProfilePackagePath(path).split("/");
		parts.pop();
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!await this.exists(current)) {
				await this.adapter.mkdir(current);
			}
		}
	}

	private async writeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
		await this.ensureParentFolder(path);
		await this.adapter.writeBinary(path, bytesToArrayBuffer(bytes));
	}

	private async writeTextFile(path: string, text: string): Promise<void> {
		await this.ensureParentFolder(path);
		await this.adapter.write(path, text);
	}
}
