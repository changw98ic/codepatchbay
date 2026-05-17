import assert from "node:assert/strict";
import { access, constants } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { mkdir, writeFile } from "node:fs/promises";

import { acquireLease, readLease, resolveRuntimeBin, getRuntimeBackend } from "../server/services/runtime-cli.js";
import { createJob, listJobs } from "../server/services/job-store.js";

async function detectRuntimeBinary() {
  const bin = resolveRuntimeBin(".");
  try {
    await access(bin, constants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

const detectedBinary = await detectRuntimeBinary();
if (detectedBinary && !process.env.CPB_RUNTIME_BIN) {
  process.env.CPB_RUNTIME_BIN = detectedBinary;
}
const hasRuntimeBinary = Boolean(detectedBinary);

test("Rust runtime adapter lets a zero-ttl lease be reacquired", { skip: !hasRuntimeBinary }, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-runtime-contract-"));

  const first = await acquireLease(cpbRoot, {
    leaseId: "lease-job-contract-plan",
    jobId: "job-contract",
    phase: "plan",
    ttlMs: 0,
    ownerPid: 101,
  });
  assert.equal(first.acquired, true);
  assert.equal(first.lease.ownerPid, 101);

  const second = await acquireLease(cpbRoot, {
    leaseId: "lease-job-contract-plan",
    jobId: "job-contract",
    phase: "plan",
    ttlMs: 50,
    ownerPid: 202,
  });
  assert.equal(second.acquired, true);
  assert.equal(second.lease.ownerPid, 202);

  const current = await readLease(cpbRoot, "lease-job-contract-plan");
  assert.equal(current.ownerPid, 202);
});


test("Rust runtime adapter is used through job-store and filters orphan streams", { skip: !hasRuntimeBinary }, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-runtime-job-contract-"));
  await createJob(cpbRoot, {
    project: "contract",
    task: "adapter job",
    jobId: "job-contract-valid",
    ts: "2026-05-17T00:00:00.000Z",
  });

  const orphanDir = path.join(cpbRoot, "cpb-task", "events", "contract");
  await mkdir(orphanDir, { recursive: true });
  await writeFile(
    path.join(orphanDir, "job-contract-orphan.jsonl"),
    JSON.stringify({ type: "phase_started", jobId: "job-contract-orphan", project: "contract", phase: "plan" }) + "\n",
    "utf8"
  );

  const jobs = await listJobs(cpbRoot, { project: "contract" });
  assert.deepEqual(jobs.map((job) => job.jobId), ["job-contract-valid"]);
});

test("Rust runtime adapter serializes concurrent active lease acquisition", { skip: !hasRuntimeBinary }, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-runtime-lease-race-"));
  const results = await Promise.all([
    acquireLease(cpbRoot, {
      leaseId: "lease-job-race-plan",
      jobId: "job-race",
      phase: "plan",
      ttlMs: 60_000,
      ownerPid: 301,
    }),
    acquireLease(cpbRoot, {
      leaseId: "lease-job-race-plan",
      jobId: "job-race",
      phase: "plan",
      ttlMs: 60_000,
      ownerPid: 302,
    }),
  ]);

  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(results.filter((result) => !result.acquired).length, 1);
});

test("getRuntimeBackend reports js when CPB_RUNTIME is not rust", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-runtime-backend-"));
  const prev = process.env.CPB_RUNTIME;
  process.env.CPB_RUNTIME = "js";
  try {
    const info = await getRuntimeBackend(cpbRoot);
    assert.equal(info.backend, "js");
    assert.equal(typeof info.bin, "string");
    assert.equal(typeof info.binExists, "boolean");
  } finally {
    process.env.CPB_RUNTIME = prev;
  }
});

test("runtime status command returns structured JSON", { skip: !hasRuntimeBinary }, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-runtime-status-"));
  const prev = process.env.CPB_RUNTIME;
  process.env.CPB_RUNTIME = "rust";
  try {
    const info = await getRuntimeBackend(cpbRoot);
    assert.equal(info.backend, "rust");
    assert.equal(info.binExists, true);
    assert.ok(info.bin);
  } finally {
    process.env.CPB_RUNTIME = prev;
  }
});
