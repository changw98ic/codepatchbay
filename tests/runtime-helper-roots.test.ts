import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { ingestEvent, listCandidates, updateCandidate } from "../server/services/event-source.js";
import { appendEvent } from "../server/services/event-store.js";
import { buildLocator, eventLogPath } from "../server/services/phase-locator.js";
import { recordPerformance, getAgentPerformance } from "../server/services/performance-tracker.js";
import { registerProject } from "../server/services/hub-registry.js";
import { tempRoot } from "./helpers.js";

async function assertMissing(filePath: string) {
  await assert.rejects(() => stat(filePath), { code: "ENOENT" });
}

test("performance tracker requires explicit project runtime root and does not create source cpb-task", async () => {
  const root = await tempRoot("cpb-performance-root");
  const cpbRoot = path.join(root, "source");
  const previousRuntimeRoot = process.env.CPB_PROJECT_RUNTIME_ROOT;
  delete process.env.CPB_PROJECT_RUNTIME_ROOT;

  try {
    await mkdir(cpbRoot, { recursive: true });
    await assert.rejects(
      () => recordPerformance(cpbRoot, "flow", "job-20260611-100000-perf", {
        agent: "codex",
        role: "executor",
        phase: "execute",
        status: "completed",
        ts: "2026-06-11T10:00:00.000Z",
      }),
      /dataRoot is required/,
    );
    await assert.rejects(
      () => getAgentPerformance(cpbRoot, "codex"),
      /dataRoot is required/,
    );
    await assertMissing(path.join(cpbRoot, "cpb-task"));
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    } else {
      process.env.CPB_PROJECT_RUNTIME_ROOT = previousRuntimeRoot;
    }
  }
});

test("performance tracker writes only to explicit project runtime root and ignores ambient env", async () => {
  const root = await tempRoot("cpb-performance-env");
  const cpbRoot = path.join(root, "source");
  const dataRoot = path.join(root, "hub", "projects", "flow");
  const poisonedRoot = path.join(root, "poisoned-project-runtime");
  const previousRuntimeRoot = process.env.CPB_PROJECT_RUNTIME_ROOT;
  process.env.CPB_PROJECT_RUNTIME_ROOT = poisonedRoot;

  try {
    await mkdir(cpbRoot, { recursive: true });
    await recordPerformance(cpbRoot, "flow", "job-20260611-100500-perf", {
      agent: "codex",
      role: "executor",
      phase: "execute",
      status: "completed",
      ts: "2026-06-11T10:05:00.000Z",
      dataRoot,
    });

    const metrics = await getAgentPerformance(cpbRoot, "codex", { dataRoot });
    assert.equal(metrics.totalRequests, 1);
    assert.match(await readFile(path.join(dataRoot, "performance", "codex.jsonl"), "utf8"), /"project":"flow"/);
    await assertMissing(path.join(poisonedRoot, "performance"));
    await assertMissing(path.join(cpbRoot, "cpb-task"));
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    } else {
      process.env.CPB_PROJECT_RUNTIME_ROOT = previousRuntimeRoot;
    }
  }
});

test("event source candidate queue is control-plane data and ignores project runtime env", async () => {
  const root = await tempRoot("cpb-event-source-root");
  const cpbRoot = path.join(root, "source");
  const hubRoot = path.join(root, "hub");
  const poisonedRoot = path.join(root, "poisoned-project-runtime");
  const previousRuntimeRoot = process.env.CPB_PROJECT_RUNTIME_ROOT;
  process.env.CPB_PROJECT_RUNTIME_ROOT = poisonedRoot;

  try {
    await mkdir(cpbRoot, { recursive: true });
    const entry = await ingestEvent(cpbRoot, {
      source: "github-issue",
      externalId: "issue-42",
      projectId: "flow",
      payload: { title: "Fix onboarding" },
    }, { hubRoot });

    assert.equal((await listCandidates(cpbRoot, { hubRoot })).length, 1);
    await updateCandidate(cpbRoot, entry.id, { status: "queued", reason: "test" }, { hubRoot });

    const queue = JSON.parse(await readFile(path.join(hubRoot, "event-sources", "candidates.json"), "utf8"));
    assert.equal(queue[0].status, "queued");
    await assertMissing(path.join(poisonedRoot, "event-sources"));
    await assertMissing(path.join(cpbRoot, "cpb-task"));
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    } else {
      process.env.CPB_PROJECT_RUNTIME_ROOT = previousRuntimeRoot;
    }
  }
});

test("phase locator job evidence requires registered runtime root and ignores ambient env", async () => {
  const root = await tempRoot("cpb-phase-locator-root");
  const cpbRoot = path.join(root, "source");
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "repo");
  const dataRoot = path.join(hubRoot, "projects", "flow");
  const poisonedRoot = path.join(root, "poisoned-project-runtime");
  const previousRuntimeRoot = process.env.CPB_PROJECT_RUNTIME_ROOT;
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  process.env.CPB_PROJECT_RUNTIME_ROOT = poisonedRoot;
  process.env.CPB_HUB_ROOT = hubRoot;

  try {
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(sourcePath, { recursive: true });
    await writeFile(path.join(sourcePath, "package.json"), "{}\n", "utf8");
    await registerProject(hubRoot, {
      id: "flow",
      sourcePath,
      projectRuntimeRoot: dataRoot,
      skipCodeGraphGate: true,
    });
    await appendEvent(cpbRoot, "flow", "job-20260611-101000-phase", {
      type: "job_created",
      jobId: "job-20260611-101000-phase",
      project: "flow",
      task: "runtime locator",
      workflow: "standard",
      ts: "2026-06-11T10:10:00.000Z",
    }, { dataRoot });

    assert.throws(
      () => eventLogPath(cpbRoot, "flow", "job-20260611-101000-phase"),
      /dataRoot is required/,
    );
    assert.equal(
      eventLogPath(cpbRoot, "flow", "job-20260611-101000-phase", { dataRoot }),
      path.join(dataRoot, "events", "flow", "job-20260611-101000-phase.jsonl"),
    );

    const locator = await buildLocator(cpbRoot, "flow", "job-20260611-101000-phase", { hubRoot });
    assert.equal(locator.stateRoot, dataRoot);
    assert.equal(locator.eventLogPath, path.join(dataRoot, "events", "flow", "job-20260611-101000-phase.jsonl"));
    await assertMissing(path.join(poisonedRoot, "events"));
    await assertMissing(path.join(cpbRoot, "cpb-task"));
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    } else {
      process.env.CPB_PROJECT_RUNTIME_ROOT = previousRuntimeRoot;
    }
    if (previousHubRoot === undefined) {
      delete process.env.CPB_HUB_ROOT;
    } else {
      process.env.CPB_HUB_ROOT = previousHubRoot;
    }
  }
});
