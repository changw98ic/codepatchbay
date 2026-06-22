# CodePatchBay Stabilization Baseline - 2026-06-22

This baseline starts the stabilization cycle for the execution kernel,
production-default checklist path, dry-run finalizer, type gates, and flagship
GitHub Issue -> evidence-backed draft PR path.

## Freeze Scope

Until the stabilization gates are complete, do not add new agent types,
workflow categories, scheduler features, or provider integrations. Work should
focus on:

- execution-kernel recovery and event-order safety
- production-default checklist decomposition coverage
- managed-worker/ACP isolation evidence
- dry-run finalizer and non-destructive PR request preview
- type gates for `core/engine`
- trust evidence for the flagship GitHub Issue -> draft PR path

## Post-Stabilization Note (2026-06-23)

An adversarial architecture review closed two recurring "remaining debt"
items that appear through the checkpoint log below as **design intent, not
debt**. No further work is planned on either:

- **"DAG execution is still sequential despite the contract being DAG-shaped"**
  — All five built-in workflows (`standard`, `direct`, `complex`, `blocked`,
  `accelerated`) normalize to single-chain DAGs with `maxConcurrentNodes: 1`
  (`core/workflow/definition.ts:144-153`). The scheduler
  `dagSequentialExecutionPlan` (`core/engine/run-job-planning.ts:80`) keeps only the
  first ready node per round, and `scheduleReadyNodes`
  (`core/workflow/dag-executor.ts:248`) is dead code with no runtime caller.
  A typical run has exactly **1 ready node** at any time — there is no
  schedulable width. The DAG-shaped contract is a data-structure affordance
  for future wide workflows, not a runtime feature. Building a parallel
  executor has zero current ROI. Sequential traversal is the design.

- **"strict mode still excludes `run-job.ts`"** — **Resolved (commit
  `057c4e77`):** `run-job.ts` is now in the strict-engine gate. An earlier
  draft of this note argued the exclusion was a correct orchestrator-boundary
  call; that argument was wrong — the `ctx: AnyRecord` sites are explicit
  `any` (legal under `tsc --strict`, which forbids implicit any, not explicit),
  not an architectural blocker. The migration fixed 38 strict errors across
  `run-job.ts` (14) and its imports `handoff-bundle` / `dynamic-agent-plan` /
  `agent-runner` / `session-cache` (24). The type-debt allowlist for
  `run-job.ts` is 28 `AnyRecord` occurrences (`workflowDag`/`phaseRoleMap`
  tightened to concrete types; `executionNodes`/`dagResumeContext`/
  `acceptanceChecklist` kept as `AnyRecord | undefined` because
  `WorkflowDagNode` is `JsonRecord`-based and narrowing cascades `unknown`
  into 12+ downstream access sites).

  **Follow-up debt surfaced by this migration:** two `runPhase` call sites
  (`run-job.ts:991`, `run-job.ts:1011`) use `as (input: AnyRecord) =>
  Promise<any>` to bridge a covariance gap. Root cause: `run-phase.ts`
  defines `PhaseResult` as `ReturnType<typeof phasePassed | phaseFailed>`
  (its `failure` field is `unknown`), while 7 other `core/engine` files each
  declare their own local `type PhaseResult` with incompatible `failure`
  shapes (`QuotaFailure | null` etc). Consolidating into one canonical
  `PhaseResult` in `shared/types.ts` removes the as-assertions. This is the
  next strict-quality debt; non-blocking.

The stabilization items that remain open are: (1) the flagship GitHub Issue
-> draft PR path, which by design requires a 3-maintainer/team manual
validation that automation cannot substitute (see
`docs/product/cpb-flagship-validation-gate.md`); and (2) the `PhaseResult`
fragmentation follow-up above.

## Baseline Metrics

Measured in the isolated worktree
`/Users/chengwen/.config/superpowers/worktrees/flow/cpb-stabilization-plan`.

| Metric | Baseline |
| --- | ---: |
| `core/engine/run-job.ts` line count | 2384 |
| `runJobInner` span | `core/engine/run-job.ts:1254-2202` |
| `runJobInner` line count | 949 |
| `core/engine` broad-any/cast grep-line hits | 80 |
| type-debt guard `AnyRecord` occurrences | 88 |
| type-debt guard `Record<string, any>` occurrences | 4 |
| type-debt guard `as any` occurrences | 0 |
| type-debt guard `unknown as` occurrences | 0 |
| type-debt guard TS ignore occurrences | 0 |
| Total type-debt guard allowlisted occurrences | 92 |

## Baseline Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `npm ci` | pass | Installed 5 packages, 0 vulnerabilities |
| `npm run typecheck` | pass | `tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.tests.json --noEmit` exited 0 |
| `npm run verify:p0p1 -- --full` | fail | Focused P0/P1 node tests failed before the full suite |

## Existing Gate Failure

`npm run verify:p0p1 -- --full` currently fails in the focused P0/P1 node-test
stage. The failing tests are concentrated in `tests/engine-prepare-task.test.js`
and `tests/engine-provider-event.test.js`.

Observed failure pattern:

- focused P0/P1 runs tests directly with `node --test`
- those tests do not inherit the standard `scripts/run-node-tests.ts`
  `CPB_CHECKLIST_DECOMPOSE=0` isolation
- `runJob` therefore uses production-default checklist decomposition
- the fake agent pool does not return non-empty `decomposedItems`
- jobs block in `prepare_task` with
  `checklist decomposition failed: decomposed items invalid: decomposedItems must be a non-empty array`

The later full `npm test` stage passed its node suites because the standard test
runner disables checklist decomposition for fake-agent tests. This mismatch is
the current release-gate defect: the authoritative P0/P1 runner and the standard
test runner do not exercise equivalent checklist-decomposition behavior.

## Required Follow-Up Gates

- Split diagnostic type checking from emit/build checking.
- Add a strict-engine type gate and a type-debt guard.
- Make P0/P1 focused tests either use an explicit deterministic checklist path
  or provide phase/prompt-sensitive decomposer responses.
- Add a separate contract E2E that keeps `CPB_CHECKLIST_DECOMPOSE` enabled and
  proves the decomposer, artifact index, completion gate, isolation boundary,
  and dry-run finalizer path.
- Keep live GitHub PR creation opt-in and non-merging by default.
- Use `docs/product/cpb-flagship-validation-gate.md` as the product gate for
  GitHub Issue -> evidence-backed draft PR dry-run validation.

## Remediation Checkpoint 1

This checkpoint establishes the first stabilization gates:

- `noEmitOnError` is enabled in `tsconfig.node.json`.
- `typecheck:type-debt:engine` guards against new broad type debt in
  `core/engine`.
- `verify:p0p1` focused tests run through `scripts/run-node-tests.js`, so
  fake-agent deterministic tests consistently use the standard
  `CPB_CHECKLIST_DECOMPOSE=0` test isolation.
- stale focused P0/P1 entries for removed integration tests were replaced with
  the current `tests/integration/fake-acp-smoke.test.js`.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build` | pass |
| `npm run typecheck` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `node --test dist-tests/tests/type-debt-guard.test.js dist-tests/tests/verify-p0p1-runner.test.js` | pass |
| `npm run verify:p0p1` | pass |

## Remediation Checkpoint 2

This checkpoint closes the first dry-run finalizer and CI gate blockers raised by
the six adversarial review rounds:

- managed-worker assignment finalization defaults to `dry-run`
- live PR mode requires explicit metadata opt-in (`allowLiveFinalize`,
  `liveFinalize`, `finalize.allowLive`, or `finalizer.allowLive`)
- dry-run finalization does not fetch a push token or install a PR transport
- auto-finalizer dry-run exercises the draft PR request/body builder
- PR preview/open requires materialized completion-gate `outcome: "complete"`
  and materialized verdict `status: "pass"`
- missing completion-gate evidence or non-PASS verdict blocks finalization instead
  of hardcoding `PASS`
- dry-run rejects dirty source checkouts without `git stash` mutation
- dry-run reports protected diffs without requeueing or updating Hub queue state
- CI now runs `npm run typecheck:type-debt:engine`
- `npm run verify:release-gate` refuses `CPB_CHECKLIST_DECOMPOSE=0` and avoids
  `scripts/run-node-tests.js`
- `docs/product/cpb-flagship-validation-gate.md` defines the flagship product
  validation evidence and live-mode rule

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:tests && node --test dist-tests/tests/assignment-finalizer.test.js dist-tests/tests/auto-finalizer.test.js` | pass |
| `npm run build:tests && node --test dist-tests/tests/type-debt-guard.test.js` | pass |
| `npm run build:tests && node --test dist-tests/tests/release-gate-runner.test.js` | pass |
| `npm run verify:release-gate` | pass, 34 release-gate checks |
| `npm run typecheck` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass |
| `git diff --check` | pass |

## Remediation Checkpoint 3

This checkpoint establishes the first strict execution-kernel type gate:

- `typecheck:strict:engine` runs `tsc -p tsconfig.strict-engine.json --noEmit`.
- CI runs the strict-engine gate after the normal node typecheck.
- The initial strict scope covers `core/engine/completion-gate.ts` and its direct
  checklist dependency `core/workflow/acceptance-checklist.ts`.
- `completion-gate.ts` now exposes typed completion-gate input/output contracts
  instead of broad `AnyRecord` at its public boundary.
- `acceptance-checklist.ts` has explicit Set/ref narrowing needed by strict mode.
- The type-debt allowlist no longer includes `core/engine/completion-gate.ts`;
  allowlisted broad type occurrences in `core/engine` dropped from 92 to 77.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run typecheck:strict:engine` | pass |
| `npm run build:tests && node --test dist-tests/tests/strict-engine-gate.test.js dist-tests/tests/completion-gate.test.js dist-tests/tests/checklist-completion-gate.test.js dist-tests/tests/checklist-attempt-boundary.test.js` | pass, 65 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:release-gate` | pass, 34 release-gate checks |

## Remediation Checkpoint 4

This checkpoint starts execution-kernel slimming with a bounded provider handoff
seam:

- provider resolution, fallback-candidate selection, and provider preflight now
  live in `core/engine/provider-handoff.ts` instead of the tail of
  `core/engine/run-job.ts`
- `run-job.ts` dropped from 2384 to 2285 lines while preserving the existing
  `runJobInner` behavior surface
- `tests/provider-handoff.test.ts` directly covers the extracted helper seam
  for missing availability services, preferred-provider fallback, all-provider
  unavailable, and legacy agent/provider-key selection
- `core/engine/provider-handoff.ts` is included in the strict-engine type gate
- `scripts/verify-p0-p1.ts` now includes `tests/provider-handoff.test.js` in
  the focused P0/P1 gate
- the type-debt allowlist tightened `core/engine/run-job.ts` `AnyRecord`
  occurrences from 71 to 67; total allowlisted `core/engine` occurrences
  dropped from 77 to 73

Remaining execution-kernel debt after this checkpoint:

- `runJobInner` still spans the main phase orchestration loop and remains the
  next split target
- mid-run quota fallback remained in `run-job.ts` at this checkpoint; it is
  extracted in Remediation Checkpoint 6
- DAG execution is still sequential despite the contract being DAG-shaped

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build && npm run build:tests && node dist/scripts/run-node-tests.js tests/provider-handoff.test.js tests/engine-provider-event.test.js tests/verify-p0p1-runner.test.js` | pass, 28 checks |
| `npm run build && npm run build:tests && node dist/scripts/run-node-tests.js tests/strict-engine-gate.test.js tests/provider-handoff.test.js tests/engine-provider-event.test.js` | pass, 28 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 153 focused unit checks, 2 fake ACP smoke checks, 7 managed-worker isolated checks, CLI smoke |
| `npm run verify:release-gate` | pass, 34 release-gate checks |

## Remediation Checkpoint 5

This checkpoint upgrades the release gate from component-level finalizer
contracts to a managed-worker dry-run PR preview E2E:

- `tests/integration/managed-worker.test.ts` now covers an evidence-backed
  managed-worker run with `autoFinalize: true`
- the E2E exercises isolated worktree creation, fake ACP plan/execute/verify,
  acceptance checklist artifacts, completion gate, assignment finalization, and
  dry-run draft PR request generation
- the dry-run result asserts no push/live PR path is planned and verifies the PR
  request contains `repo`, `head`, `draft`, completion-gate evidence, and verdict
  evidence
- `server/services/pr-body.ts` renders a `## Completion Gate` section in the PR
  body instead of forcing maintainers to infer completion status from artifact
  links
- `scripts/verify-release-gate.ts` runs the E2E with Node's native test runner
  and `--test-name-pattern`, preserving the release gate rule that it must not
  use `scripts/run-node-tests.js` or `CPB_CHECKLIST_DECOMPOSE=0`

Remaining product-validation debt after this checkpoint:

- the automated gate still uses fake ACP responses, not live coding agents
- the manual gate with 3 unfamiliar maintainers or teams is still required
  before calling the flagship product path validated
- live draft PR creation remains intentionally untested by default because live
  mode is opt-in and side-effectful

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build && npm run build:tests && node dist/scripts/run-node-tests.js tests/integration/managed-worker.test.js` | pass, 8 managed-worker checks |
| `npm run build && npm run build:tests && node --test dist-tests/tests/release-gate-runner.test.js` | pass |
| `npm run verify:release-gate` | pass, 34 contract checks + 1 managed-worker dry-run PR preview E2E |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 153 focused unit checks, 2 fake ACP smoke checks, 8 managed-worker isolated checks, CLI smoke |

## Remediation Checkpoint 6

This checkpoint extracts mid-run quota fallback from the main execution loop:

- `core/engine/provider-quota-fallback.ts` owns the retry loop for retryable
  `AGENT_RATE_LIMITED` phase failures
- the extracted module marks failed providers unavailable through the delegate,
  selects fallback providers through the provider handoff seam, emits
  `provider_handoff`/`provider_quota_blocked` telemetry, builds execute-phase
  handoff context, and retries the phase through injected dependencies
- `run-job.ts` now passes `runPhase` and `generateHandoffBundle` into the
  extracted module instead of keeping quota fallback logic inline
- `tests/provider-quota-fallback.test.ts` directly covers delegate writes,
  fallback selection, provider attempts, handoff state mutation, progress/event
  telemetry, and retry source context
- `core/engine/provider-quota-fallback.ts` is included in the strict-engine type
  gate without adding new broad-type allowlist entries
- `run-job.ts` dropped from 2285 to 2063 lines in this stabilization worktree
- the type-debt allowlist tightened `core/engine/run-job.ts` `AnyRecord`
  occurrences from 67 to 61; total allowlisted `core/engine` occurrences
  dropped from 73 to 67

Remaining execution-kernel debt after this checkpoint:

- `runJobInner` still owns the main phase orchestration loop and remains the
  next split target
- phase retry and feedback retry loops still live in `run-job.ts`; they are
  extracted in Remediation Checkpoint 7
- DAG execution is still sequential despite the contract being DAG-shaped

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build && npm run build:tests && node dist/scripts/run-node-tests.js tests/provider-quota-fallback.test.js tests/engine-provider-event.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 26 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:release-gate` | pass, 34 contract checks + 1 managed-worker dry-run PR preview E2E |
| `npm run verify:p0p1` | pass, 154 focused unit checks, 2 fake ACP smoke checks, 8 managed-worker isolated checks, CLI smoke |

## Remediation Checkpoint 7

This checkpoint extracts phase retry and feedback retry loops from the main
execution loop:

- `core/engine/phase-retry.ts` owns transient phase retry and validation feedback
  retry behavior
- the extracted module preserves runtime env handling for
  `CPB_PHASE_RETRY_BASE_DELAY_MS`, emits `phase_retry` and
  `phase_feedback_retry` telemetry, skips quota-delegate write failures, and
  appends feedback context for artifact/contract validation retries
- `run-job.ts` now delegates retry behavior through injected `runPhase` instead
  of keeping retry loops inline
- `tests/phase-retry.test.ts` directly covers retry delay, retry source context,
  feedback retry context, and quota-delegate retry suppression
- `core/engine/phase-retry.ts` is included in the strict-engine type gate without
  adding new broad-type allowlist entries
- `run-job.ts` dropped from 2063 to 1898 lines in this stabilization worktree
- the type-debt allowlist tightened `core/engine/run-job.ts` `AnyRecord`
  occurrences from 61 to 59; total allowlisted `core/engine` occurrences
  dropped from 67 to 65

Remaining execution-kernel debt after this checkpoint:

- `runJobInner` still owns the main phase orchestration loop and remains the
  next split target
- provider preflight, quota fallback, and retry logic are now extracted, but
  phase start/result, scope guard, poisoned-session checks, usage recording, and
  completion still live in the main loop
- DAG execution is still sequential despite the contract being DAG-shaped

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build && npm run build:tests && node dist/scripts/run-node-tests.js tests/phase-retry.test.js tests/engine-provider-event.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 28 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:release-gate` | pass, 34 contract checks + 1 managed-worker dry-run PR preview E2E |
| `npm run verify:p0p1` | pass, 157 focused unit checks, 2 fake ACP smoke checks, 8 managed-worker isolated checks, CLI smoke |

## Remediation Checkpoint 8

This checkpoint addresses the second adversarial validation pass after the first
execution-kernel extractions. The six review lanes found blocking issues in
default finalization safety, type-debt drift prevention, P0/P1 stale test paths,
and the proposed scope-guard extraction boundary.

Changes made in this checkpoint:

- `finalizeSuccessfulQueueEntry` now defaults direct calls to `dry-run`.
- live finalizer modes (`local`, `remote`, `pr`) require explicit lower-level
  `allowLiveFinalize`/`allowLive` opt-in before any Git merge, push, PR, or issue
  close path can run.
- `openDraftPullRequest` now defaults to dry-run and requires explicit
  `allowLive` before preparing/pushing a branch or creating a PR.
- `assignment-finalizer.ts` passes the live opt-in decision down to the
  auto-finalizer, so the worker-level policy and service-level side-effect
  boundary agree.
- `managed-worker.ts` no longer commits uncommitted worktree changes before
  finalization; dry-run PR preview now proves `worktreeHead === sourceHead`.
- `scope-guard.ts` gained a strict-checked pure `evaluateScopeGuard` helper for
  changed-file cleaning and scope comparison; job lifecycle side effects remain
  in `run-job.ts`.
- `scripts/verify-p0-p1.ts` now preflights focused test path existence and the
  stale entries found by review were replaced with existing tests covering
  finalizer safety, PR dry-run behavior, scope guard, strict-engine, type-debt,
  and the runner itself.
- P0/P1 focused-test preflight now short-circuits before `git diff`, test
  runner, or smoke commands when files are missing, so stale paths fail fast
  with a clear missing-file list.
- `scripts/type-debt-guard.ts` now scans `core/engine` plus strict-engine
  includes outside that directory, and fails on stale/inflated allowlist counts
  as well as newly increased counts.
- `tests/strict-engine-gate.test.ts` now requires new engine modules to be either
  strict-checked or explicitly listed as legacy exclusions.

Checkpoint 25 stabilization metrics at the time:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1895 |
| `runJobInner` span | `core/engine/run-job.ts:858-1821` |
| `runJobInner` line count | 964 |
| `core/engine` allowlisted broad type occurrences | 65 |
| strict-scope total allowlisted broad type occurrences | 114 |

Adversarial validation status:

- Round 1, finalizer safety: initially FAIL; fixed with default dry-run,
  lower-level live opt-in, PR helper dry-run default, and managed-worker
  no-precommit evidence.
- Round 3, scope-guard boundary: initially FAIL for a wholesale orchestration
  extraction; fixed by extracting only pure comparison logic into
  `scope-guard.ts`.
- Round 4, strict/type-debt drift: initially FAIL; fixed by strict include
  coverage checks, strict `scope-guard.ts`, wider type-debt scan scope, and stale
  allowlist failure.
- Round 5, P0/P1 coverage: initially FAIL; fixed by focused-test path preflight
  and replacing missing test paths with existing focused tests.
- Round 6, product/documentation claims: PASS; no blocker overclaim found.
- Replacement Round 2, production-default release/E2E review: PASS by source
  inspection; `verify-release-gate` rejects `CPB_CHECKLIST_DECOMPOSE=0`, avoids
  `scripts/run-node-tests.js`, and runs the managed-worker dry-run PR preview
  E2E by test-name pattern.

Remaining debt after this checkpoint:

- `runJobInner` is still too large and owns phase start/result, poisoned-session
  checks, usage recording, and completion handling.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/scope-guard.test.js tests/github-draft-pr.test.js tests/auto-finalizer.test.js tests/assignment-finalizer.test.js tests/type-debt-guard.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 23 checks |
| `node --test dist/tests/integration/managed-worker.test.js` | pass, 8 managed-worker checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 180 focused unit checks, 2 fake ACP smoke checks, 8 managed-worker isolated checks, CLI smoke |
| `npm run verify:release-gate` | pass, 35 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 9

This checkpoint continues execution-kernel slimming by extracting the
poisoned-session post-phase gate from the main run loop:

- `core/engine/poisoned-session-gate.ts` now owns the artifact read,
  `classifyPoisonedSession` invocation, `phase_poisoned_session` event emission,
  and conversion from a passed phase result to a `POISONED_SESSION` failed phase
  result.
- The extraction preserves the existing fail-closed behavior where unreadable
  artifact content is classified from empty output and can become semantic
  inactivity.
- `run-job.ts` now delegates poisoned-session evaluation through the strict
  module instead of dynamically importing the classifier and reading artifacts
  inline.
- `tests/poisoned-session-gate.test.ts` covers skip behavior, invalid-request
  poisoning, event payload shape, failed phase result shape, and unreadable
  artifact fail-closed behavior.
- Existing `tests/engine-run-job.test.ts` poisoned-session integration coverage
  still passes against the real run-job call site.
- `core/engine/poisoned-session-gate.ts` is included in the strict-engine type
  gate without adding new broad-type allowlist entries.
- `scripts/verify-p0-p1.ts` now includes
  `tests/poisoned-session-gate.test.js` in the focused P0/P1 gate.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1860 |
| `runJobInner` span | `core/engine/run-job.ts:858-1786` |
| `runJobInner` line count | 929 |
| `core/engine` allowlisted broad type occurrences | 65 |
| strict-scope total allowlisted broad type occurrences | 114 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start/result events, provider usage recording,
  DAG node failure shaping, checklist artifact loading, runtime-failure
  recording, and completion-gate handling.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/poisoned-session-gate.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 37 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 183 focused unit checks, 2 fake ACP smoke checks, 8 managed-worker isolated checks, CLI smoke |
| `npm run verify:release-gate` | pass, 35 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 10

This checkpoint extracts provider usage recording from the main run loop:

- `core/engine/provider-usage-recorder.ts` now owns phase usage normalization,
  provider adapter metadata lookup, quota/fallback payload shaping, and
  best-effort delegate usage writes.
- `run-job.ts` now keeps the original call position immediately after
  `phase_result`, but delegates the payload construction and write failure
  swallowing to the strict module.
- `tests/provider-usage-recorder.test.ts` locks the hard-gate zero-call usage
  record, missing delegate/hub skip behavior, passed-phase payload shape,
  rate-limit fallback payload shape, and delegate write failure swallowing.
- `core/engine/provider-usage-recorder.ts` is included in
  `tsconfig.strict-engine.json` and the strict-engine coverage guard.
- `scripts/verify-p0-p1.ts` and `scripts/verify-release-gate.ts` both run the
  provider usage recorder regression test.
- `scripts/type-debt-allowlist.json` was reduced for `run-job.ts`; no new broad
  type allowance was added for the extracted module.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1782 |
| `runJobInner` span | `core/engine/run-job.ts:829-1700` |
| `runJobInner` line count | 872 |
| `core/engine` allowlisted broad type occurrences | 63 |
| strict-scope total allowlisted broad type occurrences | 112 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start/result events, DAG node failure shaping,
  checklist artifact loading, runtime-failure recording, and completion-gate
  handling.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/provider-usage-recorder.test.js tests/engine-provider-event.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 62 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 188 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 40 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 11

This checkpoint extracts the main phase-loop DAG node failure handler:

- `core/engine/dag-node-failure.ts` now owns failed phase event emission,
  `failJob` payload shaping, safe progress reporting, and failed `JobResult`
  construction for the standard post-`phase_result` failure path.
- Verification failures still return the narrowed retry verdict/artifact cause
  while `failJob` receives the original failure plus `nodeId`, preserving retry
  and materialization semantics.
- Malformed failed phase results still fall back to `fatal`/`<phase> phase
  failed` for persisted failure events and job-store failure payloads.
- `tests/dag-node-failure.test.ts` locks the normal verification-failure path
  and malformed-result fallback behavior.
- `core/engine/dag-node-failure.ts` is included in strict-engine coverage, P0/P1
  focused tests, and the production-default release contract gate.
- `scripts/type-debt-allowlist.json` was reduced again for `run-job.ts`; the new
  strict module adds no broad type allowance.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1736 |
| `runJobInner` span | `core/engine/run-job.ts:812-1654` |
| `runJobInner` line count | 843 |
| `core/engine` allowlisted broad type occurrences | 62 |
| strict-scope total allowlisted broad type occurrences | 111 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start/result events, the separate scope-guard
  failure branch, checklist artifact loading, runtime-failure recording, and
  completion-gate handling.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/dag-node-failure.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 36 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 190 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 42 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 12

This checkpoint extracts execute retry scope-guard orchestration from the main
run loop:

- `core/engine/scope-guard-runner.ts` now owns execute-only fix-scope discovery,
  changed-file extraction, `scope_guard_evaluated` event emission,
  `scope_guard_violation` progress reporting, the scope-violation failure
  event/job failure payload, and failed `JobResult` construction.
- `core/engine/scope-guard.ts` remains the pure path-comparison module; the new
  runner imports it instead of mixing I/O and comparison logic into the pure
  helper.
- `run-job.ts` delegates the post-retry scope guard check before `phaseResults`
  mutation, preserving the original event order and failure short-circuit.
- `tests/scope-guard-runner.test.ts` covers violation handling, pass-through
  `scope_guard_evaluated` behavior, and skip behavior for non-execute/no-scope
  paths.
- `core/engine/scope-guard-runner.ts` is included in strict-engine coverage,
  P0/P1 focused tests, and the production-default release contract gate.
- The new strict module adds no broad type allowance.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1667 |
| `runJobInner` span | `core/engine/run-job.ts:811-1585` |
| `runJobInner` line count | 775 |
| `core/engine` allowlisted broad type occurrences | 62 |
| strict-scope total allowlisted broad type occurrences | 111 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start/result events, side artifact event
  emission, checklist artifact loading, runtime-failure recording, and
  completion-gate handling.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/scope-guard-runner.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 37 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 193 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 45 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 13

This checkpoint extracts runtime artifact event shaping from the execution
kernel:

- `core/engine/runtime-artifact-events.ts` now owns the `artifact_created` event
  payload and diagnostics side-artifact filtering.
- `run-job.ts` delegates both acceptance-checklist artifact event emission and
  per-phase diagnostics artifact event emission to the strict helper.
- Diagnostics artifact emission still skips the primary phase artifact and keeps
  side artifacts event-indexed before `phase_result`, preserving completion-gate
  and audit discovery semantics.
- `tests/runtime-artifact-events.test.ts` locks the artifact event payload shape,
  primary-artifact skip rule, malformed diagnostics filtering, attemptId, and
  `sha256` fallback behavior.
- `core/engine/runtime-artifact-events.ts` is included in strict-engine
  coverage, P0/P1 focused tests, and the production-default release contract
  gate.
- `scripts/type-debt-allowlist.json` was reduced again for `run-job.ts`; the new
  strict module adds no broad type allowance.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1664 |
| `runJobInner` span | `core/engine/run-job.ts:805-1582` |
| `runJobInner` line count | 778 |
| `core/engine` allowlisted broad type occurrences | 60 |
| strict-scope total allowlisted broad type occurrences | 109 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start/result events, successful phase
  completion, checklist artifact loading, runtime-failure recording, and
  completion-gate handling.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/runtime-artifact-events.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 36 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 195 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 47 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 14

This checkpoint extracts runtime failure collection and event recording from the
completion-gate prelude:

- `core/engine/runtime-failure-recorder.ts` now owns active-run runtime failure
  collection from phase results and `runtime_failure_recorded` event emission.
- It preserves the existing source-of-truth strategy: active runs collect from
  `phaseResults`, emit events before gate evaluation, and allow replay/audit to
  consume materialized runtime failures from the event log later.
- `tests/runtime-failure-recorder.test.ts` locks poisoned-session, runjob-panic,
  diagnostic poisoned-session, duplicate diagnostic suppression, and event
  attemptId fallback behavior.
- `run-job.ts` delegates collection and event emission immediately before
  artifact-invalid and completion-gate evaluation.
- `core/engine/runtime-failure-recorder.ts` is included in strict-engine
  coverage, P0/P1 focused tests, and the production-default release contract
  gate.
- `scripts/type-debt-allowlist.json` was reduced again for `run-job.ts`; the new
  strict module adds no broad type allowance.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1620 |
| `runJobInner` span | `core/engine/run-job.ts:806-1538` |
| `runJobInner` line count | 733 |
| `core/engine` allowlisted broad type occurrences | 59 |
| strict-scope total allowlisted broad type occurrences | 108 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start/result events, successful phase
  completion, checklist artifact loading, artifact-invalid completion failure,
  and completion-gate handling.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/runtime-failure-recorder.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 36 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 197 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 49 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 15

This checkpoint extracts the artifact-invalid completion failure branch from the
execution kernel:

- `core/engine/completion-failure.ts` now owns the fail-closed result path for
  invalid completion artifacts.
- The helper preserves the existing `completion_gate_evaluated` audit event,
  `completion_gate_blocked` progress event, `failJob` payload, and returned
  failed job result shape.
- Progress callback failures remain non-fatal, matching the execution kernel's
  existing best-effort progress behavior.
- `run-job.ts` delegates the artifact-invalid branch after active-run runtime
  failures are recorded and before normal completion-gate evaluation.
- `tests/completion-failure.test.ts` locks the event, progress, failJob, result,
  and progress-failure behavior without adding broad `any` debt.
- `core/engine/completion-failure.ts` is included in strict-engine coverage,
  P0/P1 focused tests, and the production-default release contract gate.
- `scripts/type-debt-allowlist.json` was reduced again for `run-job.ts`; the new
  strict module adds no broad type allowance.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1605 |
| `core/engine/completion-failure.ts` line count | 81 |
| `runJobInner` span | `core/engine/run-job.ts:807-1523` |
| `runJobInner` line count | 717 |
| `core/engine` allowlisted broad type occurrences | 58 |
| strict-scope total allowlisted broad type occurrences | 107 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start/result events, successful phase
  completion, checklist artifact loading, and non-artifact-invalid
  completion-gate handling.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/completion-failure.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 36 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 199 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 51 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 16

This checkpoint extracts the non-artifact-invalid completion gate failure branch
from the execution kernel:

- `core/engine/completion-failure.ts` now owns checklist/adversarial completion
  gate failure routing, failJob payload construction, retryability, persisted
  retry scope, and returned failed job result shape.
- The helper preserves the existing separation where `run-job.ts` emits
  `completion_gate_evaluated` before failure handling, while the helper owns the
  `completion_gate_blocked` progress event and terminal failure payload.
- Checklist failures still persist `routingAction`, `routingRetryPhase`,
  `fixScope`, `checklistVerdict`, and `targetChecklistIds`, so retry
  reconciliation can rebuild the intended scope.
- Adversarial failures still reconstruct `retryContext` from the
  `adversarial_verify` phase, with risk-map and execute-artifact fallback scope.
- `tests/completion-failure.test.ts` now locks both checklist routing metadata
  and adversarial retry context behavior.
- `scripts/type-debt-allowlist.json` was reduced again for `run-job.ts`; the
  strict helper and its tests add no broad `any` debt.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1522 |
| `core/engine/completion-failure.ts` line count | 226 |
| `runJobInner` span | `core/engine/run-job.ts:768-1440` |
| `runJobInner` line count | 673 |
| `core/engine` allowlisted broad type occurrences | 49 |
| strict-scope total allowlisted broad type occurrences | 98 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start/result events, successful phase
  completion, checklist artifact loading, and successful completion finalization.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/completion-failure.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 38 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 201 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 53 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 17

This checkpoint extracts successful completion finalization from the execution
kernel:

- `core/engine/completion-success.ts` now owns the success-path progress order,
  `completeJob` invocation, and returned completed job result shape.
- `run-job.ts` still evaluates the completion gate and emits
  `completion_gate_evaluated`, then delegates the success tail after the gate
  returns `complete`.
- The helper preserves the existing progress sequence:
  `completion_gate_passed` before `completeJob`, then `job_completed` after
  `completeJob`.
- Progress callback failures remain best-effort and do not skip `completeJob` or
  change the returned success result.
- `tests/completion-success.test.ts` locks the success event order, completeJob
  call arguments, returned result shape, and progress-failure behavior.
- `core/engine/completion-success.ts` is included in strict-engine coverage,
  P0/P1 focused tests, and the production-default release contract gate.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1519 |
| `core/engine/completion-success.ts` line count | 54 |
| `runJobInner` span | `core/engine/run-job.ts:769-1437` |
| `runJobInner` line count | 669 |
| `core/engine` allowlisted broad type occurrences | 49 |
| strict-scope total allowlisted broad type occurrences | 98 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start/result events and checklist artifact
  loading.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/completion-success.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 36 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 203 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 55 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 18

This checkpoint extracts completion checklist artifact loading from the
execution kernel:

- `core/engine/completion-checklist-artifacts.ts` now owns loading
  event-visible checklist gate inputs from the artifact index.
- The helper preserves the checklist-first vs legacy distinction:
  checklist-first jobs are anchored by an `acceptance-checklist` artifact, while
  legacy jobs without that anchor skip checklist gate inputs and fall back to
  legacy verdict gates.
- Anchored checklist jobs still fail closed when any required checklist artifact
  is missing, broken, unreadable, invalid JSON, or owned by the wrong attempt.
- Artifact index read failures still become `artifactInvalidReason` values that
  block completion before normal gate evaluation.
- `tests/completion-checklist-artifacts.test.ts` locks legacy skip, active
  artifact loading, incomplete artifact fail-closed behavior, and artifact index
  read failure handling using real temporary JSON artifacts and the production
  `readActiveChecklistArtifacts` helper.
- `scripts/type-debt-allowlist.json` was reduced again for `run-job.ts`; the new
  strict helper and its tests add no broad `any` debt.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1490 |
| `core/engine/completion-checklist-artifacts.ts` line count | 94 |
| `runJobInner` span | `core/engine/run-job.ts:769-1408` |
| `runJobInner` line count | 640 |
| `core/engine` allowlisted broad type occurrences | 47 |
| strict-scope total allowlisted broad type occurrences | 96 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start/result events and the sequential DAG
  execution loop.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/completion-checklist-artifacts.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 38 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 207 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 59 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 19

This checkpoint extracts phase-result event emission from the execution kernel:

- `core/engine/phase-result-events.ts` now owns the durable `phase_result`
  event payload and matching progress payload for completed phase attempts.
- The helper preserves event fields consumed by projection and audit consumers:
  phase, agent, status, artifact, prompt artifact, ACP audit file, usage, and
  normalized failure kind/reason/cause.
- Progress callback failures remain best-effort and do not affect the already
  written durable phase-result event.
- `run-job.ts` still owns phase execution ordering, provider usage recording,
  and failure routing, but delegates the event/progress payload construction.
- `tests/phase-result-events.test.ts` locks failed-result payload shape and
  progress failure behavior.
- `core/engine/phase-result-events.ts` is included in strict-engine coverage,
  P0/P1 focused tests, and the production-default release contract gate.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1474 |
| `core/engine/phase-result-events.ts` line count | 92 |
| `runJobInner` span | `core/engine/run-job.ts:770-1392` |
| `runJobInner` line count | 623 |
| `core/engine` allowlisted broad type occurrences | 47 |
| strict-scope total allowlisted broad type occurrences | 96 |

Remaining debt after this checkpoint:

- `runJobInner` still owns phase start events, DAG node completion events, and
  the sequential DAG execution loop.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/phase-result-events.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 36 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 209 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 61 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 20

This checkpoint extracts phase-start lifecycle event emission from the execution
kernel:

- `core/engine/phase-start-events.ts` now owns the durable `phase_started`
  fallback event, `dag_node_started` event, and matching best-effort progress
  payload for phase entry.
- The helper preserves the existing split between stores with a native
  `startPhase` service and stores that require direct durable event append.
- `dag_node_started` still carries node id, phase, agent, attempt id, checklist
  ids, and the legacy attempt counter expected by DAG projection consumers.
- Progress callback failures remain best-effort and cannot block durable phase
  start event materialization.
- `run-job.ts` still owns DAG ordering, phase execution, provider usage, and
  node completion/failure routing, but delegates the start-event payload
  construction.
- `tests/phase-start-events.test.ts` locks fallback append behavior, native
  `startPhase` behavior, `dag_node_started` payload shape, and progress failure
  tolerance.
- `core/engine/phase-start-events.ts` is included in strict-engine coverage,
  P0/P1 focused tests, and the production-default release contract gate.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1454 |
| `core/engine/phase-start-events.ts` line count | 93 |
| `runJobInner` span | `core/engine/run-job.ts:771-1373` |
| `runJobInner` line count | 603 |
| `core/engine` allowlisted broad type occurrences | 47 |
| strict-scope total allowlisted broad type occurrences | 96 |

Remaining debt after this checkpoint:

- `runJobInner` still owns DAG node completion events and the sequential DAG
  execution loop.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/phase-start-events.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 36 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 211 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 63 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 21

This checkpoint extracts DAG node lifecycle event emission from the execution
kernel:

- `core/engine/dag-node-lifecycle-events.ts` now owns the durable
  `dag_node_skipped` and `dag_node_completed` event payloads.
- Resume skips still push the recovered passed phase result, emit
  `dag_node_skipped`, report best-effort progress, then continue without
  rerunning the completed node.
- Successful nodes still call `completePhase` before emitting
  `dag_node_completed`, preserving the previous ordering before
  `phase_result`.
- `dag_node_completed` still carries node id, phase, role, attempt id,
  artifact name, and checklist ids for DAG projection, resume, and checklist
  binding consumers.
- `tests/dag-node-lifecycle-events.test.ts` locks skip payload shape,
  completion payload shape, and progress failure tolerance.
- `core/engine/dag-node-lifecycle-events.ts` is included in strict-engine
  coverage, P0/P1 focused tests, and the production-default release contract
  gate.
- A read-only verifier subagent reviewed the slice and found no schema drift,
  ordering drift, progress drift, or gate omission.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1448 |
| `core/engine/dag-node-lifecycle-events.ts` line count | 113 |
| `runJobInner` span | `core/engine/run-job.ts:772-1367` |
| `runJobInner` line count | 596 |
| `core/engine` allowlisted broad type occurrences | 47 |
| strict-scope total allowlisted broad type occurrences | 96 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.
- parallel validators that rebuild `dist` in the same worktree can invalidate
  another running verification command's generated artifacts; release evidence
  should come from a single owner or isolated worktree.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:tests` before implementation | failed as expected: missing `../core/engine/dag-node-lifecycle-events.js` |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/dag-node-lifecycle-events.test.js tests/engine-run-job.test.js tests/dag-resume-contract.test.js tests/checklist-dag-binding.test.js` | pass, 49 checks |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/dag-node-lifecycle-events.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js && node dist/scripts/run-node-tests.js tests/release-gate-runner.test.js` | pass, 37 checks + 1 isolated runner check |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 214 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 66 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 22

This checkpoint extracts adversarial verdict event emission from the execution
kernel:

- `core/engine/adversarial-verdict-events.ts` now owns the durable
  `adversarial_verdict` event payload.
- The helper preserves the existing condition: only the `adversarial_verify`
  phase with a present `diagnostics.verdict` emits this event.
- The verdict object is preserved verbatim, while `status`, `reason`, and
  artifact name remain projected into top-level event fields for existing
  consumers.
- The event still occurs after successful DAG node completion and before
  `phase_result`, preserving the previous ordering.
- `tests/adversarial-verdict-events.test.ts` locks payload shape, non-adversarial
  phase skips, and missing-verdict skips.
- `core/engine/adversarial-verdict-events.ts` is included in strict-engine
  coverage, P0/P1 focused tests, and the production-default release contract
  gate.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1445 |
| `core/engine/adversarial-verdict-events.ts` line count | 52 |
| `runJobInner` span | `core/engine/run-job.ts:773-1364` |
| `runJobInner` line count | 592 |
| `core/engine` allowlisted broad type occurrences | 47 |
| strict-scope total allowlisted broad type occurrences | 96 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:tests` before implementation | failed as expected: missing `../core/engine/adversarial-verdict-events.js` |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/adversarial-verdict-events.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js && node dist/scripts/run-node-tests.js tests/release-gate-runner.test.js` | pass, 36 checks + 1 isolated runner check |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 216 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 68 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 23

This checkpoint extracts normal passed-phase artifact tracking from the
execution kernel:

- `core/engine/phase-artifact-tracker.ts` now owns the normal passed-phase
  `state.planId` / `state.deliverableId` updates and the matching
  `completePhase` call.
- The helper preserves the existing condition: it only runs for passed phase
  results with an artifact.
- Artifact ids still come from the suffix of hyphenated artifact names, with
  legacy `artifact.id` fallback for non-hyphenated artifact names.
- `completePhase` is still called with `{ phase, artifact: artifact.name }`
  before `dag_node_completed`, adversarial verdict events, and `phase_result`.
- Resume-completed-node artifact recovery remains inline and unchanged; that
  path updates state without re-completing an already completed phase.
- `tests/phase-artifact-tracker.test.ts` locks plan id extraction, execute
  deliverable id fallback, and failed/no-artifact no-op behavior.
- `core/engine/phase-artifact-tracker.ts` is included in strict-engine
  coverage, P0/P1 focused tests, and the production-default release contract
  gate.
- A read-only verifier subagent reviewed the slice and found no state tracking,
  `completePhase` payload/order, or gate wiring blocker.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1444 |
| `core/engine/phase-artifact-tracker.ts` line count | 55 |
| `runJobInner` span | `core/engine/run-job.ts:774-1363` |
| `runJobInner` line count | 590 |
| `core/engine` allowlisted broad type occurrences | 47 |
| strict-scope total allowlisted broad type occurrences | 96 |

Remaining debt after this checkpoint:

- `runJobInner` still owns resume-completed-node artifact recovery, the
  sequential DAG execution loop, and the surrounding phase orchestration.
- `extractArtifactId` now exists in both `run-job.ts` for resume recovery and
  `phase-artifact-tracker.ts` for normal passed phases; the logic matches today,
  but should be consolidated in a later small slice to prevent drift.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:tests` before implementation | failed as expected: missing `../core/engine/phase-artifact-tracker.js` |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/phase-artifact-tracker.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js && node dist/scripts/run-node-tests.js tests/release-gate-runner.test.js` | pass, 37 checks + 1 isolated runner check |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 219 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 71 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 24

This checkpoint consolidates artifact id extraction for normal passed phases and
resume-completed-node recovery:

- `core/engine/phase-artifact-tracker.ts` now exports
  `extractPhaseArtifactId`, the single helper used by both normal passed-phase
  tracking and `run-job.ts` resume artifact recovery.
- `run-job.ts` no longer carries a duplicate local `extractArtifactId`
  implementation.
- The helper preserves the previous behavior: hyphenated artifact names use the
  final suffix, non-hyphenated names fall back to legacy `artifact.id`, and
  missing names return `null`.
- `tests/phase-artifact-tracker.test.ts` now locks the shared extraction helper
  directly, in addition to the existing normal passed-phase state tracking tests.
- `scripts/type-debt-allowlist.json` was tightened because removing the local
  `run-job.ts` helper reduced `AnyRecord` usage from 41 to 40.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1438 |
| `core/engine/phase-artifact-tracker.ts` line count | 55 |
| `runJobInner` span | `core/engine/run-job.ts:768-1357` |
| `runJobInner` line count | 590 |
| `core/engine` allowlisted broad type occurrences | 46 |
| strict-scope total allowlisted broad type occurrences | 95 |

Remaining debt after this checkpoint:

- `runJobInner` still owns resume-completed-node control flow, the sequential DAG
  execution loop, and the surrounding phase orchestration.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:tests` before implementation | failed as expected: `extractPhaseArtifactId` was not exported |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/phase-artifact-tracker.test.js tests/engine-run-job.test.js tests/engine-prepare-task.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js && node dist/scripts/run-node-tests.js tests/release-gate-runner.test.js` | pass, 49 checks + 1 isolated runner check |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass after tightening `run-job.ts` `AnyRecord` allowlist from 41 to 40 |
| `npm run verify:p0p1` | pass, 220 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 72 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 25

This checkpoint extracts resume-completed-node handling from the execution
kernel:

- `core/engine/dag-node-resume.ts` now owns resumed node state updates,
  synthetic passed phase-result construction, and `dag_node_skipped` emission.
- The helper preserves artifact-backed state recovery for `planId` and
  `deliverableId` through the shared `extractPhaseArtifactId` helper.
- The helper preserves the skipped phase-result shape: schema version, phase,
  passed status, recovered artifact, recovered verdict, null failure, skip
  diagnostics, and created timestamp.
- The helper preserves `dag_node_skipped` event and progress payloads through the
  existing lifecycle-event helper.
- `run-job.ts` still computes recovered artifact and verdict from retry context,
  then calls the helper and continues before dynamic agent routing or phase
  execution.
- `tests/dag-node-resume.test.ts` locks artifact-backed resume, verdict
  preservation, event/progress payloads, and artifact-absent resume behavior.
- `core/engine/dag-node-resume.ts` is included in strict-engine coverage, P0/P1
  focused tests, and the production-default release contract gate.
- A read-only verifier subagent reviewed the slice and found no blocker in
  ordering, result shape, skip event/progress payloads, or gate wiring.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1423 |
| `core/engine/dag-node-resume.ts` line count | 76 |
| `runJobInner` span | `core/engine/run-job.ts:769-1342` |
| `runJobInner` line count | 574 |
| `core/engine` allowlisted broad type occurrences | 46 |
| strict-scope total allowlisted broad type occurrences | 95 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- the automated flagship path still uses fake ACP responses; the 3-maintainer or
  3-team manual product validation gate remains required before claiming product
  validation.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:tests` before implementation | failed as expected: missing `../core/engine/dag-node-resume.js` |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/dag-node-resume.test.js tests/engine-prepare-task.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js && node dist/scripts/run-node-tests.js tests/release-gate-runner.test.js` | pass, 47 checks + 1 isolated runner check |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 222 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 74 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 26

This checkpoint extracts phase-agent routing and incorporates six rounds of
read-only adversarial subagent validation:

- `core/engine/phase-agent-routing.ts` now owns dynamic-agent-plan selection,
  dynamic role normalization, routing fallback resolution, and the effective
  selected agent for a phase.
- `run-job.ts` no longer carries local dynamic-agent helpers. The phase loop now
  calls `resolvePhaseAgentRouting()` and passes the effective selected agent into
  `emitPhaseStartEvents()`, so `phase_started` and progress records match the
  agent used for execution.
- `tests/phase-agent-routing.test.ts` locks dynamic-agent precedence over routing
  fallback while still preserving the routing decision for audit events.
- `tests/engine-provider-event.test.ts` locks the production event path: dynamic
  executor selection is visible in `phase_started`.
- The release gate now includes `github-draft-pr.test.ts`, covering direct
  `openDraftPullRequest()` default dry-run behavior and explicit live opt-in at
  the lower-level PR helper boundary.
- `tests/release-gate-runner.test.ts` no longer runs `npm run build:node` inside
  the parallel unit suite. It validates the environment refusal path directly
  with Node type stripping, avoiding concurrent deletion/rebuild of `dist`.
- `finalizeSuccessfulQueueEntry()` now rejects dirty source checkouts in every
  mode instead of auto-stashing local operator state.
- Live PR finalization now rejects uncommitted worktree changes before opening or
  pushing a PR, preventing post-gate files from being swept into a live PR after
  completion evidence was generated.
- README and flagship-gate docs now describe the verified default as a draft PR
  dry-run preview. Live draft PR creation remains explicit opt-in and is not
  claimed as default product behavior.
- The flagship gate doc now states that `verify:release-gate` is the product-path
  gate and does not replace the separate typecheck, strict-engine, and type-debt
  gates required for stabilization PR evidence.

Adversarial validation outcome:

- Round 1 checked dynamic/routing behavior preservation and found no P0/P1/P2.
- Round 2 found release-gate coverage and phase-start event gaps; both were
  fixed and covered by tests.
- Round 3 found P2 architecture debts: poisoned-session result replacement in
  `phaseResults`, release-gate/type-gate wording, and scope-guard dependency
  direction. The wording gap is fixed here; the other two remain tracked debt.
- Round 4 found misleading README/live PR wording and stale metrics. The README
  claim is downgraded here; this checkpoint records current metrics.
- Round 5 found live finalizer safety risks around source auto-stash and live PR
  worktree cleanliness. Both are fixed with fail-closed tests.
- Round 6 found checklist-E2E and destructive-mode claim drift. Docs now
  distinguish production-default env posture plus decomposer contracts from a
  full worker-path decomposer E2E, and legacy `local`/`remote` destructive
  finalizers are explicitly outside the flagship gate.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1399 |
| `core/engine/phase-agent-routing.ts` line count | 127 |
| `runJobInner` span | `core/engine/run-job.ts:748-1318` |
| `runJobInner` line count | 571 |
| `core/engine` allowlisted broad type occurrences | 42 |
| strict-scope total allowlisted broad type occurrences | 91 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- at this checkpoint, the automated flagship path still used fake ACP responses
  and materialized checklist evidence in the worker E2E; the worker-path
  decomposer gap is closed in Remediation Checkpoint 28.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.
- legacy `local` and `remote` finalizers remain outside the flagship product
  gate and must not be claimed as validated by it.
- poisoned-session failure conversion still deserves a follow-up audit because
  the in-memory `phaseResults` list can preserve the pre-gate passed result even
  when the gate returns a failed result.
- `scope-guard-runner.ts` still imports checklist fix-scope normalization from
  the workflow layer; this is a boundary-cleanup candidate.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:tests` before implementation | failed as expected: missing `../core/engine/phase-agent-routing.js` |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/release-gate-runner.test.js tests/phase-agent-routing.test.js tests/engine-provider-event.test.js tests/auto-finalizer.test.js` after RED tests | failed as expected before fixes: missing `effectiveSelectedAgent`, missing `github-draft-pr` gate entry, and live finalizer returned `PR_FINALIZE_FAILED` instead of fail-closed source/worktree errors |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/release-gate-runner.test.js tests/phase-agent-routing.test.js tests/engine-provider-event.test.js tests/auto-finalizer.test.js` | pass, 36 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 228 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 81 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 27

This checkpoint closes the two execution-kernel P2 debts left by the
adversarial review:

- `run-job.ts` now replaces the just-recorded phase result after
  `evaluatePoisonedSessionGate()` runs. If a passed phase is converted into
  `FailureKind.POISONED_SESSION`, the returned `phaseResults` list now reflects
  the failed result instead of retaining the stale pre-gate passed result.
- `tests/engine-run-job.test.ts` locks this behavior in the full runJob path by
  asserting that poisoned plan output returns `phaseResults[0].status ===
  "failed"` and `phaseResults[0].failure.kind === "poisoned_session"`.
- `normalizeRepoRelativePaths()` and `normalizeFixScope()` now live in
  `core/engine/scope-guard.ts`, next to the execute scope guard logic.
- `scope-guard-runner.ts` now imports fix-scope normalization from the engine
  scope-guard module instead of depending on workflow checklist normalization.
- `core/workflow/acceptance-checklist.ts` re-exports the same normalizer so
  checklist contracts and execute scope guard keep identical repo-relative path
  semantics without the engine depending on workflow code for scope checks.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1401 |
| `core/engine/scope-guard.ts` line count | 153 |
| `core/engine/scope-guard-runner.ts` line count | 178 |
| `runJobInner` span | `core/engine/run-job.ts:748-1320` |
| `runJobInner` line count | 573 |
| `core/engine` allowlisted broad type occurrences | 42 |
| strict-scope total allowlisted broad type occurrences | 91 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- at this checkpoint, the automated flagship path still used fake ACP responses
  and materialized checklist evidence in the worker E2E; the worker-path
  decomposer gap is closed in Remediation Checkpoint 28.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.
- legacy `local` and `remote` finalizers remain outside the flagship product
  gate and must not be claimed as validated by it.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/engine-run-job.test.js tests/poisoned-session-gate.test.js` before implementation | failed as expected: poisoned session failure returned stale `phaseResults[0].status === "passed"` |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/engine-run-job.test.js tests/poisoned-session-gate.test.js tests/engine-provider-event.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 61 checks |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/scope-guard.test.js tests/scope-guard-runner.test.js tests/acceptance-checklist-contract.test.js tests/checklist-decomposer.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 72 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 228 focused node checks, 2 demo integration checks, 8 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 81 contract checks + 1 managed-worker dry-run PR preview E2E |

## Remediation Checkpoint 28

This checkpoint closes the worker-path checklist decomposer gap left by the
adversarial review:

- `tests/integration/managed-worker.test.ts` now includes a managed-worker E2E
  that does not inject `acceptanceChecklist`. The worker invokes the default
  checklist decomposition path, materializes the acceptance-checklist artifact,
  records evidence-ledger output, evaluates the checklist verdict, and completes
  the assignment.
- The fake ACP scenario now includes an explicit decomposition response for the
  worker path. The transcript assertion checks the production decomposition
  prompt marker, so the test fails if the worker skips decomposition.
- The E2E overrides `CPB_CHECKLIST_DECOMPOSE=1` for that isolated worker test
  because `scripts/run-node-tests.ts` intentionally defaults fake-agent suites to
  `CPB_CHECKLIST_DECOMPOSE=0` for deterministic legacy tests.
- `scripts/verify-release-gate.ts` now requires both managed-worker flagship
  E2Es: default checklist decomposition and dry-run draft PR preview.
- `tests/release-gate-runner.test.ts` locks the release-gate runner pattern so a
  future edit cannot silently drop either worker E2E branch.
- `README.md` and `docs/product/cpb-flagship-validation-gate.md` now describe
  worker-path checklist decomposition as covered by the automated flagship gate.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1401 |
| `tests/integration/managed-worker.test.ts` line count | 936 |
| `scripts/verify-release-gate.ts` line count | 88 |
| `runJobInner` span | `core/engine/run-job.ts:748-1320` |
| `runJobInner` line count | 573 |
| `core/engine` allowlisted broad type occurrences | 42 |
| strict-scope total allowlisted broad type occurrences | 91 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.
- legacy `local` and `remote` finalizers remain outside the flagship product
  gate and must not be claimed as validated by it.
- the flagship gate still uses fake ACP responses; a live provider or real ACP
  release rehearsal remains outside default automated CI.
- the stabilization cycle still needs the manual 3-maintainer/team product gate
  before claiming product maturity for unfamiliar teams.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/release-gate-runner.test.js tests/verify-p0p1-runner.test.js tests/integration/managed-worker.test.js` before final fix | failed as expected: the new managed-worker decomposer E2E failed until the fake ACP decomposition response and `CPB_CHECKLIST_DECOMPOSE=1` worker env were supplied |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/release-gate-runner.test.js tests/verify-p0p1-runner.test.js tests/integration/managed-worker.test.js` | pass, 4 runner checks + 9 managed-worker isolated checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 228 focused node checks, 2 demo integration checks, 9 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 81 contract checks + 2 managed-worker E2Es |

## Remediation Checkpoint 29

This checkpoint continues the execution-kernel cleanup by extracting the
post-phase completion-gate runner:

- `core/engine/completion-gate-runner.ts` now owns verdict extraction,
  completed-phase projection, checklist artifact loading, runtime failure event
  recording, completion-gate evaluation, and final success/failure dispatch.
- `run-job.ts` now delegates the post-phase completion path to
  `runCompletionGate()`, leaving `runJobInner` focused on job creation,
  task/DAG preparation, sequential phase execution, and phase-level failure
  handling.
- `tests/completion-gate-runner.test.ts` locks the new boundary for the
  successful completion path and the runtime-failure-before-gate event order.
- `tsconfig.strict-engine.json`, `tests/strict-engine-gate.test.ts`,
  `scripts/verify-p0-p1.ts`, and `scripts/verify-release-gate.ts` include the
  new runner, so it cannot drift outside strict checks or flagship gates.
- `tests/engine-prepare-task.test.ts` now stringifies the unknown failure reason
  before `assert.match()`, allowing `noEmitOnError` to keep catching test type
  mistakes without weakening the assertion.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/run-job.ts` line count | 1326 |
| `core/engine/completion-gate-runner.ts` line count | 158 |
| `tests/completion-gate-runner.test.ts` line count | 118 |
| `runJobInner` span | `core/engine/run-job.ts:744-1245` |
| `runJobInner` line count | 502 |
| `core/engine` allowlisted broad type occurrences | 42 |
| strict-scope total allowlisted broad type occurrences | 91 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still uses explicit legacy exclusions for older engine modules
  rather than full `core/engine` strict coverage.
- DAG execution is still sequential despite the contract being DAG-shaped.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.
- legacy `local` and `remote` finalizers remain outside the flagship product
  gate and must not be claimed as validated by it.
- the flagship gate still uses fake ACP responses; a live provider or real ACP
  release rehearsal remains outside default automated CI.
- the stabilization cycle still needs the manual 3-maintainer/team product gate
  before claiming product maturity for unfamiliar teams.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/completion-gate-runner.test.js tests/completion-checklist-artifacts.test.js tests/completion-failure.test.js tests/completion-success.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/release-gate-runner.test.js tests/verify-p0p1-runner.test.js` before final fixes | failed as expected: test compilation caught an `unknown` failure reason in `tests/engine-prepare-task.test.ts`, then the new runner test was corrected to assert the existing failure reason rather than changing production routing code |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/completion-gate-runner.test.js tests/completion-checklist-artifacts.test.js tests/completion-failure.test.js tests/completion-success.test.js tests/engine-run-job.test.js tests/strict-engine-gate.test.js tests/release-gate-runner.test.js tests/verify-p0p1-runner.test.js` | pass, 47 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 230 focused node checks, 2 demo integration checks, 9 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 83 contract checks + 2 managed-worker E2Es |

## Remediation Checkpoint 30

This checkpoint reduces the strict-mode migration backlog:

- `core/engine/session-pin.ts` now uses `Record<string, unknown>` for parsed
  process-registry JSON instead of `Record<string, any>`, while preserving its
  best-effort behavior for missing or malformed process files.
- `session-pin.ts` moved from the strict-engine legacy exclusion list into
  `tsconfig.strict-engine.json`.
- `scripts/type-debt-allowlist.json` no longer carries a
  `core/engine/session-pin.ts` broad-type allowance.
- `scripts/verify-p0-p1.ts` now includes `tests/job-recovery-hardening.test.js`,
  so the existing session-pin behavior tests run in the focused P0/P1 gate.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| `core/engine/session-pin.ts` line count | 63 |
| strict-engine legacy exclusions | 6 |
| `core/engine` allowlisted broad type occurrences | 41 |
| strict-scope total allowlisted broad type occurrences | 90 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still excludes `dag-builder.ts`, `phase-policy.ts`,
  `poisoned-session.ts`, `run-job.ts`, `run-phase.ts`, and
  `workflow-runner.ts`.
- DAG execution is still sequential despite the contract being DAG-shaped.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.
- legacy `local` and `remote` finalizers remain outside the flagship product
  gate and must not be claimed as validated by it.
- the flagship gate still uses fake ACP responses; a live provider or real ACP
  release rehearsal remains outside default automated CI.
- the stabilization cycle still needs the manual 3-maintainer/team product gate
  before claiming product maturity for unfamiliar teams.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/job-recovery-hardening.test.js tests/strict-engine-gate.test.js tests/type-debt-guard.test.js tests/verify-p0p1-runner.test.js` | pass, 45 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 265 focused node checks, 2 demo integration checks, 9 managed-worker isolated checks, CLI smoke; live/full skipped by default |

## Remediation Checkpoint 31

This checkpoint continues the strict-mode migration:

- `core/engine/phase-policy.ts` now has explicit result types for semantic
  phase resolution and phase-policy validation.
- `phase-policy.ts` and `core/engine/poisoned-session.ts` moved from the
  strict-engine legacy exclusion list into `tsconfig.strict-engine.json`.
- Pulling `phase-policy.ts` into strict exposed real dependency-boundary type
  gaps. `core/triage/schema.ts` now has explicit indexable rank/default maps and
  a non-null route candidate list; `core/workflow/definition.ts` normalizes
  nullable routing inputs and returns a safe DAG-node list; and
  `core/workflow/dag-executor.ts` handles unknown caught errors plus impossible
  missing-node lookups explicitly.
- `scripts/verify-p0-p1.ts` now includes `tests/dag-executor.test.js` and
  `tests/poisoned-session.test.js`, so the dependency fixes and classifier
  behavior are covered by the focused P0/P1 gate.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| strict-engine legacy exclusions | 4 |
| `core/engine/phase-policy.ts` line count | 88 |
| `core/engine/poisoned-session.ts` line count | 82 |
| `core/engine` allowlisted broad type occurrences | 41 |
| strict-scope total allowlisted broad type occurrences | 90 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still excludes `dag-builder.ts`, `run-job.ts`, `run-phase.ts`, and
  `workflow-runner.ts`.
- DAG execution is still sequential despite the contract being DAG-shaped.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.
- legacy `local` and `remote` finalizers remain outside the flagship product
  gate and must not be claimed as validated by it.
- the flagship gate still uses fake ACP responses; a live provider or real ACP
  release rehearsal remains outside default automated CI.
- the stabilization cycle still needs the manual 3-maintainer/team product gate
  before claiming product maturity for unfamiliar teams.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/workflow-definition-contract.test.js tests/dag-executor.test.js tests/poisoned-session.test.js tests/poisoned-session-gate.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` before dependency fixes | failed as expected: strict-engine exposed nullable route, workflow-DAG, and caught-error type gaps after adding `phase-policy.ts` |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/workflow-definition-contract.test.js tests/dag-executor.test.js tests/poisoned-session.test.js tests/poisoned-session-gate.test.js tests/strict-engine-gate.test.js tests/verify-p0p1-runner.test.js` | pass, 73 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 325 focused node checks, 2 demo integration checks, 9 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 83 contract checks + 2 managed-worker E2Es |

## Remediation Checkpoint 32

This checkpoint moves the final small engine helpers into strict mode:

- `core/engine/workflow-runner.ts` now has explicit string-array return types
  for plan-mode phase resolution and is included in `tsconfig.strict-engine.json`.
- `core/engine/dag-builder.ts` now has explicit DAG result, edge, adversarial
  insertion, and mutating-DAG validation result types, plus a narrow dependency
  filter type guard.
- `tests/dag-builder.test.ts` directly covers runtime phase projection,
  fallback unknown-phase chaining, adversarial verify insertion, and mutating-job
  verify validation.
- `scripts/verify-p0-p1.ts` now includes `tests/dag-builder.test.js`, so DAG
  builder behavior is part of the focused P0/P1 gate.
- The initial direct DAG-builder test expected filtered subset phases to create
  a new `execute -> verify` edge and repeated phases to receive suffixed IDs.
  The production builder does neither today, so the test was corrected to lock
  current behavior rather than silently changing DAG semantics during a strict
  migration.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| strict-engine legacy exclusions | 2 |
| `core/engine/dag-builder.ts` line count | 138 |
| `core/engine/workflow-runner.ts` line count | 30 |
| `tests/dag-builder.test.ts` line count | 72 |
| `core/engine` allowlisted broad type occurrences | 41 |
| strict-scope total allowlisted broad type occurrences | 90 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still excludes `run-job.ts` and `run-phase.ts`.
- DAG execution is still sequential despite the contract being DAG-shaped.
- DAG projection still drops dependencies outside the filtered phase list and
  does not yet normalize repeated phase IDs; this is now explicitly covered as
  current behavior and should be revisited before enabling real parallel DAG
  execution.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.
- legacy `local` and `remote` finalizers remain outside the flagship product
  gate and must not be claimed as validated by it.
- the flagship gate still uses fake ACP responses; a live provider or real ACP
  release rehearsal remains outside default automated CI.
- the stabilization cycle still needs the manual 3-maintainer/team product gate
  before claiming product maturity for unfamiliar teams.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/dag-builder.test.js tests/workflow-definition-contract.test.js tests/dag-executor.test.js tests/strict-engine-gate.test.js tests/type-debt-guard.test.js tests/verify-p0p1-runner.test.js` before test correction | failed as expected: the new direct DAG-builder test assumed new dependency edges and suffixed repeated phase IDs that production does not currently create |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/dag-builder.test.js tests/workflow-definition-contract.test.js tests/dag-executor.test.js tests/strict-engine-gate.test.js tests/type-debt-guard.test.js tests/verify-p0p1-runner.test.js` | pass, 65 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 329 focused node checks, 2 demo integration checks, 9 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 83 contract checks + 2 managed-worker E2Es |

## Remediation Checkpoint 33

This checkpoint moves the phase adapter boundary into strict mode:

- `core/engine/run-phase.ts` now has a typed phase context, adapter cache,
  ACP release pool shape, and unknown-error handling path instead of broad
  `Record<string, any>` boundaries.
- Pool exhaustion is still rethrown so queue/provider backpressure semantics
  remain unchanged, while normal adapter failures still materialize as failed
  phase results with safe stringified reason/stack data.
- `tests/run-phase.test.ts` locks the adapter success path, adapter error path,
  pool-exhaustion rethrow, and `releaseWorktree(..., { closeProvider: true })`
  cleanup behavior.
- `core/engine/run-phase.ts` moved from the strict-engine legacy exclusion list
  into `tsconfig.strict-engine.json`, leaving `run-job.ts` as the only strict
  engine exclusion.
- `scripts/type-debt-allowlist.json` no longer carries `run-phase.ts`; the
  focused P0/P1 verifier now includes `tests/run-phase.test.js`.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| strict-engine legacy exclusions | 1 |
| `core/engine/run-phase.ts` line count | 91 |
| `tests/run-phase.test.ts` line count | 108 |
| `core/engine` allowlisted broad type occurrences | 38 |
| strict-scope total allowlisted broad type occurrences | 87 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still excludes `run-job.ts`.
- DAG execution is still sequential despite the contract being DAG-shaped.
- DAG projection still drops dependencies outside the filtered phase list and
  does not yet normalize repeated phase IDs; this remains covered as current
  behavior and should be revisited before enabling real parallel DAG execution.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.
- legacy `local` and `remote` finalizers remain outside the flagship product
  gate and must not be claimed as validated by it.
- the flagship gate still uses fake ACP responses; a live provider or real ACP
  release rehearsal remains outside default automated CI.
- the stabilization cycle still needs the manual 3-maintainer/team product gate
  before claiming product maturity for unfamiliar teams.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/run-phase.test.js` before production edits | pass, 3 behavior-lock checks |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/run-phase.test.js tests/strict-engine-gate.test.js tests/type-debt-guard.test.js tests/verify-p0p1-runner.test.js` | pass, 13 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 332 focused node checks, 2 demo integration checks, 9 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 83 contract checks + 2 managed-worker E2Es |
| `npm test` | pass, 985 unit checks, 8 isolated unit checks, 17 integration checks, 47 isolated integration checks, shell tests |

## Remediation Checkpoint 34

This checkpoint narrows the remaining `run-job.ts` strict-mode boundary without
changing the phase execution loop:

- `core/engine/run-job-planning.ts` now owns the pure DAG planning and recovery
  helpers that previously lived at the top of `run-job.ts`: sequential DAG node
  planning, DAG resume context normalization, recovered artifact/verdict lookup,
  and canonical checklist-id attachment.
- `tests/run-job-planning.test.ts` locks the extracted helper contract, including
  dependency-ordered sequential planning, cycle/no-ready-node failure, retry vs
  dagResume vs previousFailure precedence, artifact path reconstruction through
  project runtime roots, and checklist binding rules for default vs custom or
  neutral nodes.
- `core/engine/run-job-planning.ts` is included in `tsconfig.strict-engine.json`,
  so this newly extracted boundary is strict-checked immediately instead of
  becoming another legacy side module.
- `scripts/verify-p0-p1.ts` now includes `tests/run-job-planning.test.js`, so
  the focused P0/P1 gate covers the extracted DAG planning and recovery helpers.
- `core/engine/run-job.ts` dropped from 1327 lines after Checkpoint 33 to 1227
  lines, while keeping the known `runJobInner` sequential execution loop intact
  for a later, behavior-preserving pass.

Current stabilization metrics after this checkpoint:

| Metric | Current |
| --- | ---: |
| strict-engine legacy exclusions | 1 |
| `core/engine/run-job.ts` line count | 1227 |
| `core/engine/run-job-planning.ts` line count | 207 |
| `tests/run-job-planning.test.ts` line count | 118 |
| `core/engine` allowlisted broad type occurrences | 27 |
| strict-scope total allowlisted broad type occurrences | 76 |

Remaining debt after this checkpoint:

- `runJobInner` still owns the sequential DAG execution loop and the surrounding
  phase orchestration.
- strict mode still excludes `run-job.ts`.
- DAG execution is still sequential despite the contract being DAG-shaped.
- DAG projection still drops dependencies outside the filtered phase list and
  does not yet normalize repeated phase IDs; this remains covered as current
  behavior and should be revisited before enabling real parallel DAG execution.
- live draft PR creation remains intentionally untested by default because it is
  side-effectful and requires explicit opt-in.
- legacy `local` and `remote` finalizers remain outside the flagship product
  gate and must not be claimed as validated by it.
- the flagship gate still uses fake ACP responses; a live provider or real ACP
  release rehearsal remains outside default automated CI.
- the stabilization cycle still needs the manual 3-maintainer/team product gate
  before claiming product maturity for unfamiliar teams.

Verified after the checkpoint:

| Command | Result |
| --- | --- |
| `npm run build:tests` before implementation | failed as expected: `tests/run-job-planning.test.ts` could not import missing `core/engine/run-job-planning.js` |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/run-job-planning.test.js` | pass, 5 helper checks |
| `npm run build:node && npm run build:tests && node dist/scripts/run-node-tests.js tests/run-job-planning.test.js tests/strict-engine-gate.test.js tests/type-debt-guard.test.js tests/verify-p0p1-runner.test.js` | pass, 15 checks |
| `npm run typecheck` | pass |
| `npm run typecheck:strict:engine` | pass |
| `npm run typecheck:type-debt:engine` | pass |
| `npm run verify:p0p1` | pass, 337 focused node checks, 2 demo integration checks, 9 managed-worker isolated checks, CLI smoke; live/full skipped by default |
| `npm run verify:release-gate` | pass, 83 contract checks + 2 managed-worker E2Es |
| `npm test` | pass, 990 unit checks, 8 isolated unit checks, 17 integration checks, 47 isolated integration checks, shell tests |
