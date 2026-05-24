import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSetupReadinessChecks, formatReadinessJson } from "../server/services/readiness-checks.js";

describe("doctor JSON contract", () => {
  it("emits stable evidence and recommendedAction fields for every check", () => {
    const parsed = JSON.parse(formatReadinessJson({
      command: "cpb doctor",
      generatedAt: "2026-01-01T00:00:00.000Z",
      roots: { executorRoot: "/repo", hubRoot: "/hub" },
      summary: { ok: 1, warn: 1, error: 0, skipped: 0, success: true },
      checks: [
        {
          id: "node-version",
          category: "toolchain",
          status: "ok",
          severity: "info",
          message: "Node.js v24.4.1",
        },
        {
          id: "hub-liveness",
          category: "hub",
          status: "warn",
          severity: "important",
          message: "Hub not started",
          details: { reason: "no-hub-json" },
          remediation: "Run: cpb hub start",
        },
      ],
    }));

    for (const check of parsed.checks) {
      assert.ok(Object.hasOwn(check, "status"));
      assert.ok(Object.hasOwn(check, "severity"));
      assert.ok(Object.hasOwn(check, "evidence"));
      assert.ok(Object.hasOwn(check, "recommendedAction"));
    }

    assert.deepEqual(parsed.checks[0].evidence, { message: "Node.js v24.4.1" });
    assert.equal(parsed.checks[0].recommendedAction, null);
    assert.deepEqual(parsed.checks[1].evidence, { reason: "no-hub-json" });
    assert.equal(parsed.checks[1].recommendedAction, "Run: cpb hub start");
  });

  it("emits local readiness levels with explicit skipped smoke gates", () => {
    const parsed = JSON.parse(formatReadinessJson({
      command: "cpb doctor",
      generatedAt: "2026-01-01T00:00:00.000Z",
      roots: { executorRoot: "/repo", hubRoot: "/hub" },
      summary: { ok: 4, warn: 0, error: 0, skipped: 0, success: true },
      checks: [
        { id: "node-version", category: "toolchain", status: "ok", severity: "info", message: "Node.js ok" },
        { id: "disk-project", category: "disk", status: "ok", severity: "info", message: "disk ok" },
        { id: "hub-liveness", category: "hub", status: "ok", severity: "info", message: "hub ok" },
        { id: "registry-consistency", category: "registry", status: "ok", severity: "info", message: "registry ok" },
      ],
    }));

    assert.equal(parsed.readiness.currentLevel, 0);
    assert.equal(parsed.readiness.levels.length, 5);
    assert.equal(parsed.readiness.levels[0].status, "pass");
    assert.equal(parsed.readiness.levels[1].status, "skipped");
    assert.match(parsed.readiness.levels[1].recommendedAction, /health-check/);
    assert.equal(parsed.readiness.levels[3].status, "skipped");
    assert.match(parsed.readiness.levels[3].recommendedAction, /fake-acp-smoke/);
    assert.equal(parsed.readiness.levels[4].optional, true);
  });

  it("builds setup readiness checks with exact remediation commands", () => {
    const checks = buildSetupReadinessChecks({
      tools: {
        npm: { installed: true },
        brew: { installed: false },
      },
      agents: {
        codex: { installed: true, status: "installed", version: "codex-cli 0.130.0", error: null },
        opencode: { installed: false, status: "missing", version: null, error: { kind: "missing", code: "ENOENT" } },
      },
    }, [
      {
        id: "codex",
        displayName: "OpenAI Codex CLI",
        binary: "codex",
        recommended: true,
        install: { npm: { command: "npm i -g @openai/codex" } },
      },
      {
        id: "opencode",
        displayName: "OpenCode",
        binary: "opencode",
        recommended: true,
        install: {
          npm: { command: "npm install -g opencode-ai" },
          brew: { command: "brew install anomalyco/tap/opencode" },
        },
      },
    ]);

    const codex = checks.find((check) => check.id === "setup-agent-codex");
    const opencode = checks.find((check) => check.id === "setup-agent-opencode");

    assert.equal(codex.status, "ok");
    assert.equal(opencode.status, "warn");
    assert.equal(opencode.category, "setup");
    assert.equal(opencode.remediation, "Run: cpb agents install opencode --method npm");
  });

  it("preserves setup readiness in doctor JSON output", () => {
    const parsed = JSON.parse(formatReadinessJson({
      command: "cpb doctor",
      generatedAt: "2026-01-01T00:00:00.000Z",
      roots: { executorRoot: "/repo", hubRoot: "/hub" },
      summary: { ok: 1, warn: 1, error: 0, skipped: 0, success: true },
      setup: {
        schemaVersion: 1,
        tools: { node: { installed: true, status: "installed" } },
        agents: { codex: { installed: true, status: "installed" } },
      },
      checks: [
        { id: "setup-agent-codex", category: "setup", status: "ok", severity: "info", message: "OpenAI Codex CLI installed" },
        { id: "setup-agent-opencode", category: "setup", status: "warn", severity: "important", message: "OpenCode missing", remediation: "Run: cpb agents install opencode --method npm" },
      ],
    }));

    assert.equal(parsed.setup.schemaVersion, 1);
    assert.equal(parsed.setup.agents.codex.status, "installed");
    assert.equal(parsed.checks[1].recommendedAction, "Run: cpb agents install opencode --method npm");
  });
});
