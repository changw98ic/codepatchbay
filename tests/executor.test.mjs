#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerTask, unregisterTask, getRunningTasks, getDurableTasks } from "../server/services/executor.js";
import { createJob } from "../server/services/job-store.js";

const root = await mkdtemp(path.join(tmpdir(), "flow-executor-"));

// In-memory task tracking
registerTask("job-1", "demo", "job-runner.mjs", 12345);
assert.equal(getRunningTasks().length, 1);
assert.equal(getRunningTasks()[0].id, "job-1");

unregisterTask("job-1");
assert.equal(getRunningTasks().length, 0);

// Durable task listing from event store
const job = await createJob(root, {
  project: "demo",
  task: "Add login",
  workflow: "standard",
  ts: "2026-05-13T00:00:00.000Z",
});

const durable = await getDurableTasks(root);
assert.equal(durable.length, 1);
assert.equal(durable[0].jobId, job.jobId);
assert.equal(durable[0].project, "demo");
assert.equal(durable[0].task, "Add login");
