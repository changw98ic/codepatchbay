import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MultiEvolveController } from "../bridges/multi-evolve.mjs";
import { registerProject } from "../server/services/hub-registry.js";
import { pushIssues, loadBacklog } from "../server/services/multi-evolve-state.js";

async function cleanGitRepo(dir) {
  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: dir });
  execSync("git config user.email t@t.com", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  await writeFile(path.join(dir, "f.txt"), "init");
  execSync("git add . && git commit -m init", { cwd: dir });
}

test("guarded-repair rejects high-risk issue and records policy block", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-risk-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-risk-cpb-"));
  const src = await mkdtemp(path.join(tmpdir(), "cpb-gr-risk-src-"));
  await cleanGitRepo(src);
  const proj = await registerProject(hubRoot, { name: "risk-proj", sourcePath: src });
  await pushIssues(src, proj.id, [
    { id: "i-secret", priority: "P0", description: "rotate the api_key for auth" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  // Override checkPolicy by using noCleanCheck + safe description won't match
  // But we intentionally have a high-risk description here
  const result = await controller.runGuardedRepair({
    project: proj.id,
    noCleanCheck: true,
  });

  assert.equal(result.mode, "guarded_repair");
  assert.equal(result.issuesExecuted, 0);
  assert.equal(result.policyBlocked, 1);
  assert.equal(result.totalRounds, 1);

  // Issue should be marked policy_blocked (not claimed)
  const backlog = await loadBacklog(src, proj.id);
  assert.equal(backlog[0].status, "policy_blocked");
});

test("guarded-repair executes safe issue on clean worktree", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-ok-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-ok-cpb-"));
  const src = await mkdtemp(path.join(tmpdir(), "cpb-gr-ok-src-"));
  await cleanGitRepo(src);
  const proj = await registerProject(hubRoot, { name: "safe-proj", sourcePath: src });
  await pushIssues(src, proj.id, [
    { id: "i-safe", priority: "P1", description: "fix typo in readme" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  controller.executeIssue = async () => ({ ok: true, code: 0 });

  const result = await controller.runGuardedRepair({ project: proj.id });

  assert.equal(result.mode, "guarded_repair");
  assert.equal(result.issuesExecuted, 1);
  assert.equal(result.policyBlocked, 0);

  const backlog = await loadBacklog(src, proj.id);
  assert.equal(backlog[0].status, "completed");
});

test("guarded-repair rejects dirty worktree when check is enabled", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-dirty-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-dirty-cpb-"));
  const src = await mkdtemp(path.join(tmpdir(), "cpb-gr-dirty-src-"));
  await cleanGitRepo(src);
  // Make worktree dirty
  await writeFile(path.join(src, "dirty.txt"), "uncommitted");
  const proj = await registerProject(hubRoot, { name: "dirty-proj", sourcePath: src });
  await pushIssues(src, proj.id, [
    { id: "i-dirty", priority: "P1", description: "fix typo in docs" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  const result = await controller.runGuardedRepair({ project: proj.id });

  assert.equal(result.issuesExecuted, 0);
  assert.equal(result.policyBlocked, 1);

  const backlog = await loadBacklog(src, proj.id);
  assert.equal(backlog[0].status, "policy_blocked");
});

test("guarded-repair skips dirty worktree check with noCleanCheck", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-nock-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-nock-cpb-"));
  const src = await mkdtemp(path.join(tmpdir(), "cpb-gr-nock-src-"));
  await cleanGitRepo(src);
  await writeFile(path.join(src, "dirty.txt"), "uncommitted");
  const proj = await registerProject(hubRoot, { name: "nock-proj", sourcePath: src });
  await pushIssues(src, proj.id, [
    { id: "i-nock", priority: "P1", description: "fix typo in docs" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  controller.executeIssue = async () => ({ ok: true, code: 0 });

  const result = await controller.runGuardedRepair({ project: proj.id, noCleanCheck: true });

  assert.equal(result.issuesExecuted, 1);
  assert.equal(result.policyBlocked, 0);
});

test("guarded-repair respects maxIssues budget", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-budget-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-budget-cpb-"));
  const src = await mkdtemp(path.join(tmpdir(), "cpb-gr-budget-src-"));
  await cleanGitRepo(src);
  const proj = await registerProject(hubRoot, { name: "budget-proj", sourcePath: src });
  await pushIssues(src, proj.id, [
    { id: "i-b1", priority: "P1", description: "fix issue one" },
    { id: "i-b2", priority: "P1", description: "fix issue two" },
    { id: "i-b3", priority: "P1", description: "fix issue three" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  controller.executeIssue = async () => ({ ok: true, code: 0 });

  const result = await controller.runGuardedRepair({ project: proj.id, noCleanCheck: true, maxIssues: 2 });

  assert.equal(result.issuesExecuted, 2);
  assert.equal(result.policyBlocked, 0);
  assert.equal(result.budget.maxIssues, 2);
  assert.equal(result.budget.used, 2);
  assert.ok(result.budget.stopReason);
});

test("guarded-repair respects project allowlist", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-allow-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-allow-cpb-"));
  const src = await mkdtemp(path.join(tmpdir(), "cpb-gr-allow-src-"));
  await cleanGitRepo(src);
  const proj = await registerProject(hubRoot, { name: "blocked-proj", sourcePath: src });
  await pushIssues(src, proj.id, [
    { id: "i-allow", priority: "P1", description: "fix typo in docs" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  const result = await controller.runGuardedRepair({
    project: proj.id,
    noCleanCheck: true,
    allowlist: ["other-project"],
  });

  assert.equal(result.issuesExecuted, 0);
  assert.equal(result.policyBlocked, 1);
});

test("guarded-repair appends history with guarded_ prefix actions", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-hist-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-gr-hist-cpb-"));
  const src = await mkdtemp(path.join(tmpdir(), "cpb-gr-hist-src-"));
  await cleanGitRepo(src);
  const proj = await registerProject(hubRoot, { name: "hist-proj", sourcePath: src });
  await pushIssues(src, proj.id, [
    { id: "i-hist", priority: "P1", description: "fix typo in readme" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  controller.executeIssue = async () => ({ ok: true, code: 0 });

  await controller.runGuardedRepair({ project: proj.id });

  const historyPath = path.join(src, "cpb-task", "evolve", proj.id, "history.jsonl");
  const raw = await readFile(historyPath, "utf8");
  const entries = raw.trim().split("\n").map((l) => JSON.parse(l));
  const guardedEntries = entries.filter((e) => e.action.startsWith("guarded_"));
  assert.ok(guardedEntries.some((e) => e.action === "guarded_execute"));
});
