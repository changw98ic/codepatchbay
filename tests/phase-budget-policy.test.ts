import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildRiskBudgetAcpEnv, derivePhaseBudgetPolicy } from "../core/policy/phase-budget.js";
import { buildPhaseAcpEnv } from "../core/phases/phase-env.js";
import { runRemediate } from "../core/phases/remediate.js";
import { runReview } from "../core/phases/review.js";
import { tempRoot } from "./helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function jsonEnvelope(data: Record<string, unknown>) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

async function productionSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, dir), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      return productionSourceFiles(rel);
    }
    return /\.(?:mjs|js|ts)$/.test(entry.name) ? [rel] : [];
  }));
  return files.flat();
}

test("derivePhaseBudgetPolicy scales budgets and evidence by risk", () => {
  const low = derivePhaseBudgetPolicy({
    workflow: "standard",
    sourceContext: { riskMap: { riskLevel: "low", domains: ["docs"] } },
  });
  const high = derivePhaseBudgetPolicy({
    workflow: "standard",
    sourceContext: { riskMap: { riskLevel: "high", domains: ["provider_pool"], verificationDepth: "strict" } },
  });
  const critical = derivePhaseBudgetPolicy({
    workflow: "complex",
    sourceContext: { riskMap: { riskLevel: "critical", domains: ["security"], verificationDepth: "paranoid" } },
  });

  assert.equal(low.riskLevel, "low");
  assert.equal(high.riskLevel, "high");
  assert.equal(critical.riskLevel, "critical");
  assert.ok(high.evidenceRequirements.includes("adversarial_verdict"));
  assert.ok(critical.evidenceRequirements.includes("external_oracle"));
  assert.equal(high.phases["prepare_task"].toolCallBudget, 60);
  assert.ok(high.phases["execute"].toolCallBudget > low.phases["execute"].toolCallBudget);
  assert.equal(high.phases["review"].toolCallBudget, 35);
  assert.equal(high.phases["remediate"].toolEventBudget, 360);
  assert.ok(critical.phases["plan"].toolEventBudget > high.phases["plan"].toolEventBudget);
});

test("high-assurance planning denies terminal creation without shrinking the risk-derived budget", () => {
  const high = buildPhaseAcpEnv({
    sourceContext: {
      assurance: { mode: "high" },
      riskMap: { riskLevel: "high" },
    },
  }, "plan");
  const standard = buildPhaseAcpEnv({
    sourceContext: { riskMap: { riskLevel: "high" } },
  }, "plan");
  const explicit = buildPhaseAcpEnv({
    env: {
      CPB_ACP_TOOL_CALL_BUDGET_PLAN: "72",
      CPB_ACP_TOOL_EVENT_BUDGET_PLAN: "288",
    },
    sourceContext: {
      assurance: { mode: "high" },
      riskMap: { riskLevel: "high" },
    },
  }, "plan");

  assert.equal(high.CPB_ACP_TERMINAL, "deny");
  assert.equal(high.CPB_ACP_TOOL_CALL_BUDGET_PLAN, "60");
  assert.equal(high.CPB_ACP_TOOL_EVENT_BUDGET_PLAN, "240");
  assert.equal(standard.CPB_ACP_TERMINAL, undefined);
  assert.equal(standard.CPB_ACP_TOOL_CALL_BUDGET_PLAN, "60");
  assert.equal(standard.CPB_ACP_TOOL_EVENT_BUDGET_PLAN, "240");
  assert.equal(explicit.CPB_ACP_TERMINAL, "deny");
  assert.equal(explicit.CPB_ACP_TOOL_CALL_BUDGET_PLAN, "72");
  assert.equal(explicit.CPB_ACP_TOOL_EVENT_BUDGET_PLAN, "288");
});

test("high assurance gives the preferred executor time to think before cross-model fallback", () => {
  const policy = derivePhaseBudgetPolicy({
    workflow: "standard",
    sourceContext: {
      assurance: { mode: "high" },
      riskMap: { riskLevel: "medium" },
    },
  });
  const execute = policy.phases.execute;
  const env = buildRiskBudgetAcpEnv({
    workflow: "standard",
    sourceContext: {
      assurance: { mode: "high" },
      riskMap: { riskLevel: "medium" },
    },
  }, "execute");

  assert.equal(policy.riskLevel, "medium");
  assert.equal(execute.idleTimeoutMs, 360_000);
  assert.equal(execute.noEditIdleTimeoutMs, 300_000);
  assert.equal(execute.noEditToolLimit, 8);
  assert.ok(policy.reasons.includes("assurance=high_quality_time_budget"));
  assert.equal(env.CPB_ACP_IDLE_TIMEOUT_MS, "360000");
  assert.equal(env.CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS, "300000");
});

test("phase environment propagates the allowed-agent universe to the final launch gate", () => {
  const env = buildPhaseAcpEnv({
    sourceContext: {
      agentPolicy: { allowedAgents: ["codex", "claude-glm"] },
    },
  }, "verify");

  assert.equal(env.CPB_ALLOWED_AGENTS_JSON, JSON.stringify(["codex", "claude-glm"]));
  const unrestricted = buildPhaseAcpEnv({ sourceContext: {} }, "verify");
  assert.equal(unrestricted.CPB_ALLOWED_AGENTS_JSON, undefined);
});

test("derivePhaseBudgetPolicy infers product risk samples without explicit riskMap level", () => {
  const samples = [
    {
      name: "small local docs",
      ctx: { task: "Fix a README typo in the setup section", workflow: "standard" },
      riskLevel: "low",
      domain: null,
      requirement: "canonical_command",
    },
    {
      name: "standard bugfix",
      ctx: { task: "Fix formatting bug in generated report summary", workflow: "standard" },
      riskLevel: "medium",
      domain: null,
      requirement: "real_path_trace",
    },
    {
      name: "user-facing UI",
      ctx: { task: "Fix the customer UI form submit button losing edits", workflow: "standard" },
      riskLevel: "high",
      domain: "user_interface",
      requirement: "adversarial_verdict",
    },
    {
      name: "CLI surface",
      ctx: { task: "Add a CLI command smoke check for jobs report output", workflow: "standard" },
      riskLevel: "high",
      domain: "cli",
      requirement: "adversarial_verdict",
    },
    {
      name: "bare CLI surface",
      ctx: { task: "Fix cpb cli status output when a job is blocked", workflow: "standard" },
      riskLevel: "high",
      domain: "cli",
      requirement: "adversarial_verdict",
    },
    {
      name: "API integration",
      ctx: { task: "Fix GitHub webhook API retry behavior for failed requests", workflow: "standard" },
      riskLevel: "high",
      domain: "api",
      requirement: "adversarial_verdict",
    },
    {
      name: "migration dry-run",
      ctx: { task: "Add a reversible database migration dry-run before schema changes", workflow: "standard" },
      riskLevel: "high",
      domain: "database",
      requirement: "adversarial_verdict",
    },
    {
      name: "security and data loss",
      ctx: { task: "Fix auth token exposure that can cause production data loss", workflow: "direct", planMode: "light" },
      riskLevel: "critical",
      domain: "security",
      requirement: "external_oracle",
    },
  ];

  for (const sample of samples) {
    const policy = derivePhaseBudgetPolicy(sample.ctx);
    assert.equal(policy.riskLevel, sample.riskLevel, sample.name);
    assert.ok(policy.evidenceRequirements.includes(sample.requirement), sample.name);
    if (sample.domain) assert.ok(policy.domains.includes(sample.domain), sample.name);
    assert.ok(policy.reasons.some((reason) => reason.startsWith("riskSignal=")), sample.name);
  }
});

test("derivePhaseBudgetPolicy keeps explicit risk level above inferred product signals", () => {
  const policy = derivePhaseBudgetPolicy({
    task: "Fix customer UI authentication token behavior",
    workflow: "standard",
    sourceContext: { riskMap: { riskLevel: "medium", domains: ["manual_override"] } },
  });

  assert.equal(policy.riskLevel, "medium");
  assert.deepEqual(policy.domains, ["manual_override"]);
  assert.ok(policy.reasons.includes("riskSignal=explicit_risk_level"));
});

test("buildRiskBudgetAcpEnv injects ordinary task budgets without overriding explicit env", () => {
  const env = buildRiskBudgetAcpEnv({
    workflow: "standard",
    sourceContext: { riskMap: { riskLevel: "medium", domains: ["general"] } },
  }, "execute", {
    CPB_ACP_TOOL_CALL_BUDGET_EXECUTE: "999",
    CPB_ACP_IDLE_TIMEOUT_MS: "777",
  });

  assert.equal(env.CPB_TASK_RISK_LEVEL, "medium");
  assert.equal(env.CPB_ACP_TOOL_CALL_BUDGET_EXECUTE, "999");
  assert.equal(env.CPB_ACP_TOOL_EVENT_BUDGET_EXECUTE, "280");
  assert.equal(env.CPB_ACP_IDLE_TIMEOUT_MS, "777");
  assert.equal(env.CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT, "8");
  assert.equal(env.CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS, "60000");
  assert.deepEqual(JSON.parse(String(env.CPB_TASK_EVIDENCE_REQUIREMENTS_JSON)), [
    "agent_regression_test",
    "canonical_command",
    "real_path_trace",
  ]);
});

test("buildRiskBudgetAcpEnv respects global budget overrides", () => {
  const env = buildRiskBudgetAcpEnv({
    sourceContext: { riskMap: { riskLevel: "high" } },
  }, "plan", {
    CPB_ACP_TOOL_CALL_BUDGET: "12",
    CPB_ACP_TOOL_EVENT_BUDGET: "34",
  });

  assert.equal(env.CPB_ACP_TOOL_CALL_BUDGET, "12");
  assert.equal(env.CPB_ACP_TOOL_EVENT_BUDGET, "34");
  assert.equal(env.CPB_ACP_TOOL_CALL_BUDGET_PLAN, undefined);
  assert.equal(env.CPB_ACP_TOOL_EVENT_BUDGET_PLAN, undefined);
});

test("buildRiskBudgetAcpEnv injects review and remediate phase budgets", () => {
  const ctx = {
    workflow: "complex",
    sourceContext: { riskMap: { riskLevel: "high", domains: ["general"] } },
  };
  const reviewEnv = buildRiskBudgetAcpEnv(ctx, "review");
  const remediateEnv = buildRiskBudgetAcpEnv(ctx, "remediate");

  assert.equal(reviewEnv.CPB_ACP_TOOL_CALL_BUDGET_REVIEW, "35");
  assert.equal(reviewEnv.CPB_ACP_TOOL_EVENT_BUDGET_REVIEW, "140");
  assert.equal(reviewEnv.CPB_ACP_TOOL_CALL_BUDGET_EXECUTE, undefined);

  assert.equal(remediateEnv.CPB_ACP_TOOL_CALL_BUDGET_REMEDIATE, "90");
  assert.equal(remediateEnv.CPB_ACP_TOOL_EVENT_BUDGET_REMEDIATE, "360");
  assert.equal(remediateEnv.CPB_ACP_TOOL_CALL_BUDGET_EXECUTE, undefined);
});

test("review and remediate adapters pass phase-specific risk budget env to agents", async () => {
  const cpbRoot = await tempRoot("cpb-phase-budget-adapters");
  const observed: Record<string, NodeJS.ProcessEnv> = {};
  const pool = {
    async execute(_agent: string, _prompt: string, _cwd: string, _timeoutMs: number, options: { phase?: string; env?: NodeJS.ProcessEnv }) {
      observed[String(options.phase)] = options.env || {};
      if (options.phase === "review") {
        return {
          output: jsonEnvelope({
            status: "ok",
            verdict: "approved",
            summary: "review budget observed",
            comments: [],
          }),
        };
      }
      return {
        output: jsonEnvelope({
          status: "ok",
          remediationStatus: "FIXED",
          summary: "remediation budget observed",
          changes: ["core/phases/remediate.ts"],
        }),
      };
    },
  };

  const common = {
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-phase-budget-adapters",
    task: "Verify phase budget adapter env",
    sourcePath: cpbRoot,
    workflow: "complex",
    sourceContext: { riskMap: { riskLevel: "high" } },
    pool,
  };

  const review = await runReview({
    ...common,
    previousResults: [{ artifact: { kind: "deliverable", name: "deliverable-phase-budget" } }],
  });
  const remediate = await runRemediate(common);

  assert.equal(review.status, "passed", review.failure?.reason);
  assert.equal(remediate.status, "passed", remediate.failure?.reason);
  assert.equal(observed.review.CPB_ACP_TOOL_CALL_BUDGET_REVIEW, "35");
  assert.equal(observed.review.CPB_ACP_TOOL_EVENT_BUDGET_REVIEW, "140");
  assert.equal(observed.review.CPB_TASK_RISK_LEVEL, "high");
  assert.equal(observed.review.CPB_ACP_TOOL_CALL_BUDGET_EXECUTE, undefined);
  assert.equal(observed.remediate.CPB_ACP_TOOL_CALL_BUDGET_REMEDIATE, "90");
  assert.equal(observed.remediate.CPB_ACP_TOOL_EVENT_BUDGET_REMEDIATE, "360");
  assert.equal(observed.remediate.CPB_TASK_RISK_LEVEL, "high");
  assert.equal(observed.remediate.CPB_ACP_TOOL_CALL_BUDGET_EXECUTE, undefined);
});

test("coding task agent surfaces stay phase-budgeted and direct pool execution stays allowlisted", async () => {
  const expectedPhaseSurfaces = [
    {
      file: "core/engine/run-job-assurance.ts",
      phase: 'phase: "plan"',
      env: 'const agentEnv = buildPhaseAcpEnv(ctx, "plan")',
      envPass: "env: agentEnv",
    },
    {
      file: "core/phases/plan.ts",
      phase: 'phase: "plan"',
      env: 'env: buildPhaseAcpEnv(ctx, "plan")',
    },
    {
      file: "core/phases/execute.ts",
      phase: 'phase: "execute"',
      env: '...buildPhaseAcpEnv(ctx, "execute")',
      envPass: "CPB_ACP_WRITE_ALLOW",
    },
    {
      file: "core/phases/review.ts",
      phase: 'phase: "review"',
      env: 'env: buildPhaseAcpEnv(ctx, "review")',
    },
    {
      file: "core/phases/remediate.ts",
      phase: 'phase: "remediate"',
      env: 'env: buildPhaseAcpEnv(ctx, "remediate")',
    },
    {
      file: "core/phases/verify.ts",
      phase: 'phase: "verify"',
      env: 'env: buildDisposableVerificationReplayEnv(ctx)',
      envPass: "env: verifierEnv",
    },
    {
      file: "core/phases/adversarial_verify.ts",
      phase: 'phase: "adversarial_verify"',
      env: 'env: buildPhaseAcpEnv(ctx, "adversarial_verify")',
    },
    {
      file: "core/workflow/checklist-decomposer.ts",
      phase: "phase: CHECKLIST_DECOMPOSE_PHASE",
      env: "env: buildRiskBudgetAcpEnv(ctx, CHECKLIST_DECOMPOSE_PHASE",
    },
  ];

  for (const surface of expectedPhaseSurfaces) {
    const source = await readFile(path.join(repoRoot, surface.file), "utf8");
    assert.match(source, /\brunAgent\(\{/u, `${surface.file} should launch through runAgent`);
    assert.ok(source.includes(surface.phase), `${surface.file} should set ${surface.phase}`);
    assert.ok(source.includes(surface.env), `${surface.file} should use a phase budget env builder`);
    if (surface.envPass) {
      assert.ok(source.includes(surface.envPass), `${surface.file} should pass the derived phase budget env`);
    }
    assert.doesNotMatch(source, /env:\s*ctx\.env/u, `${surface.file} must not pass raw ctx.env to runAgent`);
  }

  const runAgentSurfaceFiles = [];
  for (const file of (await Promise.all([
    productionSourceFiles("core"),
    productionSourceFiles("server"),
    productionSourceFiles("runtime"),
    productionSourceFiles("bridges"),
    productionSourceFiles("cli"),
    productionSourceFiles("scripts"),
  ])).flat()) {
    if (file === "core/agents/agent-runner.ts") continue;
    const source = await readFile(path.join(repoRoot, file), "utf8");
    if (/\brunAgent\s*\(\s*\{/u.test(source)) runAgentSurfaceFiles.push(file);
  }
  assert.deepEqual(
    runAgentSurfaceFiles.sort(),
    expectedPhaseSurfaces.map((surface) => surface.file).sort(),
    "new production runAgent() call sites must be added to the phase-budget surface guard",
  );

  const allowedDirectExecuteFiles = new Set([
    "core/agents/agent-runner.ts",
    "runtime/evolve/multi-evolve.ts",
    "scripts/validate-scan-readiness.ts",
    "server/orchestrator/acp-supervisor.ts",
    "server/services/issue-triage.ts",
  ]);
  const scannedFiles = (await Promise.all([
    productionSourceFiles("core"),
    productionSourceFiles("server"),
    productionSourceFiles("runtime"),
    productionSourceFiles("bridges"),
    productionSourceFiles("cli"),
    productionSourceFiles("scripts"),
  ])).flat();
  const directExecuteFiles = [];
  for (const file of scannedFiles) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    if (/\.\s*execute\s*\(/u.test(source)) directExecuteFiles.push(file);
  }

  assert.deepEqual(
    directExecuteFiles.sort(),
    [...allowedDirectExecuteFiles].sort(),
    "new production .execute() call sites must be reviewed: coding-task phases should use runAgent with phase-budget env; control-plane/script exceptions belong in this allowlist",
  );
});
