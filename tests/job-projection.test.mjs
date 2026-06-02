import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { jobToPipelineState } from "../server/services/job-projection.js";

describe("jobToPipelineState", () => {
  it("projects job statuses using the lowercase UI API contract", () => {
    const running = jobToPipelineState({
      project: "proj",
      task: "run",
      jobId: "job-q-running-0001",
      status: "running",
      phase: "execute",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:01:00.000Z",
    });
    const completed = jobToPipelineState({
      project: "proj",
      task: "done",
      jobId: "job-q-complete-0001",
      status: "completed",
      phase: "completed",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:02:00.000Z",
    });

    assert.equal(running.status, "running");
    assert.equal(completed.status, "completed");
  });
});
