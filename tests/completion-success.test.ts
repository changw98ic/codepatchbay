import assert from "node:assert/strict";
import { test } from "node:test";

import { handleCompletionSuccess } from "../core/engine/completion-success.js";

test("handleCompletionSuccess reports gate pass, completes job, reports completion, and returns success", async () => {
  const calls: Array<{
    type: string;
    payload?: Record<string, unknown>;
  }> = [];
  const phaseResults = [{ phase: "verify", status: "passed" }];

  const result = await handleCompletionSuccess({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-success",
    phaseResults,
    completeJob: async (cpbRoot: string, project: string, jobId: string) => {
      calls.push({ type: "completeJob", payload: { cpbRoot, project, jobId } });
    },
    onProgress: async (event: Record<string, unknown>) => {
      calls.push({ type: "progress", payload: event });
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(calls, [
    {
      type: "progress",
      payload: {
        ts: "2026-06-22T00:00:00.000Z",
        type: "completion_gate_passed",
        jobId: "job-success",
        project: "proj",
      },
    },
    {
      type: "completeJob",
      payload: {
        cpbRoot: "/tmp/cpb",
        project: "proj",
        jobId: "job-success",
      },
    },
    {
      type: "progress",
      payload: {
        ts: "2026-06-22T00:00:00.000Z",
        type: "job_completed",
        jobId: "job-success",
        project: "proj",
      },
    },
  ]);
  assert.deepEqual(result, {
    status: "completed",
    jobId: "job-success",
    exitCode: 0,
    failure: null,
    phaseResults,
  });
});

test("handleCompletionSuccess ignores progress callback failures without skipping completeJob", async () => {
  const completed: string[] = [];

  const result = await handleCompletionSuccess({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-progress-failure",
    phaseResults: [],
    completeJob: async (_cpbRoot: string, _project: string, jobId: string) => {
      completed.push(jobId);
    },
    onProgress: async () => {
      throw new Error("progress sink unavailable");
    },
  });

  assert.deepEqual(completed, ["job-progress-failure"]);
  assert.equal(result.status, "completed");
});
