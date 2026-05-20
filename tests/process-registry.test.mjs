#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  registerProcess,
  updateHeartbeat,
  markExited,
  addChildPid,
  getProcess,
  listProcesses,
  classifyLiveness,
  cleanProcesses,
  stopProcess,
} from "../server/services/process-registry.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-proc-reg-"));

// registerProcess
const entry = await registerProcess(root, {
  jobId: "job-test-001",
  project: "demo",
  phase: "plan",
  runnerPid: process.pid,
  command: "echo hello",
});
assert.equal(entry.jobId, "job-test-001");
assert.equal(entry.project, "demo");
assert.equal(entry.runnerPid, process.pid);
assert.equal(entry.status, "running");
assert.ok(Array.isArray(entry.childPids));
console.log("registerProcess: OK");

// getProcess
const fetched = await getProcess(root, "job-test-001");
assert.equal(fetched.jobId, "job-test-001");
assert.equal(fetched.status, "running");
console.log("getProcess: OK");

// updateHeartbeat
const updated = await updateHeartbeat(root, "job-test-001");
assert.ok(new Date(updated.lastHeartbeat).getTime() >= new Date(entry.lastHeartbeat).getTime());
console.log("updateHeartbeat: OK");

// addChildPid
const withChild = await addChildPid(root, "job-test-001", 99999);
assert.ok(withChild.childPids.includes(99999));
const withChild2 = await addChildPid(root, "job-test-001", 88888);
assert.ok(withChild2.childPids.includes(99999));
assert.ok(withChild2.childPids.includes(88888));
// duplicate ignored
const withChild3 = await addChildPid(root, "job-test-001", 99999);
assert.equal(withChild3.childPids.filter(p => p === 99999).length, 1);
console.log("addChildPid: OK");

// classifyLiveness - alive (current process)
const liveness = classifyLiveness(fetched);
assert.equal(liveness, "alive");
console.log("classifyLiveness (alive): OK");

// classifyLiveness - exited
const exitedEntry = { ...fetched, status: "exited" };
assert.equal(classifyLiveness(exitedEntry), "exited");
console.log("classifyLiveness (exited): OK");

// classifyLiveness - stale
const staleEntry = { ...fetched, lastHeartbeat: new Date(Date.now() - 300_000).toISOString() };
assert.equal(classifyLiveness(staleEntry), "stale");
console.log("classifyLiveness (stale): OK");

// classifyLiveness - null
assert.equal(classifyLiveness(null), "unknown");
console.log("classifyLiveness (null): OK");

// listProcesses
const all = await listProcesses(root);
assert.equal(all.length, 1);
assert.equal(all[0].jobId, "job-test-001");
console.log("listProcesses: OK");

// markExited
const exited = await markExited(root, "job-test-001", { exitCode: 0 });
assert.equal(exited.status, "exited");
assert.equal(exited.exitCode, 0);
console.log("markExited: OK");

// register a second process for list/clean
await registerProcess(root, { jobId: "job-test-002", project: "demo", runnerPid: 999999 });

// cleanProcesses - should clean exited and orphan (999999 is dead)
const cleanResult = await cleanProcesses(root);
assert.ok(cleanResult.removed.includes("job-test-001"), "exited entry should be cleaned");
assert.ok(cleanResult.removed.includes("job-test-002"), "orphan entry should be cleaned");
console.log("cleanProcesses: OK");

// verify cleaned
const afterClean = await listProcesses(root);
assert.equal(afterClean.length, 0);
console.log("cleanProcesses (verified empty): OK");

// cleanProcesses dry-run
await registerProcess(root, { jobId: "job-test-003", project: "demo", runnerPid: 999998 });
const dryRun = await cleanProcesses(root, { dryRun: true });
assert.equal(dryRun.dryRun, true);
assert.equal(dryRun.removed.length, 0);
assert.ok(dryRun.eligible.length >= 1);
console.log("cleanProcesses (dry-run): OK");

// ID validation
try {
  await registerProcess(root, { jobId: "../etc/passwd", project: "demo" });
  assert.fail("should have thrown");
} catch (e) {
  assert.ok(e.message.includes("invalid jobId"));
}
console.log("ID validation: OK");

// stopProcess on already exited appends process_stop_skipped event
{
  await registerProcess(root, { jobId: "job-stop-skip", project: "test-proj", runnerPid: 999999 });
  await markExited(root, "job-stop-skip", { exitCode: 0 });
  const result = await stopProcess(root, "job-stop-skip");
  assert.equal(result.stopped, false);
  assert.match(result.reason, /already exited/);
  const eventFile = path.join(root, "cpb-task", "events", "test-proj", "job-stop-skip.jsonl");
  const raw = await readFile(eventFile, "utf8");
  const events = raw.trim().split("\n").filter(Boolean).map(JSON.parse);
  const skipEvent = events.find(e => e.type === "process_stop_skipped");
  assert.ok(skipEvent, "should have process_stop_skipped event");
  assert.equal(skipEvent.jobId, "job-stop-skip");
  assert.equal(skipEvent.project, "test-proj");
  assert.equal(skipEvent.runnerPid, 999999);
  assert.match(skipEvent.reason, /already exited/);
  console.log("stopProcess (already exited -> process_stop_skipped): OK");
}

// Cleanup
await rm(root, { recursive: true, force: true });
console.log("All process-registry tests passed.");
