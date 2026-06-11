import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, describe } from "node:test";
import { tempRoot, writeJson } from "./helpers.js";
import {
  buildWorktreeRetentionPlan,
  cleanupWorktrees,
  formatWorktreeRetentionHuman,
} from "../server/services/worktree-retention.js";

const INDEX_VERSION = 1;

async function setupJobsIndex(root, jobs) {
  const index = {
    _meta: { version: INDEX_VERSION, updatedAt: new Date().toISOString(), jobCount: jobs.length },
    jobs: {},
  };
  for (const job of jobs) {
    const key = `${job.project}/${job.jobId}`;
    index.jobs[key] = {
      jobId: job.jobId,
      project: job.project,
      task: job.task || "test task",
      status: job.status,
      phase: job.phase || null,
      worktree: job.worktree || null,
      worktreeBranch: job.worktreeBranch || null,
      worktreeBaseBranch: job.worktreeBaseBranch || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  const indexPath = path.join(root, "cpb-task", "jobs-index.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeJson(indexPath, index);
}

describe("worktree-retention: normalizePolicy defaults", () => {
  test("defaults to preserve for completed jobs", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const plan = await buildWorktreeRetentionPlan(root, { dryRun: true });
    assert.equal(plan.policy.completed, "preserve");
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

  test("falls back to preserve for invalid completed policy", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "nuke" },
      dryRun: true,
    });
    assert.equal(plan.policy.completed, "preserve");
  });
});

describe("worktree-retention: completed job worktrees can be archived or deleted", () => {
  test("completed job worktree marked delete when policy is delete", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-del");
    await mkdir(wtPath, { recursive: true });
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-del-001", status: "completed", worktree: wtPath },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
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
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-arch-001", status: "completed", worktree: wtPath },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "archive" },
      dryRun: true,
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
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-keep-001", status: "completed", worktree: wtPath },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, { dryRun: true });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].action, "preserve");
  });
});

describe("worktree-retention: failed and blocked worktrees retained by default", () => {
  test("failed job worktree is preserved regardless of completed policy", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-fail");
    await mkdir(wtPath, { recursive: true });
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-fail-001", status: "failed", worktree: wtPath },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
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
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-block-001", status: "blocked", worktree: wtPath },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
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
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-dry-001", status: "completed", worktree: wt1 },
      { project: "test", jobId: "job-dry-002", status: "failed", worktree: wt2 },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
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
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-safe-001", status: "completed", worktree: wtPath },
    ]);

    await cleanupWorktrees(root, {
      policy: { completed: "delete" },
      dryRun: true,
    });
    const marker = await readFile(path.join(wtPath, "marker.txt"), "utf8");
    assert.equal(marker, "still here", "dry-run must not delete the worktree");
  });

  test("summary counts match entries", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const paths = ["wt-a", "wt-b", "wt-c"].map((s) => path.join(root, "worktrees", s));
    for (const p of paths) await mkdir(p, { recursive: true });
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-sum-001", status: "completed", worktree: paths[0] },
      { project: "test", jobId: "job-sum-002", status: "completed", worktree: paths[1] },
      { project: "test", jobId: "job-sum-003", status: "failed", worktree: paths[2] },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
    });
    assert.equal(plan.summary.total, 3);
    assert.equal(plan.summary.delete, 2);
    assert.equal(plan.summary.preserve, 1);
    assert.equal(plan.summary.archive, 0);
  });
});

describe("worktree-retention: actual cleanup executes", () => {
  test("delete action removes worktree directory", async () => {
    const root = await tempRoot("cpb-wt-ret");
    const wtPath = path.join(root, "worktrees", "wt-del");
    await mkdir(wtPath, { recursive: true });
    await writeFile(path.join(wtPath, "file.txt"), "data", "utf8");
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-del-001", status: "completed", worktree: wtPath },
    ]);

    const result = await cleanupWorktrees(root, {
      policy: { completed: "delete" },
      dryRun: false,
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
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-arch-001", status: "completed", worktree: wtPath },
    ]);

    const result = await cleanupWorktrees(root, {
      policy: { completed: "archive", archiveRoot },
      dryRun: false,
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
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-keep-001", status: "failed", worktree: wtPath },
    ]);

    const result = await cleanupWorktrees(root, {
      policy: { completed: "delete" },
      dryRun: false,
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
    await setupJobsIndex(root, [
      { project: "test", jobId: "job-no-wt-001", status: "completed" },
    ]);

    const plan = await buildWorktreeRetentionPlan(root, {
      policy: { completed: "delete" },
      dryRun: true,
    });
    assert.equal(plan.entries.length, 0);
    assert.equal(plan.summary.total, 0);
  });
});
