import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function findEventFile(cpbRoot, project) {
  const eventsDir = path.join(cpbRoot, "cpb-task", "events", project);
  const entries = await readdir(eventsDir);
  const jsonl = entries.find((e) => e.endsWith(".jsonl"));
  if (!jsonl) return null;
  return path.join(eventsDir, jsonl);
}

async function readJsonlEvents(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("blocked workflow writes execution_boundary with sourcePath and cwd", async () => {
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-blocked-src-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-blocked-cpb-"));
  const canonical = await realpath(sourcePath);
  const project = "blocked-meta-test";

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "bridges/run-pipeline.mjs",
    "--project", project,
    "--task", "test blocked metadata",
    "--source-path", sourcePath,
    "--workflow", "blocked",
  ], { cwd: process.cwd(), env: { ...process.env, CPB_ROOT: cpbRoot } });

  const eventFile = await findEventFile(cpbRoot, project);
  assert.ok(eventFile, "event file should exist after blocked workflow");

  const events = await readJsonlEvents(eventFile);
  const boundaries = events.filter((e) => e.type === "execution_boundary");
  const boundary = boundaries[0];

  assert.ok(boundary, "execution_boundary event should exist in blocked workflow");
  assert.equal(boundaries.length, 1, "blocked workflow should emit one execution_boundary event");
  assert.equal(boundary.sourcePath, canonical);
  assert.equal(boundary.cwd, canonical);
  assert.equal(boundary.project, project);
  assert.ok(boundary.jobId, "execution_boundary should have jobId");
  assert.ok(boundary.ts, "execution_boundary should have ts");

  // sessionId and workerId should be explicit null when not set via env
  assert.equal(boundary.sessionId, null);
  assert.equal(boundary.workerId, null);
});

test("blocked workflow carries CPB_SESSION_ID and CPB_WORKER_ID in execution_boundary", async () => {
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-blocked-env-src-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-blocked-env-cpb-"));
  const canonical = await realpath(sourcePath);
  const project = "blocked-env-test";

  await execFileAsync(process.execPath, [
    "bridges/run-pipeline.mjs",
    "--project", project,
    "--task", "test env metadata",
    "--source-path", sourcePath,
    "--workflow", "blocked",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CPB_ROOT: cpbRoot,
      CPB_SESSION_ID: "sess-from-env",
      CPB_WORKER_ID: "worker-from-env",
    },
  });

  const eventFile = await findEventFile(cpbRoot, project);
  assert.ok(eventFile);

  const events = await readJsonlEvents(eventFile);
  const boundary = events.find((e) => e.type === "execution_boundary");

  assert.ok(boundary);
  assert.equal(boundary.sessionId, "sess-from-env");
  assert.equal(boundary.workerId, "worker-from-env");
  assert.equal(boundary.sourcePath, canonical);
  assert.equal(boundary.cwd, canonical);
});

test("blocked workflow without sourcePath omits execution_boundary event", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-blocked-nosrc-cpb-"));
  const project = "blocked-nosrc-test";

  await execFileAsync(process.execPath, [
    "bridges/run-pipeline.mjs",
    "--project", project,
    "--task", "test no source",
    "--workflow", "blocked",
  ], { cwd: process.cwd(), env: { ...process.env, CPB_ROOT: cpbRoot } });

  const eventFile = await findEventFile(cpbRoot, project);
  if (!eventFile) return; // no events at all is acceptable

  const events = await readJsonlEvents(eventFile);
  const boundary = events.find((e) => e.type === "execution_boundary");
  assert.equal(boundary, undefined, "execution_boundary should not exist without sourcePath");
});
