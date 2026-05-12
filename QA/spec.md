# YAOS Holy QA — Harness Specification

This document is the engineering spec for building the QA harness. It was written
after reading the full codebase against the QA plan (review1.md, review2.md,
harness.md, harness2.md). It tells you exactly what exists, what is missing, and
what to build in what order.

Do not start building until you have read this document. Do not skip sections.

---

## 1. Inventory — what already exists

### 1.1 Flight recorder (complete)

`src/debug/flightRecorder.ts` — ring buffer, NDJSON rotation, priority-based
admission/eviction, redaction guard, path identity resolver.

`src/debug/flightTraceController.ts` — start/stop/export lifecycle, checkpoint
loop, path-scoped async recording, flush before export.

`src/debug/flightEvents.ts` — full event taxonomy (`FLIGHT_KIND`), typed
envelopes, `FlightMode`, `FlightPriority`, `FlightScope`, `FlightLayer`.

`src/debug/pathIdentity.ts` — HMAC + QA-secret path identity.

Everything works. The recorder is the trust artifact. It is not the QA harness.

### 1.2 Plugin commands (registered in commands.ts)

All of these are command-palette accessible today:

| Command ID | Method |
|---|---|
| `qa-flight-trace-start` | `startQaFlightTrace(mode?)` |
| `qa-flight-trace-stop` | `stopQaFlightTrace()` |
| `qa-flight-trace-export-safe` | `exportSafeFlightTrace()` |
| `qa-flight-trace-export-full` | `exportFullFlightTrace()` |
| `qa-flight-trace-timeline-current-file` | `showTimelineForCurrentFile()` |
| `qa-flight-trace-clear-logs` | `clearFlightLogs()` |
| `force-reconcile` | `runReconciliation(mode)` |
| `export-diagnostics` | `DiagnosticsService.exportDiagnostics()` |
| `export-diagnostics-with-filenames` | `DiagnosticsService.exportDiagnosticsWithFilenames()` |

### 1.3 Readable internal state (available on the plugin instance)

From `VaultSync`:
- `connected`, `providerSynced`, `serverAppliedLocalState`
- `getActiveMarkdownPaths()` — all live CRDT paths
- `getTextForPath(path)` — `Y.Text` for a path
- `getDebugSnapshot()` — full debug object
- `waitForLocalPersistence()`, `waitForProviderSync()`

From `ReconciliationController`:
- `isReconciled`, `isReconcileInFlight`
- `runReconciliation(mode)`

From `DiskMirror`:
- `getDebugSnapshot()`, `getPreservedUnresolvedEntries()`

From `main.ts`:
- `collectOpenFileTraceState()` — hashes editor/disk/crdt for all open leaves
- `sha256Hex(text)` — SHA-256 via Web Crypto
- `buildFlightCheckpoint()` — checkpoint snapshot

### 1.4 Existing tests

`tests/` contains ~40 files: regression tests for specific behaviours (disk mirror,
frontmatter quarantine, sv echo, ack origins, closed file conflict, etc.), plus
worker integration tests (`worker-integration.mjs`) and a regression runner
(`run-regressions.mjs`). These are Layer 1 (pure/unit) tests. They pass today.

---

## 2. Inventory — what does NOT exist

This is the gap. Everything below must be built.

| Missing piece | Needed for |
|---|---|
| `YaosQaDebugApi` exposed on the plugin | Harness to call YAOS without reaching into private fields |
| `window.__YAOS_QA__` global | Dev console + external controller to drive the harness |
| Vault manifest tool (`qa:manifest`, `qa:compare`) | Comparing disk state across devices without eyeballing |
| QA harness plugin (`qa/obsidian-harness/`) | Scenario runner, assertion helpers, wait helpers |
| Scenario definitions (`qa/scenarios/`) | Reproducible, documented test cases |
| Fixture vaults (`qa/fixtures/`) | Deterministic starting state for each scenario |
| External Node orchestrator (`qa/controllers/`) | Automated multi-device runs |
| Analyzer (`qa/analyzers/`) | Automated pass/fail from flight traces |
| `qa-runs/` output directory convention | Trust artifact per run |

---

## 3. Architecture

Three layers. Outer layers depend on inner layers. Build inward-out.

```
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Node orchestrator (qa/controllers/)           │
│  Playwright/Electron DevTools → window.__YAOS_QA__      │
│  Coordinates multi-device scenarios, collects artifacts  │
└─────────────────────────────────────────────────────────┘
          ↕ JS eval over Electron remote debugging
┌─────────────────────────────────────────────────────────┐
│  Layer 2: In-Obsidian QA harness (qa/obsidian-harness/) │
│  window.__YAOS_QA__ = { run, open, type, manifest, ... }│
│  Calls real Obsidian APIs + YAOS debug API              │
└─────────────────────────────────────────────────────────┘
          ↕ narrow debug API
┌─────────────────────────────────────────────────────────┐
│  Layer 1: YAOS plugin debug surface (src/qaDebugApi.ts) │
│  window.__YAOS_DEBUG__ = { waitForIdle, getCrdtHash, …} │
│  Only exists when qaDebugMode setting is true           │
└─────────────────────────────────────────────────────────┘
          ↕ flight recorder
┌─────────────────────────────────────────────────────────┐
│  Flight recorder + analyzer (already built / to build)  │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Milestone 0 — YAOS debug API

Before the harness can do anything useful, YAOS must expose a narrow, deterministic
debug surface. This is NOT a product API. It exists only when `qaDebugMode` is
enabled in settings.

### 4.1 New setting

Add to `VaultSyncSettings`:

```typescript
qaDebugMode: boolean; // default false
// When true, exposes window.__YAOS_DEBUG__ in the renderer.
// Must never ship enabled. Guarded by settings toggle + Notice on enable.
```

### 4.2 New file: `src/qaDebugApi.ts`

```typescript
export interface YaosQaDebugApi {
  // Readiness
  isLocalReady(): boolean;
  isProviderSynced(): boolean;
  isReconciled(): boolean;
  isReconcileInFlight(): boolean;

  // Wait helpers (resolve when condition true, reject on timeout)
  waitForLocalReady(timeoutMs: number): Promise<void>;
  waitForProviderSynced(timeoutMs: number): Promise<void>;
  waitForReconciled(timeoutMs: number): Promise<void>;
  waitForIdle(timeoutMs: number): Promise<void>;           // local ready + provider synced + reconciled + no reconcile in flight
  waitForMemoryReceipt(timeoutMs: number): Promise<void>;  // serverAppliedLocalState === true
  waitForFile(path: string, timeoutMs: number): Promise<void>; // file appears in vault

  // Content hashes (SHA-256 hex)
  getDiskHash(path: string): Promise<string | null>;       // reads vault file via app.vault.read
  getCrdtHash(path: string): Promise<string | null>;       // hashes Y.Text content
  getEditorHash(path: string): Promise<string | null>;     // hashes active editor content

  // Path sets
  getActiveMarkdownPaths(): string[];                      // VaultSync.getActiveMarkdownPaths()
  getDiskMarkdownPaths(): string[];                        // app.vault.getMarkdownFiles().map(f => f.path)

  // Status
  getServerReceiptState(): "confirmed" | "pending" | "unknown" | "no-candidate";
  getConnectionState(): string;                            // ConnectionController state kind

  // Flight trace
  startFlightTrace(mode: string, secret?: string): Promise<void>;
  stopFlightTrace(): Promise<void>;
  exportFlightTrace(privacy: "safe" | "full"): Promise<string>; // returns path written

  // Force operations
  forceReconcile(): Promise<void>;
  forceReconnect(): void;
}
```

### 4.3 Exposure

In `main.ts`, after `initSync()` completes, if `settings.qaDebugMode`:

```typescript
(window as any).__YAOS_DEBUG__ = buildQaDebugApi(this);
```

`buildQaDebugApi` is a factory in `src/qaDebugApi.ts` that closes over the plugin
instance. No direct access to private fields — call the same methods the
reconciliation loop calls.

All wait helpers use `waitFor(predicate, intervalMs, timeoutMs)` — poll every
`intervalMs` (default 250 ms) until true or timeout. Never `setTimeout(fn, n)`.

### 4.4 Exit criteria for Milestone 0

In Obsidian DevTools console, with `qaDebugMode` enabled:

```javascript
const api = window.__YAOS_DEBUG__;
await api.waitForIdle(10000);
console.log(api.getActiveMarkdownPaths().length);  // should be > 0
const hash = await api.getDiskHash("Notes/test.md");
console.log(hash);  // should be a 64-char hex string
```

No errors. Hash matches `sha256(fileContent)`.

---

## 5. Milestone 1 — vault manifest tool

A standalone Node/Bun script that reads a vault directory and produces a JSON
manifest: path, sha256, byte size, kind. A companion compare script diffs two
manifests.

### 5.1 New files

```
qa/
  scripts/
    manifest.ts     — reads a vault, outputs manifest.json
    compare.ts      — diffs two manifests, exits 1 if mismatch
```

### 5.2 Manifest format

```typescript
interface VaultManifest {
  generatedAt: string;         // ISO 8601
  vaultPath: string;           // absolute path (local QA use only)
  fileCount: number;
  files: VaultManifestEntry[];
}

interface VaultManifestEntry {
  path: string;                // relative to vault root
  sha256: string;              // hex
  bytes: number;
  kind: "markdown" | "attachment" | "other";
}
```

### 5.3 Compare output

```
manifest compare: 2 files differ, 1 missing on B, 0 extra on B

DIFFER:
  Notes/test.md  sha256 mismatch (A: abc123…  B: def456…)
  Notes/foo.md   bytes differ (A: 1024  B: 0)

MISSING on B:
  Notes/bar.md

Exit code: 1
```

### 5.4 package.json scripts

```json
"qa:manifest": "bun run qa/scripts/manifest.ts",
"qa:compare": "bun run qa/scripts/compare.ts"
```

### 5.5 Exit criteria for Milestone 1

```bash
bun run qa:manifest /path/to/vault > manifest-a.json
bun run qa:compare manifest-a.json manifest-a.json   # exits 0, "no differences"
bun run qa:compare manifest-a.json manifest-b.json   # exits 1, shows diffs
```

---

## 6. Milestone 2 — in-Obsidian QA harness plugin

A dev-only Obsidian plugin that installs alongside YAOS and exposes
`window.__YAOS_QA__`. This is the main QA control surface.

### 6.1 File structure

```
qa/
  obsidian-harness/
    manifest.json
    main.ts
    api.ts          — QaConsoleApi interface + implementation
    scenarios/      — scenario definitions (added incrementally)
    assertions.ts   — assertion helpers
    wait.ts         — wait helpers (wraps __YAOS_DEBUG__)
    vault-ops.ts    — file create/modify/delete/rename using real Obsidian APIs
    editor-ops.ts   — open file, type into MarkdownView, toggle checkbox
```

### 6.2 `manifest.json`

```json
{
  "id": "yaos-qa-harness",
  "name": "YAOS QA Harness",
  "version": "0.1.0",
  "minAppVersion": "1.0.0",
  "description": "Internal QA harness for YAOS. Do not install in production vaults.",
  "author": "YAOS dev",
  "isDesktopOnly": true
}
```

### 6.3 `window.__YAOS_QA__` interface

```typescript
interface QaConsoleApi {
  // Discovery
  help(): void;                          // prints all methods to console
  scenarios(): string[];                 // list registered scenario IDs

  // Scenario execution
  run(id: string, opts?: QaRunOptions): Promise<QaResult>;

  // Vault operations (use real Obsidian APIs)
  createFile(path: string, content: string): Promise<void>;   // app.vault.create
  modifyFile(path: string, content: string): Promise<void>;   // app.vault.modify
  appendToFile(path: string, text: string): Promise<void>;    // read + modify
  deleteFile(path: string): Promise<void>;                    // app.vault.delete
  renameFile(oldPath: string, newPath: string): Promise<void>; // app.fileManager.renameFile

  // External-write simulation (bypasses Obsidian API, hits filesystem directly)
  // Used to simulate Web Clipper, external editors, TaskForge-style writes
  writeExternal(path: string, content: string): Promise<void>; // adapter.write
  deleteExternal(path: string): Promise<void>;                 // adapter.remove

  // Editor operations
  openFile(path: string): Promise<void>;   // workspace.openLinkText
  closeFile(path: string): Promise<void>;  // closes leaf by path
  typeIntoFile(path: string, text: string, opts?: TypingOptions): Promise<void>;
  replaceFileContent(path: string, content: string): Promise<void>; // editor.setValue
  runCommand(commandId: string): Promise<void>; // app.commands.executeCommandById

  // Wait helpers (delegates to __YAOS_DEBUG__)
  waitForIdle(timeoutMs?: number): Promise<void>;
  waitForMemoryReceipt(timeoutMs?: number): Promise<void>;
  waitForFile(path: string, timeoutMs?: number): Promise<void>;
  waitForFileContent(path: string, expectedHash: string, timeoutMs?: number): Promise<void>;

  // Assertions
  assertFileExists(path: string): Promise<void>;
  assertFileNotExists(path: string): Promise<void>;
  assertFileContent(path: string, expectedContent: string): Promise<void>;
  assertFileHash(path: string, expectedHash: string): Promise<void>;
  assertDiskEqualsCrdt(path: string): Promise<void>;
  assertNoConflictCopies(dirPath?: string): Promise<void>;

  // Manifests
  manifest(): Promise<VaultManifest>;   // snapshot of current vault
  compareManifest(expected: VaultManifest): Promise<ManifestDiff>;

  // Flight trace
  startTrace(mode?: string, secret?: string): Promise<void>;
  stopTrace(): Promise<void>;
  exportTrace(privacy?: "safe" | "full"): Promise<string>;   // returns path

  // Diagnostics export
  exportDiagnostics(): Promise<string>;  // returns path

  // Plugin state
  plugins(): Array<{ id: string; version: string; enabled: boolean }>;
}

interface QaRunOptions {
  timeoutMs?: number;
  role?: "A" | "B" | "C";
}

interface QaResult {
  id: string;
  passed: boolean;
  durationMs: number;
  errors: string[];
  warnings: string[];
  artifactDir?: string;
}
```

### 6.4 Scenario interface

```typescript
export interface QaScenario {
  id: string;
  title: string;
  tags: string[];
  requiredPlugins?: string[];

  setup(ctx: QaContext): Promise<void>;
  run(ctx: QaContext): Promise<void>;
  assert(ctx: QaContext): Promise<void>;
  cleanup?(ctx: QaContext): Promise<void>;
}

export interface QaContext {
  // Direct API access
  vault: typeof app.vault;
  workspace: typeof app.workspace;
  yaos: YaosQaDebugApi;      // window.__YAOS_DEBUG__

  // Helpers (delegates)
  createFile(path: string, content: string): Promise<void>;
  modifyFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  renameFile(old: string, next: string): Promise<void>;
  openFile(path: string): Promise<void>;
  typeIntoFile(path: string, text: string): Promise<void>;
  runCommand(id: string): Promise<void>;
  sleep(ms: number): Promise<void>;   // only for intentional idle tests

  waitForIdle(timeoutMs?: number): Promise<void>;
  waitForMemoryReceipt(timeoutMs?: number): Promise<void>;
  waitForFile(path: string, timeoutMs?: number): Promise<void>;

  assert: {
    fileExists(path: string): Promise<void>;
    fileNotExists(path: string): Promise<void>;
    fileContent(path: string, content: string): Promise<void>;
    fileHash(path: string, hash: string): Promise<void>;
    diskEqualsCrdt(path: string): Promise<void>;
    noConflictCopies(dir?: string): Promise<void>;
    noAnalyzerErrors(): void;   // checks last run result
  };
}
```

### 6.5 `vault-ops.ts` — two write modes

Label every file write so the flight trace can distinguish sources:

```typescript
// Mode A: Obsidian-native (tests normal plugin/editor behavior)
await app.vault.create(path, content);

// Mode B: External filesystem (tests Web Clipper, TaskForge, git checkout)
await app.vault.adapter.write(normalizePath(path), content);
```

Both modes must be available. Use Mode A as default. Use Mode B explicitly when
testing external-write scenarios. Log the mode in every operation.

### 6.6 `editor-ops.ts`

```typescript
// Open a file in a real MarkdownView leaf
async function openFile(app: App, path: string): Promise<void> {
  await app.workspace.openLinkText(path, "", true);
  await waitFor(() => {
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path === path;
  }, 250, 5000);
}

// Type into the active MarkdownView editor (simulates user input)
async function typeIntoFile(app: App, path: string, text: string): Promise<void> {
  const view = getViewForPath(app, path);
  for (const ch of text) {
    view.editor.replaceRange(ch, view.editor.getCursor());
    await sleep(20);  // simulate typing cadence
  }
}

// Replace entire content (blunt — use for setup, not for live-sync tests)
async function replaceFileContent(app: App, path: string, content: string): Promise<void> {
  const view = getViewForPath(app, path);
  view.editor.setValue(content);
}
```

Do not use `editor.setValue` in live-sync tests. It does not simulate the
incremental cursor operations that caused the old duplication bugs.

### 6.7 First scenario to ship with Milestone 2

`qa/obsidian-harness/scenarios/single-device-basic-edit.ts`:

```typescript
export const singleDeviceBasicEdit: QaScenario = {
  id: "single-device-basic-edit",
  title: "Single device: create, edit, delete a note",
  tags: ["basic", "single-device", "layer1"],

  async setup(ctx) {
    await ctx.deleteFile("QA-scratch/basic-edit.md").catch(() => {});
    await ctx.waitForIdle(5000);
  },

  async run(ctx) {
    await ctx.createFile("QA-scratch/basic-edit.md", "# hello\n");
    await ctx.waitForIdle(5000);
    await ctx.waitForMemoryReceipt(10000);

    await ctx.openFile("QA-scratch/basic-edit.md");
    await ctx.typeIntoFile("QA-scratch/basic-edit.md", "\nworld");
    await ctx.waitForIdle(5000);

    await ctx.deleteFile("QA-scratch/basic-edit.md");
    await ctx.waitForIdle(5000);
  },

  async assert(ctx) {
    await ctx.assert.fileNotExists("QA-scratch/basic-edit.md");
    ctx.assert.noAnalyzerErrors();
  },
};
```

### 6.8 Exit criteria for Milestone 2

In Obsidian DevTools:

```javascript
await window.__YAOS_QA__.run("single-device-basic-edit");
// → { passed: true, durationMs: ..., errors: [], warnings: [] }

const m = await window.__YAOS_QA__.manifest();
// → { fileCount: N, files: [...] }

await window.__YAOS_QA__.startTrace("qa-safe");
await window.__YAOS_QA__.stopTrace();
const path = await window.__YAOS_QA__.exportTrace("safe");
// → ".obsidian/plugins/yaos/diagnostics/flight-trace-qa-safe-....ndjson"
```

---

## 7. Milestone 3 — analyzer MVP

A Node/Bun script that reads an exported NDJSON flight trace and applies the 10
analyzer rules from review2.md. Exits 0 on pass, 1 on failure.

### 7.1 File structure

```
qa/
  analyzers/
    analyzer.ts     — main entry point
    rules/
      unsafe-overwrite.ts
      recovery-loop.ts
      delete-then-revive.ts
      self-write-suppression-miss.ts
      stuck-receipt.ts
      false-safe-to-close.ts
      disk-crdt-idle-mismatch.ts
      missing-path-id.ts
      redaction-failure.ts
      dropped-critical-event.ts
    report.ts       — builds the structured report
```

### 7.2 Analyzer output format

```typescript
interface AnalyzerReport {
  scenarioId?: string;
  traceFile: string;
  analyzedAt: string;
  passed: boolean;

  summary: {
    hardFailures: number;
    warnings: number;
    checkedEvents: number;
    incompleteOps: number;
    hashMismatches: number;
    criticalDrops: number;
    redactionFailures: number;
  };

  failures: AnalyzerFinding[];
  warnings: AnalyzerFinding[];
}

interface AnalyzerFinding {
  rule: string;          // e.g. "unsafe-overwrite"
  severity: "hard" | "warning";
  pathId?: string;
  opId?: string;
  eventSeqs: number[];   // which events triggered this
  description: string;
}
```

### 7.3 Rule: unsafe overwrite

Flag when:
- `reconcile.file.decision` with `decision=write-crdt-to-disk`
- AND `data.diskChangedSinceObserved=true`
- AND `data.conflictRisk != "none"`
- AND no `crdt.file.revived` or conflict-preserved event for same pathId

Severity: **hard failure**.

### 7.4 Rule: recovery loop

Flag when same `pathId` has `recovery.decision` events with identical
`data.signature` repeated >= 3 times within any 60-second window.

Severity: **hard failure**.

### 7.5 Rule: delete then revive without explicit cause

Flag when:
- `crdt.file.tombstoned` for a pathId
- followed by `crdt.file.revived` within 10 seconds
- AND no `disk.create.observed` for same pathId between the two events

Severity: **warning** (could be valid explicit recreate; flag for human review).

### 7.6 Rule: self-write suppression miss

Flag when:
- `disk.write.ok` for pathId
- then `disk.modify.observed` for same pathId within 5 seconds
- then `disk.event.not_suppressed` for same pathId

Severity: **hard failure** (loop seed).

### 7.7 Rule: stuck receipt

Flag when:
- `server.receipt.candidate_captured` 
- AND `provider.connected` is present (device was online)
- AND no `server.receipt.confirmed` within 60 seconds of the capture

Severity: **warning**.

### 7.8 Rule: disk/CRDT idle mismatch

Flag when `qa.checkpoint` shows `diskHash != crdtHash` for any path AND no
pending operation or reconcile in flight (`reconcileInFlight=false`,
`pendingBlobUploads=0`).

Severity: **hard failure**.

### 7.9 Rule: redaction failure

Any `redaction.failure` event is a **hard failure**.

### 7.10 Rule: dropped critical event

Any `flight.events.dropped` with `data.droppedByPriority.critical > 0` is a
**hard failure**.

### 7.11 Rules: missing path ID, false safe-to-close

Flag any `scope=file` event without a `pathId` (unless `kind` is explicitly
connection/diagnostics scoped) — **warning**.

Flag safe-to-close false positive if it becomes instrumentable (not yet emitted
by current code, add as **warning placeholder** for now).

### 7.12 package.json script

```json
"qa:analyze": "bun run qa/analyzers/analyzer.ts"
```

Usage:

```bash
bun run qa:analyze path/to/flight-trace.ndjson
bun run qa:analyze path/to/flight-trace.ndjson --scenario offline-handoff-create
```

### 7.13 Exit criteria for Milestone 3

Three dry runs as specified in review2.md:

**Dry Run 1** — single device, create/edit/delete, export trace, run analyzer:

```bash
# In Obsidian
await YAOS_QA.run("single-device-basic-edit")
const p = await YAOS_QA.exportTrace("safe")

# In terminal
bun run qa:analyze $p
# → PASS, 0 hard failures, 0 warnings
```

**Dry Run 2** — synthetic trace with a known unsafe-overwrite pattern injected:

```bash
bun run qa:analyze qa/fixtures/traces/unsafe-overwrite-synthetic.ndjson
# → FAIL, 1 hard failure: unsafe-overwrite
```

**Dry Run 3** — synthetic trace with a recovery loop injected:

```bash
bun run qa:analyze qa/fixtures/traces/recovery-loop-synthetic.ndjson
# → FAIL, 1 hard failure: recovery-loop
```

---

## 8. Milestone 4 — fixture vaults

Versioned, deterministic vault directories for each scenario class.

### 8.1 Directory structure

```
qa/
  fixtures/
    vaults/
      001-basic-markdown/
        Notes/hello.md
        Notes/world.md
        README.md
      002-frontmatter-properties/
        Notes/task-001.md      — frontmatter-heavy task note
        Notes/task-002.md
        README.md
      003-tasks-dataview/
        Tasks/storm.md         — 200-task storm note
        README.md
      004-bulk-import/
        Imported/             — 100 pre-built markdown files
        README.md
      005-nasty-paths/
        "Unicode ☃ file.md"
        "Case Test.md"        — paired with "case test.md" for case-collision
        Deep/Nested/Path/To/A/File.md
        README.md
    traces/
      unsafe-overwrite-synthetic.ndjson   — for analyzer dry run 2
      recovery-loop-synthetic.ndjson      — for analyzer dry run 3
    templates/
      daily-note.md
      task-note.md
      frontmatter-heavy.md
      task-storm-200.md       — 200 task lines, deterministic
      web-clipper-article.md
```

### 8.2 Fixture install script

```
qa/
  scripts/
    prepare-vault.ts    — copies fixture vault to a target directory,
                          installs YAOS plugin build, optionally installs
                          community plugins from plugin-lock.json
```

Usage:

```bash
bun run qa:prepare --fixture 001-basic-markdown --out /tmp/yaos-qa/device-a
```

It:
1. Copies fixture vault to `--out`
2. Creates `.obsidian/plugins/yaos/` and copies current `main.js` build
3. Creates `.obsidian/plugins/yaos-qa-harness/` and copies harness build
4. Writes `.obsidian/community-plugins.json` enabling both
5. Writes a minimal `.obsidian/app.json` (disable safe mode)

### 8.3 Plugin lock file

```json
// qa/plugin-lock.json
{
  "obsidian-tasks-plugin": {
    "repo": "obsidian-tasks-group/obsidian-tasks",
    "version": "7.20.0",
    "assets": ["main.js", "manifest.json", "styles.css"]
  },
  "templater-obsidian": {
    "repo": "SilentVoid13/Templater",
    "version": "2.9.1",
    "assets": ["main.js", "manifest.json", "styles.css"]
  }
}
```

The prepare script downloads these via GitHub release API if asked:

```bash
bun run qa:prepare --fixture 003-tasks-dataview --plugins tasks --out /tmp/yaos-qa/device-a
```

Pin exact versions. QA without pinned versions is soup.

### 8.4 Exit criteria for Milestone 4

```bash
bun run qa:prepare --fixture 001-basic-markdown --out /tmp/yaos-qa/test-vault
ls /tmp/yaos-qa/test-vault/.obsidian/plugins/yaos/main.js   # exists
ls /tmp/yaos-qa/test-vault/Notes/hello.md                   # exists
```

---

## 9. Milestone 5 — first five scenarios (single-device + two-device)

The five scenarios from harness.md that prove the spine. All must pass before
running the full matrix.

### 9.1 Scenario file locations

```
qa/obsidian-harness/scenarios/
  s01-live-markdown-create.ts
  s02-offline-handoff-create.ts
  s03-delete-does-not-resurrect.ts
  s04-bulk-import-after-delete.ts
  s05-frontmatter-safety-loop.ts
```

### 9.2 S01 — live markdown create

Device A creates `Notes/live-create.md`. Device B must receive it.

Expected flight events (in order, across devices):
```
A: disk.create.observed
A: crdt.file.created
A: server.receipt.candidate_captured
A: server.receipt.confirmed
B: provider.sync.complete (or provider.connected if cold start)
B: disk.write.ok
```

Analyzer: 0 hard failures, 0 critical drops.

### 9.3 S02 — offline handoff create (release gate)

This scenario must pass before any release.

Steps:
1. Both A and B start with a clean synced vault (fixture 001).
2. B closes Obsidian (or disconnects from server).
3. A creates `Notes/offline-handoff.md`.
4. A waits for memory receipt (`waitForMemoryReceipt`).
5. A closes Obsidian.
6. B opens Obsidian.
7. B waits for `Notes/offline-handoff.md` to appear.
8. Export traces from both devices, run analyzer.

Pass criteria:
- `Notes/offline-handoff.md` exists on B with matching content.
- A's trace shows `server.receipt.confirmed` before A closed.
- B's trace shows `disk.write.ok` with no A reconnect event between B open and file appear.
- Analyzer: 0 hard failures.

If this fails, stop all other work. This is the old scary report.

### 9.4 S03 — delete does not resurrect

Steps:
1. Both A and B have `Notes/delete-me.md`.
2. Disconnect B.
3. A deletes `Notes/delete-me.md`. Wait for receipt.
4. Reconnect B.
5. B waits for reconcile.
6. Assert file does not exist on B.
7. Force reconcile on B.
8. Assert file still does not exist.

Expected flight events:
```
A: disk.delete.observed
A: crdt.file.tombstoned
B: (on reconnect) disk.write.ok → delete
B: (after force reconcile) no crdt.file.revived
```

### 9.5 S04 — bulk import after delete

Steps:
1. A deletes folder `Imported/`. Wait for receipt and B delete.
2. On A, write 50 markdown files into `Imported/` using external write mode
   (simulates Web Clipper / file manager).
3. Wait for all 50 to appear in A's CRDT paths.
4. Wait for B to receive all 50.
5. Compare manifests: A and B must match for `Imported/` subtree.

Expected flight events per file:
```
A: disk.create.observed
A: crdt.file.revived OR crdt.file.created
A: server.receipt.confirmed (eventually)
B: disk.write.ok
```

No missing children. This directly replays the previous bulk-import tombstone bug.

### 9.6 S05 — frontmatter safety loop

Steps:
1. Open a frontmatter-heavy file (from fixture 002) on A.
2. Modify a YAML property through Obsidian Properties UI
   (`app.commands.executeCommandById("editor:open-search")` → property panel).
3. Simulate an external plugin write to the same file with a suspicious YAML
   change (duplicate key or growth > 3x) using `writeExternal`.
4. Wait for YAOS to process.
5. Assert no exponential duplication of YAML blocks.
6. Assert quarantine decision is in the flight trace.

Expected flight events:
```
A: disk.modify.observed (external)
A: reconcile.file.decision with frontmatter-blocked reason
A: (no crdt.file.updated loop)
```

---

## 10. Milestone 6 — external Node orchestrator

A Node/Bun script that can drive single-device scenarios automatically by
connecting to Obsidian's Electron remote debugging protocol.

### 10.1 File structure

```
qa/
  controllers/
    obsidian-client.ts   — connects to Obsidian over CDP, evaluates JS
    single-device.ts     — CLI: launch/attach + run scenario + collect artifacts
    two-device.ts        — CLI: two vaults, shared QA secret
    collect-artifacts.ts — copies flight logs, diagnostics, vault manifest to run dir
```

### 10.2 Obsidian CDP connection

Launch Obsidian with remote debugging enabled:

```bash
obsidian --remote-debugging-port=9222 --vault /tmp/yaos-qa/device-a &
```

Connect via Playwright CDPSession or raw CDP:

```typescript
import { chromium } from "@playwright/test";

const browser = await chromium.connectOverCDP("http://localhost:9222");
const page = browser.contexts()[0]!.pages()[0]!;

async function evalQa(js: string): Promise<unknown> {
  return await page.evaluate(js);
}

await evalQa(`await window.__YAOS_QA__.waitForIdle(10000)`);
```

### 10.3 `single-device.ts` CLI

```bash
bun run qa:obsidian \
  --scenario single-device-basic-edit \
  --vault /tmp/yaos-qa/device-a \
  --port 9222 \
  --run-dir qa-runs/$(date +%Y-%m-%d)/single-device-basic-edit
```

It:
1. Verifies `window.__YAOS_QA__` is present (polls for 30s).
2. Starts QA trace.
3. Calls `__YAOS_QA__.run(scenarioId)`.
4. Collects artifacts to `--run-dir`: flight trace, diagnostics, vault manifest.
5. Runs analyzer on flight trace.
6. Writes `verdict.json` to `--run-dir`.
7. Exits 0 on pass, 1 on failure.

### 10.4 `two-device.ts` CLI

```bash
bun run qa:two-device \
  --scenario offline-handoff-create \
  --vault-a /tmp/yaos-qa/device-a \
  --vault-b /tmp/yaos-qa/device-b \
  --port-a 9222 \
  --port-b 9223 \
  --shared-secret qa-secret-$(openssl rand -hex 8)
```

Orchestrates the two-device scenario step-by-step. Each step is defined in the
scenario's `run()` method but accepts a `ctx.device("A")` / `ctx.device("B")`
API that routes calls to the appropriate CDP session.

### 10.5 Run directory format

```
qa-runs/
  2026-05-13/
    offline-handoff-create/
      scenario.md        — human-readable steps copy
      expected.json      — expected manifest + events
      device-a/
        flight.ndjson
        diagnostics.json
        manifest.json
        analyzer.json
        console.log
      device-b/
        flight.ndjson
        diagnostics.json
        manifest.json
        analyzer.json
      verdict.json       — { scenario, passed, durationMs, findings }
```

### 10.6 Exit criteria for Milestone 6

```bash
bun run qa:obsidian \
  --scenario single-device-basic-edit \
  --vault /tmp/yaos-qa/device-a \
  --port 9222 \
  --run-dir qa-runs/$(date +%Y-%m-%d)/m6-smoke
# → exits 0
# → qa-runs/.../m6-smoke/verdict.json: { passed: true }
# → qa-runs/.../m6-smoke/device-a/flight.ndjson: exists, > 0 bytes
# → qa-runs/.../m6-smoke/device-a/analyzer.json: { passed: true }
```

---

## 11. Build order

Build in this exact order. Do not skip milestones. Each one unlocks the next.

```
Milestone 0: YAOS debug API          (2–4 hours)
  → exposes waitForIdle, getCrdtHash, getDiskHash, getActiveMarkdownPaths

Milestone 1: Vault manifest tool      (1–2 hours)
  → bun run qa:manifest, bun run qa:compare

Milestone 2: QA harness plugin        (4–8 hours)
  → window.__YAOS_QA__, single-device-basic-edit passes

Milestone 3: Analyzer MVP             (4–6 hours)
  → all 10 rules, 3 dry runs pass

Milestone 4: Fixture vaults           (2–3 hours)
  → 5 fixture vaults, prepare-vault script

Milestone 5: First five scenarios     (4–8 hours)
  → s01–s05 pass (S02 is the release gate)

Milestone 6: External orchestrator    (4–8 hours)
  → single-device automated, two-device automated
```

Total estimated: ~21–39 hours of actual coding.

---

## 12. What not to do while building the harness

- Do not add features to the YAOS product plugin while building QA infrastructure.
- Do not skip Milestone 0. You cannot test anything reliably without the debug API.
- Do not use `await sleep(N)` in scenarios except for intentional idle tests.
  Use wait helpers that poll a condition.
- Do not test multiple scenarios simultaneously before the harness is boring.
- Do not commit plugin lock files with unpinned versions.
- Do not expose `window.__YAOS_QA__` or `window.__YAOS_DEBUG__` from the production
  YAOS plugin. The debug API lives only in `main.ts` behind `qaDebugMode` setting.
  The harness is a separate plugin.
- Do not use `app.vault.modify` as the only way to test editor behavior. The old
  bugs happened at the editor-binding boundary.

---

## 13. Acceptance criteria for "QA harness is done"

The QA harness is done when:

1. `bun run qa:two-device --scenario offline-handoff-create` exits 0.
2. The analyzer reports zero hard failures for that run.
3. The vault manifests for device-a and device-b match for the synced paths.
4. S02 (offline handoff) has passed on real Mac + iOS hardware at least once.
5. All five first scenarios (S01–S05) have passed on at least two desktop pairings.
6. Every run produces a `qa-runs/` artifact directory with flight traces,
   manifests, and `verdict.json`.

After this, the Holy QA matrix (layers 3 and 4 from review1.md) can begin.
