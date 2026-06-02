import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { appendEvent } from "../server/services/event-store.js";
import { finalizeAndWriteSuccessfulResult } from "../runtime/worker/managed-worker.js";

describe("managed worker finalizer result writeback", () => {
  let tmpDir;
  let cpbRoot;
  let hubRoot;
  let sourcePath;
  let worktreePath;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-managed-worker-finalizer-"));
    cpbRoot = path.join(tmpDir, "cpb");
    hubRoot = path.join(tmpDir, "hub");
    sourcePath = path.join(tmpDir, "source");
    worktreePath = path.join(tmpDir, "worktree");
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(hubRoot, { recursive: true });
    await mkdir(sourcePath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes the real no-GitHub finalizer result into result.json", async () => {
    const project = "worker-finalizer";
    const jobId = "job-q-real";
    const assignmentId = "assignment-real";
    const attemptNum = 1;
    const attemptDir = path.join(hubRoot, "assignments", assignmentId, "attempts", "001");
    const inboxDir = path.join(cpbRoot, "wiki", "projects", project, "inbox");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(path.join(inboxDir, "plan-worker.md"), "# Plan\n\nCreate a review bundle.\n", "utf8");

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created",
      jobId,
      project,
      task: "Create a review bundle",
      ts: new Date().toISOString(),
    });
    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      project,
      phase: "plan",
      artifact: "plan-worker",
      ts: new Date().toISOString(),
    });
    await appendEvent(cpbRoot, project, jobId, {
      type: "job_completed",
      jobId,
      project,
      ts: new Date().toISOString(),
    });

    const finalizeResult = await finalizeAndWriteSuccessfulResult({
      cpbRoot,
      hubRoot,
      assignment: {
        assignmentId,
        entryId: "q-real",
        projectId: project,
        attempt: attemptNum,
        attemptToken: "attempt-token-real",
        sourcePath,
        sourceContext: {},
        task: "Create a review bundle",
        workflow: "standard",
        planMode: "full",
        metadata: {
          autoFinalize: true,
          source: "cli",
          workflow: "standard",
          planMode: "full",
        },
      },
      attemptDir,
      assignmentId,
      attemptNum,
      result: { status: "completed", jobId },
      worktreeInfo: { path: worktreePath, branch: "codex/test" },
      log: { info() {}, warn() {} },
    });

    assert.equal(finalizeResult?.status, "review_bundle");

    const written = JSON.parse(await readFile(path.join(attemptDir, "result.json"), "utf8"));
    assert.equal(written.status, "completed");
    assert.equal(written.finalizeResult?.status, "review_bundle");
    assert.equal(written.finalizeResult?.jobId, jobId);
    assert.ok(written.finalizeResult?.bundlePath);
  });
});
