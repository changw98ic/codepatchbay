import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { MultiEvolveController } from "../bridges/multi-evolve.mjs";
import { registerProject } from "../server/services/hub-registry.js";
import { loadBacklog, pushIssues } from "../server/services/multi-evolve-state.js";

const execFileAsync = promisify(execFile);

async function initGitRepo() {
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-guarded-project-"));
  await execFileAsync("git", ["init"], { cwd: sourcePath });
  await writeFile(path.join(sourcePath, "README.md"), "demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: sourcePath });
  await execFileAsync("git", ["-c", "user.email=cpb@example.invalid", "-c", "user.name=CPB Test", "commit", "-m", "init"], {
    cwd: sourcePath,
  });
  return sourcePath;
}

test("guarded repair blocks high-risk pending issues before execution", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-guarded-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-guarded-cpb-"));
  const sourcePath = await initGitRepo();
  const project = await registerProject(hubRoot, { name: "guarded-risk", sourcePath });
  await pushIssues(sourcePath, project.id, [
    { id: "risky", priority: "P1", description: "change auth token storage" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  let executed = false;
  controller.executeIssue = async () => {
    executed = true;
    return { ok: true, code: 0 };
  };

  const result = await controller.runOnce({
    project: project.id,
    guardedRepair: true,
    policy: { allowProjects: [project.id] },
  });

  assert.equal(result.blocked, true);
  assert.match(result.reason, /P1|auth/);
  assert.equal(executed, false);
  const backlog = await loadBacklog(sourcePath, project.id);
  assert.equal(backlog[0].status, "blocked");
  assert.match(backlog[0].detail.blockedReason, /P1|auth/);
});

test("guarded repair allows allowlisted low-risk clean projects", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-guarded-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-guarded-cpb-"));
  const sourcePath = await initGitRepo();
  const project = await registerProject(hubRoot, { name: "guarded-safe", sourcePath });
  await pushIssues(sourcePath, project.id, [
    { id: "safe", priority: "P2", description: "tighten button spacing" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  controller.executeIssue = async () => ({ ok: true, code: 0 });

  const result = await controller.runOnce({
    project: project.id,
    guardedRepair: true,
    policy: { allowProjects: [project.id] },
  });

  assert.equal(result.result.ok, true);
  assert.equal(result.budget.repairsStarted, 1);
  const backlog = await loadBacklog(sourcePath, project.id);
  assert.equal(backlog[0].status, "completed");
});

test("guarded repair records budget exhaustion as a stop reason", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-guarded-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-guarded-cpb-"));
  const sourcePath = await initGitRepo();
  const project = await registerProject(hubRoot, { name: "guarded-budget", sourcePath });
  await pushIssues(sourcePath, project.id, [
    { id: "one", priority: "P2", description: "first safe cleanup" },
    { id: "two", priority: "P2", description: "second safe cleanup" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  controller.executeIssue = async () => ({ ok: true, code: 0 });

  const result = await controller.runContinuous({
    project: project.id,
    execute: true,
    guardedRepair: true,
    maxRounds: 2,
    intervalMs: 0,
    policy: { allowProjects: [project.id], maxRepairsPerRun: 1 },
  });

  assert.equal(result.issuesExecuted, 1);
  assert.equal(result.repairsBlocked, 1);
  assert.equal(result.stopReason, "repair budget exhausted");
  assert.match(
    await readFile(path.join(sourcePath, "cpb-task", "evolve", project.id, "history.jsonl"), "utf8"),
    /guarded_repair_blocked/,
  );
});
