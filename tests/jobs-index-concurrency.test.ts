import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendEvent } from "../server/services/event/event-store.js";
import { listJobsFromIndex, readJobsIndex, rebuildJobsIndex } from "../server/services/job/job-store.js";

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
    await writeFile(
      path.join(lockDir, "lock.json"),
      `${JSON.stringify({
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        ownerPid: 999_999,
        ownerToken: "external-owner",
      })}\n`,
      "utf8"
    );

    const release = setTimeout(() => {
      rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }, 1_500);
    const start = Date.now();
    try {
      const jobs = await listJobsFromIndex(cpbRoot, { dataRoot });
      assert(Date.now() - start >= 1_250);
      assert.deepEqual(jobs.map((job) => job.jobId), [jobId]);
    } finally {
      clearTimeout(release);
    }
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index readers do not steal a stale lock from a live owner process", async () => {
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
    await writeFile(
      path.join(lockDir, "lock.json"),
      `${JSON.stringify({
        acquiredAt: "2000-01-01T00:00:00.000Z",
        heartbeatAt: "2000-01-01T00:00:00.000Z",
        ownerPid: process.pid,
        ownerToken: "live-owner",
      })}\n`,
      "utf8"
    );

    const release = setTimeout(() => {
      rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }, 1_500);
    const start = Date.now();
    try {
      const jobs = await listJobsFromIndex(cpbRoot, { dataRoot });
      assert(Date.now() - start >= 1_250);
      assert.deepEqual(jobs.map((job) => job.jobId), [jobId]);
    } finally {
      clearTimeout(release);
    }
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});
