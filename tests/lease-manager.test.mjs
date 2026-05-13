#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireLease,
  readLease,
  renewLease,
  releaseLease,
  isLeaseStale,
} from "../server/services/lease-manager.js";

const moduleUrl = pathToFileURL(
  path.resolve("server/services/lease-manager.js")
).href;

function runFreshNode(source) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

const root = await mkdtemp(path.join(tmpdir(), "flow-lease-"));
const now = new Date("2026-05-13T00:00:00.000Z");

const lease = await acquireLease(root, {
  leaseId: "lease-job-1-plan",
  jobId: "job-1",
  phase: "plan",
  ttlMs: 60_000,
  now,
  ownerPid: 123,
});

assert.equal(lease.jobId, "job-1");
assert.equal(lease.phase, "plan");
assert.equal(lease.expiresAt, "2026-05-13T00:01:00.000Z");

const read = await readLease(root, "lease-job-1-plan");
assert.equal(read.ownerPid, 123);
assert.equal(isLeaseStale(read, new Date("2026-05-13T00:00:30.000Z")), false);
assert.equal(isLeaseStale(read, new Date("2026-05-13T00:01:00.000Z")), true);
assert.equal(isLeaseStale(read, new Date("2026-05-13T00:01:01.000Z")), true);
assert.equal(isLeaseStale({ ...read, expiresAt: "bad-date" }, now), true);

const renewed = await renewLease(root, "lease-job-1-plan", {
  now: new Date("2026-05-13T00:00:45.000Z"),
  ttlMs: 60_000,
});
assert.equal(renewed.expiresAt, "2026-05-13T00:01:45.000Z");

await releaseLease(root, "lease-job-1-plan");
const afterRelease = await readLease(root, "lease-job-1-plan");
assert.equal(afterRelease, null);
await releaseLease(await mkdtemp(path.join(tmpdir(), "flow-lease-missing-")), "missing-lease");

await assert.rejects(
  () => acquireLease(root, {
    leaseId: "../lease-job-1-plan",
    jobId: "job-1",
    phase: "plan",
    ttlMs: 60_000,
  }),
  /invalid leaseId/i
);
assert.throws(() => isLeaseStale(null), /invalid lease/i);

const staleRoot = await mkdtemp(path.join(tmpdir(), "flow-lease-stale-"));
const staleLease = await acquireLease(staleRoot, {
  leaseId: "lease-job-2-plan",
  jobId: "job-2",
  phase: "plan",
  ttlMs: 1_000,
  now,
  ownerPid: 456,
});
const recoveredLease = await acquireLease(staleRoot, {
  leaseId: "lease-job-2-plan",
  jobId: "job-2",
  phase: "plan",
  ttlMs: 60_000,
  now: new Date("2026-05-13T00:00:02.000Z"),
  ownerPid: 789,
});
assert.notEqual(recoveredLease.ownerToken, staleLease.ownerToken);
assert.equal(recoveredLease.ownerPid, 789);
assert.equal(recoveredLease.acquiredAt, "2026-05-13T00:00:02.000Z");
const freshRenewWithoutToken = runFreshNode(`
  import { renewLease } from ${JSON.stringify(moduleUrl)};
  await renewLease(${JSON.stringify(staleRoot)}, "lease-job-2-plan", {
    now: new Date("2026-05-13T00:00:03.000Z"),
    ttlMs: 60_000
  });
`);
assert.notEqual(freshRenewWithoutToken.status, 0);
assert.match(freshRenewWithoutToken.stderr, /lease owner mismatch/i);
await assert.rejects(
  () => renewLease(staleRoot, "lease-job-2-plan", {
    now: new Date("2026-05-13T00:00:03.000Z"),
    ttlMs: 60_000,
    ownerToken: staleLease.ownerToken,
  }),
  /lease owner mismatch/i
);
await assert.rejects(
  () => releaseLease(staleRoot, "lease-job-2-plan", {
    ownerToken: staleLease.ownerToken,
  }),
  /lease owner mismatch/i
);
assert.notEqual(await readLease(staleRoot, "lease-job-2-plan"), null);
const freshReleaseWithoutToken = runFreshNode(`
  import { releaseLease } from ${JSON.stringify(moduleUrl)};
  await releaseLease(${JSON.stringify(staleRoot)}, "lease-job-2-plan");
`);
assert.notEqual(freshReleaseWithoutToken.status, 0);
assert.match(freshReleaseWithoutToken.stderr, /lease owner mismatch/i);
assert.notEqual(await readLease(staleRoot, "lease-job-2-plan"), null);
await releaseLease(staleRoot, "lease-job-2-plan", {
  ownerToken: recoveredLease.ownerToken,
});
assert.equal(await readLease(staleRoot, "lease-job-2-plan"), null);

const concurrentRoot = await mkdtemp(path.join(tmpdir(), "flow-lease-race-"));
await acquireLease(concurrentRoot, {
  leaseId: "lease-job-3-plan",
  jobId: "job-3",
  phase: "plan",
  ttlMs: 1_000,
  now,
});
const concurrentResults = await Promise.allSettled([
  acquireLease(concurrentRoot, {
    leaseId: "lease-job-3-plan",
    jobId: "job-3",
    phase: "plan",
    ttlMs: 60_000,
    now: new Date("2026-05-13T00:00:02.000Z"),
    ownerPid: 101,
  }),
  acquireLease(concurrentRoot, {
    leaseId: "lease-job-3-plan",
    jobId: "job-3",
    phase: "plan",
    ttlMs: 60_000,
    now: new Date("2026-05-13T00:00:02.000Z"),
    ownerPid: 202,
  }),
]);
assert.equal(
  concurrentResults.filter((result) => result.status === "fulfilled").length,
  1
);
assert.equal(
  concurrentResults.filter((result) => result.status === "rejected").length,
  1
);
const concurrentLease = await readLease(concurrentRoot, "lease-job-3-plan");
assert.equal(concurrentLease.expiresAt, "2026-05-13T00:01:02.000Z");
assert.equal(
  concurrentLease.ownerToken,
  concurrentResults.find((result) => result.status === "fulfilled").value.ownerToken
);

const invalidRoot = await mkdtemp(path.join(tmpdir(), "flow-lease-invalid-"));
await acquireLease(invalidRoot, {
  leaseId: "lease-job-4-plan",
  jobId: "job-4",
  phase: "plan",
  ttlMs: 60_000,
  now,
});
await writeFile(
  path.join(invalidRoot, ".omc", "leases", "lease-job-4-plan.json"),
  JSON.stringify({
    leaseId: "lease-job-4-plan",
    jobId: "job-4",
    phase: "plan",
    ownerPid: 303,
    ownerHost: "test",
    ownerToken: "old-token",
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: "not-a-date",
  }),
  "utf8"
);
const invalidRecovered = await acquireLease(invalidRoot, {
  leaseId: "lease-job-4-plan",
  jobId: "job-4",
  phase: "plan",
  ttlMs: 60_000,
  now: new Date("2026-05-13T00:00:05.000Z"),
});
assert.notEqual(invalidRecovered.ownerToken, "old-token");

const orphanLockRoot = await mkdtemp(path.join(tmpdir(), "flow-lease-orphan-lock-"));
await acquireLease(orphanLockRoot, {
  leaseId: "lease-job-5-plan",
  jobId: "job-5",
  phase: "plan",
  ttlMs: 1_000,
  now,
});
const orphanLockDir = path.join(
  orphanLockRoot,
  ".omc",
  "leases",
  "lease-job-5-plan.json.lock"
);
await mkdir(orphanLockDir);
await writeFile(
  path.join(orphanLockDir, "lock.json"),
  JSON.stringify({
    acquiredAt: "2026-05-13T00:00:00.000Z",
    ownerPid: 999_999,
    ownerHost: "dead-host",
  }),
  "utf8"
);
const orphanRecovered = await acquireLease(orphanLockRoot, {
  leaseId: "lease-job-5-plan",
  jobId: "job-5",
  phase: "plan",
  ttlMs: 60_000,
  now: new Date("2026-05-13T00:00:05.000Z"),
  ownerPid: 404,
});
assert.equal(orphanRecovered.ownerPid, 404);
