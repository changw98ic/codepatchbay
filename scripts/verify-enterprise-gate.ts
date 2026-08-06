#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";

const requiredCommands: string[] = [];
// Enterprise-specific test files were removed; the gate is vestigial until new
// enterprise tests are added. An empty array skips the test run (avoids
// node --test discovering the full suite).
const enterpriseTests: string[] = [];

for (const command of requiredCommands) {
  const probe = spawnSync(command, ["--version"], { cwd: REPO_ROOT, stdio: "ignore" });
  if (probe.status !== 0) {
    console.error(`${FAIL} Enterprise gate requires ${command}; skipped.`);
    process.exit(1);
  }
}

if (enterpriseTests.length === 0) {
  console.log(`${PASS} Enterprise gate passed (no enterprise-specific tests to run).`);
  process.exit(0);
}

console.log("Enterprise gate");
console.log(`$ ${process.execPath} --test ${enterpriseTests.join(" ")}`);
const child = spawn(process.execPath, ["--test", ...enterpriseTests], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: { ...process.env, CPB_WORKER_DISPATCH_ENABLED: "0" },
});
child.once("error", (error) => {
  console.error(`${FAIL} Enterprise gate failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (code === 0) {
    console.log(`${PASS} Enterprise gate passed.`);
    return;
  }
  console.error(`${FAIL} Enterprise gate failed (${signal || code}).`);
  process.exitCode = code || 1;
});
