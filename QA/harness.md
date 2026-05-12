Mocks are useful for pure logic. They are not enough for YAOS anymore.

The historical bugs are not “does this pure function return true?” bugs. They are:

Obsidian editor lifecycle + plugin writes + filesystem events + IndexedDB + Yjs + mobile lifecycle + Cloudflare timing

A mock will happily lie to you about all of that.

So build a QA harness that runs inside real Obsidian, uses real vaults, real plugins, real editor views, real file events, and real YAOS. Then use Node/Playwright only as the outside orchestrator.

Do not replace Obsidian with mocks. Treat Obsidian as the kernel/userspace boundary you must test against.

The right mental model

You need three layers of tests.

Layer 1: Pure tests
- Yjs origin classification
- state vector dominance
- path redaction
- flight recorder privacy
- conflict decision functions
- diff postconditions

Layer 2: Obsidian-in-process tests
- run inside real Obsidian
- use real vault adapter
- use real editor
- use real plugins
- use real YAOS runtime
- driven by a QA harness plugin / dev-console bridge

Layer 3: Multi-device orchestration
- multiple Obsidian instances
- desktop + mobile where possible
- shared Cloudflare server
- external controller starts scenarios, collects traces/manifests

The thing you are describing is Layer 2 + Layer 3.

That is where the trust comes from.

Build a QA Harness plugin

Do not just paste random snippets into DevTools forever. That is amateur garbage.

Create a small internal-only plugin:

packages/obsidian-qa-harness/
  manifest.json
  main.ts
  scenarios/
  fixtures/

Or inside the repo:

qa/obsidian-harness/
  main.ts
  scenarios/
  fixtures/
  templates/
  plugin-presets/

This plugin should expose a global object in Obsidian:

window.YAOS_QA

Example:

window.YAOS_QA = {
  runScenario,
  listScenarios,
  resetVault,
  installFixture,
  enablePluginPreset,
  collectManifest,
  collectFlightTrace,
  collectDiagnostics,
  openFile,
  typeText,
  toggleCheckbox,
  waitForYAOSIdle,
  waitForReceipt,
  waitForDurableReceipt,
  assertVaultManifest,
};

Then the dev console can do:

await YAOS_QA.runScenario("tasknotes-checkbox-storm")

And your external controller can do the same through Playwright/Electron DevTools.

This gives you both:

manual debugging from DevTools;
automated orchestration from scripts.

Do not make “paste this 500-line script into console” the test harness. That becomes rot.

Why a harness plugin is better than DevTools-only

DevTools is good for poking. It is not good as the main system.

A harness plugin can:

call Obsidian APIs directly;
register commands;
open files in real editors;
wait for layout readiness;
access YAOS plugin internals through a debug API;
read/write vault files through the real vault adapter;
enable/disable plugins;
emit QA checkpoints into the flight recorder;
export artifacts cleanly.

DevTools can trigger the harness. The harness should do the actual work.

YAOS must expose a test/debug API

You need an internal API from the YAOS plugin. Not public product API. QA/debug only.

Something like:

interface YaosQaDebugApi {
  getState(): YaosQaState;
  startFlightTrace(options: QaTraceOptions): Promise<void>;
  stopFlightTrace(): Promise<void>;
  exportFlightTrace(options: ExportOptions): Promise<string>;
  exportDiagnostics(options: ExportOptions): Promise<string>;

  waitForLocalReady(timeoutMs: number): Promise<void>;
  waitForProviderSynced(timeoutMs: number): Promise<void>;
  waitForMemoryReceipt(timeoutMs: number): Promise<void>;
  waitForDurableReceipt(timeoutMs: number): Promise<void>;
  waitForIdle(timeoutMs: number): Promise<void>;

  forceReconcile(): Promise<void>;
  forceReconnect(): Promise<void>;
  getActiveMarkdownPaths(): string[];
  getHashManifest(): Promise<VaultManifest>;
}

Expose it only when debug/QA mode is enabled:

(window as any).__YAOS_DEBUG__ = api;

or better:

app.plugins.plugins["yaos"]?.qa

Do not make the QA harness reach into random private fields. That is brittle. Give it a narrow debug surface.

The QA harness should be scenario-based

A scenario is a real test case with metadata, steps, expected results, and artifacts.

export interface QaScenario {
  id: string;
  title: string;
  tags: string[];

  requiredPlugins?: string[];
  requiredCapabilities?: {
    r2?: boolean;
    durableReceipt?: boolean;
    mobile?: boolean;
  };

  setup(ctx: QaContext): Promise<void>;
  run(ctx: QaContext): Promise<void>;
  assert(ctx: QaContext): Promise<void>;
  cleanup?(ctx: QaContext): Promise<void>;
}

Example:

export const taskNotesCheckboxStorm: QaScenario = {
  id: "tasknotes-checkbox-storm",
  title: "TaskNotes checkbox storm does not duplicate task blocks",
  tags: ["plugin", "tasknotes", "frontmatter", "recovery"],

  requiredPlugins: ["obsidian-tasknotes"],

  async setup(ctx) {
    await ctx.vault.write("Tasks/project.md", TASKNOTE_TEMPLATE);
    await ctx.open("Tasks/project.md");
    await ctx.waitForYaosIdle();
  },

  async run(ctx) {
    for (let i = 0; i < 50; i++) {
      await ctx.editor.toggleCheckbox("Tasks/project.md", i % 5);
      await ctx.sleep(50);
    }
  },

  async assert(ctx) {
    await ctx.waitForYaosIdle();
    await ctx.assertNoAnalyzerErrors();
    await ctx.assertNoDuplicateBlocks("Tasks/project.md");
    await ctx.assertDiskEqualsCrdt("Tasks/project.md");
  },
};

This is the shape you want.

Not “test scripts.” Scenarios.

The harness should drive real Obsidian editor behavior

Do not only use:

app.vault.modify(file, content)

That bypasses important editor behavior.

You need both:

Vault-level operations

Use these to simulate external/plugin disk writes:

await app.vault.create(path, content)
await app.vault.modify(file, content)
await app.vault.delete(file)
await app.vault.rename(file, newPath)

These trigger vault events and test disk ingestion.

Editor-level operations

Use CodeMirror / Obsidian editor APIs to simulate user typing:

const view = app.workspace.getActiveViewOfType(MarkdownView);
view.editor.replaceRange("hello", view.editor.getCursor());

Or:

view.editor.setValue(newContent);

But setValue is blunt. For live sync, you need incremental operations too:

for (const ch of "hello world") {
  view.editor.replaceRange(ch, view.editor.getCursor());
  await sleep(30);
}

The old bugs happened while typing and while editor bindings were active. Do not test only vault writes.

UI-level operations

Use actual Obsidian commands where possible:

await app.commands.executeCommandById("editor:toggle-checklist-status")

This matters for Tasks/TaskNotes behavior.

If a real plugin registers commands, call those commands. Do not fake their output unless you are testing only YAOS.

Incorporate plugins people actually care about

You need plugin presets.

qa/plugin-presets/
  minimal.json
  tasks.json
  tasknotes.json
  templater.json
  dataview.json
  web-clipper.json
  excalidraw.json
  canvas-bases.json
  hostile-sync.json

Each preset says:

{
  "plugins": [
    {
      "id": "obsidian-tasks-plugin",
      "source": "community",
      "version": "x.y.z",
      "enabled": true,
      "settingsFixture": "tasks-settings.json"
    }
  ]
}

Do not rely on “whatever plugins I have installed.” QA needs reproducibility.

Priority plugins/templates

Start with these:

1. Tasks

Why:

checkbox churn;
task line mutation;
common user workflow.

Scenarios:

toggle 100 tasks rapidly;
recurring task edits;
task query block remains stable;
same file open on two devices.
2. TaskNotes / TaskForge

Why:

your historical complaints mention this class;
frontmatter and task metadata churn;
external plugin writes while YAOS has editor binding.

Scenarios:

create task note from template;
complete task repeatedly;
modify scheduled/due metadata;
bulk task update;
same note open during plugin write.
3. Templater

Why:

templates create files with frontmatter;
common startup/new-note workflows.

Scenarios:

create note from template;
template inserts date/frontmatter;
template modifies existing file;
rapid template creation.
4. Dataview

Why:

mostly read-only, but heavily used;
should not cause churn;
verifies YAOS does not confuse rendered views with edits.

Scenarios:

dataview query pages present;
edits to source notes update normally;
no phantom writes.
5. Web Clipper

Why:

old report: bulk clipped notes missing until rename;
creates many files quickly.

Scenarios:

create 50/200 clipped notes;
nested folders;
attachments if supported.
6. Excalidraw

Why:

special file format;
often JSON/Markdown hybrid;
plugin writes large chunks.

Scenarios:

create drawing;
edit drawing;
rename drawing;
attach image;
verify supported/unsupported behavior.
7. Canvas / Bases

Why:

Obsidian-native non-standard file types;
users will expect clarity.

Scenarios:

create canvas/base;
edit;
sync or skip according to policy;
no corruption.
Use real templates and fixture vaults

You should create fixture vaults.

qa/fixtures/vaults/
  minimal/
  tasks-vault/
  tasknotes-vault/
  templater-vault/
  webclipper-bulk/
  excalidraw-vault/
  large-vault/
  hostile-frontmatter/

Each fixture includes:

.obsidian/
  plugins/
  themes? maybe not
  snippets? maybe not
Notes/
Templates/
Tasks/
Attachments/

But be careful: do not commit proprietary plugin code into your repo unless licenses allow it.

For community plugins, you can write an installer script:

npm run qa:install-plugin -- tasks
npm run qa:install-plugin -- templater

It downloads specific releases into the fixture vault.

Pin versions. QA without pinned versions is soup.

Template fixtures people care about

You need realistic note shapes.

Daily note template
---
date: <% tp.date.now("YYYY-MM-DD") %>
tags:
  - daily
---

# <% tp.date.now("dddd, MMMM D, YYYY") %>

## Tasks
- [ ] Review YAOS
- [ ] Write notes

## Log
Task note template
---
type: task
status: open
priority: medium
due: 2026-05-15
scheduled: 2026-05-12
project: YAOS
tags:
  - task
---

# Fix sync recovery loop

- [ ] reproduce
- [ ] inspect trace
- [ ] add regression
Frontmatter-heavy note
---
aliases:
  - Test Note
created: 2026-05-12
updated: 2026-05-12
status: active
projects:
  - YAOS
metadata:
  source: web
  clipped: true
---

# Frontmatter Test

Body.
Task block stress note
# Task Storm

- [ ] task 001
- [ ] task 002
...
- [ ] task 200
Repeated markdown block note

This catches diff/recovery bugs:

## Repeated

- item
- item
- item

## Repeated

- item
- item
- item
Web clipper article shape
---
source: https://example.com/article
author: Someone
clipped: 2026-05-12
---

# Article Title

Long body...
![[image.png]]

These templates should live in qa/templates/, not random notes.

The harness should support multi-device roles

A scenario should know which device is doing what.

type DeviceRole = "A" | "B" | "C";

interface MultiDeviceScenario {
  id: string;
  devices: DeviceRole[];

  setup(ctx: MultiDeviceContext): Promise<void>;
  run(ctx: MultiDeviceContext): Promise<void>;
  assert(ctx: MultiDeviceContext): Promise<void>;
}

Example:

await ctx.device("A").open("Daily/today.md");
await ctx.device("A").typeText("Daily/today.md", "hello");
await ctx.device("A").waitForDurableReceipt();

await ctx.device("B").waitForFile("Daily/today.md");
await ctx.device("B").assertFileContains("Daily/today.md", "hello");

You need an external controller that talks to each Obsidian instance.

External orchestration

For desktop, use Playwright or Electron automation.

Obsidian is Electron. You can attach to DevTools or launch with remote debugging:

open -a Obsidian --args --remote-debugging-port=9222

Then Playwright:

const browser = await chromium.connectOverCDP("http://localhost:9222");
const page = browser.contexts()[0].pages()[0];

await page.evaluate(async () => {
  return await window.YAOS_QA.runScenario("single-device-basic-edit");
});

For two desktop instances:

Obsidian A: remote debugging port 9222, vault A
Obsidian B: remote debugging port 9223, vault B

Controller:

const A = await connectObsidian(9222);
const B = await connectObsidian(9223);

await A.eval(() => YAOS_QA.startTrace(...));
await B.eval(() => YAOS_QA.startTrace(...));

await A.eval(() => YAOS_QA.runStep("create-note"));
await B.eval(() => YAOS_QA.waitForFile("Inbox/test.md"));

For mobile, full automation is harder. Start with manual harness commands inside Obsidian mobile where possible. Later use Appium if you are insane enough. Desktop + Android manual-assisted QA is still better than mocks.

Dev console bridge

Since you specifically mentioned the dev console: yes, expose a nice bridge.

In the harness plugin:

declare global {
  interface Window {
    YAOS_QA: QaConsoleApi;
  }
}

API:

interface QaConsoleApi {
  help(): void;
  list(): string[];
  run(id: string, options?: QaRunOptions): Promise<QaResult>;
  step(id: string, step: string): Promise<void>;

  startTrace(options?: QaTraceOptions): Promise<void>;
  stopTrace(): Promise<void>;
  export(): Promise<QaArtifacts>;

  manifest(): Promise<VaultManifest>;
  compare(expected: VaultManifest): Promise<ManifestDiff>;

  open(path: string): Promise<void>;
  type(path: string, text: string, options?: TypingOptions): Promise<void>;
  modify(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;

  waitForIdle(): Promise<void>;
  waitForMemoryReceipt(): Promise<void>;
  waitForDurableReceipt(): Promise<void>;

  plugins(): Promise<PluginState[]>;
  enablePlugin(id: string): Promise<void>;
  disablePlugin(id: string): Promise<void>;
}

Then in console:

await YAOS_QA.run("offline-edit-handoff")
await YAOS_QA.export()

This is good. This makes manual reproduction much less stupid.

Important: tests should call real plugin commands

For plugin workflows, prefer invoking the plugin’s own commands/UI paths.

Example:

await app.commands.executeCommandById("templater-obsidian:create-new-note-from-template");

or:

await app.commands.executeCommandById("obsidian-tasks-plugin:toggle-done");

Command IDs vary. The harness should list commands:

Object.keys(app.commands.commands).filter(id => id.includes("task"))

QA should save the command IDs used in artifacts:

{
  "plugin": "obsidian-tasks-plugin",
  "commandId": "obsidian-tasks-plugin:toggle-done",
  "version": "..."
}

Otherwise future failures are impossible to reproduce.

Plugin version pinning

Do not test “Tasks latest” without recording version.

Every QA artifact should include:

{
  "obsidianVersion": "...",
  "installerVersion": "...",
  "yaosVersion": "...",
  "yaosCommit": "...",
  "plugins": [
    {
      "id": "obsidian-tasks-plugin",
      "version": "7.20.0",
      "enabled": true
    }
  ]
}

Plugin behavior changes. If you do not record versions, you are debugging ghosts.

QA presets

Define presets:

minimal

Only YAOS.

Use for correctness baseline.

notes-basic

YAOS + Daily Notes/core templates if relevant.

tasks

YAOS + Tasks.

tasknotes

YAOS + TaskNotes/TaskForge.

templater

YAOS + Templater.

research-vault

YAOS + Dataview + Templater + Tasks.

creative-vault

YAOS + Excalidraw + Canvas-heavy files.

hostile-vault

YAOS + plugins that rewrite frontmatter/files frequently.

You do not need all from day one. But design the harness around presets.

The harness must generate artifacts automatically

At the end of every run:

qa-output/
  run-2026-05-12T21-00-00Z/
    metadata.json
    scenario.md
    expected.json
    device-A/
      flight.ndjson
      diagnostics.json
      manifest.json
      analyzer.json
      console.log
    device-B/
      ...
    server/
      server-events.ndjson
    verdict.json

The harness should do this itself. If artifact collection is manual, you will forget something exactly when the interesting bug happens.

In-Obsidian assertions

The harness should have assertion helpers.

await ctx.assert.fileExists("Inbox/a.md");
await ctx.assert.fileNotExists("Inbox/deleted.md");
await ctx.assert.fileContains("Inbox/a.md", "hello");
await ctx.assert.fileHash("Inbox/a.md", expectedHash);
await ctx.assert.noConflictCopies();
await ctx.assert.noAnalyzerErrors();
await ctx.assert.diskEqualsCrdt("Inbox/a.md");
await ctx.assert.noDuplicateBlock("Tasks/project.md", "task 001");

Use real vault reads for disk. Use YAOS debug API for CRDT.

Example:

const disk = await ctx.vault.read("Inbox/a.md");
const crdt = await ctx.yaos.getCrdtText("Inbox/a.md");
assert(hash(disk) === hash(crdt));

This is how you catch drift before another device exposes it.

Wait helpers are critical

Most flaky tests are just bad waiting.

Add explicit waiters:

await waitFor(() => yaos.localReady, 10000);
await waitFor(() => yaos.providerSynced, 30000);
await waitFor(() => yaos.reconciled, 30000);
await waitFor(() => yaos.memoryReceiptReceived, 10000);
await waitFor(() => yaos.durableReceiptReceived, 30000);
await waitFor(() => ctx.fileExists(path), 30000);
await waitFor(() => ctx.diskEqualsCrdt(path), 30000);

Never do:

await sleep(5000)

except when intentionally testing idle/debounce behavior.

Sleep-based tests are crap.

How to test templates/plugin workflows

You need two modes:

Mode 1: Fixture-driven

The harness writes a note/template directly:

await ctx.installTemplate("tasknote-basic");
await ctx.createFromTemplate("Tasks/foo.md", "tasknote-basic");

Good for deterministic baseline.

Mode 2: Plugin-driven

The harness invokes the real plugin command or UI path.

Example:

await ctx.plugins.templater.createNoteFromTemplate("Daily", "Daily/2026-05-12.md");

This is more realistic.

Use both.

Fixture-driven tells you YAOS can handle the resulting file shape. Plugin-driven tells you YAOS can handle the actual plugin’s timing/writes.

Test the timings that cause bugs

Plugin interactions are timing bugs.

For every important scenario, run variants:

file closed
file open but inactive
file open and active
file open on both devices
device offline
device reconnecting
during startup reconcile
during provider sync
during receipt wait

Example: Templater creates frontmatter.

Run it:

while the file is closed;
while newly opened;
while YAOS is still reconciling;
while another device has the file open;
while offline then reconnecting.

That is how you find the real bugs.

What not to mock

Do not mock:

Obsidian vault events;
editor binding lifecycle;
CodeMirror editor;
workspace leaves;
plugin commands;
file adapter;
IndexedDB;
provider lifecycle for integration QA.

You may still mock:

Cloudflare for pure server unit tests;
hash functions for path identity tests;
time for debounce unit tests;
tiny pure decision functions.

Mocks are fine for Layer 1. They are not acceptable as proof for Layer 2/3.

A practical build plan
Step 1: Create the harness plugin

Minimum:

window.YAOS_QA.help()
window.YAOS_QA.run(id)
window.YAOS_QA.open(path)
window.YAOS_QA.type(path, text)
window.YAOS_QA.manifest()
window.YAOS_QA.export()

One scenario:

single-device-basic-edit
Step 2: Add YAOS debug API

Expose:

waitForIdle
waitForReceipt
getCrdtHash
getDiskHash
exportTrace
exportDiagnostics
Step 3: Add external controller
npm run qa:obsidian -- --scenario single-device-basic-edit --vault ./qa/tmp/vault-a --port 9222

It:

launches/attaches to Obsidian;
waits for window.YAOS_QA;
starts trace;
runs scenario;
exports artifacts;
runs analyzer;
exits pass/fail.
Step 4: Add fixture vault installer
npm run qa:prepare-vault -- --preset tasks --out ./qa/tmp/tasks-vault

It copies fixture, installs pinned plugin versions, writes .obsidian/community-plugins.json, settings, YAOS config.

Step 5: Add two-device controller
npm run qa:two-device -- --scenario offline-edit-handoff --preset minimal

Starts two Obsidian instances, two vaults, same QA secret.

Step 6: Add plugin presets

Start with:

minimal
tasks
templater
tasknotes
webclipper

Then Excalidraw/Canvas/Bases.

Example scenario: Templater + YAOS
export const templaterDailyNote: QaScenario = {
  id: "templater-daily-note-sync",
  title: "Templater daily note creation syncs without frontmatter duplication",
  tags: ["templater", "frontmatter", "create"],

  requiredPlugins: ["templater-obsidian"],

  async setup(ctx) {
    await ctx.installTemplate("daily-basic");
    await ctx.waitForYaosIdle();
  },

  async run(ctx) {
    await ctx.pluginCommand("templater-obsidian:create-new-note-from-template", {
      template: "Templates/daily-basic.md",
      target: "Daily/2026-05-12.md",
    });
    await ctx.waitForYaosIdle();
  },

  async assert(ctx) {
    await ctx.assert.fileExists("Daily/2026-05-12.md");
    await ctx.assert.frontmatterValid("Daily/2026-05-12.md");
    await ctx.assert.noDuplicateFrontmatter("Daily/2026-05-12.md");
    await ctx.assert.diskEqualsCrdt("Daily/2026-05-12.md");
    await ctx.assert.noAnalyzerErrors();
  },
};

If plugin command parameterization is impossible, fall back to UI automation or fixture-driven creation. But record which path was used.

Example scenario: Task checkbox storm
export const tasksCheckboxStorm: QaScenario = {
  id: "tasks-checkbox-storm",
  title: "Tasks checkbox storm does not duplicate or revert content",
  tags: ["tasks", "editor", "rapid-edit"],

  requiredPlugins: ["obsidian-tasks-plugin"],

  async setup(ctx) {
    await ctx.vault.write("Tasks/storm.md", makeTaskStormNote(200));
    await ctx.open("Tasks/storm.md");
    await ctx.waitForYaosIdle();
  },

  async run(ctx) {
    for (let i = 0; i < 100; i++) {
      await ctx.editor.setCursorToTaskLine(i % 200);
      await ctx.command("editor:toggle-checklist-status");
      await ctx.sleep(20);
    }
    await ctx.waitForYaosIdle();
  },

  async assert(ctx) {
    await ctx.assert.noDuplicateTaskLines("Tasks/storm.md");
    await ctx.assert.diskEqualsCrdt("Tasks/storm.md");
    await ctx.assert.noRecoveryLoops("Tasks/storm.md");
    await ctx.assert.noAnalyzerErrors();
  },
};

This is much closer to what users actually do.

Example multi-device scenario
export const offlineHandoffWithTemplater: MultiDeviceScenario = {
  id: "offline-handoff-templater",
  title: "Offline Templater-created note handoff to second device",
  devices: ["A", "B"],

  async setup(ctx) {
    await ctx.all.startTrace({ mode: "qa-safe", sharedSecret: ctx.sharedSecret });
    await ctx.device("A").installPreset("templater");
    await ctx.device("B").installPreset("templater");
    await ctx.all.waitForYaosIdle();
  },

  async run(ctx) {
    await ctx.device("A").goOffline();
    await ctx.device("A").createFromTemplate("Templates/daily.md", "Daily/offline.md");
    await ctx.device("A").goOnline();
    await ctx.device("A").waitForDurableReceipt();

    await ctx.device("A").closeObsidian();
    await ctx.device("B").openObsidian();
    await ctx.device("B").waitForFile("Daily/offline.md");
  },

  async assert(ctx) {
    await ctx.device("B").assert.fileExists("Daily/offline.md");
    await ctx.compareVaults(["A", "B"], {
      paths: ["Daily/offline.md"],
    });
    await ctx.all.assertNoAnalyzerErrors();
  },
};

This tests the thing users actually care about: can I create something offline and later trust another device to get it?

Mobile reality

For mobile, full automation is hard. Do not let that block you.

Do three levels:

Mobile manual-assisted

Harness plugin exposes commands in Obsidian command palette:

YAOS QA: Run mobile step
YAOS QA: Export artifacts
YAOS QA: Show current expected step

The external scenario tells the human:

Step 4: On Android, background Obsidian now. Wait 30s. Reopen. Tap Continue.

Still useful if artifacts are automatic.

Android automation later

Use Appium or ADB where feasible:

adb shell am force-stop md.obsidian
adb shell monkey -p md.obsidian 1

Useful for kill/reopen lifecycle.

iOS manual

iOS automation is pain. Use manual-assisted first.

Do not pretend mobile is fully covered by desktop tests.

Obsidian version matrix

Record versions. Later, test a small matrix:

Current stable Obsidian
Current insider Obsidian, if you use it
Older stable if users are stuck there

Editor internals change. CodeMirror integration changes. Workspace lifecycle changes.

YAOS touches editor binding; Obsidian version matters.

What counts as “using Obsidian as much as possible”

This:

real vault folders;
real .obsidian config;
real community plugins;
real plugin settings;
real workspace leaves;
real MarkdownView editor;
real commands;
real app lifecycle;
real IndexedDB;
real file adapter;
real mobile backgrounding where possible.

Not this:

fake TFile;
fake workspace;
fake editor;
fake vault event emitter;
fake plugin writes.

Again: mocks are fine for pure unit tests. They do not certify sync behavior.

One nasty thing: plugin licensing and installation

Do not commit third-party plugin code unless allowed.

Better:

qa/plugin-lock.json
{
  "obsidian-tasks-plugin": {
    "repo": "obsidian-tasks-group/obsidian-tasks",
    "version": "7.20.0",
    "assets": ["main.js", "manifest.json", "styles.css"]
  }
}

Installer downloads GitHub release assets into fixture vault.

You may need to browse/verify plugin release asset names when implementing this, because they can change. Pin exact versions.

QA should live beside the code, not in your head

Add:

qa/
  README.md
  scenarios/
  fixtures/
  templates/
  plugin-presets/
  controllers/
  output/
  analyzers/

And a command list:

npm run qa:prepare -- --preset tasks
npm run qa:obsidian -- --scenario single-device-basic-edit
npm run qa:two-device -- --scenario offline-edit-handoff
npm run qa:analyze -- ./qa/output/run-...
npm run qa:manifest -- ./qa/tmp/vault-a

If the commands are annoying, you will not run them. If you do not run them, QA is theater.

My blunt recommendation

Build the Obsidian harness now, before adding more scenarios.

Minimum milestone:

Milestone 1:
- harness plugin loads in real Obsidian
- exposes window.YAOS_QA
- can open a file
- can type into real MarkdownView
- can call YAOS debug API
- can start/export flight trace
- can produce vault manifest
- one scenario passes: create/edit/delete note single-device

Then:

Milestone 2:
- external controller attaches to Obsidian devtools
- runs scenario automatically
- collects artifacts
- runs analyzer

Then:

Milestone 3:
- two Obsidian instances
- shared QA secret
- create/edit handoff scenario

Then:

Milestone 4:
- plugin preset: Tasks
- task checkbox storm scenario

Then add Templater, TaskNotes, Web Clipper, Excalidraw, Canvas/Bases.

Do not try to build all plugin scenarios before the harness itself is boring.

Final verdict

Yes: use Obsidian as much as possible.

The correct architecture is:

YAOS debug API
        ↑
Obsidian QA Harness plugin
        ↑
Dev console / Playwright controller
        ↑
Scenario suite + plugin presets + fixture vaults
        ↑
Flight recorder + analyzer + manifests

That gives you real Obsidian behavior without relying on mocks, while still being scriptable.

The most important rule:

Every QA scenario must run against real Obsidian state and produce artifacts that explain every YAOS data decision.

If the harness cannot open a real MarkdownView, type into it, trigger real plugin commands, wait for YAOS receipts, export flight logs, and compare disk/CRDT manifests, it is not enough.

Build the harness. Then torture YAOS with the actual workflows people use.
