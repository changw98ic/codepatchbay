import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { buildMeta, executionBoundaryEvent } from "../server/services/execution-meta.js";

describe("buildMeta", () => {
  test("returns null for all optional fields when no input", () => {
    const meta = buildMeta();
    assert.equal(meta.projectId, null);
    assert.equal(meta.sourcePath, null);
    assert.equal(meta.sessionId, null);
    assert.equal(meta.workerId, null);
    assert.equal(meta.cwd, null);
    assert.equal(meta.executionBoundary, "source");
  });

  test("preserves provided values", () => {
    const meta = buildMeta({
      projectId: "my-project",
      sourcePath: "/repos/project",
      sessionId: "sess-001",
      workerId: "worker-1",
      cwd: "/repos/project/worktree",
      executionBoundary: "worktree",
    });
    assert.equal(meta.projectId, "my-project");
    assert.equal(meta.sourcePath, "/repos/project");
    assert.equal(meta.sessionId, "sess-001");
    assert.equal(meta.workerId, "worker-1");
    assert.equal(meta.cwd, "/repos/project/worktree");
    assert.equal(meta.executionBoundary, "worktree");
  });

  test("defaults cwd to sourcePath when cwd not provided", () => {
    const meta = buildMeta({ sourcePath: "/repos/project" });
    assert.equal(meta.cwd, "/repos/project");
  });

  test("converts empty strings to null", () => {
    const meta = buildMeta({
      projectId: "",
      sourcePath: "",
      sessionId: "",
      workerId: "",
    });
    assert.equal(meta.projectId, null);
    assert.equal(meta.sourcePath, null);
    assert.equal(meta.sessionId, null);
    assert.equal(meta.workerId, null);
    assert.equal(meta.cwd, null);
  });

  test("defaults executionBoundary to source", () => {
    assert.equal(buildMeta().executionBoundary, "source");
    assert.equal(buildMeta({ executionBoundary: "" }).executionBoundary, "source");
  });
});

describe("executionBoundaryEvent", () => {
  test("creates well-formed event from meta", () => {
    const meta = buildMeta({
      sourcePath: "/repos/project",
      sessionId: "sess-001",
      workerId: "worker-1",
    });
    const event = executionBoundaryEvent(meta, {
      jobId: "job-20260517-120000-abc",
      project: "my-project",
      ts: "2026-05-17T12:00:00.000Z",
    });

    assert.equal(event.type, "execution_boundary");
    assert.equal(event.jobId, "job-20260517-120000-abc");
    assert.equal(event.project, "my-project");
    assert.equal(event.sourcePath, "/repos/project");
    assert.equal(event.cwd, "/repos/project");
    assert.equal(event.sessionId, "sess-001");
    assert.equal(event.workerId, "worker-1");
    assert.equal(event.ts, "2026-05-17T12:00:00.000Z");
  });

  test("carries null metadata when not provided", () => {
    const meta = buildMeta({ sourcePath: "/repos/project" });
    const event = executionBoundaryEvent(meta, {
      jobId: "job-1",
      project: "p1",
      ts: "2026-05-17T00:00:00.000Z",
    });

    assert.equal(event.sessionId, null);
    assert.equal(event.workerId, null);
    assert.equal(event.cwd, "/repos/project");
  });
});
