The QA goal is:

For every scary historical failure mode, produce a reproducible scenario, run it across real Obsidian/device conditions, capture flight traces, and decide: fixed, not fixed, or misunderstood.

You need a QA campaign, not a vibes session.

Overall QA verdict

Your next milestone should be:

YAOS Holy QA Run v1

Exit criteria:

No known reproducible data-loss/corruption bugs.
Offline handoff works without simultaneous device presence.
Disk ↔ CRDT ↔ server ↔ remote disk lifecycle is traceable.
Every old Reddit/Discord/GitHub complaint is classified.
Every scary fixed bug has a regression test or manual QA script.
Every remaining limitation is documented honestly.

Do not start .obsidian sync, self-hosting, folders, or Layer 4 UI until this is done.

The QA structure

Split the QA into four layers:

Automated regression suite
Simulated multi-client integration
Real Obsidian multi-device QA
Historical bug replay

Each layer catches different crap. Do not pretend one replaces the other.

Layer 1: automated regression suite

This is your “don’t re-break known logic” layer.

You already have many regression tests. Good. Now organize them by invariant, not by random filename.

Required groups
Sync correctness
file create
file modify
file delete
file rename
folder rename as batch path move
tombstone prevents stale resurrection
explicit local recreate revives tombstone
bulk import after delete
empty file behavior
oversized file skip
excluded path skip
conflict copy / ambiguous divergence behavior
Editor/recovery correctness
open editor bound to Y.Text
local-only divergence
CRDT-only divergence
ambiguous divergence
frontmatter quarantine
recovery does not write stale editor content back
repair-only path does not amplify
Receipt/offline correctness
local candidate captured
server echo confirms candidate
restart with persisted candidate
stale persisted candidate discarded
candidate persistence failure reported
coalesced candidate with multiple file ops
Diagnostics/flight recorder
safe logs contain no raw path/token/host/vault ID
full logs contain filenames but no token/content
path IDs correlate across devices with shared QA secret
op timeline survives rotation/export
analyzer identifies incomplete lifecycle
dropped events are counted
Server hardening
unauthorized requests do not touch room DO
capabilities public/private split, if implemented
oversized blob upload precheck
trace rate limit
update-required protocol rejection
schema mismatch rejection

This is the boring foundation. Good tests are boring.

Layer 2: simulated multi-client integration

Before touching real devices, you need fake clients that can run fast.

This should simulate:

Client A VaultSync
Client B VaultSync
shared test server / fake provider / real-ish Yjs path
fake vault adapter
fake disk mirror
flight recorder on both clients

You want scenarios like:

A edits, B offline

Expected:

A disk.create.observed
A crdt.file.created
A server.receipt.confirmed
A disconnects
B connects cold
B provider.remote_update.applied
B disk.write.ok
B checkpoint: diskHash == crdtHash
A deletes, B stale

Expected:

A crdt.file.tombstoned
B receives tombstone
B deletes local replica
B does not recreate file from stale disk scan
Both edit same file offline

Expected:

both edits preserved by CRDT semantics
or conflict path created if ambiguous
no silent blanking
no exponential duplication
Bulk import storm

Expected:

N disk create events
N CRDT entries or intentionally skipped entries
no missing files after idle convergence
no trace overflow dropping critical events

These should run without opening Obsidian. This is where you catch protocol and state-machine stupidity quickly.

Layer 3: real Obsidian multi-device QA

This is the actual “does the product work?” layer.

You need a fixed matrix. Not random usage.

Minimum device matrix

Start with four environments:

Mac desktop
Windows desktop
Linux desktop
iOS mobile

Android if you can get it. But Mac/Windows/Linux/iOS already catches plenty.

Required pairings

Run at least:

Mac ↔ iOS
Windows ↔ iOS
Linux ↔ iOS
Mac ↔ Windows
Mac ↔ Windows ↔ iOS

Why? Because most scary sync failures happen at platform boundaries: file watchers, Unicode, mobile lifecycle, backgrounding, and path casing.

Vault sizes

Use three vaults:

Tiny vault
10 markdown files
2 folders
1 attachment

For quick smoke.

Realistic vault
500-1500 markdown files
nested folders
frontmatter-heavy files
attachments
canvas/base/excalidraw

For product QA.

Nasty vault
weird Unicode filenames
case-colliding names
empty folders
empty files
large files
deep paths
many attachments
plugin-generated files

For breaking things deliberately.

The actual QA scenario list
1. Basic live sync
Scenario

A and B online. Edit markdown on A.

Expected:

B updates without manual refresh.
Flight trace shows A disk/editor → CRDT → receipt.
B shows remote apply → disk write/materialization.
No hash mismatch after idle.

Run:

new file
edit existing file
delete file
rename file
move file
2. Offline handoff

This is the old scary report. Test it brutally.

Scenario
A online, B closed.
A creates/edits/deletes files.
Wait until server receipt confirms.
Close A completely.
Open B.
B must receive changes without A reopening.

Expected:

B catches up.
No simultaneous presence needed.
Trace proves server had state before A closed.
Analyzer reports complete lifecycle.

This is a release gate.

If this fails, stop everything.

3. Mobile background/foreground
Scenario
iOS open, desktop open.
Edit on desktop.
Background iOS.
Edit more on desktop.
Foreground iOS.
Verify catch-up.

Reverse it:

Edit on iOS.
Immediately background/close Obsidian.
Desktop should catch up if receipt completed.
If receipt did not complete, status must honestly say so.

Expected:

no silent “looked synced but wasn’t”
no missing mobile-created notes
no duplicate files after foreground
4. Bulk import
Scenario

Copy 100 markdown files into vault via file manager.

Run variants:

new paths
paths previously deleted
nested folders
Unicode filenames
iOS target receiving

Expected:

all eligible files appear.
tombstoned paths revive only for explicit local create.
no missing files inside visible folders.
analyzer reports no incomplete lifecycle.

This directly re-tests the previous bulk import tombstone bug.

5. Web Clipper / external app ingest

This targets issue #19.

Scenario

On iOS:

clip 10 articles quickly
clip while desktop offline
clip while desktop online
rename a missing-looking clipped file
background/foreground during clipping

Expected:

clipped files appear on desktop.
no “rename to force sync” needed.
if file is skipped, trace says why.

If this fails, it is probably watcher lifecycle / delayed materialization / external edit policy.

6. .base, canvas, Excalidraw

Do not lump these together mentally.

.base

Expected answer needed:

Is .base text sync?
blob sync?
unsupported?
special policy?

Test:

create .base
edit .base layout
restart both devices
offline edit then reconnect

Expected:

no silent reversion.
if unsupported, explicit skip reason.
Canvas

Test:

create canvas on desktop
edit canvas on mobile
edit canvas on desktop
attachment/R2 disabled
attachment/R2 enabled

Expected:

behavior matches documented model.
no one-way weirdness.
Excalidraw

Test:

edit Excalidraw file
save
sync to phone
sync back

Expected:

no Obsidian breakage.
if treated as attachment, R2 requirement is visible.
no corrupt partial writes.
7. Frontmatter and task plugins

This is a known minefield.

Set up a vault with:

TaskNotes-like frontmatter edits
TaskForge-like external app edits, if possible
Obsidian Properties UI
Dataview-heavy files
Tasks plugin format

Scenarios:

change property on desktop
change property on mobile
external app modifies YAML
rapid repeated task priority toggles
invalid YAML injected
concurrent YAML edits

Expected:

no infinite duplication.
unsafe YAML quarantined.
body text still syncs if safe.
trace shows frontmatter decision reason.
user-visible pause/resume path exists.
8. Delete/rename/move semantics

This must be exhaustive.

File delete
A deletes file
B receives delete
B does not resurrect
B trash behavior matches configured policy
Folder delete
A deletes folder with 20 descendants
B receives delete
no descendant resurrection
Rename
A renames file
B sees only new path
old path tombstoned or moved correctly
no old+new duplicate unless conflict is expected
Move
A moves folder
B gets moved descendants
no partial folder tree

Expected:

final disk/CRDT path sets match.
no stale resurrection.
trace explains tombstone/revive behavior.
9. Empty file and empty folder behavior
Empty file

Test:

create empty.md
sync
edit from empty to nonempty
edit from nonempty to empty
external app writes zero-length file

Expected:

intentional empty file syncs.
suspicious nonempty→empty external overwrite is either allowed with reason or quarantined by policy.
no accidental blanking.
Empty folder

You need to decide current behavior.

If empty folders are unsupported:

QA should verify they are skipped consistently.
UI/docs should say so.
trace should emit folder.empty.unsupported or similar if observed.

If you implement folder semantics later, that is separate.

10. iCloud/Dropbox/Syncthing/Git conflict warning

You do not need to support running multiple sync engines.

But you should test what happens.

Scenarios:

vault inside iCloud
vault inside Dropbox
Obsidian Git auto-push/pull enabled
Syncthing modifies files underneath

Expected:

ideally warning/detection
no known data corruption
docs say “do not run live sync engines together”
trace records external event storms

This is important because users will do stupid things. Software has to survive users being users.

QA instrumentation requirements

Before running the matrix, make sure every run produces a bundle:

device logs
server trace
flight NDJSON
checkpoint summaries
final disk/crdt hash comparison
analyzer report
environment metadata
YAOS versions
server version
plugin version
settings summary

No raw token. No note contents.

For every scenario, save:

scenario name
devices used
vault fixture
steps
expected result
actual result
pass/fail
trace bundle path
analyzer summary
issue link if failed

Make this mechanical.

The analyzer report

For each run, analyzer should output:

Scenario: offline-handoff-md-create
Result: PASS

Devices:
- MacBook boot=...
- iPhone boot=...

Operations:
- 1 disk create
- 1 CRDT create
- 1 server receipt confirmed
- 1 remote materialization

Failures:
- 0 incomplete ops
- 0 hash mismatches
- 0 stuck receipts
- 0 dropped critical events
- 0 redaction failures

For failure:

Scenario: webclipper-bulk-ios
Result: FAIL

Path p:abc123
Observed:
- iPhone disk.create.observed
- iPhone crdt.file.created
- iPhone server.receipt.confirmed
Missing:
- Windows provider.remote_update.applied
- Windows disk.write.ok

Likely layer: remote provider/materialization

That is useful. “It didn’t sync” is not.

Historical issue replay

Make a table.

Complaint / issue
Scenario
Expected proof
Status
Root cause
Regression added?

Example:

Bulk imported notes missing on iOS

Scenario:

delete folder
wait
copy same folder back via file manager
sync to iOS

Expected:

local create revives tombstone
iOS receives files
no missing children

Status:

fixed / regression added / trace proves revive
Deleted folders coming back

Scenario:

A delete folder
B stale offline
B reconnect

Expected:

tombstone beats stale disk state
Empty file corruption

Scenario:

external tool writes zero-byte file over nonempty file

Expected:

policy decision visible
no silent propagation unless intentional

Do this for every scary complaint.

Pass/fail gates
Hard fail

The release fails if any of these happen:

note contents silently disappear
file blanks propagate unintentionally
deleted file/folder resurrects without explicit local recreate
offline handoff requires original device to come back
CRDT/disk hash mismatch remains after idle convergence with no reason
frontmatter duplication loop appears
unsafe diagnostics export raw token/content
analyzer sees incomplete lifecycle for a supposedly passed scenario
Soft fail

Allowed if documented:

empty folders unsupported
.obsidian unsupported
certain plugin settings unsupported
Excalidraw requires R2
iCloud/Dropbox/Syncthing unsupported
Layer 4 UI not complete yet

Soft fails must be explicit. Silent behavior is not acceptable.

QA schedule

Do it in this order.

Phase 0: QA fixtures

Create vault fixtures:

fixtures/tiny-vault
fixtures/realistic-vault
fixtures/nasty-vault
fixtures/frontmatter-vault
fixtures/blob-vault

These should be versioned, deterministic, and reusable.

Phase 1: analyzer dry run

Run fake traces through analyzer.

Make sure analyzer catches:

missing CRDT event
missing receipt
missing remote disk write
safety brake
dropped critical event
hash mismatch
Phase 2: automated integration scenarios

Run simulated clients until green.

Phase 3: two-device real Obsidian

Run Mac ↔ iOS or Windows ↔ iOS first.

Do not use all devices immediately. Debug one pairing first.

Phase 4: full matrix

Run all pairings and fixtures.

Phase 5: historical replay

Reproduce old bugs intentionally.

Phase 6: issue closure

Close or update GitHub issues with evidence.

Not “should be fixed.” Evidence.

How to document each QA run

Create a file like:

qa/runs/2026-05-holy-qa-v1/README.md

For each scenario:

## offline-handoff-md-create

Devices:
- MacBook Pro, macOS ...
- iPhone 13 mini, iOS ...

YAOS:
- plugin version:
- server version:
- worker deployment:

Steps:
1. ...
2. ...

Expected:
- ...

Result:
PASS

Analyzer:
- incomplete ops: 0
- mismatches: 0
- critical drops: 0

Artifacts:
- safe trace bundle: ...
- full local trace: not exported

This becomes your trust artifact.

What to work on before running QA

Assuming the recorder is “done,” only three things should block QA:

Analyzer MVP
Reusable vault fixtures
Scenario checklist

If those exist, start.

Do not keep polishing the recorder forever. At some point you need to hit it with a hammer.

What not to do during QA

Do not:

fix bugs silently without logging root cause
change five systems at once
use your personal vault as the only test vault
rely on visual inspection only
skip mobile lifecycle tests
ignore failures because “probably Cloudflare”
close issues without proof
add new features mid-QA

QA is not a development playground. It is an evidence factory.

Final recommendation

Your next milestone should be:

Holy QA v1

Scope:

Analyzer MVP.
Test fixtures.
Scenario matrix.
Real Obsidian runs.
Historical bug replay.
Issue triage with root causes.
Stabilization release notes.

After that, you can decide:

Layer 4 semantics
folder semantics
.obsidian sync
self-hosting
CLI

But not before.

The order is now:

QA proof → bug fixes → QA rerun → stabilization release → new features

That is the grown-up path.
