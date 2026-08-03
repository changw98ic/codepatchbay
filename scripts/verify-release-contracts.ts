#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CONTRACT_TESTS = [
  "dist-tests/tests/release-source-fingerprint.test.js",
  "dist-tests/tests/release-evidence-signing.test.js",
  "dist-tests/tests/release-gate-receipts.test.js",
  "dist-tests/tests/release-gate-runner.test.js",
  "dist-tests/tests/release-readiness-report.test.js",
  "dist-tests/tests/disposable-draft-pr-rehearsal.test.js",
  "dist-tests/tests/live-release-evidence.test.js",
  "dist-tests/tests/product-gate.test.js",
  "dist-tests/tests/release-install-safety.test.js",
  "dist-tests/tests/release-selection-metadata-safety.test.js",
];
const FLAGSHIP_PATTERN = "managed worker flagship issue to draft PR dry-run uses default checklist decomposition and evidence";

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, CPB_WORKER_DISPATCH_ENABLED: "0" },
    });
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(Number.isInteger(code) ? Number(code) : 1));
  });
}

async function main() {
  let code = await run(process.execPath, ["--test", ...CONTRACT_TESTS]);
  if (code === 0) {
    code = await run(process.execPath, [
      "--test",
      "--test-name-pattern",
      FLAGSHIP_PATTERN,
      "dist-tests/tests/integration/managed-worker.test.js",
    ]);
  }
  if (code !== 0) process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
