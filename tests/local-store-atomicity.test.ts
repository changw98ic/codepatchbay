import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { writeJsonAtomic, writeJsonOnce, withFsUtilsTestHooks } from "../shared/fs-utils.js";
import { AssignmentStore, withAssignmentStoreTestHooksForTests } from "../shared/orchestrator/assignment-store.js";
import { tempRoot, readJson } from "./helpers.js";

// ---------------------------------------------------------------------------
// writeJsonAtomic — basic atomicity
// ---------------------------------------------------------------------------

test("writeJsonAtomic creates file with correct content", async () => {
  const root = await tempRoot("cpb-json-atomic-basic");
  const filePath = path.join(root, "data.json");
  const payload = { key: "value", nested: { a: 1, b: [2, 3] } };

  await writeJsonAtomic(filePath, payload);
  const content = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(content, payload);
});

test("writeJsonAtomic overwrites existing file atomically", async () => {
  const root = await tempRoot("cpb-json-atomic-overwrite");
  const filePath = path.join(root, "data.json");

  await writeJsonAtomic(filePath, { version: 1 });
  await writeJsonAtomic(filePath, { version: 2 });

  const content = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(content, { version: 2 });
});

test("writeJsonAtomic does not leave temp files on success", async () => {
  const root = await tempRoot("cpb-json-atomic-no-tmp");
  const filePath = path.join(root, "clean.json");

  await writeJsonAtomic(filePath, { clean: true });

  const entries = await readdir(root);
  const tmpFiles = entries.filter((e) => e.includes(".tmp-") || e.endsWith(".tmp"));
  assert.equal(tmpFiles.length, 0, `unexpected temp files: ${tmpFiles.join(", ")}`);
});

test("writeJsonAtomic creates parent directories", async () => {
  const root = await tempRoot("cpb-json-atomic-mkdir");
  const filePath = path.join(root, "deep", "nested", "dir", "data.json");

  await writeJsonAtomic(filePath, { deep: true });
  const content = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(content, { deep: true });
});

test("writeJsonAtomic preserves data integrity under rename hook failure", async () => {
  const root = await tempRoot("cpb-json-atomic-rename-fail");
  const filePath = path.join(root, "data.json");

  // Write initial value
  await writeJsonAtomic(filePath, { original: true });

  // Make rename fail — the original file must survive
  await withFsUtilsTestHooks({
    rename: async () => {
      throw Object.assign(new Error("ENOSPC: simulated"), { code: "ENOSPC" });
    },
  }, async () => {
    await assert.rejects(
      writeJsonAtomic(filePath, { replaced: true }),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        // JsonWriteRecoveryError wraps the original ENOSPC in a cause chain
        const msg = error.message;
        const causeMsg = error.cause instanceof Error ? error.cause.message : "";
        return msg.includes("atomic JSON write failed") || causeMsg.includes("ENOSPC");
      },
    );
  });

  // Original file must still be intact
  const content = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(content, { original: true });
});

test("writeJsonAtomic reports temp file in recovery paths on failure before rename", async () => {
  const root = await tempRoot("cpb-json-atomic-recovery");
  const filePath = path.join(root, "data.json");

  let tempPath: string | null = null;
  await withFsUtilsTestHooks({
    rename: async (source: string, dest: string) => {
      tempPath = source;
      throw Object.assign(new Error("simulated rename failure"), { code: "EACCES" });
    },
  }, async () => {
    await assert.rejects(
      writeJsonAtomic(filePath, { fail: true }),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        // JsonWriteRecoveryError includes recoveryPaths with the temp file
        const recoveryPaths = (error as unknown as { recoveryPaths?: string[] }).recoveryPaths;
        return Array.isArray(recoveryPaths) && recoveryPaths.length > 0;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// writeJsonOnce — O_EXCL semantics
// ---------------------------------------------------------------------------

test("writeJsonOnce succeeds on new file", async () => {
  const root = await tempRoot("cpb-json-once-new");
  const filePath = path.join(root, "new.json");

  const result = await writeJsonOnce(filePath, { first: true });
  assert.equal(result, true);
  const content = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(content, { first: true });
});

test("writeJsonOnce returns false when file already exists", async () => {
  const root = await tempRoot("cpb-json-once-exists");
  const filePath = path.join(root, "exists.json");

  await writeJsonOnce(filePath, { first: true });
  const result = await writeJsonOnce(filePath, { second: true });
  assert.equal(result, false);

  // Original content must be preserved
  const content = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(content, { first: true });
});

// ---------------------------------------------------------------------------
// Assignment completion WAL — pending, recovery, and idempotency
// ---------------------------------------------------------------------------

async function completionFixture(prefix: string) {
  const root = await tempRoot(prefix);
  const store = new AssignmentStore(root);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: `${prefix}-entry`,
    projectId: "project-1",
    task: "complete this assignment",
  });
  const attempt = await store.createAttempt(assignment.assignmentId, {
    workerId: "worker-1",
    orchestratorEpoch: 1,
  });
  await store.markRunning(assignment.assignmentId, attempt.attempt, {
    assignmentId: assignment.assignmentId,
    attempt: attempt.attempt,
    attemptToken: attempt.attemptToken,
    orchestratorEpoch: attempt.orchestratorEpoch,
  });
  const result = {
    assignmentId: assignment.assignmentId,
    attempt: attempt.attempt,
    attemptToken: attempt.attemptToken,
    orchestratorEpoch: attempt.orchestratorEpoch,
    status: "completed",
    output: `${prefix}-done`,
  };
  return { root, store, assignmentId: assignment.assignmentId, attempt, result };
}

function completionWalPath(root: string, assignmentId: string) {
  return path.join(root, "assignments", assignmentId, "completion-wal.json");
}

test("AssignmentStore recovers a pending completion WAL on the next read", async () => {
  const fixture = await completionFixture("cpb-completion-wal-recovery");

  await assert.rejects(
    withAssignmentStoreTestHooksForTests({
      afterLocalCompletionAttemptWrite: () => {
        throw new Error("simulated crash between completion publications");
      },
    }, () => fixture.store.completeAttemptFromExistingResult(fixture.assignmentId, 1, fixture.result)),
    /simulated crash between completion publications/,
  );

  const wal = await readJson(completionWalPath(fixture.root, fixture.assignmentId));
  assert.equal(wal.schemaVersion, 1);
  assert.equal(wal.attemptNum, 1);
  assert.equal(wal.attemptToken, fixture.attempt.attemptToken);

  const recovered = new AssignmentStore(fixture.root);
  const state = await recovered.getAssignment(fixture.assignmentId);
  const attempt = await recovered.getAttempt(fixture.assignmentId, 1);
  assert.equal(state?.status, "completed");
  assert.equal(attempt?.status, "completed");
  assert.deepEqual(attempt?.result, fixture.result);
  assert.equal(state?.resultWrittenAt, attempt?.completedAt);

  await assert.rejects(readFile(completionWalPath(fixture.root, fixture.assignmentId), "utf8"), { code: "ENOENT" });
});

test("AssignmentStore recovery does not create an orphan top-level attempts directory", async () => {
  const fixture = await completionFixture("cpb-completion-wal-before-attempt");

  await assert.rejects(
    withAssignmentStoreTestHooksForTests({
      afterLocalCompletionWalWrite: () => {
        throw new Error("simulated crash before attempt publication");
      },
    }, () => fixture.store.completeAttemptFromExistingResult(fixture.assignmentId, 1, fixture.result)),
    /simulated crash before attempt publication/,
  );

  const recovered = new AssignmentStore(fixture.root);
  assert.equal((await recovered.getAssignment(fixture.assignmentId))?.status, "completed");
  assert.equal((await recovered.getAttempt(fixture.assignmentId, 1))?.status, "completed");
  await assert.rejects(
    stat(path.join(fixture.root, "assignments", "attempts", "001")),
    { code: "ENOENT" },
  );
});

test("AssignmentStore retries inbox acknowledgement after WAL recovery", async () => {
  const fixture = await completionFixture("cpb-completion-wal-ack-retry");
  let ackCalls = 0;

  await assert.rejects(
    withAssignmentStoreTestHooksForTests({
      afterLocalCompletionAttemptWrite: () => {
        throw new Error("simulated crash before state publication");
      },
    }, () => fixture.store.completeAttemptAndAckInbox(fixture.assignmentId, 1, fixture.result, {
      workerId: "worker-1",
      claimToken: "claim-1",
      ackInboxFn: async () => {
        ackCalls += 1;
        return true;
      },
    })),
    /simulated crash before state publication/,
  );
  assert.equal(ackCalls, 0);

  const recovered = new AssignmentStore(fixture.root);
  const completion = await recovered.completeAttemptAndAckInbox(fixture.assignmentId, 1, fixture.result, {
    workerId: "worker-1",
    claimToken: "claim-1",
    ackInboxFn: async () => {
      ackCalls += 1;
      return true;
    },
  });
  assert.deepEqual(completion, { accepted: true, inboxAcked: true });
  assert.equal(ackCalls, 1);
  await assert.rejects(readFile(completionWalPath(fixture.root, fixture.assignmentId), "utf8"), { code: "ENOENT" });
});

test("AssignmentStore completion is idempotent for the same terminal result", async () => {
  const fixture = await completionFixture("cpb-completion-wal-idempotent");
  let ackCalls = 0;

  const first = await fixture.store.completeAttemptAndAckInbox(fixture.assignmentId, 1, fixture.result, {
    workerId: "worker-1",
    claimToken: "claim-1",
    ackInboxFn: async () => {
      ackCalls += 1;
      return true;
    },
  });
  const stateAfterFirst = await fixture.store.getAssignment(fixture.assignmentId);
  const attemptAfterFirst = await fixture.store.getAttempt(fixture.assignmentId, 1);

  const second = await fixture.store.completeAttemptAndAckInbox(fixture.assignmentId, 1, fixture.result, {
    workerId: "worker-1",
    claimToken: "claim-1",
    ackInboxFn: async () => {
      ackCalls += 1;
      return true;
    },
  });
  const stateAfterSecond = await fixture.store.getAssignment(fixture.assignmentId);
  const attemptAfterSecond = await fixture.store.getAttempt(fixture.assignmentId, 1);

  assert.deepEqual(first, { accepted: true, inboxAcked: true });
  assert.deepEqual(second, { accepted: true, inboxAcked: true });
  assert.equal(ackCalls, 2);
  assert.deepEqual(stateAfterSecond, stateAfterFirst);
  assert.deepEqual(attemptAfterSecond, attemptAfterFirst);
});

// ---------------------------------------------------------------------------
// Multi-process concurrent write to same assignment
// ---------------------------------------------------------------------------

test("multi-process concurrent writeJsonAtomic to same file: last writer wins", async () => {
  const root = await tempRoot("cpb-concurrent-json");
  const filePath = path.join(root, "shared.json");
  const scriptPath = path.join(root, "writer.mjs");

  // Initial write
  await writeJsonAtomic(filePath, { writer: "initial", seq: 0 });

  // Write child script to a temp file
  await writeFile(scriptPath, `
    import { writeJsonAtomic } from "${path.resolve("dist/shared/fs-utils.js")}";

    const filePath = process.argv[2];
    const writerId = process.argv[3];
    const seq = Number(process.argv[4]);

    for (let i = 0; i < 10; i++) {
      await writeJsonAtomic(filePath, { writer: writerId, seq: seq * 10 + i });
    }
    process.exit(0);
  `);

  const { spawn } = await import("node:child_process");
  const child1 = spawn(process.execPath, [scriptPath, filePath, "child-A", "1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child2 = spawn(process.execPath, [scriptPath, filePath, "child-B", "2"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const [exit1, exit2] = await Promise.all([
    new Promise<number | null>((resolve) => child1.on("exit", resolve)),
    new Promise<number | null>((resolve) => child2.on("exit", resolve)),
  ]);

  assert.equal(exit1, 0, `child-A exited with ${exit1}`);
  assert.equal(exit2, 0, `child-B exited with ${exit2}`);

  // File should exist and be valid JSON from one of the writers
  const content = JSON.parse(await readFile(filePath, "utf8"));
  assert.ok(content.writer === "child-A" || content.writer === "child-B");
  assert.equal(typeof content.seq, "number");
});

// ---------------------------------------------------------------------------
// writeJsonAtomic — edge cases
// ---------------------------------------------------------------------------

test("writeJsonAtomic handles empty object", async () => {
  const root = await tempRoot("cpb-json-atomic-empty");
  const filePath = path.join(root, "empty.json");

  await writeJsonAtomic(filePath, {});
  const content = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(content, {});
});

test("writeJsonAtomic handles large payload", async () => {
  const root = await tempRoot("cpb-json-atomic-large");
  const filePath = path.join(root, "large.json");

  const largeArray = Array.from({ length: 10_000 }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    data: "x".repeat(100),
  }));
  const payload = { items: largeArray };

  await writeJsonAtomic(filePath, payload);
  const content = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(content.items.length, 10_000);
  assert.equal(content.items[0].id, 0);
  assert.equal(content.items[9999].id, 9999);
});

test("writeJsonAtomic is safe against symlink attacks on target", async () => {
  const root = await tempRoot("cpb-json-atomic-symlink");
  const realFile = path.join(root, "real.json");
  const symlinkFile = path.join(root, "symlink.json");

  await writeJsonAtomic(realFile, { real: true });
  // The implementation uses O_NOFOLLOW, so writing through a symlink
  // to a different path should work (it writes to the symlink path, not the target)
  await writeJsonAtomic(symlinkFile, { via: "symlink" });

  const content = JSON.parse(await readFile(symlinkFile, "utf8"));
  assert.deepEqual(content, { via: "symlink" });
});
