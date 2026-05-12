#!/usr/bin/env node
/**
 * analyze-qa-trace.mjs — Analyze a QA flight trace for sync anomalies.
 *
 * Usage: node tools/analyze-qa-trace.mjs <trace.ndjson>
 *
 * Rules checked:
 *   1. incomplete-lifecycle: disk create without matching crdt create
 *   2. crdt-no-receipt: crdt mutation with no subsequent server receipt
 *   3. receipt-stuck: candidate captured but never confirmed (>60s)
 *   4. overwrite-disk-changed: reconcile file decision overwriting changed disk
 *   5. delete-revive-cycle: tombstone followed by revive for same path
 *   6. recovery-loop: recovery.loop.detected events
 *   7. suppression-miss: disk.event.not_suppressed events
 *   8. disk-write-failed: disk.write.failed events
 *   9. safety-brake: reconcile.safety_brake.triggered events
 *   10. events-dropped-high: flight.events.dropped with high counts
 *   11. redaction-failures: redaction.failure events
 *   12. missing-pathId: scope=file events without pathId
 */

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length < 1) {
	console.error("Usage: node analyze-qa-trace.mjs <trace.ndjson>");
	process.exit(1);
}

const content = readFileSync(args[0], "utf-8");
const events = content
	.split("\n")
	.filter(Boolean)
	.map((line) => { try { return JSON.parse(line); } catch { return null; } })
	.filter(Boolean);

console.log(`\nAnalyzing ${events.length} events...\n`);

const findings = [];

function finding(rule, severity, message, event) {
	findings.push({ rule, severity, message, seq: event?.seq, ts: event?.ts, kind: event?.kind });
}

// Index events by pathId for lifecycle checking
const eventsByPathId = new Map();
const eventsByOpId = new Map();
for (const e of events) {
	if (e.pathId) {
		if (!eventsByPathId.has(e.pathId)) eventsByPathId.set(e.pathId, []);
		eventsByPathId.get(e.pathId).push(e);
	}
	if (e.opId) {
		if (!eventsByOpId.has(e.opId)) eventsByOpId.set(e.opId, []);
		eventsByOpId.get(e.opId).push(e);
	}
}

// Rule 1: incomplete-lifecycle
for (const [pathId, pathEvents] of eventsByPathId) {
	const hasDiskCreate = pathEvents.some((e) => e.kind === "disk.create.observed");
	const hasCrdtCreate = pathEvents.some((e) => e.kind === "crdt.file.created");
	if (hasDiskCreate && !hasCrdtCreate) {
		const diskEvent = pathEvents.find((e) => e.kind === "disk.create.observed");
		finding("incomplete-lifecycle", "warn", `pathId=${pathId.slice(0, 16)}… has disk.create but no crdt.file.created`, diskEvent);
	}
}

// Rule 2: crdt-no-receipt
const crdtMutations = events.filter((e) =>
	e.kind === "crdt.file.created" || e.kind === "crdt.file.updated" || e.kind === "crdt.file.tombstoned"
);
const receiptConfirmed = events.filter((e) => e.kind === "server.receipt.confirmed");
const receiptCandidates = events.filter((e) => e.kind === "server.receipt.candidate_captured");
if (crdtMutations.length > 0 && receiptCandidates.length === 0) {
	finding("crdt-no-receipt", "warn", `${crdtMutations.length} CRDT mutations but no receipt candidates captured`, crdtMutations[0]);
}

// Rule 3: receipt-stuck
for (const candidate of receiptCandidates) {
	const candidateId = candidate.candidateId;
	if (!candidateId) continue;
	const confirmed = receiptConfirmed.find((e) => e.candidateId === candidateId);
	if (!confirmed) {
		const age = events[events.length - 1]?.ts - candidate.ts;
		if (age > 60_000) {
			finding("receipt-stuck", "error", `candidateId=${candidateId} captured but never confirmed (${Math.round(age / 1000)}s)`, candidate);
		}
	}
}

// Rule 4: overwrite-disk-changed
const reconcileDecisions = events.filter((e) => e.kind === "reconcile.file.decision");
for (const d of reconcileDecisions) {
	if (d.data?.decision === "overwrite" && d.data?.diskChangedSinceObserved) {
		finding("overwrite-disk-changed", "error", `Reconcile overwrite with changed disk`, d);
	}
}

// Rule 5: delete-revive-cycle
for (const [pathId, pathEvents] of eventsByPathId) {
	const tombstones = pathEvents.filter((e) => e.kind === "crdt.file.tombstoned");
	const revives = pathEvents.filter((e) => e.kind === "crdt.file.revived");
	if (tombstones.length > 0 && revives.length > 0) {
		finding("delete-revive-cycle", "warn", `pathId=${pathId.slice(0, 16)}… has ${tombstones.length} tombstone(s) and ${revives.length} revive(s)`, tombstones[0]);
	}
}

// Rule 6: recovery-loop
const recoveryLoops = events.filter((e) => e.kind === "recovery.loop.detected");
for (const e of recoveryLoops) {
	finding("recovery-loop", "error", `Recovery loop detected (${e.data?.repeatCount ?? "?"} repeats, reason: ${e.data?.reason ?? "unknown"})`, e);
}

// Rule 7: suppression-miss
const suppressionMisses = events.filter((e) => e.kind === "disk.event.not_suppressed");
for (const e of suppressionMisses) {
	finding("suppression-miss", "error", `Disk event suppression failed`, e);
}

// Rule 8: disk-write-failed
const writeFailures = events.filter((e) => e.kind === "disk.write.failed");
for (const e of writeFailures) {
	finding("disk-write-failed", "error", `Disk write failed: ${e.data?.error ?? "unknown"}`, e);
}

// Rule 9: safety-brake
const safetyBrakes = events.filter((e) => e.kind === "reconcile.safety_brake.triggered");
for (const e of safetyBrakes) {
	finding("safety-brake", "error", `Safety brake triggered`, e);
}

// Rule 10: events-dropped-high
const droppedEvents = events.filter((e) => e.kind === "flight.events.dropped");
for (const e of droppedEvents) {
	const count = e.data?.count ?? 0;
	if (count > 50) {
		finding("events-dropped-high", "warn", `${count} events dropped in one batch`, e);
	}
}

// Rule 11: redaction-failures
const redactionFailures = events.filter((e) => e.kind === "redaction.failure");
for (const e of redactionFailures) {
	finding("redaction-failures", "warn", `Redaction failure: key="${e.data?.leakedKey}" in ${e.data?.originalKind}`, e);
}

// Rule 12: missing-pathId
const fileScopedWithoutPathId = events.filter((e) =>
	e.scope === "file" && !e.pathId && e.kind !== "export.manifest"
);
if (fileScopedWithoutPathId.length > 0) {
	finding("missing-pathId", "warn", `${fileScopedWithoutPathId.length} file-scoped events missing pathId`, fileScopedWithoutPathId[0]);
	// Show first few
	for (const e of fileScopedWithoutPathId.slice(0, 5)) {
		finding("missing-pathId", "info", `  kind=${e.kind} seq=${e.seq}`, e);
	}
}

// --- Report ---
console.log("═══════════════════════════════════════════════════");
console.log("  FLIGHT TRACE ANALYSIS REPORT");
console.log("═══════════════════════════════════════════════════\n");

const byRule = new Map();
for (const f of findings) {
	if (!byRule.has(f.rule)) byRule.set(f.rule, []);
	byRule.get(f.rule).push(f);
}

if (findings.length === 0) {
	console.log("  ✓ No anomalies detected.\n");
} else {
	for (const [rule, ruleFindings] of byRule) {
		const maxSeverity = ruleFindings.some((f) => f.severity === "error") ? "ERROR"
			: ruleFindings.some((f) => f.severity === "warn") ? "WARN" : "INFO";
		console.log(`  [${maxSeverity}] ${rule} (${ruleFindings.length} finding${ruleFindings.length > 1 ? "s" : ""})`);
		for (const f of ruleFindings.slice(0, 5)) {
			console.log(`         ${f.message}`);
		}
		if (ruleFindings.length > 5) {
			console.log(`         ... and ${ruleFindings.length - 5} more`);
		}
		console.log();
	}
}

// Summary
const errors = findings.filter((f) => f.severity === "error").length;
const warnings = findings.filter((f) => f.severity === "warn").length;
console.log("───────────────────────────────────────────────────");
console.log(`  Total: ${findings.length} findings (${errors} errors, ${warnings} warnings)`);
console.log(`  Events: ${events.length} | Paths: ${eventsByPathId.size} | Ops: ${eventsByOpId.size}`);
console.log("───────────────────────────────────────────────────\n");

if (errors > 0) process.exit(2);
if (warnings > 0) process.exit(1);
