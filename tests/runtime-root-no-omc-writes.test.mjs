#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, eventFileFor } from "../server/services/event-store.js";
import { acquireLease, readLease } from "../server/services/lease-manager.js";

const repoRoot = path.resolve(".");

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

const root = await mkdtemp(path.join(tmpdir(), "flow-runtime-root-"));
const project = "demo";
const jobId = "job-20260513-120000-abc123";

await appendEvent(root, project, jobId, {
  type: "job_created",
  jobId,
  project,
  task: "Migrate runtime root",
  ts: "2026-05-13T12:00:00.000Z",
});

const eventFile = eventFileFor(root, project, jobId);
assert.equal(
  eventFile,
  path.join(root, "flow-task", "events", project, `${jobId}.jsonl`)
);
assert.equal(await exists(path.join(root, ".omc", "events")), false);

await acquireLease(root, {
  leaseId: "lease-job-20260513-plan",
  jobId,
  phase: "plan",
  ttlMs: 60_000,
  now: new Date("2026-05-13T12:00:00.000Z"),
});

assert.notEqual(await readLease(root, "lease-job-20260513-plan"), null);
assert.equal(await exists(path.join(root, "flow-task", "leases", "lease-job-20260513-plan.json")), true);
assert.equal(await exists(path.join(root, ".omc", "leases")), false);

await mkdir(path.join(root, "wiki", "projects", project), { recursive: true });
await mkdir(path.join(root, "bridges"), { recursive: true });
await symlink(
  path.join(repoRoot, "bridges", "json-helper.mjs"),
  path.join(root, "bridges", "json-helper.mjs")
);
execFileSync(
  "bash",
  [
    "-lc",
    `export FLOW_ROOT=${JSON.stringify(root)}; source ${JSON.stringify(path.join(repoRoot, "bridges", "common.sh"))}; state_init demo "task" 3; state_write demo "'phase'" "'execute'"`,
  ],
  { cwd: repoRoot }
);

const stateFile = path.join(root, "flow-task", "state", "pipeline-demo.json");
assert.equal(await exists(stateFile), true);
assert.equal(await exists(path.join(root, ".omc", "state")), false);
assert.match(await readFile(stateFile, "utf8"), /"phase": "execute"/);

const { bootstrap } = await import("../bridges/worktree-manager.mjs");
const projectDir = path.join(root, "source");
await bootstrap(projectDir);
const gitignore = await readFile(path.join(projectDir, ".gitignore"), "utf8");
assert.match(gitignore, /flow-task\/state\//);
assert.match(gitignore, /flow-task\/worktrees\//);
assert.doesNotMatch(gitignore, /\.omc\/state\//);
assert.doesNotMatch(gitignore, /\.omc\/worktrees\//);
