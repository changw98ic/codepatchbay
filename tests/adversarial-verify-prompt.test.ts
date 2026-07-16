import assert from "node:assert/strict";
import { test } from "node:test";

import { runAdversarialVerify } from "../core/phases/adversarial_verify.js";
import { buildScopeReviewRequest } from "../core/workflow/scope-amendment.js";
import { recordValue } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

function jsonEnvelope(data: Record<string, unknown>) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

test("adversarial verifier prompt treats plan mismatch as non-blocking without concrete failure", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-prompt");
  let capturedPrompt = "";
  const pool = {
    async execute(_agent: string, prompt: string) {
      capturedPrompt = prompt;
      return {
        output: jsonEnvelope({
          status: "ok",
          verdict: "pass",
          reason: "no concrete failure remains",
          details: "checklist evidence and independent checks pass",
          confidence: 0.9,
        }),
        providerKey: "fake",
        variant: null,
      };
    },
  };

  const result = await runAdversarialVerify({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-adversarial-prompt",
    task: "Fix a SWE-bench issue using canonical local verification commands",
    sourcePath: cpbRoot,
    pool,
    sourceContext: {
      riskMap: {
        riskLevel: "high",
        domains: ["swebench"],
        adversarialFocus: ["canonical verification commands", "worktree integrity"],
      },
    },
    previousResults: [
      {
        phase: "verify",
        artifact: {
          kind: "verdict",
          name: "verdict-plan-mismatch",
          metadata: { status: "partial", reason: "plan-specific static-path gap" },
        },
      },
    ],
  });

  assert.equal(result.status, "passed");
  assert.match(
    capturedPrompt,
    /The plan artifact is an attack guide, not an independent acceptance criterion/,
    "adversarial prompt must not make the plan an independent blocker",
  );
  assert.match(
    capturedPrompt,
    /If the only remaining concern is that the implementation chose a different code path than the plan suggested/,
    "adversarial prompt must pass plan-path-only deviations when concrete evidence passes",
  );
  assert.match(
    capturedPrompt,
    /Return FAIL or PARTIAL only for a concrete behavioral failure/,
    "adversarial prompt must require a concrete failure before blocking",
  );
  assert.match(
    capturedPrompt,
    /Real-path challenge contract/,
    "adversarial prompt must explicitly attack real-path false greens",
  );
  assert.match(
    capturedPrompt,
    /bypass candidates/,
    "adversarial prompt must require bypass-candidate checks",
  );
  assert.match(
    capturedPrompt,
    /agent-authored minimal regression tests as supporting evidence only/,
    "adversarial prompt must not accept self-authored tests as sole proof",
  );
  assert.match(
    capturedPrompt,
    /blocked or absent/,
    "adversarial prompt must treat blocked critical diagnostics as missing proof",
  );
  assert.match(capturedPrompt, /explicit numbered\/bulleted task obligation/);
  assert.match(capturedPrompt, /Reject commit-date-only chronology/);
});

test("benchmark metadata does not install a special ACP command allowlist", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-swebench-diagnostic");
  const canonical = "PYTHONPATH=. python3 tests/runtests.py deprecation.test_middleware_mixin.MiddlewareMixinTests.test_coroutine";
  const diagnostic = "PYTHONPATH=. python3 tests/runtests.py deprecation.test_middleware_mixin.MiddlewareMixinTests";
  let capturedPrompt = "";
  let capturedEnv: Record<string, unknown> = {};
  const pool = {
    async execute(_agent: string, prompt: string, _cwd: string, _timeoutMs: number, meta: Record<string, unknown>) {
      capturedPrompt = prompt;
      capturedEnv = meta.env as Record<string, unknown>;
      return {
        output: jsonEnvelope({
          status: "ok",
          verdict: "pass",
          reason: "diagnostic path is visible",
          details: "diagnostic allowlist propagated",
          confidence: 0.9,
        }),
        providerKey: "fake",
        variant: null,
      };
    },
  };

  const result = await runAdversarialVerify({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "swebench-django-django-13344",
    jobId: "job-django-django-13344",
    task: [
      "Resolve this SWE-bench Verified issue in django/django.",
      "",
      "Canonical local verification commands:",
      `- FAIL_TO_PASS: ${canonical}`,
      "Allowed bounded diagnostic commands:",
      "- Diagnostic commands may supplement real-path and bypass investigation, but they are not canonical acceptance evidence.",
      `- DIAGNOSTIC: ${diagnostic}`,
      "",
      "Problem statement:",
      "Fixed async detection for middleware instances.",
    ].join("\n"),
    sourcePath: cpbRoot,
    pool,
    sourceContext: {
      productValidation: {
        validationMode: "swe-bench-verified",
        canonicalCommands: [canonical],
        diagnosticCommands: [diagnostic],
      },
      riskMap: {
        riskLevel: "high",
        domains: ["swebench"],
        adversarialFocus: ["real-path diagnostics"],
      },
    },
  });

  assert.equal(result.status, "passed");
  assert.match(capturedPrompt, /Allowed bounded diagnostic commands:/);
  assert.match(capturedPrompt, new RegExp(diagnostic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(capturedEnv.CPB_ACP_SWEBENCH_TEST_GUARD, undefined);
  assert.equal(capturedEnv.CPB_SWEBENCH_CANONICAL_COMMANDS_JSON, undefined);
  assert.equal(capturedEnv.CPB_SWEBENCH_DIAGNOSTIC_COMMANDS_JSON, undefined);
  assert.equal(capturedEnv.CPB_ACP_TOOL_CALL_BUDGET_ADVERSARIAL_VERIFY, "35");
});

const scopeChecklist = {
  items: [{
    id: "AC-001",
    requirement: "Preserve repository warning behavior",
    required: true,
    allowedFiles: ["src/table.py"],
    risk: "high",
  }],
};
const scopeExecutionMap = {
  changedFiles: ["src/table.py", "setup.cfg"],
  unmappedChangedFiles: ["setup.cfg"],
  mappings: [{ checklistId: "AC-001", changedFiles: ["src/table.py"] }],
};

function scopePreviousResults() {
  return [{
    phase: "execute",
    status: "passed",
    diagnostics: {
      candidateArtifact: { identityHash: "sha256:candidate" },
      executionMap: scopeExecutionMap,
    },
  }, {
    phase: "verify",
    status: "passed",
    artifact: { kind: "verdict", name: "verdict-1" },
  }];
}

test("adversarial verifier fails closed when a required scope review is omitted", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-scope-required");
  let capturedPrompt = "";
  const result = await runAdversarialVerify({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-adversarial-scope-required",
    task: "Preserve repository warning behavior",
    sourcePath: cpbRoot,
    sourceContext: {
      acceptanceChecklistArtifact: { name: "acceptance-checklist-1" },
      acceptanceChecklist: scopeChecklist,
      riskMap: { riskLevel: "high", adversarialFocus: ["scope expansion"] },
    },
    previousResults: scopePreviousResults(),
    pool: {
      async execute(_agent: string, prompt: string) {
        capturedPrompt = prompt;
        return {
          output: jsonEnvelope({ status: "ok", verdict: "pass", reason: "ok", details: "omitted", confidence: 0.9 }),
          providerKey: "fake",
          variant: null,
        };
      },
    },
  });

  assert.match(capturedPrompt, /FROZEN SCOPE AMENDMENT REVIEW/);
  assert.match(capturedPrompt, /setup\.cfg/);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "verdict_invalid");
  assert.match(String(result.failure?.reason), /scopeReview is required/);
});

test("adversarial verifier preserves an exact independent scope approval", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-scope-approved");
  const request = buildScopeReviewRequest({
    executionMap: scopeExecutionMap,
    checklist: scopeChecklist,
    candidateId: "sha256:candidate",
  });
  assert.ok(request);
  const approval = {
    candidateId: request.candidateId,
    requestHash: request.requestHash,
    decision: "approve",
    unmappedFiles: request.unmappedFiles,
    mappings: [{
      file: "setup.cfg",
      checklistIds: ["AC-001"],
      necessity: "The existing requirement needs a precise warning policy entry.",
      risk: "The rule was checked for overbroad warning suppression.",
      evidence: ["Exact setup.cfg diff and warning-as-error path inspected."],
    }],
  };
  const result = await runAdversarialVerify({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-adversarial-scope-approved",
    task: "Preserve repository warning behavior",
    sourcePath: cpbRoot,
    sourceContext: {
      acceptanceChecklistArtifact: { name: "acceptance-checklist-1" },
      acceptanceChecklist: scopeChecklist,
      riskMap: { riskLevel: "high", adversarialFocus: ["scope expansion"] },
    },
    previousResults: scopePreviousResults(),
    pool: {
      async execute() {
        return {
          output: jsonEnvelope({
            status: "ok",
            verdict: "pass",
            reason: "scope expansion is necessary and bounded",
            details: "independent review passed",
            confidence: 0.95,
            scopeReview: approval,
          }),
          providerKey: "fake",
          variant: null,
        };
      },
    },
  });

  assert.equal(result.status, "passed", result.failure?.reason);
  assert.deepEqual(recordValue(result.diagnostics.verdict).scopeReview, approval);
  assert.equal(recordValue(result.diagnostics.scopeReviewValidation).ok, true);
});
