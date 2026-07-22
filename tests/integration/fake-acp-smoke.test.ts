import assert from "node:assert/strict";
import { readFile, stat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  runDemo,
  runWithDemoTemporaryWorkspace,
} from "../../server/services/readiness-checks.js";
import type { TemporaryWorkspace } from "../../core/runtime/temporary-workspace.js";

test("demo produces all required artifacts and a passing verdict", async () => {
  const result = await runDemo();

  assert.equal(result.ok, true);
  assert.ok(result.project, "result has project name");
  assert.ok(result.tempRoot, "result has tempRoot");
  assert.ok(result.cpbRoot, "result has cpbRoot");
  assert.ok(result.sourcePath, "result has sourcePath");
  assert.equal(result.workspaceCleanup.cleanupVerified, true);
  assert.equal(result.workspaceCleanup.successorPreserved, false);
  assert.equal(result.tempRoot, result.workspaceCleanup.recoveryPaths.quarantineRoot);
  await assert.rejects(stat(result.workspaceCleanup.recoveryPaths.canonicalRoot), { code: "ENOENT" });

  // Job completed
  assert.equal(result.job.status, "completed", "job status is completed");
  assert.ok(result.job.jobId, "job has jobId");

  // All six artifacts present
  for (const key of ["plan", "deliverable", "diff", "tests", "verdict", "risk"]) {
    const artifact = result.artifacts[key];
    assert.ok(artifact, `missing artifact: ${key}`);
    assert.ok(artifact.path, `artifact ${key} has path`);
    const info = await stat(artifact.path);
    assert.ok(info.isFile(), `artifact ${key} is a file`);
  }

  // Verdict content is pass
  const verdictContent = await readFile(result.artifacts.verdict.path, "utf8");
  const verdict = JSON.parse(verdictContent);
  assert.equal(verdict.status, "pass");

  // Event log exists and is non-empty
  assert.ok(result.eventLog, "result has eventLog");
  const logInfo = await stat(result.eventLog);
  assert.ok(logInfo.isFile(), "eventLog is a file");
  const logContent = await readFile(result.eventLog, "utf8");
  const logLines = logContent.trim().split("\n").filter(Boolean);
  assert.ok(logLines.length >= 5, `event log has ${logLines.length} entries`);

  // Story has all five entries in correct order
  assert.deepEqual(
    result.story.map((s) => s.name),
    ["plan", "diff", "tests", "verdict", "risk"],
  );

  // Toy repo has the fixed sum.js
  const sumSource = await readFile(path.join(result.sourcePath, "src", "sum.js"), "utf8");
  assert.ok(sumSource.includes("return a + b"), "sum.js was fixed to addition");

  // Cleanup
  await rm(result.workspaceCleanup.recoveryPaths.quarantineContainer || result.tempRoot, { recursive: true, force: true });
});

test("demo workspace preserves primary and successor-safe cleanup recovery evidence", async () => {
  const primary = new Error("synthetic demo failure");
  const recovery = {
    version: 1,
    kind: "temporary_workspace_recovery",
    code: "TEMPORARY_WORKSPACE_SUCCESSOR_PRESERVED",
    recoveryPaths: {
      canonicalRoot: "/tmp/cpb-demo-owned",
      quarantineRoot: "/tmp/.cpb-quarantine-demo-owned",
    },
    successorPreserved: true,
  } as const;
  const cleanupFailure = Object.assign(new Error("synthetic demo cleanup race"), {
    temporaryWorkspaceRecovery: recovery,
  });
  let cleanupCalls = 0;
  const workspace = {
    rootPath: "/tmp/cpb-demo-owned",
    cleanup: async () => {
      cleanupCalls += 1;
      throw cleanupFailure;
    },
  } as unknown as TemporaryWorkspace;

  await assert.rejects(
    runWithDemoTemporaryWorkspace(
      async (rootPath) => {
        assert.equal(rootPath, workspace.rootPath);
        throw primary;
      },
      async () => workspace,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanupFailure]);
      assert.equal(error.cause, primary);
      assert.equal((error as { temporaryWorkspaceRecovery?: unknown }).temporaryWorkspaceRecovery, recovery);
      assert.deepEqual((error as { recoveryPaths?: unknown }).recoveryPaths, recovery.recoveryPaths);
      assert.equal((error as { successorPreserved?: unknown }).successorPreserved, true);
      return true;
    },
  );
  assert.equal(cleanupCalls, 1);
});

test("demo failure reports successful quarantine proof", async () => {
  const primary = new Error("synthetic demo operation failure");
  const cleanupProof = {
    version: 1,
    kind: "temporary_workspace_disposition",
    recoveryPaths: {
      canonicalRoot: "/tmp/cpb-demo-proof-owned",
      quarantineRoot: "/tmp/.cpb-quarantine-demo-proof-owned",
    },
    successorPreserved: false,
  } as const;
  const workspace = {
    rootPath: cleanupProof.recoveryPaths.canonicalRoot,
    cleanup: async () => cleanupProof,
  } as unknown as TemporaryWorkspace;

  await assert.rejects(
    runWithDemoTemporaryWorkspace(
      async () => { throw primary; },
      async () => workspace,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary]);
      assert.equal(error.cause, primary);
      assert.equal((error as { temporaryWorkspaceRecovery?: unknown }).temporaryWorkspaceRecovery, cleanupProof);
      assert.deepEqual((error as { recoveryPaths?: unknown }).recoveryPaths, cleanupProof.recoveryPaths);
      return true;
    },
  );
});

test("demo runs with custom project name and task", async () => {
  const result = await runDemo({
    project: "custom-demo-project",
    task: "Custom demo task description",
  });

  assert.equal(result.project, "custom-demo-project");
  assert.equal(result.task, "Custom demo task description");
  assert.equal(result.job.status, "completed");

  // Plan mentions the custom task
  const planContent = await readFile(result.artifacts.plan.path, "utf8");
  assert.ok(planContent.includes("Custom demo task description"));

  // Cleanup
  await rm(result.workspaceCleanup.recoveryPaths.quarantineContainer || result.tempRoot, { recursive: true, force: true });
});
