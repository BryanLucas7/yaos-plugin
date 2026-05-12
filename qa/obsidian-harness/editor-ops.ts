/**
 * Editor operations for the QA harness.
 *
 * Uses real Obsidian editor APIs — NOT app.vault.modify() for tests that
 * exercise the editor/CRDT binding boundary.
 */

import { MarkdownView, normalizePath, type App } from "obsidian";
import { sleep, waitForCondition } from "./wait";

export async function openFile(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	await app.workspace.openLinkText(normalized, "", true);
	await waitForCondition(
		() => {
			const view = app.workspace.getActiveViewOfType(MarkdownView);
			return view?.file?.path === normalized;
		},
		5000,
		`openFile(${path})`,
	);
}

export async function closeFile(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	app.workspace.iterateAllLeaves((leaf) => {
		if (leaf.view instanceof MarkdownView && leaf.view.file?.path === normalized) {
			leaf.detach();
		}
	});
}

function getViewForPath(app: App, path: string): MarkdownView {
	const normalized = normalizePath(path);
	let found: MarkdownView | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		if (found) return;
		if (leaf.view instanceof MarkdownView && leaf.view.file?.path === normalized) {
			found = leaf.view;
		}
	});
	if (!found) throw new Error(`No open MarkdownView for path: ${normalized}`);
	return found;
}

/**
 * Type text into a file's editor one character at a time.
 * Use this for live-sync tests (exercises the y-codemirror binding).
 * Do NOT use replaceFileContent() for live-sync tests.
 */
export async function typeIntoFile(
	app: App,
	path: string,
	text: string,
	opts: { intervalMs?: number } = {},
): Promise<void> {
	const view = getViewForPath(app, path);
	const intervalMs = opts.intervalMs ?? 20;
	for (const ch of text) {
		view.editor.replaceRange(ch, view.editor.getCursor());
		await sleep(intervalMs);
	}
}

/**
 * Replace entire editor content (blunt).
 * Only use for setup steps, not for live-sync correctness tests.
 */
export async function replaceFileContent(app: App, path: string, content: string): Promise<void> {
	const view = getViewForPath(app, path);
	view.editor.setValue(content);
}

export async function runCommand(app: App, commandId: string): Promise<void> {
	await (app as unknown as {
		commands: { executeCommandById: (id: string) => boolean | Promise<boolean>;
	};
	}).commands.executeCommandById(commandId);
}

export function listCommands(app: App, filter?: string): string[] {
	const all = Object.keys(
		(app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands,
	);
	return filter ? all.filter((id) => id.includes(filter)) : all;
}
