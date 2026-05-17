#!/usr/bin/env node
// validate-scan-readiness.mjs — Bounded operational validation for multi-project scan
// under simulated 429/backoff pressure.
//
// Usage:
//   node bridges/validate-scan-readiness.mjs                # dry-run with temp dirs
//   node bridges/validate-scan-readiness.mjs --live         # validate against real hub root
//   node bridges/validate-scan-readiness.mjs --hub-root DIR # validate specific hub root
//   node bridges/validate-scan-readiness.mjs --json         # machine-readable output
//
// Checks:
//   1. Queue integrity: loads/parses, valid state machine
//   2. Queue status surfaces: correct pending/in_progress/completed counts
//   3. Rate-limit backoff: 429 → durable backoff → pool respects it
//   4. Concurrency bounds: pool never exceeds configured limits
//   5. Multi-project scan under 429: backoff propagates across projects
//   6. Process growth bound: pool tracks active requests, no leak after release

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AcpPool, RateLimitError } from "./acp-pool.mjs";
import { enqueue, loadQueue, queueStatus, updateEntry } from "../server/services/hub-queue.js";
import { resolveHubRoot } from "../server/services/hub-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { live: false, hubRoot: null, json: false, verbose: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--live") opts.live = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "--hub-root") {
      const v = args[++i];
      if (!v || v.startsWith("--")) throw new Error("missing value for --hub-root");
      opts.hubRoot = v;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function makeTempHub() {
  return mkdtemp(path.join(os.tmpdir(), "cpb-val-"));
}

async function seedQueue(hubRoot, entries) {
  for (const e of entries) {
    await enqueue(hubRoot, {
      projectId: e.projectId || "test-project",
      sourcePath: e.sourcePath || "/tmp/fake",
      description: e.description || `issue-${Math.random().toString(36).slice(2, 6)}`,
      priority: e.priority || "P2",
      type: e.type || "candidate",
    });
  }
}

function makeFakeProjects(n) {
  const projects = [];
  for (let i = 0; i < n; i++) {
    projects.push({
      projectId: `proj-${i}`,
      sourcePath: `/tmp/fake-${i}`,
      description: `scan-issue-${i}`,
      priority: i === 0 ? "P0" : "P2",
    });
  }
  return projects;
}

// ── Checks (each gets an isolated hubRoot) ───────────────────────────────────

export async function checkQueueIntegrity(hubRoot) {
  const projects = makeFakeProjects(5);
  await seedQueue(hubRoot, projects);
  const queue = await loadQueue(hubRoot);
  if (!queue || !Array.isArray(queue.entries)) return { pass: false, detail: "queue did not parse" };
  if (queue.entries.length < 5) return { pass: false, detail: `expected >=5 entries, got ${queue.entries.length}` };
  for (const e of queue.entries) {
    if (e.status !== "pending") return { pass: false, detail: `entry ${e.id} not pending: ${e.status}` };
    if (!e.projectId) return { pass: false, detail: `entry ${e.id} missing projectId` };
  }
  return { pass: true, detail: `${queue.entries.length} entries, all pending with valid state` };
}

export async function checkQueueStatusSurfaces(hubRoot) {
  await seedQueue(hubRoot, [
    { projectId: "a", description: "a-1" },
    { projectId: "a", description: "a-2" },
    { projectId: "b", description: "b-1" },
  ]);
  const status = await queueStatus(hubRoot);
  if (status.pending !== 3) return { pass: false, detail: `expected 3 pending, got ${status.pending}` };

  const queue = await loadQueue(hubRoot);
  const target = queue.entries[0];
  await updateEntry(hubRoot, target.id, { status: "in_progress" });
  const after = await queueStatus(hubRoot);
  if (after.pending !== 2 || after.inProgress !== 1) {
    return { pass: false, detail: `after transition: pending=${after.pending} in_progress=${after.inProgress}` };
  }
  return { pass: true, detail: `pending→in_progress correct: ${JSON.stringify(after)}` };
}

export async function checkRateLimitBackoff(hubRoot) {
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    backoffMs: 5_000,
    runner: async () => { throw new Error("429 rate limit: retry after 5 seconds"); },
  });

  try {
    await pool.execute("codex", "trigger-429");
    return { pass: false, detail: "429 runner should have thrown" };
  } catch (err) {
    if (!(err instanceof RateLimitError)) {
      return { pass: false, detail: `expected RateLimitError, got ${err.name}: ${err.message}` };
    }
  }

  try {
    await pool.execute("codex", "should-reject");
    return { pass: false, detail: "should have rejected during backoff" };
  } catch (err) {
    if (!(err instanceof RateLimitError)) {
      return { pass: false, detail: `backoff rejection not RateLimitError: ${err.name}` };
    }
  }

  const st = pool.status().pools.codex;
  if (!st.rateLimitedUntil || st.rateLimitedUntil <= Date.now()) {
    return { pass: false, detail: `rateLimitedUntil not in future: ${st.rateLimitedUntil}` };
  }

  return { pass: true, detail: `429 → RateLimitError, backoff until ${new Date(st.rateLimitedUntil).toISOString()}` };
}

export async function checkConcurrencyBounds(hubRoot) {
  let maxActive = 0;
  let currentActive = 0;
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 2 },
    runner: async () => {
      currentActive++;
      maxActive = Math.max(maxActive, currentActive);
      await new Promise((r) => setTimeout(r, 30));
      currentActive--;
      return "ok";
    },
  });

  const promises = [];
  for (let i = 0; i < 6; i++) {
    promises.push(pool.execute("codex", `concurrent-${i}`));
  }
  const results = await Promise.all(promises);

  if (results.some((r) => r !== "ok")) return { pass: false, detail: "some executions failed" };
  if (maxActive > 2) return { pass: false, detail: `maxActive=${maxActive} exceeded limit of 2` };

  const st = pool.status().pools.codex;
  if (st.active !== 0) return { pass: false, detail: `active=${st.active} after all resolved (leak)` };

  return { pass: true, detail: `6 tasks, limit 2, maxActive=${maxActive}, active now=${st.active}` };
}

export async function checkMultiProjectScanUnder429(hubRoot) {
  let callCount = 0;
  const rateLimitedProjects = new Set();

  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    backoffMs: 30_000,
    runner: async ({ prompt }) => {
      callCount++;
      if (prompt.includes("proj-1")) {
        throw new Error("429 rate limit exceeded for proj-1");
      }
      return "[ISSUE] P2 normal finding";
    },
  });

  const projects = [
    { id: "proj-0", sourcePath: "/tmp/fake-0", name: "proj-0", enabled: true },
    { id: "proj-1", sourcePath: "/tmp/fake-1", name: "proj-1", enabled: true },
    { id: "proj-2", sourcePath: "/tmp/fake-2", name: "proj-2", enabled: true },
  ];

  for (const project of projects) {
    try {
      await pool.execute("codex", `scan-${project.id}`, project.sourcePath, 5_000);
    } catch (err) {
      if (err instanceof RateLimitError) {
        project.rateLimitedUntil = err.untilTs;
        rateLimitedProjects.add(project.id);
      }
    }
  }

  const st = pool.status().pools.codex;
  if (!st.rateLimitedUntil) return { pass: false, detail: "expected global rate-limit after proj-1 429" };

  const blocked = projects.filter((p) => p.rateLimitedUntil).length;
  if (blocked === 0) return { pass: false, detail: "no projects marked rate-limited after 429" };

  return {
    pass: true,
    detail: `scanned ${projects.length} projects, ${blocked} blocked by backoff, callCount=${callCount}`,
  };
}

export async function checkProcessGrowthBound(hubRoot) {
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1, claude: 1 },
    runner: async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "ok";
    },
  });

  for (let i = 0; i < 20; i++) {
    const handle = await pool.acquire("codex");
    const st = pool.status().pools.codex;
    if (st.active > 1) {
      handle.release();
      return { pass: false, detail: `active=${st.active} exceeded limit=1 at iteration ${i}` };
    }
    handle.release();
  }

  let totalActive = 0;
  for (const p of Object.values(pool.status().pools)) totalActive += p.active;

  if (totalActive !== 0) return { pass: false, detail: `leaked ${totalActive} active slots after 20 cycles` };

  const codexActive = pool.status().pools.codex.active;
  const claudeActive = pool.status().pools.claude.active;
  return { pass: true, detail: `20 acquire/release cycles, active=0 after (codex=${codexActive}, claude=${claudeActive})` };
}

// ── Runner ───────────────────────────────────────────────────────────────────

export const ALL_CHECKS = [
  { name: "queue-integrity", fn: checkQueueIntegrity },
  { name: "queue-status-surfaces", fn: checkQueueStatusSurfaces },
  { name: "rate-limit-backoff", fn: checkRateLimitBackoff },
  { name: "concurrency-bounds", fn: checkConcurrencyBounds },
  { name: "multi-project-scan-429", fn: checkMultiProjectScanUnder429 },
  { name: "process-growth-bound", fn: checkProcessGrowthBound },
];

export async function runChecks(hubRootFactory, opts = {}) {
  const results = [];
  for (const check of ALL_CHECKS) {
    const isolatedHub = typeof hubRootFactory === "function" ? await hubRootFactory() : hubRootFactory;
    try {
      const result = await check.fn(isolatedHub);
      results.push({ name: check.name, ...result });
    } catch (err) {
      results.push({ name: check.name, pass: false, detail: `UNEXPECTED: ${err.message}` });
    } finally {
      if (typeof hubRootFactory === "function") {
        try { await rm(isolatedHub, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }
  return results;
}

export function formatResults(results, { json: asJson } = {}) {
  if (asJson) return JSON.stringify(results, null, 2);

  const lines = [];
  let allPass = true;
  for (const r of results) {
    const icon = r.pass ? "PASS" : "FAIL";
    if (!r.pass) allPass = false;
    lines.push(`  [${icon}] ${r.name}: ${r.detail}`);
  }
  lines.push("");
  lines.push(allPass ? "  All checks passed." : "  Some checks FAILED.");
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage: node bridges/validate-scan-readiness.mjs [options]

Options:
  --live            Validate against real hub root (requires --hub-root)
  --hub-root DIR    Use specific hub root (default: temp dir in dry-run)
  --json            Machine-readable JSON output
  --verbose         Verbose output
  --help            Show this help

Default mode is dry-run: uses temp dirs, no network, no real provider.
Use --live --hub-root DIR to validate real state.`);
    process.exit(0);
  }

  let hubRootOrFactory;
  if (opts.live) {
    const hubRoot = opts.hubRoot || resolveHubRoot();
    console.error(`[validate] Live mode: hub-root=${hubRoot}`);
    hubRootOrFactory = hubRoot;
  } else {
    if (opts.verbose) console.error("[validate] Dry-run mode: isolated temp dirs per check");
    hubRootOrFactory = makeTempHub;
  }

  const results = await runChecks(hubRootOrFactory, opts);
  console.log(formatResults(results, opts));

  const allPass = results.every((r) => r.pass);
  process.exit(allPass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[validate] fatal: ${err.message}`);
    process.exit(2);
  });
}
