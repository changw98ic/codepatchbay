#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { glob } from "glob";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function runTests(files, opts = {}) {
  const { concurrency = undefined, label = "tests" } = opts;
  const args = ["--test", ...files];
  if (concurrency !== undefined) {
    args.unshift(`--test-concurrency=${concurrency}`);
  }

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CPB_")) delete env[key];
  }
  env.CPB_WORKER_DISPATCH_ENABLED = "0";

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

const allFiles = await glob("tests/**/*.test.mjs", { cwd: repoRoot });

if (allFiles.length === 0) {
  console.error("No Node test files found under tests/*.test.mjs");
  process.exit(1);
}

const browserFiles = allFiles.filter((f) => f.startsWith("tests/browser/"));
const otherFiles = allFiles.filter((f) => !f.startsWith("tests/browser/"));
const isolatedUnitFiles = otherFiles.filter((f) => f === "tests/quota-delegate.test.mjs");
const parallelUnitFiles = otherFiles.filter((f) => !isolatedUnitFiles.includes(f));

try {
  // Browser E2E tests: run serially to avoid concurrent Chromium contention
  if (browserFiles.length > 0) {
    await runTests(browserFiles, { concurrency: 1, label: "browser E2E tests" });
  }

  // Other unit tests: run in parallel (default Node concurrency).
  if (parallelUnitFiles.length > 0) {
    await runTests(parallelUnitFiles, { label: "unit tests" });
  }

  // Real-process delegate integration tests need isolation from parallel load.
  if (isolatedUnitFiles.length > 0) {
    await runTests(isolatedUnitFiles, { concurrency: 1, label: "isolated unit tests" });
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
