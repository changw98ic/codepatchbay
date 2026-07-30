import { test } from "node:test";
import assert from "node:assert/strict";
import { codexAcpEnvPolicy } from "../core/acp/policy.js";

// codex spawns with CPB_AGENT_SANDBOX_INHERITED="1" in production (codex has a
// native phase-aware sandbox), so codexConfiguredSandboxModeForExecution returns
// the effective phase mode. These tests mirror that real env shape.

test("read-only verify phase (codex inner sandbox) → INITIAL_AGENT_MODE=read-only", () => {
  const p = codexAcpEnvPolicy({ CPB_ACP_PHASE: "verify", CPB_AGENT_SANDBOX_INHERITED: "1" });
  assert.equal(p.INITIAL_AGENT_MODE, "read-only");
  const cfg = JSON.parse(p.CODEX_CONFIG ?? "{}");
  assert.equal(cfg.approval_policy, "never");
  assert.equal(cfg.sandbox_mode, "read-only");
});

test("mutating execute phase → INITIAL_AGENT_MODE=agent (workspace-write)", () => {
  const p = codexAcpEnvPolicy({ CPB_ACP_PHASE: "execute", CPB_AGENT_SANDBOX_INHERITED: "1" });
  assert.equal(p.INITIAL_AGENT_MODE, "agent");
  assert.equal(JSON.parse(p.CODEX_CONFIG ?? "{}").sandbox_mode, "workspace-write");
});

test("CPB outer sandbox required (not inherited) → agent-full-access (outer enforces)", () => {
  const p = codexAcpEnvPolicy({ CPB_ACP_PHASE: "verify", CPB_AGENT_SANDBOX: "required" });
  assert.equal(p.INITIAL_AGENT_MODE, "agent-full-access");
  assert.equal(JSON.parse(p.CODEX_CONFIG ?? "{}").sandbox_mode, "danger-full-access");
});

test("verifier replay workspace-write → agent (write-enabled verify)", () => {
  const p = codexAcpEnvPolicy({
    CPB_ACP_PHASE: "verify",
    CPB_VERIFIER_REPLAY_WORKSPACE_WRITE: "1",
    CPB_AGENT_SANDBOX_INHERITED: "1",
  });
  assert.equal(p.INITIAL_AGENT_MODE, "agent");
});

test("remediate role (mutating) → agent", () => {
  const p = codexAcpEnvPolicy({ CPB_ACP_ROLE: "remediator", CPB_AGENT_SANDBOX_INHERITED: "1" });
  assert.equal(p.INITIAL_AGENT_MODE, "agent");
});
