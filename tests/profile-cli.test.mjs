import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CPB_ROOT = path.resolve(__dirname, "..");

// Helper: capture console output
async function captureRun(args) {
  const { run } = await import("../cli/commands/profile.js");
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const code = await run(args, { cpbRoot: CPB_ROOT });
    return { code, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

// ─── list ───

test("profile list returns all 5 roles", async () => {
  const { code, logs } = await captureRun(["list"]);
  assert.equal(code, 0);
  const output = logs.join("\n");
  for (const role of ["executor", "planner", "repairer", "reviewer", "verifier"]) {
    assert.ok(output.includes(role), `expected output to include ${role}`);
  }
});

test("profile list --json returns valid JSON array", async () => {
  const { code, logs } = await captureRun(["list", "--json"]);
  assert.equal(code, 0);
  const parsed = JSON.parse(logs.join("\n"));
  assert.ok(Array.isArray(parsed), "expected JSON array");
  assert.ok(parsed.length >= 5, "expected at least 5 profiles");
  for (const role of ["executor", "planner", "repairer", "reviewer", "verifier"]) {
    assert.ok(parsed.includes(role), `expected array to include ${role}`);
  }
});

// ─── show ───

test("profile show executor prints agent command and skill info", async () => {
  const { code, logs } = await captureRun(["show", "executor"]);
  assert.equal(code, 0);
  const output = logs.join("\n");
  assert.ok(output.includes("Role: executor"), "expected role name");
  assert.ok(output.includes("claude-agent-acp"), "expected agent command");
  assert.ok(output.includes("Skills"), "expected skills section");
});

test("profile show executor --json returns JSON with expected fields", async () => {
  const { code, logs } = await captureRun(["show", "executor", "--json"]);
  assert.equal(code, 0);
  const parsed = JSON.parse(logs.join("\n"));
  assert.equal(parsed.role, "executor");
  assert.ok(parsed.agent, "expected agent field");
  assert.ok(parsed.permissions, "expected permissions field");
  assert.ok(Array.isArray(parsed.skills), "expected skills array");
});

test("profile show nonexistent-role returns exit code 1", async () => {
  const { code, errors } = await captureRun(["show", "nonexistent-role"]);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("not found"), "expected 'not found' error");
});

// ─── use ───

test("profile use writes soul.md override to project wiki dir", async () => {
  const testProject = "__test-profile-use";
  const wikiDir = path.join(CPB_ROOT, "wiki", "projects", testProject);
  const overridePath = path.join(wikiDir, "profiles", "executor", "soul.md");

  try {
    // Create fake project wiki dir
    await mkdir(wikiDir, { recursive: true });

    const { code, logs } = await captureRun(["use", "executor", "--project", testProject]);
    assert.equal(code, 0);
    assert.ok(logs.join("\n").includes("bound to project"), "expected confirmation message");

    // Verify the file was written
    const content = await readFile(overridePath, "utf8");
    assert.ok(content.length > 0, "expected non-empty soul.md");

    // Verify it matches the original
    const original = await readFile(path.join(CPB_ROOT, "profiles", "executor", "soul.md"), "utf8");
    assert.equal(content, original, "override should match original soul.md");
  } finally {
    await rm(wikiDir, { recursive: true, force: true });
  }
});

test("profile use without --project returns error", async () => {
  const { code, errors } = await captureRun(["use", "executor"]);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("--project"), "expected --project required error");
});

test("profile use nonexistent project returns error", async () => {
  const { code, errors } = await captureRun(["use", "executor", "--project", "__nonexistent_project_xyz__"]);
  assert.equal(code, 1);
  assert.ok(errors.join("\n").includes("not found"), "expected 'not found' error");
});

// ─── help ───

test("profile --help returns 0 and prints usage", async () => {
  const { code, logs } = await captureRun(["--help"]);
  assert.equal(code, 0);
  assert.ok(logs.join("\n").includes("Usage:"), "expected usage text");
});

test("profile with no subcommand returns 1", async () => {
  const { code } = await captureRun([]);
  assert.equal(code, 1);
});
