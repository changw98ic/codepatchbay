import assert from "node:assert/strict";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  acquireHubMaintenance,
  assertHubWritable,
  hubMaintenanceLockPath,
  hubRestoreJournalPath,
  readHubMaintenance,
} from "../shared/hub-maintenance.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import { WorkerStore } from "../shared/orchestrator/worker-store.js";
import { startHubServer } from "../server/index.js";
import { HubOrchestrator } from "../server/orchestrator/hub-orchestrator.js";
import { WorkerSupervisor } from "../server/orchestrator/worker-supervisor.js";
import { createHubBackup } from "../server/services/hub/hub-backup.js";
import { enqueue } from "../server/services/hub/hub-queue.js";
import { getHubRuntime, saveRegistry } from "../server/services/hub/hub-registry.js";
import { appendCommand } from "../server/services/quota-delegate-client.js";
import { tempRoot } from "./helpers.js";

test("Hub maintenance lease fences writes and releases only its own token", async () => {
  const root = await tempRoot("cpb-hub-maintenance-lease");
  const hubRoot = path.join(root, "hub");
  await mkdir(hubRoot, { recursive: true });

  const lease = await acquireHubMaintenance(hubRoot, "backup");
  await assert.rejects(assertHubWritable(hubRoot), /backup is active/);
  await assert.rejects(acquireHubMaintenance(hubRoot, "restore"), /already held/);
  assert.equal((await readHubMaintenance(hubRoot)).active, true);

  assert.equal(await lease.release(), true);
  await assert.doesNotReject(assertHubWritable(hubRoot));
  assert.equal((await readHubMaintenance(hubRoot)).active, false);
});

test("old maintenance owner cannot release a replacement lease", async () => {
  const root = await tempRoot("cpb-hub-maintenance-replacement");
  const hubRoot = path.join(root, "hub");
  await mkdir(hubRoot, { recursive: true });
  const first = await acquireHubMaintenance(hubRoot, "backup");
  const displaced = `${first.lockPath}.displaced`;
  await rename(first.lockPath, displaced);
  const replacement = await acquireHubMaintenance(hubRoot, "restore");

  assert.equal(await first.release(), false);
  assert.equal((await readHubMaintenance(hubRoot)).owner?.ownerToken, replacement.owner.ownerToken);

  assert.equal(await replacement.release(), true);
  await rm(displaced, { recursive: true, force: true });
});

test("maintenance acquisition recovers a dead local owner", async () => {
  const root = await tempRoot("cpb-hub-maintenance-stale");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v1",
    ownerToken: "dead-owner",
    operation: "backup",
    hubRoot,
    pid: 999_999_999,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`, "utf8");

  const replacement = await acquireHubMaintenance(hubRoot, "restore");
  assert.notEqual(replacement.owner.ownerToken, "dead-owner");
  assert.equal(await replacement.release(), true);
});

test("interrupted restore journal prevents automatic stale-lock theft", async () => {
  const root = await tempRoot("cpb-hub-maintenance-journal");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v1",
    ownerToken: "dead-restore-owner",
    operation: "restore",
    hubRoot,
    pid: 999_999_999,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`, "utf8");
  await writeFile(hubRestoreJournalPath(hubRoot), "{}\n", "utf8");

  await assert.rejects(acquireHubMaintenance(hubRoot, "backup"), /requires recovery|already held/);
  await assert.rejects(assertHubWritable(hubRoot), /restore recovery completes/);
  await access(lockPath);
  assert.ok(!hubMaintenanceLockPath(hubRoot).startsWith(`${path.resolve(hubRoot)}${path.sep}`));
});

test("maintenance lease fences Hub, orchestrator, worker, stores, delegate, and backup entry points", async () => {
  const root = await tempRoot("cpb-hub-maintenance-entry-points");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  const lease = await acquireHubMaintenance(hubRoot, "restore drill");
  try {
    await assert.rejects(startHubServer({ cpbRoot, hubRoot, host: "127.0.0.1", port: 0, allowAnonymousDev: true }), /restore drill is active/);
    await assert.rejects(new HubOrchestrator(hubRoot, cpbRoot).start(), /restore drill is active/);
    await assert.rejects(new WorkerSupervisor(hubRoot, cpbRoot).startWorker({ projectId: "flow" }), /restore drill is active/);
    await assert.rejects(new WorkerStore(hubRoot).init(), /restore drill is active/);
    await assert.rejects(new AssignmentStore(hubRoot).init(), /restore drill is active/);
    await assert.rejects(saveRegistry(hubRoot, { projects: {} }), /restore drill is active/);
    await assert.rejects(enqueue(hubRoot, { projectId: "flow", description: "blocked" }), /restore drill is active/);
    await assert.rejects(getHubRuntime(cpbRoot, hubRoot).persist(), /restore drill is active/);
    await assert.rejects(appendCommand(hubRoot, { commandId: "blocked-command", type: "usage_write" }), /restore drill is active/);
    await assert.rejects(createHubBackup({ cpbRoot, hubRoot, output: path.join(root, "backup") }), /already held/);
  } finally {
    await lease.release();
  }
});

test("Redis-backed WorkerSupervisor refuses to pass control-plane credentials to a worker", async () => {
  const root = await tempRoot("cpb-worker-broker-required");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  const previousRedis = process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
  const previousBroker = process.env.CPB_HUB_WORKER_BROKER_URL;
  process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE = path.join(root, "private-redis-config.json");
  delete process.env.CPB_HUB_WORKER_BROKER_URL;
  try {
    await assert.rejects(
      new WorkerSupervisor(hubRoot, cpbRoot).startWorker({ projectId: "flow" }),
      { code: "HUB_WORKER_BROKER_REQUIRED" },
    );
  } finally {
    if (previousRedis === undefined) delete process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
    else process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE = previousRedis;
    if (previousBroker === undefined) delete process.env.CPB_HUB_WORKER_BROKER_URL;
    else process.env.CPB_HUB_WORKER_BROKER_URL = previousBroker;
  }
});
