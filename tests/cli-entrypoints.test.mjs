import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("cpb init command uses the command module contract", async () => {
  const result = await runNode(["./cpb", "init"]);
  assert.notEqual(result.stderr + result.stdout, "");
  assert.doesNotMatch(result.stderr + result.stdout, /mod\.run is not a function/);
  assert.notEqual(result.code, 0);
});

test("cpb version exits zero", async () => {
  const result = await runNode(["./cpb", "version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /v0\.2\.0/);
});

test("cpb unknown command exits non-zero", async () => {
  const result = await runNode(["./cpb", "nonexistent-command"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /Unknown command/);
});

test("cpb release list is routed", async () => {
  const result = await runNode(["./cpb", "release", "list", "--json"]);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr + result.stdout, /Unknown command/);
});

test("cpb install-bin --help is routed", async () => {
  const result = await runNode(["./cpb", "install-bin", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
});

test("all routed CLI command modules import successfully", async () => {
  const commands = [
    "init", "attach", "hub", "plan", "execute", "verify", "pipeline", "research",
    "status", "list", "jobs", "evolve-multi", "index", "repair", "diff", "review",
    "inbox", "outputs", "doctor", "wiki", "ui", "version", "release-select", "install-bin",
  ];
  for (const command of commands) {
    const result = await runNode(["-e", `import("./cli/commands/${command}.js")`]);
    assert.equal(result.code, 0, `${command} import failed: ${result.stderr}`);
  }
});
