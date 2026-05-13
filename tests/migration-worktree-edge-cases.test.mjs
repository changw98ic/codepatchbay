#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, eventFileFor } from "../server/services/event-store.js";
import { acquireLease, readLease } from "../server/services/lease-manager.js";
import { projectPipelineState } from "../server/services/job-projection.js";
import { runtimeDataRoot } from "../server/services/runtime-root.js";
import { spawnFile } from "./helpers/spawn-file.mjs";

const manager = path.resolve("bridges/worktree-manager.mjs");

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

async function runManager(args) {
  return await spawnFile(process.execPath, [manager, ...args], {
    cwd: process.cwd(),
  });
}

async function mustGit(args, cwd) {
  const result = await spawnFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  assert.equal(result.code, 0, `git ${args.join(" ")} failed\n${result.stderr}`);
  return result;
}

// ─── Migration edge cases ─────────────────────────────────────────

describe("Migration edge cases", () => {
  it("re-running event append and lease acquire is idempotent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flow-idempotent-"));
    try {
      const project = "idempotency-test";
      const jobId = "job-idem-001";

      await appendEvent(root, project, jobId, {
        type: "job_created", jobId, project, task: "Idempotency check",
        ts: "2026-05-14T10:00:00.000Z",
      });
      await acquireLease(root, {
        leaseId: "lease-idem-001", jobId, phase: "plan", ttlMs: 60_000,
        now: new Date("2026-05-14T10:00:01.000Z"),
      });

      const eventPath = eventFileFor(root, project, jobId);
      const eventsFirst = await readFile(eventPath, "utf8");

      await appendEvent(root, project, jobId, {
        type: "phase_started", jobId, project, phase: "plan", attempt: 1,
        leaseId: "lease-idem-001", ts: "2026-05-14T10:00:02.000Z",
      });
      await acquireLease(root, {
        leaseId: "lease-idem-002", jobId, phase: "execute", ttlMs: 60_000,
        now: new Date("2026-05-14T10:00:03.000Z"),
      });

      const eventsSecond = await readFile(eventPath, "utf8");
      assert.ok(eventsSecond.startsWith(eventsFirst), "re-run should append, not overwrite");
      assert.equal(eventsSecond.split("\n").filter(Boolean).length, 2);
      assert.notEqual(await readLease(root, "lease-idem-001"), null);
      assert.notEqual(await readLease(root, "lease-idem-002"), null);
      assert.equal(await exists(path.join(root, ".omc")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("partial migration coexists with pre-existing files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flow-partial-"));
    try {
      const project = "partial-test";
      const jobId = "job-partial-001";

      const eventsDir = path.join(runtimeDataRoot(root), "events", project);
      await mkdir(eventsDir, { recursive: true });
      await writeFile(path.join(eventsDir, "stale-job.jsonl"), '{"type":"job_created"}\n', "utf8");

      await appendEvent(root, project, jobId, {
        type: "job_created", jobId, project, task: "Partial migration",
        ts: "2026-05-14T11:00:00.000Z",
      });

      assert.equal(await exists(path.join(eventsDir, "stale-job.jsonl")), true);
      assert.equal(await exists(path.join(eventsDir, `${jobId}.jsonl`)), true);

      const state = await projectPipelineState(root, project);
      assert.equal(state.project, project);
      assert.equal(state.jobId, jobId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stale conflicting lease file is overwritten by acquireLease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flow-conflict-"));
    try {
      const project = "conflict-test";
      const jobId = "job-conflict-001";

      const leaseDir = path.join(runtimeDataRoot(root), "leases");
      await mkdir(leaseDir, { recursive: true });

      const conflictPath = path.join(leaseDir, "lease-conflict-001.json");
      await writeFile(conflictPath, JSON.stringify({
        leaseId: "lease-conflict-001",
        jobId: "old-stale-job",
        phase: "verify",
        expiresAt: "2020-01-01T00:00:00.000Z",
      }), "utf8");

      await acquireLease(root, {
        leaseId: "lease-conflict-001", jobId, phase: "plan", ttlMs: 60_000,
        now: new Date("2026-05-14T12:00:00.000Z"),
      });

      const lease = await readLease(root, "lease-conflict-001");
      assert.equal(lease.jobId, jobId);
      assert.equal(lease.phase, "plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ─── Worktree edge cases ──────────────────────────────────────────

describe("Worktree edge cases", () => {
  it("path traversal in jobId is rejected", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "flow-wt-traversal-"));
    await writeFile(path.join(project, "README.md"), "# Traversal\n", "utf8");
    await runManager(["bootstrap", "--project", project]);
    const worktreesRoot = await mkdtemp(path.join(tmpdir(), "flow-wt-traversal-root-"));

    try {
      for (const badId of ["../bad", "../../etc/passwd", "a/b/c"]) {
        const result = await runManager([
          "create", "--project", project, "--job-id", badId,
          "--slug", "demo", "--worktrees-root", worktreesRoot,
        ]);
        assert.notEqual(result.code, 0, `expected rejection for jobId="${badId}"`);
        assert.match(result.stderr, /invalid job-id/i);
      }
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(worktreesRoot, { recursive: true, force: true });
    }
  });

  it("duplicate worktree (same jobId + slug) is idempotent", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "flow-wt-dup-"));
    await writeFile(path.join(project, "README.md"), "# Dup\n", "utf8");
    await runManager(["bootstrap", "--project", project]);
    const worktreesRoot = await mkdtemp(path.join(tmpdir(), "flow-wt-dup-root-"));

    try {
      const first = await runManager([
        "create", "--project", project, "--job-id", "job-dup",
        "--slug", "dup", "--worktrees-root", worktreesRoot,
      ]);
      assert.equal(first.code, 0, `first create failed\nstderr:\n${first.stderr}`);

      const second = await runManager([
        "create", "--project", project, "--job-id", "job-dup",
        "--slug", "dup", "--worktrees-root", worktreesRoot,
      ]);
      assert.equal(second.code, 0, `duplicate create failed\nstderr:\n${second.stderr}`);
      assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(worktreesRoot, { recursive: true, force: true });
    }
  });

  it("git worktree remove on non-existent path fails gracefully", async () => {
    const result = await spawnFile("git", [
      "worktree", "remove", "/tmp/no-such-worktree-flow-test",
    ]);
    assert.notEqual(result.code, 0, "expected git worktree remove to fail on non-existent path");
  });

  it("createWorktree on plain directory auto-inits git", async () => {
    const nonGitDir = await mkdtemp(path.join(tmpdir(), "flow-wt-nongit-"));
    await writeFile(path.join(nonGitDir, "README.md"), "# Not Git\n", "utf8");
    const worktreesRoot = await mkdtemp(path.join(tmpdir(), "flow-wt-nongit-root-"));

    try {
      const result = await runManager([
        "create", "--project", nonGitDir, "--job-id", "job-nongit",
        "--slug", "test", "--worktrees-root", worktreesRoot,
      ]);
      assert.equal(result.code, 0, `auto-init should succeed\nstderr:\n${result.stderr}`);
      const created = JSON.parse(result.stdout);
      assert.equal(await readFile(path.join(created.path, "README.md"), "utf8"), "# Not Git\n");
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
      await rm(worktreesRoot, { recursive: true, force: true });
    }
  });
});
