import { createHash } from "node:crypto";

import { parseAgentJson } from "../agents/response-parser.js";
import { validatePlanMarkdown } from "../artifacts/validators.js";
import { recordValue, type LooseRecord } from "../contracts/types.js";
import {
  assuranceAgentName,
  assuranceAgentVariant,
  type AssuranceAgent,
  type HighAssurancePolicy,
} from "../policy/high-assurance.js";
import { validateDecomposedItems } from "../workflow/acceptance-checklist.js";
import { extractTaskRequirementSlices } from "../workflow/checklist-build.js";
import { VERIFICATION_METHODS } from "../workflow/checklist-shared.js";
import { validatePlanObservableContracts } from "../workflow/observable-contract.js";

export type PlanProposal = {
  proposalId: "A" | "B";
  planMarkdown: string;
  problemModel: string;
  claims: LooseRecord[];
  decomposedItems: LooseRecord[];
  changeScope: string[];
  invariants: string[];
  implementationSteps: string[];
  verification: string[];
  unresolvedAssumptions: string[];
};

export type PlanCritique = {
  reviewer: "A" | "B";
  targetProposalId: "A" | "B";
  objections: LooseRecord[];
  acceptedClaims: string[];
  unresolvedDisputes: LooseRecord[];
};

export type ArbitrationDecision = {
  decision: "A" | "B" | "merge" | "unresolved";
  reason: string;
  proposal: PlanProposal | null;
  acceptedConstraints: string[];
  rejectedAlternatives: LooseRecord[];
};

export type PlanTournamentRun = {
  agent: AssuranceAgent;
  role: string;
  prompt: string;
  conversationKey: string;
};

export type PlanTournamentResult = {
  ok: boolean;
  reason?: string;
  kind?: string;
  retryable?: boolean;
  proposal?: PlanProposal;
  decision?: ArbitrationDecision;
  candidates?: PlanProposal[];
  critiques?: PlanCritique[];
  revisions?: PlanProposal[];
  runs?: LooseRecord[];
};

export type PlanRepositoryContract = {
  repositoryIndexAvailable: boolean;
  trackedPaths: Set<string>;
  trustedProbePredicateIds: Set<string>;
  frozenRevision?: string;
};

export const PLAN_REPOSITORY_EVIDENCE_BASIS = "validated_frozen_head_repository_refs";

export type PlanPredicateBinding = {
  stage: string;
  itemIndex: number;
  predicateId: string;
  requestedMethod: "command" | "test";
  boundMethod: "static";
  reason: "predicate_not_in_frozen_maintainer_policy";
};

type ExecuteRun = (run: PlanTournamentRun) => Promise<{
  ok: boolean;
  output?: string;
  reason?: string;
  kind?: string;
  retryable?: boolean;
  diagnostics?: LooseRecord;
}>;

const JSON_ONLY = `Respond with one JSON object inside a \`\`\`json code block and no text outside it. Do not reveal chain-of-thought or narrate your reasoning. Keep the complete response under 8,000 characters; prefer short evidence references over repeated explanation.`;
const VERIFICATION_METHOD_VALUES = [...VERIFICATION_METHODS].map((value) => `"${value}"`).join(", ");
const CONTRACT_REPAIR_LIMIT = 1;
// Keep a successful opponent result while a transiently unavailable side
// cools down. This is deliberately larger than the transport's short internal
// retry budget so a 529 does not force a whole-tournament restart and consume
// the successful model's quota again.
const PROVIDER_RETRY_LIMIT = 5;
const TRANSIENT_RUN_RETRY_LIMIT = 2;
const TRANSIENT_RUN_KINDS = new Set([
  "agent_unavailable",
  "agent_spawn_error",
  "agent_exit_nonzero",
  "runtime_interrupted",
  "timeout",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function recordArray(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.map(recordValue).filter((entry) => Object.keys(entry).length > 0) : [];
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function explicitRequirementContract(task: string) {
  const slices = extractTaskRequirementSlices(task).filter((slice) => slice.locator !== "task:0");
  const sliceList = slices.length > 0
    ? slices.map((slice) => `- ${slice.locator}: ${slice.text}`).join("\n")
    : "- No separately structured task bullets detected.";
  return `## Explicit requirement and repository-state contract
${sliceList}
- Treat every task:bullet:N entry as a separate acceptance obligation. The final decomposedItems must cite every listed locator at least once in addition to task:0; do not silently collapse, defer, or label an explicit obligation out of scope.
- When the task uses future/current behavior, target versions, migration phases, deprecation windows, or release milestones, establish which phase this checkout represents from repository-native evidence such as version metadata, current whatsnew/changelog files, release configuration, or branch-owned tests. A commit date or unsupported chronology guess is not evidence.
- If repository evidence cannot establish the applicable phase, keep it as an unresolved assumption. If it does establish the phase, the plan must implement every obligation applicable to that phase and test both the superseded and resulting behavior where relevant.`;
}

const REPOSITORY_SOURCE_REF_KINDS = new Set([
  "code",
  "file",
  "repo",
  "repo_file",
  "repository",
  "repository_file",
  "repository_path",
  "source_file",
]);

function stripRepositoryLocatorSuffix(locator: string) {
  const hashLine = locator.match(/^(.+)#L\d+(?:-L\d+)?$/);
  if (hashLine) return hashLine[1];
  const colonLine = locator.match(/^(.+?):\d+(?:-\d+)?(?::\d+)?$/);
  return colonLine ? colonLine[1] : locator;
}

function repositoryPathExists(contract: PlanRepositoryContract, locator: string) {
  const candidate = stripRepositoryLocatorSuffix(locator);
  if (!candidate) return false;
  if (contract.trackedPaths.has(candidate)) return true;
  const prefix = candidate.endsWith("/") ? candidate : `${candidate}/`;
  return [...contract.trackedPaths].some((entry) => entry.startsWith(prefix));
}

/**
 * Validate facts that a model cannot establish by confidence or consensus.
 * Repository source references must exist at the frozen HEAD, and command/test
 * predicates must be backed by a maintainer-owned probe policy at that HEAD.
 */
export function validatePlanProposalRepositoryContract(
  proposal: PlanProposal,
  contract: PlanRepositoryContract,
) {
  for (const [itemIndex, item] of proposal.decomposedItems.entries()) {
    const itemRecord = recordValue(item);
    const predicateId = text(itemRecord.predicateId);
    const verificationMethod = text(itemRecord.verificationMethod);
    if (
      (verificationMethod === "command" || verificationMethod === "test")
      && !contract.trustedProbePredicateIds.has(predicateId)
    ) {
      return {
        ok: false as const,
        reason: `decomposedItems[${itemIndex}] ${verificationMethod} predicate is not present in the frozen maintainer probe policy: ${predicateId || "missing"}`,
      };
    }
    if (!contract.repositoryIndexAvailable) continue;
    for (const [fileIndex, allowedFile] of stringArray(itemRecord.allowedFiles).entries()) {
      if (!repositoryPathExists(contract, allowedFile)) {
        return {
          ok: false as const,
          reason: `decomposedItems[${itemIndex}].allowedFiles[${fileIndex}] does not exist at frozen repository HEAD: ${allowedFile}. For an intentional new file, use the narrowest existing tracked parent directory instead of guessing a new exact path.`,
        };
      }
    }
    const observableContract = recordValue(itemRecord.observableContract);
    const repositoryRefGroups = [
      { field: "sourceRefs", refs: recordArray(itemRecord.sourceRefs) },
      { field: "observableContract.oracleSourceRefs", refs: recordArray(observableContract.oracleSourceRefs) },
    ];
    for (const group of repositoryRefGroups) {
      for (const [refIndex, ref] of group.refs.entries()) {
        const kind = text(ref.kind);
        const locator = text(ref.locator);
        if (!REPOSITORY_SOURCE_REF_KINDS.has(kind)) continue;
        if (!repositoryPathExists(contract, locator)) {
          return {
            ok: false as const,
            reason: `decomposedItems[${itemIndex}].${group.field}[${refIndex}] does not exist at frozen repository HEAD: ${kind}:${locator || "missing"}`,
          };
        }
      }
    }
  }
  return { ok: true as const, reason: "" };
}

/**
 * Freeze repository evidence locators from a proposal only after the same
 * proposal has passed the frozen-HEAD repository contract. This permits
 * read-only evidence outside edit scope without relying on brittle substring
 * matches against the bounded CodeGraph evidence pack.
 */
export function freezePlanRepositoryEvidenceLocators(
  proposal: PlanProposal,
  contract: PlanRepositoryContract,
) {
  const trace = {
    basis: PLAN_REPOSITORY_EVIDENCE_BASIS,
    frozenRevision: contract.repositoryIndexAvailable
      ? text(contract.frozenRevision) || null
      : null,
    repositoryIndexAvailable: contract.repositoryIndexAvailable,
  };
  const validation = validatePlanProposalRepositoryContract(proposal, contract);
  if (!validation.ok) return { ...validation, ...trace, locators: [] as string[] };
  if (!contract.repositoryIndexAvailable) {
    return { ok: true as const, reason: "", ...trace, locators: [] as string[] };
  }
  const locators = new Set<string>();
  for (const item of proposal.decomposedItems) {
    const itemRecord = recordValue(item);
    const observableContract = recordValue(itemRecord.observableContract);
    for (const ref of [
      ...recordArray(itemRecord.sourceRefs),
      ...recordArray(observableContract.oracleSourceRefs),
    ]) {
      const kind = text(ref.kind);
      const locator = text(ref.locator);
      if (REPOSITORY_SOURCE_REF_KINDS.has(kind) && locator) locators.add(locator);
    }
  }
  return { ok: true as const, reason: "", ...trace, locators: [...locators] };
}

/**
 * Project model-authored executable checks onto the frozen maintainer probe
 * policy. An untrusted command/test identifier is never executed and never
 * allowed to masquerade as runtime evidence; it becomes an explicit static
 * acceptance item instead. This deterministic projection avoids asking the
 * model to repair an identifier that has no valid executable binding.
 */
export function bindPlanProposalPredicates(
  proposal: PlanProposal,
  contract: PlanRepositoryContract,
  stage = "proposal",
) {
  const bindings: PlanPredicateBinding[] = [];
  const decomposedItems = proposal.decomposedItems.map((item, itemIndex) => {
    const current = recordValue(item);
    const requestedMethod = text(current.verificationMethod);
    const predicateId = text(current.predicateId);
    if (
      (requestedMethod !== "command" && requestedMethod !== "test")
      || contract.trustedProbePredicateIds.has(predicateId)
    ) {
      return current;
    }
    bindings.push({
      stage,
      itemIndex,
      predicateId,
      requestedMethod,
      boundMethod: "static",
      reason: "predicate_not_in_frozen_maintainer_policy",
    });
    return {
      ...current,
      verificationMethod: "static",
      requiresRealPathEvidence: false,
      expectedEvidence: `Static candidate evidence for the frozen requirement: ${text(current.requirement) || predicateId || `item ${itemIndex + 1}`}`,
    };
  });
  return {
    proposal: bindings.length > 0 ? { ...proposal, decomposedItems } : proposal,
    bindings,
  };
}

function predicateBindingRun(binding: PlanPredicateBinding) {
  return {
    role: "deterministic_predicate_binding",
    agent: "cpb",
    variant: "frozen-maintainer-policy-v1",
    conversationKey: null,
    promptSha256: null,
    ok: true,
    kind: "predicate_binding_projected",
    reason: binding.reason,
    diagnostics: binding,
  };
}

function frozenProbePolicyPrompt(contract?: PlanRepositoryContract) {
  if (!contract) return "";
  const predicateIds = [...contract.trustedProbePredicateIds].sort();
  return `

## Frozen maintainer probe bindings
Executable verification is an exact-ID contract. ${predicateIds.length > 0
    ? `The only predicateIds allowed with verificationMethod "command" or "test" are:\n${predicateIds.map((id) => `- ${id}`).join("\n")}`
    : "This repository has no maintainer-approved command/test predicateIds at frozen HEAD."}
For every other requirement use verificationMethod "static" and requiresRealPathEvidence=false. Do not derive, rename, or invent executable predicateIds; ordinary test intentions belong in the proposal verification list.`;
}

function providerRetryDelayMs(result: Awaited<ReturnType<ExecuteRun>>, attempt: number) {
  const cause = recordValue(recordValue(result.diagnostics).cause);
  const nextEligibleAt = Number(cause.nextEligibleAt || cause.untilTs || 0);
  if (Number.isFinite(nextEligibleAt) && nextEligibleAt > 0) {
    return Math.max(0, Math.min(120_000, nextEligibleAt - Date.now()));
  }
  return Math.min(120_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}

function abortReason(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) return `plan tournament aborted: ${reason.message}`;
  if (typeof reason === "string" && reason.trim()) return `plan tournament aborted: ${reason.trim()}`;
  return "plan tournament aborted";
}

function abortedRunResult(runs: LooseRecord[], signal?: AbortSignal) {
  return {
    ok: false as const,
    reason: abortReason(signal),
    kind: "runtime_interrupted",
    retryable: false,
    runs,
  };
}

function waitForProviderBackoff(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) finish(false);
  });
}

function proposalSchemaExample(proposalId: "A" | "B") {
  return JSON.stringify({
    status: "ok",
    proposal: {
      proposalId,
      problemModel: "Evidence-backed explanation of the behavior and likely causal path",
      claims: [{
        claimId: `${proposalId}-C1`,
        statement: "A falsifiable repository fact",
        evidenceRefs: ["path/to/file.py:42"],
        falsificationProbe: "A safe read-only inspection or focused test that would disprove this claim",
        status: "supported",
      }],
      changeScope: ["path/to/file.py"],
      invariants: ["Observable behavior that must remain true"],
      implementationSteps: ["Small implementation step"],
      verification: ["Repository-appropriate focused verification"],
      unresolvedAssumptions: [],
      decomposedItems: [{
        requirement: "One verifiable requirement grounded in the task",
        predicateId: `${proposalId.toLowerCase()}-requirement-1`,
        verificationMethod: "static",
        allowedFiles: ["path/to/file.py"],
        sourceRefs: [{ kind: "task_text", locator: "task:0" }],
        expectedEvidence: "The frozen candidate changes the declared implementation path.",
        evidenceOrigin: "deterministic_probe",
        requiresRealPathEvidence: false,
        observableContract: {
          observationKind: "invariant",
          probeInput: "Concrete pre-execution scenario or state to observe",
          expectedObservation: "Observable result that must hold independently of the candidate implementation",
          forbiddenObservations: [],
          oracleSourceRefs: [{ kind: "task_text", locator: "task:0" }],
          candidateIndependent: true,
        },
      }],
      planMarkdown: "## Analysis\n...\n\n## Bounded Handoff\n- Real actors: ...\n- Entrypoints: ...\n- Bypass candidates: ...\n- Edit files: ...\n- Verification targets: ...\n- Blockers: none\n\n## Files to modify\n...\n\n## Implementation Steps\n...\n\n## Testing\n...\n\n## Risks\n...",
    },
  }, null, 2);
}

export function buildProposalPrompt({
  proposalId,
  basePrompt,
  task = "",
}: {
  proposalId: "A" | "B";
  basePrompt: string;
  task?: string;
}) {
  return `${basePrompt}

${explicitRequirementContract(task)}

## Independent high-assurance proposal ${proposalId}
Work independently. Do not assume another planner's answer. Inspect the repository read-only and express important conclusions as falsifiable claims with concrete repository evidence. Use only the original task and local repository evidence. Do not write files.

Your decomposedItems will become the candidate acceptance scope only after cross-critique and arbitration. Declare the smallest evidence-backed allowedFiles scope; do not invent files. Every allowedFiles entry must resolve to a tracked file or tracked directory at frozen HEAD. For an intentional new file, declare the narrowest existing tracked parent directory; do not guess a new exact path.

Each verificationMethod MUST be exactly one of: ${VERIFICATION_METHOD_VALUES}. For an ordinary code change, use "static" unless the repository already contains a maintainer-approved structured probe for the predicate. Do not invent aliases such as "focused_test"; focused tests belong in the proposal's verification list and Testing section.
When verificationMethod is "static", requiresRealPathEvidence MUST be false. Static diff-scope evidence and agent-written evidence cannot prove that a runtime path executed.
Every decomposed item MUST include { "kind": "task_text", "locator": "task:0" } in sourceRefs. Repository file/line refs may be added as technical evidence, but they do not replace the task requirement source.
Every decomposed item MUST also include an observableContract frozen from the task and repository state before execution. It must name a concrete probeInput, expectedObservation, oracleSourceRefs, and candidateIndependent=true. Choose observationKind from "exact_text", "contains_text", "state_transition", or "invariant". The expected observation is an oracle, not a description of whatever the future candidate happens to produce.
For user-visible text, diagnostics, serialized output, or response wording, use exact_text or contains_text and include at least one forbiddenObservations entry. Expand representative values through the existing formatting template and write the literal expected output or literal required fragment. Include the current bad output when supplied by the task and a representation-boundary near miss when applicable.
Treat tests and exact assertions already present at frozen HEAD as compatibility contracts. Inspect adjacent existing tests, list the old scenarios that must remain valid, and prefer adding focused coverage over rewriting old expectations. Propose changing an existing expectation only when the original task explicitly supersedes that exact scenario.
For misleading diagnostics, classify the root cause before proposing control-flow changes: determine whether the wrong guard fired or the existing formatter discarded context that was already available. If the correct guard already fires and only its expected/observed rendering is lossy, prefer widening that formatter over adding a new branch or inventing a new message taxonomy. When expected or observed values are collections, preserve unambiguous collection structure and element escaping using the repository's native representation, render the same semantically compared slice on both sides, and preserve established single-item wording byte-for-byte. A broader branch must beat this minimal hypothesis with repository evidence and a falsification probe.
When a native collection representation is substituted into a placeholder, do not retain scalar quote delimiters around that placeholder: a template like expected '{}' turns a list representation into the misleading scalar-looking text '[...]'. Cross-check the fully expanded literal in observableContract, including quote, escape, separator, and pluralization boundaries.

${JSON_ONLY}

Required shape:
\`\`\`json
${proposalSchemaExample(proposalId)}
\`\`\``;
}

export function buildCritiquePrompt({
  reviewer,
  task,
  own,
  target,
}: {
  reviewer: "A" | "B";
  task: string;
  own: PlanProposal;
  target: PlanProposal;
}) {
  return `You are planner ${reviewer} performing a read-only adversarial critique of proposal ${target.proposalId}.

## Original task
${task}

## Your proposal
${JSON.stringify(own, null, 2)}

## Target proposal
${JSON.stringify(target, null, 2)}

${explicitRequirementContract(task)}

Critique claim-by-claim. Generic disagreement is invalid. Every blocking objection must identify a targetClaimId or target scope item, cite repository evidence, and provide a safe falsification probe or required revision. Distinguish technical disputes from unresolved user intent. Do not write files.
Treat reliance on deleting or rewriting existing test expectations as a blocking objection unless the original task explicitly supersedes the exact old scenario. Require a production-only replay against frozen HEAD tests when a proposal changes repository tests.
For a diagnostic-message bug, block proposals that add semantic branches without first falsifying the smaller hypothesis that the current formatter is discarding available expected/observed values. Also block delimiter-flattened collection diagnostics that lose container boundaries, element escaping, or the compared-slice boundary.
For any exact_text or contains_text contract, independently expand the proposed template with the representative probe input. Block a contract that was copied from candidate-style code, omits the current bad output, or wraps a native collection representation in leftover scalar quotes. Candidate-authored regression assertions are not an oracle.
Do not call tools. The repository evidence is frozen in the supplied proposals and evidenceRefs; this round challenges those claims without reopening discovery.

${JSON_ONLY}

Required shape:
\`\`\`json
{
  "status": "ok",
  "critique": {
    "reviewer": "${reviewer}",
    "targetProposalId": "${target.proposalId}",
    "objections": [{
      "objectionId": "${reviewer}-O1",
      "targetClaimId": "${target.proposalId}-C1",
      "severity": "blocking",
      "statement": "Concrete objection",
      "evidenceRefs": ["path/to/file.py:42"],
      "falsificationProbe": "Safe probe",
      "requiredRevision": "Specific correction"
    }],
    "acceptedClaims": [],
    "unresolvedDisputes": []
  }
}
\`\`\``;
}

export function buildRevisionPrompt({
  proposalId,
  task,
  current,
  critique,
}: {
  proposalId: "A" | "B";
  task: string;
  current: PlanProposal;
  critique: PlanCritique;
}) {
  return `You are planner ${proposalId}. Revise your proposal after an evidence-backed critique.

## Original task
${task}

## Current proposal
${JSON.stringify(current, null, 2)}

## Critique from the other planner
${JSON.stringify(critique, null, 2)}

${explicitRequirementContract(task)}

Accept valid objections, reject invalid ones with repository evidence, and remove unsupported assumptions. Keep the change scope minimal. If user intent is genuinely unresolved, state it in unresolvedAssumptions instead of guessing. Do not write files.
Preserve frozen HEAD test contracts unless the original task explicitly supersedes their exact scenario; do not use rewritten assertions as proof of correctness.
For misleading diagnostics, explicitly preserve or reject the minimal formatter-only hypothesis before retaining a new validation branch. For multi-value diagnostics, preserve collection shape, escaping, and the compared-slice boundary while keeping established single-value messages byte-compatible.
Retain and repair every observableContract. Text contracts must contain the literal pre-execution expected observation and negative observations; never derive them from a future candidate or its tests. Re-expand formatting templates and remove scalar wrapper quotes around native structured representations unless the frozen repository contract explicitly requires them.
Do not call tools. Use only the current proposal, critique, and their frozen evidence references.
Use only the verificationMethod values shown in the proposal contract. For "static", requiresRealPathEvidence must be false.
Every decomposed item must retain the task_text:task:0 sourceRef; repository refs are additional technical evidence only.

${JSON_ONLY}

Return the same proposal envelope shape:
\`\`\`json
${proposalSchemaExample(proposalId)}
\`\`\``;
}

function buildContractRepairPrompt(run: PlanTournamentRun, output: string, reason: string) {
  return `${run.prompt}

## Contract repair
Your previous response was rejected only because it violated the required machine-readable contract:
${reason}

Return one complete corrected response. Preserve supported technical content, but correct every schema violation. Do not discuss the rejection. Do not invent enum aliases. The previous response was:
\`\`\`text
${output.slice(0, 16_000)}
\`\`\``;
}

function buildToolBudgetRetryPrompt(run: PlanTournamentRun, reason: string) {
  return `${run.prompt}

## Bounded retry
The previous run failed before returning a valid response:
${reason}

Do not call any tools. Repository evidence was already frozen into the supplied proposals, critiques, and evidence references. Use only those inputs and return the required complete JSON response.`;
}

export function buildArbitrationPrompt({
  task,
  proposalA,
  proposalB,
  critiques,
}: {
  task: string;
  proposalA: PlanProposal;
  proposalB: PlanProposal;
  critiques: PlanCritique[];
}) {
  return `You are a fresh high-assurance plan arbiter. You did not author either proposal. Select A, B, merge, or unresolved using repository evidence and falsifiable claims, not writing style or confidence labels.

## Original task
${task}

## Revised proposal A
${JSON.stringify(proposalA, null, 2)}

## Revised proposal B
${JSON.stringify(proposalB, null, 2)}

## Cross-critiques
${JSON.stringify(critiques, null, 2)}

${explicitRequirementContract(task)}

Rules:
- Choose unresolved when the remaining dispute is user intent, an irreversible tradeoff, or a technical claim that cannot be resolved from available repository evidence.
- A merge must be a coherent minimal proposal, not a concatenation.
- The final decomposedItems and planMarkdown are the only scope and plan that downstream execution may consume.
- Preserve the proposal contract: do not invent verificationMethod aliases, and set requiresRealPathEvidence=false for "static" items.
- Every final decomposed item must include the task_text:task:0 sourceRef.
- Existing frozen-HEAD tests are compatibility contracts. Reject plans that need rewritten assertions merely to pass; when test files change, require a production-only replay against the HEAD versions.
- For misleading diagnostics, prefer a formatter-only repair when the existing guard already detects the failure and has the full expected/observed values. Preserve native collection shape, element escaping, and matching comparison slices for multi-value diagnostics while retaining established single-value wording. Reject new semantic branches unless repository evidence falsifies that smaller repair.
- Treat observableContract as the pre-execution behavior oracle. Reconcile the two planners' literal observations before choosing a winner. If text contracts disagree, resolve the exact quote/escape/separator/pluralization boundary from the task and frozen repository evidence or choose unresolved; do not let the future executor decide. Reject scalar quote delimiters left around native collection representations.
- Do not write files. Judge only from the original task and local repository evidence.
- Do not call tools. Arbitration is over the supplied frozen record only.

${JSON_ONLY}

Required shape:
\`\`\`json
{
  "status": "ok",
  "arbitration": {
    "decision": "A",
    "reason": "Evidence-based decision",
    "acceptedConstraints": [],
    "rejectedAlternatives": [],
    "proposal": ${JSON.stringify(JSON.parse(proposalSchemaExample("A")).proposal, null, 2)}
  }
}
\`\`\``;
}

export function parsePlanProposal(output: string, expectedId: "A" | "B", task = ""): { ok: true; proposal: PlanProposal } | { ok: false; reason: string } {
  const parsed = parseAgentJson(output);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const raw = recordValue(recordValue(parsed.data).proposal || parsed.data);
  const proposalId = text(raw.proposalId);
  if (proposalId !== expectedId) return { ok: false, reason: `proposalId must be ${expectedId}` };
  const planMarkdown = text(raw.planMarkdown);
  const planValidation = validatePlanMarkdown(planMarkdown);
  if (!planValidation.ok) return { ok: false, reason: planValidation.reason || "plan markdown is invalid" };
  const decomposedItems = recordArray(raw.decomposedItems);
  const checklistValidation = validateDecomposedItems(decomposedItems);
  if (!checklistValidation.ok) return { ok: false, reason: checklistValidation.reason };
  const observableValidation = validatePlanObservableContracts(decomposedItems, {
    task,
    problemModel: text(raw.problemModel),
  });
  if (!observableValidation.ok) return { ok: false, reason: observableValidation.reason };
  if (decomposedItems.some((item) => !recordArray(item.sourceRefs).some((ref) => text(ref.kind) === "task_text" && text(ref.locator) === "task:0"))) {
    return { ok: false, reason: "every proposal.decomposedItems entry must cite task_text:task:0 in sourceRefs" };
  }
  const claims = recordArray(raw.claims);
  if (claims.length === 0) return { ok: false, reason: "proposal.claims must be non-empty" };
  return {
    ok: true,
    proposal: {
      proposalId: expectedId,
      planMarkdown,
      problemModel: text(raw.problemModel),
      claims,
      decomposedItems: observableValidation.items,
      changeScope: stringArray(raw.changeScope),
      invariants: stringArray(raw.invariants),
      implementationSteps: stringArray(raw.implementationSteps),
      verification: stringArray(raw.verification),
      unresolvedAssumptions: stringArray(raw.unresolvedAssumptions),
    },
  };
}

export function parsePlanCritique(output: string, reviewer: "A" | "B", targetProposalId: "A" | "B"): { ok: true; critique: PlanCritique } | { ok: false; reason: string } {
  const parsed = parseAgentJson(output);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const raw = recordValue(recordValue(parsed.data).critique || parsed.data);
  if (text(raw.reviewer) !== reviewer || text(raw.targetProposalId) !== targetProposalId) {
    return { ok: false, reason: "critique reviewer or targetProposalId mismatch" };
  }
  return {
    ok: true,
    critique: {
      reviewer,
      targetProposalId,
      objections: recordArray(raw.objections),
      acceptedClaims: stringArray(raw.acceptedClaims),
      unresolvedDisputes: recordArray(raw.unresolvedDisputes),
    },
  };
}

export function parseArbitration(output: string, task = ""): { ok: true; arbitration: ArbitrationDecision } | { ok: false; reason: string } {
  const parsed = parseAgentJson(output);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const raw = recordValue(recordValue(parsed.data).arbitration || parsed.data);
  const decision = text(raw.decision);
  if (!["A", "B", "merge", "unresolved"].includes(decision)) {
    return { ok: false, reason: `invalid arbitration decision: ${decision || "missing"}` };
  }
  if (decision === "unresolved") {
    return {
      ok: true,
      arbitration: {
        decision,
        reason: text(raw.reason) || "plan tournament left unresolved intent or evidence",
        proposal: null,
        acceptedConstraints: stringArray(raw.acceptedConstraints),
        rejectedAlternatives: recordArray(raw.rejectedAlternatives),
      },
    };
  }
  const rawProposal = recordValue(raw.proposal);
  const proposalId = decision === "B" ? "B" : "A";
  const proposalEnvelope = JSON.stringify({ status: "ok", proposal: { ...rawProposal, proposalId } });
  const proposal = parsePlanProposal(proposalEnvelope, proposalId, task);
  if (proposal.ok === false) return { ok: false, reason: `arbitrated proposal invalid: ${proposal.reason}` };
  return {
    ok: true,
    arbitration: {
      decision: decision as ArbitrationDecision["decision"],
      reason: text(raw.reason),
      proposal: proposal.proposal,
      acceptedConstraints: stringArray(raw.acceptedConstraints),
      rejectedAlternatives: recordArray(raw.rejectedAlternatives),
    },
  };
}

function runRecord(run: PlanTournamentRun, result: Awaited<ReturnType<ExecuteRun>>) {
  return {
    role: run.role,
    agent: assuranceAgentName(run.agent),
    variant: assuranceAgentVariant(run.agent),
    conversationKey: run.conversationKey,
    promptSha256: digest(run.prompt),
    ok: result.ok,
    kind: result.kind || null,
    reason: result.reason || null,
    diagnostics: result.diagnostics || null,
  };
}

type ContractParse<T> = (output: string) => { ok: true; value: T } | { ok: false; reason: string };

async function executeParsedRun<T>({
  run,
  execute,
  parse,
  signal,
}: {
  run: PlanTournamentRun;
  execute: ExecuteRun;
  parse: ContractParse<T>;
  signal?: AbortSignal;
}): Promise<{
  ok: true;
  value: T;
  runs: LooseRecord[];
} | {
  ok: false;
  reason?: string;
  kind?: string;
  retryable?: boolean;
  runs: LooseRecord[];
}> {
  const runs: LooseRecord[] = [];
  let currentRun = run;
  let contractAttempt = 0;
  let providerAttempt = 0;
  while (contractAttempt <= CONTRACT_REPAIR_LIMIT) {
    if (signal?.aborted) return abortedRunResult(runs, signal);
    const result = await execute(currentRun);
    runs.push(runRecord(currentRun, result));
    if (!result.ok) {
      const localizedRetryLimit = result.kind === "agent_rate_limited"
        ? PROVIDER_RETRY_LIMIT
        : TRANSIENT_RUN_KINDS.has(result.kind || "")
          ? TRANSIENT_RUN_RETRY_LIMIT
          : 0;
      if (
        result.retryable === true
        && localizedRetryLimit > 0
        && providerAttempt < localizedRetryLimit
      ) {
        providerAttempt += 1;
        const delayMs = providerRetryDelayMs(result, providerAttempt);
        const completedBackoff = await waitForProviderBackoff(delayMs, signal);
        if (!completedBackoff || signal?.aborted) return abortedRunResult(runs, signal);
        const retryLabel = result.kind === "agent_rate_limited" ? "provider-retry" : "transport-retry";
        currentRun = {
          ...currentRun,
          role: `${run.role}_${retryLabel.replace("-", "_")}_${providerAttempt}`,
          conversationKey: `${run.conversationKey}:${retryLabel}:${providerAttempt}`,
        };
        continue;
      }
      if (contractAttempt < CONTRACT_REPAIR_LIMIT && result.kind === "tool_budget_exceeded") {
        contractAttempt += 1;
        currentRun = {
          ...run,
          role: `${run.role}_bounded_retry_${contractAttempt}`,
          conversationKey: `${run.conversationKey}:bounded-retry:${contractAttempt}`,
          prompt: buildToolBudgetRetryPrompt(run, result.reason || "tool budget exceeded"),
        };
        continue;
      }
      if (contractAttempt < CONTRACT_REPAIR_LIMIT && result.kind === "agent_contract_invalid") {
        contractAttempt += 1;
        currentRun = {
          ...run,
          role: `${run.role}_contract_repair_${contractAttempt}`,
          conversationKey: `${run.conversationKey}:contract-repair:${contractAttempt}`,
          prompt: buildContractRepairPrompt(run, result.output || "", result.reason || "agent output exceeded the structured-response budget"),
        };
        continue;
      }
      return { ok: false, reason: result.reason, kind: result.kind, retryable: result.retryable, runs };
    }
    const parsed = parse(result.output || "");
    if (parsed.ok === true) return { ok: true, value: parsed.value, runs };
    if (contractAttempt === CONTRACT_REPAIR_LIMIT) {
      return { ok: false, reason: parsed.reason, kind: "agent_contract_invalid", retryable: true, runs };
    }
    contractAttempt += 1;
    currentRun = {
      ...run,
      role: `${run.role}_contract_repair_${contractAttempt}`,
      conversationKey: `${run.conversationKey}:contract-repair:${contractAttempt}`,
      prompt: buildContractRepairPrompt(run, result.output || "", parsed.reason),
    };
  }
  return { ok: false, reason: "contract repair exhausted", kind: "agent_contract_invalid", retryable: true, runs };
}

export async function runPlanTournament({
  task,
  basePrompt,
  conversationKey,
  policy,
  execute,
  repositoryContract,
  signal,
}: {
  task: string;
  basePrompt: string;
  conversationKey: string;
  policy: HighAssurancePolicy;
  execute: ExecuteRun;
  repositoryContract?: PlanRepositoryContract;
  signal?: AbortSignal;
}): Promise<PlanTournamentResult> {
  const [agentA, agentB] = policy.planning.candidates;
  const runs: LooseRecord[] = [];
  const probePolicyPrompt = frozenProbePolicyPrompt(repositoryContract);
  const bindAndValidateProposal = (proposal: PlanProposal, stage: string) => {
    const bound = repositoryContract
      ? bindPlanProposalPredicates(proposal, repositoryContract, stage)
      : { proposal, bindings: [] as PlanPredicateBinding[] };
    runs.push(...bound.bindings.map(predicateBindingRun));
    if (repositoryContract) {
      const repositoryValidation = validatePlanProposalRepositoryContract(bound.proposal, repositoryContract);
      if (repositoryValidation.ok === false) {
        return { ok: false as const, reason: repositoryValidation.reason };
      }
    }
    return { ok: true as const, proposal: bound.proposal };
  };
  const initialRuns: [PlanTournamentRun, PlanTournamentRun] = [
    { agent: agentA, role: "planner_a", prompt: buildProposalPrompt({ proposalId: "A", basePrompt: `${basePrompt}${probePolicyPrompt}`, task }), conversationKey: `${conversationKey}:proposal:A` },
    { agent: agentB, role: "planner_b", prompt: buildProposalPrompt({ proposalId: "B", basePrompt: `${basePrompt}${probePolicyPrompt}`, task }), conversationKey: `${conversationKey}:proposal:B` },
  ];
  const initialResults = await Promise.all(initialRuns.map((run, index) => executeParsedRun({
    run,
    execute,
    signal,
    parse: (output) => {
      const parsed = parsePlanProposal(output, index === 0 ? "A" : "B", task);
      if (parsed.ok === false) return { ok: false as const, reason: parsed.reason };
      const bound = bindAndValidateProposal(parsed.proposal, index === 0 ? "proposal_a" : "proposal_b");
      if (bound.ok === false) return bound;
      return { ok: true as const, value: bound.proposal };
    },
  })));
  initialResults.forEach((result) => runs.push(...result.runs));
  const initialA = initialResults[0];
  const initialB = initialResults[1];
  if (initialA.ok === false) return { ok: false, reason: initialA.reason, kind: initialA.kind, retryable: initialA.retryable, runs };
  if (initialB.ok === false) return { ok: false, reason: initialB.reason, kind: initialB.kind, retryable: initialB.retryable, runs };
  const candidates = [initialA.value, initialB.value];
  let currentA = initialA.value;
  let currentB = initialB.value;
  let critiques: PlanCritique[] = [];
  const revisions: PlanProposal[] = [];

  for (let round = 1; round <= policy.planning.critiqueRounds; round += 1) {
    const critiqueRuns: [PlanTournamentRun, PlanTournamentRun] = [
      { agent: agentA, role: `critic_a_round_${round}`, prompt: buildCritiquePrompt({ reviewer: "A", task, own: currentA, target: currentB }), conversationKey: `${conversationKey}:critique:${round}:A` },
      { agent: agentB, role: `critic_b_round_${round}`, prompt: buildCritiquePrompt({ reviewer: "B", task, own: currentB, target: currentA }), conversationKey: `${conversationKey}:critique:${round}:B` },
    ];
    const critiqueResults = await Promise.all(critiqueRuns.map((run, index) => executeParsedRun({
      run,
      execute,
      signal,
      parse: (output) => {
        const parsed = parsePlanCritique(output, index === 0 ? "A" : "B", index === 0 ? "B" : "A");
        if (parsed.ok === false) return { ok: false as const, reason: parsed.reason };
        return { ok: true as const, value: parsed.critique };
      },
    })));
    critiqueResults.forEach((result) => runs.push(...result.runs));
    const critiqueAResult = critiqueResults[0];
    const critiqueBResult = critiqueResults[1];
    if (critiqueAResult.ok === false) return { ok: false, reason: critiqueAResult.reason, kind: critiqueAResult.kind, retryable: critiqueAResult.retryable, candidates, critiques, revisions, runs };
    if (critiqueBResult.ok === false) return { ok: false, reason: critiqueBResult.reason, kind: critiqueBResult.kind, retryable: critiqueBResult.retryable, candidates, critiques, revisions, runs };
    const critiqueA = critiqueAResult.value;
    const critiqueB = critiqueBResult.value;
    critiques = [...critiques, critiqueA, critiqueB];
    const revisionRuns: [PlanTournamentRun, PlanTournamentRun] = [
      { agent: agentA, role: `revision_a_round_${round}`, prompt: `${buildRevisionPrompt({ proposalId: "A", task, current: currentA, critique: critiqueB })}${probePolicyPrompt}`, conversationKey: `${conversationKey}:revision:${round}:A` },
      { agent: agentB, role: `revision_b_round_${round}`, prompt: `${buildRevisionPrompt({ proposalId: "B", task, current: currentB, critique: critiqueA })}${probePolicyPrompt}`, conversationKey: `${conversationKey}:revision:${round}:B` },
    ];
    const revisionResults = await Promise.all(revisionRuns.map((run, index) => executeParsedRun({
      run,
      execute,
      signal,
      parse: (output) => {
        const parsed = parsePlanProposal(output, index === 0 ? "A" : "B", task);
        if (parsed.ok === false) return { ok: false as const, reason: parsed.reason };
        const bound = bindAndValidateProposal(
          parsed.proposal,
          `revision_${index === 0 ? "a" : "b"}_round_${round}`,
        );
        if (bound.ok === false) return bound;
        return { ok: true as const, value: bound.proposal };
      },
    })));
    revisionResults.forEach((result) => runs.push(...result.runs));
    const revisionA = revisionResults[0];
    const revisionB = revisionResults[1];
    if (revisionA.ok === false) return { ok: false, reason: revisionA.reason, kind: revisionA.kind, retryable: revisionA.retryable, candidates, critiques, revisions, runs };
    if (revisionB.ok === false) return { ok: false, reason: revisionB.reason, kind: revisionB.kind, retryable: revisionB.retryable, candidates, critiques, revisions, runs };
    currentA = revisionA.value;
    currentB = revisionB.value;
    revisions.push(currentA, currentB);
  }

  const arbitrationRun: PlanTournamentRun = {
    agent: policy.planning.arbiter,
    role: "plan_arbiter",
    prompt: `${buildArbitrationPrompt({ task, proposalA: currentA, proposalB: currentB, critiques })}${probePolicyPrompt}`,
    conversationKey: `${conversationKey}:arbitration`,
  };
  const arbitrationResult = await executeParsedRun({
    run: arbitrationRun,
    execute,
    signal,
    parse: (output) => {
      const parsed = parseArbitration(output, task);
      if (parsed.ok === false) return { ok: false as const, reason: parsed.reason };
      if (parsed.arbitration.proposal) {
        const bound = bindAndValidateProposal(parsed.arbitration.proposal, "arbitration");
        if (bound.ok === false) return bound;
        parsed.arbitration.proposal = bound.proposal;
      }
      return { ok: true as const, value: parsed.arbitration };
    },
  });
  runs.push(...arbitrationResult.runs);
  if (arbitrationResult.ok === false) {
    return { ok: false, reason: arbitrationResult.reason, kind: arbitrationResult.kind, retryable: arbitrationResult.retryable, candidates, critiques, revisions, runs };
  }
  const arbitration = arbitrationResult.value;
  if (!arbitration.proposal) {
    return { ok: false, reason: arbitration.reason, kind: "human_approval_required", retryable: false, candidates, critiques, revisions, decision: arbitration, runs };
  }
  return {
    ok: true,
    proposal: arbitration.proposal,
    decision: arbitration,
    candidates,
    critiques,
    revisions,
    runs,
  };
}
