#!/usr/bin/env node
// @ts-nocheck
import { spawn } from "node:child_process";
import path from "node:path";
import { glob } from "glob";

const repoRoot = path.resolve(import.meta.dirname, "..");

function normalizeRequestedFile(arg) {
  const resolved = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  let relative = path.relative(repoRoot, resolved).split(path.sep).join("/");

  if (relative.startsWith("../")) {
    const cwdRelative = path.relative(process.cwd(), resolved).split(path.sep).join("/");
    relative = cwdRelative.startsWith("dist/")
      ? cwdRelative.slice("dist/".length)
      : cwdRelative;
  }

  return relative.replace(/\.ts$/, ".js");
}

async function runTests(files, opts = {}) {
  const { concurrency = undefined, env: envOverrides = {}, label = "tests" } = opts;
  const args = ["--test", ...files];
  if (concurrency !== undefined) {
    args.unshift(`--test-concurrency=${concurrency}`);
  }

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CPB_")) delete env[key];
  }
  env.CPB_WORKER_DISPATCH_ENABLED = "0";
  Object.assign(env, envOverrides);

  console.log(`Running ${label}: ${files.length} file(s)`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
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
  : await glob("tests/**/*.test.js", { cwd: repoRoot });

if (allFiles.length === 0) {
  console.error("No Node test files found");
  process.exit(1);
}

const browserFiles = allFiles.filter((f) => f.startsWith("tests/browser/"));
const integrationFiles = allFiles.filter((f) => f.startsWith("tests/integration/"));
const unitFiles = allFiles.filter((f) => !f.startsWith("tests/browser/") && !f.startsWith("tests/integration/"));

const isolatedIntegrationFiles = new Set([
  "tests/integration/acp-test-agent.test.js",
  "tests/integration/managed-worker.test.js",
  "tests/integration/worker-supervisor.test.js",
  "tests/integration/reconcile.test.js",
]);
const isolatedFiles = integrationFiles.filter((f) => isolatedIntegrationFiles.has(f));
const parallelIntegrationFiles = integrationFiles.filter((f) => !isolatedFiles.includes(f));

// When --unit flag is passed, only run unit tests (fast, <15s)
const unitOnly = process.argv.includes("--unit");
// When --integration flag is passed, only run integration tests
const integrationOnly = process.argv.includes("--integration");

try {
  if (unitOnly) {
    if (unitFiles.length > 0) {
      await runTests(unitFiles, { label: "unit tests" });
    }
  } else if (integrationOnly) {
    // Browser E2E tests: run serially to avoid concurrent Chromium contention
    if (browserFiles.length > 0) {
      await runTests(browserFiles, {
        concurrency: 1,
        env: { CPB_ACP_BROWSER_AGENT_HEADLESS: "1" },
        label: "browser E2E tests",
      });
    }
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
    // Browser E2E tests: run serially
    if (browserFiles.length > 0) {
      await runTests(browserFiles, {
        concurrency: 1,
        env: { CPB_ACP_BROWSER_AGENT_HEADLESS: "1" },
        label: "browser E2E tests",
      });
    }
    // Unit tests: run in parallel (fast)
    if (unitFiles.length > 0) {
      await runTests(unitFiles, { label: "unit tests" });
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
