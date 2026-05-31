#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { glob } from "glob";

const repoRoot = path.resolve(import.meta.dirname, "..");
const files = await glob("tests/**/*.test.mjs", { cwd: repoRoot });

if (files.length === 0) {
  console.error("No Node test files found under tests/*.test.mjs");
  process.exit(1);
}

function buildTestEnv(parentEnv) {
  const env = { ...parentEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CPB_")) delete env[key];
  }
  return {
    ...env,
    CPB_WORKER_DISPATCH_ENABLED: "0",
  };
}

const child = spawn(process.execPath, ["--test", ...files], {
  cwd: repoRoot,
  stdio: "inherit",
  env: buildTestEnv(process.env),
});

child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
