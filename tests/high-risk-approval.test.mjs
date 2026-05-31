import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyRisk,
  requiresApproval,
  buildSupervisorContext,
  riskSummary,
  HIGH_RISK_PATTERNS,
} from "../core/policy/high-risk-approval.js";

describe("classifyRisk", () => {
  it("returns low for benign tasks", () => {
    const result = classifyRisk("Add a hello world page");
    assert.equal(result.level, "low");
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.matchedPatterns, []);
  });

  it("detects secrets pattern", () => {
    const result = classifyRisk("Rotate the api_key for staging");
    assert.equal(result.level, "medium");
    assert.ok(result.reasons.some((r) => r.includes("secrets")));
    assert.ok(result.matchedPatterns.includes("secrets"));
  });

  it("detects auth pattern", () => {
    const result = classifyRisk("Update authentication middleware");
    assert.ok(result.level !== "low");
    assert.ok(result.matchedPatterns.includes("auth"));
  });

  it("detects destructive db pattern", () => {
    const result = classifyRisk("drop_table users before migration");
    assert.ok(result.matchedPatterns.includes("destructive_db"));
  });

  it("detects migration pattern", () => {
    const result = classifyRisk("Run schema migration for new column");
    assert.ok(result.matchedPatterns.includes("migration"));
  });

  it("detects public api pattern", () => {
    const result = classifyRisk("Breaking change to public api endpoint");
    assert.ok(result.matchedPatterns.includes("public_api"));
  });

  it("detects infra pattern", () => {
    const result = classifyRisk("Update production deployment config");
    assert.ok(result.matchedPatterns.includes("infra"));
  });

  it("detects security pattern", () => {
    const result = classifyRisk("Fix XSS vulnerability in input");
    assert.ok(result.matchedPatterns.includes("security"));
  });

  it("returns high when multiple patterns match", () => {
    const result = classifyRisk("Fix security vulnerability in authentication token handling");
    assert.equal(result.level, "high");
    assert.ok(result.reasons.length >= 2);
  });

  it("elevates to high on critical label", () => {
    const result = classifyRisk("Fix typo", { labels: ["P0-critical"] });
    assert.ok(result.matchedPatterns.includes("critical_label"));
  });

  it("elevates to high on complex workflow + full plan", () => {
    const result = classifyRisk("Simple task", { workflow: "complex", planMode: "full" });
    assert.ok(result.matchedPatterns.includes("complex_workflow"));
    assert.equal(result.level, "medium");
  });

  it("returns high when label + pattern both match", () => {
    const result = classifyRisk("Rotate secret", { labels: ["P0"] });
    assert.equal(result.level, "high");
  });
});

describe("requiresApproval", () => {
  it("does not require approval for low risk", () => {
    const result = requiresApproval({ level: "low", reasons: [] });
    assert.equal(result.required, false);
  });

  it("requires approval for high risk regardless of phase", () => {
    const result = requiresApproval({ level: "high", reasons: ["secrets"] });
    assert.equal(result.required, true);
    assert.ok(result.reason.includes("high-risk"));
  });

  it("requires approval for medium risk on execute phase", () => {
    const result = requiresApproval({ level: "medium", reasons: ["auth"] }, null, "execute");
    assert.equal(result.required, true);
    assert.ok(result.reason.includes("medium-risk"));
  });

  it("does not require approval for medium risk on plan phase", () => {
    const result = requiresApproval({ level: "medium", reasons: ["auth"] }, null, "plan");
    assert.equal(result.required, false);
  });

  it("respects team policy override for write operation", () => {
    const policy = { approvals: { write: { required: true } } };
    const result = requiresApproval({ level: "low", reasons: [] }, policy, "plan");
    assert.equal(result.required, true);
    assert.ok(result.reason.includes("team policy"));
  });

  it("respects team policy override for shell operation on execute", () => {
    const policy = { approvals: { shell: { required: true } } };
    const result = requiresApproval({ level: "low", reasons: [] }, policy, "execute");
    assert.equal(result.required, true);
  });

  it("returns default timeout of 60 minutes for high risk", () => {
    const result = requiresApproval({ level: "high", reasons: ["secrets"] });
    assert.equal(result.timeoutMinutes, 60);
  });

  it("returns 30 minute timeout for medium risk", () => {
    const result = requiresApproval({ level: "medium", reasons: ["auth"] }, null, "execute");
    assert.equal(result.timeoutMinutes, 30);
  });
});

describe("buildSupervisorContext", () => {
  it("returns low-risk context with no hints for low risk", () => {
    const risk = { level: "low", reasons: [], matchedPatterns: [] };
    const ctx = buildSupervisorContext(risk, {});
    assert.equal(ctx.riskLevel, "low");
    assert.deepEqual(ctx.supervisorHints, []);
  });

  it("includes supervisor hints for high risk", () => {
    const risk = { level: "high", reasons: ["secrets"], matchedPatterns: ["secrets"] };
    const ctx = buildSupervisorContext(risk, {});
    assert.ok(ctx.supervisorHints.length > 0);
    assert.ok(ctx.supervisorHints.some((h) => h.includes("request_human_approval")));
  });

  it("includes secrets-specific hint", () => {
    const risk = { level: "high", reasons: ["secrets"], matchedPatterns: ["secrets"] };
    const ctx = buildSupervisorContext(risk, {});
    assert.ok(ctx.supervisorHints.some((h) => h.includes("credential rotation")));
  });

  it("includes database-specific hint", () => {
    const risk = { level: "high", reasons: ["destructive db"], matchedPatterns: ["destructive_db"] };
    const ctx = buildSupervisorContext(risk, {});
    assert.ok(ctx.supervisorHints.some((h) => h.includes("manual rollback")));
  });

  it("includes public api hint", () => {
    const risk = { level: "medium", reasons: ["public api"], matchedPatterns: ["public_api"] };
    const ctx = buildSupervisorContext(risk, {});
    assert.ok(ctx.supervisorHints.some((h) => h.includes("auto-retry")));
  });

  it("includes phase history from job", () => {
    const risk = { level: "low", reasons: [], matchedPatterns: [] };
    const job = {
      completedPhases: ["plan"],
      failureCode: "timeout",
      failurePhase: "execute",
      retryCount: 1,
      blockedReason: null,
    };
    const ctx = buildSupervisorContext(risk, job);
    assert.deepEqual(ctx.phaseHistory.completedPhases, ["plan"]);
    assert.equal(ctx.phaseHistory.failureCode, "timeout");
    assert.equal(ctx.phaseHistory.retryCount, 1);
  });
});

describe("riskSummary", () => {
  it("returns low-risk for low level", () => {
    assert.equal(riskSummary({ level: "low", reasons: [] }), "low-risk");
  });

  it("includes reasons for elevated risk", () => {
    const result = riskSummary({ level: "high", reasons: ["secrets", "auth"] });
    assert.ok(result.includes("high-risk"));
    assert.ok(result.includes("secrets"));
    assert.ok(result.includes("auth"));
  });
});

describe("HIGH_RISK_PATTERNS", () => {
  it("is an array of pattern objects", () => {
    assert.ok(Array.isArray(HIGH_RISK_PATTERNS));
    assert.ok(HIGH_RISK_PATTERNS.length >= 5);
    for (const p of HIGH_RISK_PATTERNS) {
      assert.ok(p.id, "pattern must have id");
      assert.ok(p.pattern instanceof RegExp, "pattern must be RegExp");
      assert.ok(typeof p.reason === "string", "pattern must have reason");
    }
  });
});
