/**
 * Client-side wrapper for the remote profile lock.
 *
 * Reads via GET /vault/<vaultId>/profile-lock.
 * Writes via PUT /vault/<vaultId>/profile-lock with CAS.
 *
 * Lives on the plugin side; the server's ProfileLockStore is the canonical
 * source of truth.
 */

import { requestUrl } from "obsidian";
import {
	emptyProfileLock,
	isProfileLock,
	type ProfileLock,
	type ProfileLockCasResult,
	type ProfileLockPutBody,
} from "./profileLock";

export interface ProfileLockTransport {
	/** GET the current lock; returns null if none has been published yet. */
	getLock(): Promise<ProfileLock | null>;
	/**
	 * Attempt CAS publish. Returns "accepted" with the persisted lock or
	 * "stale-base" with the current remote lock if the publisher's
	 * baseGeneration is no longer current.
	 */
	putLock(body: ProfileLockPutBody): Promise<ProfileLockCasResult>;
}

export interface ProfileLockEndpoint {
	host: string;
	vaultId: string;
	token: string;
}

export class HttpProfileLockTransport implements ProfileLockTransport {
	constructor(private readonly endpoint: ProfileLockEndpoint) {}

	private url(): string {
		const host = this.endpoint.host.replace(/\/$/, "");
		return `${host}/vault/${encodeURIComponent(this.endpoint.vaultId)}/profile-lock`;
	}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		return {
			Authorization: `Bearer ${this.endpoint.token}`,
			...extra,
		};
	}

	async getLock(): Promise<ProfileLock | null> {
		const response = await requestUrl({
			url: this.url(),
			method: "GET",
			headers: this.headers(),
		});
		if (response.status !== 200) {
			throw new Error(`profile-lock GET failed (${response.status})`);
		}
		const body = response.json as { lock?: unknown };
		if (!isProfileLock(body.lock)) return null;
		return body.lock;
	}

	async putLock(body: ProfileLockPutBody): Promise<ProfileLockCasResult> {
		const response = await requestUrl({
			url: this.url(),
			method: "PUT",
			headers: this.headers(),
			contentType: "application/json",
			body: JSON.stringify(body),
		});

		if (response.status === 409) {
			const data = response.json as { current?: unknown };
			const current = isProfileLock(data.current) ? data.current : emptyProfileLock();
			return { kind: "stale-base", current };
		}

		if (response.status !== 200) {
			throw new Error(`profile-lock PUT failed (${response.status})`);
		}

		const data = response.json as { lock?: unknown };
		if (!isProfileLock(data.lock)) {
			throw new Error("profile-lock PUT returned malformed payload");
		}
		return { kind: "accepted", lock: data.lock };
	}
}
