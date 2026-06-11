# Dynamic Workflow, DAG Resume, and Attention Projection Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CodePatchBay dynamic workflow behavior reproducible by aligning runtime health, workflow definitions, DAG execution/resume semantics, and human-attention projection without mutating user runtime state during diagnostics.

**Architecture:** Treat workflow definition, runtime health, DAG node state, and attention projection as explicit contracts instead of UI or runner-local guesses. The first implementation slice should prove linear workflows still behave exactly as before while adding node-aware state contracts that can support non-linear DAG workflows without misleading operators.

**Tech Stack:** Node.js ESM, Fastify routes, JSONL event store, existing custom Node test runner, React/Vite web UI, Zustand store, vanilla-extract components.

---

## Current Evidence After Implementation

- `core/workflow/definition.ts` is the workflow catalog, DAG normalization, and runtime registration source of truth.
- `server/services/workflow-definition.ts` delegates to the core workflow catalog instead of maintaining an independent linear workflow table.
- `core/engine/run-job.ts` executes ready DAG nodes in deterministic node-first sequential order and records node-aware resume metadata.
- `core/workflow/dag-executor.ts` derives concrete-node resume state with legacy phase fallback only when node ids are unavailable.
- `server/services/event-store.ts`, `server/services/job-projection.ts`, `server/services/job-store.ts`, and `server/services/job-recovery.ts` preserve `dagResume` and node-level recovery lineage.
- Runtime is still not a clean operational verification surface: local source is `0.3.13`, active release is `0.3.12`, queue contains many `codegraph_unavailable` entries, stale jobs are present, and jobs-index/event-log divergence remains a warning.
- `server/services/attention-projection.ts` is the canonical attention projection, and `web/src/pages/Dashboard.tsx` fetches `/api/inbox?attentionOnly=1&limit=5` instead of deriving attention inline.

## Non-Goals

- Do not rewrite the hub orchestrator or worker process model.
- Do not replace the event-store or jobs-index storage layer.
- Do not add new dependencies, except TypeScript migration toolchain dev dependencies explicitly allowed by Task 8.
- Do not implement advanced DAG parallel fairness before the workflow contract is unified.
- Do not claim full DAG parallel execution in this plan. The execution target is a node-first sequential DAG executor boundary; parallel scheduling remains a later milestone.
- Do not perform a broad visual redesign of Dashboard or Project Overview before the attention projection contract is stable.
- Do not edit fakes, fixtures, snapshots, or test doubles merely to hide current behavior.

## Target Contracts

### Runtime Health Gate

`cpb dw-status` and dynamic-workflow acceptance should report a read-only, severity-ranked health gate before claiming DW readiness.

Required fields:

```js
{
  ok: false,
  sourceVersion: "0.3.13",
  activeReleaseVersion: "0.3.13",
  launcherReleaseVersion: "0.3.13",
  hubOrchestratorStatus: "running",
  queueBlockingCounts: {
    codegraph_unavailable: 0,
    agent_rate_limited: 0
  },
  jobsIndexDivergence: {
    count: 0,
    severity: "ok" // ok | warning | blocker
  },
  staleJobs: 0,
  initialized: true,
  blockers: [
    { code: "release_version_mismatch", message: "Active release differs from source", expected: "0.3.13", actual: "0.3.12" }
  ],
  warnings: [
    { code: "jobs_index_needs_reconcile", message: "Jobs index differs from event log", count: 76 }
  ]
}
```

Rules:

- `launcherReleaseVersion` is nullable and means the release metadata version behind `CPB_EXECUTOR_ROOT` or the selected launcher release. It is not a separate global binary truth source.
- Uninitialized environments, missing release selection, missing launcher metadata, or absent `CPB_EXECUTOR_ROOT` are warnings unless a command explicitly requires an active release.
- Jobs-index divergence is a warning on first detection because the index is rebuildable and eventually consistent. It becomes a blocker only after an explicit reconcile attempt still leaves divergence, or after repeated samples in the same runtime health history show persistent divergence.
- Health checks must remain read-only. `dw-status` and `doctor` may recommend reconcile commands but must not run repair/reconcile operations as part of status collection.
- Divergence escalation may only read existing evidence: prior reconcile result events/logs, persisted health history written by another explicit command, or explicit test fixtures passed into the helper. Status collection itself must not write health history solely to make escalation possible.

### Workflow Definition Source

All workflow lookup paths should resolve through `core/workflow/definition.js`.

Required behaviors:

- `standard`, `direct`, `complex`, `sdd-standard`, and future DAG workflows resolve from one catalog.
- Server supervisor and phase runner must not maintain an independent workflow table.
- Existing linear workflows remain phase-compatible for legacy callers.
- Explicit DAG workflows expose stable node ids, phases, dependencies, and per-node agent config.

### DAG Resume State

DAG recovery should be node-aware even before full parallel execution is enabled.

Required fields in projected job state:

```js
{
  workflowDag: {
    name: "standard",
    nodes: [
      { id: "plan", phase: "plan", dependsOn: [] },
      { id: "execute", phase: "execute", dependsOn: ["plan"] },
      { id: "verify", phase: "verify", dependsOn: ["execute"] }
    ]
  },
  dagResume: {
    completedNodeIds: ["plan"],
    failedNodeId: "execute",
    readyNodeIds: ["execute"],
    blockedNodeIds: ["verify"],
    resumeTarget: { nodeId: "execute", phase: "execute" }
  }
}
```

### Attention Projection

Dashboard and Inbox should consume one attention projection instead of inventing separate rankings.

Canonical API source:

- Dashboard must read attention rows from `/api/inbox?attentionOnly=1&limit=5` or a hub endpoint that delegates to the same `server/services/attention-projection.js` function.
- Inbox may request `/api/inbox?attentionOnly=1` for attention-focused views.
- UI code may truncate for display, but must not re-rank, reclassify, or synthesize attention reasons.

Canonical ordering:

1. Severity rank: `critical`, then `warning`, then `info`.
2. Kind rank within severity: `jobs_index_divergent`, `stale_runtime`, `codegraph_unavailable`, `agent_rate_limited`, `workflow_failed`, `dag_node_failed`, `waiting_approval`, `review_ready`.
3. Older `updatedAt` first for unresolved blockers so long-stuck work rises.
4. Higher priority if the source row has priority (`P0`, `P1`, `P2`, then unknown).
5. Stable lexical `id` tie-break.

Canonical dedupe:

- Dedupe key is `${project || "system"}:${kind}:${primaryEvidenceId}`.
- If a queue entry and job describe the same work, keep the item with richer evidence and preserve both evidence refs.
- Do not dedupe system runtime health items into project-level failures.

Required row shape:

```ts
type AttentionSeverity = 'critical' | 'warning' | 'info';
type AttentionKind =
  | 'workflow_failed'
  | 'dag_node_failed'
  | 'waiting_approval'
  | 'codegraph_unavailable'
  | 'agent_rate_limited'
  | 'jobs_index_divergent'
  | 'stale_runtime'
  | 'review_ready';

interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  kind: AttentionKind;
  project: string | null;
  title: string;
  reason: string;
  impact: string;
  ageMs: number | null;
  updatedAt: string | null;
  nextHumanAction: {
    label: string;
    href: string;
    kind: string;
  };
  evidence: Array<{ type: string; id: string; path?: string }>;
}
```

Compatibility rule:

- Inbox rows must keep the existing top-level `row.nextHumanAction` contract intact for legacy callers.
- Attention-specific action data lives under `row.attention.nextHumanAction` or in standalone `AttentionItem.nextHumanAction`.
- New action kinds may include `inspect`, `retry`, `approve`, and `repair_runtime`, but the type must remain open-ended so existing `cancel`, `redirect`, `start_worker`, `review_patch`, and `review_pr` actions are not broken.
- `AttentionQueue` must accept `AttentionItem[]` directly. Dashboard and Inbox must not assemble replacement `reason`, `impact`, `action`, or severity view models.

### Full JavaScript To TypeScript Migration

After runtime/workflow/DAG/attention stabilization is passing, migrate the Node-side source from `.js`/`.mjs` to TypeScript.

Rules:

- This is a post-stabilization task. Do not mix behavioral DAG/attention fixes with mechanical TS renames in the same commit.
- Allowed new dev dependencies are limited to TypeScript toolchain requirements such as `typescript` and `@types/node`, unless a later review explicitly approves more.
- Preserve Node ESM behavior. Source `.ts` files should keep `.js` import specifiers where required by `moduleResolution: "NodeNext"` so emitted JavaScript remains runnable.
- Preserve executable entrypoints and shebang behavior for `cpb`, `cpb-browser-agent-acp`, and `cpb-test-acp-agent`.
- Package publishing must include runnable compiled output or a documented launcher strategy; `npm pack` must not publish `.ts` sources without a runtime path that Node can execute.
- Migration is complete only when root Node sources, scripts, bridges, CLI commands, server, runtime, core, shared modules, and Node tests are typechecked or explicitly listed as generated/excluded artifacts.

## Files To Modify Or Create

- Modify `cli/commands/dw-status.js`: add runtime health gate checks and replace brittle string probes with exported contract checks.
- Modify `cli/cpb.mjs`: read CLI version from `package.json` in help output instead of hardcoded `v0.2.0`.
- Create: `server/services/runtime-health.js`: shared runtime health probe used by `doctor`, `dw-status`, and attention projection.
- Modify: `cli/commands/doctor.js`: delegate reusable runtime health facts to `server/services/runtime-health.js` instead of keeping jobs-index divergence logic CLI-local.
- Modify `server/services/workflow-definition.js`: replace the independent legacy table with adapters around `core/workflow/definition.js`.
- Modify `server/services/supervisor.js`: compute recovery from DAG node state when `workflowDag.nodes` exist; retain legacy phase fallback.
- Modify `server/services/phase-runner.js`: consume the unified workflow adapter.
- Modify `core/engine/phase-policy.js`: verify semantic phase policy and server workflow adapter agree for every built-in workflow.
- Modify `core/engine/run-job.js`: replace phase-first node selection with a node-first sequential DAG executor boundary and emit resume metadata.
- Modify `core/workflow/dag-executor.js`: expose deterministic `deriveDagResumeState()` for completed/failed/running node sets.
- Modify `server/services/event-store.js`: materialize `dagResume` from `dag_node_*` and phase events without duplicating phase ids as node ids; preserve terminal immutability for business projection.
- Modify `server/services/job-projection.js`: include `workflowDag`, `dagResume`, and attention evidence fields in projected jobs.
- Modify `server/services/job-store.js`: preserve node-level resume lineage when retrying or creating recovery jobs.
- Modify `server/services/job-recovery.js`: carry failed node id, completed node ids, and resume target into recovery source context.
- Create `server/services/attention-projection.js`: canonical projection from jobs, queue entries, review sessions, runtime health, and index status into `AttentionItem[]`.
- Modify `server/routes/inbox.js`: include attention fields and support `attentionOnly=1`; use canonical projection for filtering and order.
- Modify `server/routes/hub.js`: expose an attention summary only through the canonical projection; no separate hub-specific attention ranking.
- Modify `web/src/types/api.ts`: add `AttentionItem`, `AttentionKind`, and optional `attention` fields on inbox rows.
- Modify `web/src/app/store/inbox.ts`: send `attentionOnly` to the server instead of client-only filtering.
- Modify `web/src/pages/Dashboard.tsx`: replace inline `attentionItems` construction with canonical API data.
- Modify `web/src/components/dashboard/AttentionQueue.tsx`: render severity, reason, impact, age, and action.
- Modify `package.json`: add Node TypeScript build/typecheck scripts and update publish files/bin paths after migration.
- Modify `package-lock.json`: record approved TypeScript toolchain dev dependencies.
- Create `tsconfig.node.json`: Node ESM TypeScript config for CLI/server/runtime/core/shared/scripts/tests.
- Modify `cpb`: preserve the executable launcher while pointing at the compiled CLI runtime if source is emitted to `dist/`.
- Rename/migrate Node-side source files from `.js`/`.mjs` to `.ts` across `cli/`, `core/`, `server/`, `runtime/`, `bridges/`, `shared/`, `scripts/`, and `tests/` in controlled batches.
- Create `tests/workflow-definition-contract.test.mjs`: unified workflow catalog and legacy compatibility.
- Create `tests/dag-resume-contract.test.mjs`: DAG resume derivation and node-aware retry target tests.
- Create `tests/runtime-health-gate.test.mjs`: source/release launcher identity, initialization warnings, and jobs-index divergence severity checks.
- Create `tests/attention-projection.test.mjs`: canonical attention ranking, dedupe, and next-action tests.
- Create or update web tests for `AttentionQueue` and Dashboard attention rendering when the web test harness is available.

## Implementation Tasks

### Task 1: Runtime Health Gate And Version Identity

**Files:**
- Modify: `cli/commands/dw-status.js`
- Modify: `cli/cpb.mjs`
- Create: `server/services/runtime-health.js`
- Modify: `cli/commands/doctor.js`
- Create: `tests/runtime-health-gate.test.mjs`

- [ ] **Step 1: Write failing tests for version identity and health gate**

Create `tests/runtime-health-gate.test.mjs` with assertions that CLI usage reads `package.json` version and that the DW health gate reports mismatched release/source as a blocker, uninitialized release state as a warning, and first-observed jobs-index divergence as a `needs_reconcile` warning. Use temp package/release launcher fixtures or injectable probe inputs; do not hardcode the current repository version as the only test value.

Add escalation tests with explicit read-only history fixtures: repeated prior divergence or a recorded failed reconcile result may upgrade divergence to blocker. The helper must not write any history file during status collection.

Run: `npm run build:tests && node --test dist/tests/runtime-health-gate.test.js`
Expected: FAIL because help still prints `v0.2.0` and no reusable health gate exists.

- [ ] **Step 2: Implement version identity fix**

Change `cli/cpb.mjs` so `usage()` reads the package version once from `package.json` instead of printing a literal version.

Run: `./cpb --help | head -1`
Expected: first line contains `cpb v0.3.13`.

- [ ] **Step 3: Implement shared runtime health helper**

Create `server/services/runtime-health.js` with a read-only helper that returns source version, active release version, nullable launcher release version, initialization state, hub orchestrator status, queue blocking counts, stale jobs, and jobs-index divergence severity. Update `cli/commands/doctor.js` and `cli/commands/dw-status.js` to consume the helper instead of duplicating jobs-index divergence logic. Do not invoke reconcile or repair code from the helper.

Run: `./cpb dw-status`
Expected: output includes runtime health blockers before any readiness success claim.

- [ ] **Step 4: Run focused verification**

Run: `npm run build:tests && node --test dist/tests/runtime-health-gate.test.js`
Expected: PASS.

### Task 2: Workflow Definition Single Source

**Files:**
- Modify: `server/services/workflow-definition.js`
- Modify: `server/services/phase-runner.js`
- Modify: `server/services/supervisor.js`
- Modify: `core/engine/phase-policy.js`
- Create: `tests/workflow-definition-contract.test.mjs`

- [ ] **Step 1: Write failing contract tests**

Test that server workflow lookup, `phase-runner`, `supervisor`, and `core/engine/phase-policy.js` resolve the same phases and DAG metadata as `core/workflow/definition.js` for `standard`, `direct`, `complex`, and `sdd-standard`.

Run: `npm run build:tests && node --test dist/tests/workflow-definition-contract.test.js`
Expected: FAIL because the server table omits newer workflows.

- [ ] **Step 2: Replace server workflow table with adapter**

Make `server/services/workflow-definition.js` import the core workflow helpers and export legacy-compatible functions such as `getWorkflow(name)` and `nextPhaseFor(workflowName, completedPhases)`.

Run: `npm run build:tests && node --test dist/tests/workflow-definition-contract.test.js`
Expected: PASS.

- [ ] **Step 3: Verify existing server callers still work**

Run: `rg -n "server/services/workflow-definition|workflow-definition.js" server tests`
Expected: callers remain routed through the adapter, with no second workflow catalog.

### Task 3: DAG Resume Contract

**Files:**
- Modify: `core/workflow/dag-executor.js`
- Modify: `server/services/event-store.js`
- Modify: `server/services/job-projection.js`
- Modify: `server/services/job-store.js`
- Modify: `server/services/job-recovery.js`
- Create: `tests/dag-resume-contract.test.mjs`

- [ ] **Step 1: Write failing tests for resume derivation**

Test a DAG with `plan -> execute_a`, `plan -> execute_b`, and `verify` depending on both execute nodes. Assert that completing `plan` makes both execute nodes ready, failing `execute_b` makes `resumeTarget.nodeId === "execute_b"`, and `verify` remains blocked.

Add an event-flow test with `workflow_dag_materialized`, `phase_completed`, and `dag_node_failed` events. For a workflow with `execute_a` and `execute_b` sharing `phase: "execute"`, assert:

- node ids are authoritative when present;
- `completedNodeIds` never contains a bare `"execute"` entry if concrete execute node ids exist;
- phase fallback is used only for legacy jobs with no node ids.
- post-terminal `dag_node_*` events are retained as audit evidence but do not mutate business `dagResume`, `nodeStates`, or terminal status after the job is sealed.

Add recovery-lineage tests proving a failed DAG node retry/recovery carries `failedNodeId`, `resumeTarget`, and `completedNodeIds` into the new job source context. The test must fail if recovery chooses only `failurePhase` and loses the concrete failed node id.

Run: `npm run build:tests && node --test dist/tests/dag-resume-contract.test.js`
Expected: FAIL because no exported deterministic resume derivation exists.

- [ ] **Step 2: Implement `deriveDagResumeState()`**

Export `deriveDagResumeState({ workflowDag, nodeStates, phaseStates })` from `core/workflow/dag-executor.js`. It must use node ids first and phase names only as a legacy fallback when node ids are unavailable.

Run: `npm run build:tests && node --test dist/tests/dag-resume-contract.test.js`
Expected: PASS for pure DAG derivation.

- [ ] **Step 3: Materialize resume state**

Update `server/services/event-store.js` and `server/services/job-projection.js` so projected jobs include `dagResume`. Preserve terminal immutability: if a job is already terminal, later `dag_node_*` events may appear in audit history but must not change `dagResume`, `nodeStates`, terminal status, or next recovery target.

Run: `npm run build:tests && node --test dist/tests/event-store.test.js dist/tests/dag-resume-contract.test.js`
Expected: PASS.

- [ ] **Step 4: Preserve node-aware recovery lineage**

Update `server/services/job-store.js` and `server/services/job-recovery.js` so retries and recovery jobs preserve `sourceContext.dagResume` with `failedNodeId`, `resumeTarget`, and `completedNodeIds`. Review-bundle rejection retry paths must carry the same node-level context when the rejected job has DAG resume metadata.

Run: `npm run build:tests && node --test dist/tests/job-recovery.test.js dist/tests/dag-resume-contract.test.js`
Expected: PASS.

### Task 4: Node-First Sequential DAG Executor Boundary

**Files:**
- Modify: `core/engine/run-job.js`
- Modify: `core/workflow/dag-executor.js`
- Update: `tests/engine-prepare-task.test.mjs`
- Create or update: DAG execution behavior tests near existing engine tests.

- [ ] **Step 1: Add tests that expose phase-first behavior**

Add an explicit DAG workflow test with two same-phase execute nodes where the second node depends on the first. Assert node execution follows `workflowDag.nodes` dependency order, not the legacy `phases` list. The test must prove an unmet dependency node never starts even if its phase appears next in the legacy phase list. Add a same-phase failed node test proving `dagResume.resumeTarget.nodeId` targets the failed node, and assert `dag_parallel_execution_ready=false` even when `maxConcurrentNodes > 1`.

Run: `npm run build:tests && node --test dist/tests/engine-prepare-task.test.js`
Expected: FAIL until runner selects nodes by DAG topology and emits unambiguous node execution/resume metadata.

- [ ] **Step 2: Implement node-first sequential execution**

Refactor `core/engine/run-job.js` so execution iterates ready DAG nodes in deterministic topological order. Do not introduce real parallelism in this task; run at most one ready node at a time, but derive that node from DAG dependencies rather than from the legacy phase array.

Run: `npm run build:tests && node --test dist/tests/engine-prepare-task.test.js dist/tests/dag-resume-contract.test.js`
Expected: PASS.

- [ ] **Step 3: Update DW status language**

Ensure `dw-status` distinguishes `dag_metadata_ready`, `dag_node_first_sequential_ready`, `dag_resume_ready`, and `dag_parallel_execution_ready`. The last one should remain false until true parallel scheduling is implemented.

Run: `./cpb dw-status`
Expected: no claim that parallel DAG execution is ready.

### Task 5: Canonical Attention Projection

**Files:**
- Create: `server/services/attention-projection.js`
- Modify: `server/routes/inbox.js`
- Modify: `server/routes/hub.js`
- Modify: `web/src/types/api.ts`
- Modify: `web/src/app/store/inbox.ts`
- Create: `tests/attention-projection.test.mjs`

- [ ] **Step 1: Write failing projection tests**

Test ranking and dedupe for failed DAG node, `codegraph_unavailable`, `agent_rate_limited`, waiting review approval, jobs-index divergence, `stale_runtime`, and review-ready completed work.

Assert the exact canonical ordering and dedupe rules:

- severity rank before age;
- kind rank before age within the same severity;
- older unresolved blocker before newer unresolved blocker;
- stable lexical id tie-break when all other fields match;
- queue/job duplicates merge evidence instead of producing two attention rows.

Add route-level tests proving:

- `/api/inbox?attentionOnly=1&limit=5` returns canonical order and excludes non-attention rows;
- hub dashboard attention summary delegates to the same projection result;
- row-level `attention` fields match the service output without route-specific remapping;
- non-`attentionOnly` `/api/inbox` responses remain backward compatible, including existing top-level `nextHumanAction` values.
- route-level attention calls pass current `runtimeHealth` into `buildAttentionProjection()` so system-level items such as `stale_runtime` are not lost when the route also loads jobs, queue entries, and reviews.

Run: `npm run build:tests && node --test dist/tests/attention-projection.test.js`
Expected: FAIL because no canonical projection module exists.

- [ ] **Step 2: Implement `buildAttentionProjection()`**

Create `server/services/attention-projection.js` exporting `buildAttentionProjection({ jobs, queueEntries, reviews, runtimeHealth })`. Return sorted `AttentionItem[]` with stable ids and evidence.

Run: `npm run build:tests && node --test dist/tests/attention-projection.test.js`
Expected: PASS.

- [ ] **Step 3: Wire Inbox and Hub routes to one source**

Update `/api/inbox` to include attention fields on rows and support `attentionOnly=1`. Put attention actions under `row.attention.nextHumanAction`; do not replace legacy `row.nextHumanAction`. Update hub dashboard summary to expose attention counts using the same projection. Document that Dashboard reads `/api/inbox?attentionOnly=1&limit=5` unless a future hub summary endpoint proves it delegates to the same function.

Run: `npm run build:tests && node --test dist/tests/attention-projection.test.js dist/tests/integration/api-github-policy.test.js`
Expected: PASS or documented unrelated skips if integration prerequisites are absent.

### Task 6: Dashboard And AttentionQueue Consumption

**Files:**
- Modify: `web/src/pages/Dashboard.tsx`
- Modify: `web/src/components/dashboard/AttentionQueue.tsx`
- Modify: `web/src/types/api.ts`
- Update or create: web attention tests when harness is present.

- [ ] **Step 1: Add component expectations**

Add web tests that render an attention row with severity, reason, impact, age, and action. Add a dashboard test that asserts AttentionQueue appears before metric-heavy summary when critical attention exists. Use an intentionally unsorted fixture from the API and assert the Dashboard preserves API order rather than re-ranking client-side.

Also add a DOM/accessibility order test: the Needs Attention landmark/heading must appear before the Today Brief metrics heading whenever the API returns at least one `critical` or `warning` attention item.

Run: `cd web && npm test -- --run`
Expected: FAIL until UI consumes canonical attention data.

- [ ] **Step 2: Update AttentionQueue rendering**

Render severity, project, reason, impact, age, and action from `AttentionItem`. Keep the empty state compact and accessible.

Run: `cd web && npm test -- --run`
Expected: PASS for attention component tests.

- [ ] **Step 3: Replace Dashboard inline attention derivation**

Remove local `useMemo` construction of `attentionItems` from `Dashboard.tsx`. Fetch `/api/inbox?attentionOnly=1&limit=5` or consume a hub field that is contract-tested to delegate to `server/services/attention-projection.js`, then pass rows directly into `AttentionQueue` without client-side reclassification.

Do not build `{ project, reason, impact, action, link }` objects in `Dashboard.tsx`. Any text displayed in `AttentionQueue` must come from `AttentionItem` fields supplied by the canonical projection.

Run: `npm run build:web`
Expected: PASS.

### Task 7: Final Regression And Documentation Sync

**Files:**
- Modify: `docs/product/dw-audit-report.md`
- Modify: `docs/product/dw08-migration-runbook.md`
- Modify: this plan if implementation discoveries change accepted behavior.

- [ ] **Step 1: Update docs with actual readiness levels**

Record separate statuses for runtime health, workflow single-source, DAG metadata, DAG resume, DAG parallel execution, and attention projection.

- [ ] **Step 2: Run focused backend verification**

Run:

```bash
npm run build:tests
node --test dist/tests/runtime-health-gate.test.js dist/tests/workflow-definition-contract.test.js dist/tests/dag-resume-contract.test.js dist/tests/attention-projection.test.js
```

Expected: PASS.

- [ ] **Step 3: Run existing relevant regression**

Run:

```bash
npm run build:tests
node --test dist/tests/engine-prepare-task.test.js dist/tests/scheduler-dag-provider.test.js dist/tests/event-store.test.js dist/tests/job-recovery.test.js
node --test dist/tests/event-extension-gate.test.js
```

Expected: PASS.

- [ ] **Step 4: Run package-level verification**

Run:

```bash
npm test
npm run build:web
./cpb dw-status
./cpb doctor
```

Expected: tests/build pass; `dw-status` and `doctor` either pass or list explicit remaining runtime blockers without claiming DW readiness.

### Task 8: Full JavaScript To TypeScript Migration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tsconfig.node.json`
- Modify: `cpb`
- Rename/modify: `cli/**/*.js`, `cli/**/*.mjs`
- Rename/modify: `core/**/*.js`
- Rename/modify: `server/**/*.js`, `server/**/*.mjs`
- Rename/modify: `runtime/**/*.js`, `runtime/**/*.mjs`
- Rename/modify: `bridges/**/*.js`, `bridges/**/*.mjs`
- Rename/modify: `shared/**/*.js`
- Rename/modify: `scripts/**/*.mjs`
- Rename/modify: `tests/**/*.mjs`

- [ ] **Step 1: Create a migration inventory**

Run:

```bash
rg --files -g '*.js' -g '*.mjs' -g '*.cjs' cli core server runtime bridges shared scripts tests cpb package.json
```

Expected: produces the complete Node-side migration list. Save the categorized inventory in the implementation notes before renaming any file.

- [ ] **Step 2: Add the TypeScript toolchain**

Add approved dev dependencies only:

```bash
npm install --save-dev --package-lock-only typescript @types/node
```

Expected package effect: `package.json` contains only `typescript` and `@types/node` as new root dev dependencies, and `package-lock.json` records the exact resolved versions.

Add scripts:

```json
{
  "scripts": {
    "typecheck:node": "tsc -p tsconfig.node.json --noEmit",
    "build:node": "tsc -p tsconfig.node.json",
    "build": "npm run build:node && npm run build:web"
  }
}
```

Create `tsconfig.node.json` with `module` and `moduleResolution` set to `NodeNext`, `target` set to a Node 20-compatible target, `rootDir` set to `.`, and `outDir` set to `dist`.

Run: `npm install --package-lock-only`
Expected: lockfile remains consistent and records only the approved TypeScript toolchain additions.

- [ ] **Step 3: Prove JS behavior before renaming**

Run:

```bash
npm test
npm run build:web
./cpb --version
npm run build:tests
node --test dist/tests/engine-prepare-task.test.js dist/tests/event-store.test.js
```

Expected: PASS. Record this as the pre-migration baseline.

- [ ] **Step 4: Migrate leaf/shared modules first**

Rename low-level modules under `shared/`, `core/`, and pure service helpers to `.ts`. Keep runtime import specifiers as `.js` where TypeScript NodeNext expects emitted JavaScript paths.

Run:

```bash
npm run typecheck:node
npm run build:tests
node --test dist/tests/core-boundary.test.js dist/tests/shared-boundary.test.js
```

Expected: PASS.

- [ ] **Step 5: Migrate server/runtime/bridge modules**

Rename `server/`, `runtime/`, and `bridges/` modules in batches. Preserve public exported names and event payload shapes. Do not combine this with behavior changes from Tasks 1-7.

Run:

```bash
npm run typecheck:node
npm run build:tests
node --test dist/tests/server-boundary.test.js dist/tests/runtime-root-separation.test.js dist/tests/event-store.test.js dist/tests/job-recovery.test.js
```

Expected: PASS.

- [ ] **Step 6: Migrate CLI, scripts, and entrypoints**

Rename `cli/commands/*`, `cli/cpb.mjs`, and runnable scripts to `.ts`. Update `cpb` and `package.json` `bin` entries so installed packages execute compiled JavaScript from `dist/` or a verified launcher path.

Run:

```bash
npm run build:node
node dist/cli/cpb.js --version
./cpb --version
```

Expected: both version commands return the package version.

- [ ] **Step 7: Migrate Node tests**

Rename Node tests to `.test.ts` only after the runner supports compiled test execution. Update `scripts/run-node-tests.mjs` or its migrated TypeScript equivalent to run compiled tests from `dist/` without relying on a runtime TypeScript loader.

Run:

```bash
npm run build:node
npm test
```

Expected: PASS.

- [ ] **Step 8: Verify packaging**

Run:

```bash
npm run build
npm pack --dry-run
node dist/scripts/e2e-npm-pack.js
```

Expected: the package includes runnable compiled Node output, `web/dist/`, and no stale source-only bin paths.

- [ ] **Step 9: Enforce no remaining Node JS sources**

Run:

```bash
rg --files -g '*.js' -g '*.mjs' -g '*.cjs' cli core server runtime bridges shared scripts tests
```

Expected: no files remain, except documented generated files or compatibility launchers explicitly listed in the migration notes.

## Acceptance Criteria

1. There is one workflow catalog source used by core and server paths.
2. DW readiness cannot be reported as complete when source/release versions diverge or required runtime state is unhealthy; jobs-index divergence is first reported as a reconcile warning and escalates only after persistence or failed reconcile evidence.
3. Projected jobs include deterministic DAG resume metadata based on node ids.
4. Explicit DAG workflows are no longer described as parallel-ready unless the runner actually schedules them that way.
5. Dashboard and Inbox use the same attention semantics.
6. CodeGraph unavailable, provider rate limit, waiting approval, stale runtime, and jobs-index divergence appear as actionable attention items.
7. Focused contract tests prove workflow definition consistency, DAG resume behavior, runtime health gating, and attention ranking.
8. UI tests prove AttentionQueue consumes canonical `AttentionItem[]`, preserves API order, and appears before metric-heavy summary content when critical or warning attention exists.
9. After stabilization tasks pass, Node-side JavaScript is migrated to TypeScript with a runnable compiled package, preserved bin entrypoints, passing typecheck, passing Node tests, and no undocumented `.js`/`.mjs` sources left in `cli/`, `core/`, `server/`, `runtime/`, `bridges/`, `shared/`, `scripts/`, or `tests/`.

## Adversarial Validation Log

### Round 1: Architecture Scope

Verdict: `PASS_WITH_CHANGES`.

Applied changes:

- Strengthened Task 4 from a vague DAG-compatible boundary to node-first sequential DAG execution.
- Added a shared runtime health helper instead of duplicating doctor logic in `dw-status`.
- Required `phase-policy` consistency checks.
- Specified a single attention API source.
- Added `tests/event-extension-gate.test.mjs` to final regression.

### Round 2: Test Falsifiability

Verdict: `PASS_WITH_CHANGES`.

Applied changes:

- Added event-flow DAG resume tests for same-phase nodes.
- Required tests proving bare phase names do not pollute concrete node state.
- Required route and UI attention tests, not service-only tests.
- Added recovery-lineage verification.
- Required runtime health tests to use fixtures instead of hardcoding the current repository version.

### Round 3: Runtime Health Realism

Verdict: `PASS_WITH_CHANGES`.

Applied changes:

- Replaced ambiguous `globalCliVersion` with nullable `launcherReleaseVersion`.
- Downgraded first-observed jobs-index divergence to `needs_reconcile` warning.
- Clarified uninitialized release/runtime states as warnings unless an active release is required.
- Required health checks to remain read-only.

### Round 4: Compatibility And Terminal Boundaries

Verdict: `REQUEST_CHANGES`.

Applied changes:

- Added terminal immutability rules for post-terminal `dag_node_*` events.
- Moved node-aware recovery lineage into Task 3 instead of final-only verification.
- Required `job-store.js` and `job-recovery.js` updates.
- Preserved legacy `row.nextHumanAction` and moved attention-specific action under `row.attention.nextHumanAction`.

### Round 5: Attention Semantics

Verdict: `BLOCKING`.

Applied changes:

- Added canonical attention ordering, tie-break, and dedupe rules.
- Required `AttentionQueue` to consume `AttentionItem[]` directly.
- Prohibited Dashboard and Inbox from synthesizing replacement attention text or order.
- Added DOM/accessibility order tests requiring attention before metric-heavy summary when critical or warning items exist.

### Round 6: Final Integrated Review

Verdict: `PASS_WITH_CHANGES`.

Applied changes:

- Defined read-only evidence sources for escalating jobs-index divergence to blocker.
- Added `stale_runtime` projection and route-level tests.
- Required `/api/inbox?attentionOnly=1` to pass `runtimeHealth` into the canonical projection.

Final status: Ready for implementation planning handoff. Remaining risk is implementation scope size, not an unresolved spec contradiction.

### Post-Validation Addition: Full JS To TS Migration

User-requested addition after the six adversarial validation rounds.

Applied changes:

- Added a post-stabilization TypeScript migration contract.
- Added Task 8 for full Node-side `.js`/`.mjs` to `.ts` migration.
- Limited new dependencies to the explicit TypeScript toolchain.
- Required package/bin/runtime verification so the migration cannot leave source-only TypeScript that Node cannot execute.

## Implementation Status: 2026-06-11

Tasks 1-8 are implemented with focused and full-suite verification.

Readiness levels:

- `runtime_health_gate`: implemented, but the current local runtime still reports explicit blockers.
- `workflow_single_source`: ready.
- `dag_metadata_ready`: true.
- `dag_node_first_sequential_ready`: true.
- `dag_resume_ready`: true.
- `dag_parallel_execution_ready`: false by design.
- `attention_projection`: ready.
- `dashboard_attention_consumption`: ready.
- `typescript_migration`: complete for source files outside dependencies, generated output, runtime homes, and vendored browser bundles; `web/test-setup.js`, ignored marketing scripts, and ignored hyperframes subtitle data were migrated or removed after confirming current runtime references.
- `package_publish_runtime`: ready; compiled `dist/` contains executable bins, runtime assets, and `web/dist`.

Observed operational blockers from `./cpb dw-status`:

- Active release version differs from source version.
- Queue contains `codegraph_unavailable` entries.
- Stale jobs are present.
- Jobs-index divergence is a reconcile warning.

Implementation notes:

- Same-phase DAG workflows must use `dag_node_*` events and `dagResume` for ordering/resume semantics. Phase-level events remain legacy compatibility signals and can repeat for multiple same-phase nodes.
- Runtime health divergence scanning uses `readEventsReadOnly()` and must not repair event logs.
- Attention projection normalizes dotted `waiting.approval` and underscore `waiting_approval` spellings.
- Queue/job attention dedupe uses explicit queue/job lineage keys and a same-project/kind/work fallback, then merges evidence.
- The Node TypeScript migration preserves NodeNext `.js` import specifiers so emitted JavaScript remains runnable.
- The migrated Node source is currently guarded with `// @ts-nocheck` during the mechanical full-file migration. `typecheck:node` proves project graph, module resolution, declarations, and emit viability, but strict semantic typing remains a follow-up hardening task.
- `npm pack --dry-run --json --ignore-scripts` now reports no tests, no runtime `.omc` state, no local `.tgz` files, no non-template wiki artifacts, and includes `dist/web/dist/index.html` plus browser fixture HTML.

Final verification:

```bash
npm run typecheck:node
npm run typecheck:web
cd web && npm test -- --run
npm test
npm pack --dry-run --json --ignore-scripts
find . \( -path './.*' -o -path './cpb-task' -o -path './node_modules' -o -path './web/node_modules' -o -path './dist' -o -path './web/dist' -o -path './dist-tests' -o -path './marketing/codepatchbay-vibecoding-video/assets/gsap.min.js' \) -prune -o -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print | sort
./cpb dw-status
```

Observed result:

- Node and web typechecks passed.
- Web Vitest passed: 3 files, 3 tests.
- Full `npm test` passed: unit 477/477, integration 101/101, isolated integration 43/43, shell smoke passed.
- Source-wide legacy JS/MJS/CJS count is 0 outside dependencies, generated output, runtime homes, and vendored browser bundles.
- `./cpb dw-status` correctly exits non-zero because the current runtime state has operational blockers, while DAG readiness flags are true except `dag_parallel_execution_ready: false`.
