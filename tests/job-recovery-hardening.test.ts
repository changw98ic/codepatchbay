import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, describe } from "node:test";
import { tempRoot, writeJson } from "./helpers.js";
import {
  buildWorktreeRetentionPlan,
  cleanupWorktrees,
  formatWorktreeRetentionHuman,
  resolveRetentionPolicy,
} from "../server/services/cleanup/cleanup.js";
import { pinSessionToJob } from "../core/engine/session-pin.js";

const INDEX_VERSION = 1;

async function setupJobsIndex(root, jobs) {
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "source");
  const dataRoot = path.join(hubRoot, "projects", "test");
  await mkdir(sourcePath, { recursive: true });
  await writeJson(path.join(hubRoot, "projects.json"), {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {
      test: {
        id: "test",
        name: "test",
        sourcePath,
        projectRuntimeRoot: dataRoot,
        enabled: true,
      },
    },
  });
  const index = {
    _meta: { version: INDEX_VERSION, updatedAt: new Date().toISOString(), jobCount: jobs.length },
    jobs: {},
  };
  for (const job of jobs) {
    const key = `${job.project}/${job.jobId}`;
    const ts = new Date().toISOString();
    index.jobs[key] = {
      jobId: job.jobId,
      project: job.project,
      task: job.task || "test task",
      workflow: job.workflow || "standard",
      status: job.status,
      phase: job.phase || null,
      worktree: job.worktree || null,
      worktreeBranch: job.worktreeBranch || null,
      worktreeBaseBranch: job.worktreeBaseBranch || null,
      createdAt: ts,
      updatedAt: ts,
    };
    const events: Record<string, unknown>[] = [
      {
        type: "job_created",
        jobId: job.jobId,
        project: job.project,
        task: job.task || "test task",
        workflow: job.workflow || "standard",
        ts,
      },
    ];
    if (job.worktree) {
      events.push({
        type: "worktree_created",
        jobId: job.jobId,
        project: job.project,
        worktree: job.worktree,
        branch: job.worktreeBranch || null,
        baseBranch: job.worktreeBaseBranch || null,
        ts,
      });
    }
    if (job.status === "completed") {
      events.push({ type: "job_completed", jobId: job.jobId, project: job.project, ts });
    } else if (job.status === "failed") {
      events.push({ type: "job_failed", jobId: job.jobId, project: job.project, reason: "test failure", ts });
    } else if (job.status === "blocked") {
      events.push({ type: "job_blocked", jobId: job.jobId, project: job.project, reason: "test blocked", ts });
    }
    const eventPath = path.join(dataRoot, "events", job.project, `${job.jobId}.jsonl`);
    await mkdir(path.dirname(eventPath), { recursive: true });
    await writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  }
  const indexPath = path.join(dataRoot, "jobs-index.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeJson(indexPath, index);
  return { hubRoot, dataRoot };
}

describe("worktree-retention: normalizePolicy defaults", () => {
  test("defaults to null (workflow-aware) when no policy specified", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const plan = await buildWorktreeRetentionPlan(root, { dryRun: true });
    assert.equal(plan.policy.completed, null);
  });

  test("respects completed: delete policy", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
    });
    assert.equal(plan.policy.completed, "delete");
  });

  test("respects completed: archive policy", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "archive" },
      dryRun: true,
    });
    assert.equal(plan.policy.completed, "archive");
  });

  test("falls back to null (workflow-aware) for invalid completed policy", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "nuke" },
      dryRun: true,
    });
    assert.equal(plan.policy.completed, null);
  });
});

describe("worktree-retention: completed job worktrees can be archived or deleted", () => {
  test("completed job worktree marked delete when policy is delete", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-del");
    await mkdir(wtPath, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-del-001", status: "completed", worktree: wtPath },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
      hubRoot,
    });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].action, "delete");
    assert.equal(plan.entries[0].worktree, wtPath);
    assert.ok(plan.entries[0].reason.includes("delete"));
  });

  test("completed job worktree marked archive when policy is archive", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-arch");
    await mkdir(wtPath, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-arch-001", status: "completed", worktree: wtPath },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "archive" },
      dryRun: true,
      hubRoot,
    });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].action, "archive");
    assert.ok(plan.entries[0].archivePath);
    assert.ok(plan.entries[0].reason.includes("archive"));
  });

  test("completed job worktree preserved by default", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-keep");
    await mkdir(wtPath, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-keep-001", status: "completed", worktree: wtPath },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, { dryRun: true, hubRoot });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].action, "preserve");
  });
});

describe("worktree-retention: failed and blocked worktrees retained by default", () => {
  test("failed job worktree is preserved regardless of completed policy", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-fail");
    await mkdir(wtPath, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-fail-001", status: "failed", worktree: wtPath },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
      hubRoot,
    });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].action, "preserve");
    assert.ok(plan.entries[0].reason.includes("failed"));
    assert.ok(plan.entries[0].reason.includes("retained"));
  });

  test("blocked job worktree is preserved regardless of completed policy", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-block");
    await mkdir(wtPath, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-block-001", status: "blocked", worktree: wtPath },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
      hubRoot,
    });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].action, "preserve");
    assert.ok(plan.entries[0].reason.includes("blocked"));
    assert.ok(plan.entries[0].reason.includes("retained"));
  });
});

describe("worktree-retention: dry-run lists exact paths and reasons", () => {
  test("dry-run plan includes exact worktree paths and reasons", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wt1 = path.join(root, "worktrees", "wt-alpha");
    const wt2 = path.join(root, "worktrees", "wt-beta");
    await mkdir(wt1, { recursive: true });
    await mkdir(wt2, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-dry-001", status: "completed", worktree: wt1 },
      { project: "test", jobId: "job-dry-002", status: "failed", worktree: wt2 },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
      hubRoot,
    });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.entries.length, 2);
    const paths = plan.entries.map((e) => e.worktree);
    assert.ok(paths.includes(wt1));
    assert.ok(paths.includes(wt2));
    for (const entry of plan.entries) {
      assert.ok(entry.reason, `entry ${entry.jobId} must have a reason`);
      assert.ok(entry.action, `entry ${entry.jobId} must have an action`);
    }
  });

  test("dry-run does not delete or move anything", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-safe");
    await mkdir(wtPath, { recursive: true });
    await writeFile(path.join(wtPath, "marker.txt"), "still here", "utf8");
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-safe-001", status: "completed", worktree: wtPath },
    ]);

    await cleanupWorktrees(root, {
      policy: { completed: "delete" },
      dryRun: true,
      hubRoot,
    });
    const marker = await readFile(path.join(wtPath, "marker.txt"), "utf8");
    assert.equal(marker, "still here", "dry-run must not delete the worktree");
  });

  test("summary counts match entries", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const paths = ["wt-a", "wt-b", "wt-c"].map((s) => path.join(root, "worktrees", s));
    for (const p of paths) await mkdir(p, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-sum-001", status: "completed", worktree: paths[0] },
      { project: "test", jobId: "job-sum-002", status: "completed", worktree: paths[1] },
      { project: "test", jobId: "job-sum-003", status: "failed", worktree: paths[2] },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
      hubRoot,
    });
    assert.equal(plan.summary.total, 3);
    assert.equal(plan.summary.delete, 2);
    assert.equal(plan.summary.preserve, 1);
    assert.equal(plan.summary.archive, 0);
  });
});

describe("worktree-retention: actual cleanup executes", () => {
  test("delete policy preserves a projected worktree outside managed roots", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const outside = path.join(root, "outside", "must-preserve");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "marker.txt"), "preserve", "utf8");
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-outside-001", status: "completed", worktree: outside },
    ]);

    const result = await cleanupWorktrees(root, {
      policy: { completed: "delete" },
      dryRun: false,
      hubRoot,
    });
    const entry = result.entries.find((item) => item.jobId === "job-outside-001");
    assert.equal(entry.action, "preserve");
    assert.equal(entry.result, "preserved");
    assert.match(entry.reason, /outside managed worktree roots/);
    assert.equal(await readFile(path.join(outside, "marker.txt"), "utf8"), "preserve");
  });

  test("delete policy preserves a symlink inside a managed root", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot("cpb-wt-ret");
    const outside = path.join(root, "outside", "symlink-target");
    const link = path.join(root, "worktrees", "linked-worktree");
    await mkdir(outside, { recursive: true });
    await mkdir(path.dirname(link), { recursive: true });
    await writeFile(path.join(outside, "marker.txt"), "preserve", "utf8");
    await symlink(outside, link, "dir");
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-symlink-001", status: "completed", worktree: link },
    ]);

    const result = await cleanupWorktrees(root, {
      policy: { completed: "delete" },
      dryRun: false,
      hubRoot,
    });
    const entry = result.entries.find((item) => item.jobId === "job-symlink-001");
    assert.equal(entry.action, "preserve");
    assert.equal(entry.result, "preserved");
    assert.match(entry.reason, /unsafe managed worktree path/);
    assert.equal(await readFile(path.join(outside, "marker.txt"), "utf8"), "preserve");
  });

  test("delete action removes worktree directory", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-del");
    await mkdir(wtPath, { recursive: true });
    await writeFile(path.join(wtPath, "file.txt"), "data", "utf8");
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-del-001", status: "completed", worktree: wtPath },
    ]);

    const result = await cleanupWorktrees(root, {
      policy: { completed: "delete" },
      dryRun: false,
      hubRoot,
    });
    assert.equal(result.dryRun, false);
    const deletedEntry = result.entries.find((e) => e.jobId === "job-del-001");
    assert.equal(deletedEntry.result, "deleted");
    await assert.rejects(() => readFile(path.join(wtPath, "file.txt")), "worktree directory must be removed");
  });

  test("archive action moves worktree to archive root", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-arch");
    const archiveRoot = path.join(root, "archive");
    await mkdir(wtPath, { recursive: true });
    await writeFile(path.join(wtPath, "file.txt"), "archived data", "utf8");
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-arch-001", status: "completed", worktree: wtPath },
    ]);

    const result = await cleanupWorktrees(root, {
      policy: { completed: "archive", archiveRoot },
      dryRun: false,
      hubRoot,
    });
    const archivedEntry = result.entries.find((e) => e.jobId === "job-arch-001");
    assert.equal(archivedEntry.result, "archived");
    assert.ok(archivedEntry.archivePath.startsWith(archiveRoot));

    await assert.rejects(() => readFile(path.join(wtPath, "file.txt")), "original worktree must be moved");
    const content = await readFile(path.join(archivedEntry.archivePath, "file.txt"), "utf8");
    assert.equal(content, "archived data");
  });

  test("preserve action leaves worktree untouched", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-keep");
    await mkdir(wtPath, { recursive: true });
    await writeFile(path.join(wtPath, "file.txt"), "kept", "utf8");
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-keep-001", status: "failed", worktree: wtPath },
    ]);

    const result = await cleanupWorktrees(root, {
      policy: { completed: "delete" },
      dryRun: false,
      hubRoot,
    });
    const preservedEntry = result.entries.find((e) => e.jobId === "job-keep-001");
    assert.equal(preservedEntry.result, "preserved");
    const content = await readFile(path.join(wtPath, "file.txt"), "utf8");
    assert.equal(content, "kept");
  });
});

describe("worktree-retention: human-readable output", () => {
  test("formatWorktreeRetentionHuman shows dry-run header", () => {
    const plan = {
      dryRun: true,
      entries: [],
      summary: { total: 0, delete: 0, archive: 0, preserve: 0 },
    };
    const output = formatWorktreeRetentionHuman(plan);
    assert.ok(output.includes("dry-run"));
    assert.ok(output.includes("No job worktrees found"));
  });

  test("formatWorktreeRetentionHuman shows each entry with path and reason", () => {
    const plan = {
      dryRun: false,
      entries: [
        {
          jobId: "job-001",
          status: "completed",
          worktree: "/tmp/wt-1",
          action: "delete",
          reason: "completed job worktree selected by policy: delete",
        },
        {
          jobId: "job-002",
          status: "failed",
          worktree: "/tmp/wt-2",
          action: "preserve",
          archivePath: "/archive/wt-2",
          reason: "failed job worktree retained for inspection by default",
        },
      ],
      summary: { total: 2, delete: 1, archive: 0, preserve: 1 },
    };
    const output = formatWorktreeRetentionHuman(plan);
    assert.ok(!output.includes("dry-run"));
    assert.ok(output.includes("DELETE /tmp/wt-1"));
    assert.ok(output.includes("PRESERVE /tmp/wt-2"));
    assert.ok(output.includes("job: job-001"));
    assert.ok(output.includes("reason:"));
  });
});

describe("worktree-retention: jobs without worktrees are skipped", () => {
  test("jobs with no worktree field are excluded from plan", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-no-wt-001", status: "completed" },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
      hubRoot,
    });
    assert.equal(plan.entries.length, 0);
    assert.equal(plan.summary.total, 0);
  });
});

// ── Session Pin ──

describe("session-pin: pinSessionToJob writes sessionPin to process registry", () => {
  test("writes sessionPin into existing process file", async () => {
    const root = await tempRoot("cpb-session-pin");
    const dataRoot = path.join(root, "data");
    const processesDir = path.join(dataRoot, "processes");
    await mkdir(processesDir, { recursive: true });

    const jobId = "job-pin-001";
    const processFilePath = path.join(processesDir, `${jobId}.json`);
    // Simulate a pre-existing process registry entry (created by registerProcess)
    await writeJson(processFilePath, {
      jobId,
      project: "test",
      phase: "execute",
      runnerPid: 1234,
      childPids: [],
      status: "running",
      lastHeartbeat: new Date().toISOString(),
    });

    await pinSessionToJob(root, "test", jobId, {
      phase: "execute",
      sessionId: "sess-abc-123",
      agentPid: 5678,
      dataRoot,
    });

    const updated = JSON.parse(await readFile(processFilePath, "utf8"));
    assert.ok(updated.sessionPin, "process file must contain sessionPin");
    assert.equal(updated.sessionPin.sessionId, "sess-abc-123");
    assert.equal(updated.sessionPin.agentPid, 5678);
    assert.equal(updated.sessionPin.phase, "execute");
    assert.ok(updated.sessionPin.pinnedAt, "sessionPin must have pinnedAt timestamp");
    // Original fields preserved
    assert.equal(updated.jobId, jobId);
    assert.equal(updated.status, "running");
  });

  test("is best-effort when process file does not exist", async () => {
    const root = await tempRoot("cpb-session-pin");
    const dataRoot = path.join(root, "data");

    // Should not throw
    await pinSessionToJob(root, "test", "job-noexist-999", {
      phase: "execute",
      sessionId: "sess-xyz",
      agentPid: 9999,
      dataRoot,
    });
  });

  test("overwrites sessionPin on repeated calls", async () => {
    const root = await tempRoot("cpb-session-pin");
    const dataRoot = path.join(root, "data");
    const processesDir = path.join(dataRoot, "processes");
    await mkdir(processesDir, { recursive: true });

    const jobId = "job-pin-retry";
    const processFilePath = path.join(processesDir, `${jobId}.json`);
    await writeJson(processFilePath, {
      jobId,
      project: "test",
      phase: "execute",
      runnerPid: 1234,
      childPids: [],
      status: "running",
      lastHeartbeat: new Date().toISOString(),
    });

    await pinSessionToJob(root, "test", jobId, {
      phase: "execute",
      sessionId: "sess-first",
      agentPid: 100,
      dataRoot,
    });
    await pinSessionToJob(root, "test", jobId, {
      phase: "verify",
      sessionId: "sess-second",
      agentPid: 200,
      dataRoot,
    });

    const updated = JSON.parse(await readFile(processFilePath, "utf8"));
    assert.equal(updated.sessionPin.sessionId, "sess-second");
    assert.equal(updated.sessionPin.phase, "verify");
    assert.equal(updated.sessionPin.agentPid, 200);
  });
});

// ── Workflow-aware Retention ──

describe("workflow-retention: resolveRetentionPolicy returns correct action per workflow", () => {
  test("pipeline completed resolves to delete", () => {
    assert.equal(resolveRetentionPolicy("pipeline", "completed"), "delete");
  });

  test("research completed resolves to archive", () => {
    assert.equal(resolveRetentionPolicy("research", "completed"), "archive");
  });

  test("standard completed resolves to preserve", () => {
    assert.equal(resolveRetentionPolicy("standard", "completed"), "preserve");
  });

  test("unknown workflow falls back to default (preserve)", () => {
    assert.equal(resolveRetentionPolicy("nonexistent-workflow", "completed"), "preserve");
  });

  test("null workflow falls back to default", () => {
    assert.equal(resolveRetentionPolicy(null, "completed"), "preserve");
  });

  test("failed status always resolves to preserve", () => {
    assert.equal(resolveRetentionPolicy("pipeline", "failed"), "preserve");
    assert.equal(resolveRetentionPolicy("standard", "failed"), "preserve");
  });
});

describe("workflow-retention: workflow-aware plan entries use workflow policy", () => {
  test("pipeline completed job gets delete action without explicit policy override", async () => {
    const root = await tempRoot("cpb-wf-ret");
    const wtPath = path.join(root, "worktrees", "wt-pipe");
    await mkdir(wtPath, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-pipe-001", status: "completed", worktree: wtPath, workflow: "pipeline" },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, { dryRun: true, hubRoot });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].action, "delete");
    assert.ok(plan.entries[0].reason.includes("pipeline"));
  });

  test("research completed job gets archive action without explicit policy override", async () => {
    const root = await tempRoot("cpb-wf-ret");
    const wtPath = path.join(root, "worktrees", "wt-res");
    await mkdir(wtPath, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-res-001", status: "completed", worktree: wtPath, workflow: "research" },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, { dryRun: true, hubRoot });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].action, "archive");
    assert.ok(plan.entries[0].reason.includes("research"));
  });

  test("standard completed job gets preserve action (default)", async () => {
    const root = await tempRoot("cpb-wf-ret");
    const wtPath = path.join(root, "worktrees", "wt-std");
    await mkdir(wtPath, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-std-001", status: "completed", worktree: wtPath, workflow: "standard" },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, { dryRun: true, hubRoot });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].action, "preserve");
  });

  test("explicit policy:delete overrides workflow default", async () => {
    const root = await tempRoot("cpb-wf-ret");
    const wtPath = path.join(root, "worktrees", "wt-exp");
    await mkdir(wtPath, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-exp-001", status: "completed", worktree: wtPath, workflow: "standard" },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
      hubRoot,
    });
    assert.equal(plan.entries[0].action, "delete");
  });

  test("pipeline failed job is preserved regardless of workflow policy", async () => {
    const root = await tempRoot("cpb-wf-ret");
    const wtPath = path.join(root, "worktrees", "wt-pipe-fail");
    await mkdir(wtPath, { recursive: true });
    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-pipe-fail-001", status: "failed", worktree: wtPath, workflow: "pipeline" },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, { dryRun: true, hubRoot });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].action, "preserve");
  });
});

// ── Orphan Worktree Detection ──

describe("worktree-retention: orphan worktrees detected and cleaned", () => {
  test("orphan worktree directory with no associated job is detected", async () => {
    const root = await tempRoot("cpb-wt-orphan");
    const wtJob = path.join(root, "worktrees", "wt-has-job");
    const wtOrphan = path.join(root, "worktrees", "wt-orphan");
    await mkdir(wtJob, { recursive: true });
    await mkdir(wtOrphan, { recursive: true });

    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-has-001", status: "completed", worktree: wtJob, workflow: "standard" },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, { dryRun: true, hubRoot });
    assert.ok(plan.orphans, "plan must have orphans array");
    assert.equal(plan.orphans.length, 1);
    assert.equal(plan.orphans[0].worktree, wtOrphan);
    assert.equal(plan.orphans[0].action, "delete");
    assert.ok(plan.orphans[0].reason.includes("orphan"));
    assert.equal(plan.summary.orphanCount, 1);
  });

  test("orphan worktree is deleted on actual cleanup", async () => {
    const root = await tempRoot("cpb-wt-orphan");
    const wtJob = path.join(root, "worktrees", "wt-has-job2");
    const wtOrphan = path.join(root, "worktrees", "wt-orphan2");
    await mkdir(wtJob, { recursive: true });
    await mkdir(wtOrphan, { recursive: true });
    await writeFile(path.join(wtOrphan, "stale.txt"), "orphan data", "utf8");

    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-has-002", status: "completed", worktree: wtJob, workflow: "pipeline" },
    ]);

    const result = await cleanupWorktrees(root, {
      policy: { completed: "preserve" },
      dryRun: false,
      hubRoot,
    });

    // The orphan should be deleted
    await assert.rejects(
      () => readFile(path.join(wtOrphan, "stale.txt")),
      "orphan worktree must be deleted",
    );
    // The job-associated worktree should still exist
    const marker = await readFile(path.join(wtJob, "file.txt"), "utf8").catch(() => null);
    // worktree for completed pipeline is preserved by explicit policy
    const jobEntry = result.entries.find((e) => e.jobId === "job-has-002");
    assert.equal(jobEntry.result, "preserved");
  });

  test("no orphans when all worktree dirs have jobs", async () => {
    const root = await tempRoot("cpb-wt-orphan");
    const wt1 = path.join(root, "worktrees", "wt-a");
    const wt2 = path.join(root, "worktrees", "wt-b");
    await mkdir(wt1, { recursive: true });
    await mkdir(wt2, { recursive: true });

    const { hubRoot } = await setupJobsIndex(root, [
      { project: "test", jobId: "job-no-orphan-1", status: "completed", worktree: wt1 },
      { project: "test", jobId: "job-no-orphan-2", status: "failed", worktree: wt2 },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, { dryRun: true, hubRoot });
    assert.equal(plan.orphans.length, 0);
    assert.equal(plan.summary.orphanCount, 0);
  });
});
