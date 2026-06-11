import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendEvent,
  readCheckpoint,
  readEvents,
  writeCheckpoint,
} from "../server/services/event-store.js";
import { registerProject } from "../server/services/hub-registry.js";
import { listJobs, listJobsAcrossRuntimeRoots } from "../server/services/job-store.js";
import { readJobsIndex } from "../server/services/jobs-index.js";
import { acquireLease, readLease } from "../server/services/lease-manager.js";
import { reconcileJobs, cleanupJobs } from "../server/services/reconcile.js";
import { assertNoLegacyRuntimeData } from "../server/services/runtime-migration-guard.js";
import { migrateToProjectRuntimeRoots } from "../runtime/migrate-runtime-root.js";

async function tempRoot(prefix: string) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function assertMissing(file: string) {
  await assert.rejects(() => access(file), { code: "ENOENT" });
}

test("broken runtime migration moves registered legacy runtime data into project roots", async () => {
  const cpbRoot = await tempRoot("cpb-runtime-migrate-");
  const hubRoot = await tempRoot("cpb-runtime-migrate-hub-");
  const sourcePath = await tempRoot("cpb-runtime-migrate-source-");
  const jobId = "job-20260611-080000-migrate";
  try {
    const project = await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath,
      skipCodeGraphGate: true,
    }) as Record<string, any>;
    const dataRoot = project.projectRuntimeRoot;

    await appendEvent(cpbRoot, "flow", jobId, {
      type: "job_created",
      jobId,
      project: "flow",
      task: "legacy job to migrate",
      workflow: "standard",
      ts: "2026-06-11T08:00:00.000Z",
    }, { legacyOnly: true });
    await writeCheckpoint(
      cpbRoot,
      "flow",
      jobId,
      {
        jobId,
        project: "flow",
        task: "legacy checkpoint",
        status: "completed",
        createdAt: "2026-06-11T08:00:00.000Z",
        updatedAt: "2026-06-11T08:00:01.000Z",
      },
      { legacyOnly: true },
    );
    await mkdir(path.join(cpbRoot, "wiki", "projects", "flow", "inbox"), { recursive: true });
    await writeFile(path.join(cpbRoot, "wiki", "projects", "flow", "inbox", "plan-001.md"), "# migrated\n", "utf8");

    const report = await migrateToProjectRuntimeRoots(cpbRoot, hubRoot, { dryRun: false });

    assert.equal(report.conflicts.length, 0);
    assert.equal(report.retained.length, 0);
    assert.deepEqual(
      (await readEvents(cpbRoot, "flow", jobId, { dataRoot })).map((event) => event.type),
      ["job_created"],
    );
    assert.equal((await readCheckpoint(cpbRoot, "flow", jobId, { dataRoot }))?.task, "legacy checkpoint");
    assert.equal(
      await readFile(path.join(dataRoot, "wiki", "inbox", "plan-001.md"), "utf8"),
      "# migrated\n",
    );

    const index = await readJobsIndex(cpbRoot, { dataRoot });
    assert.equal(index?.jobs?.[`flow/${jobId}`]?.task, "legacy job to migrate");
    await assertMissing(path.join(cpbRoot, "cpb-task", "events", "flow", `${jobId}.jsonl`));
    await assertNoLegacyRuntimeData(cpbRoot);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  }
});

test("broken runtime migration fails before moving unregistered legacy projects", async () => {
  const cpbRoot = await tempRoot("cpb-runtime-migrate-unmapped-");
  const hubRoot = await tempRoot("cpb-runtime-migrate-unmapped-hub-");
  const sourcePath = await tempRoot("cpb-runtime-migrate-unmapped-source-");
  const ghostEvent = path.join(
    cpbRoot,
    "cpb-task",
    "events",
    "ghost",
    "job-20260611-081000-ghost.jsonl",
  );
  try {
    await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath,
      skipCodeGraphGate: true,
    });
    await mkdir(path.dirname(ghostEvent), { recursive: true });
    await writeFile(ghostEvent, "{}\n", "utf8");

    await assert.rejects(
      () => migrateToProjectRuntimeRoots(cpbRoot, hubRoot, { dryRun: false }),
      /unregistered legacy projects: ghost/,
    );
    assert.equal(await readFile(ghostEvent, "utf8"), "{}\n");
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  }
});

test("broken runtime migration rejects poisoned project runtime roots", async () => {
  const cpbRoot = await tempRoot("cpb-runtime-migrate-poisoned-");
  const hubRoot = await tempRoot("cpb-runtime-migrate-poisoned-hub-");
  const sourcePath = await tempRoot("cpb-runtime-migrate-poisoned-source-");
  const outsideRoot = await tempRoot("cpb-runtime-migrate-poisoned-outside-");
  const legacyPlan = path.join(cpbRoot, "wiki", "projects", "flow", "inbox", "plan-001.md");
  try {
    await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath,
      skipCodeGraphGate: true,
    });
    const registryPath = path.join(hubRoot, "projects.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.projects.flow.projectRuntimeRoot = outsideRoot;
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    await mkdir(path.dirname(legacyPlan), { recursive: true });
    await writeFile(legacyPlan, "# should stay put\n", "utf8");

    await assert.rejects(
      () => migrateToProjectRuntimeRoots(cpbRoot, hubRoot, { dryRun: false }),
      /invalid projectRuntimeRoot for flow/,
    );
    assert.equal(await readFile(legacyPlan, "utf8"), "# should stay put\n");
    await assertMissing(path.join(outsideRoot, "wiki", "inbox", "plan-001.md"));
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("project runtime reads do not fall back to legacy data after the broken migration line", async () => {
  const cpbRoot = await tempRoot("cpb-runtime-no-fallback-");
  const hubRoot = await tempRoot("cpb-runtime-no-fallback-hub-");
  const sourcePath = await tempRoot("cpb-runtime-no-fallback-source-");
  const jobId = "job-20260611-082000-legacy";
  try {
    const project = await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath,
      skipCodeGraphGate: true,
    }) as Record<string, any>;
    const dataRoot = project.projectRuntimeRoot;

    await appendEvent(cpbRoot, "flow", jobId, {
      type: "job_created",
      jobId,
      project: "flow",
      task: "legacy only",
      workflow: "standard",
      ts: "2026-06-11T08:20:00.000Z",
    }, { legacyOnly: true });

    assert.deepEqual(await readEvents(cpbRoot, "flow", jobId, { dataRoot }), []);
    assert.deepEqual(await listJobs(cpbRoot, { dataRoot }), []);
    assert.deepEqual(await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot }), []);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  }
});

test("default job listing uses project runtime roots instead of legacy cpb-task", async () => {
  const cpbRoot = await tempRoot("cpb-runtime-list-default-");
  const hubRoot = await tempRoot("cpb-runtime-list-default-hub-");
  const sourcePath = await tempRoot("cpb-runtime-list-default-source-");
  const originalHubRoot = process.env.CPB_HUB_ROOT;
  const jobId = "job-20260611-082500-default";
  try {
    process.env.CPB_HUB_ROOT = hubRoot;
    const project = await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath,
      skipCodeGraphGate: true,
    }) as Record<string, any>;
    const dataRoot = project.projectRuntimeRoot;

    await appendEvent(cpbRoot, "flow", jobId, {
      type: "job_created",
      jobId,
      project: "flow",
      task: "modern default listing",
      workflow: "standard",
      ts: "2026-06-11T08:25:00.000Z",
    }, { dataRoot });

    const jobs = await listJobs(cpbRoot);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].jobId, jobId);
    await assert.rejects(() => stat(path.join(cpbRoot, "cpb-task")), { code: "ENOENT" });
  } finally {
    if (originalHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = originalHubRoot;
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  }
});

test("legacy runtime data is a fail-fast startup condition", async () => {
  const cpbRoot = await tempRoot("cpb-runtime-guard-");
  try {
    await mkdir(path.join(cpbRoot, "cpb-task", "events", "flow"), { recursive: true });
    await writeFile(
      path.join(cpbRoot, "cpb-task", "events", "flow", "job-20260611-083000-guard.jsonl"),
      "{}\n",
      "utf8",
    );

    await assert.rejects(
      () => assertNoLegacyRuntimeData(cpbRoot),
      /legacy runtime data remains.*cpb migrate-runtime-root --execute/s,
    );
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("reconcile and cleanup operate on project runtime roots without creating legacy data", async () => {
  const cpbRoot = await tempRoot("cpb-runtime-reconcile-");
  const hubRoot = await tempRoot("cpb-runtime-reconcile-hub-");
  const sourcePath = await tempRoot("cpb-runtime-reconcile-source-");
  const projectId = "flow";
  try {
    const project = await registerProject(hubRoot, {
      id: projectId,
      name: projectId,
      sourcePath,
      skipCodeGraphGate: true,
    }) as Record<string, any>;
    const dataRoot = project.projectRuntimeRoot;

    const jobId = "job-20260611-084000-reconcile";
    const leaseId = `lease-${jobId}-plan`;
    await appendEvent(cpbRoot, projectId, jobId, {
      type: "job_created",
      jobId,
      project: projectId,
      task: "modern stale job",
      workflow: "standard",
      ts: "2026-06-11T08:40:00.000Z",
    }, { dataRoot });
    await appendEvent(cpbRoot, projectId, jobId, {
      type: "phase_started",
      jobId,
      project: projectId,
      phase: "plan",
      leaseId,
      ts: "2026-06-11T08:41:00.000Z",
    }, { dataRoot });
    await acquireLease(cpbRoot, {
      leaseId,
      jobId,
      phase: "plan",
      ttlMs: 1,
      ownerPid: 999999999,
      dataRoot,
      now: new Date("2026-06-11T08:41:00.000Z"),
    });

    const orphanLeaseId = "lease-orphan-modern";
    await mkdir(path.join(dataRoot, "leases"), { recursive: true });
    await writeFile(
      path.join(dataRoot, "leases", `${orphanLeaseId}.json`),
      `${JSON.stringify({
        leaseId: orphanLeaseId,
        jobId: "job-missing-modern",
        phase: "plan",
        ownerPid: 999999999,
        acquiredAt: "2026-06-11T08:41:00.000Z",
        heartbeatAt: "2026-06-11T08:41:00.000Z",
        expiresAt: "2026-06-11T08:41:00.001Z",
      })}\n`,
      "utf8",
    );

    const dryRun = await reconcileJobs(cpbRoot, { dryRun: true, hubRoot });
    assert.equal(dryRun.staleJobs.some((job: Record<string, any>) => job.jobId === jobId && job.dataRoot === dataRoot), true);
    assert.equal(dryRun.orphanLeases.some((lease: Record<string, any>) => lease.leaseId === orphanLeaseId && lease.dataRoot === dataRoot), true);

    const report = await reconcileJobs(cpbRoot, { dryRun: false, hubRoot });
    assert.equal(report.staleJobs.some((job: Record<string, any>) => job.jobId === jobId), true);
    assert.equal(report.orphanLeases.some((lease: Record<string, any>) => lease.leaseId === orphanLeaseId), true);
    assert.equal((await listJobs(cpbRoot, { dataRoot })).find((job: Record<string, any>) => job.jobId === jobId)?.status, "failed");
    assert.equal(await readLease(cpbRoot, leaseId, { dataRoot }), null);
    await assertMissing(path.join(dataRoot, "leases", `${orphanLeaseId}.json`));

    const cleanup = await cleanupJobs(cpbRoot, { hubRoot });
    assert.equal(typeof cleanup.cleaned, "number");
    await assert.rejects(() => stat(path.join(cpbRoot, "cpb-task")), { code: "ENOENT" });
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  }
});
