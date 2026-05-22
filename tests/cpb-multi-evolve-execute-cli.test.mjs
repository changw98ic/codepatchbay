import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadBacklog, pushIssues } from "../server/services/multi-evolve-state.js";
import { runtimeDataPath } from "../server/services/runtime-root.js";

const execFileAsync = promisify(execFile);

function cleanEnv(overrides = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CPB_")) clean[k] = v;
  }
  return { ...clean, ...overrides };
}

const testCpbRoot = path.resolve(process.cwd());

function eventsDirFor(projectName) {
  return runtimeDataPath(testCpbRoot, "events", projectName);
}

test("cpb evolve-multi --once dispatches one issue and completes it with blocked workflow", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-exec-hub-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-exec-project-"));
  const projectName = `exec-${Date.now().toString(36)}`;
  const workspaceRoot = process.cwd();
  const wikiDir = path.join(workspaceRoot, "wiki", "projects", projectName);
  const eventsDir = path.join(workspaceRoot, "cpb-task", "events", projectName);

  try {
    const attach = await execFileAsync("./cpb", ["attach", projectRoot, projectName], {
      cwd: workspaceRoot,
      env: cleanEnv({ CPB_ROOT: testCpbRoot, CPB_HUB_ROOT: hubRoot }),
    });
    const attached = JSON.parse(attach.stdout);

    await pushIssues(attached.project.sourcePath, projectName, [
      { id: "issue-1", priority: "P1", description: "safe blocked workflow dispatch" },
    ]);

    const { stdout } = await execFileAsync("./cpb", [
      "evolve-multi",
      "--once",
      "--project", projectName,
      "--workflow", "blocked",
    ], {
      cwd: workspaceRoot,
      env: cleanEnv({ CPB_ROOT: testCpbRoot, CPB_HUB_ROOT: hubRoot }),
    });
    const result = JSON.parse(stdout);

    assert.equal(result.result.ok, true);
    assert.equal(result.next.project, projectName);

    const backlog = await loadBacklog(attached.project.sourcePath, projectName);
    assert.equal(backlog.length, 1);
    assert.equal(backlog[0].status, "completed");
    await access(eventsDir);
  } finally {
    await rm(wikiDir, { recursive: true, force: true });
    await rm(eventsDir, { recursive: true, force: true });
  }
});

test("cpb evolve-multi without --once stays dry-run and leaves backlog pending", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-no-once-hub-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-no-once-project-"));
  const projectName = `no-once-${Date.now().toString(36)}`;
  const workspaceRoot = process.cwd();

  const attach = await execFileAsync("./cpb", ["attach", projectRoot, projectName], {
    cwd: workspaceRoot,
    env: cleanEnv({ CPB_ROOT: testCpbRoot, CPB_HUB_ROOT: hubRoot }),
  });
  const attached = JSON.parse(attach.stdout);
  await pushIssues(attached.project.sourcePath, projectName, [
    { id: "issue-1", priority: "P1", description: "do not execute without once" },
  ]);

  const { stdout } = await execFileAsync("./cpb", ["evolve-multi", "--project", projectName, "--workflow", "blocked"], {
    cwd: workspaceRoot,
    env: cleanEnv({ CPB_ROOT: testCpbRoot, CPB_HUB_ROOT: hubRoot }),
  });
  const result = JSON.parse(stdout);

  assert.equal(result.dryRun, true);
  const backlog = await loadBacklog(attached.project.sourcePath, projectName);
  assert.equal(backlog[0].status, "pending");
});

test("cpb evolve-multi rejects invalid workflow names", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-bad-workflow-hub-"));

  await assert.rejects(
    () => execFileAsync("./cpb", ["evolve-multi", "--workflow", "surprise"], {
      cwd: process.cwd(),
      env: cleanEnv({ CPB_ROOT: testCpbRoot, CPB_HUB_ROOT: hubRoot }),
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /invalid workflow: surprise/);
      return true;
    },
  );
});

test("cpb evolve-multi accepts accelerated workflow in dry-run mode", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-accelerated-workflow-hub-"));

  const { stdout } = await execFileAsync("./cpb", ["evolve-multi", "--workflow", "accelerated"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });
  const result = JSON.parse(stdout);

  assert.equal(result.dryRun, true);
  assert.ok(Array.isArray(result.candidates));
});

test("cpb evolve-multi rejects missing workflow value under --once", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-missing-workflow-hub-"));

  await assert.rejects(
    () => execFileAsync("./cpb", ["evolve-multi", "--once", "--project", "__unlikely_project__", "--workflow"], {
      cwd: process.cwd(),
      env: cleanEnv({ CPB_ROOT: testCpbRoot, CPB_HUB_ROOT: hubRoot }),
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /missing value for --workflow/);
      return true;
    },
  );
});

test("cpb evolve-multi rejects missing project value under --once", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-missing-project-hub-"));

  await assert.rejects(
    () => execFileAsync("./cpb", ["evolve-multi", "--once", "--project"], {
      cwd: process.cwd(),
      env: cleanEnv({ CPB_ROOT: testCpbRoot, CPB_HUB_ROOT: hubRoot }),
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /missing value for --project/);
      return true;
    },
  );
});

// Focused replacement: exercises the blocked workflow path via run-pipeline
// directly, bypassing the multi-evolve/worker layer that requires live agents.
test("run-pipeline --workflow blocked creates a blocked job without live agents", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-blocked-wf-hub-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-blocked-wf-project-"));
  const projectName = `blocked-${Date.now().toString(36)}`;
  const workspaceRoot = process.cwd();
  const eventsDir = eventsDirFor(projectName);

  try {
    const attach = await execFileAsync("./cpb", ["attach", projectRoot, projectName], {
      cwd: workspaceRoot,
      env: cleanEnv({ CPB_ROOT: testCpbRoot, CPB_HUB_ROOT: hubRoot }),
    });
    const attached = JSON.parse(attach.stdout);

    // run-pipeline outputs log lines to stdout and returns exit code 0 on success
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      path.join(workspaceRoot, "bridges", "run-pipeline.mjs"),
      "--project", projectName,
      "--task", "blocked workflow unit test",
      "--source-path", attached.project.sourcePath,
      "--workflow", "blocked",
    ], {
      cwd: workspaceRoot,
      env: cleanEnv({ CPB_ROOT: testCpbRoot, CPB_HUB_ROOT: hubRoot }),
    });

    // Blocked workflow should succeed (exit 0)
    assert.ok(stdout.includes("blocked"), `expected 'blocked' in stdout, got: ${stdout.slice(-200)}`);

    // Events must exist for the project
    await access(eventsDir);

    // Verify the blocked job exists
    const { listJobs } = await import("../server/services/job-store.js");
    const jobs = await listJobs(testCpbRoot, { project: projectName });
    assert.ok(jobs.length >= 1, "blocked workflow should create at least one job");
    const blockedJob = jobs.find((j) => j.status === "blocked");
    assert.ok(blockedJob, `expected a blocked job, got statuses: ${jobs.map((j) => j.status).join(", ")}`);
  } finally {
    await rm(path.join(workspaceRoot, "wiki", "projects", projectName), { recursive: true, force: true });
    await rm(eventsDir, { recursive: true, force: true });
  }
});
