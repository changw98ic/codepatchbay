# Checklist-First Task Verification Design

## Goal

Upgrade CodePatchBay task completion from verifier-authored pass/fail judgment to a checklist-first, evidence-backed, DAG-aware audit system.

The system should parse every task into a frozen acceptance checklist before execution depends on it, execute against that checklist, verify every required item with concrete evidence, route retries by failed or unchecked item, and let the completion gate make the final decision from structured checklist, evidence, DAG, and scope state.

## Current Baseline

CodePatchBay already has the main runtime pieces needed for this:

- `core/phases/verify.ts` collects plan, git diff, changed file, and hard-gate evidence before asking a verifier agent.
- `core/engine/completion-gate.ts` prevents mutating jobs from completing without a completed verify phase and a parseable passing verdict.
- `core/workflow/verdict.ts` supports structured verdict envelopes, retry reason extraction, `blocking`, and `fix_scope`.
- `server/orchestrator/failure-router.ts` blocks blind verification retries when there is no actionable retry scope.
- `core/engine/run-job.ts` already materializes workflow DAGs, dynamic agent plans, DAG node events, and retry scope guard checks.

The remaining trust gap is that the verifier still has too much authority to define what "done" means at verification time. The new design makes acceptance criteria a first-class contract produced before implementation and audited after implementation.

## V1 Scope

V1 deliberately keeps the runtime change small enough to land safely:

- The acceptance checklist is generated, validated, persisted, and event-indexed before `workflowDag` and `dynamicAgentPlan` materialization.
- Existing execute and verify DAG nodes carry grouped `checklistIds` as coverage metadata; CPB does not split one DAG node per checklist item in V1.
- The plan phase consumes the frozen checklist and may flag a checklist problem, but it is not the source of truth for same-run DAG shaping.
- A frozen checklist is immutable in V1. Scope changes or checklist corrections fail the current attempt or require a new job/revision flow in V2.
- Checklist artifacts are stored as JSON content in the current artifact system. Since `writeArtifact()` writes `${kind}-${id}.md`, V1 uses `.md` artifact files containing JSON.
- V1 extends the existing JSON audit export. A full filesystem review bundle with `task.md`, `diff.patch`, `replay.sh`, and separate report files is V2.

## V2 Scope

These are intentionally out of V1 unless a later plan explicitly pulls them forward:

- Versioned checklist revisions and `acceptance-change-log`.
- Per-checklist-item DAG splitting and parallel item scheduling.
- Per-item adversarial verifier nodes.
- Full replayable audit bundle with standalone files and replay scripts.

## Non-Goals

- Do not replace the existing `plan -> execute -> verify` workflow in one step.
- Do not require full parallel DAG execution before checklist state is useful.
- Do not remove legacy text verdict parsing until current callers have migrated to structured checklist verdicts.
- Do not add new dependencies.
- Do not let executor self-reports count as pass evidence.
- Do not rely on phase diagnostics as the durable source of truth for checklist artifacts.

## Vocabulary

- `acceptanceChecklist`: frozen task contract, produced before DAG materialization.
- `checklist item`: requirement-level acceptance unit, identified by `AC-*`.
- `DAG node`: scheduling unit; one node may reference many checklist item ids for coverage, but node status is not item verdict status.
- `artifact`: durable JSON-content file written through `writeArtifact`, with `kind`, `id`, `name`, `path`, and `metadata`. The JSON content is the contract source.
- `artifact event`: event-log record that makes an artifact discoverable by projection and audit. It is an index/replay entry, not a substitute for artifact JSON content.
- `diagnostics`: phase-result metadata; useful in-process as a cache or artifact handle carrier, but never authoritative for completion, audit, or replay.
- `evidenceRef`: `{ ledgerId, evidenceId }`, not a bare global id.
- `targetChecklistIds`: logical checklist item ids targeted by retry or focused verification.
- `fixScope`: canonical file path list used by scope guard. Paths must be repo-relative POSIX paths, sorted, deduplicated, and must not be absolute, empty, or contain `..`.
- `fix_scope`: legacy parser input only; normalize to `fixScope` before it enters V1 contracts.
- `retryScope`: router/internal file-only scope field; never put checklist ids in it.
- `routing label`: planner/router classification; it must map to a valid `FailureKind` before entering failure contracts.

## Core Contracts

### Acceptance Manifest

`acceptance-checklist` is the immutable V1 task contract. It is produced in prepare-time before the workflow DAG and dynamic agent plan are materialized.

```json
{
  "schemaVersion": 1,
  "jobId": "job-123",
  "project": "flow",
  "source": {
    "task": "Add JSON output to cpb status",
    "issue": null,
    "documents": ["README.md", "docs/architecture/runtime-boundaries.md"]
  },
  "status": "frozen",
  "items": [
    {
      "id": "AC-001",
      "requirement": "cpb status supports --json output",
      "source": "user_task",
      "required": true,
      "area": "cli",
      "risk": "medium",
      "verificationMethod": "command",
      "expectedEvidence": "Command exits 0 and stdout parses as JSON",
      "dependsOn": [],
      "allowedFiles": ["cli/commands/status.ts", "tests/status-command.test.ts"]
    }
  ],
  "assumptions": [
    {
      "id": "ASM-001",
      "text": "Existing status command semantics remain unchanged outside --json mode",
      "risk": "medium",
      "acceptedForExecution": true
    }
  ]
}
```

Rules:

- Every required user-visible requirement must map to at least one checklist item.
- Every checklist item must have a source, area, risk, verification method, and expected evidence.
- High-risk assumptions cannot be silently accepted; they must map to `human_approval_required` or a higher-strength planning path.
- V1 forbids in-place post-freeze checklist mutation. If the checklist is materially wrong, the current job fails with an audit reason and V2 revision/change-log work can address it later.

### Artifact Visibility

Checklist-related files must be discoverable from event replay and artifact index. Writing the file is not enough.

V1 artifact kinds:

- `acceptance-checklist`
- `execution-map`
- `evidence-ledger`
- `checklist-verdict`

Each artifact must be written with `writeArtifact()` and referenced by a first-class artifact event or a multi-artifact event payload that includes at least:

```json
{
  "type": "artifact_created",
  "jobId": "job-123",
  "project": "flow",
  "phase": "verify",
  "kind": "evidence-ledger",
  "artifact": "evidence-ledger-123456",
  "artifactKind": "evidence-ledger",
  "artifactId": "123456",
  "sha256": "..."
}
```

Projection, artifact index, audit export, and event materialization must use event-visible artifacts, not phase diagnostics, as their durable source of truth.
If an artifact has been written, an `artifact_created` event must be emitted before a phase returns success, failure, or blocked status. Artifact `metadata` and diagnostics may mirror JSON content, but cannot supersede it.

### Execution Map

`execution-map` links implementation output back to checklist items.

```json
{
  "schemaVersion": 1,
  "jobId": "job-123",
  "project": "flow",
  "mappings": [
    {
      "checklistId": "AC-001",
      "changedFiles": ["cli/commands/status.ts", "tests/status-command.test.ts"],
      "executorClaim": "Added --json output and tests",
      "notes": "Plain text output path is unchanged"
    }
  ],
  "changedFiles": ["cli/commands/status.ts", "tests/status-command.test.ts"],
  "unmappedChangedFiles": []
}
```

Rules:

- Executor claims are not verification evidence.
- Every changed production file must map to one or more checklist items or appear in `unmappedChangedFiles`.
- `changedFiles`, `mappings[*].changedFiles`, `unmappedChangedFiles`, `allowedFiles`, and `fixScope` use normalized repo-relative POSIX paths.
- Files outside `allowedFiles` or retry `fixScope` produce a scope violation mapped to a valid `FailureKind`.
- `unmappedChangedFiles` must be computed from normalized changed files minus mapped files; it cannot be hard-coded empty.

### Evidence Ledger

`evidence-ledger` stores replayable or inspectable evidence and the final worktree identity used by verification.

```json
{
  "schemaVersion": 1,
  "jobId": "job-123",
  "project": "flow",
  "ledgerId": "evidence-ledger-123456",
  "finalWorktree": {
    "head": "abc123",
    "diffHash": "sha256:..."
  },
  "evidence": [
    {
      "id": "EV-001",
      "type": "command",
      "command": "node dist/cli/cpb.js status demo --json",
      "cwd": "/repo",
      "exitCode": 0,
      "stdoutSha256": "sha256:...",
      "stderrSha256": "sha256:...",
      "summary": "stdout parsed as JSON with project status fields",
      "worktreeHead": "abc123",
      "diffHash": "sha256:..."
    }
  ]
}
```

Rules:

- Evidence ids are ledger-scoped. Cross-artifact references use `{ "ledgerId": "...", "evidenceId": "EV-001" }`.
- A pass result cannot rely on executor summary or unverifiable prose.
- Evidence is stale when its `worktreeHead` or `diffHash` differs from `evidenceLedger.finalWorktree`.
- Completion fails when pass evidence is missing or stale.
- Negative-path evidence is required for CLI, API, validation, auth, retry, and runtime lifecycle tasks.

### Checklist Verdict

`checklist-verdict` is the verifier output. It must be itemized.

```json
{
  "schemaVersion": 1,
  "jobId": "job-123",
  "status": "fail",
  "items": [
    {
      "checklistId": "AC-001",
      "result": "pass",
      "evidenceRefs": [
        { "ledgerId": "evidence-ledger-123456", "evidenceId": "EV-001" }
      ],
      "actualResult": "Command exited 0 and stdout was valid JSON",
      "reason": "The required JSON path is present and dynamically verified",
      "fixScope": []
    },
    {
      "checklistId": "AC-002",
      "result": "unchecked",
      "evidenceRefs": [],
      "actualResult": "",
      "reason": "The missing-project error path was not executed",
      "fixScope": ["cli/commands/status.ts", "tests/status-command.test.ts"]
    }
  ],
  "blocking": [
    {
      "checklistId": "AC-002",
      "criterion": "Missing-project error path must return stable JSON",
      "evidence": "No evidence ref was produced for this required negative case",
      "file": "cli/commands/status.ts",
      "fixHint": "Add an error-path command probe and update JSON error output if needed"
    }
  ],
  "fixScope": ["cli/commands/status.ts", "tests/status-command.test.ts"],
  "reason": "One required checklist item was not verified"
}
```

Rules:

- Item `result` is `pass`, `fail`, or `unchecked`.
- Top-level `status` is derived: `pass` only when every required item is `pass`; otherwise `fail`.
- Required item with `fail` means job failure.
- Required item with `unchecked` means job failure or inconclusive routing, never pass.
- `pass` without at least one non-stale evidence ref is invalid.
- Verifier output that does not cover every required checklist id is invalid.
- `fixScope` is a file path list and should be the minimal file set needed for retry.

### DAG Binding

V1 binds grouped checklist ids to existing DAG nodes before the `workflow_dag_materialized` event. These ids describe coverage intent only.

```json
{
  "nodes": [
    {
      "id": "execute",
      "phase": "execute",
      "role": "executor",
      "checklistIds": ["AC-001", "AC-002"],
      "dependsOn": ["plan"]
    },
    {
      "id": "verify",
      "phase": "verify",
      "role": "verifier",
      "checklistIds": ["AC-001", "AC-002"],
      "dependsOn": ["execute"]
    }
  ]
}
```

Rules:

- `workflowDag.nodes[*].checklistIds` is the V1 DAG coverage metadata source.
- Do not rely on `dynamicAgentPlan.nodeConfig` for executor node checklist metadata unless node config generation is deliberately generalized.
- If `prepareResult` or source context provides a prebuilt `dynamicAgentPlan`, it must reference the same event-indexed acceptance checklist artifact or be rejected/rebuilt before execution.
- Item pass/fail state is derived only from `checklist-verdict.items[*]` plus fresh evidence refs, never from DAG node completion.
- Verify nodes must depend on execute nodes that claim their checklist ids.
- High-risk checklist ids can require grouped `adversarial_verify` nodes.
- In checklist-aware jobs, side-effecting execute, remediate, verify, review, adversarial, or custom dynamic nodes must either carry `checklistIds` or be explicitly marked `checklistNeutral: true`. Unmarked mutating/custom nodes fail the completion gate.
- Per-item split DAG nodes are V2.

## Routing Model

Routing should be deterministic first, AI-assisted second.

Signals:

- `area`: `cli`, `server`, `runtime`, `bridge`, `core`, `web`, `security`, `docs`, `tests`.
- `risk`: `low`, `medium`, `high`.
- `scope`: expected changed files and directories.
- `evidenceRequirement`: `command`, `test`, `api`, `static`, `runtime_event`, `visual`, `manual`.
- `routingLabel`: `scope_violation`, `infra_error`, `needs_clarification`, `checklist_failed`, `checklist_unchecked`.
- `dependencyState`: blocked, ready, completed, failed.

Routing labels must map to valid `FailureKind` values before they enter failure contracts:

| Routing label | FailureKind | Router action | Retry phase | File scope required |
| --- | --- | --- | --- | --- |
| `artifact_invalid` | `artifact_invalid` | block or mark failed | none | no |
| `verdict_invalid` | `verdict_invalid` | retry when verifier can repair shape | verify | no |
| `checklist_failed` | `verification_failed` | retry only with actionable `fixScope`; otherwise mark failed | execute | yes |
| `evidence_missing` / `checklist_unchecked` | `verification_failed` | retry verifier when no file change is needed; otherwise execute repair with `fixScope` | verify or execute | conditional |
| `scope_violation` | `scope_violation` | mark failed, no blind retry | none | no |
| `needs_clarification` | `human_approval_required` | block | none | no |
| `infra_error` | existing runtime, timeout, worker, or agent failure kind | existing infra policy | existing policy | no |

The matrix is part of the contract. A fallback `UNKNOWN` or generic verification failure is not enough for checklist-aware routing.

## Retry Semantics

Retry state is checklist-scoped for task intent and file-scoped for scope guard.

```json
{
  "retryOf": "job-123",
  "targetChecklistIds": ["AC-002", "AC-003"],
  "failedChecklistIds": ["AC-002"],
  "uncheckedChecklistIds": ["AC-003"],
  "lockedPassedChecklistIds": ["AC-001"],
  "fixScope": ["cli/commands/status.ts", "tests/status-command.test.ts"],
  "previousEvidenceRefs": [
    { "ledgerId": "evidence-ledger-123456", "evidenceId": "EV-001" }
  ],
  "retryPhase": "execute"
}
```

Rules:

- Retry repairs only failed or unchecked required items.
- `targetChecklistIds` is prompt and audit context.
- `fixScope` is the only contract input to scope guard; `retryScope` is an internal file-only projection.
- `lockedPassedChecklistIds` and `previousEvidenceRefs` are retry context, not completion authority. The final gate must still re-check freshness or require revalidation when current changes touch those items.
- Checklist failure with actionable file scope restarts from execute/repair, not verify-only loops.
- Unchecked items caused only by missing evidence may route to verifier retry without changing files.

## Completion Gate

The completion gate evaluates checklist state, DAG state, evidence integrity, and scope state.

The gate must build checklist inputs from event-indexed artifact JSON: `acceptance-checklist`, `execution-map`, `evidence-ledger`, and `checklist-verdict`. It must not use `sourceContext`, phase diagnostics, prompt text, executor summary, legacy `VERDICT: PASS`, or artifact metadata that conflicts with JSON content as authoritative checklist facts.

Required checks:

- All required checklist items have `result: "pass"`.
- Every required pass item has at least one evidence ref.
- Every evidence ref resolves to an evidence entry in the referenced ledger.
- Every pass evidence entry is fresh against `evidenceLedger.finalWorktree`.
- No required item is `fail` or `unchecked`.
- Every required verify DAG node completed.
- Required adversarial verify nodes completed for high-risk items.
- Every checklist-aware side-effecting or verifier DAG node is covered by `checklistIds` or explicitly `checklistNeutral: true`.
- No unresolved scope violation exists.
- Top-level checklist verdict status is consistent with item results.

The legacy `VERDICT: PASS` gate remains a compatibility fallback only for jobs without an `acceptance-checklist` artifact.

The `completion_gate_evaluated` event and reducer must preserve checklist fields:

- `checklistOutcome`
- `failedChecklistIds`
- `uncheckedChecklistIds`
- `missingEvidenceRefs`
- `staleEvidenceRefs`

## Audit Export

V1 extends `buildJobAuditExport` JSON. It does not yet create a full filesystem bundle.

The audit JSON must include:

```json
{
  "schemaVersion": 1,
  "project": "flow",
  "jobId": "job-123",
  "eventLog": [],
  "artifactIndex": {},
  "checklist": {},
  "executionMap": {},
  "evidenceLedger": {},
  "checklistVerdict": {},
  "completionGate": {}
}
```

The export reads checklist sections from the artifact index and artifact JSON files produced by `artifact_created` events. It must still work when phase diagnostics and source context are unavailable.

The export should let a reviewer answer:

- What was required?
- Where did each requirement come from?
- What changed?
- What evidence was collected?
- Which items passed, failed, or were not checked?
- Why did CPB mark the task complete or incomplete?

## Rollout Strategy

1. Add artifact event/index support for checklist artifact kinds.
2. Add prepare-time frozen checklist generation and persistence before DAG materialization.
3. Bind grouped checklist ids onto workflow DAG nodes.
4. Add validators for checklist shape, verdict status consistency, evidence refs, and evidence freshness.
5. Teach planner, executor, and verifier prompts/parsers to consume the checklist contract.
6. Persist execution map, evidence ledger, and checklist verdict as event-visible artifacts.
7. Gate completion on checklist/evidence/DAG state.
8. Route retry using `targetChecklistIds` plus file-only `fixScope`.
9. Extend audit JSON export.
10. Later, implement V2 checklist revisions, per-item DAG splitting, and full audit bundles.

## Acceptance Criteria

- CPB can create and persist an event-visible acceptance checklist before DAG materialization.
- Workflow DAG nodes carry grouped `checklistIds` for checklist-aware jobs.
- Checklist DAG ids are coverage metadata only; item results come from `checklist-verdict` and fresh `evidence-ledger` refs.
- Artifact index recognizes `acceptance-checklist`, `execution-map`, `evidence-ledger`, and `checklist-verdict`.
- A verifier cannot pass a checklist-aware job without covering every required item.
- A required unchecked item prevents completion.
- A pass item without fresh evidence prevents completion.
- Retry receives `targetChecklistIds` and file-only `fixScope`.
- Dynamic/custom mutating DAG nodes without checklist coverage or explicit neutrality prevent completion.
- Completion gate emits and materializes checklist-specific failure details.
- Audit JSON export includes checklist, execution map, evidence ledger, checklist verdict, and completion gate details.
- Existing legacy jobs still complete through the current verdict gate until explicitly migrated.
