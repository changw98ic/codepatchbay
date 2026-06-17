import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendEvent, listEventFiles, readEvents, readEventsReadOnly } from "../server/services/event/event-store.js";

test("readEvents keeps project runtime roots strict unless legacy fallback is explicit", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-read-fallback-"));
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const jobId = "job-20260611-050000-legacy";
  try {
    await mkdir(path.join(cpbRoot, "cpb-task", "events", "flow"), { recursive: true });
    await writeFile(path.join(cpbRoot, "cpb-task", "events", "flow", `${jobId}.jsonl`), JSON.stringify({
      type: "job_created",
      jobId,
      project: "flow",
      task: "legacy event only",
      workflow: "standard",
      ts: "2026-06-11T05:00:00.000Z",
    }) + "\n", "utf8");

    assert.deepEqual(await readEvents(cpbRoot, "flow", jobId, { dataRoot }), []);
    assert.deepEqual(await readEventsReadOnly(cpbRoot, "flow", jobId, { dataRoot }), []);
    assert.equal((await readEvents(cpbRoot, "flow", jobId, { dataRoot, includeLegacyFallback: true })).length, 1);
    assert.equal((await readEvents(cpbRoot, "flow", jobId, { includeLegacyFallback: true })).length, 1);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("project event paths fail closed when dataRoot is missing", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-missing-root-"));
  const jobId = "job-20260611-050500-missing";
  try {
    await assert.rejects(
      () => appendEvent(cpbRoot, "flow", jobId, {
        type: "job_created",
        jobId,
        project: "flow",
        task: "missing root",
        workflow: "standard",
        ts: "2026-06-11T05:05:00.000Z",
      }),
      /dataRoot is required/,
    );
    await assert.rejects(
      () => readEvents(cpbRoot, "flow", jobId),
      /dataRoot is required/,
    );
    await assert.rejects(
      () => readEventsReadOnly(cpbRoot, "flow", jobId),
      /dataRoot is required/,
    );
    await assert.rejects(
      () => listEventFiles(cpbRoot),
      /dataRoot is required/,
    );
    await assert.rejects(() => stat(path.join(cpbRoot, "cpb-task")), { code: "ENOENT" });
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("appendEvent writes only to explicit project runtime root and ignores ambient env", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-explicit-root-"));
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const envRoot = path.join(cpbRoot, "poisoned-env-root");
  const jobId = "job-20260611-050700-runtime";
  const previousRuntimeRoot = process.env.CPB_PROJECT_RUNTIME_ROOT;
  process.env.CPB_PROJECT_RUNTIME_ROOT = envRoot;
  try {
    await appendEvent(cpbRoot, "flow", jobId, {
      type: "job_created",
      jobId,
      project: "flow",
      task: "project root job",
      workflow: "standard",
      ts: "2026-06-11T05:07:00.000Z",
    }, { dataRoot });

    assert.equal(
      await readFile(path.join(dataRoot, "events", "flow", `${jobId}.jsonl`), "utf8"),
      JSON.stringify({
        type: "job_created",
        jobId,
        project: "flow",
        task: "project root job",
        workflow: "standard",
        ts: "2026-06-11T05:07:00.000Z",
      }) + "\n",
    );
    await assert.rejects(() => stat(path.join(envRoot, "events")), { code: "ENOENT" });
    await assert.rejects(() => stat(path.join(cpbRoot, "cpb-task")), { code: "ENOENT" });
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    } else {
      process.env.CPB_PROJECT_RUNTIME_ROOT = previousRuntimeRoot;
    }
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("appendEvent with a project runtime root seals only the target event stream", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-write-fallback-"));
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const jobId = "job-20260611-051000-legacy";
  try {
    await mkdir(path.join(cpbRoot, "cpb-task", "events", "flow"), { recursive: true });
    await writeFile(path.join(cpbRoot, "cpb-task", "events", "flow", `${jobId}.jsonl`), [
      JSON.stringify({
        type: "job_created",
        jobId,
        project: "flow",
        task: "legacy terminal",
        workflow: "standard",
        ts: "2026-06-11T05:10:00.000Z",
      }),
      JSON.stringify({
        type: "job_completed",
        jobId,
        project: "flow",
        ts: "2026-06-11T05:10:01.000Z",
      }),
      "",
    ].join("\n"), "utf8");

    const written = await appendEvent(cpbRoot, "flow", jobId, {
      type: "job_created",
      jobId,
      project: "flow",
      task: "project root job",
      workflow: "standard",
      ts: "2026-06-11T05:10:02.000Z",
    }, { dataRoot });

    assert.equal((written as any)?.task, "project root job");
    const projectEvents = await readEvents(cpbRoot, "flow", jobId, { dataRoot, includeLegacyFallback: false });
    assert.equal(projectEvents.length, 1);
    assert.equal(projectEvents[0].task, "project root job");
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});
