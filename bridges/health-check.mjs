#!/usr/bin/env node

// Health check: HTTP GET + test suite + frontend build
// Exit 0 = healthy, exit 1 = unhealthy

import { spawn } from "node:child_process";
import path from "node:path";

const PORT = parseInt(process.env.CPB_PORT || "3456", 10);
const CPB_ROOT = path.resolve(process.env.CPB_ROOT || ".");
const WEB_DIR = path.join(CPB_ROOT, "web");

async function httpCheck(maxAttempts = 10, intervalMs = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/projects`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function runCmd(cmd, args, cwd = CPB_ROOT) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("exit", (code) => resolve({ ok: code === 0, output }));
  });
}

async function main() {
  const checks = [];

  // Check 1: HTTP
  const httpOk = await httpCheck();
  checks.push({ name: "http", ok: httpOk });
  if (!httpOk) {
    console.log("FAIL: HTTP health check failed");
    process.exit(1);
  }

  // Check 2: Backend tests
  const tests = await runCmd("node", ["--test", "tests/*.mjs"]);
  checks.push({ name: "tests", ok: tests.ok });
  if (!tests.ok) console.log("FAIL: tests\n" + tests.output.slice(-500));

  // Check 3: Frontend build
  const build = await runCmd("npx", ["vite", "build"], WEB_DIR);
  checks.push({ name: "build", ok: build.ok });
  if (!build.ok) console.log("FAIL: build\n" + build.output.slice(-500));

  const allOk = checks.every((c) => c.ok);
  console.log(allOk ? "PASS" : `FAIL: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
  process.exit(allOk ? 0 : 1);
}

main();
