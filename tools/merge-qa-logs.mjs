#!/usr/bin/env node
/**
 * merge-qa-logs.mjs — Merge multiple QA flight trace exports for cross-device analysis.
 *
 * Usage: node tools/merge-qa-logs.mjs <file1.ndjson> <file2.ndjson> [...] -o <output.ndjson>
 *
 * Merges events by vaultIdHash + traceId. Output is sorted by timestamp.
 * The first line of output is a merged manifest.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const outputIdx = args.indexOf("-o");
if (outputIdx < 0 || !args[outputIdx + 1]) {
	console.error("Usage: node merge-qa-logs.mjs <file1> <file2> [...] -o <output>");
	process.exit(1);
}
const outputPath = args[outputIdx + 1];
const inputFiles = args.filter((_, i) => i !== outputIdx && i !== outputIdx + 1);

if (inputFiles.length < 1) {
	console.error("Error: provide at least one input file");
	process.exit(1);
}

const allEvents = [];
const manifests = [];
const sources = new Map(); // deviceId -> filename

for (const file of inputFiles) {
	const content = readFileSync(file, "utf-8");
	const lines = content.split("\n").filter(Boolean);
	let lineNum = 0;
	for (const line of lines) {
		lineNum++;
		try {
			const event = JSON.parse(line);
			if (event.kind === "export.manifest") {
				manifests.push({ ...event, _sourceFile: basename(file) });
				continue;
			}
			event._sourceFile = basename(file);
			allEvents.push(event);
			if (event.deviceId && !sources.has(event.deviceId)) {
				sources.set(event.deviceId, basename(file));
			}
		} catch {
			console.warn(`Warning: ${basename(file)}:${lineNum} — invalid JSON, skipping`);
		}
	}
}

// Sort by timestamp, then by seq within same timestamp
allEvents.sort((a, b) => {
	if (a.ts !== b.ts) return a.ts - b.ts;
	if (a.deviceId === b.deviceId) return (a.seq ?? 0) - (b.seq ?? 0);
	return 0;
});

// Build merged manifest
const mergedManifest = {
	kind: "export.manifest",
	ts: Date.now(),
	seq: 0,
	severity: "info",
	scope: "diagnostics",
	source: "analyzer",
	layer: "diagnostics",
	data: {
		merged: true,
		sourceCount: inputFiles.length,
		sourceFiles: inputFiles.map(basename),
		devices: Object.fromEntries(sources),
		totalEvents: allEvents.length,
		mergedAt: new Date().toISOString(),
		manifests: manifests.map((m) => ({
			sourceFile: m._sourceFile,
			mode: m.data?.mode,
			bootId: m.bootId,
			deviceId: m.deviceId,
			vaultIdHash: m.vaultIdHash,
		})),
	},
};

const output = [
	JSON.stringify(mergedManifest),
	...allEvents.map((e) => JSON.stringify(e)),
].join("\n") + "\n";

writeFileSync(outputPath, output);
console.log(`Merged ${allEvents.length} events from ${inputFiles.length} files -> ${outputPath}`);
console.log(`Devices: ${[...sources.entries()].map(([id, f]) => `${id.slice(0, 12)}… (${f})`).join(", ")}`);
