import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { collectRuntimeHealth } from "../server/services/runtime.js";
async function tempRoot(prefix) {
    return mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}
test("cpb usage reads package.json version instead of hardcoded fallback", async () => {
    const executorRoot = await tempRoot("cpb-usage-version");
    await writeFile(path.join(executorRoot, "package.json"), `${JSON.stringify({ name: "fixture-cpb", version: "9.8.7" }, null, 2)}\n`, "utf8");
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "cpb"), "--help"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            CPB_ROOT: process.cwd(),
            CPB_EXECUTOR_ROOT: executorRoot,
        },
        encoding: "utf8",
    });
    assert.match(result.stdout, /cpb.*v9\.8\.7/);
    assert.doesNotMatch(result.stdout, /v0\.2\.0/);
});
test("runtime health blocks mismatched source and active release versions", async () => {
    const health = await collectRuntimeHealth({
        cpbRoot: process.cwd(),
        executorRoot: process.cwd(),
        probes: {
            sourceVersion: "1.0.0",
            activeReleaseVersion: "2.0.0",
            launcherReleaseVersion: "2.0.0",
            initialized: true,
            hubOrchestratorStatus: "running",
            queueEntries: [],
            jobsIndexDivergenceCount: 0,
            staleJobs: [],
        },
    });
    assert.equal(health.ok, false);
    assert.equal(health.sourceVersion, "1.0.0");
    assert.equal(health.activeReleaseVersion, "2.0.0");
    assert.equal(health.launcherReleaseVersion, "2.0.0");
    assert.equal(health.jobsIndexDivergence.severity, "ok");
    assert.ok(health.blockers.some((b) => b.code === "release_version_mismatch"));
});
test("runtime health treats uninitialized release state as a warning", async () => {
    const health = await collectRuntimeHealth({
        cpbRoot: process.cwd(),
        executorRoot: process.cwd(),
        probes: {
            sourceVersion: "1.0.0",
            activeReleaseVersion: null,
            launcherReleaseVersion: null,
            initialized: false,
            queueEntries: [],
            jobsIndexDivergenceCount: 0,
            staleJobs: [],
        },
    });
    assert.equal(health.ok, true);
    assert.equal(health.initialized, false);
    assert.deepEqual(health.blockers, []);
    assert.ok(health.warnings.some((w) => w.code === "release_uninitialized"));
});
test("runtime health warns when selected active release metadata is unavailable", async () => {
    const health = await collectRuntimeHealth({
        cpbRoot: process.cwd(),
        executorRoot: process.cwd(),
        probes: {
            sourceVersion: "1.0.0",
            activeReleaseVersion: null,
            launcherReleaseVersion: "1.0.0",
            initialized: true,
            queueEntries: [],
            jobsIndexDivergenceCount: 0,
            staleJobs: [],
        },
    });
    assert.equal(health.ok, true);
    assert.equal(health.initialized, true);
    assert.ok(health.warnings.some((w) => w.code === "active_release_unknown"));
});
test("runtime health divergence scan is read-only for malformed event logs", async () => {
    const cpbRoot = await tempRoot("cpb-health-readonly-events");
    const hubRoot = await tempRoot("cpb-health-readonly-hub");
    const previousHubRoot = process.env.CPB_HUB_ROOT;
    process.env.CPB_HUB_ROOT = hubRoot;
    try {
        const project = await registerProject(hubRoot, {
            id: "proj",
            sourcePath: cpbRoot,
            skipCodeGraphGate: true,
        });
        const dataRoot = project.projectRuntimeRoot;
        const eventsDir = path.join(dataRoot, "events", "proj");
        await mkdir(eventsDir, { recursive: true });
        await writeFile(path.join(dataRoot, "jobs-index.json"), JSON.stringify({
            _meta: { version: 1, updatedAt: "2026-06-11T00:00:00.000Z", jobCount: 1 },
            jobs: {
                "proj/job-1": { project: "proj", jobId: "job-1", status: "running" },
            },
        }) + "\n", "utf8");
        const eventFile = path.join(eventsDir, "job-1.jsonl");
        const raw = `${JSON.stringify({ type: "job_created", project: "proj", jobId: "job-1", task: "t", ts: "2026-06-11T00:00:00.000Z" })}\n{"type":"phase_started"`;
        await writeFile(eventFile, raw, "utf8");
        const health = await collectRuntimeHealth({
            cpbRoot,
            executorRoot: process.cwd(),
            probes: {
                sourceVersion: "1.0.0",
                activeReleaseVersion: "1.0.0",
                launcherReleaseVersion: "1.0.0",
                initialized: true,
                queueEntries: [],
                staleJobs: [],
            },
        });
        assert.equal(health.jobsIndexDivergence.count, 1);
        assert.equal(await readFile(eventFile, "utf8"), raw);
    }
    finally {
        if (previousHubRoot === undefined) {
            delete process.env.CPB_HUB_ROOT;
        }
        else {
            process.env.CPB_HUB_ROOT = previousHubRoot;
        }
    }
});
test("first-observed jobs-index divergence is a needs_reconcile warning", async () => {
    const health = await collectRuntimeHealth({
        cpbRoot: process.cwd(),
        executorRoot: process.cwd(),
        probes: {
            sourceVersion: "1.0.0",
            activeReleaseVersion: "1.0.0",
            launcherReleaseVersion: null,
            initialized: true,
            queueEntries: [],
            jobsIndexDivergenceCount: 4,
            staleJobs: [],
        },
    });
    assert.equal(health.jobsIndexDivergence.count, 4);
    assert.equal(health.jobsIndexDivergence.severity, "warning");
    assert.ok(health.warnings.some((w) => w.code === "jobs_index_needs_reconcile"));
    assert.ok(!health.blockers.some((b) => b.code === "jobs_index_divergent"));
});
test("jobs-index divergence escalates only from explicit read-only history evidence", async () => {
    const health = await collectRuntimeHealth({
        cpbRoot: process.cwd(),
        executorRoot: process.cwd(),
        probes: {
            sourceVersion: "1.0.0",
            activeReleaseVersion: "1.0.0",
            launcherReleaseVersion: null,
            initialized: true,
            queueEntries: [],
            jobsIndexDivergenceCount: 2,
            staleJobs: [],
        },
        history: [
            { jobsIndexDivergence: { count: 2, severity: "warning" } },
        ],
    });
    assert.equal(health.jobsIndexDivergence.severity, "blocker");
    assert.ok(health.blockers.some((b) => b.code === "jobs_index_divergent"));
});
test("failed reconcile evidence escalates jobs-index divergence without writing history", async () => {
    const cpbRoot = await tempRoot("cpb-health-readonly");
    const historyPath = path.join(cpbRoot, "health-history.json");
    const health = await collectRuntimeHealth({
        cpbRoot,
        executorRoot: process.cwd(),
        historyPath,
        probes: {
            sourceVersion: "1.0.0",
            activeReleaseVersion: "1.0.0",
            launcherReleaseVersion: null,
            initialized: true,
            queueEntries: [],
            jobsIndexDivergenceCount: 1,
            staleJobs: [],
            reconcileEvidence: { attempted: true, success: false, divergenceCount: 1 },
        },
    });
    assert.equal(health.jobsIndexDivergence.severity, "blocker");
    assert.ok(health.blockers.some((b) => b.code === "jobs_index_divergent"));
    assert.equal(existsSync(historyPath), false);
});
