/**
 * Regression test for retryJob argument-order bug (#218).
 *
 * retryJob(cpbRoot, project, jobId, opts) was being called with shifted args:
 *   retryJob(dataRoot, jobId, { force })  — 3 args, all shifted.
 *
 * This test creates a cpbRoot and a distinct dataRoot, seeds a failed job,
 * then calls retryJob with the correct 4-arg signature to verify the
 * recovery job lands under the right project and data root.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createJob,
  failJob,
  retryJob,
  cancelJob,
  getJob,
} from "../server/services/job-store.js";

let cpbRoot;
let dataRoot;

beforeEach(async () => {
  cpbRoot = await mkdtemp(path.join(os.tmpdir(), "retry-cpb-"));
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "retry-data-"));
});

afterEach(async () => {
  await rm(cpbRoot, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});

describe("retryJob argument order", () => {
  it("creates recovery job with correct project when cpbRoot !== dataRoot", async () => {
    const project = "flow";
    const job = await createJob(cpbRoot, {
      project,
      task: "test task",
      dataRoot,
    });
    assert.ok(job.jobId, "job created");

    const failed = await failJob(cpbRoot, project, job.jobId, {
      reason: "test failure",
      code: "RECOVERABLE",
      dataRoot,
    });
    assert.equal(failed.status, "failed");

    const recovery = await retryJob(cpbRoot, project, job.jobId, {
      force: true,
      dataRoot,
    });

    assert.ok(recovery.jobId, "recovery job created");
    assert.equal(recovery.project, project, "recovery project matches");
    assert.ok(["pending", "running"].includes(recovery.status), "recovery job is active");
    assert.equal(recovery.recoveryOf, job.jobId, "lineage correct");

    // Verify the original job still exists and is failed
    const original = await getJob(cpbRoot, project, job.jobId, { dataRoot });
    assert.equal(original.status, "failed");
  });

  it("recovers a cancelled job with force", async () => {
    const project = "test-proj";
    const job = await createJob(cpbRoot, {
      project,
      task: "cancel then retry",
      dataRoot,
    });

    const cancelled = await cancelJob(cpbRoot, project, job.jobId, {
      reason: "test cancel",
      dataRoot,
    });
    assert.equal(cancelled.status, "cancelled");

    const recovery = await retryJob(cpbRoot, project, job.jobId, {
      force: true,
      dataRoot,
    });

    assert.ok(recovery.jobId);
    assert.equal(recovery.project, project);
    assert.ok(["pending", "running"].includes(recovery.status));
  });
});

describe("retryJob source pattern guard", () => {
  it("finds no shifted retryJob call patterns in source files", async () => {
    const { execSync } = await import("node:child_process");
    const root = path.resolve(import.meta.dirname, "..");

    // Check for the buggy 3-arg pattern: retryJob(dataRoot, jobId, ...
    const result = execSync(
      `grep -rn 'retryJob(dataRoot,' --include='*.js' --include='*.mjs' --exclude='retry-args-regression.test.mjs' . || true`,
      { cwd: root, encoding: "utf-8" }
    );

    // Also check the hub-orch variant: doRetry(dataRoot, jobId, ...
    const result2 = execSync(
      `grep -rn 'doRetry(dataRoot,' --include='*.js' --include='*.mjs' --exclude='retry-args-regression.test.mjs' . || true`,
      { cwd: root, encoding: "utf-8" }
    );

    assert.equal(result.trim(), "", "no retryJob(dataRoot, ...) pattern should exist");
    assert.equal(result2.trim(), "", "no doRetry(dataRoot, ...) pattern should exist");
  });
});
