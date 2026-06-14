import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { runChecklistProbes } from "../core/workflow/probe-runner.js";

type AnyRecord = Record<string, any>;

const exec = (cmd: string, args: string[], opts: AnyRecord = {}) =>
  new Promise<void>((resolve, reject) => {
    execFile(cmd, args, opts, (err) => (err ? reject(err) : resolve()));
  });

async function makeGitRepo() {
  const dir = path.join(await import("node:os").then((m) => m.tmpdir()), `probe-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  await mkdir(dir, { recursive: true });
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# init\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function staticItem(overrides: AnyRecord = {}) {
  return {
    id: "AC-001",
    requirement: "update README",
    source: "task_text",
    sourceRefs: [{ kind: "task_text", locator: "task:0" }],
    predicateId: "PRED-001",
    required: true,
    area: "docs",
    risk: "low",
    verificationMethod: "static",
    expectedEvidence: "README diff",
    dependsOn: [],
    allowedFiles: ["README.md"],
    ...overrides,
  };
}

function checklist(items: AnyRecord[]) {
  return { schemaVersion: 1, jobId: "job-1", project: "p", status: "frozen", items, assumptions: [] };
}

test("static item with allowedFiles hit by diff yields matchCount > 0 and valid observation", async () => {
  const dir = await makeGitRepo();
  try {
    await writeFile(path.join(dir, "README.md"), "# changed\n", "utf8");
    const checks = await runChecklistProbes(checklist([staticItem()]), dir, {});
    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.verificationMethod, "static");
    assert.match(obs.queryId, /^static-diff-scope:AC-001$/);
    assert.ok(Number.isInteger(obs.matchCount) && obs.matchCount > 0, `matchCount should be > 0, got ${obs.matchCount}`);
    assert.deepEqual(obs.changedFilesInScope, ["README.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("static item with allowedFiles NOT in diff yields matchCount === 0 (honest fail)", async () => {
  const dir = await makeGitRepo();
  try {
    // change a different file than the item declares
    await writeFile(path.join(dir, "OTHER.md"), "x\n", "utf8");
    const checks = await runChecklistProbes(checklist([staticItem()]), dir, {});
    const obs = checks[0].observation;
    assert.equal(obs.matchCount, 0);
    assert.deepEqual(obs.changedFilesInScope, []);
    assert.equal(checks[0].emitFailedClaim, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("static item with empty allowedFiles yields matchCount === 0 (no scope to prove against)", async () => {
  const dir = await makeGitRepo();
  try {
    await writeFile(path.join(dir, "README.md"), "# changed\n", "utf8");
    const checks = await runChecklistProbes(checklist([staticItem({ allowedFiles: [] })]), dir, {});
    assert.equal(checks[0].observation.matchCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-static items are skipped by the runner", async () => {
  const dir = await makeGitRepo();
  try {
    const checks = await runChecklistProbes(checklist([staticItem({ id: "AC-002", verificationMethod: "command" })]), dir, {});
    assert.equal(checks.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("null checklist returns no checks", async () => {
  const dir = await makeGitRepo();
  try {
    const checks = await runChecklistProbes(null, dir, {});
    assert.equal(checks.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
