#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmod, mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  getWorkflow,
  nextPhase,
  bridgeForPhase,
  roleForPhase,
  phaseRequiresSubagents,
  getVerificationLayers,
  getSubagentConfig,
  listWorkflows,
  isWorkflowName,
} from "../server/services/workflow-definition.js";
import { loadProfile } from "../server/services/profile-loader.js";
import {
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildVerifierPrompt,
  buildVerifierJobPrompt,
  buildRepairerPrompt,
} from "../server/services/prompt-builder.js";

// --- Workflow definition tests ---

describe("accelerated workflow definition", () => {
  it("getWorkflow returns accelerated for known name", () => {
    const wf = getWorkflow("accelerated");
    assert.equal(wf.name, "accelerated");
    assert.deepEqual(wf.phases, ["plan", "execute", "verify"]);
  });

  it("accelerated has same phase sequence as standard", () => {
    const std = getWorkflow("standard");
    const acc = getWorkflow("accelerated");
    assert.deepEqual(acc.phases, std.phases);
  });

  it("accelerated roleForPhase matches standard", () => {
    const acc = getWorkflow("accelerated");
    assert.equal(roleForPhase(acc, "plan"), "planner");
    assert.equal(roleForPhase(acc, "execute"), "executor");
    assert.equal(roleForPhase(acc, "verify"), "verifier");
  });

  it("accelerated bridgeForPhase matches standard", () => {
    const acc = getWorkflow("accelerated");
    assert.equal(bridgeForPhase(acc, "plan"), "planner.sh");
    assert.equal(bridgeForPhase(acc, "execute"), "executor.sh");
    assert.equal(bridgeForPhase(acc, "verify"), "verifier.sh");
  });

  it("accelerated nextPhase sequence is valid", () => {
    const wf = getWorkflow("accelerated");
    const visited = [];
    let current = null;
    while (true) {
      current = nextPhase(wf, current);
      if (current === null) break;
      visited.push(current);
    }
    assert.deepEqual(visited, wf.phases);
  });
});

// --- Subagent requirement tests ---

describe("subagent requirements", () => {
  it("accelerated plan phase requires subagents", () => {
    const wf = getWorkflow("accelerated");
    assert.equal(phaseRequiresSubagents(wf, "plan"), true);
  });

  it("accelerated execute phase requires subagents", () => {
    const wf = getWorkflow("accelerated");
    assert.equal(phaseRequiresSubagents(wf, "execute"), true);
  });

  it("accelerated verify phase requires subagents", () => {
    const wf = getWorkflow("accelerated");
    assert.equal(phaseRequiresSubagents(wf, "verify"), true);
  });

  it("accelerated repair phase requires subagents", () => {
    const wf = getWorkflow("accelerated");
    assert.equal(phaseRequiresSubagents(wf, "repair"), true);
  });

  it("standard workflow has no subagent requirements", () => {
    const wf = getWorkflow("standard");
    assert.equal(phaseRequiresSubagents(wf, "plan"), false);
    assert.equal(phaseRequiresSubagents(wf, "execute"), false);
    assert.equal(phaseRequiresSubagents(wf, "verify"), false);
  });

  it("unknown phase returns false for subagent requirements", () => {
    const wf = getWorkflow("accelerated");
    assert.equal(phaseRequiresSubagents(wf, "nonexistent"), false);
  });

  it("getSubagentConfig returns config for accelerated", () => {
    const wf = getWorkflow("accelerated");
    const config = getSubagentConfig(wf);
    assert.ok(config);
    assert.equal(config.maxConcurrency, 3);
  });

  it("getSubagentConfig returns null for standard", () => {
    const wf = getWorkflow("standard");
    assert.equal(getSubagentConfig(wf), null);
  });
});

// --- Verification layers tests ---

describe("verification layers", () => {
  it("accelerated has four verification layers", () => {
    const wf = getWorkflow("accelerated");
    const layers = getVerificationLayers(wf);
    assert.deepEqual(layers, ["fast", "changed", "regression", "acceptance"]);
  });

  it("standard workflow has no verification layers", () => {
    const wf = getWorkflow("standard");
    assert.equal(getVerificationLayers(wf), null);
  });

  it("complex workflow has no verification layers", () => {
    const wf = getWorkflow("complex");
    assert.equal(getVerificationLayers(wf), null);
  });
});

// --- Conservative default tests ---

describe("conservative defaults", () => {
  it("standard workflow has no requireSubagents field", () => {
    const wf = getWorkflow("standard");
    assert.equal(wf.requireSubagents, undefined);
  });

  it("standard workflow has no verificationLayers field", () => {
    const wf = getWorkflow("standard");
    assert.equal(wf.verificationLayers, undefined);
  });

  it("standard workflow has no subagentConfig field", () => {
    const wf = getWorkflow("standard");
    assert.equal(wf.subagentConfig, undefined);
  });

  it("unknown workflow name falls back to standard", () => {
    const wf = getWorkflow("totally-unknown");
    assert.equal(wf.name, "standard");
    assert.equal(wf.requireSubagents, undefined);
    assert.equal(wf.verificationLayers, undefined);
  });
});

// --- Profile loader subagentGuidance tests ---

describe("profile subagentGuidance", () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-subagent-profile-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("default profile has null subagentGuidance", async () => {
    const profile = await loadProfile(tmpRoot, "nonexistent-role");
    assert.equal(profile.subagentGuidance, null);
  });

  it("profile preserves subagentGuidance from config.json", async () => {
    const dir = path.join(tmpRoot, "profiles", "accel-executor");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({
        permissions: { write_paths: ["wiki/projects/*/outputs/*"], deny_tools: [] },
        agent: { command: "claude-agent-acp", args: [] },
        subagentGuidance: { maxConcurrency: 5, reportSection: "Subagents used" },
      }),
    );
    const profile = await loadProfile(tmpRoot, "accel-executor");
    assert.ok(profile.subagentGuidance);
    assert.equal(profile.subagentGuidance.maxConcurrency, 5);
    assert.equal(profile.subagentGuidance.reportSection, "Subagents used");
  });

  it("profile without subagentGuidance keeps null", async () => {
    const dir = path.join(tmpRoot, "profiles", "basic");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({
        permissions: { write_paths: [], deny_tools: [] },
        agent: { command: "codex-acp", args: [] },
      }),
    );
    const profile = await loadProfile(tmpRoot, "basic");
    assert.equal(profile.subagentGuidance, null);
  });
});

// --- Prompt rendering tests ---

describe("prompt rendering with workflow context", () => {
  const savedWorkflow = process.env.CPB_WORKFLOW;

  afterEach(() => {
    if (savedWorkflow !== undefined) {
      process.env.CPB_WORKFLOW = savedWorkflow;
    } else {
      delete process.env.CPB_WORKFLOW;
    }
  });

  async function makePromptEnv() {
    const executorRoot = await mkdtemp(path.join(tmpdir(), "cpb-prompt-exec-"));
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-prompt-cpb-"));
    const wikiDir = path.join(cpbRoot, "wiki", "projects", "testproj");
    await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
    await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
    await mkdir(path.join(executorRoot, "profiles", "executor"), { recursive: true });
    await mkdir(path.join(executorRoot, "profiles", "planner"), { recursive: true });
    await mkdir(path.join(executorRoot, "profiles", "verifier"), { recursive: true });
    await mkdir(path.join(executorRoot, "profiles", "repairer"), { recursive: true });
    await mkdir(path.join(cpbRoot, "cpb-task", "events", "testproj"), { recursive: true });
    await writeFile(path.join(executorRoot, "profiles", "executor", "soul.md"), "# Executor", "utf8");
    await writeFile(path.join(executorRoot, "profiles", "planner", "soul.md"), "# Planner", "utf8");
    await writeFile(path.join(executorRoot, "profiles", "verifier", "soul.md"), "# Verifier", "utf8");
    await writeFile(path.join(executorRoot, "profiles", "repairer", "soul.md"), "# Repairer", "utf8");
    return { executorRoot, cpbRoot, wikiDir };
  }

  // --- Executor prompt tests ---

  it("executor prompt includes subagent guidance with Claude ACP and Task tool when CPB_WORKFLOW=accelerated", async () => {
    process.env.CPB_WORKFLOW = "accelerated";
    const { executorRoot, cpbRoot, wikiDir } = await makePromptEnv();
    try {
      const prompt = await buildExecutorPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "deliverable-001.md"), null,
      );
      assert.match(prompt, /Subagent Requirements/i);
      assert.match(prompt, /MANDATORY/);
      assert.match(prompt, /Maximum concurrent subagents: 3/);
      assert.match(prompt, /Subagents used/);
      assert.match(prompt, /Claude ACP/);
      assert.match(prompt, /Task tool/);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("executor prompt omits subagent guidance without CPB_WORKFLOW", async () => {
    delete process.env.CPB_WORKFLOW;
    const { executorRoot, cpbRoot, wikiDir } = await makePromptEnv();
    try {
      const prompt = await buildExecutorPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "deliverable-001.md"), null,
      );
      assert.doesNotMatch(prompt, /Subagent Requirements/i);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("executor prompt omits subagent guidance for standard workflow", async () => {
    process.env.CPB_WORKFLOW = "standard";
    const { executorRoot, cpbRoot, wikiDir } = await makePromptEnv();
    try {
      const prompt = await buildExecutorPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "deliverable-001.md"), null,
      );
      assert.doesNotMatch(prompt, /Subagent Requirements/i);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  // --- Planner prompt tests ---

  it("planner prompt includes subagent guidance with Codex mention when CPB_WORKFLOW=accelerated", async () => {
    process.env.CPB_WORKFLOW = "accelerated";
    const { executorRoot, cpbRoot } = await makePromptEnv();
    try {
      const prompt = await buildPlannerPrompt(
        executorRoot, cpbRoot, "testproj", "some task",
        path.join(cpbRoot, "wiki", "projects", "testproj", "inbox", "plan-001.md"),
      );
      assert.match(prompt, /Subagent Requirements/i);
      assert.match(prompt, /MANDATORY/);
      assert.match(prompt, /Codex/);
      assert.doesNotMatch(prompt, /Claude ACP/);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("planner prompt omits subagent guidance for standard workflow", async () => {
    process.env.CPB_WORKFLOW = "standard";
    const { executorRoot, cpbRoot } = await makePromptEnv();
    try {
      const prompt = await buildPlannerPrompt(
        executorRoot, cpbRoot, "testproj", "some task",
        path.join(cpbRoot, "wiki", "projects", "testproj", "inbox", "plan-001.md"),
      );
      assert.doesNotMatch(prompt, /Subagent Requirements/i);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  // --- Verifier prompt tests ---

  it("verifier prompt includes both subagent guidance and layered verification when CPB_WORKFLOW=accelerated", async () => {
    process.env.CPB_WORKFLOW = "accelerated";
    const { executorRoot, cpbRoot, wikiDir } = await makePromptEnv();
    try {
      const prompt = await buildVerifierPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "verdict-001.md"),
      );
      assert.match(prompt, /Subagent Requirements/i);
      assert.match(prompt, /MANDATORY/);
      assert.match(prompt, /Codex/);
      assert.match(prompt, /Layered Verification/);
      assert.match(prompt, /independent subagent lanes/);
      assert.match(prompt, /fast/i);
      assert.match(prompt, /changed/i);
      assert.match(prompt, /regression/i);
      assert.match(prompt, /acceptance/i);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("verifier job prompt includes both subagent guidance and layered verification when CPB_WORKFLOW=accelerated", async () => {
    process.env.CPB_WORKFLOW = "accelerated";
    const { executorRoot, cpbRoot, wikiDir } = await makePromptEnv();
    try {
      const prompt = await buildVerifierJobPrompt(
        executorRoot, cpbRoot, "testproj", "job-001",
        path.join(wikiDir, "outputs", "verdict-job-001.md"),
      );
      assert.match(prompt, /Subagent Requirements/i);
      assert.match(prompt, /MANDATORY/);
      assert.match(prompt, /Codex/);
      assert.match(prompt, /Layered Verification/);
      assert.match(prompt, /independent subagent lanes/);
      assert.match(prompt, /fast/i);
      assert.match(prompt, /changed/i);
      assert.match(prompt, /regression/i);
      assert.match(prompt, /acceptance/i);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("verifier prompt omits subagent and layered sections without CPB_WORKFLOW", async () => {
    delete process.env.CPB_WORKFLOW;
    const { executorRoot, cpbRoot, wikiDir } = await makePromptEnv();
    try {
      const prompt = await buildVerifierPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "verdict-001.md"),
      );
      assert.doesNotMatch(prompt, /Subagent Requirements/i);
      assert.doesNotMatch(prompt, /Layered Verification/);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  // --- Repairer prompt tests ---

  it("repairer prompt includes subagent guidance when CPB_WORKFLOW=accelerated", async () => {
    process.env.CPB_WORKFLOW = "accelerated";
    const { executorRoot, cpbRoot, wikiDir } = await makePromptEnv();
    try {
      const prompt = await buildRepairerPrompt(
        executorRoot, cpbRoot, "testproj", "job-001",
        path.join(wikiDir, "outputs", "repair-job-001.md"),
      );
      assert.match(prompt, /Subagent Requirements/i);
      assert.match(prompt, /MANDATORY/);
      assert.match(prompt, /Claude ACP/);
      assert.match(prompt, /Task tool/);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("repairer prompt omits subagent guidance for standard workflow", async () => {
    process.env.CPB_WORKFLOW = "standard";
    const { executorRoot, cpbRoot, wikiDir } = await makePromptEnv();
    try {
      const prompt = await buildRepairerPrompt(
        executorRoot, cpbRoot, "testproj", "job-001",
        path.join(wikiDir, "outputs", "repair-job-001.md"),
      );
      assert.doesNotMatch(prompt, /Subagent Requirements/i);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  // --- Standard workflow remains conservative ---

  it("standard workflow prompts omit subagent and layered sections", async () => {
    process.env.CPB_WORKFLOW = "standard";
    const { executorRoot, cpbRoot, wikiDir } = await makePromptEnv();
    try {
      const planner = await buildPlannerPrompt(
        executorRoot, cpbRoot, "testproj", "some task",
        path.join(cpbRoot, "wiki", "projects", "testproj", "inbox", "plan-001.md"),
      );
      const executor = await buildExecutorPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "deliverable-001.md"), null,
      );
      const verifier = await buildVerifierPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "verdict-001.md"),
      );
      for (const prompt of [planner, executor, verifier]) {
        assert.doesNotMatch(prompt, /Subagent Requirements/i);
        assert.doesNotMatch(prompt, /Layered Verification/);
      }
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

// --- Workflow validation helpers ---

describe("workflow validation helpers", () => {
  it("listWorkflows returns all known workflow names", () => {
    const names = listWorkflows();
    assert.ok(names.includes("standard"));
    assert.ok(names.includes("complex"));
    assert.ok(names.includes("blocked"));
    assert.ok(names.includes("accelerated"));
  });

  it("isWorkflowName returns true for known workflows", () => {
    assert.equal(isWorkflowName("standard"), true);
    assert.equal(isWorkflowName("complex"), true);
    assert.equal(isWorkflowName("blocked"), true);
    assert.equal(isWorkflowName("accelerated"), true);
  });

  it("isWorkflowName returns false for unknown", () => {
    assert.equal(isWorkflowName("unknown"), false);
    assert.equal(isWorkflowName("surprise"), false);
    assert.equal(isWorkflowName(""), false);
  });
});

// --- Profile-driven subagent guidance ---

describe("profile-driven subagent guidance", () => {
  const savedWorkflow = process.env.CPB_WORKFLOW;

  afterEach(() => {
    if (savedWorkflow !== undefined) {
      process.env.CPB_WORKFLOW = savedWorkflow;
    } else {
      delete process.env.CPB_WORKFLOW;
    }
  });

  async function makeProfileEnv() {
    const executorRoot = await mkdtemp(path.join(tmpdir(), "cpb-profile-exec-"));
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-profile-cpb-"));
    const wikiDir = path.join(cpbRoot, "wiki", "projects", "testproj");
    await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
    await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
    await mkdir(path.join(executorRoot, "profiles", "executor"), { recursive: true });
    await mkdir(path.join(cpbRoot, "cpb-task", "events", "testproj"), { recursive: true });
    await writeFile(path.join(executorRoot, "profiles", "executor", "soul.md"), "# Executor", "utf8");
    return { executorRoot, cpbRoot, wikiDir };
  }

  it("profile subagentGuidance forces subagent prompt without CPB_WORKFLOW", async () => {
    delete process.env.CPB_WORKFLOW;
    const { executorRoot, cpbRoot, wikiDir } = await makeProfileEnv();
    await writeFile(
      path.join(executorRoot, "profiles", "executor", "config.json"),
      JSON.stringify({ subagentGuidance: { required: true } }),
    );
    try {
      const prompt = await buildExecutorPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "deliverable-001.md"), null,
      );
      assert.match(prompt, /Subagent Requirements/i);
      assert.match(prompt, /MANDATORY/);
      assert.match(prompt, /Claude ACP/);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("profile subagentGuidance overrides maxConcurrency", async () => {
    delete process.env.CPB_WORKFLOW;
    const { executorRoot, cpbRoot, wikiDir } = await makeProfileEnv();
    await writeFile(
      path.join(executorRoot, "profiles", "executor", "config.json"),
      JSON.stringify({ subagentGuidance: { required: true, maxConcurrency: 5 } }),
    );
    try {
      const prompt = await buildExecutorPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "deliverable-001.md"), null,
      );
      assert.match(prompt, /Maximum concurrent subagents: 5/);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("profile subagentGuidance respects phases filter", async () => {
    delete process.env.CPB_WORKFLOW;
    const { executorRoot, cpbRoot, wikiDir } = await makeProfileEnv();
    await writeFile(
      path.join(executorRoot, "profiles", "executor", "config.json"),
      JSON.stringify({ subagentGuidance: { required: true, phases: ["verify"] } }),
    );
    try {
      const prompt = await buildExecutorPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "deliverable-001.md"), null,
      );
      assert.doesNotMatch(prompt, /Subagent Requirements/i);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("profile subagentGuidance applies to matching phase", async () => {
    delete process.env.CPB_WORKFLOW;
    const { executorRoot, cpbRoot, wikiDir } = await makeProfileEnv();
    await writeFile(
      path.join(executorRoot, "profiles", "executor", "config.json"),
      JSON.stringify({ subagentGuidance: { required: true, phases: ["execute"] } }),
    );
    try {
      const prompt = await buildExecutorPrompt(
        executorRoot, cpbRoot, "testproj", "001",
        path.join(wikiDir, "outputs", "deliverable-001.md"), null,
      );
      assert.match(prompt, /Subagent Requirements/i);
    } finally {
      await rm(executorRoot, { recursive: true, force: true });
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

// --- run-phase --workflow arg validation ---

describe("run-phase --workflow validation", () => {
  const execFileAsync = promisify(execFile);
  const runPhasePath = path.resolve(import.meta.dirname, "..", "bridges", "run-phase.mjs");

  it("rejects invalid --workflow value", async () => {
    try {
      await execFileAsync(process.execPath, [runPhasePath, "plan", "--workflow", "surprise", "--project", "test"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.match(err.stderr, /invalid workflow: surprise/);
    }
  });

  it("accepts valid --workflow accelerated", async () => {
    try {
      await execFileAsync(process.execPath, [runPhasePath, "plan", "--workflow", "accelerated", "--project", "test"]);
      assert.fail("should have thrown on missing --task");
    } catch (err) {
      assert.doesNotMatch(err.stderr, /invalid workflow/);
      assert.match(err.stderr, /--task is required/);
    }
  });
});

// --- repairer.sh wrapper regression ---

describe("repairer wrapper accelerated workflow", () => {
  const execFileAsync = promisify(execFile);
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const repairerPath = path.join(repoRoot, "bridges", "repairer.sh");

  it("routes repair through run-phase with Claude ACP subagent guidance", async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-repair-wrapper-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-repair-source-"));
    const stubPath = path.join(cpbRoot, "acp-stub.mjs");
    const promptCapture = path.join(cpbRoot, "repair-prompt.txt");
    const project = "testproj";
    const jobId = "job-001";
    const wikiDir = path.join(cpbRoot, "wiki", "projects", project);

    await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
    await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
    await mkdir(path.join(cpbRoot, "cpb-task", "events", project), { recursive: true });
    await mkdir(path.join(cpbRoot, "wiki", "system"), { recursive: true });
    await writeFile(path.join(wikiDir, "context.md"), "# Context\n", "utf8");
    await writeFile(path.join(wikiDir, "decisions.md"), "# Decisions\n", "utf8");
    await writeFile(path.join(wikiDir, "log.md"), "", "utf8");
    await writeFile(path.join(cpbRoot, "wiki", "system", "dashboard.md"), "## Active projects\n", "utf8");
    await writeFile(path.join(wikiDir, "project.json"), JSON.stringify({ sourcePath: sourceRoot }), "utf8");
    await writeFile(
      path.join(cpbRoot, "cpb-task", "events", project, `${jobId}.jsonl`),
      [
        JSON.stringify({
          type: "job_created",
          jobId,
          project,
          task: "Repair accelerated subagent prompt routing",
          workflow: "accelerated",
          ts: "2026-05-21T00:00:00Z",
        }),
        JSON.stringify({
          type: "phase_failed",
          jobId,
          project,
          phase: "verify",
          error: "test failure",
          ts: "2026-05-21T00:01:00Z",
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(process.env.PROMPT_CAPTURE, prompt, "utf8");
const match = prompt.match(/Write the repair report to:\\s*(.+)/);
if (!match) {
  console.error("missing repair file path");
  process.exit(2);
}
writeFileSync(match[1].trim(), "REPAIR: NOOP\\nStub repair report\\n", "utf8");
`,
      "utf8",
    );
    await chmod(stubPath, 0o755);

    try {
      await execFileAsync("bash", [repairerPath, project, jobId], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CPB_ROOT: cpbRoot,
          CPB_EXECUTOR_ROOT: repoRoot,
          CPB_PROJECT_PATH_OVERRIDE: sourceRoot,
          CPB_ACP_CLIENT: stubPath,
          CPB_CLAUDE_VARIANT: "none",
          PROMPT_CAPTURE: promptCapture,
        },
      });

      const prompt = await readFile(promptCapture, "utf8");
      const repair = await readFile(path.join(wikiDir, "outputs", "repair-001.md"), "utf8");
      assert.match(prompt, /This phase runs under Claude ACP/);
      assert.match(prompt, /Claude Code native subagents \/ Task tool/);
      assert.match(prompt, /BLOCKED: subagent tool unavailable/);
      assert.match(repair, /^REPAIR: NOOP/);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});
