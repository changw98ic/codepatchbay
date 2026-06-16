import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { listProjectPipelineStates } from "../server/services/job/job-projection.js";
import { completeJob, createJob, failJob, FAILURE_CODES } from "../server/services/job/job-store.js";
test("project pipeline state keeps the newest non-running job instead of drifting to older history", async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-projection-latest-"));
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-projection-latest-hub-"));
    const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-job-projection-latest-src-"));
    try {
        const project = await registerProject(hubRoot, {
            id: "flow",
            name: "flow",
            sourcePath,
            skipCodeGraphGate: true,
        });
        const dataRoot = project.projectRuntimeRoot;
        const oldJob = await createJob(cpbRoot, {
            project: "flow",
            task: "old completed job",
            jobId: "job-20260611-060000-old",
            ts: "2026-06-11T06:00:00.000Z",
            dataRoot,
        });
        await completeJob(cpbRoot, "flow", oldJob.jobId, { ts: "2026-06-11T06:00:10.000Z", dataRoot });
        const newJob = await createJob(cpbRoot, {
            project: "flow",
            task: "new failed job",
            jobId: "job-20260611-060100-new",
            ts: "2026-06-11T06:01:00.000Z",
            dataRoot,
        });
        await failJob(cpbRoot, "flow", newJob.jobId, {
            reason: "verification failed",
            code: FAILURE_CODES.RECOVERABLE,
            ts: "2026-06-11T06:01:10.000Z",
            dataRoot,
        });
        const states = await listProjectPipelineStates(cpbRoot, { hubRoot, includeLegacy: false });
        assert.equal(states.flow.jobId, newJob.jobId);
        assert.equal(states.flow.status, "failed");
    }
    finally {
        await rm(cpbRoot, { recursive: true, force: true });
        await rm(hubRoot, { recursive: true, force: true });
        await rm(sourcePath, { recursive: true, force: true });
    }
});
