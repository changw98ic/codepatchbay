import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, readFile } from "node:fs/promises";

import { AssignmentStore } from "../server/orchestrator/assignment-store.js";
import { WorkerStore } from "../server/orchestrator/worker-store.js";

describe("plumbing-agents: metadata.agent and metadata.agents in managed worker assignments", () => {
  it("writes agent and agents metadata into the managed-worker inbox payload", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-plumbing-"));
    const hubRoot = path.join(tmpDir, "hub");
    try {
      const assignments = new AssignmentStore(hubRoot);
      const workers = new WorkerStore(hubRoot);
      await assignments.init();
      await workers.init();

      const assignment = await assignments.getOrCreateAssignmentForEntry({
        entryId: "q-test-001",
        projectId: "test-project",
        task: "test task",
        sourcePath: tmpDir,
        workflow: "standard",
        planMode: "full",
        sourceContext: { queueEntryId: "q-test-001" },
        metadata: {
          agent: "browser-agent:chatgpt",
          agents: ["claude", "browser-agent:deepseek"],
          workflow: "standard",
          autoFinalize: false,
        },
      });
      const attempt = await assignments.createAttempt(assignment.assignmentId, {
        workerId: "w-test",
        orchestratorEpoch: 1,
      });
      await workers.writeInbox("w-test", {
        assignmentId: assignment.assignmentId,
        entryId: assignment.entryId,
        projectId: assignment.projectId,
        task: assignment.task,
        sourcePath: assignment.sourcePath,
        workflow: assignment.workflow,
        planMode: assignment.planMode,
        sourceContext: assignment.sourceContext,
        metadata: assignment.metadata,
        attempt: attempt.attempt,
        attemptToken: attempt.attemptToken,
        orchestratorEpoch: attempt.orchestratorEpoch,
      });

      const raw = await readFile(path.join(hubRoot, "workers", "inbox", "w-test", `${assignment.assignmentId}.json`), "utf8");
      const payload = JSON.parse(raw);
      assert.equal(payload.metadata.agent, "browser-agent:chatgpt");
      assert.deepEqual(payload.metadata.agents, ["claude", "browser-agent:deepseek"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
