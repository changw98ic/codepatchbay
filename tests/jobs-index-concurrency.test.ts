import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { withDirectoryProcessFence } from "../core/runtime/durable-directory-lock.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { captureCurrentProcessIdentity, captureProcessIdentity } from "../core/runtime/process-tree.js";
import {
  listJobsFromIndex,
  readJobsIndex,
  rebuildJobsIndex,
  withJobsIndexLockTestHooksForTests,
  type JobsIndexLockTestHooks,
} from "../server/services/job/job-store.js";

const jobsIndexLockTestHookScope = new AsyncLocalStorage<JobsIndexLockTestHooks>();
const __jobsIndexLockTestHooks = new Proxy({} as JobsIndexLockTestHooks, {
  get(_target, property) {
    return Reflect.get(jobsIndexLockTestHookScope.getStore() || {}, property);
  },
  set(_target, property, value) {
    const hooks = jobsIndexLockTestHookScope.getStore();
    if (!hooks) throw new Error("jobs-index test hook mutation requires a scoped test");
    return Reflect.set(hooks, property, value);
  },
  deleteProperty(_target, property) {
    const hooks = jobsIndexLockTestHookScope.getStore();
    if (!hooks) return true;
    return Reflect.deleteProperty(hooks, property);
  },
});

function test(name: string, fn: (context: TestContext) => void | Promise<void>) {
  return nodeTest(name, (context) => {
    const hooks: JobsIndexLockTestHooks = {};
    return jobsIndexLockTestHookScope.run(
      hooks,
      () => withJobsIndexLockTestHooksForTests(hooks, () => fn(context)),
    );
  });
}

function waitForChildJson(child: ReturnType<typeof spawn>, timeoutMs = 60_000) {
  let stdout = "";
  let stderr = "";
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);
  timeout.unref();
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise<any>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`child exited ${code ?? signal}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`child returned invalid JSON: ${stdout}\n${stderr}\n${(error as Error).message}`));
      }
    });
  });
}

function jobsIndexModulePath() {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(testDir, "../server/services/job/job-store.js"),
    path.resolve(testDir, "../../dist-tests/server/services/jobs-index.js"),
    path.resolve(process.cwd(), "dist/server/services/jobs-index.js"),
    path.resolve(process.cwd(), "dist-tests/server/services/jobs-index.js"),
  ];
  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) return existing;
  return candidates[0];
}

function spawnJobsIndexReader(cpbRoot: string, dataRoot: string, barrierPath: string) {
  const modulePath = jobsIndexModulePath();
  const script = `
    import { existsSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { pathToFileURL } from "node:url";

    const [modulePath, cpbRoot, dataRoot, barrierPath] = process.argv.slice(-4);
    if (!modulePath || !cpbRoot || !dataRoot || !barrierPath) throw new Error("missing jobs-index reader arguments");
    while (!existsSync(barrierPath)) await delay(5);
    const { listJobsFromIndex } = await import(pathToFileURL(modulePath).href);
    const jobs = await listJobsFromIndex(cpbRoot, { dataRoot });
    console.log(JSON.stringify({ jobIds: jobs.map((job) => job.jobId).sort() }));
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script, modulePath, cpbRoot, dataRoot, barrierPath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function currentProcessIdentity() {
  const identity = captureProcessIdentity(process.pid, { strict: false });
  assert.ok(identity);
  return identity;
}

function exactCurrentProcessIdentityOrNull() {
  try {
    return captureCurrentProcessIdentity();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "PROCESS_IDENTITY_UNAVAILABLE") return null;
    throw error;
  }
}

async function jobsIndexLockOwner(lockDir: string, ownerToken: string, identity = currentProcessIdentity()) {
  assert.ok(identity);
  return {
    format: "cpb-directory-lock/v1",
    ownerToken,
    lockPath: path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir)),
    pid: identity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: {
      ...identity,
      birthIdPrecision: identity.birthIdPrecision === "coarse" ? "coarse" : "exact",
    },
  };
}

async function writeJobsIndexLockOwner(lockDir: string, ownerToken: string, identity = currentProcessIdentity()) {
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(await jobsIndexLockOwner(lockDir, ownerToken, identity), null, 2)}\n`, "utf8");
}

async function retireJobsIndexLockAfter(lockDir: string, delayMs: number) {
  await delay(delayMs);
  const quarantineDir = `${lockDir}.released-test-${process.pid}-${Date.now()}`;
  await withDirectoryProcessFence(lockDir, () => rename(lockDir, quarantineDir), { waitMs: 10_000 });
  return quarantineDir;
}

test("concurrent jobs-index readers can merge missing event streams without tmp-file races", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-race-"));
  const dataRoot = path.join(cpbRoot, "runtime");
  try {
    const project = "race";
    const firstJobId = "job-20260611-010000-seeded";

    await appendEvent(
      cpbRoot,
      project,
      firstJobId,
      {
        type: "job_created",
        jobId: firstJobId,
        project,
        task: "seed index",
        workflow: "standard",
        ts: "2026-06-11T01:00:00.000Z",
      },
      { dataRoot }
    );
    await rebuildJobsIndex(cpbRoot, { dataRoot });

    const expectedJobIds = new Set([firstJobId]);
    for (let i = 0; i < 20; i++) {
      const suffix = String(i).padStart(2, "0");
      const jobId = `job-20260611-0101${suffix}-missing`;
      expectedJobIds.add(jobId);
      await appendEvent(
        cpbRoot,
        project,
        jobId,
        {
          type: "job_created",
          jobId,
          project,
          task: `missing ${i}`,
          workflow: "standard",
          ts: `2026-06-11T01:01:${suffix}.000Z`,
        },
        { dataRoot }
      );
    }

    const results = await Promise.all(
      Array.from({ length: 50 }, () => listJobsFromIndex(cpbRoot, { dataRoot }))
    );

    assert.equal(results.length, 50);
    for (const jobs of results) {
      assert.equal(jobs.length, expectedJobIds.size);
      assert.deepEqual(new Set(jobs.map((job) => job.jobId)), expectedJobIds);
    }

    const index = await readJobsIndex(cpbRoot, { dataRoot });
    assert.equal(index?._meta?.jobCount, expectedJobIds.size);
    assert.deepEqual(new Set(Object.values(index?.jobs ?? {}).map((job: any) => job.jobId)), expectedJobIds);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index readers ignore stale legacy entries already written into a project index", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-legacy-pollution-"));
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const projectJobId = "job-20260611-040100-project";
  const legacyJobId = "job-20260611-040000-legacy";
  try {
    await appendEvent(
      cpbRoot,
      "legacy",
      legacyJobId,
      {
        type: "job_created",
        jobId: legacyJobId,
        project: "legacy",
        task: "old fallback job",
        workflow: "standard",
        ts: "2026-06-11T04:00:00.000Z",
      },
      { legacyOnly: true }
    );
    await appendEvent(
      cpbRoot,
      "flow",
      projectJobId,
      {
        type: "job_created",
        jobId: projectJobId,
        project: "flow",
        task: "project root job",
        workflow: "standard",
        ts: "2026-06-11T04:01:00.000Z",
      },
      { dataRoot }
    );

    await mkdir(dataRoot, { recursive: true });
    await writeFile(
      path.join(dataRoot, "jobs-index.json"),
      `${JSON.stringify({
        _meta: {
          version: 1,
          updatedAt: "2026-06-11T04:02:00.000Z",
          jobCount: 2,
        },
        jobs: {
          [`flow/${projectJobId}`]: {
            project: "flow",
            jobId: projectJobId,
            task: "project root job",
            status: "running",
            createdAt: "2026-06-11T04:01:00.000Z",
            updatedAt: "2026-06-11T04:01:00.000Z",
          },
          [`legacy/${legacyJobId}`]: {
            project: "legacy",
            jobId: legacyJobId,
            task: "old fallback job",
            status: "running",
            createdAt: "2026-06-11T04:00:00.000Z",
            updatedAt: "2026-06-11T04:00:00.000Z",
          },
        },
      })}\n`,
      "utf8"
    );
    const pollutedIndex = await readJobsIndex(cpbRoot, { dataRoot });
    assert.deepEqual(Object.keys(pollutedIndex?.jobs ?? {}).sort(), [
      `flow/${projectJobId}`,
      `legacy/${legacyJobId}`,
    ]);

    const jobs = await listJobsFromIndex(cpbRoot, { dataRoot, includeLegacyFallback: false });

    assert.deepEqual(jobs.map((job) => `${job.project}/${job.jobId}`), [`flow/${projectJobId}`]);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index preserves corrupt and incompatible files instead of rebuilding over them", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-invalid-"));
  try {
    for (const [name, content, code] of [
      ["corrupt", "{not-json\n", "JOBS_INDEX_CORRUPT"],
      [
        "newer-version",
        `${JSON.stringify({ _meta: { version: 2, updatedAt: null, jobCount: 0 }, jobs: {} })}\n`,
        "JOBS_INDEX_INVALID",
      ],
    ] as const) {
      const dataRoot = path.join(cpbRoot, name);
      const indexFile = path.join(dataRoot, "jobs-index.json");
      await mkdir(dataRoot, { recursive: true });
      await writeFile(indexFile, content, "utf8");

      await assert.rejects(readJobsIndex(cpbRoot, { dataRoot }), { code });
      await assert.rejects(listJobsFromIndex(cpbRoot, { dataRoot }), { code });
      assert.equal(await readFile(indexFile, "utf8"), content);
    }
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index rejects a symbolic-link index without changing its target", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-symlink-"));
  const dataRoot = path.join(cpbRoot, "runtime");
  const external = path.join(cpbRoot, "external-index.json");
  const content = `${JSON.stringify({ _meta: { version: 1, updatedAt: null, jobCount: 0 }, jobs: {} })}\n`;
  try {
    await mkdir(dataRoot, { recursive: true });
    await writeFile(external, content, "utf8");
    await symlink(external, path.join(dataRoot, "jobs-index.json"));

    await assert.rejects(readJobsIndex(cpbRoot, { dataRoot }), { code: "JOBS_INDEX_UNSAFE" });
    await assert.rejects(listJobsFromIndex(cpbRoot, { dataRoot }), { code: "JOBS_INDEX_UNSAFE" });
    assert.equal(await readFile(external, "utf8"), content);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("cross-process jobs-index readers converge on one complete index without lock leaks", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-process-race-"));
  const dataRoot = path.join(cpbRoot, "runtime");
  const barrierPath = path.join(cpbRoot, "start-readers");
  const project = "process-race";
  const seededJobId = "job-20260611-020000-seeded";
  const expectedJobIds = new Set([seededJobId]);
  try {
    await appendEvent(
      cpbRoot,
      project,
      seededJobId,
      {
        type: "job_created",
        jobId: seededJobId,
        project,
        task: "seed cross-process index",
        workflow: "standard",
        ts: "2026-06-11T02:00:00.000Z",
      },
      { dataRoot }
    );
    await rebuildJobsIndex(cpbRoot, { dataRoot });

    for (let i = 0; i < 30; i++) {
      const suffix = String(i).padStart(2, "0");
      const jobId = `job-20260611-0201${suffix}-missing`;
      expectedJobIds.add(jobId);
      await appendEvent(
        cpbRoot,
        project,
        jobId,
        {
          type: "job_created",
          jobId,
          project,
          task: `cross-process missing ${i}`,
          workflow: "standard",
          ts: `2026-06-11T02:01:${suffix}.000Z`,
        },
        { dataRoot }
      );
    }

    const childResults = Array.from({ length: 8 }, () =>
      waitForChildJson(spawnJobsIndexReader(cpbRoot, dataRoot, barrierPath))
    );
    await writeFile(barrierPath, "go\n", "utf8");
    const results = await Promise.all(childResults);
    const expectedSorted = [...expectedJobIds].sort();
    for (const result of results) {
      assert.deepEqual(result.jobIds, expectedSorted);
    }

    const index = await readJobsIndex(cpbRoot, { dataRoot });
    assert.equal(index?._meta?.jobCount, expectedJobIds.size);
    assert.deepEqual(Object.keys(index?.jobs ?? {}).sort(), expectedSorted.map((jobId) => `${project}/${jobId}`));
    assert.equal(existsSync(path.join(dataRoot, "jobs-index.json.lock")), false);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index readers wait for a fresh lock instead of failing after one second", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-lock-wait-"));
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "wait";
  const jobId = "job-20260611-030000-wait";
  const lockDir = path.join(dataRoot, "jobs-index.json.lock");
  try {
    await appendEvent(
      cpbRoot,
      project,
      jobId,
      {
        type: "job_created",
        jobId,
        project,
        task: "wait through active lock",
        workflow: "standard",
        ts: "2026-06-11T03:00:00.000Z",
      },
      { dataRoot }
    );
    await mkdir(lockDir, { recursive: true });
    await writeJobsIndexLockOwner(lockDir, "external-owner");

    const retirement = retireJobsIndexLockAfter(lockDir, 1_500);
    const start = Date.now();
    try {
      const jobs = await listJobsFromIndex(cpbRoot, { dataRoot });
      assert(Date.now() - start >= 1_250);
      assert.deepEqual(jobs.map((job) => job.jobId), [jobId]);
    } finally {
      const quarantineDir = await retirement;
      assert.equal(JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8")).ownerToken, "external-owner");
    }
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index readers do not steal a stale lock from a live owner process", async () => {
  const current = exactCurrentProcessIdentityOrNull();
  if (!current) return;
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-live-lock-"));
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "live";
  const jobId = "job-20260611-031000-live";
  const lockDir = path.join(dataRoot, "jobs-index.json.lock");
  try {
    await appendEvent(
      cpbRoot,
      project,
      jobId,
      {
        type: "job_created",
        jobId,
        project,
        task: "wait for live owner lock",
        workflow: "standard",
        ts: "2026-06-11T03:10:00.000Z",
      },
      { dataRoot }
    );
    await mkdir(lockDir, { recursive: true });
    await writeJobsIndexLockOwner(lockDir, "live-owner", current);
    const old = new Date(0);
    await utimes(lockDir, old, old);

    const retirement = retireJobsIndexLockAfter(lockDir, 1_500);
    const start = Date.now();
    try {
      const jobs = await listJobsFromIndex(cpbRoot, { dataRoot });
      assert(Date.now() - start >= 1_250);
      assert.deepEqual(jobs.map((job) => job.jobId), [jobId]);
    } finally {
      const quarantineDir = await retirement;
      assert.equal(JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8")).ownerToken, "live-owner");
    }
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index readers recover a stale lock only after PID reuse is disproven by process identity", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-pid-reuse-"));
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "pid-reuse";
  const jobId = "job-20260611-032000-reused";
  const lockDir = path.join(dataRoot, "jobs-index.json.lock");
  try {
    await appendEvent(
      cpbRoot,
      project,
      jobId,
      {
        type: "job_created",
        jobId,
        project,
        task: "recover reused pid lock",
        workflow: "standard",
        ts: "2026-06-11T03:20:00.000Z",
      },
      { dataRoot }
    );
    const current = exactCurrentProcessIdentityOrNull();
    if (!current) return;
    const predecessorBirthId = `${current.birthId}:predecessor`;
    await writeJobsIndexLockOwner(lockDir, "predecessor-owner", {
      ...current,
      birthId: predecessorBirthId,
      incarnation: `${current.pid}:${predecessorBirthId}`,
    });
    const old = new Date(0);
    await utimes(lockDir, old, old);

    const jobs = await listJobsFromIndex(cpbRoot, { dataRoot });

    assert.deepEqual(jobs.map((job) => job.jobId), [jobId]);
    assert.equal(existsSync(lockDir), false);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index stale recovery preserves a successor owner during ABA quarantine", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-aba-"));
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "aba";
  const jobId = "job-20260611-033000-aba";
  const lockDir = path.join(dataRoot, "jobs-index.json.lock");
  try {
    await appendEvent(
      cpbRoot,
      project,
      jobId,
      {
        type: "job_created",
        jobId,
        project,
        task: "preserve successor lock",
        workflow: "standard",
        ts: "2026-06-11T03:30:00.000Z",
      },
      { dataRoot }
    );
    const current = exactCurrentProcessIdentityOrNull();
    if (!current) return;
    const predecessorBirthId = `${current.birthId}:aba-predecessor`;
    await writeJobsIndexLockOwner(lockDir, "predecessor-owner", {
      ...current,
      birthId: predecessorBirthId,
      incarnation: `${current.pid}:${predecessorBirthId}`,
    });
    const old = new Date(0);
    await utimes(lockDir, old, old);

    __jobsIndexLockTestHooks.afterQuarantineRename = async ({ lockDir: originalLockDir }) => {
      await mkdir(originalLockDir);
      await writeJobsIndexLockOwner(originalLockDir, "successor-owner");
    };
    __jobsIndexLockTestHooks.waitMs = 100;
    let quarantineDir = "";
    try {
      await assert.rejects(
        listJobsFromIndex(cpbRoot, { dataRoot }),
        (error: NodeJS.ErrnoException & {
          committed?: boolean;
          quarantinePreserved?: boolean;
          successorPreserved?: boolean;
          recoveryPaths?: { quarantine?: string };
        }) => {
          assert.equal(error.code, "DIRECTORY_LOCK_SUCCESSOR_PRESERVED");
          assert.equal(error.committed, true);
          assert.equal(error.quarantinePreserved, true);
          assert.equal(error.successorPreserved, true);
          quarantineDir = error.recoveryPaths?.quarantine || "";
          assert.ok(quarantineDir);
          return true;
        },
      );
    } finally {
      __jobsIndexLockTestHooks.afterQuarantineRename = undefined;
      __jobsIndexLockTestHooks.waitMs = undefined;
    }

    const successor = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
    assert.equal(successor.ownerToken, "successor-owner");
    const predecessor = JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8"));
    assert.equal(predecessor.ownerToken, "predecessor-owner");
  } finally {
    __jobsIndexLockTestHooks.afterQuarantineRename = undefined;
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index test hooks stay isolated across overlapping async scopes", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-hook-scope-"));
  const blockedRoot = path.join(cpbRoot, "blocked");
  const independentRoot = path.join(cpbRoot, "independent");
  const blockedLockDir = path.join(blockedRoot, "jobs-index.json.lock");
  try {
    await mkdir(blockedLockDir, { recursive: true });
    const old = new Date(0);
    await utimes(blockedLockDir, old, old);

    let observedBlockedScope!: () => void;
    const blockedScopeObserved = new Promise<void>((resolve) => { observedBlockedScope = resolve; });
    let resumeBlockedScope!: () => void;
    const blockedScopeResume = new Promise<void>((resolve) => { resumeBlockedScope = resolve; });
    let blockedObservations = 0;
    let independentObservations = 0;

    const blocked = withJobsIndexLockTestHooksForTests({
      afterRecoveryObserved: async () => {
        blockedObservations += 1;
        observedBlockedScope();
        await blockedScopeResume;
      },
    }, () => rebuildJobsIndex(cpbRoot, { dataRoot: blockedRoot }));

    await blockedScopeObserved;
    await withJobsIndexLockTestHooksForTests({
      afterRecoveryObserved: () => { independentObservations += 1; },
    }, () => rebuildJobsIndex(cpbRoot, { dataRoot: independentRoot }));
    resumeBlockedScope();
    await blocked;

    assert.equal(blockedObservations, 1);
    assert.equal(independentObservations, 0);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});
