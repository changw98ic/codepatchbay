import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runAgent } from "../core/agents/agent-runner.js";
import { FailureKind, failure } from "../core/contracts/failure.js";
import { mapChecklistRoutingLabel } from "../core/workflow/acceptance-checklist.js";
import { FailureRouter } from "../server/orchestrator/failure-router.js";

test("scope violation is a valid failure kind for checklist routing", () => {
  const result = failure({
    kind: FailureKind.SCOPE_VIOLATION,
    phase: "execute",
    reason: "changed file outside fix scope",
    retryable: false,
  });
  assert.equal(result.kind, "scope_violation");
});

test("runAgent classifies ACP policy fail-fast errors by hard-constraint kind", async () => {
  for (const [message, expectedKind] of [
    ["PERMISSION_FAIL_FAST: web tool use is disabled for this ACP run", FailureKind.WEB_TOOL_DENIED],
    ["PERMISSION_FAIL_FAST: read-only phase \"verify\" cannot run mutating terminal command (git stash)", FailureKind.READ_ONLY_MUTATION_DENIED],
    ["execute denied: broad_test_command_denied: test command is broader than the listed canonical commands", FailureKind.BROAD_TEST_COMMAND_DENIED],
    ["PERMISSION_FAIL_FAST: whole-filesystem find is denied; search the current worktree instead", FailureKind.WHOLE_FILESYSTEM_SEARCH_DENIED],
    ["PERMISSION_FAIL_FAST: tool_budget_exceeded: ACP phase exceeded normalized tool-call budget 1", FailureKind.TOOL_BUDGET_EXCEEDED],
    ["tool_budget_exceeded: claude-glm structured planning exhausted maxTurns=5 stopReason=tool_use without a recoverable StructuredOutput candidate", FailureKind.TOOL_BUDGET_EXCEEDED],
    ["claude-glm exited 1: PERMISSION_FAIL_FAST: tool_event_budget_exceeded: ACP phase exceeded normalized tool-event budget 180", FailureKind.TOOL_BUDGET_EXCEEDED],
    ["PERMISSION_FAIL_FAST: execute_no_edit_progress: execute phase exceeded no-edit read/search limit 6", FailureKind.EXECUTE_NO_EDIT_PROGRESS],
  ] as const) {
    const result = await runAgent({
      phase: "execute",
      role: "executor",
      agent: "claude-glm",
      prompt: "",
      cwd: process.cwd(),
      pool: {
        execute: async () => {
          throw new Error(message);
        },
      },
    });

    const record = result as { kind?: unknown; retryable?: unknown };
    assert.equal(record.kind, expectedKind);
    assert.equal(record.retryable, true);
  }
});

test("runAgent classifies configured execute idle before edits as no-edit progress", async () => {
  const result = await runAgent({
    phase: "execute",
    role: "executor",
    agent: "codex",
    prompt: "",
    cwd: process.cwd(),
    env: { CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "2" },
    pool: {
      execute: async () => {
        throw new Error("ACP session update idle timed out after 120000ms without session updates");
      },
    },
  });

  const record = result as { kind?: unknown; retryable?: unknown };
  assert.equal(record.kind, FailureKind.EXECUTE_NO_EDIT_PROGRESS);
  assert.equal(record.retryable, true);
});

test("runAgent keeps execute idle after edit as timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-run-agent-edit-idle-"));
  const auditPath = path.join(root, "audit.jsonl");
  await writeFile(auditPath, `${JSON.stringify({
    event: "tool_call",
    phase: "execute",
    title: "Edit django/utils/deprecation.py",
    kind: "edit",
  })}\n`, "utf8");

  const result = await runAgent({
    phase: "execute",
    role: "executor",
    agent: "codex",
    prompt: "",
    cwd: process.cwd(),
    env: { CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "5" },
    pool: {
      execute: async () => {
        throw Object.assign(
          new Error("ACP session update idle timed out after 120000ms without session updates"),
          { acpAuditFile: auditPath },
        );
      },
    },
  });

  const record = result as { kind?: unknown; retryable?: unknown };
  assert.equal(record.kind, FailureKind.TIMEOUT);
  assert.equal(record.retryable, true);
});

test("runAgent classifies provider stream disconnects as retryable transport failures", async () => {
  const result = await runAgent({
    phase: "prepare_task",
    role: "planner",
    agent: "codex",
    prompt: "",
    cwd: process.cwd(),
    pool: {
      execute: async () => {
        throw new Error("stream disconnected before completion: error sending request for url");
      },
    },
  });

  const record = result as { kind?: unknown; retryable?: unknown; diagnostics?: Record<string, unknown> };
  assert.equal(record.kind, FailureKind.AGENT_UNAVAILABLE);
  assert.equal(record.retryable, true);
  assert.equal(record.diagnostics?.transportFailure, true);
});

test("runAgent blocks an out-of-policy agent before the pool can launch it", async () => {
  let executeCalls = 0;
  const result = await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "claude",
    prompt: "",
    cwd: process.cwd(),
    env: { CPB_ALLOWED_AGENTS_JSON: JSON.stringify(["codex", "claude-glm"]) },
    pool: {
      execute: async () => {
        executeCalls += 1;
        return "should not run";
      },
    },
  });

  const record = result as { kind?: unknown; retryable?: unknown; reason?: unknown };
  assert.equal(executeCalls, 0);
  assert.equal(record.kind, FailureKind.AGENT_UNAVAILABLE);
  assert.equal(record.retryable, false);
  assert.match(String(record.reason), /outside allowed agent policy/);
});

test("runAgent classifies a null child exit as a retryable transport disappearance", async () => {
  const result = await runAgent({
    phase: "assurance_plan",
    role: "plan_arbiter",
    agent: "codex",
    prompt: "",
    cwd: process.cwd(),
    pool: {
      execute: async () => {
        throw new Error("codex exited null: ");
      },
    },
  });

  const record = result as { kind?: unknown; retryable?: unknown; exitCode?: unknown; diagnostics?: Record<string, unknown> };
  assert.equal(record.kind, FailureKind.AGENT_UNAVAILABLE);
  assert.equal(record.retryable, true);
  assert.equal(record.exitCode, null);
  assert.equal(record.diagnostics?.transportFailure, true);
});

test("checklist routing labels map to closed failure contracts", () => {
  assert.deepEqual(mapChecklistRoutingLabel("scope_violation", {}), {
    kind: FailureKind.SCOPE_VIOLATION,
    action: "mark_failed",
    retryPhase: null,
    requiresFixScope: false,
    retryable: false,
  });
  assert.deepEqual(mapChecklistRoutingLabel("checklist_failed", { fixScope: ["cli/status.ts"] }), {
    kind: FailureKind.VERIFICATION_FAILED,
    action: "retry_same_worker",
    retryPhase: "execute",
    requiresFixScope: true,
    retryable: true,
  });
  assert.deepEqual(mapChecklistRoutingLabel("evidence_missing", { evidenceMissingCause: "probe_available_not_run", fixScope: [] }), {
    kind: FailureKind.VERIFICATION_FAILED,
    action: "retry_same_worker",
    retryPhase: "verify",
    requiresFixScope: false,
    retryable: true,
  });
  assert.deepEqual(mapChecklistRoutingLabel("evidence_missing", { evidenceMissingCause: "probe_definition_missing", fixScope: [] }), {
    kind: FailureKind.VERIFICATION_FAILED,
    action: "mark_failed",
    retryPhase: null,
    requiresFixScope: false,
    retryable: false,
  });
  assert.deepEqual(mapChecklistRoutingLabel("evidence_missing", { evidenceMissingCause: "manual_approval_missing", fixScope: [] }), {
    kind: FailureKind.HUMAN_APPROVAL_REQUIRED,
    action: "mark_blocked",
    retryPhase: null,
    requiresFixScope: false,
    retryable: false,
  });
  assert.deepEqual(mapChecklistRoutingLabel("evidence_mismatch", { targetChecklistIds: ["AC-002"], fixScope: [] }), {
    kind: FailureKind.VERIFICATION_FAILED,
    action: "retry_same_worker",
    retryPhase: "execute",
    requiresFixScope: false,
    retryable: true,
  });
  assert.deepEqual(mapChecklistRoutingLabel("poisoned_session", {}), {
    kind: FailureKind.POISONED_SESSION,
    action: "mark_failed",
    retryPhase: null,
    requiresFixScope: false,
    retryable: false,
  });
  assert.deepEqual(mapChecklistRoutingLabel("runjob_panic", {}), {
    kind: FailureKind.RUNJOB_PANIC,
    action: "mark_failed",
    retryPhase: null,
    requiresFixScope: false,
    retryable: false,
  });
  assert.deepEqual(mapChecklistRoutingLabel("runtime_failure_ambiguous", {}), {
    kind: FailureKind.ARTIFACT_INVALID,
    action: "mark_failed",
    retryPhase: null,
    requiresFixScope: false,
    retryable: false,
  });
  assert.equal(mapChecklistRoutingLabel("unknown_label", {}).action, "mark_failed");
});

test("failure router applies closed actions for checklist routing labels", async () => {
  const router = new FailureRouter();
  const scopeDecision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: { failure: { kind: FailureKind.SCOPE_VIOLATION, reason: "outside fix scope", retryable: false, cause: { routingLabel: "scope_violation" } } },
  });
  assert.equal(scopeDecision.action, "mark_failed");
  assert.equal(scopeDecision.retryable, false);

  const ambiguousDecision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: { failure: { kind: FailureKind.ARTIFACT_INVALID, reason: "ambiguous attempt", retryable: false, cause: { routingLabel: "runtime_failure_ambiguous" } } },
  });
  assert.equal(ambiguousDecision.action, "mark_failed");
  assert.equal(ambiguousDecision.retryable, false);
});
