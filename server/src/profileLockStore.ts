/**
 * ProfileLockStore — single source of truth for the profile lock inside the
 * Durable Object. Provides compare-and-swap semantics: a PUT is accepted
 * only when the publisher's baseGeneration matches the currently-stored
 * lock's generation.
 *
 * The store DOES NOT touch WebSockets. Broadcast happens in server.ts after
 * a CAS-accepted PUT so the storage layer stays test-friendly.
 */

const PROFILE_LOCK_KEY = "profileLock";
export const PROFILE_LOCK_VERSION = 1;
export const PROFILE_WS_LOCK_UPDATED = "__YAOS_PROFILE:lock-updated";

export interface ProfileManifestRefDTO {
	profile: "desktop" | "mobile";
	kind: "real" | "bootstrap";
	manifestHash: string;
	fileCount: number;
	totalBytes: number;
	createdAt: string;
	sourceDeviceId: string;
}

export interface PluginVersionLockDTO {
	pluginId: string;
	version: string;
	repo?: string;
	isDesktopOnly: boolean;
	allowedProfiles: Array<"desktop" | "mobile">;
	codeManifestHash: string;
	fileCount: number;
	totalBytes: number;
	updatedAt: string;
	sourceDeviceId: string;
}

export interface ProfileLockDTO {
	version: 1;
	generation: string;
	previousGeneration: string;
	publishedAt: string;
	publishedByDeviceId: string;
	publishedByDeviceName: string;
	baseGeneration: string;
	pluginLocks: Record<string, PluginVersionLockDTO>;
	profileManifests: Partial<Record<"desktop" | "mobile", ProfileManifestRefDTO>>;
}

export type CasResult =
	| { kind: "accepted"; lock: ProfileLockDTO }
	| { kind: "stale-base"; current: ProfileLockDTO | null };

export interface ProfileLockStorageLike {
	get<T = unknown>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	transaction?<T>(fn: (txn: unknown) => Promise<T>): Promise<T>;
}

export function isProfileLockDTO(value: unknown): value is ProfileLockDTO {
	if (typeof value !== "object" || value === null) return false;
	const v = value as ProfileLockDTO;
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

/**
 * In-process serializer that prevents two CAS attempts from interleaving
 * against the same DO. The DO is single-threaded but `await` boundaries can
 * still let a second request observe a stale read; serializing here keeps
 * the sequence read-current → compare → write atomic from the caller's
 * perspective.
 */
class CasSerializer {
	private chain: Promise<void> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.then(fn, fn);
		this.chain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}

export class ProfileLockStore {
	private readonly serializer = new CasSerializer();

	constructor(private readonly storage: ProfileLockStorageLike) {}

	async read(): Promise<ProfileLockDTO | null> {
		const raw = await this.storage.get(PROFILE_LOCK_KEY);
		if (!isProfileLockDTO(raw)) return null;
		return raw;
	}

	/**
	 * Compare-and-swap: accept `nextLock` only if `baseGeneration` equals the
	 * stored lock's current generation. When no lock exists yet, only an
	 * empty baseGeneration is accepted (initial publish).
	 *
	 * Returns "accepted" with the stored lock on success, or "stale-base"
	 * with the currently-stored lock on rejection.
	 */
	async cas(
		baseGeneration: string,
		nextLock: ProfileLockDTO,
	): Promise<CasResult> {
		return this.serializer.run(async () => {
			const current = await this.read();
			const currentGeneration = current?.generation ?? "";
			if (baseGeneration !== currentGeneration) {
				return { kind: "stale-base", current };
			}
			if (nextLock.baseGeneration !== baseGeneration) {
				return { kind: "stale-base", current };
			}
			if (current && nextLock.generation === currentGeneration) {
				return { kind: "stale-base", current };
			}
			await this.storage.put(PROFILE_LOCK_KEY, nextLock);
			return { kind: "accepted", lock: nextLock };
		});
	}
}
