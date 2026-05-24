import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
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

async function mustRun(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  assert.equal(result.code, 0, `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

// --- Basic routing ---

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

test("cpb setup --json is routed and reports agents", async () => {
  const result = await runNode(["./cpb", "setup", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.system);
  assert.ok(parsed.agents.codex);
  assert.ok(parsed.agents.claude);
  assert.ok(parsed.agents.opencode);
});

test("cpb agents list --json is routed", async () => {
  const result = await runNode(["./cpb", "agents", "list", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.agents));
  assert.ok(parsed.agents.some((agent) => agent.id === "codex"));
});

test("cpb agents install without --yes prints a non-executed install plan", async () => {
  const result = await runNode(["./cpb", "agents", "install", "codex", "--method", "npm", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.executed, false);
  assert.equal(parsed.plan.agent.id, "codex");
  assert.equal(parsed.plan.displayCommand, "npm i -g @openai/codex");
  assert.equal(parsed.plan.requiresExplicitConfirmation, true);
});

// --- Newly routed commands ---

test("cpb cancel --help is routed and shows usage", async () => {
  const result = await runNode(["./cpb", "cancel", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:.*cancel/);
});

test("cpb redirect --help is routed and shows usage", async () => {
  const result = await runNode(["./cpb", "redirect", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:.*redirect/);
});

test("cpb merge-preview --help is routed and shows usage", async () => {
  const result = await runNode(["./cpb", "merge-preview", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
});

test("cpb cancel without args shows usage and exits non-zero", async () => {
  const result = await runNode(["./cpb", "cancel"], { env: { CPB_ROOT: "/tmp/cpb-test-fake" } });
  assert.notEqual(result.code, 0);
});

test("cpb redirect without args shows usage and exits non-zero", async () => {
  const result = await runNode(["./cpb", "redirect"], { env: { CPB_ROOT: "/tmp/cpb-test-fake" } });
  assert.notEqual(result.code, 0);
});

test("direct cancel-redirect module honors non-zero run() return code", async () => {
  const result = await runNode(["./cli/commands/cancel-redirect.js", "cancel"], {
    env: { CPB_ROOT: "/tmp/cpb-test-fake" },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /Usage: cpb cancel/);
});

test("direct merge-preview module honors unsafe-preview return code", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-cli-merge-"));
  const repo = path.join(tmp, "repo");
  const hubRoot = path.join(tmp, "hub");

  try {
    await mkdir(repo, { recursive: true });
    await mustRun("git", ["init", "-b", "main"], { cwd: repo });
    await mustRun("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
    await mustRun("git", ["config", "user.name", "Tests"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "base\n", "utf8");
    await mustRun("git", ["add", "README.md"], { cwd: repo });
    await mustRun("git", ["commit", "-m", "base"], { cwd: repo });
    await mustRun("git", ["checkout", "-b", "unsafe-candidate"], { cwd: repo });
    await mkdir(path.join(repo, ".omx"), { recursive: true });
    await writeFile(path.join(repo, ".omx", "state.json"), "{}\n", "utf8");
    await mustRun("git", ["add", ".omx/state.json"], { cwd: repo });
    await mustRun("git", ["commit", "-m", "unsafe shared state"], { cwd: repo });
    await mustRun("git", ["checkout", "main"], { cwd: repo });

    await mkdir(hubRoot, { recursive: true });
    await writeFile(path.join(hubRoot, "projects.json"), `${JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        mergeproj: {
          id: "mergeproj",
          name: "mergeproj",
          sourcePath: repo,
          projectRoot: path.join(repo, "cpb-task"),
          projectRuntimeRoot: path.join(tmp, "runtime"),
          enabled: true,
        },
      },
    }, null, 2)}\n`, "utf8");

    const result = await runNode(["./cli/commands/merge-preview.js", "mergeproj", "unsafe-candidate", "--json"], {
      env: { CPB_ROOT: tmp, CPB_HUB_ROOT: hubRoot },
    });
    assert.equal(result.code, 2, result.stderr || result.stdout);
    assert.match(result.stdout, /shared_state_changed/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- Help consistency ---

test("cpb help lists all public COMMANDS keys", async () => {
  const result = await runNode(["./cpb", "help"]);
  assert.equal(result.code, 0);

  // These are the commands that should appear in help output
  const publicCommands = [
    "init", "attach", "hub", "plan", "execute", "verify", "pipeline",
    "research", "evolve-multi", "index", "repair",
    "status", "list", "jobs", "gc", "recover", "diff", "review",
    "inbox", "outputs", "doctor", "health-check", "setup", "agents", "wiki", "release",
    "cancel", "redirect", "merge-preview", "install-bin", "ui", "version",
  ];

  for (const cmd of publicCommands) {
    assert.match(result.stdout, new RegExp(cmd), `help output missing command: ${cmd}`);
  }
});

// --- All routed command modules import successfully ---

test("all routed CLI command modules import successfully", async () => {
  // Module filenames (values in COMMANDS), deduplicated
  const moduleFiles = [
    "init", "attach", "hub", "plan", "execute", "verify", "pipeline", "research",
    "status", "list", "jobs", "evolve-multi", "index", "repair", "diff", "review",
    "inbox", "outputs", "doctor", "health-check", "setup", "agents", "reconcile", "wiki", "ui",
    "version", "release-select", "install-bin", "cancel-redirect", "merge-preview",
  ];
  for (const mod of moduleFiles) {
    const result = await runNode(["-e", `import("./cli/commands/${mod}.js")`]);
    assert.equal(result.code, 0, `${mod} import failed: ${result.stderr}`);
  }
});

test("all routed command modules export run()", async () => {
  const moduleFiles = [
    "init", "attach", "hub", "plan", "execute", "verify", "pipeline", "research",
    "status", "list", "jobs", "evolve-multi", "index", "repair", "diff", "review",
    "inbox", "outputs", "doctor", "health-check", "setup", "agents", "reconcile", "wiki", "ui",
    "version", "release-select", "install-bin", "cancel-redirect", "merge-preview",
  ];
  for (const mod of moduleFiles) {
    const result = await runNode(["-e", `
      import("./cli/commands/${mod}.js").then(m => {
        if (typeof m.run !== "function") throw new Error("${mod} missing run()");
      })
    `]);
    assert.equal(result.code, 0, `${mod} missing run(): ${result.stderr}`);
  }
});

// --- Help signature accuracy for repaired commands ---

test("cpb help shows correct repair signature", async () => {
  const result = await runNode(["./cpb", "help"]);
  const plain = result.stdout.replace(/\x1B\[[0-9;]*m/g, "");
  assert.match(plain, /repair\s+<project> <job-id>/);
  assert.doesNotMatch(plain, /repair\s+\[options\]/);
});

test("cpb help shows correct index signature", async () => {
  const result = await runNode(["./cpb", "help"]);
  const plain = result.stdout.replace(/\x1B\[[0-9;]*m/g, "");
  assert.match(plain, /index\s+<status\|refresh> <project>/);
  assert.doesNotMatch(plain, /index\s+<project>\s+.*Rebuild/);
});

test("cpb help shows correct evolve-multi signature with modes", async () => {
  const result = await runNode(["./cpb", "help"]);
  const plain = result.stdout.replace(/\x1B\[[0-9;]*m/g, "");
  assert.match(plain, /evolve-multi\s+\[--once\|--scan\|--continuous\]/);
  assert.doesNotMatch(plain, /evolve-multi\s+<project>.*<task>/);
});

test("cpb repair without args shows correct usage", async () => {
  const result = await runNode(["./cpb", "repair"], { env: { CPB_ROOT: "/tmp/cpb-test-fake" } });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /Usage: cpb repair <project> <job-id>/);
});

test("cpb index without args shows correct usage", async () => {
  const result = await runNode(["./cpb", "index"], { env: { CPB_ROOT: "/tmp/cpb-test-fake" } });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /Usage: cpb index <status\|refresh> <project>/);
});

// --- Orphan command files are intentional ---

test("all cli/commands/*.js files are either routed or intentionally internal", async () => {
  const files = await readdir(path.join(repoRoot, "cli", "commands"));
  const jsFiles = files.filter((f) => f.endsWith(".js")).sort();

  // Files that are NOT in COMMANDS values but exist in cli/commands/
  // These are intentionally internal (used by other commands or legacy)
  const intentionalInternal = new Set([
    "list-jobs.js",       // redundant with cpb jobs default behavior
    "install-release.js", // used internally by release-select.js
  ]);

  // All module files that COMMANDS maps to (values, deduplicated)
  const routedModules = new Set([
    "init.js", "attach.js", "hub.js", "plan.js", "execute.js", "verify.js",
    "pipeline.js", "research.js", "status.js", "list.js", "jobs.js",
    "evolve-multi.js", "index.js", "repair.js", "diff.js", "review.js",
    "inbox.js", "outputs.js", "doctor.js", "health-check.js", "setup.js", "agents.js", "reconcile.js",
    "wiki.js", "ui.js", "version.js", "release-select.js", "install-bin.js",
    "cancel-redirect.js", "merge-preview.js",
  ]);

  for (const file of jsFiles) {
    if (!routedModules.has(file) && !intentionalInternal.has(file)) {
      assert.fail(`cli/commands/${file} is not routed and not marked intentional`);
    }
  }
});
