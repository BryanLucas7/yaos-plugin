import { strict as assert } from "node:assert";
import { decideClosedFileConflict } from "../src/sync/closedFileConflict";

console.log("\n--- Test 1: closed-file conflict decision table ---");

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "A", crdtHash: "A" }),
	{ kind: "no-op" },
	"disk=crdt is no-op",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "A", crdtHash: "B" }),
	{ kind: "apply-remote-to-disk", reason: "disk-at-baseline" },
	"baseline=A disk=A crdt=B applies remote",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "B", crdtHash: "A" }),
	{ kind: "import-disk-to-crdt", reason: "crdt-at-baseline" },
	"baseline=A disk=B crdt=A imports disk",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "B", crdtHash: "C" }),
	{
		kind: "preserve-conflict",
		reason: "both-changed",
		winner: "disk",
		preserveCrdt: true,
	},
	"baseline=A disk=B crdt=C preserves conflict",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C" }),
	{
		kind: "preserve-conflict",
		reason: "missing-baseline",
		winner: "crdt",
		preserveDisk: true,
	},
	"missing baseline preserves disk as conflict and keeps CRDT canonical",
);

console.log("\n--- Test 2: stale disk with newer remote does not demote CRDT ---");

{
	const staleDisk = "old local disk";
	const newerRemoteCrdt = "newer remote server state";
	let canonicalCrdt = newerRemoteCrdt;
	let canonicalDisk = staleDisk;
	const conflictArtifacts: Array<{ side: "disk" | "crdt"; content: string }> = [];

	const decision = decideClosedFileConflict({
		baselineHash: null,
		diskHash: "stale-disk-hash",
		crdtHash: "newer-remote-hash",
	});

	if (decision.kind === "preserve-conflict") {
		const preservedContent = decision.preserveDisk ? canonicalDisk : canonicalCrdt;
		const preservedSide = decision.preserveDisk ? "disk" : "crdt";
		conflictArtifacts.push({ side: preservedSide, content: preservedContent });
		if (decision.winner === "disk") {
			canonicalCrdt = canonicalDisk;
		} else {
			canonicalDisk = canonicalCrdt;
		}
	}

	assert.equal(canonicalCrdt, newerRemoteCrdt, "canonical CRDT remains the newer remote version");
	assert.equal(canonicalDisk, newerRemoteCrdt, "canonical disk is updated from CRDT");
	assert.deepEqual(
		conflictArtifacts,
		[{ side: "disk", content: staleDisk }],
		"stale disk is preserved as the conflict artifact",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log("Results: 8 passed, 0 failed");
console.log("──────────────────────────────────────────────────");
