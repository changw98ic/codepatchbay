import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindPlanProposalPredicates,
  buildProposalPrompt,
  freezePlanRepositoryEvidenceLocators,
  parsePlanProposal,
  runPlanTournament,
  validatePlanProposalRepositoryContract,
  type PlanTournamentRun,
} from "../core/assurance/plan-tournament.js";
import type { HighAssurancePolicy } from "../core/policy/high-assurance.js";

const policy: HighAssurancePolicy = {
  enabled: true,
  mode: "high",
  planning: { candidates: ["codex", "claude-glm"], arbiter: "codex", critiqueRounds: 1 },
  execution: { agent: "claude-glm", required: true },
  verification: { agent: "codex", required: true, blind: true, independent: true },
};

function envelope(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function proposal(proposalId: "A" | "B", suffix = "initial") {
  return {
    status: "ok",
    proposal: {
      proposalId,
      problemModel: `${proposalId} evidence-backed model ${suffix}`,
      claims: [{
        claimId: `${proposalId}-C1`,
        statement: "The current implementation path is repository-backed",
        evidenceRefs: ["src/target.ts:1"],
        falsificationProbe: "inspect src/target.ts",
        status: "supported",
      }],
      decomposedItems: [{
        requirement: "Correct the observable target behavior",
        predicateId: `${proposalId.toLowerCase()}-target-behavior`,
        verificationMethod: "static",
        allowedFiles: ["src/target.ts"],
        sourceRefs: [{ kind: "task_text", locator: "task:0" }],
        observableContract: {
          observationKind: "invariant",
          probeInput: "Invoke target() with the task input",
          expectedObservation: "The target behavior satisfies the original task",
          forbiddenObservations: [],
          oracleSourceRefs: [{ kind: "task_text", locator: "task:0" }],
          candidateIndependent: true,
        },
      }],
      changeScope: ["src/target.ts"],
      invariants: ["Unrelated behavior remains unchanged"],
      implementationSteps: ["Patch the target implementation"],
      verification: ["Run focused repository tests"],
      unresolvedAssumptions: [],
      planMarkdown: `## Analysis\nProposal ${proposalId} ${suffix} is grounded in src/target.ts.\n\n## Bounded Handoff\n- Real actors: target\n- Entrypoints: target()\n- Bypass candidates: wrappers\n- Edit files: src/target.ts\n- Verification targets: focused tests\n- Blockers: none\n\n## Implementation Steps\n1. Patch target.\n\n## Testing\nRun focused tests.`,
    },
  };
}

function critique(reviewer: "A" | "B", targetProposalId: "A" | "B") {
  return {
    status: "ok",
    critique: {
      reviewer,
      targetProposalId,
      objections: [],
      acceptedClaims: [`${targetProposalId}-C1`],
      unresolvedDisputes: [],
    },
  };
}

test("plan tournament keeps proposals independent, cross-critiques, revises, and uses a fresh arbiter", async () => {
  const calls: PlanTournamentRun[] = [];
  const execute = async (run: PlanTournamentRun) => {
    calls.push(run);
    if (run.role === "planner_a") return { ok: true, output: envelope(proposal("A")) };
    if (run.role === "planner_b") return { ok: true, output: envelope(proposal("B")) };
    if (run.role.startsWith("critic_a")) return { ok: true, output: envelope(critique("A", "B")) };
    if (run.role.startsWith("critic_b")) return { ok: true, output: envelope(critique("B", "A")) };
    if (run.role.startsWith("revision_a")) return { ok: true, output: envelope(proposal("A", "revised")) };
    if (run.role.startsWith("revision_b")) return { ok: true, output: envelope(proposal("B", "revised")) };
    return {
      ok: true,
      output: envelope({
        status: "ok",
        arbitration: {
          decision: "B",
          reason: "B has the stronger falsifiable path",
          acceptedConstraints: [],
          rejectedAlternatives: [],
          proposal: proposal("B", "winner").proposal,
        },
      }),
    };
  };

  const result = await runPlanTournament({
    task: "Fix target behavior",
    basePrompt: "Inspect the repository read-only.",
    conversationKey: "job:plan-tournament",
    policy,
    execute,
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision?.decision, "B");
  assert.equal(result.proposal?.proposalId, "B");
  assert.equal(calls.length, 7);
  assert.equal(new Set(calls.map((call) => call.conversationKey)).size, 7);
  assert.doesNotMatch(calls[0].prompt, /Target proposal|Revised proposal B/);
  assert.doesNotMatch(calls[1].prompt, /Target proposal|Revised proposal A/);
  assert.match(calls[0].prompt, /existing formatter discarded context/);
  assert.match(calls[0].prompt, /preserve unambiguous collection structure/);
  assert.match(calls[0].prompt, /observableContract frozen from the task and repository state before execution/);
  assert.match(calls[0].prompt, /do not retain scalar quote delimiters around that placeholder/);
  assert.match(calls[2].prompt, /block proposals that add semantic branches/);
  assert.match(calls[2].prompt, /delimiter-flattened collection diagnostics/);
  assert.match(calls[2].prompt, /Candidate-authored regression assertions are not an oracle/);
  assert.match(calls[4].prompt, /minimal formatter-only hypothesis/);
  assert.match(calls[4].prompt, /preserve collection shape/);
  assert.match(calls.at(-1)?.prompt || "", /prefer a formatter-only repair/);
  assert.match(calls.at(-1)?.prompt || "", /native collection shape/);
  assert.match(calls.at(-1)?.prompt || "", /pre-execution behavior oracle/);
  assert.equal(calls.at(-1)?.role, "plan_arbiter");
});

test("proposal contract repairs contract-invalid output and boundedly retries tool-budget drift", async () => {
  const prompt = buildProposalPrompt({
    proposalId: "A",
    basePrompt: "Inspect read-only.",
    task: "Migrate behavior:\n- Warn callers now.\n- Remove the legacy path in version 2.",
  });
  assert.match(prompt, /MUST be exactly one of:/);
  assert.match(prompt, /Do not invent aliases such as "focused_test"/);
  assert.match(prompt, /Every allowedFiles entry must resolve to a tracked file or tracked directory at frozen HEAD/);
  assert.match(prompt, /do not guess a new exact path/);
  assert.match(prompt, /existing formatter discarded context/);
  assert.match(prompt, /preserve unambiguous collection structure/);
  assert.match(prompt, /literal expected output or literal required fragment/);
  assert.match(prompt, /task:bullet:1: Warn callers now/);
  assert.match(prompt, /task:bullet:2: Remove the legacy path in version 2/);
  assert.match(prompt, /commit date or unsupported chronology guess is not evidence/);

  const calls: PlanTournamentRun[] = [];
  const execute = async (run: PlanTournamentRun) => {
    calls.push(run);
    if (run.role === "planner_a") {
      return {
        ok: false,
        kind: "agent_contract_invalid",
        reason: "agent_output_budget_exceeded: compatible endpoint ignored the response cap",
        retryable: true,
      };
    }
    if (run.role === "planner_a_contract_repair_1") return { ok: true, output: envelope(proposal("A")) };
    if (run.role === "planner_b") return { ok: true, output: envelope(proposal("B")) };
    if (run.role.startsWith("critic_a")) return { ok: true, output: envelope(critique("A", "B")) };
    if (run.role.startsWith("critic_b")) return { ok: true, output: envelope(critique("B", "A")) };
    if (run.role === "revision_a_round_1") {
      return { ok: false, kind: "tool_budget_exceeded", reason: "tool budget exceeded", retryable: true };
    }
    if (run.role === "revision_a_round_1_bounded_retry_1") return { ok: true, output: envelope(proposal("A", "revised")) };
    if (run.role.startsWith("revision_a")) return { ok: true, output: envelope(proposal("A", "revised")) };
    if (run.role.startsWith("revision_b")) return { ok: true, output: envelope(proposal("B", "revised")) };
    return {
      ok: true,
      output: envelope({
        status: "ok",
        arbitration: {
          decision: "A",
          reason: "A is repository-backed",
          acceptedConstraints: [],
          rejectedAlternatives: [],
          proposal: proposal("A", "winner").proposal,
        },
      }),
    };
  };

  const result = await runPlanTournament({
    task: "Fix target behavior",
    basePrompt: "Inspect the repository read-only.",
    conversationKey: "job:contract-repair",
    policy,
    execute,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 9);
  assert.equal(calls.filter((call) => call.role === "planner_a_contract_repair_1").length, 1);
  assert.match(calls.find((call) => call.role === "planner_a_contract_repair_1")?.prompt || "", /agent_output_budget_exceeded/);
  assert.equal(calls.filter((call) => call.role === "revision_a_round_1_bounded_retry_1").length, 1);
  assert.match(calls.find((call) => call.role === "revision_a_round_1_bounded_retry_1")?.prompt || "", /Do not call any tools/);
});

test("plan tournament preserves the successful side while retrying only a rate-limited planner", async () => {
  const calls: PlanTournamentRun[] = [];
  let plannerBAttempts = 0;
  const execute = async (run: PlanTournamentRun) => {
    calls.push(run);
    if (run.role === "planner_a") return { ok: true, output: envelope(proposal("A")) };
    if (run.role.startsWith("planner_b")) {
      plannerBAttempts += 1;
      if (plannerBAttempts <= 4) {
        return {
          ok: false,
          kind: "agent_rate_limited",
          reason: "529 overloaded",
          retryable: true,
          diagnostics: { cause: { nextEligibleAt: Date.now() } },
        };
      }
      return { ok: true, output: envelope(proposal("B")) };
    }
    if (run.role.startsWith("critic_a")) return { ok: true, output: envelope(critique("A", "B")) };
    if (run.role.startsWith("critic_b")) return { ok: true, output: envelope(critique("B", "A")) };
    if (run.role.startsWith("revision_a")) return { ok: true, output: envelope(proposal("A", "revised")) };
    if (run.role.startsWith("revision_b")) return { ok: true, output: envelope(proposal("B", "revised")) };
    return {
      ok: true,
      output: envelope({
        status: "ok",
        arbitration: {
          decision: "A",
          reason: "A wins",
          acceptedConstraints: [],
          rejectedAlternatives: [],
          proposal: proposal("A", "winner").proposal,
        },
      }),
    };
  };

  const result = await runPlanTournament({
    task: "Fix target behavior",
    basePrompt: "Inspect read-only.",
    conversationKey: "job:provider-retry",
    policy,
    execute,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.filter((call) => call.role === "planner_a").length, 1);
  assert.equal(calls.filter((call) => call.role === "planner_b").length, 1);
  assert.equal(calls.filter((call) => call.role === "planner_b_provider_retry_1").length, 1);
  assert.equal(calls.filter((call) => call.role === "planner_b_provider_retry_4").length, 1);
  assert.match(calls.find((call) => call.role === "planner_b_provider_retry_1")?.conversationKey || "", /provider-retry:1$/);
});

test("plan tournament aborts provider backoff promptly without launching another attempt", async () => {
  const calls: PlanTournamentRun[] = [];
  const abort = new AbortController();
  const execute = async (run: PlanTournamentRun) => {
    calls.push(run);
    if (run.role === "planner_a") return { ok: true, output: envelope(proposal("A")) };
    if (run.role === "planner_b") {
      setTimeout(() => abort.abort(new Error("job cancelled")), 20);
      return {
        ok: false,
        kind: "agent_rate_limited",
        reason: "529 overloaded",
        retryable: true,
        diagnostics: { cause: { nextEligibleAt: Date.now() + 60_000 } },
      };
    }
    throw new Error(`unexpected provider attempt after abort: ${run.role}`);
  };

  const startedAt = Date.now();
  const result = await runPlanTournament({
    task: "Fix target behavior",
    basePrompt: "Inspect read-only.",
    conversationKey: "job:provider-retry-abort",
    policy,
    signal: abort.signal,
    execute,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(result.kind, "runtime_interrupted");
  assert.equal(result.retryable, false);
  assert.match(result.reason || "", /job cancelled/);
  assert.ok(elapsedMs < 1_000, `expected prompt abort, waited ${elapsedMs}ms`);
  assert.equal(calls.filter((call) => call.role === "planner_b_provider_retry_1").length, 0);
});

test("plan tournament retries a vanished arbiter locally without replaying prior rounds", async () => {
  const calls: PlanTournamentRun[] = [];
  let arbiterAttempts = 0;
  const execute = async (run: PlanTournamentRun) => {
    calls.push(run);
    if (run.role === "planner_a") return { ok: true, output: envelope(proposal("A")) };
    if (run.role === "planner_b") return { ok: true, output: envelope(proposal("B")) };
    if (run.role.startsWith("critic_a")) return { ok: true, output: envelope(critique("A", "B")) };
    if (run.role.startsWith("critic_b")) return { ok: true, output: envelope(critique("B", "A")) };
    if (run.role.startsWith("revision_a")) return { ok: true, output: envelope(proposal("A", "revised")) };
    if (run.role.startsWith("revision_b")) return { ok: true, output: envelope(proposal("B", "revised")) };
    arbiterAttempts += 1;
    if (arbiterAttempts === 1) {
      return {
        ok: false,
        kind: "agent_unavailable",
        reason: "codex exited null: ",
        retryable: true,
        diagnostics: { cause: { nextEligibleAt: Date.now() } },
      };
    }
    return {
      ok: true,
      output: envelope({
        status: "ok",
        arbitration: {
          decision: "A",
          reason: "A wins",
          acceptedConstraints: [],
          rejectedAlternatives: [],
          proposal: proposal("A", "winner").proposal,
        },
      }),
    };
  };

  const result = await runPlanTournament({
    task: "Fix target behavior",
    basePrompt: "Inspect read-only.",
    conversationKey: "job:transport-retry",
    policy,
    execute,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.filter((call) => call.role === "planner_a").length, 1);
  assert.equal(calls.filter((call) => call.role === "planner_b").length, 1);
  assert.equal(calls.filter((call) => call.role === "plan_arbiter").length, 1);
  assert.equal(calls.filter((call) => call.role === "plan_arbiter_transport_retry_1").length, 1);
  assert.match(calls.find((call) => call.role === "plan_arbiter_transport_retry_1")?.conversationKey || "", /transport-retry:1$/);
});

test("plan tournament fails closed when arbitration leaves intent unresolved", async () => {
  const execute = async (run: PlanTournamentRun) => {
    if (run.role === "planner_a") return { ok: true, output: envelope(proposal("A")) };
    if (run.role === "planner_b") return { ok: true, output: envelope(proposal("B")) };
    if (run.role.startsWith("critic_a")) return { ok: true, output: envelope(critique("A", "B")) };
    if (run.role.startsWith("critic_b")) return { ok: true, output: envelope(critique("B", "A")) };
    if (run.role.startsWith("revision_a")) return { ok: true, output: envelope(proposal("A", "revised")) };
    if (run.role.startsWith("revision_b")) return { ok: true, output: envelope(proposal("B", "revised")) };
    return {
      ok: true,
      output: envelope({
        status: "ok",
        arbitration: {
          decision: "unresolved",
          reason: "The task requires a product choice not present in the repository",
          acceptedConstraints: [],
          rejectedAlternatives: [],
          proposal: null,
        },
      }),
    };
  };

  const result = await runPlanTournament({
    task: "Optimize performance",
    basePrompt: "Inspect read-only.",
    conversationKey: "job:unresolved",
    policy,
    execute,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "human_approval_required");
  assert.match(result.reason || "", /product choice/);
});

test("plan proposal keeps task requirements distinct from repository evidence", () => {
  const invalid = proposal("A");
  invalid.proposal.decomposedItems[0].sourceRefs = [{ kind: "repo", locator: "src/target.ts:1" }];
  const parsed = parsePlanProposal(envelope(invalid), "A");
  assert.equal(parsed.ok, false);
  if (parsed.ok === false) assert.match(parsed.reason, /task_text:task:0/);
});

test("plan proposal requires a candidate-independent observable contract", () => {
  const missing = proposal("A");
  delete (missing.proposal.decomposedItems[0] as unknown as Record<string, unknown>).observableContract;
  const missingResult = parsePlanProposal(envelope(missing), "A", "Fix target behavior");
  assert.equal(missingResult.ok, false);
  if (missingResult.ok === false) assert.match(missingResult.reason, /observableContract/);

  const diagnostic = proposal("A");
  const diagnosticItem = diagnostic.proposal.decomposedItems[0] as unknown as Record<string, unknown>;
  diagnosticItem.observableContract = {
    observationKind: "invariant",
    probeInput: "Trigger the diagnostic",
    expectedObservation: "The diagnostic is clearer",
    forbiddenObservations: [],
    oracleSourceRefs: [{ kind: "task_text", locator: "task:0" }],
    candidateIndependent: true,
  };
  const wrongKind = parsePlanProposal(envelope(diagnostic), "A", "Fix the exception message text");
  assert.equal(wrongKind.ok, false);
  if (wrongKind.ok === false) assert.match(wrongKind.reason, /exact_text or contains_text/);

  diagnosticItem.observableContract = {
    observationKind: "contains_text",
    probeInput: "Trigger the diagnostic",
    expectedObservation: "expected ['a', 'b'] but found ['a']",
    forbiddenObservations: ["expected '['a', 'b']' but found '['a']'"],
    oracleSourceRefs: [{ kind: "task_text", locator: "task:0" }],
    candidateIndependent: true,
  };
  const valid = parsePlanProposal(envelope(diagnostic), "A", "Fix the exception message text");
  assert.equal(valid.ok, true);
});

test("repository contract rejects hallucinated source refs and untrusted executable predicates", () => {
  const parsed = parsePlanProposal(envelope(proposal("A")), "A");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  parsed.proposal.decomposedItems[0].sourceRefs = [
    { kind: "task_text", locator: "task:0" },
    { kind: "repository_path", locator: "src/missing.ts:42" },
  ];
  const contract = {
    repositoryIndexAvailable: true,
    trackedPaths: new Set(["src/target.ts"]),
    trustedProbePredicateIds: new Set<string>(),
  };
  const missingPath = validatePlanProposalRepositoryContract(parsed.proposal, contract);
  assert.equal(missingPath.ok, false);
  assert.match(missingPath.reason, /does not exist at frozen repository HEAD/);

  parsed.proposal.decomposedItems[0].sourceRefs = [
    { kind: "task_text", locator: "task:0" },
    { kind: "repository", locator: "src/missing.ts:42" },
  ];
  const missingRepositoryAlias = validatePlanProposalRepositoryContract(parsed.proposal, contract);
  assert.equal(missingRepositoryAlias.ok, false);
  assert.match(missingRepositoryAlias.reason, /repository:src\/missing\.ts:42/);

  parsed.proposal.decomposedItems[0].sourceRefs = [
    { kind: "task_text", locator: "task:0" },
    { kind: "repository", locator: "src/target.ts:42" },
  ];
  assert.equal(validatePlanProposalRepositoryContract(parsed.proposal, contract).ok, true);

  parsed.proposal.decomposedItems[0].sourceRefs = [
    { kind: "task_text", locator: "task:0" },
    { kind: "repository_file", locator: "src/missing.ts:42" },
  ];
  const missingRepositoryFileAlias = validatePlanProposalRepositoryContract(parsed.proposal, contract);
  assert.equal(missingRepositoryFileAlias.ok, false);
  assert.match(missingRepositoryFileAlias.reason, /repository_file:src\/missing\.ts:42/);

  parsed.proposal.decomposedItems[0].sourceRefs = [{ kind: "task_text", locator: "task:0" }];
  const observableContract = parsed.proposal.decomposedItems[0].observableContract as Record<string, unknown>;
  observableContract.oracleSourceRefs = [
    { kind: "task_text", locator: "task:0" },
    { kind: "repository", locator: "src/missing.ts:99" },
  ];
  const missingOraclePath = validatePlanProposalRepositoryContract(parsed.proposal, contract);
  assert.equal(missingOraclePath.ok, false);
  assert.match(missingOraclePath.reason, /observableContract\.oracleSourceRefs/);

  observableContract.oracleSourceRefs = [{ kind: "task_text", locator: "task:0" }];
  parsed.proposal.decomposedItems[0].verificationMethod = "test";
  const untrustedTest = validatePlanProposalRepositoryContract(parsed.proposal, contract);
  assert.equal(untrustedTest.ok, false);
  assert.match(untrustedTest.reason, /not present in the frozen maintainer probe policy/);
});

test("frozen repository refs cover read-only evidence outside edit scope", () => {
  const parsed = parsePlanProposal(envelope(proposal("A")), "A");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  parsed.proposal.decomposedItems[0].sourceRefs = [
    { kind: "task_text", locator: "task:0" },
    { kind: "repository", locator: "tests/read-only.test.ts:58" },
  ];
  const observableContract = parsed.proposal.decomposedItems[0].observableContract as Record<string, unknown>;
  observableContract.oracleSourceRefs = [
    { kind: "task_text", locator: "task:0" },
    { kind: "repository_file", locator: "src/target.ts:42" },
  ];
  const contract = {
    repositoryIndexAvailable: true,
    trackedPaths: new Set(["src/target.ts", "tests/read-only.test.ts"]),
    trustedProbePredicateIds: new Set<string>(),
    frozenRevision: "0123456789abcdef",
  };

  const frozen = freezePlanRepositoryEvidenceLocators(parsed.proposal, contract);
  assert.equal(frozen.ok, true);
  assert.equal(frozen.basis, "validated_frozen_head_repository_refs");
  assert.equal(frozen.frozenRevision, "0123456789abcdef");
  assert.equal(frozen.repositoryIndexAvailable, true);
  assert.deepEqual(frozen.locators.sort(), ["src/target.ts:42", "tests/read-only.test.ts:58"]);

  const unavailable = freezePlanRepositoryEvidenceLocators(parsed.proposal, {
    ...contract,
    repositoryIndexAvailable: false,
  });
  assert.equal(unavailable.ok, true);
  assert.equal(unavailable.frozenRevision, null);
  assert.equal(unavailable.repositoryIndexAvailable, false);
  assert.deepEqual(unavailable.locators, []);
});

test("predicate binding projects untrusted executable checks to explicit static evidence", () => {
  const parsed = parsePlanProposal(envelope(proposal("B")), "B");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  parsed.proposal.decomposedItems[0] = {
    ...parsed.proposal.decomposedItems[0],
    predicateId: "b-invented-regression-command",
    verificationMethod: "test",
    requiresRealPathEvidence: true,
    expectedEvidence: "The invented test passed.",
  };
  const bound = bindPlanProposalPredicates(parsed.proposal, {
    repositoryIndexAvailable: true,
    trackedPaths: new Set(["src/target.ts"]),
    trustedProbePredicateIds: new Set(),
  }, "revision_b_round_1");

  assert.equal(bound.bindings.length, 1);
  assert.deepEqual(bound.bindings[0], {
    stage: "revision_b_round_1",
    itemIndex: 0,
    predicateId: "b-invented-regression-command",
    requestedMethod: "test",
    boundMethod: "static",
    reason: "predicate_not_in_frozen_maintainer_policy",
  });
  assert.equal(bound.proposal.decomposedItems[0].verificationMethod, "static");
  assert.equal(bound.proposal.decomposedItems[0].requiresRealPathEvidence, false);
  assert.match(String(bound.proposal.decomposedItems[0].expectedEvidence), /Static candidate evidence/);
  assert.equal(validatePlanProposalRepositoryContract(bound.proposal, {
    repositoryIndexAvailable: true,
    trackedPaths: new Set(["src/target.ts"]),
    trustedProbePredicateIds: new Set(),
  }).ok, true);
});

test("plan tournament deterministically binds an invented revision probe and continues to arbitration", async () => {
  const calls: PlanTournamentRun[] = [];
  const execute = async (run: PlanTournamentRun) => {
    calls.push(run);
    if (run.role === "planner_a") return { ok: true, output: envelope(proposal("A")) };
    if (run.role === "planner_b") return { ok: true, output: envelope(proposal("B")) };
    if (run.role.startsWith("critic_a")) return { ok: true, output: envelope(critique("A", "B")) };
    if (run.role.startsWith("critic_b")) return { ok: true, output: envelope(critique("B", "A")) };
    if (run.role.startsWith("revision_a")) return { ok: true, output: envelope(proposal("A", "revised")) };
    if (run.role === "revision_b_round_1") {
      const revised = proposal("B", "revised with invented probe");
      revised.proposal.decomposedItems[0].verificationMethod = "test";
      revised.proposal.decomposedItems[0].predicateId = "b-requirement-regression";
      return { ok: true, output: envelope(revised) };
    }
    return {
      ok: true,
      output: envelope({
        status: "ok",
        arbitration: {
          decision: "B",
          reason: "B has the stronger formatter diagnosis",
          acceptedConstraints: [],
          rejectedAlternatives: [],
          proposal: proposal("B", "winner").proposal,
        },
      }),
    };
  };

  const result = await runPlanTournament({
    task: "Fix target behavior",
    basePrompt: "Inspect read-only.",
    conversationKey: "job:deterministic-predicate-binding",
    policy,
    repositoryContract: {
      repositoryIndexAvailable: true,
      trackedPaths: new Set(["src/target.ts"]),
      trustedProbePredicateIds: new Set(),
    },
    execute,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(calls.some((call) => call.role === "revision_b_round_1_contract_repair_1"), false);
  assert.match(calls.find((call) => call.role === "planner_a")?.prompt || "", /no maintainer-approved command\/test predicateIds/);
  assert.equal(result.revisions?.find((entry) => entry.proposalId === "B")?.decomposedItems[0].verificationMethod, "static");
  const bindingTrace = result.runs?.find((entry) => entry.role === "deterministic_predicate_binding");
  assert.equal(bindingTrace?.kind, "predicate_binding_projected");
  assert.equal((bindingTrace?.diagnostics as Record<string, unknown>)?.stage, "revision_b_round_1");
});

test("repository contract binds allowedFiles to tracked files or directories at frozen HEAD", () => {
  const parsed = parsePlanProposal(envelope(proposal("A")), "A");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const contract = {
    repositoryIndexAvailable: true,
    trackedPaths: new Set(["src/target.ts", "tests/unit/existing.test.ts"]),
    trustedProbePredicateIds: new Set<string>(),
  };

  parsed.proposal.decomposedItems[0].sourceRefs = [{ kind: "task_text", locator: "task:0" }];
  parsed.proposal.decomposedItems[0].allowedFiles = ["src/missing.ts"];
  const missingPath = validatePlanProposalRepositoryContract(parsed.proposal, contract);
  assert.equal(missingPath.ok, false);
  assert.match(missingPath.reason, /allowedFiles\[0\].*does not exist at frozen repository HEAD/);

  parsed.proposal.decomposedItems[0].allowedFiles = ["src/target.ts"];
  assert.equal(validatePlanProposalRepositoryContract(parsed.proposal, contract).ok, true);

  parsed.proposal.decomposedItems[0].allowedFiles = ["tests/unit"];
  assert.equal(validatePlanProposalRepositoryContract(parsed.proposal, contract).ok, true);
});

test("plan tournament contract-repairs a hallucinated repository path before critique", async () => {
  const calls: PlanTournamentRun[] = [];
  const invalidA = proposal("A");
  invalidA.proposal.decomposedItems[0].sourceRefs = [
    { kind: "task_text", locator: "task:0" },
    { kind: "repository_path", locator: "src/hallucinated.ts" },
  ];
  const execute = async (run: PlanTournamentRun) => {
    calls.push(run);
    if (run.role === "planner_a") return { ok: true, output: envelope(invalidA) };
    if (run.role === "planner_a_contract_repair_1") return { ok: true, output: envelope(proposal("A")) };
    if (run.role === "planner_b") return { ok: true, output: envelope(proposal("B")) };
    if (run.role.startsWith("critic_a")) return { ok: true, output: envelope(critique("A", "B")) };
    if (run.role.startsWith("critic_b")) return { ok: true, output: envelope(critique("B", "A")) };
    if (run.role.startsWith("revision_a")) return { ok: true, output: envelope(proposal("A", "revised")) };
    if (run.role.startsWith("revision_b")) return { ok: true, output: envelope(proposal("B", "revised")) };
    return {
      ok: true,
      output: envelope({
        status: "ok",
        arbitration: {
          decision: "A",
          reason: "A now cites the frozen repository",
          acceptedConstraints: [],
          rejectedAlternatives: [],
          proposal: proposal("A", "winner").proposal,
        },
      }),
    };
  };

  const result = await runPlanTournament({
    task: "Fix target behavior",
    basePrompt: "Inspect read-only.",
    conversationKey: "job:repository-contract-repair",
    policy,
    repositoryContract: {
      repositoryIndexAvailable: true,
      trackedPaths: new Set(["src/target.ts"]),
      trustedProbePredicateIds: new Set(),
    },
    execute,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.filter((call) => call.role === "planner_a_contract_repair_1").length, 1);
  assert.match(calls.find((call) => call.role === "planner_a_contract_repair_1")?.prompt || "", /src\/hallucinated\.ts/);
});

test("plan tournament contract-repairs an arbiter that introduces a missing allowed file", async () => {
  const calls: PlanTournamentRun[] = [];
  const invalidWinner = proposal("A", "invalid winner");
  invalidWinner.proposal.decomposedItems[0].allowedFiles = ["tests/unit/guessed.test.ts"];
  const execute = async (run: PlanTournamentRun) => {
    calls.push(run);
    if (run.role === "planner_a") return { ok: true, output: envelope(proposal("A")) };
    if (run.role === "planner_b") return { ok: true, output: envelope(proposal("B")) };
    if (run.role.startsWith("critic_a")) return { ok: true, output: envelope(critique("A", "B")) };
    if (run.role.startsWith("critic_b")) return { ok: true, output: envelope(critique("B", "A")) };
    if (run.role.startsWith("revision_a")) return { ok: true, output: envelope(proposal("A", "revised")) };
    if (run.role.startsWith("revision_b")) return { ok: true, output: envelope(proposal("B", "revised")) };
    const winner = run.role === "plan_arbiter" ? invalidWinner : proposal("A", "repaired winner");
    return {
      ok: true,
      output: envelope({
        status: "ok",
        arbitration: {
          decision: "A",
          reason: "A has the narrower repository-backed scope",
          acceptedConstraints: [],
          rejectedAlternatives: [],
          proposal: winner.proposal,
        },
      }),
    };
  };

  const result = await runPlanTournament({
    task: "Fix target behavior",
    basePrompt: "Inspect read-only.",
    conversationKey: "job:arbiter-allowed-files-contract-repair",
    policy,
    repositoryContract: {
      repositoryIndexAvailable: true,
      trackedPaths: new Set(["src/target.ts", "tests/unit/existing.test.ts"]),
      trustedProbePredicateIds: new Set(),
    },
    execute,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.filter((call) => call.role === "plan_arbiter_contract_repair_1").length, 1);
  assert.match(calls.find((call) => call.role === "plan_arbiter_contract_repair_1")?.prompt || "", /tests\/unit\/guessed\.test\.ts/);
  assert.deepEqual(result.proposal?.decomposedItems[0].allowedFiles, ["src/target.ts"]);
});
