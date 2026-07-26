#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";

const requiredCommands: string[] = [];
const enterpriseTests = [
  "dist-tests/tests/hub-backup.test.js",
  "dist-tests/tests/hub-maintenance.test.js",
  "dist-tests/tests/hub-access-audit.test.js",
  "dist-tests/tests/hub-access-audit-archive.test.js",
];

for (const command of requiredCommands) {
  const probe = spawnSync(command, ["--version"], { cwd: REPO_ROOT, stdio: "ignore" });
  if (probe.status !== 0) {
    console.error(`${FAIL} Enterprise gate requires ${command}; skipped.`);
    process.exit(1);
  }
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
