/**
 * ProfilePublisher — orchestrates a single publish attempt for one profile.
 *
 * Each profile gets its own ProfilePublisher instance with its own dirty
 * set, debounce timer, baseGeneration, and policy. Desktop and mobile
 * publishers may share a transport but never a fila/debounce.
 *
 * The trust model splits two permissions:
 *   - canPublishProfile  → may publish per-profile manifests
 *   - canPublishPluginCode → may publish PluginCodeManifest + pluginLocks
 *
 * On stale-base, the publisher rebases locally (not via Y.Doc) and retries.
 * No Y.Doc writes — all CAS goes through the Durable Object via transport.
 */

import {
	emptyProfileLock,
	type ProfileLock,
	type ProfileLockCasResult,
	type ProfileManifest,
	type PluginVersionLock,
	type ProfileManifestRef,
} from "./profileLock";
import type { Profile, ProfilePolicy } from "./profilePolicy";
import {
	buildProfileManifest,
	type ScannedConfigDir,
	synthesizeCommunityPluginsJson,
} from "./profileManifest";
import { buildPluginCodeManifests, type BuiltPluginCode } from "./pluginCodeManifest";
import { canonicalJsonBytes, sha256Hex } from "./profileTransport";

export interface PublisherTransport {
	getLock(): Promise<ProfileLock | null>;
	putLock(body: { baseGeneration: string; nextLock: ProfileLock }): Promise<ProfileLockCasResult>;
	uploadJsonBlob(value: unknown): Promise<string>;
	existsBatch(hashes: string[]): Promise<Set<string>>;
	uploadBlob(bytes: Uint8Array, expectedHash: string): Promise<void>;
}

export interface PublisherTrust {
	canPublishProfile: boolean;
	canPublishPluginCode: boolean;
}

export interface ProfilePublisherDeps {
	profile: Profile;
	policy: ProfilePolicy;
	transport: PublisherTransport;
	trust: PublisherTrust;
	deviceId: string;
	deviceName: string;
	now(): string;
	nextGeneration(previous: string): string;
	/** Optional hook to look up Lazy `instant` ids for the mobile profile. */
	getInstantPluginIds?(profile: Profile): ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
	/** Used to capture the synthesized community-plugins.json so it can also be uploaded as a blob. */
	getCommunityPluginsHash?(synthesized: string[]): Promise<{ hash: string; size: number }>;
}

export type PublishOutcome =
	| { kind: "accepted"; lock: ProfileLock; manifestHash: string }
	| { kind: "rebased-and-accepted"; lock: ProfileLock; manifestHash: string; rebases: number }
	| { kind: "no-permission" }
	| { kind: "max-rebases-exceeded"; current: ProfileLock };

const MAX_REBASES = 3;
const SYNTHESIZED_COMMUNITY_PLUGINS_PATH = "community-plugins.json";

interface ScannedBlob {
	path: string;
	hash: string;
	size: number;
	bytes?: Uint8Array;
}

export class ProfilePublisher {
	private readonly dirtyPaths = new Set<string>();
	private debounceHandle: ReturnType<typeof setTimeout> | null = null;
	private lastBaseGeneration = "";

	constructor(private readonly deps: ProfilePublisherDeps) {}

	get profile(): Profile {
		return this.deps.profile;
	}

	get baseGeneration(): string {
		return this.lastBaseGeneration;
	}

	/** Mark a path as dirty (a publisher has detected a relevant change). */
	markDirty(path: string): void {
		this.dirtyPaths.add(path);
	}

	hasDirtyPaths(): boolean {
		return this.dirtyPaths.size > 0;
	}

	clearDirty(): void {
		this.dirtyPaths.clear();
	}

	scheduleDebounced(scan: () => Promise<ScannedConfigDir>, debounceMs: number, maxWaitMs: number): void {
		if (this.debounceHandle) clearTimeout(this.debounceHandle);
		const startedAt = Date.now();
		const fire = () => {
			void this.publish(scan).catch(() => undefined);
		};
		this.debounceHandle = setTimeout(() => {
			if (Date.now() - startedAt >= maxWaitMs || this.dirtyPaths.size > 0) fire();
		}, debounceMs);
	}

	async publish(scan: () => Promise<ScannedConfigDir>): Promise<PublishOutcome> {
		if (!this.deps.trust.canPublishProfile && !this.deps.trust.canPublishPluginCode) {
			return { kind: "no-permission" };
		}

		let attempt = 0;
		let current: ProfileLock | null = await this.deps.transport.getLock();

		while (attempt <= MAX_REBASES) {
			const baseGeneration = current?.generation ?? "";
			this.lastBaseGeneration = baseGeneration;

			const scannedDir = await scan();
			const generation = this.deps.nextGeneration(baseGeneration);
			const createdAt = this.deps.now();

			const profileManifest = buildProfileManifest({
				scan: scannedDir,
				profile: this.deps.profile,
				policy: this.deps.policy,
				generation,
				baseGeneration,
				createdAt,
				sourceDeviceId: this.deps.deviceId,
			});

			const synthesized = synthesizeCommunityPluginsJson({
				scan: scannedDir,
				profile: this.deps.profile,
				policy: this.deps.policy,
				instantPluginIdsForProfile: await this.deps.getInstantPluginIds?.(this.deps.profile),
			});

			let community: { hash: string; size: number } | null = null;
			if (this.deps.trust.canPublishProfile) {
				if (this.deps.getCommunityPluginsHash) {
					community = await this.deps.getCommunityPluginsHash(synthesized);
				} else {
					const bytes = canonicalJsonBytes(synthesized);
					const hash = await sha256Hex(bytes);
					await this.deps.transport.uploadBlob(bytes, hash);
					community = { hash, size: bytes.byteLength };
				}
				if (community) {
					profileManifest.files.push({
						path: SYNTHESIZED_COMMUNITY_PLUGINS_PATH,
						hash: community.hash,
						size: community.size,
						kind: "config",
						applyPhase: "activation-last",
					});
					profileManifest.files.sort((a, b) => a.path.localeCompare(b.path));
				}
			}

			const pluginCodeBuilt: BuiltPluginCode[] = this.deps.trust.canPublishPluginCode
				? buildPluginCodeManifests({
					plugins: scannedDir.plugins,
					policy: this.deps.policy,
					generation,
					createdAt,
					sourceDeviceId: this.deps.deviceId,
				})
				: [];

			await this.uploadReferencedContentBlobs({
				scannedDir,
				profileManifest,
				pluginCodeBuilt,
				uploadProfileBlobs: this.deps.trust.canPublishProfile,
				uploadPluginCodeBlobs: this.deps.trust.canPublishPluginCode,
			});

			const manifestHash = this.deps.trust.canPublishProfile
				? await this.deps.transport.uploadJsonBlob(profileManifest)
				: "";

			const codeManifestHashByPluginId = new Map<string, string>();
			for (const built of pluginCodeBuilt) {
				const hash = await this.deps.transport.uploadJsonBlob(built.manifest);
				codeManifestHashByPluginId.set(built.pluginLock.pluginId, hash);
			}

			const nextLock = this.composeNextLock({
				current,
				profileManifest,
				manifestHash,
				pluginCodeBuilt,
				codeManifestHashByPluginId,
				generation,
				baseGeneration,
				createdAt,
			});

			const cas = await this.deps.transport.putLock({ baseGeneration, nextLock });
			if (cas.kind === "accepted") {
				this.clearDirty();
				return attempt === 0
					? { kind: "accepted", lock: cas.lock, manifestHash }
					: { kind: "rebased-and-accepted", lock: cas.lock, manifestHash, rebases: attempt };
			}

			current = cas.current;
			attempt++;
		}

		return {
			kind: "max-rebases-exceeded",
			current: current ?? emptyProfileLock(),
		};
	}

	private composeNextLock(args: {
		current: ProfileLock | null;
		profileManifest: ProfileManifest;
		manifestHash: string;
		pluginCodeBuilt: BuiltPluginCode[];
		codeManifestHashByPluginId: Map<string, string>;
		generation: string;
		baseGeneration: string;
		createdAt: string;
	}): ProfileLock {
		const baseLock = args.current ?? emptyProfileLock();
		const profileManifests = { ...baseLock.profileManifests };

		if (this.deps.trust.canPublishProfile) {
			const ref: ProfileManifestRef = {
				profile: this.deps.profile,
				kind: "real",
				manifestHash: args.manifestHash,
				fileCount: args.profileManifest.files.length,
				totalBytes: args.profileManifest.files.reduce((sum, f) => sum + f.size, 0),
				createdAt: args.createdAt,
				sourceDeviceId: this.deps.deviceId,
			};
			profileManifests[this.deps.profile] = ref;
		}

		const pluginLocks = { ...baseLock.pluginLocks };
		if (this.deps.trust.canPublishPluginCode) {
			for (const built of args.pluginCodeBuilt) {
				const codeManifestHash = args.codeManifestHashByPluginId.get(built.pluginLock.pluginId)!;
				const fullLock: PluginVersionLock = { ...built.pluginLock, codeManifestHash };
				pluginLocks[built.pluginLock.pluginId] = fullLock;
			}
		}

		return {
			version: 1,
			generation: args.generation,
			previousGeneration: baseLock.generation,
			publishedAt: args.createdAt,
			publishedByDeviceId: this.deps.deviceId,
			publishedByDeviceName: this.deps.deviceName,
			baseGeneration: args.baseGeneration,
			pluginLocks,
			profileManifests,
		};
	}

	private async uploadReferencedContentBlobs(args: {
		scannedDir: ScannedConfigDir;
		profileManifest: ProfileManifest;
		pluginCodeBuilt: BuiltPluginCode[];
		uploadProfileBlobs: boolean;
		uploadPluginCodeBlobs: boolean;
	}): Promise<void> {
		const blobsByPath = this.indexScannedBlobs(args.scannedDir);
		const required = new Map<string, ScannedBlob>();

		const requireBlob = (file: { path: string; hash: string; size: number }) => {
			if (file.path === SYNTHESIZED_COMMUNITY_PLUGINS_PATH) return;
			const blob = blobsByPath.get(file.path);
			if (!blob?.bytes) {
				throw new Error(`profile publish missing content bytes for ${file.path}`);
			}
			if (blob.hash !== file.hash || blob.size !== file.size) {
				throw new Error(`profile publish scan mismatch for ${file.path}`);
			}
			required.set(file.hash, blob);
		};

		if (args.uploadProfileBlobs) {
			for (const file of args.profileManifest.files) {
				requireBlob(file);
			}
		}

		if (args.uploadPluginCodeBlobs) {
			for (const built of args.pluginCodeBuilt) {
				for (const file of built.manifest.files) {
					requireBlob(file);
				}
			}
		}

		if (required.size === 0) return;
		const hashes = Array.from(required.keys());
		const present = await this.deps.transport.existsBatch(hashes);
		for (const hash of hashes) {
			if (present.has(hash)) continue;
			const blob = required.get(hash)!;
			await this.deps.transport.uploadBlob(blob.bytes!, hash);
		}
	}

	private indexScannedBlobs(scan: ScannedConfigDir): Map<string, ScannedBlob> {
		const out = new Map<string, ScannedBlob>();
		for (const root of scan.rootConfigFiles) {
			out.set(root.name, {
				path: root.name,
				hash: root.hash,
				size: root.size,
				bytes: root.bytes,
			});
		}
		for (const file of [...scan.snippetFiles, ...scan.themeFiles, ...scan.iconFiles]) {
			out.set(file.path, file);
		}
		for (const plugin of scan.plugins) {
			if (plugin.dataJson) {
				const path = `plugins/${plugin.pluginId}/data.json`;
				out.set(path, { path, ...plugin.dataJson });
			}
			for (const file of plugin.otherBehaviorFiles) {
				out.set(file.path, file);
			}
			for (const file of plugin.codeFiles) {
				out.set(file.path, file);
			}
		}
		return out;
	}
}
