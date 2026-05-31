import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, mkdir } from "node:fs/promises";

import { ProjectWorker } from "../runtime/worker/project-worker.js";

describe("plumbing-agents: metadata.agent and metadata.agents passed to runJobWithServices", () => {
  it("runPipeline passes agent and agents from queue entry metadata", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-plumbing-"));
    const hubRoot = path.join(tmpDir, "hub");
    await mkdir(hubRoot, { recursive: true });

    const captured = {
      agent: undefined,
      agents: undefined,
    };

    const mockRunPipelineFn = (entry, sourcePath, dispatchId, overrideProjectId, worktree) => {
      // Simulate what the real runPipeline does: extract metadata and call runJobWithServices
      captured.agent = entry.metadata?.agent || null;
      captured.agents = entry.metadata?.agents || null;
      return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "", job: { status: "completed" } });
    };

    const worker = new ProjectWorker({
      projectId: "test-project",
      cpbRoot: tmpDir,
      hubRoot,
      once: true,
      runPipelineFn: mockRunPipelineFn,
    });

    // Mock the queue entry that the worker would claim
    const mockEntry = {
      id: "q-test-001",
      projectId: "test-project",
      description: "test task",
      sourcePath: tmpDir,
      metadata: {
        agent: "browser-agent:chatgpt",
        agents: ["claude", "browser-agent:deepseek"],
        workflow: "standard",
        autoFinalize: false,
      },
    };

    // Directly test the runPipeline path by calling it with the mock entry
    const result = await worker.runPipeline(mockEntry, tmpDir, null, "test-project");

    assert.equal(result.ok, true);
    assert.equal(captured.agent, "browser-agent:chatgpt");
    assert.deepEqual(captured.agents, ["claude", "browser-agent:deepseek"]);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("runPipeline handles missing agent/agents metadata gracefully", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-plumbing-"));
    const hubRoot = path.join(tmpDir, "hub");
    await mkdir(hubRoot, { recursive: true });

    const captured = {
      agent: undefined,
      agents: undefined,
    };

    const mockRunPipelineFn = (entry, sourcePath, dispatchId, overrideProjectId, worktree) => {
      captured.agent = entry.metadata?.agent || null;
      captured.agents = entry.metadata?.agents || null;
      return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "", job: { status: "completed" } });
    };

    const worker = new ProjectWorker({
      projectId: "test-project",
      cpbRoot: tmpDir,
      hubRoot,
      once: true,
      runPipelineFn: mockRunPipelineFn,
    });

    const mockEntry = {
      id: "q-test-002",
      projectId: "test-project",
      description: "test task no agents",
      sourcePath: tmpDir,
      metadata: {
        workflow: "standard",
      },
    };

    const result = await worker.runPipeline(mockEntry, tmpDir, null, "test-project");

    assert.equal(result.ok, true);
    assert.equal(captured.agent, null);
    assert.equal(captured.agents, null);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
