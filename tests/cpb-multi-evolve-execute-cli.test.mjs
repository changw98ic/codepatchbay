import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadBacklog, pushIssues } from "../server/services/multi-evolve-state.js";

const execFileAsync = promisify(execFile);

function envFor(hubRoot) {
  return { ...process.env, CPB_HUB_ROOT: hubRoot };
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
      env: envFor(hubRoot),
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
      env: envFor(hubRoot),
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
    env: envFor(hubRoot),
  });
  const attached = JSON.parse(attach.stdout);
  await pushIssues(attached.project.sourcePath, projectName, [
    { id: "issue-1", priority: "P1", description: "do not execute without once" },
  ]);

  const { stdout } = await execFileAsync("./cpb", ["evolve-multi", "--project", projectName, "--workflow", "blocked"], {
    cwd: workspaceRoot,
    env: envFor(hubRoot),
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
      env: envFor(hubRoot),
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /invalid workflow: surprise/);
      return true;
    },
  );
});

test("cpb evolve-multi rejects missing workflow value under --once", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-missing-workflow-hub-"));

  await assert.rejects(
    () => execFileAsync("./cpb", ["evolve-multi", "--once", "--project", "__unlikely_project__", "--workflow"], {
      cwd: process.cwd(),
      env: envFor(hubRoot),
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
      env: envFor(hubRoot),
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /missing value for --project/);
      return true;
    },
  );
});
