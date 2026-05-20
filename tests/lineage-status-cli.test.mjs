#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  createJob,
  failJob,
  startPhase,
  retryJob,
  listJobs,
  FAILURE_CODES,
} from "../server/services/job-store.js";
import { inspectProcess } from "../server/services/process-registry.js";

const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-lineage-status-"));
const project = "lineage-test";
const executorRoot = path.resolve(path.join(import.meta.dirname, ".."));

// Create wiki dir structure so cpb status require_project and file checks pass
await mkdir(path.join(cpbRoot, "wiki", "projects", project, "inbox"), { recursive: true });
await mkdir(path.join(cpbRoot, "wiki", "projects", project, "outputs"), { recursive: true });

const ts = (offset) => {
  const d = new Date("2026-05-20T00:00:00.000Z");
  d.setSeconds(d.getSeconds() + offset);
  return d.toISOString();
};

function runCpb(args, opts = {}) {
  const { timeout = 10000, ...env } = opts;
  return execSync(`bash "${executorRoot}/cpb" ${args}`, {
    encoding: "utf8",
    env: { ...process.env, CPB_ROOT: cpbRoot, CPB_EXECUTOR_ROOT: executorRoot, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
  });
}

describe("inspectProcess without process registry entry", () => {
  it("returns job + lineage when process entry is absent", async () => {
    const parent = await createJob(cpbRoot, {
      project,
      task: "parent task that fails",
      workflow: "standard",
      ts: ts(1),
    });
    await startPhase(cpbRoot, project, parent.jobId, { phase: "execute", leaseId: "l1", ts: ts(2) });
    await failJob(cpbRoot, project, parent.jobId, {
      reason: "execute bombed",
      code: FAILURE_CODES.RECOVERABLE,
      phase: "execute",
      ts: ts(3),
    });

    const recovered = await retryJob(cpbRoot, project, parent.jobId, { ts: ts(10) });

    const result = await inspectProcess(cpbRoot, recovered.jobId);
    assert.ok(result, "inspectProcess should return a result even without process entry");
    assert.equal(result.process, null, "no process registry entry expected");
    assert.ok(result.job, "job should be populated from durable state");
    assert.equal(result.job.jobId, recovered.jobId);
    assert.equal(result.job.project, project);
    assert.ok(result.lineage, "lineage should be present");
    assert.equal(result.lineage.parentJobId, parent.jobId);
    assert.equal(result.lineage.parentStatus, "failed");
    assert.equal(result.lineage.parentFailurePhase, "execute");
    assert.equal(result.lineage.parentFailureCode, FAILURE_CODES.RECOVERABLE);
    assert.equal(result.liveness, null, "no liveness without process");
  });

  it("builds ancestors chain from multi-level recovery", async () => {
    const g1 = await createJob(cpbRoot, { project, task: "gen1", ts: ts(100) });
    await startPhase(cpbRoot, project, g1.jobId, { phase: "plan", leaseId: "l10", ts: ts(101) });
    await failJob(cpbRoot, project, g1.jobId, {
      reason: "g1 fail", code: FAILURE_CODES.RECOVERABLE, phase: "plan", ts: ts(102),
    });
    const g2 = await retryJob(cpbRoot, project, g1.jobId, { ts: ts(110) });
    await startPhase(cpbRoot, project, g2.jobId, { phase: "plan", leaseId: "l11", ts: ts(111) });
    await failJob(cpbRoot, project, g2.jobId, {
      reason: "g2 fail", code: FAILURE_CODES.QUALITY_FAIL, phase: "plan", ts: ts(112),
    });
    const g3 = await retryJob(cpbRoot, project, g2.jobId, { force: true, ts: ts(120) });

    const result = await inspectProcess(cpbRoot, g3.jobId);
    assert.ok(result);
    assert.equal(result.lineage.parentJobId, g2.jobId);
    assert.equal(result.ancestors.length, 2, "should have 2 ancestors (g2 and g1)");
    assert.equal(result.ancestors[0].jobId, g2.jobId);
    assert.equal(result.ancestors[1].jobId, g1.jobId);
  });

  it("finds children for a parent job", async () => {
    const p = await createJob(cpbRoot, { project, task: "parent-with-children", ts: ts(200) });
    await startPhase(cpbRoot, project, p.jobId, { phase: "plan", leaseId: "l20", ts: ts(201) });
    await failJob(cpbRoot, project, p.jobId, {
      reason: "parent fail", code: FAILURE_CODES.RECOVERABLE, phase: "plan", ts: ts(202),
    });
    await retryJob(cpbRoot, project, p.jobId, { ts: ts(210) });
    await retryJob(cpbRoot, project, p.jobId, { ts: ts(220) });

    const result = await inspectProcess(cpbRoot, p.jobId);
    assert.ok(result);
    assert.equal(result.children.length, 2, "parent should have 2 recovery children");
  });
});

describe("cpb inspect CLI with lineage", () => {
  it("prints job and lineage sections for recovered job without process entry", async () => {
    const parent = await createJob(cpbRoot, {
      project,
      task: "cli inspect test",
      workflow: "standard",
      ts: ts(300),
    });
    await startPhase(cpbRoot, project, parent.jobId, { phase: "verify", leaseId: "l30", ts: ts(301) });
    await failJob(cpbRoot, project, parent.jobId, {
      reason: "verify failed",
      code: FAILURE_CODES.QUALITY_FAIL,
      phase: "verify",
      ts: ts(302),
    });
    const recovered = await retryJob(cpbRoot, project, parent.jobId, { force: true, ts: ts(310) });

    const output = runCpb(`inspect ${recovered.jobId}`);
    assert.match(output, /Job:/);
    assert.match(output, /no active process registry entry/);
    assert.match(output, /Lineage:/);
    assert.match(output, new RegExp(parent.jobId));
    assert.match(output, /verify/);
    assert.match(output, /QUALITY_FAIL/);
  });
});

describe("list-jobs.mjs lineage output", () => {
  it("includes parent failure phase/code/status in lineage tag", async () => {
    const p = await createJob(cpbRoot, { project, task: "list-jobs lineage", ts: ts(400) });
    await startPhase(cpbRoot, project, p.jobId, { phase: "execute", leaseId: "l40", ts: ts(401) });
    await failJob(cpbRoot, project, p.jobId, {
      reason: "list fail", code: FAILURE_CODES.BLOCKED, phase: "execute", ts: ts(402),
    });
    await retryJob(cpbRoot, project, p.jobId, { force: true, ts: ts(410) });

    const output = execSync(
      `node "${executorRoot}/bridges/list-jobs.mjs"`,
      { encoding: "utf8", env: { ...process.env, CPB_ROOT: cpbRoot } },
    );
    const lines = output.trim().split("\n");
    const recoveryLine = lines.find((l) => l.includes("recovery:"));
    assert.ok(recoveryLine, "should have a line with recovery lineage tag");
    assert.match(recoveryLine, /at:execute/);
    assert.match(recoveryLine, /code:BLOCKED/);
    assert.match(recoveryLine, /failed/);
  });
});

describe("cpb status lineage context", () => {
  it("prints fresh recovery lineage with parent failure info", async () => {
    const p = await createJob(cpbRoot, { project, task: "status lineage test", ts: ts(500) });
    await startPhase(cpbRoot, project, p.jobId, { phase: "plan", leaseId: "l50", ts: ts(501) });
    await failJob(cpbRoot, project, p.jobId, {
      reason: "status fail", code: FAILURE_CODES.RECOVERABLE, phase: "plan", ts: ts(502),
    });
    await retryJob(cpbRoot, project, p.jobId, { ts: ts(510) });

    const output = runCpb(`status ${project}`, { timeout: 30000 });
    assert.match(output, /fresh recovery from:/);
    assert.match(output, /failed:plan/);
    assert.match(output, /code:RECOVERABLE/);
    assert.match(output, /was:failed/);
  });
});
