#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, eventFileFor } from "../server/services/event-store.js";
import { acquireLease, readLease } from "../server/services/lease-manager.js";
import { projectPipelineState } from "../server/services/job-projection.js";

const repoRoot = path.resolve(".");

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

const root = await mkdtemp(path.join(tmpdir(), "flow-runtime-root-"));
const project = "demo";
const jobId = "job-20260513-120000-abc123";

await appendEvent(root, project, jobId, {
  type: "job_created",
  jobId,
  project,
  task: "Migrate runtime root",
  ts: "2026-05-13T12:00:00.000Z",
});

await appendEvent(root, project, jobId, {
  type: "phase_started",
  jobId,
  project,
  phase: "plan",
  attempt: 1,
  leaseId: "lease-job-20260513-plan",
  ts: "2026-05-13T12:00:01.000Z",
});

const eventFile = eventFileFor(root, project, jobId);
assert.equal(
  eventFile,
  path.join(root, "flow-task", "events", project, `${jobId}.jsonl`)
);
assert.equal(await exists(path.join(root, ".omc", "events")), false);

await acquireLease(root, {
  leaseId: "lease-job-20260513-plan",
  jobId,
  phase: "plan",
  ttlMs: 60_000,
  now: new Date("2026-05-13T12:00:00.000Z"),
});

assert.notEqual(await readLease(root, "lease-job-20260513-plan"), null);
assert.equal(await exists(path.join(root, "flow-task", "leases", "lease-job-20260513-plan.json")), true);
assert.equal(await exists(path.join(root, ".omc", "leases")), false);

// Verify pipeline state comes from job projection (no state files needed)
const pipelineState = await projectPipelineState(root, project);
assert.equal(pipelineState.project, "demo");
assert.equal(pipelineState.phase, "plan");
assert.equal(pipelineState.status, "EXECUTING");
assert.equal(pipelineState.jobId, jobId);

// No state files should exist
assert.equal(await exists(path.join(root, "flow-task", "state")), false);
assert.equal(await exists(path.join(root, ".omc", "state")), false);

const { bootstrap } = await import("../bridges/worktree-manager.mjs");
const projectDir = path.join(root, "source");
await bootstrap(projectDir);
const gitignore = await import("node:fs/promises").then(m => m.readFile(path.join(projectDir, ".gitignore"), "utf8"));
assert.match(gitignore, /flow-task\/worktrees\//);
assert.doesNotMatch(gitignore, /\.omc\/worktrees\//);
