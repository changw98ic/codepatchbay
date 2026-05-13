#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLease } from "../server/services/lease-manager.js";
import { spawnFile } from "./helpers/spawn-file.mjs";

const runner = path.resolve("bridges/job-runner.mjs");

async function readJobEvents(root, project = "demo", jobId = "job-1") {
  const eventFile = path.join(root, "flow-task", "events", project, `${jobId}.jsonl`);
  const raw = await readFile(eventFile, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

{
  const root = await mkdtemp(path.join(tmpdir(), "flow-job-runner-success-"));
  const result = await spawnFile(process.execPath, [
    runner,
    "--flow-root",
    root,
    "--project",
    "demo",
    "--job-id",
    "job-1",
    "--phase",
    "plan",
    "--script",
    "node",
    "--",
    "-e",
    "console.log('fake plan complete'); console.error('fake stderr stream')",
  ], { cwd: path.resolve(".") });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fake plan complete/);
  assert.match(result.stderr, /fake stderr stream/);

  const events = await readJobEvents(root);
  // May include phase_activity events from child output
  assert.ok(events.length >= 2);
  assert.equal(events[0].type, "phase_started");
  assert.equal(events[0].jobId, "job-1");
  assert.equal(events[0].phase, "plan");
  assert.equal(events[0].leaseId, "lease-job-1-plan");
  const completed = events.find(e => e.type === "phase_completed");
  assert.ok(completed);
  assert.equal(completed.exitCode, 0);
  assert.equal(await readLease(root, "lease-job-1-plan"), null);
}

{
  const root = await mkdtemp(path.join(tmpdir(), "flow-job-runner-failed-"));
  const result = await spawnFile(process.execPath, [
    runner,
    "--flow-root",
    root,
    "--project",
    "demo",
    "--job-id",
    "job-2",
    "--phase",
    "execute",
    "--script",
    "node",
    "--",
    "-e",
    "console.error('child failed'); process.exit(7)",
  ], { cwd: path.resolve(".") });

  assert.equal(result.code, 7);
  assert.match(result.stderr, /child failed/);

  const events = await readJobEvents(root, "demo", "job-2");
  assert.ok(events.length >= 2);
  assert.equal(events[0].type, "phase_started");
  const failed = events.find(e => e.type === "phase_failed");
  assert.ok(failed);
  assert.equal(failed.exitCode, 7);
  assert.equal(await readLease(root, "lease-job-2-execute"), null);
}

{
  const root = await mkdtemp(path.join(tmpdir(), "flow-job-runner-spawn-error-"));
  const result = await spawnFile(process.execPath, [
    runner,
    "--flow-root",
    root,
    "--project",
    "demo",
    "--job-id",
    "job-3",
    "--phase",
    "verify",
    "--script",
    "definitely-not-a-flow-command",
    "--",
    "--ignored",
  ], { cwd: path.resolve(".") });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /failed to spawn definitely-not-a-flow-command/i);

  const events = await readJobEvents(root, "demo", "job-3");
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "phase_started");
  assert.equal(events[1].type, "phase_failed");
  assert.match(events[1].error, /ENOENT|spawn/i);
  assert.equal(await readLease(root, "lease-job-3-verify"), null);
}

{
  const root = await mkdtemp(path.join(tmpdir(), "flow-job-runner-args-"));
  const result = await spawnFile(process.execPath, [
    runner,
    "--flow-root",
    root,
    "--project",
    "demo",
    "--job-id",
    "job-4",
    "--phase",
    "plan",
    "--",
    "-e",
    "console.log('missing script should not run')",
  ], { cwd: path.resolve(".") });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing required argument: --script/i);
  await assert.rejects(
    () => readFile(path.join(root, "flow-task", "events", "demo", "job-4.jsonl"), "utf8"),
    { code: "ENOENT" }
  );
}
