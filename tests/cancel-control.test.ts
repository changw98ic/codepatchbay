import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { run as runCancelCommand } from "../cli/commands/cancel-redirect.js";
import { createJob } from "../server/services/job/job-store.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import { tempRoot } from "./helpers.js";

test("cpb cancel targets the project runtime and signals the active worker attempt", async () => {
  const cpbRoot = await tempRoot("cpb-cancel-root");
  const dataRoot = path.join(cpbRoot, "project-runtime");
  const hubRoot = path.join(cpbRoot, "hub-runtime");
  const queueEntryId = "queue-cancel-1";
  const project = "project-a";

  const job = await createJob(cpbRoot, {
    project,
    task: "long running task",
    queueEntryId,
    dataRoot,
  });
  assert.ok(job.jobId);

  const assignments = new AssignmentStore(hubRoot);
  await assignments.init();
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: queueEntryId,
    projectId: project,
    task: "long running task",
  });
  assert.ok(assignment.assignmentId);
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "worker-a",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, attempt.attempt);

  const previousProjectRuntimeRoot = process.env.CPB_PROJECT_RUNTIME_ROOT;
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  const originalLog = console.log;
  process.env.CPB_PROJECT_RUNTIME_ROOT = dataRoot;
  process.env.CPB_HUB_ROOT = hubRoot;
  console.log = () => {};
  try {
    const exitCode = await runCancelCommand(
      [project, job.jobId, "operator requested stop"],
      { command: "cancel", cpbRoot },
    );
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
    if (previousProjectRuntimeRoot === undefined) delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    else process.env.CPB_PROJECT_RUNTIME_ROOT = previousProjectRuntimeRoot;
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  }

  const control = await assignments.readCancel(assignment.assignmentId, attempt.attempt);
  assert.equal(control?.reason, "operator requested stop");
  assert.equal(control?.requestedBy, "hub");
});
