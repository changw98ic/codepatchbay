import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { AnyRecord } from "../shared/types.js";

import { runChecklistProbes } from "../core/workflow/probe-runner.js";
import { validateEvidenceObservation } from "../core/workflow/evidence-probes.js";


const exec = (cmd: string, args: string[], opts: AnyRecord = {}) =>
  new Promise<void>((resolve, reject) => {
    execFile(cmd, args, opts, (err) => (err ? reject(err) : resolve()));
  });

async function makeGitRepo() {
  const dir = path.join(await import("node:os").then((m) => m.tmpdir()), `probe-ns-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  await mkdir(dir, { recursive: true });
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# init\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function checklist(items: AnyRecord[]) {
  return { schemaVersion: 1, jobId: "job-ns", project: "p", status: "frozen", items, assumptions: [] };
}

function commandItem(overrides: AnyRecord = {}) {
  return {
    id: "AC-CMD",
    requirement: "command succeeds",
    source: "task_text",
    sourceRefs: [{ kind: "task_text", locator: "task:0" }],
    predicateId: "PRED-CMD",
    required: true,
    area: "build",
    risk: "low",
    verificationMethod: "command",
    ...overrides,
  };
}

function runtimeEventItem(overrides: AnyRecord = {}) {
  return {
    id: "AC-EVT",
    requirement: "an event fired",
    source: "task_text",
    sourceRefs: [{ kind: "task_text", locator: "task:0" }],
    predicateId: "PRED-EVT",
    required: true,
    area: "runtime",
    risk: "low",
    verificationMethod: "runtime_event",
    ...overrides,
  };
}

function staticItem(overrides: AnyRecord = {}) {
  return {
    id: "AC-STATIC",
    requirement: "update README",
    source: "task_text",
    sourceRefs: [{ kind: "task_text", locator: "task:0" }],
    predicateId: "PRED-STATIC",
    required: true,
    area: "docs",
    risk: "low",
    verificationMethod: "static",
    expectedEvidence: "README diff",
    allowedFiles: ["README.md"],
    ...overrides,
  };
}

test("command item with a declared succeeding command -> valid claim, exitCode 0, stdoutSha256 present, passes validateEvidenceObservation", async () => {
  const dir = await makeGitRepo();
  try {
    // A command that exits 0 and writes stdout (printf lives in /bin on most systems).
    const item = commandItem({ expectedEvidence: "printf hello" });
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123", diffHash: "sha256:d" } });
    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.verificationMethod, "command");
    assert.equal(obs.command, "printf hello");
    assert.equal(obs.exitCode, 0);
    assert.match(obs.stdoutSha256, /^sha256:[0-9a-f]+$/);
    assert.equal(checks[0].emitFailedClaim, true);

    // The observation must be structurally valid (recordable) AND satisfied (exit 0 + worktreeHead).
    const v = validateEvidenceObservation(obs, item, { attemptId: "" });
    assert.equal(v.valid, true, "command observation should be valid");
    assert.equal(v.satisfied, true, "command observation should satisfy (exit 0 + worktreeHead)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command item whose command exits non-zero -> honest fail claim, result fail, exitCode captured", async () => {
  const dir = await makeGitRepo();
  try {
    const item = commandItem({ expectedEvidence: "sh -c 'exit 7'" });
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123", diffHash: "sha256:d" } });
    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.exitCode, 7, "real non-zero exit code must be captured honestly");
    assert.equal(checks[0].emitFailedClaim, true);

    // valid (recordable) but NOT satisfied (exitCode !== 0).
    const v = validateEvidenceObservation(obs, item, { attemptId: "" });
    assert.equal(v.valid, true, "failed command observation should still be valid (recordable)");
    assert.equal(v.satisfied, false, "non-zero exit must not satisfy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command item with no declared command -> honest fail, never a silent skip", async () => {
  const dir = await makeGitRepo();
  try {
    // No expectedEvidence, no probeCommand.
    const item = commandItem({});
    const checks = await runChecklistProbes(checklist([item]), dir, {});
    assert.equal(checks.length, 1, "must emit a claim, not silently drop");
    const obs = checks[0].observation;
    assert.equal(obs.verificationMethod, "command");
    assert.equal(checks[0].emitFailedClaim, true);
    assert.match(String(obs.note), /declares no runnable command/);
    assert.equal(obs.command, undefined);
    assert.equal(obs.exitCode, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime_event item -> honest fail claim (not silently dropped), ledger-visible", async () => {
  const dir = await makeGitRepo();
  try {
    const item = runtimeEventItem();
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123" } });
    assert.equal(checks.length, 1, "runtime_event must be recorded, not dropped");
    const obs = checks[0].observation;
    assert.equal(obs.verificationMethod, "runtime_event");
    assert.equal(checks[0].emitFailedClaim, true);
    assert.match(String(obs.note), /no deterministic probe yet/);
    // Not valid for satisfaction (no payload matcher) — an honest fail.
    const v = validateEvidenceObservation(obs, item, { attemptId: "" });
    assert.equal(v.satisfied, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing static behavior unchanged: matchCount semantics preserved", async () => {
  const dir = await makeGitRepo();
  try {
    await writeFile(path.join(dir, "README.md"), "# changed\n", "utf8");
    const item = staticItem();
    const checks = await runChecklistProbes(checklist([item]), dir, {});
    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.verificationMethod, "static");
    assert.match(obs.queryId, /^static-diff-scope:AC-STATIC$/);
    assert.ok(Number.isInteger(obs.matchCount) && obs.matchCount > 0);
    assert.deepEqual(obs.changedFilesInScope, ["README.md"]);
    assert.equal(checks[0].emitFailedClaim, true);

    const v = validateEvidenceObservation(obs, item, { attemptId: "" });
    assert.equal(v.valid, true);
    assert.equal(v.satisfied, true);

    // And the static miss case still yields an honest fail (matchCount 0).
    await exec("git", ["checkout", "-q", "--", "README.md"], { cwd: dir });
    await writeFile(path.join(dir, "OTHER.md"), "x\n", "utf8");
    const checks2 = await runChecklistProbes(checklist([staticItem({ id: "AC-STATIC-2", predicateId: "PRED-STATIC-2" })]), dir, {});
    assert.equal(checks2[0].observation.matchCount, 0);
    const v2 = validateEvidenceObservation(checks2[0].observation, staticItem({ id: "AC-STATIC-2", predicateId: "PRED-STATIC-2" }), { attemptId: "" });
    assert.equal(v2.valid, true);
    assert.equal(v2.satisfied, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
