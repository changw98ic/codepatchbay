import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { resolvePhases } from "../core/engine/workflow-runner.js";
import { defaultPlanModeForWorkflow, normalizeRoute } from "../core/triage/schema.js";
import { validateDeliverable } from "../core/artifacts/validators.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("MVP P0 real-run baseline", () => {
  it("defaults the standard workflow to full plan mode", () => {
    assert.equal(defaultPlanModeForWorkflow("standard"), "full");
  });

  it("resolves standard auto mode to plan, execute, and verify", () => {
    assert.deepEqual(resolvePhases("standard", "auto"), ["plan", "execute", "verify"]);
  });

  it("keeps explicit light mode available for callers that ask for it", () => {
    assert.deepEqual(resolvePhases("standard", "light"), ["plan", "execute"]);
  });

  it("uses full plan mode for the safe default route", () => {
    assert.equal(normalizeRoute({}).planMode, "full");
  });

  it("accepts deliverables that cite changed source files", () => {
    const result = validateDeliverable("Changed core/phases/plan.js and tests/real-run-baseline.test.mjs.");
    assert.equal(result.ok, true);
  });

  it("rejects prose-only deliverables even when they are long enough", () => {
    const result = validateDeliverable("Implemented the feature and verified the behavior with focused tests.");
    assert.equal(result.ok, false);
    assert.equal(result.kind, "artifact_invalid");
  });

  it("does not special-case browser-agent in the plan phase prompt path", () => {
    const source = fs.readFileSync(path.join(repoRoot, "core/phases/plan.js"), "utf8");
    assert.equal(source.includes("isBrowserAgent"), false);
    assert.equal(source.includes('agent === "browser-agent"'), false);
  });

  it("keeps browser-agent out of the main real-run baseline task scope", () => {
    const plan = fs.readFileSync(path.join(repoRoot, "docs/product/cpb-closed-loop-mvp-plan.md"), "utf8");
    assert.match(plan, /主流水线不使用 browser-agent/);
  });
});
