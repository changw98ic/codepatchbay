import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { runAdversarialVerify } from "../core/phases/adversarial_verify.js";
import { buildScopeReviewRequest } from "../core/workflow/scope-amendment.js";
import { recordValue } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

function jsonEnvelope(data: Record<string, unknown>) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

test("adversarial verifier treats prior plan mismatch as blocking", async () => {
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

  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "verification_failed");
  assert.match(String(result.failure?.reason), /prior verify phase left a blocking plan mismatch residual/);
  assert.equal(capturedPrompt, "");
  const cause = result.failure?.cause as {
    adversarial?: unknown;
    verificationInfrastructure?: { retryPhase?: unknown; candidateMutationAllowed?: unknown };
  } | undefined;
  assert.equal(cause?.adversarial, true);
  assert.equal(cause?.verificationInfrastructure?.retryPhase, "verify");
  assert.equal(cause?.verificationInfrastructure?.candidateMutationAllowed, false);
});

test("adversarial verifier ignores superseded plan mismatch after a fresh verify pass", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-plan-mismatch-superseded");
  let calls = 0;
  const result = await runAdversarialVerify({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-plan-mismatch-superseded",
    task: "Verify the immutable candidate",
    sourcePath: cpbRoot,
    previousResults: [{
      phase: "verify",
      status: "failed",
      artifact: {
        kind: "verdict",
        name: "verdict-plan-mismatch",
        metadata: { status: "partial", reason: "plan mismatch" },
      },
    }, {
      phase: "verify",
      status: "passed",
      artifact: {
        kind: "verdict",
        name: "verdict-fresh",
        metadata: { status: "pass", reason: "fresh immutable-candidate evidence passed" },
      },
    }],
    pool: {
      async execute() {
        calls += 1;
        return {
          output: jsonEnvelope({
            status: "ok",
            verdict: "pass",
            reason: "fresh verification supersedes the old mismatch",
            details: "latest verifier evidence is authoritative",
            confidence: 0.9,
          }),
          providerKey: "fake",
          variant: null,
        };
      },
    },
  });

  assert.equal(result.status, "passed", result.failure?.reason);
  assert.equal(calls, 1);
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
  assert.equal(capturedEnv.CPB_ACP_TOOL_EVENT_BUDGET_ADVERSARIAL_VERIFY, "140");
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

test("adversarial verifier prompt preserves frozen candidate and verification evidence", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-frozen-evidence");
  const candidatePatch = [
    "diff --git a/src/table.py b/src/table.py",
    "--- a/src/table.py",
    "+++ b/src/table.py",
    "@@ -1,3 +1,3 @@",
    "-def render(value):",
    "-    return repr(value)",
    "+def render(value):",
    "+    return str(value)",
    "",
  ].join("\n");
  const ordinaryVerifierVerdict = {
    status: "ok",
    verdict: "pass",
    reason: "real renderer path passed",
    checklistVerdict: {
      items: [{
        id: "AC-001",
        status: "pass",
        evidenceRefs: ["evidence-ledger-job-frozen:EV-001"],
      }],
    },
  };
  const patchSha256 = `sha256:${createHash("sha256").update(candidatePatch).digest("hex")}`;
  const patchBytes = Buffer.byteLength(candidatePatch, "utf8");
  const evidenceLedger = {
    schemaVersion: 1,
    ledgerId: "evidence-ledger-job-frozen",
    jobId: "job-frozen",
    project: "flow",
    attemptId: "attempt-1",
    finalWorktree: { head: "abc123", diffHash: "sha256:diff-frozen" },
    checklist: {
      status: "frozen",
      items: [{
        id: "AC-001",
        requirement: "Render table cell values without repr quotes",
        required: true,
        allowedFiles: ["src/table.py"],
      }],
    },
    evidence: [{
      id: "EV-001",
      checklistId: "AC-001",
      result: "pass",
      verificationMethod: "node:test",
      command: "npm test -- tests/table-render.test.ts",
      stdoutSha256: "sha256:stdout-frozen",
      diffHash: "sha256:diff-frozen",
    }],
  };
  let capturedPrompt = "";
  const pool = {
    async execute(_agent: string, prompt: string) {
      capturedPrompt = prompt;
      return {
        output: jsonEnvelope({
          status: "ok",
          verdict: "pass",
          reason: "frozen evidence contract was independently challenged",
          details: "candidate patch, ordinary verifier verdict, evidence ledger, checklist, and phase snapshot were present",
          confidence: 0.93,
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
    jobId: "job-frozen",
    task: "Render table cell values without repr quotes",
    sourcePath: cpbRoot,
    pool,
    sourceContext: {
      acceptanceChecklistArtifact: { name: "acceptance-checklist-frozen" },
      acceptanceChecklist: evidenceLedger.checklist,
      riskMap: {
        riskLevel: "high",
        domains: ["verification"],
        adversarialFocus: ["frozen candidate integrity", "ordinary verifier evidence"],
      },
    },
    previousResults: [{
      phase: "execute",
      status: "passed",
      diagnostics: {
        candidateArtifact: {
          schemaVersion: 1,
          baseSha: "base123",
          identityHash: "sha256:candidate-frozen",
          patchHash: patchSha256,
          treeHash: "tree123",
          changedFiles: ["src/table.py"],
        },
        candidateReplayBundle: {
          schemaVersion: 1,
          baseSha: "base123",
          candidateIdentityHash: "sha256:candidate-frozen",
          patchSha256,
          patchBytes,
          patch: candidatePatch,
        },
      },
    }, {
      phase: "verify",
      status: "passed",
      artifact: {
        kind: "verdict",
        name: "verdict-frozen",
        metadata: {
          ...ordinaryVerifierVerdict,
          reason: "ordinary verifier passed with ledger refs",
          details: "EV-001 covers AC-001",
        },
      },
      diagnostics: {
        evidenceLedger,
        evidenceLedgerArtifact: {
          kind: "evidence-ledger",
          name: "evidence-ledger-frozen",
          metadata: evidenceLedger,
        },
        checklistVerdictArtifact: {
          kind: "checklist-verdict",
          name: "checklist-verdict-frozen",
          metadata: ordinaryVerifierVerdict.checklistVerdict,
        },
      },
    }],
  });

  assert.equal(result.status, "passed", result.failure?.reason);
  const frozenEvidenceSnapshot = recordValue(result.diagnostics.frozenEvidenceSnapshot);
  assert.equal(typeof frozenEvidenceSnapshot.path, "string");
  assert.equal(typeof frozenEvidenceSnapshot.sha256, "string");
  assert.equal(typeof frozenEvidenceSnapshot.bytes, "number");
  const snapshotPath = String(frozenEvidenceSnapshot.path);
  assert.equal(
    path.relative(cpbRoot, snapshotPath).split(path.sep).slice(0, 2).join("/"),
    "phase-io/adversarial_verify",
  );
  const snapshotBytes = await readFile(snapshotPath);
  assert.equal(frozenEvidenceSnapshot.bytes, snapshotBytes.byteLength);
  assert.equal(
    frozenEvidenceSnapshot.sha256,
    `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`,
  );
  const promptRequirements: Array<[string, RegExp]> = [
    ["frozen candidate patch heading", /FROZEN CANDIDATE PATCH/],
    ["full candidate patch", /diff --git a\/src\/table\.py b\/src\/table\.py/],
    ["candidate identity", /sha256:candidate-frozen/],
    ["candidate patch sha256", new RegExp(patchSha256.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
    ["candidate patch bytes", new RegExp(String(patchBytes))],
    ["prior ordinary verifier verdict heading", /PRIOR ORDINARY VERIFIER VERDICT/],
    ["prior ordinary verifier reason", /ordinary verifier passed with ledger refs/],
    ["frozen evidence ledger heading", /FROZEN EVIDENCE LEDGER/],
    ["evidence ledger id", /evidence-ledger-job-frozen/],
    ["evidence id", /EV-001/],
    ["frozen acceptance checklist heading", /FROZEN ACCEPTANCE CHECKLIST/],
    ["checklist id", /AC-001/],
    ["phase-io snapshot heading", /ON-DISK PHASE-IO SNAPSHOT/],
    ["phase-io snapshot path", new RegExp(snapshotPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
    ["phase-io snapshot sha256", new RegExp(String(frozenEvidenceSnapshot.sha256).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
    ["phase-io snapshot bytes", new RegExp(String(frozenEvidenceSnapshot.bytes))],
    ["git history/worktree shortcut prohibition", /Do not use git (status|diff|log)/i],
    ["backup/orig/stash reconstruction prohibition", /Do not reconstruct.*(backup|\.orig|stash)/i],
  ];
  const missing = promptRequirements
    .filter(([, pattern]) => !pattern.test(capturedPrompt))
    .map(([label]) => label);
  assert.deepEqual(missing, []);
});

test("adversarial verifier fails closed when frozen evidence snapshot cannot be persisted", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-frozen-evidence-write-fail");
  const dataRoot = path.join(cpbRoot, "runtime-data-file");
  await writeFile(dataRoot, "not a directory\n", "utf8");
  let poolCalled = false;

  const result = await runAdversarialVerify({
    cpbRoot,
    dataRoot,
    project: "flow",
    jobId: "job-frozen-write-fail",
    task: "Render table cell values without repr quotes",
    sourcePath: cpbRoot,
    pool: {
      async execute() {
        poolCalled = true;
        return {
          output: jsonEnvelope({ status: "ok", verdict: "pass", reason: "unexpected", details: "unexpected", confidence: 1 }),
          providerKey: "fake",
          variant: null,
        };
      },
    },
    sourceContext: {
      acceptanceChecklistArtifact: { name: "acceptance-checklist-frozen" },
      acceptanceChecklist: {
        status: "frozen",
        items: [{ id: "AC-001", requirement: "Render table values", required: true, allowedFiles: ["src/table.py"] }],
      },
      riskMap: { riskLevel: "high", domains: ["verification"], adversarialFocus: ["frozen evidence persistence"] },
    },
    previousResults: [{
      phase: "execute",
      status: "passed",
      diagnostics: {
        candidateArtifact: { schemaVersion: 1, identityHash: "sha256:candidate-write-fail", changedFiles: ["src/table.py"] },
        candidateReplayBundle: {
          schemaVersion: 1,
          candidateIdentityHash: "sha256:candidate-write-fail",
          patchSha256: "sha256:patch-write-fail",
          patchBytes: 12,
          patch: "diff --git\n",
        },
      },
    }, {
      phase: "verify",
      status: "passed",
      artifact: { kind: "verdict", name: "verdict-write-fail", metadata: { status: "pass", verdict: "pass", reason: "ok" } },
      diagnostics: {
        evidenceLedger: { schemaVersion: 1, ledgerId: "ledger-write-fail", evidence: [] },
      },
    }],
  });

  assert.equal(poolCalled, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "artifact_invalid");
  assert.match(String(result.failure?.reason), /failed to persist frozen adversarial evidence/);
  assert.equal(recordValue(result.diagnostics).evidenceSnapshotRequired, true);
});

test("adversarial verifier stores oversized frozen patch in snapshot without inlining it", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-frozen-evidence-large-patch");
  const rawPatchMarker = "CPB_RAW_PATCH_MARKER_DO_NOT_INLINE_7f2f1b6c";
  const candidatePatch = [
    "diff --git a/src/large.py b/src/large.py",
    "--- a/src/large.py",
    "+++ b/src/large.py",
    "@@ -1,1 +1,4000 @@",
    `+${rawPatchMarker}`,
    ...Array.from({ length: 5000 }, (_value, index) => `+line_${index.toString().padStart(4, "0")}_${"x".repeat(16)}`),
    "",
  ].join("\n");
  assert.ok(Buffer.byteLength(candidatePatch, "utf8") > 64 * 1024);
  const patchSha256 = `sha256:${createHash("sha256").update(candidatePatch).digest("hex")}`;
  const patchBytes = Buffer.byteLength(candidatePatch, "utf8");
  let capturedPrompt = "";

  const result = await runAdversarialVerify({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-frozen-large-patch",
    task: "Render a large generated table patch",
    sourcePath: cpbRoot,
    pool: {
      async execute(_agent: string, prompt: string) {
        capturedPrompt = prompt;
        return {
          output: jsonEnvelope({
            status: "ok",
            verdict: "pass",
            reason: "large patch snapshot was used",
            details: "raw oversized patch was read from the frozen evidence snapshot",
            confidence: 0.9,
          }),
          providerKey: "fake",
          variant: null,
        };
      },
    },
    sourceContext: {
      acceptanceChecklistArtifact: { name: "acceptance-checklist-large" },
      acceptanceChecklist: {
        status: "frozen",
        items: [{ id: "AC-001", requirement: "Render a large generated table patch", required: true, allowedFiles: ["src/large.py"] }],
      },
      riskMap: { riskLevel: "high", domains: ["verification"], adversarialFocus: ["large frozen candidate patch"] },
    },
    previousResults: [{
      phase: "execute",
      status: "passed",
      diagnostics: {
        candidateArtifact: {
          schemaVersion: 1,
          baseSha: "base-large",
          identityHash: "sha256:candidate-large",
          patchHash: patchSha256,
          treeHash: "tree-large",
          changedFiles: ["src/large.py"],
        },
        candidateReplayBundle: {
          schemaVersion: 1,
          baseSha: "base-large",
          candidateIdentityHash: "sha256:candidate-large",
          patchSha256,
          patchBytes,
          patch: candidatePatch,
        },
      },
    }, {
      phase: "verify",
      status: "passed",
      artifact: {
        kind: "verdict",
        name: "verdict-large",
        metadata: { status: "pass", verdict: "pass", reason: "ordinary verifier accepted large patch evidence" },
      },
      diagnostics: {
        evidenceLedger: {
          schemaVersion: 1,
          ledgerId: "evidence-ledger-large",
          evidence: [{ id: "EV-001", checklistId: "AC-001", result: "pass" }],
        },
      },
    }],
  });

  assert.equal(result.status, "passed", result.failure?.reason);
  const frozenEvidenceSnapshot = recordValue(result.diagnostics.frozenEvidenceSnapshot);
  const snapshotPath = String(frozenEvidenceSnapshot.path);
  const snapshotText = await readFile(snapshotPath, "utf8");
  assert.match(capturedPrompt, /FROZEN CANDIDATE PATCH/);
  assert.match(capturedPrompt, /not inlined/i);
  assert.match(capturedPrompt, new RegExp(snapshotPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(capturedPrompt, new RegExp(patchSha256.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(capturedPrompt, new RegExp(String(patchBytes)));
  assert.equal(capturedPrompt.includes(rawPatchMarker), false);
  const snapshot = recordValue(JSON.parse(snapshotText));
  const snapshotPatch = recordValue(recordValue(snapshot.candidate).replayBundle).patch;
  assert.equal(snapshotPatch, candidatePatch);
  assert.equal(String(snapshotPatch).includes(rawPatchMarker), true);
});
