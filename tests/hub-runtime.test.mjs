import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getHubRuntime, readHubLiveness, resetInstances } from "../server/services/hub-runtime.js";
import { buildAgentSetupReadiness } from "../server/services/agent-setup-readiness.js";
import { appendEvent } from "../server/services/event-store.js";
import { buildJobArtifactDetail } from "../server/services/job-artifact-detail.js";

describe("hub runtime liveness ownership", () => {
  let roots = [];

  beforeEach(async () => {
    resetInstances();
  });

  afterEach(async () => {
    resetInstances();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => {})));
    roots = [];
  });

  async function tempRoot(prefix) {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  it("does not let a second runtime persist over an already-live hub owner", async () => {
    const hubRoot = await tempRoot("cpb-hub-runtime-");
    const primaryRoot = await tempRoot("cpb-primary-runtime-");
    const secondaryRoot = await tempRoot("cpb-secondary-runtime-");

    const primary = getHubRuntime(primaryRoot, hubRoot);
    await primary.persist();

    const secondary = getHubRuntime(secondaryRoot, hubRoot);
    await secondary.persist();

    const raw = JSON.parse(await readFile(path.join(hubRoot, "state", "hub.json"), "utf8"));
    assert.equal(raw.health, "alive");
    assert.equal(raw.cpbRoot, path.resolve(primaryRoot));
  });

  it("does not let a second runtime mark another live hub owner as dead", async () => {
    const hubRoot = await tempRoot("cpb-hub-runtime-");
    const primaryRoot = await tempRoot("cpb-primary-runtime-");
    const secondaryRoot = await tempRoot("cpb-secondary-runtime-");

    const primary = getHubRuntime(primaryRoot, hubRoot);
    await primary.persist();

    const secondary = getHubRuntime(secondaryRoot, hubRoot);
    await secondary.markDead();

    const liveness = await readHubLiveness(hubRoot);
    assert.equal(liveness.alive, true);

    const raw = JSON.parse(await readFile(path.join(hubRoot, "state", "hub.json"), "utf8"));
    assert.equal(raw.health, "alive");
    assert.equal(raw.cpbRoot, path.resolve(primaryRoot));
  });
});

describe("agent setup readiness for the Agents page", () => {
  it("combines catalog metadata, detected status, and non-executing install plan commands", () => {
    const readiness = buildAgentSetupReadiness({
      setupSnapshot: {
        tools: {
          npm: { installed: true },
          brew: { installed: false },
        },
        agents: {
          codex: {
            installed: false,
            status: "missing",
            version: null,
            error: { kind: "missing", message: "not found" },
          },
          claude: {
            installed: true,
            status: "installed",
            version: "1.2.3",
            error: null,
          },
        },
      },
      catalog: [
        {
          id: "codex",
          displayName: "OpenAI Codex CLI",
          vendor: "OpenAI",
          binary: "codex",
          recommended: true,
          tier: 1,
          roles: ["planner", "verifier"],
          capabilities: ["repo_inspect"],
          install: {
            npm: {
              label: "npm",
              command: "npm i -g @openai/codex",
              sourceUrl: "https://example.invalid/codex",
            },
          },
          auth: { methods: ["chatgpt"], statusCommand: "codex auth status" },
          adapter: { protocol: "acp", command: "codex-acp" },
        },
        {
          id: "claude",
          displayName: "Claude Code",
          vendor: "Anthropic",
          binary: "claude",
          recommended: true,
          tier: 1,
          roles: ["executor"],
          capabilities: ["file_edit"],
          install: {
            npm: {
              label: "npm",
              command: "npm install -g @anthropic-ai/claude-code",
              sourceUrl: "https://example.invalid/claude",
            },
          },
          auth: { methods: ["browser_login"], statusCommand: "claude doctor" },
          adapter: { protocol: "acp", command: "claude-agent-acp" },
        },
      ],
    });

    const codex = readiness.agents.find((agent) => agent.id === "codex");
    assert.equal(codex.status, "missing");
    assert.equal(codex.installed, false);
    assert.equal(codex.recommended, true);
    assert.equal(codex.install.method, "npm");
    assert.equal(codex.install.safePlanCommand, "cpb agents install codex --method npm");
    assert.equal(codex.install.requiresExplicitConfirmation, true);
    assert.equal(codex.install.executed, false);
    assert.equal(codex.install.displayCommand, "npm i -g @openai/codex");
    assert.equal(codex.adapter.command, "codex-acp");

    const claude = readiness.agents.find((agent) => agent.id === "claude");
    assert.equal(claude.status, "installed");
    assert.equal(claude.installed, true);
    assert.equal(claude.version, "1.2.3");
    assert.equal(claude.install, null);
  });
});

describe("job artifact detail for the Job detail page", () => {
  it("returns artifact index, parsed verdict status, and broken artifact warnings", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-job-artifact-detail-"));
    try {
      const project = "artifact-proj";
      const jobId = "job-artifact-detail-001";
      const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
      await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
      await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
      await writeFile(path.join(wikiDir, "inbox", "plan-001.md"), "# Plan\n", "utf8");
      await writeFile(path.join(wikiDir, "outputs", "deliverable-001.md"), "# Deliverable\n", "utf8");
      await writeFile(path.join(wikiDir, "outputs", "verdict-001.md"), JSON.stringify({
        status: "fail",
        confidence: 0.74,
        reason: "Missing regression test.",
        layers: {
          fast: { status: "fail", detail: "Focused tests failed." },
          changed: { status: "fail", detail: "Changed path lacks coverage." },
          regression: { status: "skipped", detail: "Skipped after failure." },
          acceptance: { status: "fail", detail: "Acceptance criteria not met." },
        },
        blocking: [
          { criterion: "Regression coverage", evidence: "No expired-token test.", file: "tests/auth.test.ts", fix_hint: "Add focused coverage." },
        ],
        diff_summary: "1 file changed",
        task_goal: "Fix redirect",
        executor_summary: "Changed redirect logic",
        fix_scope: ["tests/auth.test.ts"],
      }, null, 2), "utf8");

      for (const event of [
        { type: "job_created", task: "artifact detail", workflow: "standard" },
        { type: "phase_completed", phase: "plan", artifact: "plan-001.md" },
        { type: "phase_completed", phase: "execute", artifact: "deliverable-001.md" },
        { type: "phase_completed", phase: "verify", artifact: "verdict-001.md" },
        { type: "artifact_created", kind: "diff", artifact: "diff-missing.patch", phase: "execute" },
      ]) {
        await appendEvent(cpbRoot, project, jobId, {
          jobId,
          project,
          ts: "2026-05-24T00:00:00Z",
          ...event,
        });
      }

      const detail = await buildJobArtifactDetail(cpbRoot, project, jobId);
      assert.equal(detail.project, project);
      assert.equal(detail.jobId, jobId);
      assert.equal(detail.verdict.status, "fail");
      assert.equal(detail.verdict.confidence, 0.74);
      assert.equal(detail.verdict.reason, "Missing regression test.");
      assert.equal(detail.verdict.blockingCount, 1);
      assert.ok(detail.artifactIndex.entries.some((entry) => entry.kind === "plan" && entry.broken === false));
      assert.ok(detail.artifactIndex.entries.some((entry) => entry.kind === "diff" && entry.broken === true));
      assert.ok(detail.warnings.some((warning) => /diff-missing\.patch/.test(warning.message)));
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});
