/**
 * S01 — Single device: create, edit (in editor), verify, delete.
 *
 * Purpose: Prove the basic local disk→CRDT→server→receipt lifecycle on one
 * device with real editor interaction.
 *
 * Assertions:
 *   - After create: disk == CRDT, receipt confirmed
 *   - After editor typing: disk == CRDT, typed text present, receipt confirmed
 *   - After delete: file absent
 *
 * Key events expected:
 *   disk.create.observed → crdt.file.created
 *   server.receipt.candidate_captured → server.receipt.confirmed
 *   crdt.file.updated (after editor type)
 *   disk.delete.observed → crdt.file.tombstoned
 */

import type { QaScenario, QaContext } from "../types";

const SCRATCH = "QA-scratch/s01-basic-edit.md";
const INITIAL = "# S01 Basic Edit\n\nInitial content.\n";
const TYPED = "\nEdited via harness.";
const EXPECTED_AFTER_EDIT = INITIAL + TYPED;

export const s01SingleDeviceBasicEdit: QaScenario = {
	id: "single-device-basic-edit",
	title: "Single device: create, editor-type, verify disk==CRDT, delete",
	tags: ["basic", "single-device", "layer1", "release-gate"],

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH).catch(() => {});
		await ctx.waitForIdle(8000);
	},

	async run(ctx: QaContext): Promise<void> {
		// 1. Create via Obsidian API
		await ctx.createFile(SCRATCH, INITIAL);
		await ctx.waitForIdle(8000);

		// 2. Action-relative receipt wait (not global)
		const preCreateSnapshot = ctx.yaos.getReceiptSnapshot();
		const createTs = Date.now();
		await ctx.yaos.waitForReceiptAfter(createTs, 30_000);

		// 3. Verify create synced
		await ctx.assert.fileExists(SCRATCH);
		await ctx.assert.diskEqualsCrdt(SCRATCH);

		// 4. Open in editor and type (exercises y-codemirror binding)
		await ctx.openFile(SCRATCH);
		const preEditSnapshot = ctx.yaos.getReceiptSnapshot();
		const editTs = Date.now();
		await ctx.typeIntoFile(SCRATCH, TYPED);

		// 5. Wait for idle after edit
		await ctx.waitForIdle(10_000);

		// 6. Assert the edit actually synced to CRDT — this is the binding test
		await ctx.assert.diskEqualsCrdt(SCRATCH);
		await ctx.assert.fileContent(SCRATCH, EXPECTED_AFTER_EDIT);

		// 7. Action-relative receipt after editor edit
		await ctx.yaos.waitForReceiptAfter(editTs, 30_000);

		// 8. Close and delete
		await ctx.closeFile(SCRATCH);
		await ctx.deleteFile(SCRATCH);
		await ctx.waitForIdle(8000);

		void preCreateSnapshot; // used for documentation; snapshot taken before action
		void preEditSnapshot;
	},

	async assert(ctx: QaContext): Promise<void> {
		await ctx.assert.fileNotExists(SCRATCH);
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.closeFile(SCRATCH).catch(() => {});
		await ctx.deleteFile(SCRATCH).catch(() => {});
	},
};
