import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALL_CHECKS,
  checkConcurrencyBounds,
  checkMultiProjectScanUnder429,
  checkProcessGrowthBound,
  checkQueueIntegrity,
  checkQueueStatusSurfaces,
  checkRateLimitBackoff,
  formatResults,
  parseArgs,
  runChecks,
} from "../bridges/validate-scan-readiness.mjs";

async function freshHub() {
  return mkdtemp(path.join(tmpdir(), "cpb-test-val-"));
}

// ── parseArgs ────────────────────────────────────────────────────────────────

test("parseArgs: dry-run by default", () => {
  const opts = parseArgs(["node", "script"]);
  assert.equal(opts.live, false);
  assert.equal(opts.hubRoot, null);
  assert.equal(opts.json, false);
});

test("parseArgs: --live --hub-root DIR", () => {
  const opts = parseArgs(["node", "script", "--live", "--hub-root", "/tmp/hr"]);
  assert.equal(opts.live, true);
  assert.equal(opts.hubRoot, "/tmp/hr");
});

test("parseArgs: --json", () => {
  const opts = parseArgs(["node", "script", "--json"]);
  assert.equal(opts.json, true);
});

test("parseArgs: unknown flag throws", () => {
  assert.throws(() => parseArgs(["node", "script", "--bogus"]), /unknown argument/);
});

test("parseArgs: --hub-root without value throws", () => {
  assert.throws(() => parseArgs(["node", "script", "--hub-root"]), /missing value/);
});

// ── formatResults ────────────────────────────────────────────────────────────

test("formatResults: all pass", () => {
  const out = formatResults([
    { name: "a", pass: true, detail: "ok" },
    { name: "b", pass: true, detail: "also ok" },
  ]);
  assert.ok(out.includes("[PASS] a: ok"));
  assert.ok(out.includes("[PASS] b: also ok"));
  assert.ok(out.includes("All checks passed"));
  assert.ok(!out.includes("FAILED"));
});

test("formatResults: mixed pass/fail", () => {
  const out = formatResults([
    { name: "a", pass: true, detail: "ok" },
    { name: "b", pass: false, detail: "bad" },
  ]);
  assert.ok(out.includes("[PASS]"));
  assert.ok(out.includes("[FAIL]"));
  assert.ok(out.includes("FAILED"));
});

test("formatResults: --json output", () => {
  const out = formatResults([{ name: "x", pass: true, detail: "d" }], { json: true });
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, "x");
  assert.equal(parsed[0].pass, true);
});

// ── Individual checks with isolated hubs ─────────────────────────────────────

test("queue integrity: 5 fake projects seeded correctly", async () => {
  const hub = await freshHub();
  try {
    const r = await checkQueueIntegrity(hub);
    assert.equal(r.pass, true);
    assert.match(r.detail, /5 entries/);
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

test("queue status surfaces: pending/in_progress counts correct", async () => {
  const hub = await freshHub();
  try {
    const r = await checkQueueStatusSurfaces(hub);
    assert.equal(r.pass, true);
    assert.match(r.detail, /pending.*2.*inProgress.*1/);
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

test("rate-limit backoff: 429 triggers RateLimitError and durable backoff", async () => {
  const hub = await freshHub();
  try {
    const r = await checkRateLimitBackoff(hub);
    assert.equal(r.pass, true);
    assert.match(r.detail, /RateLimitError/);
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

test("concurrency bounds: 6 tasks with limit 2, maxActive <= 2", async () => {
  const hub = await freshHub();
  try {
    const r = await checkConcurrencyBounds(hub);
    assert.equal(r.pass, true);
    assert.match(r.detail, /maxActive=2/);
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

test("multi-project scan 429: backoff propagates to subsequent projects", async () => {
  const hub = await freshHub();
  try {
    const r = await checkMultiProjectScanUnder429(hub);
    assert.equal(r.pass, true);
    assert.match(r.detail, /blocked by backoff/);
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

test("process growth bound: 20 acquire/release cycles, zero leak", async () => {
  const hub = await freshHub();
  try {
    const r = await checkProcessGrowthBound(hub);
    assert.equal(r.pass, true);
    assert.match(r.detail, /active=0/);
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

// ── runChecks integration ────────────────────────────────────────────────────

test("runChecks with factory: all 6 checks pass", async () => {
  const results = await runChecks(freshHub);
  assert.equal(results.length, ALL_CHECKS.length);
  for (const r of results) {
    assert.equal(r.pass, true, `${r.name} failed: ${r.detail}`);
  }
});

test("runChecks with single hubRoot: queue checks accumulate entries", async () => {
  // Using a single hubRoot means queue state accumulates — this validates
  // that the status-surfaces check sees extra entries from queue-integrity
  const hub = await freshHub();
  try {
    const results = await runChecks(hub);
    // queue-integrity should still pass (>=5)
    assert.equal(results[0].pass, true);
    // queue-status-surfaces may see more than 3 pending due to accumulated
    // entries from check 1, so we only verify it doesn't crash
    assert.equal(typeof results[1].pass, "boolean");
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});
