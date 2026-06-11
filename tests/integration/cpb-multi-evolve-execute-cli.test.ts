import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadBacklog, pushIssues } from "../../server/services/evolve/evolve.js";

const execFileAsync = promisify(execFile);

type ExecFileRejection = {
  code?: number;
  stderr?: string;
};

function envFor(hubRoot, cpbRoot) {
  return { ...process.env, CPB_HUB_ROOT: hubRoot, CPB_ROOT: cpbRoot };
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

test("cpb evolve-multi --once dispatches one issue and completes it with blocked workflow", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-exec-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-exec-root-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-exec-project-"));
  const projectName = `exec-${Date.now().toString(36)}`;
  const executorRoot = process.cwd();
  const runtimeRoot = path.join(hubRoot, "projects", projectName);
  const wikiDir = path.join(runtimeRoot, "wiki");
  const eventsDir = path.join(runtimeRoot, "events", projectName);

  try {
    const attach = await execFileAsync("./cpb", ["attach", projectRoot, projectName], {
      cwd: executorRoot,
      env: envFor(hubRoot, cpbRoot),
    });
    const attached = JSON.parse(attach.stdout);

    await pushIssues(attached.project.sourcePath, projectName, [
      { id: "issue-1", priority: "P1", description: "safe blocked workflow dispatch" },
    ], { projectRuntimeRoot: attached.project.projectRuntimeRoot });

    const { stdout } = await execFileAsync("./cpb", [
      "evolve-multi",
      "--once",
      "--project", projectName,
      "--workflow", "blocked",
    ], {
      cwd: executorRoot,
      env: envFor(hubRoot, cpbRoot),
    });
    const result = JSON.parse(stdout);

    assert.equal(result.result.ok, true);
    assert.equal(result.next.project, projectName);

    const backlog = await loadBacklog(attached.project.sourcePath, projectName, {
      projectRuntimeRoot: attached.project.projectRuntimeRoot,
    });
    assert.equal(backlog.length, 1);
    assert.equal(backlog[0].status, "completed");
    await access(eventsDir);
    assert.equal(await pathExists(path.join(runtimeRoot, "evolve", projectName, "backlog.json")), true);
    assert.equal(await pathExists(path.join(projectRoot, "cpb-task", "evolve")), false);
  } finally {
    await rm(wikiDir, { recursive: true, force: true });
    await rm(eventsDir, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("cpb evolve-multi without --once stays dry-run and leaves backlog pending", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-no-once-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-no-once-root-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-no-once-project-"));
  const projectName = `no-once-${Date.now().toString(36)}`;
  const executorRoot = process.cwd();

  const attach = await execFileAsync("./cpb", ["attach", projectRoot, projectName], {
    cwd: executorRoot,
    env: envFor(hubRoot, cpbRoot),
  });
  const attached = JSON.parse(attach.stdout);
  await pushIssues(attached.project.sourcePath, projectName, [
    { id: "issue-1", priority: "P1", description: "do not execute without once" },
  ], { projectRuntimeRoot: attached.project.projectRuntimeRoot });

  const { stdout } = await execFileAsync("./cpb", ["evolve-multi", "--project", projectName, "--workflow", "blocked"], {
    cwd: executorRoot,
    env: envFor(hubRoot, cpbRoot),
  });
  const result = JSON.parse(stdout);

  assert.equal(result.dryRun, true);
  const backlog = await loadBacklog(attached.project.sourcePath, projectName, {
    projectRuntimeRoot: attached.project.projectRuntimeRoot,
  });
  assert.equal(backlog[0].status, "pending");
  assert.equal(await pathExists(path.join(attached.project.projectRuntimeRoot, "evolve", projectName, "backlog.json")), true);
  assert.equal(await pathExists(path.join(projectRoot, "cpb-task", "evolve")), false);
});

test("multi-evolve state requires explicit project runtime root", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-state-source-"));
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-state-runtime-"));
  const projectName = `state-${Date.now().toString(36)}`;

  try {
    await assert.rejects(
      () => pushIssues(projectRoot, projectName, [
        { id: "issue-1", priority: "P1", description: "missing root must fail" },
      ]),
      /projectRuntimeRoot or dataRoot is required for evolve state/,
    );

    await pushIssues(projectRoot, projectName, [
      { id: "issue-1", priority: "P1", description: "runtime root write" },
    ], { dataRoot: runtimeRoot });

    const backlog = await loadBacklog(projectRoot, projectName, { dataRoot: runtimeRoot });
    assert.equal(backlog.length, 1);
    assert.equal(await pathExists(path.join(runtimeRoot, "evolve", projectName, "backlog.json")), true);
    assert.equal(await pathExists(path.join(projectRoot, "cpb-task", "evolve")), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("multi-evolve state resolves project runtime root from hub registry", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-state-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-state-cpb-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-state-project-"));
  const projectName = `registry-${Date.now().toString(36)}`;

  try {
    const attach = await execFileAsync("./cpb", ["attach", projectRoot, projectName], {
      cwd: process.cwd(),
      env: envFor(hubRoot, cpbRoot),
    });
    const attached = JSON.parse(attach.stdout);

    await pushIssues(projectRoot, projectName, [
      { id: "issue-1", priority: "P1", description: "registry root write" },
    ], { hubRoot });

    const backlog = await loadBacklog(projectRoot, projectName, { hubRoot });
    assert.equal(backlog.length, 1);
    assert.equal(await pathExists(path.join(attached.project.projectRuntimeRoot, "evolve", projectName, "backlog.json")), true);
    assert.equal(await pathExists(path.join(projectRoot, "cpb-task", "evolve")), false);
  } finally {
    await rm(hubRoot, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("cpb evolve-multi rejects invalid workflow names", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-bad-workflow-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-bad-workflow-root-"));

  await assert.rejects(
    () => execFileAsync("./cpb", ["evolve-multi", "--workflow", "surprise"], {
      cwd: process.cwd(),
      env: envFor(hubRoot, cpbRoot),
    }),
    (error) => {
      const execError = error as ExecFileRejection;
      assert.equal(execError.code, 1);
      assert.match(execError.stderr ?? "", /invalid workflow: surprise/);
      return true;
    },
  );
});

test("cpb evolve-multi rejects missing workflow value under --once", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-missing-workflow-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-missing-workflow-root-"));

  await assert.rejects(
    () => execFileAsync("./cpb", ["evolve-multi", "--once", "--project", "__unlikely_project__", "--workflow"], {
      cwd: process.cwd(),
      env: envFor(hubRoot, cpbRoot),
    }),
    (error) => {
      const execError = error as ExecFileRejection;
      assert.equal(execError.code, 1);
      assert.match(execError.stderr ?? "", /missing value for --workflow/);
      return true;
    },
  );
});

test("cpb evolve-multi rejects missing project value under --once", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-missing-project-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-missing-project-root-"));

  await assert.rejects(
    () => execFileAsync("./cpb", ["evolve-multi", "--once", "--project"], {
      cwd: process.cwd(),
      env: envFor(hubRoot, cpbRoot),
    }),
    (error) => {
      const execError = error as ExecFileRejection;
      assert.equal(execError.code, 1);
      assert.match(execError.stderr ?? "", /missing value for --project/);
      return true;
    },
  );
});
