Overall QA grade target

Before this phase, YAOS was somewhere around:

“Promising, risky, observability improving.”

After QA, you want to be able to say:

“Known workflows tested. Known old complaints classified. Data-loss paths either fixed, conflict-preserved, or documented as unsupported.”

That is the bar.

The QA phases

Do this in layers. Do not immediately run a giant multi-device chaos session and then drown in logs.

Phase 1: Single-device correctness

Purpose:

Verify that one Obsidian client, one vault, one YAOS instance behaves sanely before distributed sync enters the picture.

Test:

plugin startup;
IDB load;
initial reconcile;
disk modify;
editor modify;
file create;
file delete;
file rename;
folder rename;
external editor write;
Obsidian restart;
plugin disable/enable;
safe trace export;
full trace export;
timeline for current file;
analyzer output.

This phase should catch stupid local bugs before you blame CRDT or Cloudflare.

If single-device behavior is not boring, multi-device QA is a waste of time.

Phase 2: Two-device baseline

Purpose:

Verify ordinary sync without chaos.

Matrix:

Desktop A ↔ Desktop B
Desktop A ↔ Android
Desktop A ↔ iOS/iPadOS
Desktop A ↔ Desktop B ↔ Mobile

Basic operations:

create note on A, appears on B;
edit note on A, appears on B;
edit note on B, appears on A;
delete note on A, deleted on B;
rename note on A, renamed on B;
create attachment on A, appears on B if R2 enabled;
no attachment sync if R2 disabled, but user gets honest status;
close A, open B later, B receives state.

This is not enough, but it is the foundation.

Phase 3: Offline/reconnect

Purpose:

Prove “simultaneous presence not required.”

Scenarios:

A edits offline, B later receives
1. A and B synced.
2. Disconnect A.
3. Edit/create/delete files on A.
4. Keep B offline or closed.
5. Reconnect A.
6. Wait for memory receipt, later durable receipt if implemented.
7. Close A.
8. Open B.
9. B receives edits.

Expected:

no dependency on A being online when B opens;
receipt state truthful;
durable receipt, if implemented, is the “safe to close” signal;
flight recorder links A’s local edits to server receipt.
B edits same file while A offline
1. A offline edits note.
2. B online edits same note.
3. A reconnects.

Expected:

CRDT merge if edits are compatible;
conflict preservation if disk/CRDT authority is ambiguous;
no silent overwrite;
trace shows decision.
Both devices offline, both edit same file

Expected:

no lost content;
either CRDT merge or conflict copy;
final state explainable.

This is where sync tools usually earn or lose trust.

Phase 4: Historical bug reproduction

Purpose:

Go through every real complaint and classify it.

Create a table:

Report ID
Original symptom
Likely root cause
Reproduction scenario
Old behavior
New behavior
Flight trace evidence
Status

Statuses:

fixed
fixed + regression
not reproduced
documented limitation
needs reporter validation
still broken
not YAOS

Old classes to test:

edits disappearing while typing;
deleted content coming back;
empty/corrupted note propagating;
offline edit overwritten after reconnect;
repeated duplicate chunks appended every few seconds;
TaskNotes/TaskForge/frontmatter loop;
Web Clipper bulk import missing until rename;
file reverting after plugin restart;
.canvas weirdness;
.base weirdness;
Excalidraw weirdness;
folder delete/move not syncing;
empty folders not syncing;
server online but plugin offline;
“both devices must be online” claim;
stale settings requiring reload;
R2 missing/misconfigured;
unsafe traces / diagnostics privacy.

This phase matters more than synthetic tests because these are the exact users who made you build the recorder.

Phase 5: Plugin-interaction torture

Purpose:

Reproduce real Obsidian ecosystem nonsense.

Use test vaults with:

Tasks;
TaskNotes;
TaskForge;
Dataview;
Templater;
Periodic Notes / Daily Notes;
Web Clipper;
Excalidraw;
Advanced Canvas;
Bases;
maybe Git plugin, but mark as hostile/unsupported if auto-syncing.

Test:

rapid task checkbox toggles;
plugins rewriting frontmatter;
template insertion;
Web Clipper bulk note creation;
daily note auto-creation;
external plugin mass rename;
canvas save while synced;
Excalidraw edits;
.base changes.

Expected:

Markdown text safe;
unsupported or risky file types documented;
no infinite loops;
no silent corruption;
flight trace identifies external disk writes vs YAOS writes.
Phase 6: Mobile lifecycle

Purpose:

Mobile is where “works on desktop” goes to die.

Test:

app backgrounded during edit;
app killed before receipt;
app killed after memory receipt but before durable receipt;
app killed after durable receipt;
flaky mobile network;
switching Wi-Fi/cellular;
screen lock/unlock;
vault opens after days stale;
large vault startup on mobile;
IDB load timeout on mobile.

Expected:

status says unknown/waiting when truth is unknown;
no false “safe” signal;
local edits preserved after restart;
pending receipt state flushes if possible;
if flush fails, trace says so.
Phase 7: Long-run soak

Purpose:

Catch slow loops, leaks, and quota problems.

Run at least:

2 hours active editing
8 hours idle connected
overnight mobile stale/reopen
bulk import 100/500/1000 notes
large vault startup
attachment queue stress

Watch:

memory growth;
log growth;
flight recorder rotation;
server trace rate limits;
Durable Object request count;
R2 request count;
stuck receipts;
repeated recovery signatures;
disk/CRDT hash drift.

The analyzer should be run after every soak.

The QA harness

You need to stop doing QA as “I clicked around.” That is not QA. That is superstition.

Each QA scenario should have a folder:

qa-runs/
  2026-05-13-two-device-offline-edit/
    scenario.md
    expected.md
    device-a/
      flight.ndjson
      diagnostics.json
      analyzer-report.json
    device-b/
      flight.ndjson
      diagnostics.json
      analyzer-report.json
    server/
      server-events.ndjson
    final-vault-manifest.json
    verdict.md
scenario.md

Contains exact steps:

Scenario: Offline edit handoff

Devices:
- A: macOS Obsidian 1.x, YAOS commit abc
- B: Android Obsidian 1.x, YAOS commit abc

Steps:
1. Start with clean vault.
2. Start QA trace on both devices with shared QA secret.
3. Create `Inbox/a.md` on A.
4. Wait for durable receipt.
5. Close A.
6. Open B.
7. Verify file appears.
expected.md

Contains expected state:

Expected:
- B has Inbox/a.md with exact content.
- No conflict copy.
- A trace has receipt durable confirmed.
- B trace has provider remote update and disk write.
- Analyzer has zero errors.
final-vault-manifest.json

Generated by script.

For every file:

{
  "path": "Inbox/a.md",
  "sha256": "...",
  "size": 123,
  "kind": "markdown"
}

For safe exports, paths can be hashed. For your own QA vaults, raw paths are fine.

Build the QA manifest tool

You need a boring script:

npm run qa:manifest /path/to/vault

Output:

{
  "generatedAt": "...",
  "fileCount": 123,
  "files": [
    {
      "path": "Inbox/a.md",
      "sha256": "...",
      "bytes": 123
    }
  ]
}

Then a compare tool:

npm run qa:compare expected.json actual.json

This is how you avoid “looks synced to me.”

For text sync, byte-for-byte final state is the source of truth. For CRDT concurrent edits, expected content may need scenario-specific rules, but still write them down.

Build the analyzer before doing too much manual QA

Minimum analyzer rules:

1. Unsafe overwrite

Flag:

reconcile.file.decision decision=write-crdt-to-disk
AND diskChangedSinceObserved=true
AND conflictRisk != none
AND no conflict.preserved

This is your data-loss detector.

2. Recovery loop

Flag same path + same disk/crdt/editor hashes repeated more than N times.

recovery.decision signature repeated >= 3
3. Delete followed by revive

Flag:

tombstone.applied/delete.disk.ok
then tombstone.revived/crdt.file.revived
within short window
without explicit local-create reason
4. Self-write suppression miss

Flag:

disk.write.ok
then disk.modify.observed
then disk.event.not_suppressed
then crdt.update from disk-sync

This is a loop seed.

5. Stuck receipt

Flag:

server.receipt.candidate_captured
while online
no confirmed within N seconds

Separate memory and durable receipts.

6. False safe-to-close

Flag:

UI/status says safe
but durable receipt missing

If you have that event.

7. Disk/CRDT idle mismatch

At checkpoint:

diskHash != crdtHash
for same path
and no pending operation/conflict/recovery
8. Missing file-scoped path ID

Any file/folder event without pathId or accepted exception.

9. Redaction failure

Any redaction.failure is a QA warning. Critical redaction failure is a failure.

10. Trace dropped critical event

Automatic QA failure.

The analyzer is your mean junior maintainer that never gets tired.

The device matrix

Do not explode the matrix too early. Start small.

Tier 1: Mandatory
macOS desktop ↔ Android
macOS desktop ↔ Windows desktop
macOS desktop ↔ iPad/iPhone

If you do not have all devices, borrow or recruit testers later. But at least cover desktop + mobile.

Tier 2: Important
Windows ↔ Android
Linux ↔ Android
macOS ↔ macOS
Tier 3: Later
three devices active
large vault on all devices
mobile-only pair
slow network / high latency

Do not start with Tier 3. You will drown.

The scenario list

Here is the initial holy QA suite.

Group A: Startup and setup
A1. Fresh setup, empty vault

Expected:

no errors;
initial reconcile completes;
status truthful;
trace export safe;
analyzer clean.
A2. Fresh setup, existing local vault

Expected:

files seeded/imported according to reconcile policy;
no deletion;
untracked behavior documented;
trace shows decisions.
A3. Second device joins existing server

Expected:

receives server state;
does not require first device online;
local disk writeback correct.
A4. Stale plugin / schema mismatch

Expected:

update required;
no partial sync;
clear status.
A5. Wrong token

Expected:

unauthorized;
no DO trace spam;
no confusing “offline” only state.
Group B: Basic file operations
B1. Create note

A creates note, B receives.

B2. Edit note

A edits, B receives.

B3. Delete note

A deletes, B deletes.

B4. Rename note

A renames, B renames.

B5. Move note into folder

A moves, B moves.

B6. Create/delete empty folder

Expected depends on current support.

If unsupported:

no data loss;
documented limitation;
analyzer should not call it corruption.
B7. Folder rename with files inside

Expected:

all contained files moved;
no duplicate old/new trees;
trace explains tree operation or file rename batch.
Group C: Offline
C1. Offline create then reconnect

A offline creates file, reconnects, B later receives.

C2. Offline edit then reconnect

A offline edits existing file.

C3. Offline delete then reconnect

A offline deletes file.

C4. Offline rename then reconnect

A offline renames file.

C5. A offline edit, B online edit same file

Expected:

merge or conflict preserve;
no silent loss.
C6. Both offline edit same file, then reconnect A then B

Expected:

merge/conflict preserve;
trace clean.
C7. Both offline edit same file, reconnect B then A

Same as C6, reversed. Order matters.

Group D: Editor binding / open file
D1. Same file open on both devices, one edits

Expected:

live sync;
no duplicate chunks;
no cursor/binding crash.
D2. File open but idle, external disk edit occurs

Expected:

policy respected;
recovery decision logged.
D3. File open and active, external disk edit occurs

Expected:

no silent overwrite of active editor;
defer or conflict preserve.
D4. Switch tabs rapidly while syncing

Expected:

no stale binding to wrong file;
timeline shows bind/unbind/rebind.
D5. Close/reopen same file repeatedly during sync

Expected:

no observer leak;
no duplicate writes.
Group E: Recovery and corruption guards
E1. Force CRDT/disk divergence while open

Expected:

recovery decision;
postcondition success;
no loop.
E2. Force repeated same divergence

Expected:

loop detector quarantines/stops;
analyzer flags if repeated.
E3. Frontmatter plugin rewrites note repeatedly

Expected:

guard/quarantine if suspicious;
no infinite append.
E4. Task checkbox spam

Expected:

no duplicate task blocks;
no repeated recovery loop.
E5. Large repeated Markdown blocks

Expected:

diff postcondition passes;
no malformed duplicate insertion.
Group F: Attachments / R2
F1. R2 disabled, create image/PDF

Expected:

user gets honest unsupported/needs R2 message;
no false sync.
F2. R2 enabled, upload image

Expected:

blob hash;
upload;
B downloads;
manifest matches.
F3. R2 enabled, delete attachment

Expected:

blob reference removed/tombstoned according to policy;
no resurrection.
F4. Oversized attachment

Expected:

skipped/rejected before huge server buffering;
clear trace event.
F5. Offline attachment create then reconnect

Expected:

queued upload;
durable result;
no missing blob ref.
Group G: Plugin interactions
G1. Web Clipper bulk import

Create 50/200 notes quickly.

Expected:

all imported;
no “only appears after rename” bug;
trace shows coalescing.
G2. TaskNotes / TaskForge loop

Reproduce old report.

Expected:

no repeated duplicated chunks;
if plugin writes externally, trace distinguishes it.
G3. Templater creates note with frontmatter

Expected:

no frontmatter duplication;
guard does not false-positive normal templates.
G4. Dataview passive vault

Expected:

no writes from Dataview; no weirdness.
G5. Excalidraw file

Expected:

explicit supported/unsupported behavior;
no text CRDT mangling binary-ish content.
G6. Canvas / Bases

Same: support explicitly or skip safely.

Group H: Lifecycle and stress
H1. Kill app before receipt

Expected:

local state preserved if IDB saved;
status on restart conservative;
no false receipt.
H2. Kill app after memory receipt before durable receipt

Expected:

if Layer 4 exists, safe-to-close remains false/unknown;
no lie.
H3. Kill app after durable receipt

Expected:

B can receive later.
H4. Durable Object cold start

Expected:

server reloads checkpoint/journal;
client receives state;
trace shows durable path.
H5. Long idle

Expected:

no log runaway;
no trace quota issue;
no phantom reconcile.
H6. Large vault startup

Expected:

no safety brake false positive;
no mass overwrite;
startup trace clear.
Pass/fail criteria

For every scenario, decide:

PASS

All expected final vault states match. Analyzer has no errors. Warnings are understood and documented.

PASS WITH DOCUMENTED LIMITATION

Behavior is not supported, but:

no data loss;
no silent corruption;
user-visible status/docs are honest;
trace explains unsupported path.

Example: empty folders not synced.

FAIL — correctness

Data lost, overwritten, resurrected incorrectly, duplicated, or corrupted.

FAIL — observability

Behavior was wrong or weird, and the trace cannot explain why.

This is important. If the bug happens and the recorder is useless, that is a QA failure even if you can manually guess the cause.

FAIL — privacy

Safe trace contains raw path/server/device/token-like data.

Immediate blocker.

The issue pass

After the structured QA suite, do the old issue triage.

For each original complaint:

Issue: TaskNotes duplicated chunks
Reproduction: G2
Old likely cause: bound recovery origin misclassified / recovery loop / external frontmatter writes
New result:
- reproduced? yes/no
- fixed? yes/no
- trace evidence:
- regression added:
- status:

Do not mark anything “fixed” unless:

you reproduced it or built an equivalent scenario;
the new behavior is clean;
there is a regression/analyzer rule where possible.

“Probably fixed by new semantics” is how regressions sneak back in.

What to do when QA finds bugs

Use a strict loop:

1. Run scenario.
2. Export traces/diagnostics/manifests.
3. Run analyzer.
4. Write verdict.
5. If fail:
   a. identify root cause from trace;
   b. write minimal regression;
   c. fix;
   d. rerun exact scenario;
   e. rerun neighboring scenarios.

Do not fix five things from one giant chaos run. You will not know what fixed what.

Release gating

Before stabilization release, I would require:

Hard blockers
any data loss;
silent overwrite without conflict copy;
delete resurrection without explicit local-create/revive reason;
recovery loop;
safe trace privacy leak;
false “safe to close”;
server receipt confirmed when server does not dominate candidate;
durable receipt confirmed before durable save;
analyzer unable to parse exported traces.
Soft blockers
unsupported folder empty sync;
unsupported .obsidian sync;
unsupported plugin-specific files;
attachment sync disabled without R2.

Soft blockers must be documented and reflected in UI/status.

Suggested stabilization release scope

When QA passes, ship a stabilization release, not a feature release.

Changelog should say:

YAOS Stability Release

- Safer recovery with postcondition checks.
- Conflict preservation for ambiguous disk/CRDT divergence.
- Server receipt status clarified.
- Durable receipt / safe-to-close signal if implemented.
- Flight recorder and safe diagnostics.
- Improved offline handoff behavior.
- Fixed historical duplicate/revert/delete reports where reproduced.
- Documented remaining limits: empty folders, .obsidian sync, unsupported file types.

Do not bury limitations. Put them in the release notes.

That builds trust.

My recommended immediate next move

Do three small dry runs before the full holy QA.

Dry Run 1: Single-device trace sanity

Create/edit/delete one note. Export trace. Run analyzer.

Expected:

all events present;
no raw paths in safe export;
current-file timeline useful.
Dry Run 2: Two-device create/edit handoff

A creates note, waits receipt, closes. B opens and receives.

Expected:

A trace shows local op → receipt.
Server trace shows update/save.
B trace shows remote apply → disk write.
Manifests match.
Dry Run 3: Known nasty scenario

Pick the old duplicate-chunk/frontmatter/task loop.

Expected:

either fixed, or trace clearly shows why not.

Only after these pass should you run the full matrix.

Final verdict

Yes, QA is the next thing.

But QA should not be “use YAOS for a week and see.”

It should be:

A reproducible stabilization campaign with scenarios, manifests, traces, analyzer reports, and issue-by-issue root-cause closure.

The order now:

1. Dry-run the recorder.
2. Build manifest/compare/analyzer scripts.
3. Run single-device suite.
4. Run two-device baseline.
5. Run offline/reconnect.
6. Reproduce historical issues.
7. Run plugin-interaction torture.
8. Run mobile lifecycle.
9. Run long soak.
10. Close issues with evidence.

That is the path from “cool project” to “sync tool people can trust.”
