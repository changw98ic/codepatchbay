import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runJob } from "../core/engine/run-job.js";
import { createJob, startPhase, completePhase, completeJob, failJob, listJobs } from "../server/services/job-store.js";
import { appendEvent } from "../server/services/event-store.js";

describe("runJob job index sync", () => {
  it("refreshes jobs list immediately when each phase starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-run-job-index-"));
    const cpbRoot = path.join(root, "cpb");
    const sourcePath = path.join(root, "source");
    try {
      await mkdir(sourcePath, { recursive: true });
      const started = [];
      const wrappedStartPhase = async (rootArg, project, jobId, opts) => {
        const state = await startPhase(rootArg, project, jobId, opts);
        const listed = (await listJobs(rootArg, { project })).find((job) => job.jobId === jobId);
        assert.equal(listed?.phase, opts.phase);
        assert.equal(listed?.status, "running");
        started.push(opts.phase);
        return state;
      };
      const pool = {
        async execute(_agent, _prompt, _cwd, _timeoutMs, options) {
          if (options.role === "executor") {
            return {
              output: "```json\n{\"status\":\"ok\",\"summary\":\"Updated src/app.js\",\"tests\":[\"src/app.test.js: passes\"],\"risks\":[]}\n```",
              providerKey: "claude",
            };
          }
          if (options.role === "verifier") {
            return {
              output: "```json\n{\"status\":\"ok\",\"verdict\":\"pass\",\"reason\":\"tests pass\",\"details\":\"verified\",\"confidence\":0.9}\n```",
              providerKey: "claude",
            };
          }
          throw new Error(`unexpected role ${options.role}`);
        },
      };

      const result = await runJob({
        cpbRoot,
        project: "proj",
        task: "update source file reference",
        jobId: "job-index-sync",
        workflow: "direct",
        planMode: "none",
        sourcePath,
        sourceContext: {},
        createJob,
        startPhase: wrappedStartPhase,
        completePhase,
        completeJob,
        failJob,
        appendEvent,
        getPool: () => pool,
      });

      assert.equal(result.status, "completed");
      assert.deepEqual(started, ["execute", "verify"]);
      const listed = (await listJobs(cpbRoot, { project: "proj" })).find((job) => job.jobId === "job-index-sync");
      assert.equal(listed?.status, "completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
