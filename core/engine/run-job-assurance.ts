import { execFile } from "node:child_process";
import { runAgent } from "../agents/agent-runner.js";
import { buildConversationKey } from "../agents/conversation-key.js";
import { resolveAllowedAgentNames } from "../agents/outcome-routing.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { writePromptArtifact } from "../artifacts/prompt-artifact.js";
import { FailureKind, failure, isValidFailureKind } from "../contracts/failure.js";
import { recordValue, type LooseRecord } from "../contracts/types.js";
import { buildPhaseAcpEnv } from "../phases/phase-env.js";
import { phaseExecutionContract } from "../phases/prompt-contract.js";
import {
  assuranceAgentName,
  highAssuranceAgentPolicyViolations,
  assuranceAgentVariant,
  resolveHighAssurancePolicy,
} from "../policy/high-assurance.js";
import {
  freezePlanRepositoryEvidenceLocators,
  PLAN_REPOSITORY_EVIDENCE_BASIS,
  runPlanTournament,
  type PlanRepositoryContract,
} from "../assurance/plan-tournament.js";
import { trustedProbePredicateIds } from "../workflow/trusted-probe-policy.js";
import {
  blockPreparedJob,
  failPreparedJob,
  reportProgress,
  ts,
  type AppendEvent,
  type BlockJob,
  type FailJob,
  type JobRunResult,
  type ProgressReporter,
  type ProviderPool,
} from "./run-job-shared.js";

type AssuranceContext = LooseRecord & {
  cpbRoot: string;
  project: string;
  task: string;
  sourcePath?: string;
  dataRoot?: string;
  sourceContext?: LooseRecord;
  agents?: LooseRecord;
  getPool: () => ProviderPool | null | undefined;
  appendEvent: AppendEvent;
  blockJob?: BlockJob;
  failJob?: FailJob;
  onProgress?: ProgressReporter | null;
  _attemptId?: string;
};

export type AssurancePlanningResult =
  | { kind: "skipped"; phaseSourceContext: LooseRecord }
  | { kind: "ok"; phaseSourceContext: LooseRecord; planArtifact: LooseRecord }
  | { kind: "blocked" | "failed"; result: JobRunResult };

const EVIDENCE_PACK_MAX_CHARS = 32_000;

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function buildEvidencePack(ctx: AssuranceContext) {
  const cwd = ctx.sourcePath || ctx.cpbRoot;
  const command = process.env.CPB_CODEGRAPH_COMMAND || "codegraph";
  return await new Promise<string>((resolve) => {
    execFile(
      command,
      ["context", ctx.task, "--path", cwd, "--max-nodes", "40", "--max-code", "10", "--format", "markdown"],
      { cwd, timeout: 30_000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error || typeof stdout !== "string" || !stdout.trim()) {
          resolve("CodeGraph evidence pack unavailable. Use focused file reads and keep unresolved claims explicit.");
          return;
        }
        const cleaned = stripAnsi(stdout).trim();
        resolve(cleaned.length <= EVIDENCE_PACK_MAX_CHARS
          ? cleaned
          : `${cleaned.slice(0, EVIDENCE_PACK_MAX_CHARS)}\n\n[Evidence pack truncated at ${EVIDENCE_PACK_MAX_CHARS} characters.]`);
      },
    );
  });
}

async function gitText(cwd: string, args: string[]) {
  return await new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(typeof stdout === "string" ? stdout : "");
    });
  });
}

async function loadPlanRepositoryContract(cwd: string): Promise<PlanRepositoryContract> {
  let repositoryIndexAvailable = false;
  let trackedPaths = new Set<string>();
  let frozenRevision: string | undefined;
  try {
    const output = await gitText(cwd, ["ls-tree", "-r", "--name-only", "HEAD"]);
    const revision = (await gitText(cwd, ["rev-parse", "HEAD"])).trim();
    if (!revision) throw new Error("git rev-parse HEAD returned an empty revision");
    trackedPaths = new Set(output.split("\n").map((entry) => entry.trim()).filter(Boolean));
    frozenRevision = revision;
    repositoryIndexAvailable = true;
  } catch {
    // Non-git sources keep the existing fail-closed checklist validation path.
  }

  let trustedPredicateIds = new Set<string>();
  try {
    const output = await gitText(cwd, ["show", "HEAD:.cpb/verification-probes.json"]);
    trustedPredicateIds = trustedProbePredicateIds(JSON.parse(output));
  } catch {
    // No maintainer-owned probe policy means model-authored command/test
    // predicates are not trusted and must be repaired to static evidence.
  }

  return {
    repositoryIndexAvailable,
    trackedPaths,
    trustedProbePredicateIds: trustedPredicateIds,
    frozenRevision,
  };
}

function planPrompt(ctx: AssuranceContext, evidencePack: string) {
  const source = recordValue(ctx.sourceContext);
  const documents = Array.isArray(source.documents)
    ? source.documents.map(recordValue).map((document) => ({
        kind: document.kind || "document",
        locator: document.locator || document.path || null,
        text: document.text || document.content || null,
      }))
    : [];
  return `You are a software planning agent participating in a high-assurance plan tournament.

${phaseExecutionContract("plan")}

## Original task
${ctx.task}

## Repository
Inspect the local checkout at ${ctx.sourcePath || ctx.cpbRoot}. The checkout is the source of truth. A bounded, shared static evidence pack is supplied below so both independent planners start from the same repository snapshot. Use focused file reads only when the pack omits a necessary detail. Do not open a terminal, execute Python or scripts, run tests/builds, start processes, or write files. Stop investigating once the causal path and smallest edit scope are supported. If static repository evidence cannot resolve a claim, leave it unresolved and return the required JSON promptly.

## Bounded repository evidence pack
${evidencePack}

## Reference documents
${documents.length > 0 ? JSON.stringify(documents, null, 2) : "None supplied."}

The final proposal must identify the real actors and entrypoints, distinguish a narrow reproduction from the real path, enumerate bypass candidates, declare the smallest evidence-backed edit scope, and provide repository-appropriate verification. Unknown user intent must remain explicit instead of being guessed.`;
}

function artifactSummary(artifact: LooseRecord) {
  return {
    kind: artifact.kind || null,
    name: artifact.name || null,
    path: artifact.path || null,
    sha256: artifact.sha256 || null,
    bytes: artifact.bytes || null,
  };
}

async function writeTournamentArtifacts(
  ctx: AssuranceContext,
  jobId: string,
  tournament: LooseRecord,
) {
  const artifacts: LooseRecord[] = [];
  const stages: Array<[string, unknown]> = [
    ["plan-proposals", tournament.candidates],
    ["plan-critiques", tournament.critiques],
    ["plan-revisions", tournament.revisions],
    ["plan-arbitration", tournament.decision],
    ["plan-tournament-trace", tournament.runs],
  ];
  for (const [kind, value] of stages) {
    if (value === undefined || value === null) continue;
    const artifact = await writeArtifact(ctx.cpbRoot, {
      project: ctx.project,
      jobId,
      kind,
      content: JSON.stringify(value, null, 2),
      dataRoot: ctx.dataRoot,
      metadata: { assuranceMode: "high", stage: kind },
    });
    artifacts.push(artifact);
  }
  return artifacts;
}

export async function runHighAssurancePlanning(
  ctx: AssuranceContext,
  {
    jobId,
    phaseSourceContext,
  }: {
    jobId: string;
    phaseSourceContext: LooseRecord;
  },
): Promise<AssurancePlanningResult> {
  const policy = resolveHighAssurancePolicy({ ...ctx, sourceContext: phaseSourceContext });
  if (!policy.enabled) return { kind: "skipped", phaseSourceContext };
  const allowedAgents = resolveAllowedAgentNames(phaseSourceContext, ctx.sourceContext);
  const policyViolations = highAssuranceAgentPolicyViolations(policy, allowedAgents);
  if (policyViolations.length > 0) {
    const fail = failure({
      kind: FailureKind.AGENT_UNAVAILABLE,
      phase: "assurance_plan",
      reason: `high-assurance agent policy violation: ${policyViolations.join(", ")}`,
      retryable: false,
      cause: {
        hardGate: true,
        allowedAgents,
        policyViolations,
      },
    });
    await failPreparedJob({
      cpbRoot: ctx.cpbRoot,
      project: ctx.project,
      jobId,
      appendEvent: ctx.appendEvent,
      failJob: ctx.failJob,
      failure: fail,
    });
    return { kind: "failed", result: { status: "failed", jobId, exitCode: 1, failure: fail } };
  }
  const pool = ctx.getPool();
  if (!pool) {
    const fail = failure({
      kind: FailureKind.AGENT_UNAVAILABLE,
      phase: "assurance_plan",
      reason: "high-assurance planning requires an agent pool",
      retryable: true,
    });
    await failPreparedJob({ cpbRoot: ctx.cpbRoot, project: ctx.project, jobId, appendEvent: ctx.appendEvent, failJob: ctx.failJob, failure: fail });
    return { kind: "failed", result: { status: "failed", jobId, exitCode: 1, failure: fail } };
  }

  await ctx.appendEvent(ctx.cpbRoot, ctx.project, jobId, {
    type: "plan_tournament_started",
    jobId,
    project: ctx.project,
    attemptId: ctx._attemptId || null,
    candidates: policy.planning.candidates.map((agent) => ({
      agent: assuranceAgentName(agent),
      variant: assuranceAgentVariant(agent),
    })),
    arbiter: assuranceAgentName(policy.planning.arbiter),
    critiqueRounds: policy.planning.critiqueRounds,
    ts: ts(),
  });
  await reportProgress(ctx, { type: "plan_tournament_started", jobId, project: ctx.project });

  const evidencePack = await buildEvidencePack(ctx);
  const evidenceArtifact = await writeArtifact(ctx.cpbRoot, {
    project: ctx.project,
    jobId,
    kind: "plan-evidence-pack",
    content: evidencePack,
    dataRoot: ctx.dataRoot,
    metadata: {
      assuranceMode: "high",
      maxChars: EVIDENCE_PACK_MAX_CHARS,
      source: evidencePack.startsWith("CodeGraph evidence pack unavailable") ? "fallback" : "codegraph_context",
    },
  });

  const baseConversationKey = buildConversationKey({
    project: ctx.project,
    jobId,
    attemptId: ctx._attemptId || jobId,
    role: "assurance_plan",
  });
  const repositoryContract = await loadPlanRepositoryContract(ctx.sourcePath || ctx.cpbRoot);
  const tournament = await runPlanTournament({
    task: ctx.task,
    basePrompt: planPrompt(ctx, evidencePack),
    conversationKey: baseConversationKey,
    policy,
    repositoryContract,
    execute: async (run) => {
      const agent = assuranceAgentName(run.agent);
      const variant = assuranceAgentVariant(run.agent);
      const promptArtifact = await writePromptArtifact(ctx.cpbRoot, {
        project: ctx.project,
        jobId,
        phase: "assurance_plan",
        role: run.role,
        agent,
        prompt: run.prompt,
        dataRoot: ctx.dataRoot,
      });
      const agentEnv = buildPhaseAcpEnv(ctx, "plan");
      // Repository retrieval is frozen once into the bounded evidence pack.
      // Re-opening repository MCP tools in any tournament round multiplies
      // context consumption and gives later agents evidence their opponent did
      // not see. Focused ACP file reads remain available when necessary.
      agentEnv.CPB_CODEGRAPH_ENABLED = "0";
      const result = recordValue(await runAgent({
        phase: "plan",
        role: run.role,
        agent,
        variant,
        project: ctx.project,
        jobId,
        prompt: run.prompt,
        cwd: ctx.sourcePath || ctx.cpbRoot,
        pool,
        timeoutMs: Number(recordValue(ctx.timeouts).plan || 0),
        scope: ctx.scope,
        env: agentEnv,
        dataRoot: ctx.dataRoot,
        onProgress: ctx.onProgress,
        attemptId: ctx._attemptId || jobId,
        conversationKey: run.conversationKey,
      }));
      return {
        ok: result.ok === true,
        output: typeof result.output === "string" ? result.output : "",
        reason: typeof result.reason === "string" ? result.reason : undefined,
        kind: typeof result.kind === "string" ? result.kind : undefined,
        retryable: result.retryable === true,
        diagnostics: {
          ...recordValue(result.diagnostics),
          cause: recordValue(result.cause),
          promptArtifact: artifactSummary(recordValue(promptArtifact)),
        },
      };
    },
  });

  const supportingArtifacts = [
    evidenceArtifact,
    ...await writeTournamentArtifacts(ctx, jobId, recordValue(tournament)),
  ];
  if (!tournament.ok || !tournament.proposal) {
    const isClarification = tournament.kind === FailureKind.HUMAN_APPROVAL_REQUIRED
      || tournament.kind === "human_approval_required";
    const tournamentFailureKind = isValidFailureKind(tournament.kind)
      ? String(tournament.kind)
      : FailureKind.AGENT_CONTRACT_INVALID;
    const fail = failure({
      kind: isClarification ? FailureKind.HUMAN_APPROVAL_REQUIRED : tournamentFailureKind,
      phase: "assurance_plan",
      reason: tournament.reason || "high-assurance plan tournament failed",
      retryable: isClarification ? false : tournament.retryable === true,
      cause: {
        routingLabel: isClarification ? "needs_clarification" : "infra_error",
        supportingArtifacts: supportingArtifacts.map(artifactSummary),
        tournamentKind: tournament.kind || null,
      },
    });
    await ctx.appendEvent(ctx.cpbRoot, ctx.project, jobId, {
      type: "plan_tournament_failed",
      jobId,
      project: ctx.project,
      reason: fail.reason,
      kind: fail.kind,
      supportingArtifacts: supportingArtifacts.map(artifactSummary),
      ts: ts(),
    });
    if (isClarification) {
      await blockPreparedJob({ cpbRoot: ctx.cpbRoot, project: ctx.project, jobId, appendEvent: ctx.appendEvent, blockJob: ctx.blockJob, failure: fail });
      return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: fail } };
    }
    await failPreparedJob({ cpbRoot: ctx.cpbRoot, project: ctx.project, jobId, appendEvent: ctx.appendEvent, failJob: ctx.failJob, failure: fail });
    return { kind: "failed", result: { status: "failed", jobId, exitCode: 1, failure: fail } };
  }

  const winnerAgent = tournament.decision?.decision === "B"
    ? policy.planning.candidates[1]
    : tournament.decision?.decision === "A"
      ? policy.planning.candidates[0]
      : policy.planning.arbiter;
  const frozenRepositoryEvidence = freezePlanRepositoryEvidenceLocators(
    tournament.proposal,
    repositoryContract,
  );
  const evidenceLocators = frozenRepositoryEvidence.ok
    ? frozenRepositoryEvidence.locators
    : [];
  const evidenceLocatorBasis = frozenRepositoryEvidence.basis || PLAN_REPOSITORY_EVIDENCE_BASIS;
  const evidenceProvenance = {
    schemaVersion: 1,
    basis: evidenceLocatorBasis,
    frozenRevision: frozenRepositoryEvidence.frozenRevision,
    repositoryIndexAvailable: frozenRepositoryEvidence.repositoryIndexAvailable,
    validationOk: frozenRepositoryEvidence.ok,
    validationReason: frozenRepositoryEvidence.reason,
    locatorCount: evidenceLocators.length,
    locators: evidenceLocators,
  };
  const evidenceProvenanceArtifact = await writeArtifact(ctx.cpbRoot, {
    project: ctx.project,
    jobId,
    kind: "plan-evidence-provenance",
    content: JSON.stringify(evidenceProvenance, null, 2),
    dataRoot: ctx.dataRoot,
    metadata: {
      assuranceMode: "high",
      stage: "plan-evidence-provenance",
      evidenceLocatorBasis,
      frozenRevision: frozenRepositoryEvidence.frozenRevision,
      locatorCount: evidenceLocators.length,
    },
  });
  supportingArtifacts.push(evidenceProvenanceArtifact);
  const planArtifact = await writeArtifact(ctx.cpbRoot, {
    project: ctx.project,
    jobId,
    kind: "plan",
    content: tournament.proposal.planMarkdown,
    dataRoot: ctx.dataRoot,
    metadata: {
      task: ctx.task,
      assuranceMode: "high",
      tournamentDecision: tournament.decision?.decision || null,
      tournamentReason: tournament.decision?.reason || null,
      winnerAgent: assuranceAgentName(winnerAgent),
      evidenceLocatorBasis,
      evidenceFrozenRevision: frozenRepositoryEvidence.frozenRevision,
      evidenceLocatorCount: evidenceLocators.length,
      evidenceProvenanceArtifact: artifactSummary(evidenceProvenanceArtifact),
      supportingArtifacts: supportingArtifacts.map(artifactSummary),
    },
  });
  const assuranceTournament = {
    mode: "high",
    decision: tournament.decision,
    proposal: tournament.proposal,
    decomposedItems: tournament.proposal.decomposedItems,
    evidenceLocators,
    evidenceLocatorBasis,
    evidenceFrozenRevision: frozenRepositoryEvidence.frozenRevision,
    evidenceProvenanceArtifact,
    planArtifact,
    supportingArtifacts,
    winnerAgent,
    plannerAgents: policy.planning.candidates,
    executorAgent: policy.execution.agent,
    verifierAgent: policy.verification.agent,
    blindVerification: policy.verification.blind,
  };
  // High-assurance planning is the authority for scope.  Do not let a
  // prepare-time, single-agent checklist/classification silently outrank the
  // tournament result when the checklist DAG is frozen below.
  const {
    acceptanceChecklist: _discardedAcceptanceChecklist,
    acceptanceChecklistArtifact: _discardedAcceptanceChecklistArtifact,
    requirementClassification: _discardedRequirementClassification,
    ...assuranceSourceContext
  } = phaseSourceContext;
  const nextSourceContext = {
    ...assuranceSourceContext,
    assurance: {
      ...recordValue(phaseSourceContext.assurance),
      mode: "high",
    },
    assuranceTournament,
  };
  await ctx.appendEvent(ctx.cpbRoot, ctx.project, jobId, {
    type: "plan_arbitrated",
    jobId,
    project: ctx.project,
    attemptId: ctx._attemptId || null,
    decision: tournament.decision?.decision || null,
    reason: tournament.decision?.reason || null,
    planArtifact: artifactSummary(recordValue(planArtifact)),
    supportingArtifacts: supportingArtifacts.map(artifactSummary),
    winnerAgent: assuranceAgentName(winnerAgent),
    evidenceLocatorBasis,
    evidenceFrozenRevision: frozenRepositoryEvidence.frozenRevision,
    evidenceLocatorCount: evidenceLocators.length,
    evidenceProvenanceArtifact: artifactSummary(evidenceProvenanceArtifact),
    ts: ts(),
  });
  await reportProgress(ctx, {
    type: "plan_arbitrated",
    jobId,
    project: ctx.project,
    decision: tournament.decision?.decision || null,
    evidenceLocatorBasis,
    evidenceLocatorCount: evidenceLocators.length,
  });
  return { kind: "ok", phaseSourceContext: nextSourceContext, planArtifact };
}
