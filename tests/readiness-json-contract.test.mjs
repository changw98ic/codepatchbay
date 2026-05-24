import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatReadinessJson } from "../server/services/readiness-checks.js";

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
});
