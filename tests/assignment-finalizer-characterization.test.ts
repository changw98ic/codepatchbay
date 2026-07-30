import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { normalizeFinalizerResult } from "../runtime/worker/assignment-finalizer.js";
import { recordValue, type LooseRecord } from "../shared/types.js";

// PHASE 0 — Worker finalizer characterization.
//
// This suite pins the *current* finalizer contract that Phase 5 (worker
// lifecycle seam) must preserve. It is a COMPLEMENT to
// tests/assignment-finalizer.test.ts and deliberately does NOT re-cover what
// the sibling suite already pins:
//   - maybeFinalizeSuccessfulAssignment transport / candidate-binding flows
//   - finalizeAndWriteSuccessfulResult blocked / missing / malformed publication
//   - recoverAndWriteFinalizerOnlyResult durable-journal recovery
//   - review_bundle canonical acceptance + event-failure partial truth
//   - finalizerExceptionResult Bearer redaction / partial-remote-receipt preservation
//   - shouldCleanupWorkerWorktree status/retention gating
//
// `invalidFinalizerResult` and `retainedFinalizerEvidence` are module-private
// (not exported), so their behavior is observed here exclusively through the
// exported `normalizeFinalizerResult` boundary, which is the only caller that
// routes both acceptance and rejection through them.

const JOB_ID = "job-characterize";
const COMMIT = "a".repeat(40);
const BASE = "a".repeat(40);
const TREE = "c".repeat(40);
const FINALIZATION_ID = "f".repeat(64);
const IDENTITY_HASH = `sha256:${"d".repeat(64)}`;

function candidate(treeHash = TREE) {
  return {
    baseSha: BASE,
    headSha: COMMIT,
    treeHash,
    identityHash: IDENTITY_HASH,
    cleanReplay: {
      cleanApply: true as const,
      baseSha: BASE,
      expectedTreeHash: treeHash,
      actualTreeHash: treeHash,
    },
  };
}

// Build an exact clean source readback receipt for `sourceSyncValid`.
function cleanSourceSync(branch: string, previousHead: string, head = COMMIT): LooseRecord {
  return {
    committed: true,
    clean: true,
    expectedBranch: branch,
    previousHead,
    expectedHead: head,
    actualBranch: branch,
    actualHead: head,
  };
}

// Always-accept journal receipt validator: returns the input as the receipt so
// the test can drive the success-contract checks deterministically.
function permissiveValidator(value: unknown) {
  return { ok: true as const, receipt: recordValue(value) };
}

describe("normalizeFinalizerResult — acceptance per mode", () => {
  test("dry-run success is accepted with committed=false and a dry-run PR preview", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "dry-run",
        mode: "dry-run",
        jobId: JOB_ID,
        committed: false,
        pr: { status: "dry-run" },
      },
      { mode: "dry-run", jobId: JOB_ID },
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, "dry-run");
    assert.equal(result.mode, "dry-run");
    assert.equal(result.jobId, JOB_ID);
    assert.equal(result.committed, false);
    assert.deepEqual(recordValue(result.pr), { status: "dry-run" });
  });

  test("local success is accepted when commit/tree match the durable candidate and source readback is clean", async () => {
    const binding = {
      candidate: candidate(TREE),
      source: { branch: "main", head: BASE },
    };

    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "finalized",
        mode: "local",
        jobId: JOB_ID,
        committed: true,
        commit: COMMIT,
        tree: TREE,
        sourceSync: cleanSourceSync("main", BASE),
      },
      { mode: "local", jobId: JOB_ID, binding },
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, "finalized");
    assert.equal(result.mode, "local");
    assert.equal(result.committed, true);
    assert.equal(result.commit, COMMIT);
    assert.equal(result.tree, TREE);
  });

  test("remote success is accepted with push/issueClose receipts, completed intent, and clean source readback", async () => {
    const binding = {
      candidate: candidate(TREE),
      source: { branch: "main", head: BASE },
    };

    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "finalized",
        mode: "remote",
        jobId: JOB_ID,
        committed: true,
        commit: COMMIT,
        tree: TREE,
        pushed: true,
        closed: true,
        localSynced: true,
        remoteWrites: {
          push: { attempted: true, committed: true },
          issueClose: { attempted: true, committed: true },
        },
        remoteIntent: { finalizationId: FINALIZATION_ID, generation: 1, stage: "local.complete" },
        sourceSync: cleanSourceSync("main", BASE),
      },
      {
        mode: "remote",
        jobId: JOB_ID,
        repository: "owner/repo",
        binding,
        validateMutationReceipt: permissiveValidator,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, "finalized");
    assert.equal(result.pushed, true);
    assert.equal(result.closed, true);
    assert.equal(result.localSynced, true);
    assert.deepEqual(recordValue(recordValue(result.remoteWrites).push), {
      attempted: true,
      committed: true,
    });
    assert.equal(recordValue(result.remoteIntent).stage, "local.complete");
  });

  test("pr success is accepted with canonical prUrl bound to repository and PR number", async () => {
    const repository = "owner/repo";
    const prNumber = 17;

    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "pr.opened",
        mode: "pr",
        jobId: JOB_ID,
        committed: true,
        commit: COMMIT,
        tree: TREE,
        pushed: true,
        closed: false,
        eventRecorded: true,
        prNumber,
        prUrl: `https://github.com/${repository}/pull/${prNumber}`,
        remoteWrites: {
          branchPush: { attempted: true, committed: true },
          pullRequestCreate: { attempted: true, committed: true },
        },
        remoteIntent: { finalizationId: FINALIZATION_ID, generation: 1, stage: "event.complete" },
      },
      {
        mode: "pr",
        jobId: JOB_ID,
        repository,
        binding: { candidate: candidate(TREE) },
        validateMutationReceipt: permissiveValidator,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, "pr.opened");
    assert.equal(result.pushed, true);
    assert.equal(result.closed, false);
    assert.equal(result.eventRecorded, true);
    assert.equal(result.prNumber, prNumber);
    assert.equal(result.prUrl, `https://github.com/${repository}/pull/${prNumber}`);
  });
});

describe("normalizeFinalizerResult — rejection per mode", () => {
  test("non-record result yields FINALIZER_RESULT_MISSING with dry-run committed=false / retryable=false", async () => {
    const result = await normalizeFinalizerResult(null, { mode: "dry-run", jobId: JOB_ID });

    assert.equal(result.ok, false);
    assert.equal(result.code, "FINALIZER_RESULT_MISSING");
    assert.equal(result.status, "failed");
    assert.equal(result.mode, "dry-run");
    assert.equal(result.jobId, JOB_ID);
    assert.equal(result.committed, false);
    assert.equal(result.retryable, false);
  });

  test("non-record result yields FINALIZER_RESULT_MISSING with live committed=null / retryable=true", async () => {
    const result = await normalizeFinalizerResult(undefined, { mode: "remote", jobId: JOB_ID });

    assert.equal(result.code, "FINALIZER_RESULT_MISSING");
    assert.equal(result.committed, null);
    assert.equal(result.retryable, true);
  });

  test("success with a result mode that differs from the expected mode is rejected", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "finalized",
        mode: "remote",
        jobId: JOB_ID,
        committed: true,
      },
      { mode: "dry-run", jobId: JOB_ID },
    );

    assert.equal(result.ok, false);
    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "finalizer mode must be dry-run");
  });

  test("success with a forged jobId that differs from the active invocation is rejected", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "dry-run",
        mode: "dry-run",
        jobId: "job-forged",
        committed: false,
        pr: { status: "dry-run" },
      },
      { mode: "dry-run", jobId: JOB_ID },
    );

    assert.equal(result.ok, false);
    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
    assert.equal(result.reason, "finalizer result jobId does not match the active invocation");
  });

  test("remote/pr success without a journal receipt validator is rejected", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "finalized",
        mode: "remote",
        jobId: JOB_ID,
        committed: true,
        commit: COMMIT,
      },
      { mode: "remote", jobId: JOB_ID, validateMutationReceipt: null },
    );

    assert.equal(result.ok, false);
    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
    assert.equal(result.reason, "strict finalizer journal receipt validator is unavailable");
    // live-mode tri-state contract:
    assert.equal(result.committed, null);
    assert.equal(result.retryable, true);
  });

  test("dry-run failure cannot claim committed=true (committed-failure contract)", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: false,
        status: "blocked",
        code: "DRY_RUN_BLOCKED",
        mode: "dry-run",
        jobId: JOB_ID,
        committed: true,
        retryable: false,
      },
      { mode: "dry-run", jobId: JOB_ID },
    );

    assert.equal(result.ok, false);
    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
    assert.equal(result.status, "rejected");
  });

  test("failure with a non-terminal status is rejected", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: false,
        status: "weird",
        code: "X",
        mode: "remote",
        jobId: JOB_ID,
        committed: null,
        retryable: true,
      },
      { mode: "remote", jobId: JOB_ID },
    );

    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
  });

  test("failure without a code is rejected", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: false,
        status: "blocked",
        mode: "remote",
        jobId: JOB_ID,
        committed: null,
        retryable: true,
      },
      { mode: "remote", jobId: JOB_ID },
    );

    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
  });

  test("failure must declare retryable as an explicit boolean (omission is rejected)", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: false,
        status: "blocked",
        code: "AUTO_RETRY",
        mode: "remote",
        jobId: JOB_ID,
        committed: null,
        // retryable intentionally omitted
      },
      { mode: "remote", jobId: JOB_ID },
    );

    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
  });

  test("success for an unsupported mode is rejected with the literal unsupported-mode reason", async () => {
    // successfulFinalizerResultError (runtime/worker/assignment-finalizer.ts)
    // validates a live success result through a chain: ok=true → mode===expected
    // → jobId match → (dry-run branch skipped) → commit present → committed=true
    // → (local branch skipped) → remoteWrites MUST be a record → (remote/pr
    // branches skipped when expectedMode is neither) → finally falls through to
    // `unsupported finalizer mode: ${expectedMode}`. The fixture must therefore
    // carry a remoteWrites record so the earlier "missing remote write receipts"
    // guard does not fire; we build a maximally-valid remote-shaped success and
    // only swap `mode` to "weird" to prove the unsupported-mode fallback is the
    // sole surviving rejection for an otherwise-valid live success.
    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "finalized",
        mode: "weird",
        jobId: JOB_ID,
        committed: true,
        commit: COMMIT,
        tree: TREE,
        pushed: true,
        closed: true,
        localSynced: true,
        remoteWrites: {
          push: { attempted: true, committed: true },
          issueClose: { attempted: true, committed: true },
        },
        remoteIntent: { finalizationId: FINALIZATION_ID, generation: 1, stage: "local.complete" },
        sourceSync: cleanSourceSync("main", BASE),
      },
      { mode: "weird", jobId: JOB_ID },
    );

    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
    assert.equal(result.reason, "unsupported finalizer mode: weird");
  });
});

describe("normalizeFinalizerResult — valid failure pass-through", () => {
  test("a well-formed blocked failure preserves its code, identity, committed, and retryable", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: false,
        status: "blocked",
        code: "REMOTE_BLOCKED",
        mode: "remote",
        jobId: JOB_ID,
        committed: null,
        retryable: true,
      },
      { mode: "remote", jobId: JOB_ID },
    );

    // Pass-through (not invalidated): original code preserved.
    assert.equal(result.ok, false);
    assert.equal(result.code, "REMOTE_BLOCKED");
    assert.equal(result.status, "blocked");
    assert.equal(result.mode, "remote");
    assert.equal(result.jobId, JOB_ID);
    assert.equal(result.committed, null);
    assert.equal(result.retryable, true);
  });
});

describe("invalidFinalizerResult envelope shape (observed via normalizeFinalizerResult)", () => {
  test("dry-run rejection envelope: committed=false, retryable=false, status=rejected", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "finalized",
        mode: "remote",
        jobId: JOB_ID,
        committed: true,
      },
      { mode: "dry-run", jobId: JOB_ID },
    );

    // Envelope authority over identity fields:
    assert.equal(result.ok, false);
    assert.equal(result.status, "rejected");
    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
    assert.equal(result.mode, "dry-run");
    assert.equal(result.jobId, JOB_ID);
    // dry-mode tri-state:
    assert.equal(result.committed, false);
    assert.equal(result.retryable, false);
  });

  test("live rejection envelope: committed=null, retryable=true, status=rejected", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "finalized",
        mode: "dry-run",
        jobId: JOB_ID,
        committed: false,
      },
      {
        mode: "remote",
        jobId: JOB_ID,
        validateMutationReceipt: permissiveValidator,
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, "rejected");
    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
    assert.equal(result.mode, "remote");
    assert.equal(result.jobId, JOB_ID);
    // live-mode tri-state (null committed + retryable) — the key divergence
    // from the dry-run envelope that Phase 5 must preserve:
    assert.equal(result.committed, null);
    assert.equal(result.retryable, true);
  });
});

describe("retainedFinalizerEvidence allowlist (observed via normalizeFinalizerResult rejection)", () => {
  // Drive rejection through a dry-run mode mismatch so the full input record
  // flows into `invalidFinalizerResult` -> `retainedFinalizerEvidence`.
  test("retains exactly the 19-key evidence allowlist and drops everything else; envelope overrides mode/jobId", async () => {
    const result = await normalizeFinalizerResult(
      {
        ok: true,
        status: "finalized",
        // `mode`/`jobId` below are intentionally distinct from the envelope's
        // to prove the envelope overrides the retained identity values.
        mode: "remote",
        jobId: "job-retain-input",
        committed: true,
        // The 19 retained keys (mode + jobId are retained too, but overridden
        // by the envelope; the remaining 17 are asserted below):
        commit: COMMIT,
        tree: TREE,
        finalizationId: FINALIZATION_ID,
        generation: 7,
        remoteIntent: { finalizationId: FINALIZATION_ID, generation: 7, stage: "local.complete" },
        remoteWrites: { push: { attempted: true, committed: true } },
        sourceSync: { committed: true, clean: true },
        localSynced: true,
        pushed: true,
        closed: false,
        prUrl: "https://github.com/owner/repo/pull/9",
        prNumber: 9,
        eventRecorded: true,
        bundlePath: "/tmp/bundle.json",
        bundleSha256: "ab".repeat(32),
        bundleBytes: 42,
        audit: { eventType: "review_bundle_created" },
        // Fields outside the allowlist — must NOT survive retention:
        droppedField: "must-not-appear",
        internalState: "also-dropped",
      },
      { mode: "dry-run", jobId: JOB_ID },
    );

    // Envelope authority over identity (retained mode/jobId are overridden):
    assert.equal(result.mode, "dry-run");
    assert.equal(result.jobId, JOB_ID);

    // The 17 non-identity retained keys survive verbatim (none are secret-keyed
    // nor match a redaction pattern, so values pass through unchanged):
    assert.equal(result.commit, COMMIT);
    assert.equal(result.tree, TREE);
    assert.equal(result.finalizationId, FINALIZATION_ID);
    assert.equal(result.generation, 7);
    assert.deepEqual(result.remoteIntent, {
      finalizationId: FINALIZATION_ID,
      generation: 7,
      stage: "local.complete",
    });
    assert.deepEqual(result.remoteWrites, { push: { attempted: true, committed: true } });
    assert.deepEqual(result.sourceSync, { committed: true, clean: true });
    assert.equal(result.localSynced, true);
    assert.equal(result.pushed, true);
    assert.equal(result.closed, false);
    assert.equal(result.prUrl, "https://github.com/owner/repo/pull/9");
    assert.equal(result.prNumber, 9);
    assert.equal(result.eventRecorded, true);
    assert.equal(result.bundlePath, "/tmp/bundle.json");
    assert.equal(result.bundleSha256, "ab".repeat(32));
    assert.equal(result.bundleBytes, 42);
    assert.deepEqual(result.audit, { eventType: "review_bundle_created" });

    // `committed`/`retryable`/`ok`/`status`/`reason`/`code` are NOT in the
    // evidence allowlist; they are set exclusively by the invalid envelope:
    assert.equal(result.ok, false);
    assert.equal(result.status, "rejected");
    assert.equal(result.code, "FINALIZER_RESULT_INVALID");
    assert.equal(result.committed, false); // dry-run envelope (input had true)
    assert.equal(result.retryable, false); // dry-run envelope

    // Non-allowlisted input fields are dropped entirely:
    assert.equal("droppedField" in result, false);
    assert.equal("internalState" in result, false);
  });

  test("the full frozen allowlist is exactly the 19 keys current behavior retains", async () => {
    // Frozen allowlist — order matches the source declaration in
    // retainedFinalizerEvidence. Any addition/removal/reordering MUST be an
    // intentional contract change caught here.
    const frozenAllowlist = [
      "mode",
      "jobId",
      "commit",
      "tree",
      "finalizationId",
      "generation",
      "remoteIntent",
      "remoteWrites",
      "sourceSync",
      "localSynced",
      "pushed",
      "closed",
      "prUrl",
      "prNumber",
      "eventRecorded",
      "bundlePath",
      "bundleSha256",
      "bundleBytes",
      "audit",
    ];

    const input: LooseRecord = {};
    for (const key of frozenAllowlist) input[key] = "sentinel";
    input.ok = true;
    input.mode = "remote"; // mismatch -> rejection that retains evidence
    input.status = "finalized";
    input.jobId = "job-allowlist";
    input.notRetained = "dropped";

    const result = await normalizeFinalizerResult(input, { mode: "dry-run", jobId: JOB_ID });

    for (const key of frozenAllowlist) {
      assert.equal(
        key in result,
        true,
        `retainedFinalizerEvidence must retain "${key}" (frozen allowlist)`,
      );
    }
    assert.equal("notRetained" in result, false);
    // mode/jobId are retained-then-overridden; verify the override still holds:
    assert.equal(result.mode, "dry-run");
    assert.equal(result.jobId, JOB_ID);
  });
});
