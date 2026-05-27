import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
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

test("initProject creates a minimal wiki when executor template is absent", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-init-no-template-"));
  const source = path.join(tmp, "source");
  const cpbRoot = path.join(tmp, "cpb-root");
  const executorRoot = path.join(tmp, "executor-root");
  const savedProjectRoots = process.env.CPB_PROJECT_ROOTS;

  try {
    await mkdir(source, { recursive: true });
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(executorRoot, { recursive: true });
    await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "no-template" }), "utf8");
    process.env.CPB_PROJECT_ROOTS = tmp;

    const { initProject } = await import("../cli/commands/init.js");
    await initProject([source, "no-template"], { cpbRoot, executorRoot });

    const context = await readFile(path.join(cpbRoot, "wiki", "projects", "no-template", "context.md"), "utf8");
    assert.match(context, /Initialized without a project template/);
  } finally {
    if (savedProjectRoots === undefined) delete process.env.CPB_PROJECT_ROOTS;
    else process.env.CPB_PROJECT_ROOTS = savedProjectRoots;
    await rm(tmp, { recursive: true, force: true });
  }
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

test("cpb run parses plan-mode and triage flags without folding them into the task", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-run-planmode-triage-"));
  try {
    const result = await runNode([
      "./cpb",
      "run",
      "blocked approval",
      "--project",
      "demo",
      "--workflow",
      "blocked",
      "--plan-mode",
      "none",
      "--triage",
      "none",
    ], {
      env: { CPB_ROOT: tmp, CPB_USE_WORKTREE: "0" },
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const eventDir = path.join(tmp, "cpb-task", "events", "demo");
    const [eventFile] = await readdir(eventDir);
    const events = (await readFile(path.join(eventDir, eventFile), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const jobCreated = events.find((event) => event.type === "job_created");
    assert.equal(jobCreated.task, "blocked approval");
    assert.equal(jobCreated.workflow, "blocked");
    assert.equal(jobCreated.planMode, "none");
    assert.equal(jobCreated.sourceContext?.triageMode, "none");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
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
  assert.ok(parsed.detected.system);
  assert.ok(parsed.detected.agents.codex);
  assert.ok(parsed.detected.agents.claude);
  assert.ok(parsed.detected.agents.opencode);
  assert.ok(parsed.profile);
  assert.equal(parsed.executed, false);
});

test("cpb agents list --json is routed", async () => {
  const result = await runNode(["./cpb", "agents", "list", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.agents));
  assert.ok(parsed.agents.some((agent) => agent.id === "codex"));
});

test("cpb agents detect --json is routed", async () => {
  const result = await runNode(["./cpb", "agents", "detect", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.agents.codex);
  assert.ok(parsed.agents.claude);
});

test("cpb auth status --json is routed", async () => {
  const result = await runNode(["./cpb", "auth", "status", "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.providers.codex);
  assert.ok(parsed.providers.claude);
  assert.ok(parsed.providers.opencode);
  assert.ok(parsed.providers.github);
});

test("cpb auth connect codex --json returns local setup instructions", async () => {
  const result = await runNode(["./cpb", "auth", "connect", "codex", "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.provider.id, "codex");
  assert.equal(parsed.providerNativeCommand, "codex");
  assert.match(parsed.localSetupUrl, /\/setup\/auth\/codex$/);
});

test("cpb github bind persists repo metadata and default trigger rules", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-github-bind-"));
  const source = path.join(tmp, "frontend");
  const hubRoot = path.join(tmp, "hub");
  try {
    await mkdir(source, { recursive: true });
    const { registerProject, registryPath } = await import("../server/services/hub-registry.js");
    await registerProject(hubRoot, { name: "frontend", sourcePath: source });

    const result = await runNode(["./cpb", "github", "bind", "frontend", "my-org/frontend", "--json"], {
      env: { CPB_ROOT: tmp, CPB_HUB_ROOT: hubRoot },
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.bound, true);
    assert.equal(parsed.project.id, "frontend");
    assert.equal(parsed.project.github.owner, "my-org");
    assert.equal(parsed.project.github.repo, "frontend");
    assert.equal(parsed.project.github.fullName, "my-org/frontend");
    assert.deepEqual(parsed.project.github.triggers, [
      { event: "issues.labeled", label: "sdd", workflow: "sdd-standard", planMode: "parent" },
      { event: "issues.labeled", label: "cpb", workflow: "standard" },
      { event: "issue_comment.created", command: "/cpb run", workflow: "standard" },
    ]);

    const registry = JSON.parse(await readFile(registryPath(hubRoot), "utf8"));
    assert.equal(registry.projects.frontend.sourcePath, await realpath(source));
    assert.equal(registry.projects.frontend.github.fullName, "my-org/frontend");
    assert.equal(registry.projects.frontend.enabled, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cpb github bind rejects invalid repo names without changing the project", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-github-bind-invalid-"));
  const source = path.join(tmp, "frontend");
  const hubRoot = path.join(tmp, "hub");
  try {
    await mkdir(source, { recursive: true });
    const { registerProject, registryPath } = await import("../server/services/hub-registry.js");
    await registerProject(hubRoot, { name: "frontend", sourcePath: source });

    const result = await runNode(["./cpb", "github", "bind", "frontend", "not-a-repo", "--json"], {
      env: { CPB_ROOT: tmp, CPB_HUB_ROOT: hubRoot },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /invalid GitHub repo/i);
    const registry = JSON.parse(await readFile(registryPath(hubRoot), "utf8"));
    assert.equal(registry.projects.frontend.github, undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cpb jobs worktrees --dry-run --json is routed", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-jobs-worktrees-"));
  try {
    const result = await runNode(["./cpb", "jobs", "worktrees", "--dry-run", "--json"], {
      env: { CPB_ROOT: tmp },
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, true);
    assert.ok(Array.isArray(parsed.entries));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cpb artifacts and verdict resolve legacy jobs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-artifacts-legacy-"));
  const jobId = "job-artifacts-legacy";
  try {
    const { appendEvent } = await import("../server/services/event-store.js");
    const outputs = path.join(tmp, "wiki", "projects", "demo", "outputs");
    await mkdir(outputs, { recursive: true });
    await writeFile(path.join(outputs, "verdict-001.md"), "VERDICT: PASS\n", "utf8");
    await appendEvent(tmp, "demo", jobId, {
      type: "job_created",
      jobId,
      project: "demo",
      task: "legacy artifact cli",
      workflow: "standard",
      ts: "2026-05-24T00:00:00.000Z",
    });
    await appendEvent(tmp, "demo", jobId, {
      type: "phase_completed",
      jobId,
      project: "demo",
      phase: "verify",
      artifact: "verdict-001.md",
      agent: "codex",
      ts: "2026-05-24T00:01:00.000Z",
    });

    const artifacts = await runNode(["./cpb", "artifacts", jobId, "--json"], { env: { CPB_ROOT: tmp } });
    assert.equal(artifacts.code, 0, artifacts.stderr || artifacts.stdout);
    const parsedArtifacts = JSON.parse(artifacts.stdout);
    assert.equal(parsedArtifacts.entries[0].kind, "verdict");
    assert.equal(parsedArtifacts.entries[0].path, path.join(outputs, "verdict-001.md"));

    const verdict = await runNode(["./cpb", "verdict", jobId, "--json"], { env: { CPB_ROOT: tmp } });
    assert.equal(verdict.code, 0, verdict.stderr || verdict.stdout);
    const parsedVerdict = JSON.parse(verdict.stdout);
    assert.match(parsedVerdict.content, /VERDICT: PASS/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cpb artifacts resolves Hub runtime roots", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-artifacts-hub-"));
  const hubRoot = path.join(tmp, ".hub");
  const projectRuntimeRoot = path.join(hubRoot, "projects", "hubproj");
  const jobId = "job-artifacts-hub";
  try {
    const { appendEvent } = await import("../server/services/event-store.js");
    const outputs = path.join(projectRuntimeRoot, "wiki", "outputs");
    await mkdir(outputs, { recursive: true });
    await writeFile(path.join(outputs, "deliverable-002.md"), "# Deliverable\n", "utf8");
    await mkdir(hubRoot, { recursive: true });
    await writeFile(path.join(hubRoot, "projects.json"), JSON.stringify({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      projects: {
        hubproj: {
          id: "hubproj",
          name: "hubproj",
          sourcePath: tmp,
          projectRoot: path.join(tmp, "cpb-task"),
          projectRuntimeRoot,
          enabled: true,
        },
      },
    }), "utf8");
    await appendEvent(tmp, "hubproj", jobId, {
      type: "job_created",
      jobId,
      project: "hubproj",
      task: "hub artifact cli",
      workflow: "standard",
      ts: "2026-05-24T00:00:00.000Z",
    }, { dataRoot: projectRuntimeRoot });
    await appendEvent(tmp, "hubproj", jobId, {
      type: "phase_completed",
      jobId,
      project: "hubproj",
      phase: "execute",
      artifact: "deliverable-002.md",
      agent: "claude",
      ts: "2026-05-24T00:01:00.000Z",
    }, { dataRoot: projectRuntimeRoot });

    const result = await runNode(["./cpb", "artifacts", jobId, "--json"], {
      env: { CPB_ROOT: tmp, CPB_HUB_ROOT: hubRoot },
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.project, "hubproj");
    assert.equal(parsed.entries[0].path, path.join(outputs, "deliverable-002.md"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cpb artifacts missing job exits non-zero without stack trace", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-artifacts-missing-"));
  try {
    const result = await runNode(["./cpb", "artifacts", "job-does-not-exist", "--json"], {
      env: { CPB_ROOT: tmp },
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /not found/i);
    assert.doesNotMatch(result.stderr + result.stdout, /\n\s*at\s+/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cpb agents install without --yes prints a non-executed install plan", async () => {
  const result = await runNode(["./cpb", "agents", "install", "codex", "--method", "npm", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.executed, false);
  assert.equal(parsed.plan.agent.id, "codex");
  assert.equal(parsed.plan.displayCommand, "npm i -g @openai/codex");
  assert.equal(parsed.plan.requiresExplicitConfirmation, true);
  assert.equal(parsed.plan.rollback.command, "npm uninstall -g @openai/codex");
  assert.ok(parsed.plan.supplyChainNotes.includes("Review the source URL before executing this plan."));
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
    "init", "attach", "hub", "daemon", "plan", "execute", "verify", "pipeline",
    "demo", "research", "evolve-multi", "index", "sdd", "repair",
    "status", "list", "jobs", "gc", "recover", "diff", "review",
    "inbox", "outputs", "artifacts", "verdict", "doctor", "health-check", "setup", "agents", "auth", "github", "wiki", "release",
    "cancel", "redirect", "merge-preview", "install-bin", "ui", "version", "audit",
  ];

  for (const cmd of publicCommands) {
    assert.match(result.stdout, new RegExp(cmd), `help output missing command: ${cmd}`);
  }
});

// --- All routed command modules import successfully ---

test("all routed CLI command modules import successfully", async () => {
  // Module filenames (values in COMMANDS), deduplicated
  const moduleFiles = [
    "init", "attach", "hub", "daemon", "plan", "execute", "verify", "pipeline", "demo", "research",
    "status", "list", "jobs", "artifacts", "verdict", "evolve-multi", "index", "sdd", "repair", "diff", "review",
    "inbox", "outputs", "doctor", "health-check", "setup", "agents", "auth", "github", "reconcile", "wiki", "ui",
    "version", "release-select", "install-bin", "cancel-redirect", "merge-preview", "audit",
  ];
  for (const mod of moduleFiles) {
    const result = await runNode(["-e", `import("./cli/commands/${mod}.js")`]);
    assert.equal(result.code, 0, `${mod} import failed: ${result.stderr}`);
  }
});

test("all routed command modules export run()", async () => {
  const moduleFiles = [
    "init", "attach", "hub", "daemon", "plan", "execute", "verify", "pipeline", "demo", "research",
    "status", "list", "jobs", "artifacts", "verdict", "evolve-multi", "index", "sdd", "repair", "diff", "review",
    "inbox", "outputs", "doctor", "health-check", "setup", "agents", "auth", "github", "reconcile", "wiki", "ui",
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
  assert.match(plain, /index\s+<status\|refresh\|graph\|impact\|context-pack> <project>/);
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
  assert.match(result.stdout + result.stderr, /Usage: cpb index <status\|refresh\|graph\|impact\|context-pack> <project>/);
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
    "init.js", "attach.js", "hub.js", "daemon.js", "plan.js", "execute.js", "verify.js",
    "pipeline.js", "demo.js", "research.js", "status.js", "list.js", "jobs.js", "artifacts.js", "verdict.js",
    "evolve-multi.js", "index.js", "sdd.js", "repair.js", "diff.js", "review.js",
    "inbox.js", "outputs.js", "doctor.js", "health-check.js", "setup.js", "agents.js", "auth.js", "github.js", "reconcile.js",
    "run.js", "wiki.js", "ui.js", "version.js", "release-select.js", "install-bin.js",
    "cancel-redirect.js", "merge-preview.js", "audit.js", "config.js", "provider.js", "quickstart.js", "model-profile.js",
  ]);

  for (const file of jsFiles) {
    if (!routedModules.has(file) && !intentionalInternal.has(file)) {
      assert.fail(`cli/commands/${file} is not routed and not marked intentional`);
    }
  }
});

// --- D47: Audit export command ---

test("D47: cpb audit is a routed public command", async () => {
  const result = await runNode(["./cpb", "audit", "--help"]);
  assert.equal(result.code, 0, `cpb audit not routed: ${result.stderr || result.stdout}`);
  assert.doesNotMatch(result.stderr + result.stdout, /Unknown command/);
});

test("D47: audit command module exports run()", async () => {
  const result = await runNode(["-e", `
    import("./cli/commands/audit.js").then(m => {
      if (typeof m.run !== "function") throw new Error("audit missing run()");
    })
  `]);
  assert.equal(result.code, 0, `audit module missing run(): ${result.stderr}`);
});

// --- D42: Quickstart command readiness ---

test("D42: cpb run is a routed command (or aliased to pipeline)", async () => {
  // D42 quickstart requires 'cpb run'. It must either be its own command
  // or an alias that routes to an existing command like 'pipeline'.
  const result = await runNode(["./cpb", "run", "--help"]);
  assert.equal(result.code, 0, `cpb run not routed: ${result.stderr || result.stdout}`);
  assert.doesNotMatch(result.stderr + result.stdout, /Unknown command/);
});

test("D42: cpb init . works with dot-path (single-arg or default-name)", async () => {
  // D42 quickstart shows 'cpb init .'. Current init requires <path> <name>.
  // This test proves that 'cpb init .' works by inferring name from
  // directory or by accepting a single arg.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-init-dot-"));
  const projectDir = path.join(tmp, "my-app");
  try {
    await mkdir(projectDir, { recursive: true });
    const projectRoot = await realpath(tmp);
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "my-app" }), "utf8");

    const result = await runNode([path.join(repoRoot, "cpb"), "init", "."], {
      cwd: projectDir,
      env: {
        CPB_ROOT: path.join(tmp, "cpb-root"),
        CPB_HUB_ROOT: path.join(tmp, "hub"),
        CPB_PROJECT_ROOTS: projectRoot,
      },
    });

    // Should not fail with "Usage" or missing-args error
    assert.doesNotMatch(
      result.stderr + result.stdout,
      /Usage:.*init/i,
      "cpb init . should not show usage; it should accept dot-path"
    );
    assert.equal(result.code, 0, `cpb init . failed: ${result.stderr || result.stdout}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("D42: cpb run can use current project with a blocked workflow smoke", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-run-dot-"));
  const projectDir = path.join(tmp, "my-app");
  const projectRoot = await realpath(tmp);
  const env = {
    CPB_ROOT: path.join(tmp, "cpb-root"),
    CPB_HUB_ROOT: path.join(tmp, "hub"),
    CPB_PROJECT_ROOTS: projectRoot,
  };

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "my-app" }), "utf8");

    const init = await runNode([path.join(repoRoot, "cpb"), "init", "."], { cwd: projectDir, env });
    assert.equal(init.code, 0, init.stderr || init.stdout);

    const run = await runNode([path.join(repoRoot, "cpb"), "run", "--workflow", "blocked", "doc smoke"], {
      cwd: projectDir,
      env,
    });
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.match(run.stdout + run.stderr, /workflow: blocked|blocked/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
