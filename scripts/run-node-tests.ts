#!/usr/bin/env node
import type { LooseRecord } from "../shared/types.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { readdir } from "node:fs/promises";

// The runner lives inside dist-tests/scripts (or dist/scripts for legacy
// callers). Test modules belong to that compiled artifact, while their cwd
// contract is the source checkout one level above it. Keeping these roots
// separate prevents process.cwd()-based fixtures from accidentally resolving
// to dist-tests while still executing only compiled JavaScript.
const artifactRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.resolve(artifactRoot, "..");

function normalizeRequestedFile(arg: string): string {
  const resolved = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  let relative = path.relative(artifactRoot, resolved).split(path.sep).join("/");

  if (relative.startsWith("../")) {
    const cwdRelative = path.relative(process.cwd(), resolved).split(path.sep).join("/");
    const outputPrefix = ["dist-tests/", "dist/"].find((prefix) => cwdRelative.startsWith(prefix));
    relative = outputPrefix ? cwdRelative.slice(outputPrefix.length) : cwdRelative;
  }

  return relative.replace(/\.ts$/, ".js");
}

async function collectTestFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectTestFiles(full));
    } else if (entry.name.endsWith(".test.js")) {
      results.push(path.relative(artifactRoot, full).split(path.sep).join("/"));
    }
  }
  return results;
}

async function runTests(files: string[], opts: LooseRecord = {}) {
  const { concurrency = undefined, env: envOverrides = {}, label = "tests" } = opts;
  const args = ["--test", ...files.map((file) => path.resolve(artifactRoot, file))];
  if (concurrency !== undefined) {
    args.unshift(`--test-concurrency=${concurrency}`);
  }

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CPB_")) delete env[key];
  }
  env.CPB_WORKER_DISPATCH_ENABLED = "0";
  // Tests use fake agent pools; the default-on LLM checklist decomposition (a
  // real planner call in phase 3) is opt-in per test via process.env. Production
  // does not run through this script, so the default-on behavior is unchanged.
  env.CPB_CHECKLIST_DECOMPOSE = "0";
  Object.assign(env, envOverrides);

  console.log(`Running ${label}: ${files.length} file(s)`);
  return new Promise((resolve, reject) => {
    // detached:true makes the child its own process-group leader (child.pid is
    // the pgid). On a signal to the runner, process.kill(-pgid, "SIGKILL")
    // tears down the whole subtree (node --test plus the grandchildren it
    // spawns — git/npm/ACP). Without this, killing the runner (pkill, agent
    // crash, session exit) orphans node --test children that keep running and
    // contend for cpb-task/runtime state. SIGKILL on the runner itself still
    // escapes (cannot be caught), but SIGTERM/SIGINT/SIGHUP are covered.
    const child = spawn(process.execPath, args, {
      cwd: sourceRoot,
      stdio: "inherit",
      env,
      detached: true,
    });
    const killTree = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    };
    const onTerm = () => { killTree(); process.exit(130); };
    const onInt = () => { killTree(); process.exit(130); };
    const onHup = () => { killTree(); process.exit(129); };
    // Crash guard: if the runner itself exits (uncaught throw, OOM, SEGV —
    // 'exit' still fires, unlike SIGKILL), tear down the test subtree so it
    // cannot orphan and contend for cpb-task/runtime state.
    const onExit = () => { killTree(); };
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    process.on("SIGHUP", onHup);
    process.on("exit", onExit);

    // Watchdog: bound the subtree's runtime so a hung batch is closed on a
    // timer instead of leaking. CPB_TEST_TIMEOUT_MS (default 45m) must exceed
    // the slowest legitimate suite; 0 disables.
    const rawTimeout = process.env.CPB_TEST_TIMEOUT_MS;
    const parsed = rawTimeout !== undefined && rawTimeout !== ""
      ? Number.parseInt(rawTimeout, 10)
      : Number.NaN;
    const timeoutMs = Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : 45 * 60 * 1000;
    const watchdog = timeoutMs > 0 ? setTimeout(() => {
      console.error(`${label}: subtree exceeded ${timeoutMs}ms, killing it`);
      killTree();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs) : null;

    child.on("close", (code) => {
      if (watchdog) clearTimeout(watchdog);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      process.off("SIGHUP", onHup);
      process.off("exit", onExit);
      if (code !== 0) {
        reject(new Error(`${label} exited with code ${code}`));
      } else {
        resolve(code);
      }
    });
  });
}

const requestedFiles = process.argv.slice(2)
  .filter((arg) => !arg.startsWith("-"))
  .map(normalizeRequestedFile);

const discoveredFiles = requestedFiles.length > 0
  ? requestedFiles
  : await collectTestFiles(path.join(artifactRoot, "tests"));

// These suites validate optional benchmark/evaluation and release-rehearsal
// tooling. They are valuable coverage, but they are not part of the normal
// HubOrchestrator -> ManagedWorker delivery path. Keep them in the default
// full run while allowing the main-flow acceptance path to exclude them
// explicitly. The list is intentional and reviewable; do not infer it from
// file size alone.
const specializedTestFiles = new Set([
  "tests/coding-comparison.test.js",
  "tests/disposable-draft-pr-rehearsal.test.js",
  "tests/e2e-npm-pack-safety.test.js",
  "tests/live-release-evidence.test.js",
  "tests/plan-tournament.test.js",
  "tests/promote-live-release-evidence.test.js",
  "tests/swebench-batch-queue.test.js",
  "tests/swebench-plan-prompt.test.js",
  "tests/swebench-product-validation.test.js",
  "tests/swebench-three-way-runner.test.js",
]);

const mainOnly = process.argv.includes("--main");
const specializedOnly = process.argv.includes("--specialized");
const integrationOnly = process.argv.includes("--integration");
const listOnly = process.argv.includes("--list");
if ((mainOnly ? 1 : 0) + (specializedOnly ? 1 : 0) + (integrationOnly ? 1 : 0) > 1) {
  console.error("--main, --specialized, and --integration are mutually exclusive");
  process.exit(1);
}

// Integration suites spawn ACP, worker, Hub, and process-tree children. The
// main profile deliberately leaves them to the manual/release E2E lanes; a
// successful real task is the product-path check, while these suites are
// fault-injection and authority-boundary checks.
const mainFlowFiles = discoveredFiles.filter((file) => (
  !specializedTestFiles.has(file)
  && !file.startsWith("tests/integration/")
));

const allFiles = mainOnly
  ? mainFlowFiles
  : specializedOnly
    ? discoveredFiles.filter((file) => specializedTestFiles.has(file))
    : integrationOnly
      ? discoveredFiles.filter((file) => file.startsWith("tests/integration/"))
    : discoveredFiles;

if (allFiles.length === 0) {
  console.error(mainOnly
    ? "No main-flow Node test files found"
    : specializedOnly
      ? "No specialized Node test files found"
      : "No Node test files found");
  process.exit(1);
}

if (listOnly) {
  for (const file of allFiles) console.log(file);
  process.exit(0);
}

const integrationFiles = allFiles.filter((f) => f.startsWith("tests/integration/"));
const unitFiles = allFiles.filter((f) => !f.startsWith("tests/integration/"));

const isolatedUnitFiles = new Set([
  // Real process-group teardown test. It is unit-scoped source-wise, but it
  // depends on OS scheduler timing and must not compete with the full unit
  // suite's child-process load.
  "tests/process-tree.test.js",
  // These tests spawn real CLI processes with timeout assertions. Under the
  // parallel focused suite, CPU-heavy workflow tests can starve the child
  // process and turn the assertion into a harness timeout.
  "tests/patch-integrity.test.js",
  "tests/product-gate.test.js",
  // Spawns the quota delegate as a real Node child process and waits for a lock
  // file. Under the parallel unit suite, other process-heavy tests can starve
  // child startup long enough to look like a delegate readiness failure.
  "tests/quota-delegate.test.js",
  // Exercises the bounded Claude CLI transport with real child processes that
  // intentionally remain alive after emitting output, plus a real quota
  // delegate. Parallel process pressure can starve stream handling until the
  // transport's production timeout and turn successful early termination into
  // a false timeout.
  "tests/claude-glm-cli-transport.test.js",
  // Spawns trusted probe subprocesses with bounded timeouts. Under the full
  // parallel suite, process-heavy Hub tests can starve the probe long enough
  // to turn a successful command into a false timeout.
  "tests/checklist-verifier-gate.test.js",
  // Runs real syntax/test subprocesses through the verification hard gate.
  // Parallel process pressure can exhaust the bounded 30-second command
  // window and manufacture a verification failure even though the same
  // frozen candidate passes immediately in isolation.
  "tests/deterministic-light-verify.test.js",
  // Verifies that an idle hub socket is unref'd by observing child-process
  // exit timing; parallel process pressure can exceed its two-second bound.
  "tests/local-store-atomicity.test.js",
  // Exercises a cancellation boundary while two review DAG nodes must reach
  // the same wave. Parallel slow-suite load can starve one scheduler callback
  // long enough to make the test observe a false non-overlap failure.
  "tests/engine-prepare-task.test.js",
  // Spawns comparison-lane helpers whose cleanup promises can otherwise lose
  // their only event-loop handle under the parallel slow-suite load.
  "tests/coding-comparison.test.js",
  // Spawns concurrent jobs-index readers and removes their temporary runtime;
  // parallel process pressure can race cleanup with a child still publishing.
  "tests/jobs-index-concurrency.test.js",
  // Spawns nested Node processes with short timeout assertions; running under
  // the parallel focused suite can starve the child process enough to look like
  // a timeout instead of the intended exit-code assertion.
  "tests/verify-p0p1-runner.test.js",
  // Process-sensitive tests that spawn real child processes or manage process
  // trees. Parallel execution causes timing failures (ACP cleanup races and
  // process-tree signal conflicts).
  // These suites also create shared process/event-lock and disposable-root
  // state; under the slow batch their children can starve or race with the
  // authority probes even when they pass in isolation.
  "tests/checklist-decompose-integration.test.js",
  "tests/job-runner.test.js",
  "tests/swebench-three-way-runner.test.js",
  "tests/trace-log.test.js",
  "tests/hub-backup.test.js",
  "tests/hub-access-audit-archive.test.js",
  "tests/hub-maintenance.test.js",
  "tests/acp-process-cleanup.test.js",
  "tests/script-process-teardown.test.js",
  "tests/process-registry-incarnation.test.js",
  "tests/managed-worker-worktree-cleanup.test.js",
  "tests/review-dispatch-cancellation.test.js",
  "tests/review-dispatch-worktree-safety.test.js",
]);

// Bench-measured slow unit files (>1s standalone OR >30s timeout via per-file
// `node --test`; 67 files, measured 2026-07-24). They are spawn/git/npm/ACP
// E2E-flavored tests that live under tests/ (not tests/integration/) for
// historical reasons. --unit skips them for fast feedback; the default full
// run still executes them in a parallel batch, so CI coverage is unchanged.
// Five real-process files that need concurrency:1 isolation (rather than the
// parallel slow batch) live in isolatedUnitFiles above. Re-measure before
// editing: `node scripts/bench-test-files.mjs` (per-file, 30s cap each).
const slowUnitFiles = new Set([
  "tests/acp-connection-lease.test.js",
  "tests/acp-conversation-isolation.test.js",
  "tests/acp-pool-provider-scope.test.js",
  "tests/adversarial-round-5.test.js",
  "tests/agent-isolation-runtime-root.test.js",
  "tests/artifact-store-atomic.test.js",
  "tests/assignment-lock.test.js",
  "tests/assignment-reconciler.test.js",
  "tests/auto-finalizer.test.js",
  "tests/candidate-artifact.test.js",
  "tests/candidate-replay.test.js",
  "tests/checklist-decompose-integration.test.js",
  "tests/checklist-execution-map.test.js",
  "tests/checklist-prepare-dag.test.js",
  "tests/cli-runtime-contracts.test.js",
  "tests/coding-comparison.test.js",
  "tests/completion-gate-runner.test.js",
  "tests/completion-repair-loop.test.js",
  "tests/durable-directory-lock.test.js",
  "tests/engine-prepare-task.test.js",
  "tests/engine-provider-event.test.js",
  "tests/engine-run-job.test.js",
  "tests/event-store-durability.test.js",
  "tests/evolve-service.test.js",
  "tests/github-issue-queue.test.js",
  "tests/hub-access-audit-archive.test.js",
  "tests/hub-backup.test.js",
  "tests/hub-maintenance.test.js",
  "tests/hub-oidc.test.js",
  "tests/hub-registry-concurrency.test.js",
  "tests/hub-registry-receipt.test.js",
  "tests/hub-server-auth.test.js",
  "tests/job-recovery-hardening.test.js",
  "tests/job-recovery.test.js",
  "tests/job-runner.test.js",
  "tests/job-store.test.js",
  "tests/jobs-index-concurrency.test.js",
  "tests/leader-lock.test.js",
  "tests/lease-lock-incarnation.test.js",
  "tests/live-release-evidence.test.js",
  "tests/openclaw-proactive.test.js",
  "tests/probe-runner-nonstatic.test.js",
  "tests/promote-live-release-evidence.test.js",
  "tests/queue-orchestrator.test.js",
  "tests/recovery-chain-consistency.test.js",
  "tests/release-install-safety.test.js",
  "tests/scheduler-dag-provider.test.js",
  "tests/scheduler-modes.test.js",
  "tests/session-cache-lock.test.js",
  "tests/setup-snapshot-contract.test.js",
  "tests/strict-engine-gate.test.js",
  "tests/swebench-batch-queue.test.js",
  "tests/swebench-three-way-runner.test.js",
  "tests/temporary-workspace-safety.test.js",
  "tests/terminal-immutability.test.js",
  "tests/trace-log.test.js",
  "tests/verification-infrastructure.test.js",
  "tests/verify-plan-mode-contract.test.js",
  "tests/worker-store-lifecycle.test.js",
]);

const isolatedIntegrationFiles = new Set([
  // Exercises the CLI ACP client with multiple detached fake agents and
  // terminals. Under the parallel integration batch, Darwin process identity
  // probes can lose the short-lived child before its cleanup proof settles.
  "tests/integration/acp-client.test.js",
  "tests/integration/acp-test-agent.test.js",
  "tests/integration/managed-worker.test.js",
  "tests/integration/worker-supervisor.test.js",
  "tests/integration/reconcile.test.js",
]);
const isolatedUnitTestFiles = unitFiles.filter((f) => isolatedUnitFiles.has(f));
const slowUnitTestFiles = unitFiles.filter((f) => slowUnitFiles.has(f) && !isolatedUnitFiles.has(f));
// Fast parallel unit files = unit, minus real-process-isolated, minus slow.
const parallelUnitFiles = unitFiles.filter((f) => !isolatedUnitTestFiles.includes(f) && !slowUnitTestFiles.includes(f));
const isolatedFiles = integrationFiles.filter((f) => isolatedIntegrationFiles.has(f));
const parallelIntegrationFiles = integrationFiles.filter((f) => !isolatedFiles.includes(f));

// When --unit flag is passed, run only the fast parallel unit files.
// Slow (>1s) and real-process-isolated unit tests are skipped here and run
// via the default full `npm test`, so coverage is unchanged.
const unitOnly = process.argv.includes("--unit");
// When --integration flag is passed, only run integration tests

try {
  if (unitOnly) {
    // Fast feedback path: only quick parallel unit files. Slow + isolated
    // unit tests run via the default full `npm test`.
    if (parallelUnitFiles.length > 0) {
      await runTests(parallelUnitFiles, { label: "unit tests (fast)" });
    }
  } else if (integrationOnly) {
    // Parallel-safe integration tests
    if (parallelIntegrationFiles.length > 0) {
      await runTests(parallelIntegrationFiles, { label: "integration tests" });
    }
    // Real-process integration tests need isolation from parallel load.
    if (isolatedFiles.length > 0) {
      await runTests(isolatedFiles, { concurrency: 1, label: "isolated integration tests" });
    }
  } else {
    // Default: run everything
    // Unit tests: fast files run in parallel; slow (>1s) files run in their
    // own parallel batch; real-process-isolated files run serially.
    if (parallelUnitFiles.length > 0) {
      await runTests(parallelUnitFiles, { label: "unit tests (fast)" });
    }
    if (slowUnitTestFiles.length > 0) {
      await runTests(slowUnitTestFiles, { concurrency: 4, label: "unit tests (slow)" });
    }
    if (isolatedUnitTestFiles.length > 0) {
      await runTests(isolatedUnitTestFiles, { concurrency: 1, label: "isolated unit tests" });
    }
    // Parallel-safe integration tests
    if (parallelIntegrationFiles.length > 0) {
      await runTests(parallelIntegrationFiles, { label: "integration tests" });
    }
    // Isolated integration tests (serial)
    if (isolatedFiles.length > 0) {
      await runTests(isolatedFiles, { concurrency: 1, label: "isolated integration tests" });
    }
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
