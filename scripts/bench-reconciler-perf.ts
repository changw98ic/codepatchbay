#!/usr/bin/env node
// P0 performance baseline (cpb-perf-arch-debt-2026-07-23.md).
// Measures the two suspected hot paths against real (ORICO APFS) disk:
//   1. reconcileAssignments tick cost vs N assignments (tick budget = 2s)
//   2. readJobProjection cost vs event count (checkpoint only validates, not shortcuts)
// Output: docs/product/evidence/perf-baseline-2026-07-23.json

import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import { WorkerStore } from "../shared/orchestrator/worker-store.js";
import { Reconciler } from "../server/orchestrator/reconciler.js";
import { enqueue } from "../server/services/hub/hub-queue.js";
import { appendEvent, readJobProjection } from "../server/services/event/event-store.js";
import { createJob } from "../server/services/job/job-store.js";

const TICK_BUDGET_MS = 2000;

function pct(frac: number, arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * frac))];
}

async function benchReconcile(N: number, runs = 5) {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-bench-rec-"));
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  for (let i = 0; i < N; i++) {
    const entry = await enqueue(hubRoot, { projectId: "bench", description: `job-${i}` });
    const a = await assignments.getOrCreateAssignmentForEntry({
      entryId: entry.id,
      projectId: "bench",
      task: `job-${i}`,
    });
    await assignments.createAttempt(a.assignmentId, { workerId: `w-${i % 4}`, orchestratorEpoch: 1 });
  }
  const rec = new Reconciler(hubRoot, {
    assignmentStore: assignments,
    workerStore: workers,
    leaderLock: { stillHeld: async () => true },
    failureRouter: { resetBudget: () => {}, route: async () => ({ action: "mark_failed", reason: "bench" }) },
  });
  await rec.reconcileAssignments(); // warmup (also exercises store caches)
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    await rec.reconcileAssignments();
    times.push(performance.now() - t0);
  }
  return {
    assignments: N,
    runs,
    meanMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
    p50Ms: +pct(0.5, times).toFixed(2),
    p99Ms: +pct(0.99, times).toFixed(2),
  };
}

async function benchReadProjection(eventCount: number, runs = 5) {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-bench-read-"));
  const dataRoot = path.join(hubRoot, "runtime");
  const project = "bench-proj";
  const now = () => new Date().toISOString();
  const job = await createJob(hubRoot, { project, task: "bench", workflow: "standard", ts: now(), dataRoot });
  const base: Record<string, unknown> = { jobId: job.jobId, project };
  await appendEvent(hubRoot, project, job.jobId, {
    ...base,
    type: "workflow_dag_materialized",
    workflow: "standard",
    workflowDag: { name: "bench", nodes: [{ id: "plan", phase: "plan", dependsOn: [] }] },
    ts: now(),
  }, { dataRoot });
  for (let i = 0; i < eventCount; i++) {
    await appendEvent(hubRoot, project, job.jobId, {
      ...base,
      type: i % 2 ? "dag_node_completed" : "phase_result",
      nodeId: `n${i % 5}`,
      phase: "execute",
      status: "passed",
      ts: now(),
    }, { dataRoot });
  }
  await readJobProjection(hubRoot, project, job.jobId, { dataRoot }); // warmup
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    await readJobProjection(hubRoot, project, job.jobId, { dataRoot });
    times.push(performance.now() - t0);
  }
  return {
    eventCount: eventCount + 1,
    runs,
    meanMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
    p50Ms: +pct(0.5, times).toFixed(2),
    p99Ms: +pct(0.99, times).toFixed(2),
  };
}

async function main() {
  const disk = process.env.CPB_BENCH_DISK_NOTE || "ORICO external APFS (assumed)";
  console.log(`bench environment: ${process.platform} / ${process.version} / ${disk}`);

  console.log("\n[1] reconcileAssignments tick cost:");
  const reconcileResults = [];
  for (const N of [10, 50, 100, 200]) {
    const r = await benchReconcile(N);
    reconcileResults.push(r);
    const over = r.p99Ms > TICK_BUDGET_MS ? "  ⚠️ p99 OVER BUDGET" : "";
    console.log(`    N=${String(N).padStart(3)}: mean=${r.meanMs}ms p50=${r.p50Ms}ms p99=${r.p99Ms}ms (budget ${TICK_BUDGET_MS}ms)${over}`);
  }

  console.log("\n[2] readJobProjection cost:");
  const readResults = [];
  for (const E of [10, 100, 1000, 5000]) {
    const r = await benchReadProjection(E);
    readResults.push(r);
    console.log(`    events=${String(r.eventCount).padStart(5)}: mean=${r.meanMs}ms p50=${r.p50Ms}ms p99=${r.p99Ms}ms`);
  }

  const report = {
    benchmarkedAt: new Date().toISOString(),
    environment: { platform: process.platform, node: process.version, disk },
    tickBudgetMs: TICK_BUDGET_MS,
    reconcileAssignments: reconcileResults,
    readJobProjection: readResults,
    notes: [
      "reconcileAssignments uses getActiveAttempt (assignment-store), NOT getJob — so it does not trigger readJobProjection.",
      "readJobProjection materializes the full event log every call even with a checkpoint (checkpoint validates via CHECKPOINT_REPLAY_MISMATCH, not a perf shortcut).",
    ],
  };
  const outDir = "docs/product/evidence";
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "perf-baseline-2026-07-23.json");
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nwrote ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exitCode = 1;
});
