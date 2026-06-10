# CPB Dynamic Workflow Strict Completion Spec

Date: 2026-06-09

## Summary

This spec supersedes the loose acceptance interpretation of `cpb-dynamic-workflow-riskmap-plan.md` and `dw08-migration-runbook.md`. The goal is to close the gap exposed by the SWE-bench Verified run: CPB can emit RiskMap, workflow DAG, dynamic agent plan, and adversarial metadata while still completing jobs that did not actually run the required verification gates.

Dynamic Workflow is not considered complete until runtime behavior, tests, review bundles, and real benchmark acceptance all enforce the same contract.

## Triggering Evidence

The 10-instance SWE-bench Verified validation showed that CPB can report queue completion while official harness scoring still finds unresolved tasks. The four failed instances were especially useful because the CPB artifacts showed:

1. Jobs completed with only `plan` and `execute` phase results.
2. Review bundles had `evidence.verdict = null` and `evidence.review = null`.
3. High-risk metadata sometimes contained `adversarialRequired: true`, but the materialized DAG did not include `verify` or `adversarial_verify`.
4. `light` plan mode was implemented as `plan + execute`, while DW requirements define lightweight execution as `execute + verify`.
5. Fake ACP and document keyword tests covered parts of the surface but did not prove the product workflow.

## Product Status

Dynamic Workflow claims are blocked until this spec is implemented and verified. Existing releases may continue to run, but UI/API/CLI copy must not claim that CodeGraph-gated dynamic workflows, adversarial verification, or DW-08 acceptance are complete unless the gates below pass.

## Non-Negotiable Runtime Invariants

### 1. Plan Mode Controls Planning, Not Verification

`planMode` must never remove required verification from a mutating durable job.

Canonical semantics:

| Mode | Durable Queue Semantics | Allowed Completion |
|---|---|---|
| `light` | `execute -> verify` | Only after verifier verdict passes |
| `full` | `plan -> execute -> verify` | Only after verifier verdict passes |
| `parent` | `plan` only for reusable planning/cache flows | Must not produce a completed mutating job |
| `none` | Internal/single-phase escape hatch only | Must not be used for normal durable mutating queue completion |
| `auto` | Resolves to one of the above before DAG materialization | Must obey resolved mode gates |

Workflow phase examples:

| Workflow / Plan Mode | Required DAG |
|---|---|
| `direct` / `light` | `execute -> verify` |
| `standard` / `light` | `execute -> verify` |
| `standard` / `full` | `plan -> execute -> verify` |
| `complex` / `full` | `plan -> execute -> review -> verify` |
| high-risk `*` / any mutating mode | normal verify, then `adversarial_verify` after verify pass |

### 2. Verification Is A Completion Gate

A mutating durable job must not reach `completed` unless:

1. A verifier phase ran.
2. A verdict artifact exists.
3. The parsed verdict status is `pass`.
4. Required verification layers are present for the job's `verificationDepth`.
5. If tests could not run, the verdict is not `pass` unless the workflow explicitly classifies the task as non-code/read-only.

`completedPhases` without `verify` is not a successful job. It is `verification_incomplete`.

### 3. Adversarial Verification Is A High-Risk Gate

When `riskMap.adversarialRequired === true`:

1. The materialized DAG must include `adversarial_verify` after `verify`.
2. `adversarial_verify` must run only after ordinary `verify` passes.
3. Completion requires an `adversarial_verdict` artifact with status `pass`.
4. If adversarial verification fails, the job must fail or requeue with retry context. It must not complete.
5. The retry context must include `adversarialFocus`, verdict reason, blocking evidence, and `fix_scope`.

### 4. Projection Is Not Policy

Fields such as `riskMap`, `dynamicAgentPlan`, `workflowDag`, `adversarialRequired`, and `adversarialVerdict` are observability outputs. They do not count as implementation unless the runtime uses them to enforce scheduling and completion gates.

### 5. Fake Providers Are Not Product Acceptance

Fake ACP, fake provider, fake LLM, and fake responder runs are allowed for unit-level and contract tests. They cannot satisfy DW product acceptance.

Any command, test, or runbook that uses fake providers must label itself as a fixture or smoke test and must not be listed as the final acceptance evidence for DW-08.

## Target Architecture

The current implementation mixes too many responsibilities inside `core/engine/run-job.js`. The cleaned architecture must separate policy, projection, and execution.

### Required Boundaries

| Boundary | Responsibility | Must Not Do |
|---|---|---|
| Project Capability Service | CodeGraph readiness, capability maps, freshness | Guess maps from heuristic fallback |
| RiskMap Service | Compute task risk from task text plus capability maps | Build phase lists or silently downgrade verification |
| Phase Policy | Resolve workflow + planMode into required semantic phases | Inspect provider state or execute agents |
| DAG Builder | Convert semantic phases and risk gates into a DAG | Run phases or mark jobs complete |
| Dynamic Agent Planner | Assign required roles/providers to DAG nodes | Add metadata for nodes that do not exist |
| DAG Runtime | Execute ready nodes and record node transitions | Invent risk policy inline |
| Completion Gate | Decide whether a job can become completed | Trust metadata without artifacts |
| Review Bundle Builder | Present evidence for human/API review | Act as the only enforcement mechanism |
| Orchestrator | Schedule queue entries and worker/node capacity | Decide risk or adversarial policy |
| Resident Supervisor | Advisory diagnosis, health summary, failure suggestions | Mutate RiskMap, modify code, or override deterministic gates |

### Module Shape

This spec does not require exact filenames, but the implementation must make these contracts explicit:

1. `WorkflowPhasePolicy`
   - Input: `workflow`, `planMode`, `taskType`, route metadata.
   - Output: semantic phase list before risk gates.
   - Owns the canonical `light = execute + verify` rule.

2. `WorkflowDagBuilder`
   - Input: semantic phases, RiskMap, workflow metadata.
   - Output: DAG nodes, edges, roles, required gates.
   - Owns insertion of `adversarial_verify` after `verify`.

3. `DynamicAgentPlanner`
   - Input: RiskMap plus final DAG.
   - Output: node/role agent requirements.
   - Must fail closed if a required node has no available required agent.

4. `JobCompletionGate`
   - Input: materialized job state, artifacts, parsed verdicts, RiskMap.
   - Output: `complete`, `verification_incomplete`, `verification_failed`, `adversarial_incomplete`, or `adversarial_failed`.
   - Must run before `completeJob()`.

5. `DwAcceptanceHarness`
   - Input: real queue run artifacts, review bundles, and optional official benchmark reports.
   - Output: pass/fail evidence that DW semantics were enforced.

## DW Requirement Matrix

### DW-01: CodeGraph Project Readiness Gate

Requirement:

1. Project registration and attach require live CodeGraph state.
2. Project capability maps must have high confidence.
3. Queue entries without fresh maps block with `codegraph_unavailable`.

Acceptance:

1. CodeGraph missing blocks before `execute`.
2. Stale CodeGraph blocks or refreshes before scheduling.
3. Fake ACP tests do not bypass this requirement in product acceptance.
4. Review bundle records CodeGraph snapshot ID or explicit blocked reason.

### DW-02: Task RiskMap Service

Requirement:

1. Every durable queue job runs `prepare_task` before mutating phases.
2. RiskMap uses Project Capability Map and task text.
3. RiskMap is persisted to queue/job metadata and event store.

Acceptance:

1. Scheduler/provider/worktree/event-store/security tasks become high or critical risk.
2. Docs-only tasks become low or medium.
3. RiskMap confidence is explicit.
4. RiskMap generation failure blocks the job.
5. RiskMap tests include cases where capability maps change the risk result, not just task-text regex matches.

### DW-03: Workflow DAG Schema And Linear Compatibility

Requirement:

1. Legacy workflows are represented as DAGs.
2. `prepare_task` is represented as a preflight DAG node or an explicitly equivalent pre-DAG gate.
3. Node transitions are recorded for every executed node.
4. Plan-mode semantics match this spec.

Acceptance:

1. `standard/full` materializes `plan -> execute -> verify`.
2. `standard/light` materializes `execute -> verify`.
3. `direct/light` materializes `execute -> verify`.
4. `complex/full` materializes `plan -> execute -> review -> verify`.
5. Completed mutating jobs without `verify` are impossible.

### DW-04: DAG-Ready Scheduler And Provider Capacity

Requirement:

1. Scheduler works from ready nodes or an equivalent node-level execution model.
2. Provider capacity is the scheduling bottleneck for ready nodes.
3. Provider-full entries queue instead of failing.

Acceptance:

1. Independent ready nodes can dispatch in parallel when provider capacity exists.
2. Dependent nodes wait for prerequisites.
3. Job-internal execution must not be a hidden sequential loop that ignores DAG readiness.
4. Runtime status explains when no ready nodes exist versus provider capacity is exhausted.

### DW-05: Dynamic Agent Plan

Requirement:

1. Dynamic agent planning happens after final DAG materialization.
2. High and critical risk require independent verifier and adversarial verifier roles.
3. Agent requirements bind to actual DAG nodes.

Acceptance:

1. If `adversarial_verifier` is required but unavailable, the job blocks or fails before execution claims success.
2. `dynamicAgentPlan.nodeConfig` includes verify and adversarial nodes when required.
3. Agent requirements cannot reference missing nodes without failing validation.

### DW-06: Adversarial Verify Node

Requirement:

1. `adversarial_verify` runs after ordinary `verify`.
2. It attacks assumptions, missing proof, unsafe boundaries, and fake validation.
3. It cannot edit files.
4. Failure requeues or remediates with scoped context.

Acceptance:

1. Ordinary `verify` failure skips adversarial and fails/requeues.
2. Ordinary `verify` pass plus `adversarialRequired` runs adversarial.
3. Adversarial fail preserves `adversarial_verdict`, `adversarialFocus`, and `fix_scope`.
4. The next execution pass receives `fix_scope` as a hard scope constraint or a deterministic guard rejects out-of-scope changes.

### DW-07: Observability

Requirement:

1. API, CLI, UI, event store, and review bundles expose the same RiskMap/DAG/adversarial state.
2. Users can tell why adversarial verification did or did not run.
3. Missing required evidence is visible as a failure, not silent absence.

Acceptance:

1. Review bundle includes `riskMap`, `workflowDag`, `dynamicAgentPlan`, `verdict`, `adversarialVerdict`, and completion-gate result.
2. Inbox/job projection shows `verification_incomplete` and `adversarial_incomplete` states.
3. CLI status differentiates `completed`, `failed`, `blocked`, `verification_incomplete`, and `adversarial_incomplete`.

### DW-08: End-To-End Acceptance

Requirement:

1. Real high-risk task triggers adversarial verification.
2. CodeGraph unavailable blocks execution.
3. Adversarial failure enters retry/remediation.
4. SWE-bench and similar benchmark runs validate the workflow gates, not only patch score.

Acceptance:

1. One real high-risk CPB task produces `verify` and `adversarial_verify` artifacts.
2. One real CodeGraph unavailable task blocks with `codegraph_unavailable`.
3. One real or controlled non-fake adversarial failure requeues with scoped retry metadata.
4. SWE-bench runner defaults cannot bypass verification.
5. Official benchmark harness results are ingested into a report that distinguishes patch correctness from CPB workflow enforcement.

### DW-09: Resident Orchestrator Supervisor ACP

Requirement:

1. Supervisor starts with hub orchestrator.
2. Supervisor uses control-plane pool scope and does not consume worker provider capacity.
3. Supervisor provides advisory diagnosis and provider health summary.
4. Deterministic scheduler and gates remain authoritative.

Acceptance:

1. Supervisor health is visible after hub start.
2. Supervisor down/timeout/invalid JSON falls back to deterministic routing.
3. Control-plane ACP does not reduce worker provider slots.
4. Supervisor decisions are durable and schema-validated.
5. Provider health summary comes from real ACP pool/quota/lease state.
6. Supervisor cannot mark incomplete verification as completed.

## Completion Gate Semantics

The completion gate runs after every phase result and immediately before job completion.

### Required Inputs

1. Materialized job state.
2. Workflow DAG nodes and node states.
3. RiskMap.
4. DynamicAgentPlan.
5. Artifact index.
6. Parsed verifier verdict.
7. Parsed adversarial verdict when required.

### Gate Outcomes

| Outcome | Meaning | Queue Result |
|---|---|---|
| `complete` | All required gates passed | completed |
| `verification_incomplete` | Verify did not run or verdict missing | failed or blocked, never completed |
| `verification_failed` | Verify ran and failed | failed/retry |
| `adversarial_incomplete` | Adversarial required but missing | failed or blocked, never completed |
| `adversarial_failed` | Adversarial verdict failed/partial | failed/retry |
| `artifact_invalid` | Required artifact unreadable or unparsable | failed/retry |
| `policy_invalid` | DAG violates required phase semantics | blocked |

## SWE-bench Workflow Acceptance

SWE-bench runs are both product validation and patch quality measurement.

### Runner Requirements

1. Default plan mode must not skip verification.
2. Runner output must persist CPB workflow gate evidence per instance.
3. Runner must record whether each instance had verify and adversarial phases when required.
4. Official harness output must be joined with CPB job artifacts.
5. A benchmark run cannot be labeled "workflow passed" if any completed CPB job lacks required verification evidence.

### Report Fields

Each instance report must include:

1. `instanceId`
2. `cpbProjectId`
3. `queueId`
4. `jobId`
5. `workflow`
6. `planMode`
7. `riskLevel`
8. `verificationDepth`
9. `adversarialRequired`
10. `completedPhases`
11. `workflowGateStatus`
12. `verdictStatus`
13. `adversarialVerdictStatus`
14. `officialResolved`
15. `officialFailToPass`
16. `officialPassToPass`
17. `repairRecommended`

### Score Interpretation

Official SWE-bench score and CPB workflow score are separate:

1. Official score measures patch correctness.
2. Workflow score measures whether CPB enforced its own gates.
3. A patch may fail official scoring while CPB workflow gates pass.
4. A patch may pass official scoring while CPB workflow gates fail.
5. Releases must report both scores.

## Test Requirements

### Unit And Contract Tests

Required focused tests:

1. Phase policy:
   - `light` resolves to `execute -> verify`.
   - `full` resolves to `plan -> execute -> verify`.
   - `none` is rejected for normal durable mutating queue completion.

2. DAG builder:
   - High-risk DAG inserts `adversarial_verify` after `verify`.
   - Adversarial insertion does not depend on a previously filtered verify phase.
   - Missing verify in a mutating DAG is invalid.

3. Dynamic agent plan:
   - Required verifier roles bind to real DAG nodes.
   - Required unavailable verifier fails closed.

4. Completion gate:
   - Completed without verify is rejected.
   - High-risk completed without adversarial verdict is rejected.
   - Invalid verdict artifact is rejected.

5. Retry scope:
   - `fix_scope` enters retry source context.
   - Next execute prompt carries it as a hard scope constraint.
   - Out-of-scope diff can be rejected by deterministic guard.

6. Review bundle:
   - Bundle includes RiskMap, DAG, dynamic agent plan, verifier verdict, adversarial verdict, and completion-gate result.

### Integration Tests

Required integration tests:

1. Managed worker `direct/light` runs `execute -> verify`.
2. Managed worker `standard/light` runs `execute -> verify`.
3. Managed worker high-risk light route runs `execute -> verify -> adversarial_verify`.
4. CodeGraph unavailable blocks before worktree mutation.
5. Adversarial failure requeues with scoped retry metadata.
6. Fake ACP tests are marked fixture-only and do not satisfy product acceptance.

### Product Acceptance

Required non-fake acceptance:

1. One real low/medium risk task completes with verifier verdict.
2. One real high-risk task completes with verifier and adversarial verdict.
3. One real high-risk task intentionally fails adversarial verification and requeues with scoped retry context.
4. One CodeGraph unavailable task blocks before execute.
5. One SWE-bench Verified smoke run records both official score and CPB workflow score.

## Migration Rules

1. Existing completed jobs without verifier verdict must be reported as historical `verification_unchecked`, not silently upgraded.
2. Existing high-risk completed jobs without adversarial verdict must be reported as historical `adversarial_unchecked`.
3. Existing queue entries using `planMode: light` must follow the new `execute -> verify` semantics on retry.
4. Existing tests that assert `direct/light` produces only `execute` must be updated because they protect invalid behavior.
5. Documentation and CLI help must describe `light` as lightweight execution plus verification, not plan-only or execute-only.

## Release Gate

A release may claim DW strict completion only when:

1. All focused tests pass.
2. Product acceptance evidence is generated without fake ACP/provider.
3. SWE-bench runner report includes workflow gate status.
4. At least one high-risk real task shows `verify -> adversarial_verify`.
5. Review bundle evidence contains required DW fields.
6. `runJob` no longer owns policy decisions that belong to RiskMap, phase policy, DAG builder, or completion gate.

## Implementation Priority

### P0: Stop False Completion

1. Fix phase policy so `light` means `execute -> verify`.
2. Add completion gate before `completeJob()`.
3. Require adversarial gate for high-risk completion.
4. Update tests that currently assert execute-only light behavior.
5. Update SWE-bench runner defaults and reports so it cannot bypass verify.

### P1: Restore Architecture Boundaries

1. Extract phase policy out of `runJob`.
2. Extract DAG builder out of `runJob`.
3. Generate dynamic agent plan from final DAG.
4. Make required dynamic roles fail closed.
5. Make review bundle carry DW evidence.

### P2: Close Retry And Remediation Loop

1. Preserve adversarial failure details in retry context.
2. Enforce `fix_scope` as a hard retry constraint.
3. Add deterministic out-of-scope diff guard.
4. Make remediation/retry state visible in CLI/API/UI.

### P3: Product Acceptance Harness

1. Add non-fake DW acceptance runbook.
2. Add SWE-bench workflow score joiner.
3. Add release gate command that reports DW acceptance status.

## Out Of Scope

1. Raising SWE-bench patch score by solving more benchmark tasks.
2. Replacing providers or model routing.
3. Rewriting the UI beyond the DW evidence fields needed for observability.
4. Removing all fake ACP tests. Fake tests remain valid for unit and contract coverage.

## Definition Of Done

DW strict completion is done when a reviewer can inspect a job and answer all of these from artifacts, not assumptions:

1. Was CodeGraph ready?
2. What RiskMap was generated and why?
3. Which DAG nodes were required?
4. Which DAG nodes ran?
5. Which agents were required and selected?
6. Did ordinary verify pass?
7. Was adversarial verify required?
8. Did adversarial verify pass?
9. If a gate failed, what retry scope was produced?
10. Did official benchmark scoring agree with the patch result?
11. Did CPB enforce the workflow it claimed?

