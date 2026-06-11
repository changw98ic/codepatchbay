#!/usr/bin/env node

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { acquireLease, readLease } from "../server/services/lease-manager.js";
import { getProcess, listProcesses, registerProcess } from "../server/services/process-registry.js";

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withProjectRuntimeEnv(value: string, callback: () => Promise<void>) {
  const previous = process.env.CPB_PROJECT_RUNTIME_ROOT;
  process.env.CPB_PROJECT_RUNTIME_ROOT = value;
  try {
    await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    } else {
      process.env.CPB_PROJECT_RUNTIME_ROOT = previous;
    }
  }
}

test("lease storage requires explicit dataRoot and ignores ambient project runtime env", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-lease-runtime-"));
  const cpbRoot = path.join(root, "source");
  const envRoot = path.join(root, "env-runtime");

  await withProjectRuntimeEnv(envRoot, async () => {
    await assert.rejects(
      acquireLease(cpbRoot, {
        leaseId: "lease-missing-root",
        jobId: "job-missing-root",
        phase: "plan",
        ttlMs: 1_000,
      }),
      /project runtime root required for lease storage/,
    );

    assert.equal(await pathExists(path.join(envRoot, "leases", "lease-missing-root.json")), false);
    assert.equal(await pathExists(path.join(cpbRoot, "cpb-task")), false);
  });
});

test("lease storage writes dataRoot and uses legacy root only with explicit opt-in", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-lease-runtime-"));
  const cpbRoot = path.join(root, "source");
  const dataRoot = path.join(root, "runtime");
  const envRoot = path.join(root, "env-runtime");

  await withProjectRuntimeEnv(envRoot, async () => {
    const lease = await acquireLease(cpbRoot, {
      leaseId: "lease-runtime-root",
      jobId: "job-runtime-root",
      phase: "plan",
      ttlMs: 1_000,
      dataRoot,
    });
    assert.equal(lease.jobId, "job-runtime-root");
    assert.equal(await pathExists(path.join(dataRoot, "leases", "lease-runtime-root.json")), true);
    assert.equal(await pathExists(path.join(envRoot, "leases", "lease-runtime-root.json")), false);

    const legacyLease = await acquireLease(cpbRoot, {
      leaseId: "lease-legacy-root",
      jobId: "job-legacy-root",
      phase: "plan",
      ttlMs: 1_000,
      includeLegacyFallback: true,
    });
    assert.equal(legacyLease.jobId, "job-legacy-root");
    assert.equal(await pathExists(path.join(cpbRoot, "cpb-task", "leases", "lease-legacy-root.json")), true);
    assert.equal((await readLease(cpbRoot, "lease-legacy-root", { includeLegacyFallback: true }))?.jobId, "job-legacy-root");
  });
});

test("process registry requires explicit dataRoot and ignores ambient project runtime env", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-process-runtime-"));
  const cpbRoot = path.join(root, "source");
  const envRoot = path.join(root, "env-runtime");

  await withProjectRuntimeEnv(envRoot, async () => {
    await assert.rejects(
      registerProcess(cpbRoot, {
        jobId: "job-missing-root",
        project: "flow",
        phase: "plan",
      }),
      /project runtime root required for process registry/,
    );
    await assert.rejects(
      listProcesses(cpbRoot),
      /project runtime root required for process registry/,
    );

    assert.equal(await pathExists(path.join(envRoot, "processes", "job-missing-root.json")), false);
    assert.equal(await pathExists(path.join(cpbRoot, "cpb-task")), false);
  });
});

test("process registry writes dataRoot and uses legacy root only with explicit opt-in", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-process-runtime-"));
  const cpbRoot = path.join(root, "source");
  const dataRoot = path.join(root, "runtime");
  const envRoot = path.join(root, "env-runtime");

  await withProjectRuntimeEnv(envRoot, async () => {
    await registerProcess(cpbRoot, {
      jobId: "job-runtime-root",
      project: "flow",
      phase: "plan",
      dataRoot,
    });

    assert.equal(await pathExists(path.join(dataRoot, "processes", "job-runtime-root.json")), true);
    assert.equal(await pathExists(path.join(envRoot, "processes", "job-runtime-root.json")), false);
    assert.equal((await getProcess(cpbRoot, "job-runtime-root", { dataRoot }))?.project, "flow");

    await registerProcess(cpbRoot, {
      jobId: "job-legacy-root",
      project: "flow",
      phase: "plan",
      includeLegacyFallback: true,
    });
    const legacyFile = path.join(cpbRoot, "cpb-task", "processes", "job-legacy-root.json");
    assert.equal(await pathExists(legacyFile), true);
    assert.equal(JSON.parse(await readFile(legacyFile, "utf8")).jobId, "job-legacy-root");
  });
});
