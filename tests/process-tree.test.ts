/**
 * Tests for core/runtime/process-tree.ts — detached process-group command runner
 * with SIGTERM→SIGKILL teardown on timeout/abort and registry-injection hooks.
 *
 * Mirrors the SIGINT/SIGKILL teardown style of tests/integration/reconcile.test.ts:610.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCommandTree, killTree } from "../core/runtime/process-tree.js";

async function makeCwd() {
  return mkdtemp(join(tmpdir(), "process-tree-"));
}

const HANG = `setInterval(()=>{}, 10000)`;

test("runCommandTree: normal exit returns exitCode + stdout", async () => {
  const cwd = await makeCwd();
  const r = await runCommandTree("node", ["-e", "process.stdout.write('hi'); process.exit(0)"], { cwd });
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.aborted, false);
  assert.match(r.stdout, /hi/);
});

test("runCommandTree: non-zero exit propagates", async () => {
  const cwd = await makeCwd();
  const r = await runCommandTree("node", ["-e", "process.exit(3)"], { cwd });
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
});

test("runCommandTree: timeout kills the process and flags timedOut", async () => {
  const cwd = await makeCwd();
  const r = await runCommandTree("node", ["-e", HANG], { cwd, timeoutMs: 300, graceMs: 200 });
  assert.equal(r.timedOut, true);
  assert.equal(r.aborted, false);
  // killed by signal → exitCode resolved as 1 (null code)
  assert.equal(r.exitCode, 1);
});

test("runCommandTree: abort signal kills the process and flags aborted", async () => {
  const cwd = await makeCwd();
  const ac = new AbortController();
  const pending = runCommandTree("node", ["-e", HANG], { cwd, signal: ac.signal, graceMs: 200 });
  setTimeout(() => ac.abort(), 200);
  const r = await pending;
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 1);
});

test("runCommandTree: onSpawn receives the child pid", async () => {
  const cwd = await makeCwd();
  let spawnedPid: number | null = null;
  const r = await runCommandTree("node", ["-e", "process.exit(0)"], {
    cwd,
    onSpawn: (pid) => { spawnedPid = pid; },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(typeof spawnedPid, "number");
  assert.ok((spawnedPid as number) > 0);
});

test("runCommandTree: onExit receives pid + code", async () => {
  const cwd = await makeCwd();
  let exitPid: number | null = null;
  let exitCode: number | null = null;
  const r = await runCommandTree("node", ["-e", "process.exit(0)"], {
    cwd,
    onExit: (pid, code) => { exitPid = pid; exitCode = code; },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(exitCode, 0);
  assert.equal(typeof exitPid, "number");
});

test("runCommandTree: timeout tears down the whole process group (grandchild reaped)", async () => {
  // Parent spawns a grandchild that stays in the parent's process group (default —
  // NOT detached, so it inherits the parent pgid). On timeout, killTree(-parentPid)
  // must reap the grandchild too. (A detached grandchild would setsid into its own
  // group and escape — that is NOT the hard-gate scenario we are guarding.)
  const cwd = await makeCwd();
  const script = `const cp=require('child_process');const g=cp.spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});g.unref();process.stdout.write(String(g.pid));setInterval(()=>{},10000);`;
  const r = await runCommandTree("node", ["-e", script], { cwd, timeoutMs: 1000, graceMs: 500 });
  assert.equal(r.timedOut, true);
  const grandchildPid = Number.parseInt(r.stdout, 10);
  assert.ok(Number.isFinite(grandchildPid) && grandchildPid > 0, `grandchild pid captured: ${r.stdout}`);
  // Allow grace + signal propagation, then the grandchild must be dead.
  await new Promise((res) => setTimeout(res, 1000));
  let alive = true;
  try { process.kill(grandchildPid, 0); } catch { alive = false; }
  assert.equal(alive, false, "grandchild in the process group must be reaped by killTree");
});

test("killTree: direct call is a no-op on a missing pid", () => {
  // A very large pid is essentially guaranteed not to exist; killTree must not throw.
  assert.doesNotThrow(() => killTree(999999, 50));
});
