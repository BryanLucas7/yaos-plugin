/**
 * Server-applied state tracker for FU-8 (Level 3 ack).
 *
 * Captures a local candidate state vector on every ack-tracked local update,
 * compares it against server SV echoes received via provider custom-message,
 * and persists candidate state across plugin restarts so offline edits can be
 * confirmed after reconnect.
 *
 * This module is intentionally Obsidian-free so it can be tested under Node.
 * It does not import Y directly — callers pass encodeStateVector as a callback.
 */

import { isStateVectorGe } from "./stateVectorAck";
import { encodeBytesBase64, decodeBytesBase64 } from "./svEchoMessage";
import { isAckTrackedLocalOrigin } from "./ackOrigins";
import type { CandidateStore, ScopeKey, ScopeMetadata, PersistedCandidateState } from "./candidateStore";

export type { ScopeKey, ScopeMetadata, PersistedCandidateState } from "./candidateStore";

export type ServerAckState = {
	serverAppliedLocalState: boolean | null;
	// Timestamp of the last valid server SV echo this session. When
	// serverAppliedLocalState is false, this is historical and does not confirm
	// the current candidate.
	lastServerReceiptEchoAt: number | null;
	lastKnownServerReceiptEchoAt: number | null;
	candidatePersistenceHealthy: boolean;
	candidatePersistenceFailureCount: number;
	hasUnconfirmedCandidate: boolean;
	candidateCapturedAt: number | null;
};

export class ServerAckTracker {
	private _lastUnconfirmedCandidateSv: Uint8Array | null = null;
	private _candidateCapturedAt: number | null = null;
	private _serverAppliedLocalState: boolean | null = null;
	private _lastServerReceiptEchoAt: number | null = null;
	private _lastKnownServerReceiptEchoAt: number | null = null;
	private _candidatePersistenceHealthy = true;
	private _candidatePersistenceFailureCount = 0;

	private _encodeStateVector: (() => Uint8Array) | null = null;
	private _store: CandidateStore | null = null;
	private _scope: (ScopeKey & ScopeMetadata) | null = null;

	/**
	 * Attach to a Y.Doc update event stream. Must be called before onStartup.
	 *
	 * @param doc               Minimal doc interface — only the "update" event is used.
	 * @param encodeStateVector Callback to get the current doc state vector after a transaction.
	 *                          Typically () => Y.encodeStateVector(doc).
	 * @param provider          The sync provider object (remote updates use this as origin).
	 * @param persistence       The IDB persistence object (replay loads use this as origin).
	 */
	attach(
		doc: { on: (event: "update", handler: (update: Uint8Array, origin: unknown) => void) => void },
		encodeStateVector: () => Uint8Array,
		provider: unknown,
		persistence: unknown,
	): void {
		this._encodeStateVector = encodeStateVector;
		doc.on("update", (_update: Uint8Array, origin: unknown) => {
			if (isAckTrackedLocalOrigin(origin, provider, persistence)) {
				this._lastUnconfirmedCandidateSv = encodeStateVector();
				this._candidateCapturedAt = Date.now();
				this._serverAppliedLocalState = false;
				this._persistAsync();
			}
		});
	}

	/**
	 * Load persisted candidate state. Call after IDB has loaded CRDT state so
	 * encodeStateVector() reflects the fully-loaded document.
	 *
	 * Persisted serverAppliedLocalState=true is NOT restored as active truth —
	 * Level 3 is not durable. Candidate is validated against the current doc SV
	 * and active state stays null until a fresh server echo revalidates it.
	 */
	async onStartup(store: CandidateStore, scope: ScopeKey & ScopeMetadata): Promise<void> {
		this._store = store;
		this._scope = scope;

		let stored: PersistedCandidateState | null;
		try {
			stored = await store.load(scope);
		} catch {
			stored = null;
		}

		if (!stored || !stored.candidateSvBase64) return;

		const sv = decodeBytesBase64(stored.candidateSvBase64);
		if (!sv) return; // corrupt base64 — fail closed

		// attach() runs before persisted startup validation so early local edits
		// are not missed. If such a live candidate exists, startup must not
		// overwrite it with older persisted state.
		if (this._lastUnconfirmedCandidateSv === null) {
			this._lastUnconfirmedCandidateSv = sv;
			this._candidateCapturedAt = stored.candidateCapturedAt;
			// Active state is always null after startup — never restore true.
			this._serverAppliedLocalState = null;
		}
		this._lastKnownServerReceiptEchoAt = stored.lastKnownServerReceiptEchoAt;

		this._validateCandidateAgainstDoc();
	}

	/**
	 * Call when the server sends an SV echo (provider "custom-message" handler,
	 * after parsing with parseSvEchoMessage).
	 */
	recordServerSvEcho(serverSv: Uint8Array): void {
		this._lastServerReceiptEchoAt = Date.now();
		if (this._lastUnconfirmedCandidateSv !== null) {
			const confirmed = isStateVectorGe(serverSv, this._lastUnconfirmedCandidateSv);
			this._serverAppliedLocalState = confirmed;
			if (confirmed) {
				this._lastKnownServerReceiptEchoAt = this._lastServerReceiptEchoAt;
			}
		}
		this._persistAsync();
	}

	get serverAppliedLocalState(): boolean | null { return this._serverAppliedLocalState; }
	get lastServerReceiptEchoAt(): number | null { return this._lastServerReceiptEchoAt; }
	get lastKnownServerReceiptEchoAt(): number | null { return this._lastKnownServerReceiptEchoAt; }
	get candidatePersistenceHealthy(): boolean { return this._candidatePersistenceHealthy; }
	get candidatePersistenceFailureCount(): number { return this._candidatePersistenceFailureCount; }
	get hasUnconfirmedCandidate(): boolean { return this._lastUnconfirmedCandidateSv !== null; }
	get candidateCapturedAt(): number | null { return this._candidateCapturedAt; }

	getState(): ServerAckState {
		return {
			serverAppliedLocalState: this._serverAppliedLocalState,
			lastServerReceiptEchoAt: this._lastServerReceiptEchoAt,
			lastKnownServerReceiptEchoAt: this._lastKnownServerReceiptEchoAt,
			candidatePersistenceHealthy: this._candidatePersistenceHealthy,
			candidatePersistenceFailureCount: this._candidatePersistenceFailureCount,
			hasUnconfirmedCandidate: this._lastUnconfirmedCandidateSv !== null,
			candidateCapturedAt: this._candidateCapturedAt,
		};
	}

	async clearLocalReceiptState(clearStore = true): Promise<void> {
		this._lastUnconfirmedCandidateSv = null;
		this._candidateCapturedAt = null;
		this._serverAppliedLocalState = null;
		this._lastServerReceiptEchoAt = null;
		this._lastKnownServerReceiptEchoAt = null;
		if (clearStore && this._store) {
			try {
				await this._store.clear();
				this._candidatePersistenceHealthy = true;
			} catch {
				this._candidatePersistenceFailureCount++;
				this._candidatePersistenceHealthy = false;
			}
		}
	}

	// ── Private ──────────────────────────────────────────────────────────────

	private _validateCandidateAgainstDoc(): void {
		if (!this._lastUnconfirmedCandidateSv || !this._encodeStateVector) return;
		const currentSv = this._encodeStateVector();
		const docDominatesCandidate = isStateVectorGe(currentSv, this._lastUnconfirmedCandidateSv);
		const candidateDominatesDoc = isStateVectorGe(this._lastUnconfirmedCandidateSv, currentSv);

		if (docDominatesCandidate && candidateDominatesDoc) {
			// Equal — candidate is valid; wait for fresh echo.
			return;
		}

		if (docDominatesCandidate && !candidateDominatesDoc) {
			// Local doc advanced past candidate (e.g. IDB crash gap, merged offline edits).
			// Replace candidate with current doc SV and mark unconfirmed.
			// This is conservative: the new candidate may include remote state, but the
			// server dominance check prevents that from producing a false true.
			this._lastUnconfirmedCandidateSv = currentSv;
			this._candidateCapturedAt = Date.now();
			this._serverAppliedLocalState = false;
			this._persistAsync();
			return;
		}

		// candidateAheadOfDoc or incomparable — discard, fail closed.
		this._lastUnconfirmedCandidateSv = null;
		this._candidateCapturedAt = null;
		this._serverAppliedLocalState = null;
		this._persistAsync();
	}

	private _persistAsync(): void {
		if (!this._store || !this._scope) return;
		// Restart-safe receipt after offline edits depends on this async write
		// completing before shutdown. Until it does, the in-memory candidate is
		// authoritative only for the current plugin session.
		const state: PersistedCandidateState = {
			schema: 1,
			...this._scope,
			candidateSvBase64: this._lastUnconfirmedCandidateSv
				? encodeBytesBase64(this._lastUnconfirmedCandidateSv)
				: null,
			candidateCapturedAt: this._candidateCapturedAt,
			lastKnownServerReceiptEchoAt: this._lastKnownServerReceiptEchoAt,
		};
		this._store.save(state).then(() => {
			if (!this._candidatePersistenceHealthy) {
				this._candidatePersistenceHealthy = true;
			}
		}).catch(() => {
			this._candidatePersistenceFailureCount++;
			this._candidatePersistenceHealthy = false;
		});
	}
}
