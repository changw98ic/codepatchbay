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
    const child = spawn(process.execPath, args, {
      cwd: sourceRoot,
      stdio: "inherit",
      env,
    });

    child.on("close", (code) => {
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

const allFiles = requestedFiles.length > 0
  ? requestedFiles
  : await collectTestFiles(path.join(artifactRoot, "tests"));

if (allFiles.length === 0) {
  console.error("No Node test files found");
  process.exit(1);
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
  // Verifies that an idle Redis socket is unref'd by observing child-process
  // exit timing; parallel process pressure can exceed its two-second bound.
  "tests/hub-state-redis.test.js",
  // Spawns nested Node processes with short timeout assertions; running under
  // the parallel focused suite can starve the child process enough to look like
  // a timeout instead of the intended exit-code assertion.
  "tests/verify-p0p1-runner.test.js",
]);

const isolatedIntegrationFiles = new Set([
  "tests/integration/acp-test-agent.test.js",
  "tests/integration/managed-worker.test.js",
  "tests/integration/worker-supervisor.test.js",
  "tests/integration/reconcile.test.js",
]);
const isolatedUnitTestFiles = unitFiles.filter((f) => isolatedUnitFiles.has(f));
const parallelUnitFiles = unitFiles.filter((f) => !isolatedUnitTestFiles.includes(f));
const isolatedFiles = integrationFiles.filter((f) => isolatedIntegrationFiles.has(f));
const parallelIntegrationFiles = integrationFiles.filter((f) => !isolatedFiles.includes(f));

// When --unit flag is passed, only run unit tests (fast, <15s)
const unitOnly = process.argv.includes("--unit");
// When --integration flag is passed, only run integration tests
const integrationOnly = process.argv.includes("--integration");

try {
  if (unitOnly) {
    if (parallelUnitFiles.length > 0) {
      await runTests(parallelUnitFiles, { label: "unit tests" });
    }
    if (isolatedUnitTestFiles.length > 0) {
      await runTests(isolatedUnitTestFiles, { concurrency: 1, label: "isolated unit tests" });
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
    // Unit tests: run in parallel, except real-process tests that need
    // isolation from child-process load.
    if (parallelUnitFiles.length > 0) {
      await runTests(parallelUnitFiles, { label: "unit tests" });
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
