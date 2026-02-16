/**
 * Line-level diff utility for applying external text changes to a Y.Text
 * as targeted inserts/deletes rather than a wholesale replace.
 *
 * This preserves CRDT history and cursor positions when an external tool
 * (git, another editor) modifies a file that's currently open.
 */
import * as Y from "yjs";

/**
 * Diff operation: retain N chars, delete N chars, or insert a string.
 */
type DiffOp =
	| { type: "retain"; count: number }
	| { type: "delete"; count: number }
	| { type: "insert"; text: string };

/**
 * Compute a line-level diff between `oldText` and `newText`, then
 * apply it to the Y.Text as a series of targeted operations.
 *
 * Uses a simple LCS (longest common subsequence) on lines, then
 * converts line-level ops to character-level ops for Y.Text.
 */
export function applyDiffToYText(
	ytext: Y.Text,
	oldText: string,
	newText: string,
	origin: string,
): void {
	if (oldText === newText) return;

	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);

	// Compute line-level edit script
	const ops = diffLines(oldLines, newLines);

	// Convert to character-level ops
	const charOps = linesToCharOps(ops, oldLines, newLines);

	// Apply to Y.Text in a single transaction
	ytext.doc?.transact(() => {
		let cursor = 0;
		for (const op of charOps) {
			switch (op.type) {
				case "retain":
					cursor += op.count;
					break;
				case "delete":
					ytext.delete(cursor, op.count);
					break;
				case "insert":
					ytext.insert(cursor, op.text);
					cursor += op.text.length;
					break;
			}
		}
	}, origin);
}

/**
 * Split text into lines preserving line endings.
 * "foo\nbar\n" -> ["foo\n", "bar\n"]
 * "foo\nbar"   -> ["foo\n", "bar"]
 */
function splitLines(text: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			lines.push(text.substring(start, i + 1));
			start = i + 1;
		}
	}
	if (start < text.length) {
		lines.push(text.substring(start));
	}
	return lines;
}

/**
 * Line-level edit op.
 */
type LineOp =
	| { type: "keep"; index: number }
	| { type: "remove"; index: number }
	| { type: "add"; index: number };

/**
 * Compute a line-level edit script using Myers-like O(ND) diff.
 * Returns a sequence of keep/remove/add operations.
 */
function diffLines(oldLines: string[], newLines: string[]): LineOp[] {
	const N = oldLines.length;
	const M = newLines.length;

	// For small inputs, use the simple O(NM) LCS approach
	// which is clearer and fast enough for typical file sizes
	const lcs = computeLCS(oldLines, newLines);

	const ops: LineOp[] = [];
	let oi = 0;
	let ni = 0;
	let li = 0;

	while (oi < N || ni < M) {
		if (li < lcs.length && oi === lcs[li]![0] && ni === lcs[li]![1]) {
			ops.push({ type: "keep", index: oi });
			oi++;
			ni++;
			li++;
		} else if (oi < N && (li >= lcs.length || oi < lcs[li]![0])) {
			ops.push({ type: "remove", index: oi });
			oi++;
		} else {
			ops.push({ type: "add", index: ni });
			ni++;
		}
	}

	return ops;
}

/**
 * Compute LCS indices using standard DP.
 * Returns array of [oldIndex, newIndex] pairs.
 */
function computeLCS(
	oldLines: string[],
	newLines: string[],
): [number, number][] {
	const N = oldLines.length;
	const M = newLines.length;

	// DP table: dp[i][j] = length of LCS of oldLines[0..i-1] and newLines[0..j-1]
	// Use 1D rolling array to save memory
	const prev = new Uint32Array(M + 1);
	const curr = new Uint32Array(M + 1);

	// First pass: compute lengths
	const dp: number[][] = [];
	for (let i = 0; i <= N; i++) {
		dp.push(new Array(M + 1).fill(0));
	}

	for (let i = 1; i <= N; i++) {
		for (let j = 1; j <= M; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i]![j] = dp[i - 1]![j - 1]! + 1;
			} else {
				dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
			}
		}
	}

	// Backtrack to find actual LCS pairs
	const result: [number, number][] = [];
	let i = N;
	let j = M;
	while (i > 0 && j > 0) {
		if (oldLines[i - 1] === newLines[j - 1]) {
			result.push([i - 1, j - 1]);
			i--;
			j--;
		} else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
			i--;
		} else {
			j--;
		}
	}

	result.reverse();
	return result;
}

/**
 * Convert line-level ops to character-level DiffOps.
 */
function linesToCharOps(
	lineOps: LineOp[],
	oldLines: string[],
	newLines: string[],
): DiffOp[] {
	const charOps: DiffOp[] = [];

	for (const op of lineOps) {
		switch (op.type) {
			case "keep": {
				const line = oldLines[op.index]!;
				if (line.length > 0) {
					charOps.push({ type: "retain", count: line.length });
				}
				break;
			}
			case "remove": {
				const line = oldLines[op.index]!;
				if (line.length > 0) {
					charOps.push({ type: "delete", count: line.length });
				}
				break;
			}
			case "add": {
				const line = newLines[op.index]!;
				if (line.length > 0) {
					charOps.push({ type: "insert", text: line });
				}
				break;
			}
		}
	}

	// Compact: merge adjacent ops of the same type
	const compacted: DiffOp[] = [];
	for (const op of charOps) {
		const last = compacted[compacted.length - 1];
		if (last && last.type === op.type) {
			if (last.type === "retain" && op.type === "retain") {
				last.count += op.count;
			} else if (last.type === "delete" && op.type === "delete") {
				last.count += op.count;
			} else if (last.type === "insert" && op.type === "insert") {
				last.text += op.text;
			}
		} else {
			compacted.push({ ...op } as DiffOp);
		}
	}

	return compacted;
}
