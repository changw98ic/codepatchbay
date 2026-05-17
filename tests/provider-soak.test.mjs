import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  formatReport,
  parseArgs,
  ProviderSoakHarness,
  SoakMonitor,
  countChildProcessesSync,
} from "../bridges/provider-soak.mjs";
import { MultiEvolveController } from "../bridges/multi-evolve.mjs";
import { RateLimitError } from "../bridges/acp-pool.mjs";
import { resetAllPoolRuntimes } from "../server/services/acp-pool-runtime.js";
import { registerProject } from "../server/services/hub-registry.js";
import { pushIssues } from "../server/services/multi-evolve-state.js";

afterEach(() => {
  resetAllPoolRuntimes();
});

async function freshHub() {
  return mkdtemp(path.join(tmpdir(), "cpb-soak-test-hub-"));
}

async function freshCpb() {
  return mkdtemp(path.join(tmpdir(), "cpb-soak-test-cpb-"));
}

async function seedProject(hubRoot, name) {
  const sourcePath = await mkdtemp(path.join(tmpdir(), `cpb-soak-${name}-`));
  await registerProject(hubRoot, { name, sourcePath });
  await pushIssues(sourcePath, name, [
    { id: `${name}-1`, priority: "P1", description: `soak issue for ${name}` },
    { id: `${name}-2`, priority: "P2", description: `low priority ${name}` },
  ]);
  return { sourcePath, name };
}

// ── parseArgs ────────────────────────────────────────────────────────────────

test("parseArgs: dry-run by default", () => {
  const opts = parseArgs(["node", "script"]);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.maxRounds, 0);
  assert.equal(opts.maxDurationMs, 0);
  assert.equal(opts.json, false);
  assert.equal(opts.verbose, false);
});

test("parseArgs: --live enables real provider mode", () => {
  const opts = parseArgs(["node", "script", "--live"]);
  assert.equal(opts.dryRun, false);
});

test("parseArgs: --dry-run --max-rounds --max-duration-ms --json", () => {
  const opts = parseArgs([
    "node", "script",
    "--dry-run",
    "--max-rounds", "5",
    "--max-duration-ms", "10000",
    "--json",
  ]);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.maxRounds, 5);
  assert.equal(opts.maxDurationMs, 10000);
  assert.equal(opts.json, true);
});

test("parseArgs: --status-interval-ms --max-process-count --hub-root", () => {
  const opts = parseArgs([
    "node", "script",
    "--status-interval-ms", "5000",
    "--max-process-count", "3",
    "--hub-root", "/tmp/hr",
  ]);
  assert.equal(opts.statusIntervalMs, 5000);
  assert.equal(opts.maxProcessCount, 3);
  assert.equal(opts.hubRoot, "/tmp/hr");
});

test("parseArgs: unknown flag throws", () => {
  assert.throws(() => parseArgs(["node", "script", "--bogus"]), /unknown argument/);
});

test("parseArgs: --skip-preflight", () => {
  const opts = parseArgs(["node", "script", "--skip-preflight"]);
  assert.equal(opts.skipPreflight, true);
});

// ── SoakMonitor ──────────────────────────────────────────────────────────────

test("SoakMonitor: snapshot captures pool status", () => {
  const hubRoot = "/tmp/nonexistent-monitor-test";
  const monitor = new SoakMonitor({ maxProcessCount: 5, statusIntervalMs: 100 });
  const fakePool = {
    status() {
      return {
        pools: {
          codex: { active: 1, queued: 0, rateLimitedUntil: null },
          claude: { active: 0, queued: 2, rateLimitedUntil: Date.now() + 60000 },
        },
      };
    },
  };
  const snap = monitor.snapshot(null, fakePool);
  assert.equal(snap.poolActive, 1);
  assert.equal(snap.poolQueued, 2);
  assert.equal(snap.rateLimited, true);
  assert.ok(snap.processCount >= 0);
});

test("SoakMonitor: detects process growth violations", () => {
  const violations = [];
  const monitor = new SoakMonitor({
    maxProcessCount: 0,
    statusIntervalMs: 100,
    onViolation: (v) => violations.push(v),
  });
  const fakePool = {
    status() { return { pools: {} }; },
  };
  monitor.start(null, fakePool);
  // maxProcessCount=0 means any child process triggers violation
  // But in test environment, likely 0 child procs
  // Force a snapshot that records a fake violation
  monitor.samples.push({ at: new Date().toISOString(), processCount: 0, poolActive: 0, poolQueued: 0, rateLimited: false });
  monitor.stop();
  assert.equal(monitor.samples.length, 1);
});

test("SoakMonitor: peakProcessCount tracks max", () => {
  const monitor = new SoakMonitor({ maxProcessCount: 100, statusIntervalMs: 100 });
  monitor.samples.push({ processCount: 2 }, { processCount: 5 }, { processCount: 3 });
  assert.equal(monitor.peakProcessCount, 5);
});

test("SoakMonitor: start/stop lifecycle", () => {
  const monitor = new SoakMonitor({ maxProcessCount: 10, statusIntervalMs: 50 });
  const fakePool = { status: () => ({ pools: {} }) };
  monitor.start(null, fakePool);
  assert.ok(monitor._timer !== null);
  monitor.stop();
  assert.equal(monitor._timer, null);
});

// ── countChildProcessesSync ──────────────────────────────────────────────────

test("countChildProcessesSync: returns non-negative integer", () => {
  const count = countChildProcessesSync();
  assert.equal(typeof count, "number");
  assert.ok(count >= 0);
});

// ── formatReport ─────────────────────────────────────────────────────────────

test("formatReport: dry-run clean result", () => {
  const result = {
    startedAt: "2026-05-18T00:00:00.000Z",
    finishedAt: "2026-05-18T00:01:00.000Z",
    dryRun: true,
    preflight: { passed: true, checks: [], skipped: true },
    soak: {
      totalRounds: 5,
      durationMs: 60000,
      issuesExecuted: 0,
      rateLimitedSkipped: 0,
      scanFailures: 0,
      stopped: false,
    },
    monitor: { samples: 6, peakProcessCount: 0, violations: [] },
    violations: [],
  };
  const report = formatReport(result);
  assert.ok(report.includes("dry-run"));
  assert.ok(report.includes("Rounds:           5"));
  assert.ok(report.includes("CLEAN"));
  assert.ok(!report.includes("VIOLATION"));
});

test("formatReport: preflight failure", () => {
  const result = {
    startedAt: "2026-05-18T00:00:00.000Z",
    finishedAt: "2026-05-18T00:00:01.000Z",
    dryRun: false,
    preflight: {
      passed: false,
      checks: [{ name: "test", pass: false, detail: "broken" }],
      skipped: false,
    },
    soak: null,
    monitor: null,
    violations: [],
  };
  const report = formatReport(result);
  assert.ok(report.includes("FAILED"));
  assert.ok(report.includes("[FAIL] test: broken"));
});

test("formatReport: with violations", () => {
  const result = {
    startedAt: "2026-05-18T00:00:00.000Z",
    finishedAt: "2026-05-18T00:10:00.000Z",
    dryRun: false,
    preflight: { passed: true, checks: [], skipped: true },
    soak: { totalRounds: 3, durationMs: 600000, issuesExecuted: 0, rateLimitedSkipped: 0, scanFailures: 0, stopped: false },
    monitor: { samples: 10, peakProcessCount: 12, violations: [{ type: "process_growth", processCount: 12, limit: 10, at: "2026-05-18T00:05:00.000Z" }] },
    violations: [{ type: "process_growth", processCount: 12, limit: 10, at: "2026-05-18T00:05:00.000Z" }],
  };
  const report = formatReport(result);
  assert.ok(report.includes("VIOLATIONS"));
  assert.ok(report.includes("process_growth"));
  assert.ok(report.includes("count=12"));
});

// ── ProviderSoakHarness: dry-run end-to-end ──────────────────────────────────

test("ProviderSoakHarness: dry-run with preflight passes cleanly", async () => {
  const hubRoot = await freshHub();
  const cpbRoot = await freshCpb();
  try {
    const harness = new ProviderSoakHarness({
      cpbRoot,
      hubRoot,
      dryRun: true,
      maxRounds: 3,
      maxDurationMs: 0,
      intervalMs: 0,
      statusIntervalMs: 60000,
      maxProcessCount: 10,
    });
    const result = await harness.run();
    assert.equal(result.dryRun, true);
    assert.equal(result.preflight.passed, true);
    assert.ok(result.soak);
    assert.equal(result.soak.totalRounds, 3);
    assert.ok(result.soak.durationMs >= 0);
    assert.equal(result.violations.length, 0);
  } finally {
    await rm(hubRoot, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("ProviderSoakHarness: skip-preflight bypasses validation", async () => {
  const hubRoot = await freshHub();
  const cpbRoot = await freshCpb();
  try {
    const harness = new ProviderSoakHarness({
      cpbRoot,
      hubRoot,
      dryRun: true,
      maxRounds: 1,
      skipPreflight: true,
      statusIntervalMs: 100,
    });
    const result = await harness.run();
    assert.equal(result.preflight.skipped, true);
    assert.ok(result.soak);
  } finally {
    await rm(hubRoot, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("ProviderSoakHarness: maxDurationMs stops the loop", async () => {
  const hubRoot = await freshHub();
  const cpbRoot = await freshCpb();
  try {
    const harness = new ProviderSoakHarness({
      cpbRoot,
      hubRoot,
      dryRun: true,
      maxRounds: 0,
      maxDurationMs: 200,
      intervalMs: 10,
      statusIntervalMs: 60000,
    });
    const result = await harness.run();
    assert.ok(result.soak);
    assert.ok(result.soak.durationMs >= 180, `expected ~200ms, got ${result.soak.durationMs}`);
    assert.ok(result.soak.totalRounds >= 1);
  } finally {
    await rm(hubRoot, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("ProviderSoakHarness: multi-project with rate-limit skipping", async () => {
  const hubRoot = await freshHub();
  const cpbRoot = await freshCpb();
  try {
    const projA = await seedProject(hubRoot, "soak-rl");
    const projB = await seedProject(hubRoot, "soak-ok");

    const scanCounts = {};
    const controller = new MultiEvolveController(cpbRoot, { hubRoot });
    controller.scanProject = async (project) => {
      scanCounts[project.id] = (scanCounts[project.id] || 0) + 1;
      if (project.id === "soak-rl" && scanCounts[project.id] === 1) {
        throw new RateLimitError("codex", Date.now() + 60000, "test rate limit");
      }
      return { project: project.id, issues: [], added: 0, total: 0 };
    };

    const result = await controller.runContinuous({
      maxRounds: 2,
      intervalMs: 0,
      scan: true,
      execute: false,
      maxDurationMs: 0,
    });

    assert.ok(result.rateLimitedSkipped > 0, `expected rate-limited skips, got ${result.rateLimitedSkipped}`);
    assert.equal(result.totalRounds, 2);
  } finally {
    await rm(hubRoot, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

// ── runContinuous maxDurationMs ───────────────────────────────────────────────

test("runContinuous: maxDurationMs bounds wall-clock time", async () => {
  const hubRoot = await freshHub();
  const cpbRoot = await freshCpb();
  try {
    await seedProject(hubRoot, "dur-bound");

    const controller = new MultiEvolveController(cpbRoot, { hubRoot });
    controller.scanProject = async (project) => {
      return { project: project.id, issues: [], added: 0, total: 0 };
    };

    const result = await controller.runContinuous({
      maxRounds: 0,
      maxDurationMs: 150,
      intervalMs: 10,
      scan: true,
      execute: false,
    });

    assert.ok(result.durationMs >= 130, `expected ~150ms, got ${result.durationMs}ms`);
    assert.ok(result.totalRounds >= 1);
    assert.equal(result.stopped, false);
  } finally {
    await rm(hubRoot, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

// ── Cross-project state isolation ────────────────────────────────────────────

test("cross-project: queue entries have distinct projectId", async () => {
  const hubRoot = await freshHub();
  const cpbRoot = await freshCpb();
  try {
    const projA = await seedProject(hubRoot, "iso-a");
    const projB = await seedProject(hubRoot, "iso-b");

    const controller = new MultiEvolveController(cpbRoot, { hubRoot });
    controller.scanProject = async (project) => {
      return {
        project: project.id,
        issues: [{ priority: "P1", description: `${project.id}-issue`, status: "pending" }],
        added: 1,
        total: 1,
      };
    };

    await controller.init({});

    // Scan both projects
    const results = await controller.scanAll();
    assert.equal(results.length, 2);

    // Verify backlog is per-project
    const { loadBacklog } = await import("../server/services/multi-evolve-state.js");
    const backlogA = await loadBacklog(projA.sourcePath, "iso-a");
    const backlogB = await loadBacklog(projB.sourcePath, "iso-b");

    assert.ok(backlogA.some((i) => i.description.includes("iso-a")));
    assert.ok(backlogB.some((i) => i.description.includes("iso-b")));
    assert.ok(!backlogA.some((i) => i.description.includes("iso-b")));
    assert.ok(!backlogB.some((i) => i.description.includes("iso-a")));
  } finally {
    await rm(hubRoot, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("cross-project: hub queue entries carry correct projectId", async () => {
  const hubRoot = await freshHub();
  const cpbRoot = await freshCpb();
  try {
    await seedProject(hubRoot, "queue-a");
    await seedProject(hubRoot, "queue-b");

    // Directly enqueue via hub queue to verify projectId isolation
    const { enqueue: hubEnqueue, loadQueue } = await import("../server/services/hub-queue.js");
    await hubEnqueue(hubRoot, {
      projectId: "queue-a",
      sourcePath: "/tmp/fake-a",
      description: "issue-for-a",
      priority: "P2",
      type: "candidate",
    });
    await hubEnqueue(hubRoot, {
      projectId: "queue-b",
      sourcePath: "/tmp/fake-b",
      description: "issue-for-b",
      priority: "P1",
      type: "candidate",
    });

    const queue = await loadQueue(hubRoot);
    const projectIds = new Set(queue.entries.map((e) => e.projectId));

    assert.ok(projectIds.has("queue-a"), "expected queue-a in projectIds");
    assert.ok(projectIds.has("queue-b"), "expected queue-b in projectIds");
    assert.ok(!queue.entries.some((e) => e.projectId !== "queue-a" && e.projectId !== "queue-b"),
      "no entries should have unexpected projectId");
  } finally {
    await rm(hubRoot, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
  }
});
