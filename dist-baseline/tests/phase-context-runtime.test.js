import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendEvent } from "../server/services/event/event-store.js";
import { buildPhaseContextPacket } from "../server/services/phase-context.js";
import { collectVerifierEvidence } from "../server/services/review/review-dispatch.js";
import { createJob, completePhase } from "../server/services/job/job-store.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
test("phase context and verifier evidence restore from project runtime root, not legacy wiki/events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-phase-context-runtime-"));
    const cpbRoot = path.join(root, "cpb");
    const hubRoot = path.join(root, "hub");
    const sourcePath = path.join(root, "source");
    const dataRoot = path.join(hubRoot, "projects", "flow");
    const project = "flow";
    const jobId = "job-20260611-083000-runtime";
    const previousHubRoot = process.env.CPB_HUB_ROOT;
    try {
        await mkdir(sourcePath, { recursive: true });
        const canonicalSourcePath = await realpath(sourcePath);
        await writeFile(path.join(sourcePath, "package.json"), JSON.stringify({ scripts: {} }, null, 2), "utf8");
        await registerProject(hubRoot, {
            id: project,
            sourcePath,
            projectRuntimeRoot: dataRoot,
            skipCodeGraphGate: true,
        });
        const legacyWiki = path.join(cpbRoot, "wiki", "projects", project);
        await mkdir(path.join(legacyWiki, "inbox"), { recursive: true });
        await mkdir(path.join(legacyWiki, "outputs"), { recursive: true });
        await writeFile(path.join(legacyWiki, "project.json"), JSON.stringify({ sourcePath: "/legacy/source" }, null, 2), "utf8");
        await writeFile(path.join(legacyWiki, "context.md"), "# Legacy Context\n", "utf8");
        await writeFile(path.join(legacyWiki, "outputs", "deliverable-001.md"), "# Legacy Deliverable\n", "utf8");
        await appendEvent(cpbRoot, project, jobId, {
            type: "job_created",
            jobId,
            project,
            task: "legacy task",
            workflow: "standard",
            ts: "2026-06-11T08:29:00.000Z",
        }, { legacyOnly: true });
        await mkdir(path.join(dataRoot, "wiki", "inbox"), { recursive: true });
        await mkdir(path.join(dataRoot, "wiki", "outputs"), { recursive: true });
        await writeFile(path.join(dataRoot, "wiki", "context.md"), "# Runtime Context\n", "utf8");
        await writeFile(path.join(dataRoot, "wiki", "outputs", "deliverable-001.md"), "# Runtime Deliverable\n", "utf8");
        await createJob(cpbRoot, {
            project,
            jobId,
            task: "runtime task",
            workflow: "standard",
            ts: "2026-06-11T08:30:00.000Z",
            dataRoot,
        });
        await completePhase(cpbRoot, project, jobId, {
            phase: "plan",
            artifact: "plan-001",
            ts: "2026-06-11T08:31:00.000Z",
            dataRoot,
        });
        const packet = await buildPhaseContextPacket(cpbRoot, project, jobId, "execute", { hubRoot });
        assert.equal(packet.task, "runtime task");
        assert.equal(packet.locators.sourcePath, canonicalSourcePath);
        assert.equal(packet.locators.wikiDir, path.join(dataRoot, "wiki"));
        assert.equal(packet.locators.prevArtifactPath, path.join(dataRoot, "wiki", "inbox", "plan-001.md"));
        assert.ok(!JSON.stringify(packet).includes("legacy task"));
        assert.ok(!packet.locators.prevArtifactPath.includes(path.join(cpbRoot, "wiki", "projects")));
        process.env.CPB_HUB_ROOT = hubRoot;
        const evidence = await collectVerifierEvidence(cpbRoot, project, jobId, { deliverableId: "001" });
        assert.equal(evidence.jobState?.sourcePath, canonicalSourcePath);
        assert.equal(evidence.eventLog?.available, true);
        assert.equal(evidence.eventLog?.eventCount, 2);
        assert.deepEqual(evidence.eventLog?.events.map((event) => event.task).filter(Boolean), ["runtime task"]);
        assert.equal(evidence.projectContext?.context, "# Runtime Context\n");
        assert.equal(evidence.deliverable?.content, "# Runtime Deliverable\n");
        assert.ok(!evidence.deliverable?.path.includes(path.join(cpbRoot, "wiki", "projects")));
    }
    finally {
        if (previousHubRoot === undefined) {
            delete process.env.CPB_HUB_ROOT;
        }
        else {
            process.env.CPB_HUB_ROOT = previousHubRoot;
        }
        await rm(root, { recursive: true, force: true });
    }
});
