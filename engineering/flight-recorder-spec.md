YAOS Flight Recorder Spec (v3)

Purpose
- Reconstruct the exact lifecycle of a file/event across disk -> CRDT -> server -> other device -> disk.
- Make every authority decision auditable: what happened, where, which file, which operation, what decision, why.
- Answer, for any bug report: who observed the change, what origin, what CRDT state before/after, did the server receive it, did another device apply it, was anything blocked, quarantined, or safety-braked?

Non-goals
- No observability framework, no dashboards, no React UI.
- No note contents, tokens, or raw server URLs in safe/qa-safe traces.
- Logging must never block sync.
- Do not build the analyzer before the recorder works correctly.

Principles
- Log decisions and state transitions, not freeform prose.
- Every file-scoped event (scope === "file") must have pathId. No exceptions.
- Every decision event requires decision, reason, and opId.
- Safe-by-default. Export must validate mode before writing.
- Stable boring taxonomy. No naming drift.
- Causality is first-class. opId must propagate through the full same-device chain.
- Local ordering must reflect causality. Async path identity must not reorder events.

---

Implementation Status After Review 3+4

What was implemented and is correct:
- PathIdentityResolver: async SHA-256 promise cache, 128-bit output, pd: degraded prefix
- FlightRecorder: safeToShare/includesFilenames/exportable getters, validateSafeEvent deep guard
- Priority-aware queue: { line, priority } entries, verbose-first eviction, critical never evicted
- recordPath() returns Promise<void>, pending promises tracked, flush() drains them
- Export: mode validation, refuses unsafe/local-private, flush before read, manifest first line
- opId threading: disk observation -> markMarkdownDirty -> processDirtyMarkdownPath -> syncFileFromDisk -> ensureFile -> crdt.file.created/updated
- handleDelete accepts opId, crdt.file.tombstoned carries it
- crdt.file.updated wired after applyDiffToYText
- Event naming: disk.create.observed, disk.modify.observed, disk.delete.observed (source: vaultEvents)
- kind: FlightKind enforced in types, FLIGHT_KIND constants cover Phase A events
- FlightSink interface defined and used at reconciliationController boundary
- Log rotation: 10 MB per file, 7-day retention, 100 MB total cap, YAOS: Clear flight logs command
- rebuildIndexesFromRing() after every ring trim
- Manual start vs settings separation (manualStart flag in state)
- URL canonicalization (new URL(host).origin, vaultId.trim())
- qaTraceSecret UX (password input, generate/copy/clear buttons)
- 44/44 regression suites pass, tsc --noEmit clean

What is broken or missing (from reviews 3+4):
See triage below.

---

Triage of Review 3+4 Findings

P0 — Fix before any further coding. These break the recorder's contract.

P0-6: CRDT file events have no pathId
  Current: ensureFile, handleDelete emit via onFlightEvent({...}) without pathId.
    Events carry only fileId + opId.
    "Show timeline for current file" command cannot find these events.
    The recorder is indexing by pathId but CRDT events bypass the path layer.
  Rule: If scope === "file", the final recorded event must have pathId.
  Fix:
    Route all CRDT file events through recordFlightPathEvent (or the new FlightSink.recordPath).
    VaultSync.ensureFile, handleDelete, and reconciliationController.syncFileFromDisk
    already have `path` at the call site. Do not discard it.
    Pattern:
      Instead of: this.onFlightEvent?.({ kind: crdtFileCreated, fileId, opId })
      Do:         this.onFlightPathEvent?.({ kind: crdtFileCreated, path, fileId, opId, ... })
    The controller resolves path -> pathId, then records.
    In safe/qa-safe mode: pathId is present, path field is absent.
    In full mode: both are present.
  Tests:
    recorder.getTimelineForPath(p1) includes crdt.file.created for that path
    CRDT tombstone event for path X appears in timeline for path X

P0-7: Export after rotation only reads current segment
  Current: exportTrace() reads only this.recorder.currentSessionPath (one file).
    After rotation, earlier segments (bootId-1.ndjson, bootId-2.ndjson) are lost.
    A holy QA trace that rotated loses all evidence before the bug symptom.
  Fix:
    Export must concatenate all segments for the active boot session:
      1. List all files matching {bootId}-*.ndjson in the session day directory.
      2. Sort by segment index (numeric suffix).
      3. Concatenate in order.
      4. Prepend export.manifest with segmentCount.
    If a session spans multiple days (unlikely but possible after midnight), check
    both current and previous day directories for matching bootId files.
  Tests:
    Write enough events to force rotation.
    Export.
    Assert exported output contains events from segment 1 and segment 2.
    Assert segmentCount in manifest matches actual segment count.

P0-8: Async path hashing can reorder causally related events
  Current: recordPath(disk.modify) is async (awaits SHA-256 path identity).
    record(crdt.file.updated) is synchronous and writes immediately.
    If both are called in sequence, the CRDT event can appear in the log
    before the disk event that caused it.
  This violates the recorder's causal ordering contract.
  Fix: Reserve sequence number (seq) synchronously at call time for ALL events.
    Option A (preferred): recordPath() calls ++seq synchronously, stores the
      pending event with its assigned seq, then resolves path identity and writes
      the event with the pre-assigned seq. The log is sorted by seq, which
      reflects call order regardless of async resolution time.
    Option B: All events (path and non-path) go through one ordered queue.
      Path hashing resolves inside the queue. Events are written in queue order.
    Option C (rejected): Tolerate drift and rely on opId for reconstruction.
      Bad. A flight recorder must have correct local ordering.
  Tests:
    Use a deliberately slow sha256Hex (add 50ms delay).
    Call recordPath(disk.modify), then immediately record(crdt.file.updated).
    Assert final NDJSON output has disk.modify.observed before crdt.file.updated
    (by seq number and/or by file position).

P0-9: redaction.failure must not leak the offending value
  Current: recordRedactionFailure(originalKind, leakedKey) emits:
    data: { originalKind, leakedKey }
  This is correct (key name only, no value). But verify:
    - No error message includes the path/value.
    - No console.error includes the raw value in safe mode.
    - No stack trace or JSON.stringify of the original event.
  Additional requirement:
    Track redaction failure counts:
      redactionDroppedCount (in FlightRecorder)
      redactionDroppedByKind: Map<string, number>
    Surface in export manifest:
      data: { ..., redaction: { droppedEvents: N, droppedKinds: {...} } }
    If redaction dropped critical events, manifest should include:
      redactionWarning: "This trace is privacy-safe but incomplete."
  Tests:
    Emit event with data: { path: "Secret/Thesis.md" } in safe mode.
    Assert redaction.failure event has key name "path" but NOT value "Secret/Thesis.md".
    Assert console.error does not include "Secret/Thesis.md".

P0-10: Degraded path identity (pd: prefix) should make trace unsafe
  Current: If sha256Hex throws, fallbackPathId uses FNV-1a and returns pd: prefix.
    hasDegraded becomes true. But safeToShare still returns true.
  Problem: FNV-1a 32-bit is dictionary-attackable for common vault paths
    (Daily/2026-05-12.md, Projects/Todo.md, Inbox.md). A "safe" trace with
    degraded path IDs is not actually safe.
  Fix:
    If PathIdentityResolver.hasDegraded is true at export time:
      safeToShare must return false.
      Export safe must be refused with reason: "trace-degraded-path-identity".
    OR:
      When degraded mode activates, stop the trace and refuse to continue in
      safe/qa-safe mode. Only full/local-private may continue with FNV.
    Preferred: Stop the trace. Degraded crypto means the environment is broken.
    Emit path.identity.degraded event with severity: error.
    Manifest includes: pathIdentityDegraded: true.
  Tests:
    Force sha256Hex to throw.
    Assert hasDegraded becomes true.
    Assert safe export is refused.
    OR assert trace stops immediately.

---

P1 — Fix before lifecycle proof test. These prevent causality from being proven.

P1-6: opId still optional at some file mutation boundaries
  Current: processDirtyMarkdownPath(path, "modify", undefined) for closed-only
    deferred imports passes no opId. This creates a causal hole.
  Rule: Every file mutation event must have an opId. If no upstream opId exists,
    generate one at the boundary where the mutation decision is made.
  Fix:
    In maybeImportDeferredClosedOnlyPath:
      const deferredOpId = this.newOpId("closed-only-deferred");
      void this.processDirtyMarkdownPath(path, "modify", deferredOpId)
    In any other path that calls processDirtyMarkdownPath without opId:
      generate one immediately.
    Rule: opId is optional in the type. But runtime code must always provide one
    for scope: "file" events. Add an assertion in debug mode.

P1-7: Coalesced dirty paths lose causality
  Current: dirtyMarkdownPaths = Map<string, { reason, opId? }>
    Multiple disk events for same path before drain: only last { reason, opId } survives.
    The other opIds are silently lost. The flight recorder cannot explain
    "this import was triggered by 3 rapid edits."
  Fix:
    Change dirty state to:
      type DirtyMarkdownState = {
        reason: "create" | "modify";
        primaryOpId: string;       // the one that will be used for the CRDT mutation
        coalescedOpIds: string[];   // all disk observation opIds that fed into this import
      };
    When markMarkdownDirty is called for a path that's already dirty:
      Append the new opId to coalescedOpIds.
      If current reason is "modify" and new reason is "create": keep "create" (higher priority).
    The crdt.file.updated or crdt.file.created event should carry:
      opId: primaryOpId (the one that survives)
      data: { coalescedOpIds: [...] } (if more than one)
    This lets the analyzer say: "this import coalesced 3 disk events."

P1-8: Server receipt events have no causal linkage
  Current: server.receipt.candidate_captured, server.sv_echo.seen, and
    server.receipt.confirmed events exist but carry no candidateId, svHash,
    causedByOpId, or originKind.
  This means: "server confirmed something" but cannot prove WHICH file operation
    was confirmed. The chain disk -> CRDT -> server receipt is unprovable.
  Fix:
    Minimum for lifecycle proof:
      server.receipt.candidate_captured must include:
        candidateId: string   (generated at capture time, passed through to confirmed)
        svHash: string        (first 32 hex chars of SHA-256 of state vector bytes)
        causedByOpId?: string (opId of the CRDT mutation that triggered the capture)
        originKind: string    (from ackOrigins classifier: disk-sync, seed, recovery, etc.)
      server.sv_echo.seen must include:
        candidateId (matches the candidate this echo might confirm)
        echoSvHash: string
      server.receipt.confirmed must include:
        candidateId
        serverSvHash: string
        dominatesCandidate: boolean
    To wire causedByOpId:
      ServerAckTracker must store the opId of the most recent CRDT update that
      triggered candidate capture. The simplest approach: when a Y.Doc update
      transaction completes and a new state vector is captured, attach the current
      active opId (from the most recent syncFileFromDisk/ensureFile call).

P1-9: Lifecycle proof test still missing
  This is the gating test for "the recorder works."
  Required test:
    1. Start a trace in safe mode.
    2. Simulate a disk create event for path "test/file.md" with opId op1.
    3. Call markMarkdownDirty -> processDirtyMarkdownPath -> syncFileFromDisk -> ensureFile
       (or mock the chain to emit the correct events).
    4. Assert disk.create.observed emitted with opId=op1, pathId=p1.
    5. Assert crdt.file.created emitted with opId=op1, pathId=p1.
    6. Simulate server receipt candidate capture with causedByOpId=op1.
    7. Assert server.receipt.candidate_captured with causedByOpId=op1.
    8. Assert recorder.getTimelineForPath(p1) contains all three events in order.
    9. Assert recorder.getTimelineForOp(op1) contains disk + crdt events.
    10. Assert no raw path appears anywhere in serialized output.
  This test may require mocking VaultSync/Y.Doc at the flight event boundary.
  It does NOT need a full Y.Doc integration.

P1-10: Rotation chunk > MAX_ACTIVE_FILE_BYTES
  Current: rotateFile() is called if bytesWritten + chunk.length > MAX.
    Then chunk is appended to the NEW file regardless of chunk size.
    If chunk itself is > MAX (unlikely but possible with huge event storm after
    a long timer delay), a single file can be arbitrarily large.
  Fix:
    Cap pending flush size: MAX_PENDING_CHARS should be <= MAX_ACTIVE_FILE_BYTES / 2.
    This ensures no single flush chunk can exceed the file size limit by more than
    the max single event line size (~4 KB).
    If flushIntervalMs is increased or buffer is large, this bound still holds
    because admission policy limits total pending chars.
  This is low risk but should be validated.

---

P2 — Fix before holy QA run.

P2-8: No remote materialization events
  Cannot answer: "Did the other device write the file to disk?"
  Required (source: diskMirror):
    disk.remote.write_queued   (pathId, causedByConnectionGeneration)
    disk.remote.write_ok       (pathId, opId, bytesWritten)
    disk.remote.write_failed   (pathId, opId, error, priority: critical)
  These are emitted from DiskMirror.scheduleWrite/executeWrite when the write
  was triggered by a remote CRDT observer (not a local edit).
  Additionally:
    provider.remote_update.applied (scope: vault, connectionGeneration)
    — emitted when the provider sync delivers a Y.Doc update from the server.

P2-9: clearLogs() should not require recorder or settings
  Current: clearLogs() in FlightTraceController creates a dummy FlightRecorder
    just to get the logs root path, and only if vaultId + host are present.
  Problem: A user should be able to clear flight logs even if YAOS is unconfigured
    or the settings are broken. The logs directory is deterministic:
      .obsidian/plugins/yaos/flight-logs/
  Fix:
    Extract a pure helper:
      async function clearFlightLogs(app: App): Promise<void>
    No settings. No vault ID. No host. No fake recorder.
    Just delete the directory contents.
    FlightTraceController.clearLogs() calls this helper + stops active trace.

P2-10: Export manifest missing key fields
  Current manifest includes: mode, includesFilenames, schemaVersion, taxonomyVersion, exportedAt.
  Required additions:
    segmentCount: number         (how many NDJSON files were concatenated)
    eventCount: number           (total event lines in the export, excluding manifest)
    sessionStartedAt: string     (ISO timestamp of first event)
    sessionEndedAt: string       (ISO timestamp of last event)
    droppedEvents: { count, byPriority: {...} }
    redaction: { droppedEvents: number, droppedKinds: {...} }
    pathIdentityDegraded: boolean
    rotated: boolean             (true if session rotated at least once)
    bootId: string
    traceId: string

P2-11: normalizePath from obsidian in pathIdentity.ts
  Current: pathIdentity.ts imports normalizePath from "obsidian".
    This makes the module unusable in Node-based analyzer tools without a mock.
  Fix:
    Replace with a local normalizer:
      function normalizeTracePath(path: string): string {
        return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "");
      }
    This does the same thing Obsidian's normalizePath does for vault paths.
    The analyzer can then import pathIdentity.ts directly.

P2-12: validateSafeEvent guard too blunt for full/local-private mode
  Current: validateSafeEvent guard runs for all modes that have safeToShare=true.
    In full mode, path in data is intentional and correct.
  Rule:
    safe / qa-safe: reject events with any SENSITIVE_DATA_KEYS in data. Period.
    full: allow path-related keys in data. Still forbid: token, qaTraceSecret.
    local-private: same as full.
  Current code checks `if (this.safeToShare && event.data)` which is correct.
  But verify the "forbidden even in full mode" keys:
    token: never allowed in any mode.
    qaTraceSecret: never allowed in any mode.
  These two must be checked even in full/local-private.

P2-13: Path identity is keyed SHA-256, not HMAC — document honestly
  Current: computePathId does sha256Hex(`${secret}\u0000${normalizedPath}`).
    Spec language sometimes says "HMAC" but this is not HMAC.
  HMAC provides additional security properties (key separation, no length extension).
  Decision: For this use case (non-security path pseudonymization where the secret
    is ephemeral and never shared with adversaries), keyed SHA-256 is acceptable.
  Fix: Update all spec/doc language to say:
    "Keyed SHA-256 path pseudonymization: SHA256(secret || \0 || normalizedPath)"
  NOT: "HMAC." If we later want HMAC, use crypto.subtle.importKey with HMAC algorithm.

P2-14: full/local-private mode should not auto-resume after restart without confirmation
  Current: qaTraceEnabled=true with qaTraceMode=full survives restart and silently
    keeps writing filenames. This is bad taste for modes that include raw paths.
  Fix:
    On settings-driven start (refreshFromSettings):
      If mode is full or local-private: do NOT auto-start.
      Log a notice: "Full/local-private flight recorder mode requires manual start."
      Only safe and qa-safe may auto-resume from settings.
    Manual start (command): always works for all modes.

---

Remaining items from v2 triage (still required, not yet implemented):

P2-1: Disk write events (disk.write.planned/ok/failed, disk.event.not_suppressed)
P2-2: Recovery events (recovery.decision through recovery.quarantined)
P2-3: Per-file reconcile.file.decision
P2-4: Server receipt candidate identity (now P1-8 above, elevated in priority)
P2-5: Remote materialization events (now P2-8 above)
P2-7: Analyzer tooling (tools/merge-qa-logs.mjs, tools/analyze-qa-trace.mjs)

---

Updated Patch Order

Patch A: Make file events actually file-indexable (P0-6)
  - Route all CRDT file events through recordFlightPathEvent/FlightSink.recordPath
  - VaultSync emits via onFlightPathEvent (new callback) instead of onFlightEvent for file-scoped events
  - Assert every scope:"file" event in the ring has pathId
  - Tests: crdt.file.created appears in getTimelineForPath; tombstone appears in timeline

Patch B: Fix rotation export (P0-7, P1-10)
  - Export concatenates all {bootId}-*.ndjson segments for the active session
  - segmentCount in manifest
  - Cap MAX_PENDING_CHARS <= MAX_ACTIVE_FILE_BYTES / 2
  - Test: force rotation, export, assert events from both segments present

Patch C: Fix async ordering (P0-8)
  - Reserve seq number synchronously in recordPath() BEFORE async path resolution
  - Events written to NDJSON in seq order (queue sorts by pre-assigned seq if needed)
  - Test: slow sha256Hex + recordPath then record -> assert correct order in output

Patch D: Hardening (P0-9, P0-10, P2-12)
  - Verify redaction.failure never leaks value; add redaction counters to manifest
  - Degraded path identity -> refuse safe export (or stop trace)
  - Validate guard policy: safe/qa-safe vs full/local-private
  - Remove normalizePath obsidian dependency from pathIdentity.ts (P2-11)
  - Document keyed SHA-256 honestly (P2-13)

Patch E: opId rigor and coalesced ops (P1-6, P1-7)
  - Generate opId at boundary for all file mutation paths (no undefined)
  - DirtyMarkdownState stores coalescedOpIds[]
  - crdt.file.updated carries coalescedOpIds in data when >1

Patch F: Server receipt causal linkage (P1-8)
  - candidateId, svHash, causedByOpId, originKind on receipt events
  - ServerAckTracker stores current opId from most recent CRDT mutation
  - server.sv_echo.seen and server.receipt.confirmed carry candidateId

Patch G: Lifecycle proof test (P1-9)
  - Integration test: disk create -> CRDT create -> receipt candidate
  - Same pathId, coherent opId/causedByOpId
  - getTimelineForPath and getTimelineForOp return correct ordered events
  - No raw path in serialized output

Patch H: Housekeeping (P2-9, P2-10, P2-14)
  - clearFlightLogs as pure App helper
  - Full manifest fields
  - full/local-private mode does not auto-resume from settings

Patch I: Dangerous decision instrumentation (P2-1, P2-2, P2-3, P2-8)
  - disk.write.planned/ok/failed, disk.event.not_suppressed
  - recovery.* events
  - reconcile.file.decision
  - disk.remote.write_* events (remote materialization)

Patch J: Analyzer MVP (P2-7)
  - tools/merge-qa-logs.mjs
  - tools/analyze-qa-trace.mjs with rules:
    incomplete-lifecycle, crdt-no-receipt, receipt-stuck, overwrite-disk-changed,
    delete-revive-cycle, recovery-loop, suppression-miss, disk-write-failed,
    safety-brake, events-dropped-high, redaction-failures, missing-pathId

Only after Patch J: holy QA run.

---

Updated Definition of Done

Phase A complete when ALL of the following are true:

Privacy:
  [x] Safe export refuses unsafe recorder modes
  [x] No raw path in any safe/qa-safe event data (enforced by recorder guard)
  [x] PathIdentityResolver uses async SHA-256 in all normal paths
  [x] qaTraceSecret never appears in NDJSON output
  [ ] Degraded path identity refuses safe export or stops trace
  [ ] redaction.failure never leaks offending value (only key name + event kind)
  [ ] Redaction counters in export manifest

Causality:
  [ ] Every scope:"file" event has pathId (CRDT events routed through path layer)
  [ ] Lifecycle proof test passes (disk -> CRDT -> receipt, same pathId/opId)
  [ ] opId is never undefined for file mutation events (generate at boundary)
  [ ] Coalesced opIds tracked when dirty paths merge
  [ ] Server receipt candidate carries candidateId + causedByOpId
  [ ] Async path identity does not reorder local event timeline

Export:
  [x] flush() before read in all export paths
  [x] export.manifest as first line
  [x] Export refuses wrong privacy mode
  [ ] Export includes all rotation segments for the session
  [ ] Manifest includes segmentCount, eventCount, droppedEvents, redaction stats

Type safety:
  [x] kind: FlightKind (no string escape in Phase A call sites)
  [x] FlightSink at module boundaries (reconciliationController)
  [ ] onFlightPathEvent callback in VaultSync (for CRDT file events with path)

Mechanics:
  [x] Priority-aware queue (critical events survive pressure)
  [x] Ring indexes rebuild from surviving events (no stale keys)
  [ ] MAX_PENDING_CHARS bounded to prevent over-size rotation chunks

Not required for Phase A DoD (Phase B / holy QA prerequisites):
  [ ] Recovery events
  [ ] Disk write events
  [ ] Per-file reconcile decisions
  [ ] Remote materialization events
  [ ] Analyzer tooling
  [ ] Multi-device QA run

---

Key Design Decisions (unchanged from v2 unless noted)

Three path identity modes: safe (per-session keyed SHA-256 salt), qa-safe (shared
  qaTraceSecret for cross-device correlation), full (raw paths with explicit confirm).
  NOTE (v3): This is keyed SHA-256, NOT HMAC. Document honestly.

opId is mandatory for all file/path/decision/mutation events; optional only for
  provider/lifecycle noise.

causedByOpId required for causal chains (e.g. server receipt caused by CRDT update).

Event admission policy: critical (never drop), important (drop only under severe
  pressure), verbose (drop first). Critical events under full-critical pressure
  trigger immediate flush.

source = emitting module; layer = semantic authority boundary.

eventSchemaVersion and taxonomyVersion are separate — they evolve independently.

Safe export must refuse unsafe sessions — no post-hoc downgrade.

Standardized event naming: disk.create.observed not disk.event.create_seen.

Analyzer is mandatory before holy QA run — not optional.

NEW (v3): Sequence numbers assigned synchronously at call time, regardless of
  whether path identity resolves asynchronously. This guarantees local ordering.

NEW (v3): CRDT file events must carry pathId. Route through path-aware recording.
  fileId alone is not sufficient for timeline indexing.

NEW (v3): Export concatenates all session segments. Single-file export after
  rotation is a data loss bug.

NEW (v3): Degraded path identity (FNV fallback) invalidates safe mode.
  The trace is no longer safe to share.

---

Relevant Files (current)

src/debug/flightEvents.ts         — event envelope, FlightKind, FLIGHT_KIND, FlightSink, types
src/debug/pathIdentity.ts         — PathIdentityResolver (SHA-256 promise cache, pd: degraded)
src/debug/flightRecorder.ts       — NDJSON writer, ring buffer, priority queue, validateSafeEvent, rotation
src/debug/flightTraceController.ts — lifecycle controller, flush, export, recordPath, checkpoint loop
src/debug/flightEmitter.ts        — FlightSink re-export
src/debug/flightTraceTypes.ts     — QaTraceSettings
src/main.ts                       — disk event wiring, opId generation, command registration
src/sync/vaultSync.ts             — CRDT event emission (BROKEN: no pathId on CRDT events)
src/sync/serverAckTracker.ts      — server receipt events (BROKEN: no candidateId/svHash/causedByOpId)
src/runtime/reconciliationController.ts — reconcile events, markMarkdownDirty (opId threaded), crdt.file.updated emission
src/commands.ts                   — QA trace commands including Clear flight logs
src/settings/settingsTab.ts       — qaTraceSecret UX (password, generate/copy/clear)
tests/flight-recorder.ts          — 59 tests: path identity, priority, safeToShare, redaction, taxonomy
tests/flight-trace-privacy.ts     — 20 tests: privacy modes, multi-device correlation, export refusal

---

Critical Context (v3)

- CRDT file events bypass the path layer. This is the #1 bug blocking causality proof.
  VaultSync.onFlightEvent emits {fileId, opId} with no path. The controller cannot
  resolve a pathId from a fileId without the path. The path is available at the call
  site. Thread it through.

- Export after rotation is silently incomplete. If rotation happened, the exported
  trace is truncated to only the latest segment. The bug that caused the user to
  file a report probably happened in segment 1. Export must concatenate all segments.

- Async path identity ordering. The current design: recordPath() awaits SHA-256
  then calls record(). But record() for non-path events is synchronous. If caller
  does recordPath(A) then record(B), B may appear before A in the log. This is
  wrong for a flight recorder that claims to show local causal order.

- Server receipt causality is the hardest remaining problem. Y.Doc state vectors
  are document-level, not per-file. A receipt "confirms" the state vector, not a
  specific file operation. The bridge is: attach causedByOpId at capture time (the
  opId of the most recent CRDT mutation before capture). This is imprecise when
  multiple ops coalesce into one state vector, but it's the best same-device signal.

- The recorder's job is NOT "log what happened." It is "prove why YAOS touched
  user data." Until reconcile.file.decision, recovery.decision, and disk.write.*
  events exist, the recorder cannot explain overwrites. Those are Phase B but
  they are non-negotiable before holy QA.

- Tests pass but are still too self-contained. The flight-recorder.ts tests build
  synthetic events and verify recorder mechanics. They do not test actual VaultSync
  emissions or real event chains. Patch G (lifecycle proof) is the gating test.
