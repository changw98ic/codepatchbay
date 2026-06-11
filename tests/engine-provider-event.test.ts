import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { appendEvent, materializeJob, readEvents } from "../server/services/event/event-store.js";
import {
  _internalMarkProviderUnavailable,
  assertProviderAvailable,
  QuotaStatus,
  readProviderQuotas,
} from "../server/services/provider-quota.js";
import { getProviderAdapter } from "../server/services/provider-quota.js";
import {
  delegateEnqueueProviderUsage,
  delegateMarkProviderUnavailable,
} from "../server/services/quota-delegate-client.js";
import { resolveTaskRoute } from "../core/workflow/auto-route.js";
import { tempRoot } from "./helpers.js";

type AnyRecord = Record<string, any>;

process.env.CPB_PHASE_RETRY_MAX = "1";
process.env.CPB_PHASE_RETRY_BASE_DELAY_MS = "0";
process.env.CPB_PHASE_FEEDBACK_RETRY_MAX = "1";
process.env.CPB_DELEGATE_ACK_POLL_MS = "10";
process.env.CPB_DELEGATE_ACK_TIMEOUT_MS = "80";

test("readProviderQuotas only falls back to legacy rate-limits when quotas file is missing", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-fallback");
  await mkdir(path.join(hubRoot, "providers"), { recursive: true });
  await writeFile(
    path.join(hubRoot, "providers", "rate-limits.json"),
    `${JSON.stringify({ legacy: { reason: "old" } })}\n`,
    "utf8",
  );

  assert.deepEqual(await readProviderQuotas(hubRoot), { legacy: { reason: "old" } });

  await writeFile(path.join(hubRoot, "providers", "quotas.json"), "{bad json", "utf8");
  assert.deepEqual(await readProviderQuotas(hubRoot), {});
});

let runJobPromise: Promise<any> | null = null;
async function loadRunJob() {
  runJobPromise ||= import("../core/engine/run-job.js").then((mod) => mod.runJob);
  return runJobPromise;
}

function jsonEnvelope(data: AnyRecord) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

function phaseOutput(role: string, overrides: AnyRecord = {}) {
  if (role === "planner") {
    return jsonEnvelope({
      status: "ok",
      planMarkdown: [
        "## Analysis",
        "- Engine provider fallback fixture.",
        "",
        "## Files to modify",
        "- README.md",
        "",
        "## Implementation Steps",
        "1. Exercise phase orchestration.",
        "",
        "## Testing",
        "- node:test engine fixture",
        "",
        "## Risks",
        "- Fixture only.",
      ].join("\n"),
      ...overrides,
    });
  }
  if (role === "executor") {
    return jsonEnvelope({
      status: "ok",
      summary: "Engine fixture completed and referenced README.md.",
      tests: ["tests/engine-provider-event.test.js"],
      risks: ["No source mutation expected."],
      ...overrides,
    });
  }
  if (role === "reviewer") {
    return jsonEnvelope({
      status: "ok",
      verdict: "approved",
      summary: "Review approved.",
      comments: [],
      ...overrides,
    });
  }
  return jsonEnvelope({
    status: "ok",
    verdict: "pass",
    reason: "Engine fixture verified.",
    details: "The fake provider completed the phase.",
    confidence: 1,
    ...overrides,
  });
}

async function makeSourceRoot(prefix = "cpb-engine-source") {
  const sourcePath = await tempRoot(prefix);
  await writeFile(path.join(sourcePath, "README.md"), "# Engine Fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "engine-fixture", private: true }, null, 2)}\n`, "utf8");
  return sourcePath;
}

function makeServices({ events = [], starts = [], completed = [], failed = [] }: AnyRecord = {}) {
  return {
    createJob: async (_cpbRoot, job) => ({
      ...job,
      jobId: job.jobId || "job-engine",
      status: "running",
    }),
    prepareTask: async () => ({
      riskMap: {
        riskLevel: "medium",
        domains: ["test_fixture"],
        highRiskFiles: [],
        safetyBoundaries: [],
        verificationDepth: "standard",
        adversarialRequired: false,
        adversarialFocus: [],
        confidence: "high",
      },
    }),
    startPhase: async (_cpbRoot, project, jobId, { phase }) => {
      starts.push(phase);
      events.push({ type: "phase_started", project, jobId, phase });
    },
    blockJob: async (_cpbRoot, project, jobId, failure) => {
      events.push({ type: "job_blocked", project, jobId, ...failure });
    },
    completePhase: async (_cpbRoot, project, jobId, { phase, artifact }) => {
      completed.push(phase);
      events.push({ type: "phase_completed", project, jobId, phase, artifact });
    },
    completeJob: async (_cpbRoot, project, jobId) => {
      events.push({ type: "job_completed", project, jobId });
    },
    failJob: async (_cpbRoot, project, jobId, failure) => {
      failed.push(failure);
      events.push({ type: "job_failed", project, jobId, ...failure });
    },
    appendEvent: async (_cpbRoot, project, jobId, event) => {
      events.push({ project, jobId, ...event });
      return event;
    },
  };
}

function makePool({ onExecute, calls = [], releases = [] }: AnyRecord = {}) {
  return {
    providerKey(agent, variant) {
      return variant ? `${agent}:${variant}` : agent;
    },
    fallbackCandidates(_agent, _variant, excludeKey) {
      return [
        { agent: "fake-secondary", variant: null, providerKey: "fake-secondary" },
        { agent: "fake-tertiary", variant: null, providerKey: "fake-tertiary" },
      ].filter((candidate) => candidate.providerKey !== excludeKey);
    },
    async execute(agent, prompt, cwd, timeoutMs, meta) {
      calls.push({ agent, prompt, cwd, timeoutMs, meta });
      if (onExecute) {
        const value = await onExecute({ agent, prompt, cwd, timeoutMs, meta, calls });
        if (value !== undefined) return value;
      }
      return { output: phaseOutput(meta.role), providerKey: this.providerKey(agent, meta.variant), variant: meta.variant || null };
    },
    async releaseWorktree(cwd, reason, options) {
      releases.push({ cwd, reason, options });
      return true;
    },
  };
}

async function startDelegateAckLoop(t, hubRoot) {
  const seen = new Set();
  let active = true;
  const tick = async () => {
    if (!active) return;
    const inbox = path.join(hubRoot, "providers", "delegate", "inbox");
    const acks = path.join(hubRoot, "providers", "delegate", "acks");
    let files = [];
    try {
      files = (await readdir(inbox)).filter((file) => file.endsWith(".json"));
    } catch {}
    await mkdir(acks, { recursive: true });
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      const command = JSON.parse(await readFile(path.join(inbox, file), "utf8"));
      await writeFile(
        path.join(acks, `${command.commandId}.json`),
        `${JSON.stringify({ ok: true, entry: command.entry || null })}\n`,
        "utf8",
      );
    }
  };
  const timer = setInterval(() => { tick().catch(() => {}); }, 10);
  t.after(() => {
    active = false;
    clearInterval(timer);
  });
}

async function readDelegateUsageCommands(hubRoot) {
  const inbox = path.join(hubRoot, "providers", "delegate", "inbox");
  let files = [];
  try {
    files = (await readdir(inbox)).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const commands = [];
  for (const file of files) {
    try {
      commands.push(JSON.parse(await readFile(path.join(inbox, file), "utf8")));
    } catch {}
  }
  return commands.filter((command) => command.type === "usage_write");
}

async function runEngine({
  cpbRoot = null,
  dataRoot = null,
  hubRoot = null,
  sourcePath = null,
  sourceContext = {},
  workflow = "standard",
  planMode = "full",
  servicesState = {},
  pool = null,
  agents = null,
  routing = null,
  agentAvailability = null,
  agentHealth = null,
  teamPolicy = null,
  providerServices = {
    assertProviderAvailable,
    getProviderAdapter,
    delegateMarkProviderUnavailable,
    delegateEnqueueProviderUsage,
  },
  jobId = "job-engine",
} = {}) {
  const runJob = await loadRunJob();
  const root = cpbRoot || await tempRoot("cpb-engine-cpb");
  const runtimeRoot = dataRoot || path.join(root, "runtime");
  const source = sourcePath || await makeSourceRoot();
  const services = makeServices(servicesState);
  const effectivePool = pool || makePool();
  const result = await runJob({
    cpbRoot: root,
    dataRoot: runtimeRoot,
    hubRoot,
    project: "proj",
    task: "engine provider fixture",
    jobId,
    workflow,
    planMode,
    sourcePath: source,
    sourceContext,
    agents: agents || {
      planner: "fake-primary",
      executor: "fake-primary",
      reviewer: "fake-primary",
      verifier: "fake-primary",
    },
    routing,
    agentAvailability,
    agentHealth,
    teamPolicy,
    providerServices,
    ...services,
    getPool: () => effectivePool,
  });
  return { result, cpbRoot: root, sourcePath: source };
}

test("runJob preserves phase order and switches unavailable providers during preflight", async () => {
  const hubRoot = await tempRoot("cpb-engine-hub-preflight");
  const events = [];
  const starts = [];
  const completed = [];
  const calls = [];
  await _internalMarkProviderUnavailable(hubRoot, {
    providerKey: "fake-primary",
    agent: "fake-primary",
    status: QuotaStatus.RATE_LIMITED,
    nextEligibleAt: Date.now() + 60_000,
    source: "test",
    reason: "preflight saturated",
  } as any);

  const { result } = await runEngine({
    hubRoot,
    servicesState: { events, starts, completed },
    pool: makePool({ calls }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(starts, ["plan", "execute", "verify"]);
  assert.deepEqual(completed, ["plan", "execute", "verify"]);
  assert.deepEqual(result.phaseResults.map((phase) => phase.phase), ["plan", "execute", "verify"]);
  assert.ok(calls.every((call) => call.agent === "fake-secondary"));
  assert.ok(events.some((event) => event.type === "provider_handoff" && event.phase === "plan" && event.from === "fake-primary" && event.to === "fake-secondary"));
});

test("runJob does not invent provider fallbacks when the pool has none", async () => {
  const hubRoot = await tempRoot("cpb-engine-hub-no-dynamic-fallback");
  const events = [];
  const failed = [];
  const calls = [];
  await _internalMarkProviderUnavailable(hubRoot, {
    providerKey: "fake-primary",
    agent: "fake-primary",
    status: QuotaStatus.RATE_LIMITED,
    nextEligibleAt: Date.now() + 60_000,
    source: "test",
    reason: "preflight saturated",
  } as any);

  const pool = makePool({ calls });
  pool.fallbackCandidates = () => [];

  const { result } = await runEngine({
    hubRoot,
    servicesState: { events, failed },
    pool,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.kind, FailureKind.AGENT_RATE_LIMITED);
  assert.equal(result.failure.phase, "plan");
  assert.match(result.failure.reason, /all providers unavailable for planner/);
  assert.equal(calls.length, 0);
  assert.ok(!events.some((event) => event.type === "provider_handoff"));
});

test("runJob applies dynamic agent plan config before provider execution", async () => {
  const calls = [];

  const { result } = await runEngine({
    pool: makePool({ calls }),
    sourceContext: {
      dynamicAgentPlan: {
        agentConfig: {
          executor: { agent: "fake-secondary" },
        },
      },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(calls.find((call) => call.meta.role === "executor")?.agent, "fake-secondary");
  assert.equal(calls.find((call) => call.meta.role === "planner")?.agent, "fake-primary");
});

test("runJob blocks required dynamic roles as agent_unavailable when provider preflight fails", async () => {
  const hubRoot = await tempRoot("cpb-engine-hub-required-dynamic-unavailable");
  const events = [];
  const calls = [];
  await _internalMarkProviderUnavailable(hubRoot, {
    providerKey: "fake-primary",
    agent: "fake-primary",
    status: QuotaStatus.RATE_LIMITED,
    nextEligibleAt: Date.now() + 60_000,
    source: "test",
    reason: "required dynamic planner unavailable",
  } as any);

  const { result } = await runEngine({
    hubRoot,
    servicesState: { events },
    pool: makePool({ calls }),
    sourceContext: {
      dynamicAgentPlan: {
        agentConfig: {
          planner: { agent: "fake-primary", required: true },
        },
      },
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.kind, FailureKind.AGENT_UNAVAILABLE);
  assert.equal(result.failure.phase, "plan");
  assert.equal(result.failure.cause.requiredDynamicRole, true);
  assert.equal(calls.length, 0);
  assert.ok(!events.some((event) => event.type === "provider_handoff"));
});

test("runJob applies configured phase fallback before provider execution", async () => {
  const events = [];
  const calls = [];
  const routing = {
    planner: "fake-primary",
    executor: "fake-primary",
    verifier: "fake-primary",
    fallback: { verifier: "fake-secondary" },
    allowFallback: true,
  };

  const { result } = await runEngine({
    servicesState: { events },
    pool: makePool({ calls }),
    routing,
    agentAvailability: {
      "fake-primary": { available: false, status: "offline" },
    },
  });

  assert.equal(result.status, "completed");
  const verifyCall = calls.find((call) => call.meta.role === "verifier");
  assert.equal(verifyCall.agent, "fake-secondary");
  const verifyDecision = events.find((event) => event.type === "agent_routing_decision" && event.phase === "verify");
  assert.ok(verifyDecision);
  assert.equal(verifyDecision.preferredAgent, "fake-primary");
  assert.equal(verifyDecision.selectedAgent, "fake-secondary");
  assert.equal(verifyDecision.fallbackApplied, true);
});

test("runJob tolerates missing provider services when provider checks are unused", async () => {
  const calls = [];
  const { result } = await runEngine({
    providerServices: null,
    pool: makePool({ calls }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => call.meta.role), ["planner", "executor", "verifier"]);
});

test("materializeJob keeps phase fallback separate from job executor selection", () => {
  const job = materializeJob([
    {
      type: "job_created",
      jobId: "job-routing-state",
      project: "proj",
      task: "route",
      executor: "claude",
      ts: "2026-06-04T00:00:00.000Z",
    },
    {
      type: "agent_routing_decision",
      jobId: "job-routing-state",
      project: "proj",
      phase: "verify",
      role: "verifier",
      preferredAgent: "codex",
      selectedAgent: "claude",
      fallbackAgent: "claude",
      fallbackAllowed: true,
      fallbackApplied: true,
      reason: "preferred unavailable",
      ts: "2026-06-04T00:01:00.000Z",
    },
  ]) as AnyRecord;

  assert.equal(job.executor, "claude");
  assert.equal(job.executorSelection, undefined);
  assert.equal(job.phaseAgentSelections.length, 1);
  assert.equal(job.phaseAgentSelections[0].phase, "verify");
  assert.equal(job.phaseAgentSelections[0].role, "verifier");
});

test("runJob releases ACP provider resources after every phase attempt", async () => {
  const calls = [];
  const releases = [];
  const { result, sourcePath } = await runEngine({
    pool: makePool({ calls, releases }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => call.meta.role), ["planner", "executor", "verifier"]);
  assert.deepEqual(releases.map((release) => release.reason), [
    "phase_plan_complete",
    "phase_execute_complete",
    "phase_verify_complete",
  ]);
  assert.ok(releases.every((release) => release.cwd === sourcePath));
  assert.ok(releases.every((release) => release.options?.closeProvider === true));
});

test("trusted simple tasks auto-route to direct execute and verify phases", async () => {
  const route = resolveTaskRoute({
    task: "Update README docs wording for the install section",
    actor: "cli",
    trustedActors: ["cli"],
  });
  const calls = [];

  assert.equal(route.workflow, "direct");
  assert.equal(route.planMode, "light");

  const { result } = await runEngine({
    workflow: route.workflow,
    planMode: route.planMode,
    pool: makePool({ calls }),
    agents: {
      executor: "fake-primary",
      verifier: "fake-primary",
      planner: "fake-primary",
      reviewer: "fake-primary",
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.phaseResults.map((phase) => phase.phase), ["execute", "verify"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.meta.role), ["executor", "verifier"]);
});

test("complex implementation tasks mentioning tests keep the standard full pipeline", () => {
  const route = resolveTaskRoute({
    task: "Implement the MVP Local Review Bundle and finalizer bridge. Expose hub APIs and CLI surfaces, and include focused tests.",
    actor: "cli",
    trustedActors: ["cli"],
  });

  assert.equal(route.workflow, "standard");
  assert.equal(route.planMode, "full");
  assert.equal(route.triageApplied, true);
  assert.equal(route.decision.ruleRoute.category, "implementation");
});

test("unknown auto-routed tasks keep the requested safe default", async () => {
  const route = resolveTaskRoute({
    task: "Build a small Vue dashboard page",
    actor: "cli",
    trustedActors: ["cli"],
  });

  assert.equal(route.workflow, "standard");
  assert.equal(route.planMode, "auto");
  assert.equal(route.triageApplied, false);
});

test("protected complex tasks auto-upgrade to plan, execute, review, and verify", async () => {
  const route = resolveTaskRoute({
    task: "Refactor auth session handling and update database migration safety checks",
    actor: "cli",
    trustedActors: ["cli"],
  });
  const calls = [];

  assert.equal(route.workflow, "complex");
  assert.equal(route.planMode, "full");

  const { result } = await runEngine({
    workflow: route.workflow,
    planMode: route.planMode,
    pool: makePool({ calls }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.phaseResults.map((phase) => phase.phase), ["plan", "execute", "review", "verify"]);
  assert.deepEqual(calls.map((call) => call.meta.role), ["planner", "executor", "reviewer", "verifier"]);
});

test("runJob preserves verifier provider diagnostics on successful verify", async () => {
  const calls = [];

  const { result } = await runEngine({
    pool: makePool({ calls }),
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: { agent: "fake-primary", variant: "mimo-v2.5pro" },
    },
  });

  assert.equal(result.status, "completed");
  const verifyResult = result.phaseResults.find((phase) => phase.phase === "verify");
  assert.ok(verifyResult, "verify phase result should be recorded");
  assert.equal(verifyResult.diagnostics.agent, "fake-primary");
  assert.equal(verifyResult.diagnostics.role, "verifier");
  assert.equal(verifyResult.diagnostics.providerKey, "fake-primary:mimo-v2.5pro");
  assert.equal(verifyResult.diagnostics.variant, "mimo-v2.5pro");
  assert.equal(typeof verifyResult.diagnostics.elapsedMs, "number");
  assert.equal(calls.find((call) => call.meta.role === "verifier")?.meta.variant, "mimo-v2.5pro");
  assert.equal(verifyResult.diagnostics.verdict.status, "pass");
  assert.ok(verifyResult.diagnostics.verificationEvidence);
  assert.ok(verifyResult.diagnostics.promptArtifact?.name);
});

test("runJob returns verifier verdict cause for failed verification retry", async () => {
  const { result } = await runEngine({
    pool: makePool({
      onExecute: async ({ meta }) => {
        if (meta.role !== "verifier") return undefined;
        return {
          output: phaseOutput("verifier", {
            verdict: "fail",
            reason: "unit tests failed",
            details: "src/api.js still returns the wrong value.",
            confidence: 0.82,
          }),
          providerKey: "fake-primary",
          variant: null,
        };
      },
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.kind, FailureKind.VERIFICATION_FAILED);
  assert.equal(result.failure.phase, "verify");
  assert.equal(result.failure.cause.verdict.status, "fail");
  assert.equal(result.failure.cause.verdict.reason, "unit tests failed");
  assert.equal(result.failure.cause.artifact.kind, "verdict");
  assert.match(result.failure.cause.artifact.path, /verdict-/);
});

test("runJob records ACP token usage in phase events and provider usage commands", async () => {
  const hubRoot = await tempRoot("cpb-engine-hub-usage");
  const events = [];
  const usageByRole = {
    planner: { inputTokens: 10, outputTokens: 4, totalTokens: 14, tokenSource: "acp_audit_prompt_usage" },
    executor: { inputTokens: 20, outputTokens: 8, totalTokens: 28, tokenSource: "acp_audit_prompt_usage" },
    verifier: { inputTokens: 30, outputTokens: 12, totalTokens: 42, tokenSource: "acp_audit_prompt_usage" },
  };
  const pool = makePool({
    onExecute: async ({ agent, meta }) => ({
      output: phaseOutput(meta.role),
      providerKey: agent,
      variant: null,
      usage: usageByRole[meta.role],
    }),
  });

  const { result } = await runEngine({
    hubRoot,
    servicesState: { events },
    pool,
  });

  assert.equal(result.status, "completed");
  const executeEvent = events.find((event) => event.type === "phase_result" && event.phase === "execute");
  assert.equal(executeEvent.usage.totalTokens, 28);
  assert.equal(executeEvent.usage.inputTokens, 20);

  const usageCommands = await readDelegateUsageCommands(hubRoot);
  const executeUsage = usageCommands.find((command) => command.record?.phase === "execute");
  assert.equal(executeUsage.record.usage.totalTokens, 28);
  assert.equal(executeUsage.record.usage.tokenSource, "acp_audit_prompt_usage");
});

test("runJob hands off mid-run rate limits to a fallback provider", async (t) => {
  const hubRoot = await tempRoot("cpb-engine-hub-midrun");
  await startDelegateAckLoop(t, hubRoot);
  const events = [];
  const calls = [];
  let executePrimaryFailed = false;

  const pool = makePool({
    calls,
    onExecute: async ({ agent, meta }) => {
      if (meta.role === "executor" && agent === "fake-primary" && !executePrimaryFailed) {
        executePrimaryFailed = true;
        const err = new Error("429 rate limit from primary") as Error & AnyRecord;
        err.name = "RateLimitError";
        err.providerKey = "fake-primary";
        err.status = "rate_limited";
        err.nextEligibleAt = Date.now() + 60_000;
        err.confidence = 1;
        throw err;
      }
      return { output: phaseOutput(meta.role), providerKey: agent, variant: null };
    },
  });

  const { result } = await runEngine({
    hubRoot,
    servicesState: { events },
    pool,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    calls.filter((call) => call.meta.role === "executor").map((call) => call.agent),
    ["fake-primary", "fake-secondary"],
  );
  const handoff = events.find((event) => event.type === "provider_handoff" && event.phase === "execute" && event.midRun);
  assert.equal(handoff.from, "fake-primary");
  assert.equal(handoff.to, "fake-secondary");
});

test("runJob turns quota delegate write failure into structured runtime failure", async () => {
  const hubRoot = await tempRoot("cpb-engine-hub-delegate-fail");
  const events = [];
  const failed = [];
  const pool = makePool({
    onExecute: async ({ agent, meta }) => {
      if (meta.role === "executor" && agent === "fake-primary") {
        const err = new Error("429 rate limit without delegate") as Error & AnyRecord;
        err.name = "RateLimitError";
        err.providerKey = "fake-primary";
        err.status = "rate_limited";
        err.nextEligibleAt = Date.now() + 60_000;
        throw err;
      }
      return { output: phaseOutput(meta.role), providerKey: agent, variant: null };
    },
  });

  const { result } = await runEngine({
    hubRoot,
    servicesState: { events, failed },
    pool,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(result.failure.phase, "execute");
  assert.match(result.failure.reason, /quota delegate failure/);
  assert.equal(failed[0].code, FailureKind.RUNTIME_INTERRUPTED);
});

test("runJob retries transient phase failures and corrects artifact validation failures", async () => {
  const events = [];
  const calls = [];
  let planAttempts = 0;
  let executeAttempts = 0;
  const pool = makePool({
    calls,
    onExecute: async ({ meta }) => {
      if (meta.role === "planner") {
        planAttempts += 1;
        if (planAttempts === 1) {
          const err = new Error("planner spawn failed") as Error & AnyRecord;
          err.code = "ENOENT";
          throw err;
        }
      }
      if (meta.role === "executor") {
        executeAttempts += 1;
        if (executeAttempts === 1) {
          return { output: phaseOutput("executor", { summary: "No source reference here.", tests: [], risks: [] }), providerKey: "fake-primary" };
        }
      }
      return { output: phaseOutput(meta.role), providerKey: "fake-primary", variant: null };
    },
  });

  const started = Date.now();
  const { result } = await runEngine({
    servicesState: { events },
    pool,
  });

  assert.equal(result.status, "completed");
  assert.ok(Date.now() - started < 5_000, "test retry delay should be configurable below the production backoff");
  assert.equal(planAttempts, 2);
  assert.equal(executeAttempts, 2);
  assert.ok(events.some((event) => event.type === "phase_retry" && event.phase === "plan"));
  assert.ok(events.some((event) => event.type === "phase_feedback_retry" && event.phase === "execute"));
});

test("event store seals terminal jobs and blocks or redacts secret-like artifacts", async () => {
  const cpbRoot = await tempRoot("cpb-engine-events");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "proj";
  const jobId = "job-events";

  await appendEvent(cpbRoot, project, jobId, {
    type: "job_completed",
    jobId,
    project,
    ts: new Date().toISOString(),
  }, { dataRoot });
  const skipped = await appendEvent(cpbRoot, project, jobId, {
    type: "phase_result",
    jobId,
    project,
    phase: "verify",
    status: "passed",
    artifact: "verdict-001.md",
    ts: new Date().toISOString(),
  }, { dataRoot });
  assert.equal(skipped, null);
  assert.deepEqual((await readEvents(cpbRoot, project, jobId, { dataRoot })).map((event) => event.type), ["job_completed"]);

  const secretJobId = "job-secret";
  const blocked = await appendEvent(cpbRoot, project, secretJobId, {
    type: "phase_result",
    jobId: secretJobId,
    project,
    phase: "execute",
    status: "passed",
    artifact: ".env",
    content: "OPENAI_API_KEY=sk-1234567890abcdef",
    ts: new Date().toISOString(),
  }, { dataRoot });
  assert.equal(blocked.type, "secret_blocked");
  assert.match(blocked.reason, /secret-like/);
  const secretEvents = await readEvents(cpbRoot, project, secretJobId, { dataRoot });
  assert.equal(secretEvents.length, 1);
  assert.equal(secretEvents[0].type, "secret_blocked");
  assert.doesNotMatch(JSON.stringify(secretEvents[0]), /sk-1234567890abcdef/);

  const redactedJobId = "job-redact";
  await appendEvent(cpbRoot, project, redactedJobId, {
    type: "phase_result",
    jobId: redactedJobId,
    project,
    phase: "plan",
    status: "passed",
    artifact: "plan-001.md",
    metadata: { apiKey: "sk-abcdef1234567890" },
    ts: new Date().toISOString(),
  }, { dataRoot });
  const redacted = await readEvents(cpbRoot, project, redactedJobId, { dataRoot });
  assert.equal(redacted[0].metadata.apiKey, "[REDACTED]");
});

test("providerServices: null is an explicit test-only disable — no provider checks even with hubRoot", async () => {
  const hubRoot = await tempRoot("cpb-engine-hub-null-ps");
  const events = [];
  const calls = [];

  const { result } = await runEngine({
    hubRoot,
    providerServices: null,
    servicesState: { events },
    pool: makePool({ calls }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => call.meta.role), ["planner", "executor", "verifier"]);
  // No provider_handoff events because all provider functions are null
  assert.ok(!events.some((event) => event.type === "provider_handoff"));
  // No provider_quota_blocked events
  assert.ok(!events.some((event) => event.type === "provider_quota_blocked"));
});

test("handoffState tracks consolidated from/to/reason/count for preflight switches", async () => {
  const hubRoot = await tempRoot("cpb-engine-hub-handoff-state");
  const events = [];
  const usageCommands = [];

  // Mark fake-primary as unavailable so preflight switches to fake-secondary
  await _internalMarkProviderUnavailable(hubRoot, {
    providerKey: "fake-primary",
    agent: "fake-primary",
    status: QuotaStatus.RATE_LIMITED,
    nextEligibleAt: Date.now() + 60_000,
    source: "test",
    reason: "preflight saturated",
  } as any);

  const { result } = await runEngine({
    hubRoot,
    servicesState: { events },
    pool: makePool({}),
  });

  assert.equal(result.status, "completed");

  // All phases should have preflight handoff events
  const handoffs = events.filter((event) => event.type === "provider_handoff" && !event.midRun);
  assert.ok(handoffs.length >= 1, "at least one preflight handoff event");
  assert.equal(handoffs[0].from, "fake-primary");
  assert.equal(handoffs[0].to, "fake-secondary");
  assert.match(handoffs[0].reason, /fallback/);
});

test("usage fallback record uses handoffState from/to/reason — not inferred from result.failure", async (t) => {
  const hubRoot = await tempRoot("cpb-engine-hub-usage-handoff");
  await startDelegateAckLoop(t, hubRoot);
  const events = [];
  const calls = [];
  let executePrimaryFailed = false;

  const pool = makePool({
    calls,
    onExecute: async ({ agent, meta }) => {
      if (meta.role === "executor" && agent === "fake-primary" && !executePrimaryFailed) {
        executePrimaryFailed = true;
        const err = new Error("429 rate limit from primary") as Error & AnyRecord;
        err.name = "RateLimitError";
        err.providerKey = "fake-primary";
        err.status = "rate_limited";
        err.nextEligibleAt = Date.now() + 60_000;
        err.confidence = 1;
        throw err;
      }
      return { output: phaseOutput(meta.role), providerKey: agent, variant: null };
    },
  });

  const { result } = await runEngine({
    hubRoot,
    servicesState: { events },
    pool,
  });

  assert.equal(result.status, "completed");

  // Read the usage commands written to the delegate
  const usageCommands = await readDelegateUsageCommands(hubRoot);
  const executeUsage = usageCommands.find((command) => command.record?.phase === "execute");
  assert.ok(executeUsage, "execute usage command should exist");

  const fallback = executeUsage.record.fallback;
  assert.equal(fallback.used, true, "fallback.used should be true");
  assert.equal(fallback.fromProviderKey, "fake-primary", "from should be the original provider");
  assert.equal(fallback.toProviderKey, "fake-secondary", "to should be the fallback provider");
  assert.equal(fallback.count, 1, "count should reflect handoffState.count");
  assert.ok(fallback.reason, "reason should be populated from handoffState");
});
