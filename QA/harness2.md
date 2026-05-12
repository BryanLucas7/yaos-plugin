You’re right: for this phase, mocks are not enough.

Mocks are useful for proving pure logic. They are not enough for Obsidian sync QA, because the bugs you care about live in the ugly boundary between:

Obsidian Vault API
Obsidian editor state
mobile lifecycle
community plugins
filesystem events
Yjs provider
YAOS disk mirror
YAOS CRDT state
Cloudflare server

So yes: build a harness that runs inside real Obsidian.

Not “replace tests with manual clicking.” That would be caveman QA. Build an in-Obsidian orchestrated QA harness.

The right architecture

You want three layers:

1. Node orchestrator outside Obsidian
2. QA harness running inside each Obsidian instance
3. YAOS flight recorder collecting proof

The key idea:

The outside process schedules scenarios. The inside harness performs actions using real Obsidian APIs.

Do not fake app.vault. Do not fake editor state for this phase. Use the real thing.

Layer 1: outside orchestrator

This is a Node script.

Example:

tools/qa/run-holy-qa.mjs

Responsibilities:

create fresh fixture vaults
copy plugin build into .obsidian/plugins/yaos
copy QA harness plugin into .obsidian/plugins/yaos-qa-harness
launch/open Obsidian vaults
wait for each device harness to announce ready
issue scenario commands
collect exported QA bundles
run analyzer
write final report

It should not directly mutate vault files except during fixture setup. Test actions should mostly happen inside Obsidian, because you want Obsidian’s real watchers, caches, metadata, editor, plugin lifecycle, and mobile-ish behavior where possible.

Layer 2: in-Obsidian QA harness

Build a tiny dev-only plugin:

packages/obsidian-qa-harness/

or inside repo:

src/qaHarness/

It exposes something like:

window.__YAOS_QA__ = {
  ready(): Promise<QAReadyInfo>;

  runScenarioStep(step: QAStep): Promise<QAStepResult>;

  openFile(path: string): Promise<void>;
  closeFile(path: string): Promise<void>;

  writeFile(path: string, content: string): Promise<void>;
  appendToFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  renameFile(oldPath: string, newPath: string): Promise<void>;
  moveFile(oldPath: string, newPath: string): Promise<void>;

  editActiveEditor(edit: EditorEdit): Promise<void>;
  setFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>;

  waitForIdle(options?: IdleOptions): Promise<IdleState>;
  assertVaultState(expected: VaultAssertion): Promise<AssertionResult>;

  startFlightTrace(options: TraceOptions): Promise<void>;
  stopFlightTrace(): Promise<void>;
  exportFlightTrace(): Promise<ExportResult>;

  getYaosStatus(): Promise<YaosStatus>;
  getFlightTimelineForPath(path: string): Promise<unknown[]>;
};

This is not production code. It is a test harness. Make it ugly if needed, but deterministic.

The important thing is that it uses real APIs:

app.vault.create()
app.vault.modify()
app.vault.delete()
app.fileManager.renameFile()
app.workspace.openLinkText()
MarkdownView.editor.replaceRange()
app.metadataCache

That is where the actual bugs live.

Layer 3: YAOS flight recorder

Every scenario should start with:

YAOS: Start QA flight trace

and end with:

YAOS: Export safe QA flight trace

The harness should not just say “test passed.” It should prove:

operation observed
CRDT changed
server receipt confirmed
remote device applied
disk materialized
final hashes match

No proof, no pass.

How to control Obsidian

You have two reasonable options.

Option A: Dev console global API

Fastest path.

The QA harness plugin installs:

window.__YAOS_QA__

Then you drive it from DevTools console or from an automation layer that can evaluate JS in Obsidian’s Electron renderer.

This is good for early development.

Option B: local QA control server

The harness starts a localhost HTTP/WebSocket control endpoint only in QA mode.

Example:

http://127.0.0.1:27123/qa

Then the Node orchestrator can call:

POST /run-step
POST /status
POST /export

This is better long-term.

Security rules:

only localhost
random session token
enabled only by explicit QA flag/setting
never in production default
clear warning in UI

Since this is a QA harness, don’t over-engineer it. But don’t accidentally ship a remote-control API to users. That would be impressively stupid.

How to run multiple “devices”

Start with two desktop vaults on the same machine:

/tmp/yaos-qa/device-a
/tmp/yaos-qa/device-b

Each vault has:

.obsidian/plugins/yaos
.obsidian/plugins/yaos-qa-harness

Configure both to the same YAOS test server and same vault ID.

This is not a perfect simulation of Mac+iOS, but it gives you real Obsidian, real plugin lifecycle, real file watchers, real editor state, and real YAOS server behavior.

Then expand:

Mac vault ↔ Windows vault
Mac vault ↔ iOS manual harness
Linux vault ↔ iOS manual harness

Do not start with iOS. Start with two desktop instances where logs are easy.

What “templates people care about” should mean

Do not start by testing random user vaults. Build fixture vault templates.

Each fixture should be a reusable vault profile:

qa/fixtures/001-basic-markdown
qa/fixtures/002-frontmatter-properties
qa/fixtures/003-tasks-dataview
qa/fixtures/004-canvas-base-excalidraw
qa/fixtures/005-bulk-import
qa/fixtures/006-nasty-paths
qa/fixtures/007-attachments

Each fixture contains:

seed files
expected final state
optional community plugin list
scenario scripts
expected unsupported behavior

This makes bugs reproducible.

Community plugins to include early

Start with plugins/features that historically caused or revealed bugs.

Must include early
1. Obsidian Properties / YAML frontmatter

Core Obsidian behavior. Not optional.

Test:

edit property through UI
edit YAML directly
concurrent property edits
malformed YAML
duplicate keys
external edit to YAML
2. Bases / .base

You had a real issue around .base layout disappearing.

Test:

create .base
edit layout
reopen Obsidian
sync across devices
offline edit
verify it does not revert
3. Canvas

You already saw weird one-way behavior related to R2/bucket binding.

Test with R2 off and on.

4. Excalidraw

Someone reported Obsidian breaking after saving Excalidraw.

Even if Excalidraw files are blob-ish, test it because users care.

5. Dataview

Dataview is everywhere. It reads metadata heavily. It may not mutate much, but it exposes whether metadata/frontmatter is sane.

6. Tasks / TaskNotes-style files

You need task-heavy Markdown and frontmatter-heavy task notes.

TaskForge may be annoying to automate, but you can reproduce the file mutation style: external app modifies YAML/task lines while Obsidian is open.

Do not install every plugin immediately

Plugin QA can explode.

Use profiles:

profile-basic
profile-frontmatter
profile-tasks
profile-visual-files
profile-nasty

Run core YAOS tests on every profile, but only plugin-specific tests on plugin profiles.

If every scenario installs every plugin, failures become meaningless. You won’t know if YAOS broke or the plugin did.

The first tests to start with

Start with five tests. Not fifty.

These five should prove the spine.

Test 1: live markdown create

Purpose: prove basic local disk/editor → CRDT → server → remote disk.

Devices:

A = Obsidian desktop vault
B = Obsidian desktop vault

Steps:

Start QA trace on A and B.
On A, create Notes/live-create.md using app.vault.create.
Wait for A server receipt.
Wait for B materialization.
Assert B has file with same content.
Export traces.
Analyzer verifies full lifecycle.

Expected events:

A disk.create.observed
A crdt.file.created
A server.receipt.candidate_captured
A server.receipt.confirmed
B provider.remote_update.applied
B disk.write.ok

This is the first gate. If this fails, everything else is noise.

Test 2: offline handoff create

Purpose: prove devices do not need simultaneous presence.

Steps:

B closed or disconnected.
A creates Notes/offline-handoff.md.
Wait for A server receipt.
Close A.
Open/connect B.
Assert B receives file.
Analyzer verifies A was absent when B materialized file.

Expected:

A server.receipt.confirmed before A closed
B disk.write.ok after B opened
no A reconnect required

This directly targets the old complaint.

This is a release gate.

Test 3: delete does not resurrect

Purpose: prove tombstones beat stale state.

Steps:

A and B both have Notes/delete-me.md.
Disconnect B.
A deletes file.
Wait for A receipt.
Reconnect B.
Assert file deleted on B.
Force reconcile on B.
Assert file does not come back.

Expected:

A crdt.file.tombstoned
B disk.delete.ok
B no crdt.file.revived unless explicit local create

This targets deleted folders/files coming back.

Test 4: bulk import after delete

Purpose: prove your tombstone revive semantics work.

Steps:

A deletes folder Imported/.
Wait for receipt and B delete.
On A, bulk copy 50 Markdown files into Imported/ using file manager-style writes or harness external writes.
Wait.
Assert B receives all 50 files.

Expected:

A tombstone cleared only for explicit local create
A crdt.file.revived or crdt.file.created for each file
B disk.write.ok for each file
no missing children

This replays the previous bulk-import bug.

Test 5: frontmatter safety loop

Purpose: prove the frontmatter amplification bug is dead.

Fixture:

---
status: open
priority: high
tags:
  - qa
---

# Task

- [ ] Something

Steps:

Open file on A in editor.
Modify YAML via Obsidian Properties API/UI if possible.
Simulate external plugin edit to same YAML while file is open.
Introduce duplicate key or suspicious growth.
Wait.
Assert no exponential duplication.
Assert quarantine/skip reason is visible.
Assert body text still stable.

Expected:

frontmatter.transition.checked
frontmatter.transition.blocked or accepted
no repeated crdt.file.updated loop
no editor stale heal write

This targets the scariest corruption class.

Then the second batch

After the first five pass, add:

Test 6: existing file modify

Because create is not enough.

Expected:

A disk.modify.observed
A crdt.file.updated
A receipt confirmed
B disk.write.ok
hashes match
Test 7: rename file

Expected:

old path gone
new path exists
no old+new duplicate unless conflict expected
Test 8: move folder

Expected:

all descendants moved
no partial tree
no resurrection
Test 9: .base layout persistence

Expected:

.base edit survives sync and restart
Test 10: Excalidraw save

Expected:

no Obsidian crash/breakage
clear R2 dependency if blob
The harness should support two action types

You need to distinguish Obsidian-native writes from external writes.

Obsidian-native write

Uses:

app.vault.create()
app.vault.modify()
app.fileManager.renameFile()

This tests normal plugin-facing Obsidian APIs.

External filesystem write

Uses adapter or Node/electron filesystem access where possible to mimic:

Web Clipper
file manager copy
external editor
TaskForge-like app
git checkout

This is important because many bugs come from outside Obsidian modifying files underneath the app.

The harness should label this in traces:

writeSource: "obsidian-api" | "external-fs" | "editor" | "plugin-simulated"

Otherwise you’ll confuse very different paths.

How to test editor behavior inside Obsidian

For editor-bound bugs, don’t use only app.vault.modify.

You need to open the file and edit the actual editor:

const leaf = app.workspace.getLeaf(true);
await leaf.openFile(file);
const view = leaf.view as MarkdownView;
view.editor.setValue(nextContent);

Or use replace operations if you care about cursor/binding behavior:

view.editor.replaceRange("hello", { line: 0, ch: 0 });

Why? Because y-codemirror binding bugs will not show up if you only use app.vault.modify.

The old frontmatter duplication bug lived in the editor/disk/CRDT recovery boundary. So test the editor boundary.

How to assert convergence

Do not assert by eyeballing the UI.

The harness should compute:

disk file set
CRDT path set
per-file hash
blob refs
tombstone set
flight incomplete ops

For each device:

await window.__YAOS_QA__.assertConverged({
  paths: ["Notes/live-create.md"],
  timeoutMs: 30000,
});

A pass means:

file exists where expected
content hash matches expected
CRDT hash matches disk hash
no pending writes
no pending receipt
no safety brake
no critical dropped events

This is what “done” means.

The QA scenario format

Make scenarios data-driven.

Example:

{
  "name": "offline-handoff-create",
  "fixture": "001-basic-markdown",
  "devices": ["A", "B"],
  "steps": [
    { "device": "B", "action": "disconnect" },
    {
      "device": "A",
      "action": "createFile",
      "path": "Notes/offline-handoff.md",
      "content": "# Offline\n"
    },
    { "device": "A", "action": "waitForReceipt" },
    { "device": "A", "action": "closeObsidian" },
    { "device": "B", "action": "connect" },
    {
      "device": "B",
      "action": "assertFile",
      "path": "Notes/offline-handoff.md",
      "sha256": "..."
    },
    { "action": "analyze" }
  ]
}

Do not encode all scenarios as random imperative scripts. Data-driven scenarios give you repeatability and reporting.

Dev console harness command example

For early manual QA, this should work:

await window.__YAOS_QA__.runScenario({
  name: "live-create",
  role: "A",
  steps: [
    {
      action: "createFile",
      path: "Notes/live-create.md",
      content: "# hello from A\n"
    },
    { action: "waitForReceipt" }
  ]
});

On B:

await window.__YAOS_QA__.waitForFile("Notes/live-create.md", {
  sha256: "...",
  timeoutMs: 30000
});

Later the Node orchestrator does this automatically.

What about mobile?

Mobile is harder. Do it after desktop harness is stable.

For iOS, you may not get the same automation hooks. Fine.

Use semi-manual mobile QA first:

Desktop orchestrator prepares vault/server.
iOS runs YAOS with QA trace enabled.
Human performs mobile action.
iOS exports safe QA trace.
Analyzer merges desktop+iOS traces.

You can still make this disciplined.

For mobile scenarios, use QR/deep links and a checklist. Do not pretend you have full automation if you don’t.

First milestone

Call it:

Obsidian QA Harness v0

It should support only:

two desktop Obsidian vaults
basic file create/modify/delete
editor edit
wait for YAOS idle/receipt
export flight trace
assert file content/hash
run analyzer

That is enough for the first five tests.

Do not add plugin fixture complexity before this works.

Final answer

Yes, incorporate Obsidian as much as possible.

The right approach is:

real Obsidian instances
dev-only QA harness plugin
window.__YAOS_QA__ control API
Node orchestrator
flight traces on every device
analyzer-based pass/fail
fixture vault templates users actually care about

Start with these tests:

live markdown create
offline handoff create
delete does not resurrect
bulk import after delete
frontmatter safety loop

Only after those pass, add:

existing file modify
rename file
move folder
.base persistence
Excalidraw save

That is the sane path. Real Obsidian first. Real evidence. No mocks pretending everything is fine.
