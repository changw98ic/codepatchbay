# Checklist-First Task Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CPB task completion auditable by turning task requirements into a prepare-time frozen checklist, requiring itemized evidence-backed verification, and gating completion on checklist, evidence, DAG, and scope state.

**Architecture:** V1 generates, validates, persists, and event-indexes the frozen `acceptance-checklist` before workflow DAG and dynamic agent plan materialization, stores checklist artifacts through first-class artifact events, binds grouped checklist ids to existing execute/verify DAG nodes as coverage metadata, and keeps legacy verdict-only completion as a compatibility path for jobs without checklist artifacts. Retry separates logical `targetChecklistIds` from file-only `fixScope`.

**Tech Stack:** Node.js ESM, TypeScript, existing `node:test` runner, CPB artifact store, JSONL event store, artifact index, workflow DAG, current failure-router and reconciler modules.

---

## V1 Decisions

- The acceptance checklist is generated, validated, persisted, and event-indexed in prepare-time before `workflowDag` and `dynamicAgentPlan` are created.
- The plan phase consumes the frozen checklist; it does not create the checklist that shapes the same run.
- V1 groups all required checklist ids on existing execute and verify DAG nodes as coverage metadata. Item pass/fail state comes only from `checklist-verdict` plus fresh `evidence-ledger` refs. Per-item DAG splitting is V2.
- V1 forbids in-place checklist mutation after freeze. Checklist revisions and `acceptance-change-log` are V2.
- Checklist artifacts are JSON content stored in current `.md` artifact files because `writeArtifact()` writes `${kind}-${id}.md`.
- V1 extends JSON audit export. A full file bundle with replay scripts is V2.
- Completion, audit, and replay must read event-indexed artifact JSON. `sourceContext`, phase diagnostics, artifact metadata, prompt text, and executor summaries are not authoritative checklist facts.

## File Map

- Create `core/workflow/acceptance-checklist.ts`: checklist validation, checklist verdict validation, evidence freshness, completion evaluation.
- Modify `core/contracts/failure.ts`: add or map checklist routing failure kinds.
- Modify `server/services/job/job-projection.ts`: recognize checklist artifact kinds and index explicit artifact events.
- Modify `server/services/event/event-store.ts`: materialize checklist artifacts and completion gate checklist fields.
- Modify `core/engine/run-job.ts`: persist prepare-time checklist, emit artifact events, attach grouped checklist ids to DAG nodes, feed checklist artifacts to phases/gate, and route retry metadata.
- Modify `core/agents/response-parser.ts`: preserve checklist payloads from planner/executor/verifier envelopes.
- Modify `core/phases/plan.ts`: consume frozen checklist and reject silent checklist mutation.
- Modify `core/phases/execute.ts`: persist `execution-map` as an event-visible artifact.
- Modify `core/phases/verify.ts`: persist `evidence-ledger` and `checklist-verdict` as event-visible artifacts.
- Modify `core/engine/completion-gate.ts`: evaluate checklist-aware completion before legacy verdict fallback.
- Modify `server/orchestrator/reconciler.ts`: carry `targetChecklistIds`, locked passed ids, and file-only retry scope.
- Modify `server/orchestrator/failure-router.ts`: route checklist failures without mixing checklist ids into file scope.
- Modify `server/services/readiness-checks.ts`: include checklist artifacts in audit export.
- Add focused tests listed in each task.

## Compatibility Rules

- A job without an `acceptance-checklist` artifact uses the existing verifier and completion-gate path.
- A job with an `acceptance-checklist` artifact must produce a valid `checklist-verdict`.
- Legacy `VERDICT: PASS` cannot complete a checklist-aware job by itself.
- New checklist artifacts must be discoverable through events and artifact index. Diagnostics-only persistence is not sufficient.
- If a checklist artifact file has been written, `artifact_created` must be emitted before the phase returns success, failure, or blocked status.

## Task 1: Add Artifact Event And Index Foundation

**Files:**
- Modify: `server/services/job/job-projection.ts`
- Modify: `server/services/event/event-store.ts`
- Create: `tests/checklist-artifact-index.test.ts`
- Modify: `tests/event-store.test.ts`

- [ ] **Step 1: Write artifact index tests**

Create `tests/checklist-artifact-index.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { appendEvent } from "../server/services/event/event-store.js";
import { buildArtifactIndex } from "../server/services/job/job-projection.js";
import { tempRoot } from "./helpers.js";

test("artifact index recognizes checklist artifact kinds from artifact_created events", async () => {
  const cpbRoot = await tempRoot("cpb-checklist-artifact-index");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
  const outputs = path.join(dataRoot, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });

  const artifacts = [
    "acceptance-checklist-001",
    "execution-map-001",
    "evidence-ledger-001",
    "checklist-verdict-001",
  ];
  for (const name of artifacts) {
    await writeFile(path.join(outputs, `${name}.md`), "{}\n", "utf8");
    const kind = name.replace(/-001$/, "");
    await appendEvent(cpbRoot, "flow", "job-1", {
      type: "artifact_created",
      jobId: "job-1",
      project: "flow",
      phase: kind === "acceptance-checklist" ? "prepare_task" : "verify",
      kind,
      artifactKind: kind,
      artifact: name,
      artifactId: "001",
      ts: "2026-06-12T00:00:00Z",
    }, { dataRoot });
  }

  const index = await buildArtifactIndex(cpbRoot, "flow", "job-1", { dataRoot });
  assert.deepEqual(index.entries.map((entry) => entry.kind).sort(), [
    "acceptance-checklist",
    "checklist-verdict",
    "evidence-ledger",
    "execution-map",
  ]);
  assert.equal(index.entries.every((entry) => entry.broken === false), true);
});
```

- [ ] **Step 2: Add event-store materialization test**

Append to `tests/event-store.test.ts`:

```ts
test("artifact_created materializes artifacts by kind", () => {
  const state = materializeJob([{
    type: "artifact_created",
    jobId: "job-1",
    project: "flow",
    phase: "verify",
    kind: "checklist-verdict",
    artifactKind: "checklist-verdict",
    artifact: "checklist-verdict-001",
    artifactId: "001",
    sha256: "abc",
    ts: ts(100),
  }]);
  assert.equal(state.artifactsByKind["checklist-verdict"].name, "checklist-verdict-001");
  assert.equal(state.artifactsByKind["checklist-verdict"].sha256, "abc");
});
```

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-artifact-index.test.ts tests/event-store.test.ts
```

Expected: tests fail because `artifact_created` and checklist kinds are not supported.

- [ ] **Step 4: Update artifact index**

In `server/services/job/job-projection.ts`, extend `KNOWN_KINDS`:

```ts
const KNOWN_KINDS = new Set([
  "plan", "deliverable", "review", "verdict", "prompt", "diff", "tests", "risk", "pr",
  "acceptance-checklist", "execution-map", "evidence-ledger", "checklist-verdict",
]);
```

In `inferKind`, add filename rules before phase fallback:

```ts
if (/^acceptance-checklist-/i.test(name)) return "acceptance-checklist";
if (/^execution-map-/i.test(name)) return "execution-map";
if (/^evidence-ledger-/i.test(name)) return "evidence-ledger";
if (/^checklist-verdict-/i.test(name)) return "checklist-verdict";
```

The existing `event.artifactKind` branch already handles explicit `artifact_created` events once the kind is known.

- [ ] **Step 5: Update event store**

In `server/services/event/event-store.ts`, include `"artifact_created"` in `POST_TERMINAL_ALLOWED`.

Add `artifactsByKind: {}` to the initial materialized state.

Add reducer:

```ts
artifact_created(state, event) {
  const kind = event.kind || event.artifactKind;
  if (!kind || !event.artifact) return;
  state.artifactsByKind = {
    ...(state.artifactsByKind || {}),
    [kind]: {
      kind,
      name: event.artifact,
      id: event.artifactId || null,
      phase: event.phase || null,
      sha256: event.sha256 || null,
      ts: event.ts || null,
    },
  };
}
```

- [ ] **Step 6: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-artifact-index.test.ts tests/event-store.test.ts
```

Expected: tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/services/job/job-projection.ts server/services/event/event-store.ts tests/checklist-artifact-index.test.ts tests/event-store.test.ts
git commit -m "Make checklist artifacts visible to event replay

Checklist-first verification requires acceptance, execution, evidence, and
checklist verdict artifacts to survive beyond phase diagnostics.

Confidence: high
Scope-risk: moderate
Tested: npm run build:node && npm run build:tests; checklist artifact index and event-store focused tests
Not-tested: full pipeline with real agents"
```

## Task 2: Add Checklist Contracts And Freshness Validation

**Files:**
- Create: `core/workflow/acceptance-checklist.ts`
- Create: `tests/acceptance-checklist-contract.test.ts`

- [ ] **Step 1: Write contract tests**

Create `tests/acceptance-checklist-contract.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateAcceptanceChecklist,
  validateChecklistVerdict,
  evaluateChecklistCompletion,
} from "../core/workflow/acceptance-checklist.js";

function checklist(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: "job-1",
    project: "flow",
    status: "frozen",
    source: { task: "add json output", issue: null, documents: [] },
    items: [
      {
        id: "AC-001",
        requirement: "cpb status supports --json",
        source: "user_task",
        required: true,
        area: "cli",
        risk: "medium",
        verificationMethod: "command",
        expectedEvidence: "exit 0 and JSON stdout",
        dependsOn: [],
        allowedFiles: ["cli/commands/status.ts"],
      },
    ],
    assumptions: [],
    ...overrides,
  };
}

const ledger = {
  schemaVersion: 1,
  jobId: "job-1",
  project: "flow",
  ledgerId: "evidence-ledger-001",
  finalWorktree: { head: "abc", diffHash: "sha256:one" },
  evidence: [
    {
      id: "EV-001",
      type: "command",
      command: "npm test",
      exitCode: 0,
      summary: "passed",
      worktreeHead: "abc",
      diffHash: "sha256:one",
    },
  ],
};

test("validateAcceptanceChecklist accepts a frozen required item", () => {
  assert.equal(validateAcceptanceChecklist(checklist()).ok, true);
});

test("validateAcceptanceChecklist rejects silently accepted high-risk assumptions", () => {
  const result = validateAcceptanceChecklist(checklist({
    assumptions: [{ id: "ASM-001", text: "Security behavior can change", risk: "high", acceptedForExecution: true }],
  }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /high-risk/i);
});

test("validateAcceptanceChecklist rejects non-normalized path fields", () => {
  const result = validateAcceptanceChecklist(checklist({
    items: [{ ...checklist().items[0], allowedFiles: ["/abs/path.ts", "../escape.ts"] }],
  }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /path/i);
});

test("validateChecklistVerdict rejects pass without evidence refs", () => {
  const verdict = {
    schemaVersion: 1,
    jobId: "job-1",
    status: "pass",
    items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [], actualResult: "looks correct", reason: "not enough", fixScope: [] }],
    blocking: [],
    fixScope: [],
    reason: "passed",
  };
  const result = validateChecklistVerdict(verdict, checklist());
  assert.equal(result.ok, false);
  assert.match(result.reason, /evidence/i);
});

test("validateChecklistVerdict rejects top-level pass when a required item is unchecked", () => {
  const verdict = {
    schemaVersion: 1,
    jobId: "job-1",
    status: "pass",
    items: [{ checklistId: "AC-001", result: "unchecked", evidenceRefs: [], actualResult: "", reason: "not run", fixScope: [] }],
    blocking: [],
    fixScope: [],
    reason: "wrong status",
  };
  const result = validateChecklistVerdict(verdict, checklist());
  assert.equal(result.ok, false);
  assert.match(result.reason, /status/i);
});

test("evaluateChecklistCompletion blocks stale evidence", () => {
  const staleLedger = {
    ...ledger,
    evidence: [{ ...ledger.evidence[0], diffHash: "sha256:old" }],
  };
  const verdict = {
    schemaVersion: 1,
    jobId: "job-1",
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
    ],
    blocking: [],
    fixScope: [],
    reason: "passed",
  };
  const result = evaluateChecklistCompletion({ checklist: checklist(), verdict, evidenceLedger: staleLedger, executionMap: { unmappedChangedFiles: [] } });
  assert.equal(result.outcome, "evidence_stale");
  assert.deepEqual(result.staleEvidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
});

test("evaluateChecklistCompletion blocks missing evidence refs", () => {
  const verdict = {
    schemaVersion: 1,
    jobId: "job-1",
    status: "pass",
    items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-missing" }], actualResult: "ok", reason: "ok", fixScope: [] }],
    blocking: [],
    fixScope: [],
    reason: "passed",
  };
  const result = evaluateChecklistCompletion({ checklist: checklist(), verdict, evidenceLedger: ledger, executionMap: { unmappedChangedFiles: [] } });
  assert.equal(result.outcome, "evidence_missing");
});

test("evaluateChecklistCompletion blocks poisoned runtime evidence", () => {
  const verdict = {
    schemaVersion: 1,
    jobId: "job-1",
    status: "pass",
    items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "ok", reason: "ok", fixScope: [] }],
    blocking: [],
    fixScope: [],
    reason: "passed",
  };
  const result = evaluateChecklistCompletion({
    checklist: checklist(),
    verdict,
    evidenceLedger: { ...ledger, evidence: [{ ...ledger.evidence[0], diffHash: "sha256:old", poisonedSession: true }] },
    executionMap: { unmappedChangedFiles: [] },
  });
  assert.equal(result.outcome, "poisoned_session");
  assert.deepEqual(result.poisonedEvidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
  assert.deepEqual(result.staleEvidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
});

test("evaluateChecklistCompletion blocks unresolved runtime failure events", () => {
  const verdict = {
    schemaVersion: 1,
    jobId: "job-1",
    status: "pass",
    items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "ok", reason: "ok", fixScope: [] }],
    blocking: [],
    fixScope: [],
    reason: "passed",
  };
  const result = evaluateChecklistCompletion({
    checklist: checklist(),
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{ type: "job_panic", phase: "verify", reason: "panic while writing artifact" }],
  });
  assert.equal(result.outcome, "runjob_panic");
  assert.deepEqual(result.runtimeFailureRefs, [{ type: "job_panic", phase: "verify", nodeId: null, reason: "panic while writing artifact" }]);
});

test("evaluateChecklistCompletion blocks unmapped execution changes", () => {
  const verdict = {
    schemaVersion: 1,
    jobId: "job-1",
    status: "pass",
    items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "ok", reason: "ok", fixScope: [] }],
    blocking: [],
    fixScope: [],
    reason: "passed",
  };
  const result = evaluateChecklistCompletion({
    checklist: checklist(),
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: ["core/engine/run-job.ts"] },
  });
  assert.equal(result.outcome, "scope_violation");
  assert.deepEqual(result.unmappedChangedFiles, ["core/engine/run-job.ts"]);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/acceptance-checklist-contract.test.ts
```

Expected: test fails because the contract module does not exist.

- [ ] **Step 3: Add contract implementation**

Create `core/workflow/acceptance-checklist.ts` with:

```ts
type AnyRecord = Record<string, any>;

const ITEM_RESULTS = new Set(["pass", "fail", "unchecked"]);
const TOP_STATUSES = new Set(["pass", "fail"]);
const RISK_VALUES = new Set(["low", "medium", "high"]);

function text(value: any) {
  return typeof value === "string" ? value.trim() : "";
}

function isRepoRelativePosixPath(value: any) {
  const path = text(value);
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

function fail(reason: string, details: AnyRecord = {}) {
  return { ok: false, reason, details };
}

function evidenceKey(ref: AnyRecord) {
  return `${text(ref.ledgerId)}:${text(ref.evidenceId)}`;
}

export function validateAcceptanceChecklist(checklist: AnyRecord) {
  if (!checklist || typeof checklist !== "object") return fail("checklist must be an object");
  if (checklist.schemaVersion !== 1) return fail("schemaVersion must be 1");
  if (!text(checklist.jobId)) return fail("jobId is required");
  if (!text(checklist.project)) return fail("project is required");
  if (checklist.status !== "frozen") return fail("checklist status must be frozen");
  if (!Array.isArray(checklist.items) || checklist.items.length === 0) return fail("items must be a non-empty array");
  for (const [index, assumption] of (Array.isArray(checklist.assumptions) ? checklist.assumptions : []).entries()) {
    if (assumption?.risk === "high" && assumption.acceptedForExecution === true) {
      return fail(`assumptions[${index}] high-risk assumption cannot be silently accepted`);
    }
  }
  const ids = new Set<string>();
  for (const [index, item] of checklist.items.entries()) {
    const prefix = `items[${index}]`;
    if (!text(item?.id)) return fail(`${prefix}.id is required`);
    if (ids.has(item.id)) return fail(`duplicate checklist id: ${item.id}`);
    ids.add(item.id);
    if (!text(item.requirement)) return fail(`${prefix}.requirement is required`);
    if (!text(item.source)) return fail(`${prefix}.source is required`);
    if (typeof item.required !== "boolean") return fail(`${prefix}.required must be boolean`);
    if (!text(item.area)) return fail(`${prefix}.area is required`);
    if (!RISK_VALUES.has(item.risk)) return fail(`${prefix}.risk must be low, medium, or high`);
    if (!text(item.verificationMethod)) return fail(`${prefix}.verificationMethod is required`);
    if (!text(item.expectedEvidence)) return fail(`${prefix}.expectedEvidence is required`);
    if (item.dependsOn !== undefined && !Array.isArray(item.dependsOn)) return fail(`${prefix}.dependsOn must be an array`);
    if (item.allowedFiles !== undefined && !Array.isArray(item.allowedFiles)) return fail(`${prefix}.allowedFiles must be an array`);
    for (const file of item.allowedFiles || []) {
      if (!isRepoRelativePosixPath(file)) return fail(`${prefix}.allowedFiles contains invalid repo-relative path`);
    }
  }
  return { ok: true, ids: [...ids] };
}

export function validateChecklistVerdict(verdict: AnyRecord, checklist: AnyRecord) {
  const checklistValidation = validateAcceptanceChecklist(checklist);
  if (!checklistValidation.ok) return checklistValidation;
  if (!verdict || typeof verdict !== "object") return fail("verdict must be an object");
  if (verdict.schemaVersion !== 1) return fail("verdict schemaVersion must be 1");
  if (!TOP_STATUSES.has(verdict.status)) return fail("verdict.status must be pass or fail");
  if (!Array.isArray(verdict.items)) return fail("verdict.items must be an array");
  const checklistIds = new Set(checklist.items.map((item: AnyRecord) => item.id));
  const requiredIds = new Set(checklist.items.filter((item: AnyRecord) => item.required).map((item: AnyRecord) => item.id));
  const seen = new Set<string>();
  let allRequiredPassed = true;
  for (const [index, item] of verdict.items.entries()) {
    const prefix = `items[${index}]`;
    const checklistId = text(item?.checklistId);
    if (!checklistId) return fail(`${prefix}.checklistId is required`);
    if (!checklistIds.has(checklistId)) return fail(`${prefix}.checklistId does not exist in checklist: ${checklistId}`);
    seen.add(checklistId);
    if (!ITEM_RESULTS.has(item.result)) return fail(`${prefix}.result must be pass, fail, or unchecked`);
    if (!Array.isArray(item.evidenceRefs)) return fail(`${prefix}.evidenceRefs must be an array`);
    if (item.result === "pass" && item.evidenceRefs.length === 0) return fail(`${prefix}.pass requires at least one evidence ref`);
    if (requiredIds.has(checklistId) && item.result !== "pass") allRequiredPassed = false;
    if (!text(item.reason)) return fail(`${prefix}.reason is required`);
    if (item.fixScope !== undefined && !Array.isArray(item.fixScope)) return fail(`${prefix}.fixScope must be an array`);
    for (const file of item.fixScope || []) {
      if (!isRepoRelativePosixPath(file)) return fail(`${prefix}.fixScope contains invalid repo-relative path`);
    }
  }
  const missingRequired = [...requiredIds].filter((id) => !seen.has(id));
  if (missingRequired.length > 0) return fail(`verdict missing required checklist ids: ${missingRequired.join(", ")}`, { missingRequired });
  if (verdict.status === "pass" && !allRequiredPassed) return fail("verdict.status pass requires every required item to pass");
  if (verdict.status === "fail" && allRequiredPassed) return fail("verdict.status fail conflicts with all required items passing");
  if (!Array.isArray(verdict.fixScope)) return fail("verdict.fixScope must be an array");
  for (const file of verdict.fixScope) {
    if (!isRepoRelativePosixPath(file)) return fail("verdict.fixScope contains invalid repo-relative path");
  }
  if (!text(verdict.reason)) return fail("verdict.reason is required");
  return { ok: true };
}

function checklistOutcome(outcome: string, reason: string, fields: AnyRecord = {}) {
  return {
    outcome,
    reason,
    failedChecklistIds: [],
    uncheckedChecklistIds: [],
    missingEvidenceRefs: [],
    staleEvidenceRefs: [],
    poisonedEvidenceRefs: [],
    runtimeFailureRefs: [],
    unmappedChangedFiles: [],
    ...fields,
  };
}

function normalizeRuntimeFailureRefs(runtimeFailures: unknown) {
  const allowed = new Set(["phase_poisoned_session", "poisoned_session", "job_panic", "runjob_panic"]);
  return (Array.isArray(runtimeFailures) ? runtimeFailures : [])
    .map((entry: AnyRecord) => {
      const type = text(entry?.type || entry?.kind || entry?.code);
      if (!allowed.has(type)) return null;
      return {
        type,
        phase: text(entry.phase) || null,
        nodeId: text(entry.nodeId) || null,
        reason: text(entry.reason) || null,
      };
    })
    .filter(Boolean);
}

export function evaluateChecklistCompletion({ checklist, verdict, evidenceLedger, executionMap, runtimeFailures }: AnyRecord) {
  const runtimeFailureRefs = normalizeRuntimeFailureRefs(runtimeFailures);
  if (runtimeFailureRefs.length > 0) {
    const hasPanic = runtimeFailureRefs.some((entry: AnyRecord) => entry.type === "job_panic" || entry.type === "runjob_panic");
    return checklistOutcome(hasPanic ? "runjob_panic" : "poisoned_session", "runtime failure event blocks checklist completion", { runtimeFailureRefs });
  }
  const validation = validateChecklistVerdict(verdict, checklist);
  if (!validation.ok) {
    return checklistOutcome("checklist_invalid", validation.reason);
  }
  const unmappedChangedFiles = Array.isArray(executionMap?.unmappedChangedFiles) ? executionMap.unmappedChangedFiles : [];
  if (unmappedChangedFiles.length > 0) {
    return checklistOutcome("scope_violation", "execution map contains unmapped changed files", { unmappedChangedFiles });
  }
  const ledgerId = text(evidenceLedger?.ledgerId);
  const finalHead = text(evidenceLedger?.finalWorktree?.head);
  const finalDiffHash = text(evidenceLedger?.finalWorktree?.diffHash);
  const evidenceByKey = new Map<string, AnyRecord>();
  for (const entry of Array.isArray(evidenceLedger?.evidence) ? evidenceLedger.evidence : []) {
    evidenceByKey.set(`${ledgerId}:${text(entry.id)}`, entry);
  }
  const failedChecklistIds: string[] = [];
  const uncheckedChecklistIds: string[] = [];
  const missingEvidenceRefs: AnyRecord[] = [];
  const staleEvidenceRefs: AnyRecord[] = [];
  const poisonedEvidenceRefs: AnyRecord[] = [];
  for (const item of verdict.items) {
    const checklistItem = checklist.items.find((entry: AnyRecord) => entry.id === item.checklistId);
    if (!checklistItem?.required) continue;
    if (item.result === "fail") failedChecklistIds.push(item.checklistId);
    if (item.result === "unchecked") uncheckedChecklistIds.push(item.checklistId);
    if (item.result === "pass") {
      for (const ref of item.evidenceRefs) {
        const entry = evidenceByKey.get(evidenceKey(ref));
        if (!entry) {
          missingEvidenceRefs.push(ref);
          continue;
        }
        if (text(entry.worktreeHead) !== finalHead || text(entry.diffHash) !== finalDiffHash) {
          staleEvidenceRefs.push(ref);
        }
        if (entry.poisonedSession === true) {
          poisonedEvidenceRefs.push(ref);
        }
      }
    }
  }
  const common = { failedChecklistIds, uncheckedChecklistIds, missingEvidenceRefs, staleEvidenceRefs, poisonedEvidenceRefs, unmappedChangedFiles };
  if (poisonedEvidenceRefs.length > 0) return checklistOutcome("poisoned_session", "pass verdict references poisoned-session evidence", common);
  if (failedChecklistIds.length > 0) return checklistOutcome("checklist_failed", "required checklist items failed", common);
  if (uncheckedChecklistIds.length > 0) return checklistOutcome("checklist_incomplete", "required checklist items were not checked", common);
  if (missingEvidenceRefs.length > 0) return checklistOutcome("evidence_missing", "pass verdict references missing evidence", common);
  if (staleEvidenceRefs.length > 0) return checklistOutcome("evidence_stale", "pass verdict references stale evidence", common);
  return checklistOutcome("complete", "all required checklist items passed with fresh evidence", common);
}
```

- [ ] **Step 4: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/acceptance-checklist-contract.test.ts
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/workflow/acceptance-checklist.ts tests/acceptance-checklist-contract.test.ts
git commit -m "Define checklist completion contracts before phase integration

Checklist-aware jobs need a deterministic contract for item results, evidence
freshness, and whole-verdict status before runtime phases can enforce it.

Confidence: high
Scope-risk: narrow
Tested: npm run build:node && npm run build:tests; acceptance checklist contract test
Not-tested: phase integration"
```

## Task 3: Generate And Persist Checklist Before DAG Materialization

**Files:**
- Modify: `core/engine/run-job.ts`
- Modify: `core/engine/dag-builder.ts` if node metadata is not preserved in the current implementation
- Create: `tests/checklist-prepare-dag.test.ts`

- [ ] **Step 1: Write prepare-time checklist ordering test**

Create `tests/checklist-prepare-dag.test.ts`:

```ts
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { runJob } from "../core/engine/run-job.js";
import { tempRoot } from "./helpers.js";

function jsonEnvelope(data: Record<string, any>) {
  return "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}

function checklist() {
  return {
    schemaVersion: 1,
    jobId: "job-checklist",
    project: "flow",
    status: "frozen",
    source: { task: "task", issue: null, documents: [] },
    items: [
      {
        id: "AC-001",
        requirement: "README is updated",
        source: "user_task",
        required: true,
        area: "docs",
        risk: "low",
        verificationMethod: "static",
        expectedEvidence: "README diff contains requested text",
        dependsOn: [],
        allowedFiles: ["README.md"],
      },
    ],
    assumptions: [],
  };
}

test("prepare-time checklist is artifacted before workflow DAG materialization", async () => {
  const cpbRoot = await tempRoot("cpb-checklist-prepare");
  const sourcePath = await tempRoot("cpb-checklist-source");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
  const events: Record<string, any>[] = [];
  const pool = {
    async execute(_agent: string, _prompt: string, _cwd: string, _timeoutMs: number, meta: Record<string, any>) {
      if (meta.role === "planner") return { output: jsonEnvelope({ status: "ok", planMarkdown: "## Analysis\n- ok\n\n## Files to modify\n- README.md\n\n## Implementation Steps\n1. edit\n\n## Testing\n- npm test\n\n## Risks\n- none" }), providerKey: "fake", variant: null };
      if (meta.role === "executor") return { output: jsonEnvelope({ status: "ok", summary: "done", tests: [], risks: [], checklistMapping: [] }), providerKey: "fake", variant: null };
      return { output: jsonEnvelope({ status: "ok", verdict: "pass", reason: "legacy", details: "ok", confidence: 1 }), providerKey: "fake", variant: null };
    },
    async releaseWorktree() { return true; },
  };

  await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "task",
    jobId: "job-checklist",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: { planner: "fake", executor: "fake", verifier: "fake" },
    prepareTask: async () => ({ phases: ["plan", "execute", "verify"], riskMap: { riskLevel: "low" }, acceptanceChecklist: checklist() }),
    createJob: async () => ({ jobId: "job-checklist" }),
    startJob: async () => ({}),
    checkpointJob: async () => ({}),
    completePhase: async () => ({}),
    completeJob: async () => ({}),
    failJob: async () => ({}),
    blockJob: async () => ({}),
    appendEvent: async (_root: string, _project: string, _jobId: string, event: Record<string, any>) => { events.push(event); },
    reportProgress: async () => ({}),
    getPool: () => pool,
  });

  const artifactIndex = events.findIndex((event) => event.type === "artifact_created" && event.kind === "acceptance-checklist");
  const dagIndex = events.findIndex((event) => event.type === "workflow_dag_materialized");
  assert.ok(artifactIndex >= 0, "acceptance-checklist artifact event should exist");
  assert.ok(dagIndex > artifactIndex, "workflow DAG must be materialized after checklist artifact");
  const dag = events[dagIndex].workflowDag;
  assert.deepEqual(dag.nodes.find((node: Record<string, any>) => node.phase === "execute").checklistIds, ["AC-001"]);
  assert.deepEqual(dag.nodes.find((node: Record<string, any>) => node.phase === "verify").checklistIds, ["AC-001"]);
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-prepare-dag.test.ts
```

Expected: test fails because prepare-time checklist is not persisted or attached to DAG nodes.

- [ ] **Step 3: Persist checklist in run-job after prepareTask**

In `core/engine/run-job.ts`, import:

```ts
import { writeArtifact } from "../artifacts/artifact-store.js";
import { validateAcceptanceChecklist } from "../workflow/acceptance-checklist.js";
```

Add helper:

```ts
async function writeRuntimeArtifactEvent({ cpbRoot, project, jobId, dataRoot, phase, artifact, appendEvent }: AnyRecord) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "artifact_created",
    jobId,
    project,
    phase,
    kind: artifact.kind,
    artifactKind: artifact.kind,
    artifact: artifact.name,
    artifactId: artifact.id,
    sha256: artifact.sha256 || null,
    ts: ts(),
  });
}
```

After `prepareTask` returns and before `workflowDag` is built:

```ts
let acceptanceChecklist = prepareResult?.acceptanceChecklist || null;
let acceptanceChecklistArtifact = null;
if (acceptanceChecklist) {
  const validation = validateAcceptanceChecklist(acceptanceChecklist);
  if (!validation.ok) {
    const fail = failure({
      kind: FailureKind.ARTIFACT_INVALID,
      phase: "prepare_task",
      reason: `acceptance checklist invalid: ${validation.reason}`,
      retryable: false,
      cause: { acceptanceChecklist },
    });
    await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail });
    return { status: "blocked", jobId, exitCode: 2, failure: fail };
  }
  acceptanceChecklistArtifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "acceptance-checklist",
    content: JSON.stringify(acceptanceChecklist, null, 2),
    dataRoot,
    metadata: acceptanceChecklist,
  });
  await writeRuntimeArtifactEvent({ cpbRoot, project, jobId, dataRoot, phase: "prepare_task", artifact: acceptanceChecklistArtifact, appendEvent });
  phaseSourceContext = { ...phaseSourceContext, acceptanceChecklist, acceptanceChecklistArtifact };
}
```

Also move `dynamicAgentPlan` materialization until after this block. If `prepareResult.dynamicAgentPlan` or source context already provided a dynamic plan, accept it only when it references the same `acceptanceChecklistArtifact.name` (or equivalent `acceptanceChecklistArtifactId`) that was just event-indexed; otherwise rebuild it from the frozen checklist or fail closed with `ARTIFACT_INVALID`. Do not let an unartifacted `sourceContext.acceptanceChecklist` shape the same-run DAG.

- [ ] **Step 4: Attach grouped checklist ids to workflow DAG**

Add helper:

```ts
function attachChecklistIdsToWorkflowDag(workflowDag: AnyRecord, acceptanceChecklist: AnyRecord | null) {
  if (!acceptanceChecklist?.items?.length) return workflowDag;
  const requiredIds = acceptanceChecklist.items.filter((item: AnyRecord) => item.required).map((item: AnyRecord) => item.id);
  return {
    ...workflowDag,
    nodes: workflowDag.nodes.map((node: AnyRecord) => {
      if (node.phase === "execute" || node.phase === "verify" || node.phase === "adversarial_verify") {
        return { ...node, checklistIds: requiredIds };
      }
      if (node.sideEffecting || node.phase === "remediate" || node.phase === "review") {
        return { ...node, checklistIds: node.checklistNeutral ? [] : requiredIds };
      }
      return node;
    }),
  };
}
```

Change:

```ts
const workflowDag = buildWorkflowDag({ workflow, phases, phaseRoleMap });
```

to:

```ts
const workflowDag = attachChecklistIdsToWorkflowDag(buildWorkflowDag({ workflow, phases, phaseRoleMap }), acceptanceChecklist);
```

- [ ] **Step 5: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-prepare-dag.test.ts tests/engine-run-job.test.ts
```

Expected: prepare/DAG test passes and existing engine tests continue to pass.

Add negative assertions before this task is considered complete:

- `workflow_dag_materialized` must occur after `acceptance-checklist artifact_created`.
- A prebuilt `dynamicAgentPlan` that does not reference the frozen checklist artifact is rejected or rebuilt.
- A checklist-aware custom mutating node without `checklistIds` and without `checklistNeutral: true` fails DAG validation.

- [ ] **Step 6: Commit**

```bash
git add core/engine/run-job.ts tests/checklist-prepare-dag.test.ts
git commit -m "Freeze checklist before workflow DAG materialization

Checklist ids must exist before DAG metadata and dynamic routing are generated,
so prepare-time checklist artifacts now become the task contract.

Confidence: medium
Scope-risk: moderate
Tested: checklist prepare DAG test; engine run-job focused tests
Not-tested: real issue triage checklist quality"
```

## Task 4: Preserve Checklist Payloads In Agent Envelopes

**Files:**
- Modify: `core/agents/response-parser.ts`
- Create: `tests/checklist-response-parser.test.ts`

- [ ] **Step 1: Write parser tests**

Create `tests/checklist-response-parser.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseExecutorJson, parseVerifierJson } from "../core/agents/response-parser.js";

function envelope(data: Record<string, any>) {
  return "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}

test("parseExecutorJson keeps checklistMapping when present", () => {
  const parsed = parseExecutorJson(envelope({
    status: "ok",
    summary: "Updated CLI JSON output",
    tests: ["node --test tests/status-command.test.js"],
    risks: [],
    checklistMapping: [
      { checklistId: "AC-001", changedFiles: ["cli/commands/status.ts"], executorClaim: "Added JSON output", notes: "Plain text unchanged" },
    ],
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.checklistMapping[0].checklistId, "AC-001");
});

test("parseVerifierJson keeps checklist verdict payload when present", () => {
  const parsed = parseVerifierJson(envelope({
    status: "ok",
    verdict: "fail",
    reason: "missing evidence",
    details: "AC-002 was not checked",
    confidence: 0.8,
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-1",
      status: "fail",
      items: [],
      blocking: [],
      fixScope: ["cli/commands/status.ts"],
      reason: "missing evidence",
    },
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "fail");
  assert.deepEqual(parsed.checklistVerdict.fixScope, ["cli/commands/status.ts"]);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-response-parser.test.ts
```

Expected: tests fail because parser drops checklist payloads.

- [ ] **Step 3: Preserve payloads**

Modify `parseExecutorJson`:

```ts
return {
  ok: true,
  summary: result.data.summary || "",
  tests: result.data.tests || [],
  risks: result.data.risks || [],
  checklistMapping: Array.isArray(result.data.checklistMapping) ? result.data.checklistMapping : [],
};
```

Modify `parseVerifierJson`:

```ts
return {
  ok: true,
  status: verdict,
  reason: result.data.reason || "",
  details: result.data.details || "",
  confidence: result.data.confidence,
  checklistVerdict: result.data.checklistVerdict || null,
};
```

- [ ] **Step 4: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-response-parser.test.ts tests/engine-run-job.test.ts
```

Expected: parser tests pass and legacy engine tests keep passing.

- [ ] **Step 5: Commit**

```bash
git add core/agents/response-parser.ts tests/checklist-response-parser.test.ts
git commit -m "Preserve checklist payloads in agent responses

Executor and verifier envelopes need to carry structured checklist state while
legacy response contracts remain valid.

Confidence: high
Scope-risk: narrow
Tested: checklist response parser; engine run-job focused tests
Not-tested: provider prompt adherence"
```

## Task 5: Make Plan Consume The Frozen Checklist

**Files:**
- Modify: `core/phases/plan.ts`
- Modify: `tests/checklist-prepare-dag.test.ts`

- [ ] **Step 1: Add prompt contract assertion**

Extend `tests/checklist-prepare-dag.test.ts` to capture planner prompt and assert it includes `AC-001` and states that the checklist is frozen.

```ts
let plannerPrompt = "";
// inside pool.execute
if (meta.role === "planner") {
  plannerPrompt = _prompt;
  return { output: jsonEnvelope({ status: "ok", planMarkdown: "## Analysis\n- ok\n\n## Files to modify\n- README.md\n\n## Implementation Steps\n1. edit\n\n## Testing\n- npm test\n\n## Risks\n- none" }), providerKey: "fake", variant: null };
}
// after runJob
assert.match(plannerPrompt, /AC-001/);
assert.match(plannerPrompt, /frozen acceptance checklist/i);
```

- [ ] **Step 2: Update plan prompt**

In `core/phases/plan.ts`, add checklist context to `buildPlanPrompt`:

```ts
const checklist = ctx.sourceContext?.acceptanceChecklist;
const checklistSection = checklist
  ? `\n\n## Frozen Acceptance Checklist\nThis checklist is the task contract. Do not silently mutate it. If it is wrong, report the issue in the plan risks.\n\n${JSON.stringify(checklist, null, 2)}`
  : "";
```

Append `${checklistSection}` before task details.

- [ ] **Step 3: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-prepare-dag.test.ts
```

Expected: planner prompt includes the frozen checklist.

- [ ] **Step 4: Commit**

```bash
git add core/phases/plan.ts tests/checklist-prepare-dag.test.ts
git commit -m "Make planning consume the frozen checklist contract

The plan phase now works from prepare-time acceptance criteria rather than
creating the same-run task contract itself.

Confidence: medium
Scope-risk: narrow
Tested: checklist prepare DAG focused test
Not-tested: planner quality across ambiguous issues"
```

## Task 6: Persist Execution Map As An Event-Visible Artifact

**Files:**
- Modify: `core/phases/execute.ts`
- Modify: `core/engine/run-job.ts`
- Create: `tests/checklist-execution-map.test.ts`

- [ ] **Step 1: Write execution map persistence test**

Create `tests/checklist-execution-map.test.ts` with a runJob fixture where executor returns `checklistMapping`. Capture events, build the artifact index, read the artifact JSON, and assert content rather than event presence only.

```ts
const event = events.find((entry) => entry.type === "artifact_created" && entry.kind === "execution-map");
assert.ok(event);
const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
const entry = index.entries.find((artifact) => artifact.kind === "execution-map");
assert.ok(entry?.path);
const executionMap = JSON.parse(await readFile(entry.path, "utf8"));
assert.deepEqual(executionMap.mappings[0].checklistId, "AC-001");
assert.deepEqual(executionMap.changedFiles, ["README.md"]);
assert.deepEqual(executionMap.unmappedChangedFiles, []);
```

Add a negative case where a changed production file is not included in any mapping. The JSON must include it in `unmappedChangedFiles`; the test must fail if `unmappedChangedFiles` is hard-coded to `[]`.

- [ ] **Step 2: Persist execution-map from execute phase**

In `core/phases/execute.ts`, after changed files are computed:

```ts
const normalizedChangedFiles = normalizeRepoRelativePaths(stripGitStatusPrefix(changedFiles));
const mappedFiles = normalizeRepoRelativePaths((parsed.checklistMapping || []).flatMap((entry) => entry.changedFiles || []));
const executionMap = {
  schemaVersion: 1,
  jobId,
  project,
  mappings: parsed.checklistMapping || [],
  changedFiles: normalizedChangedFiles,
  unmappedChangedFiles: normalizedChangedFiles.filter((file) => !mappedFiles.includes(file)),
};
const executionMapArtifact = await writeArtifact(cpbRoot, {
  project,
  jobId,
  kind: "execution-map",
  content: JSON.stringify(executionMap, null, 2),
  dataRoot,
  metadata: executionMap,
});
```

Return it in diagnostics:

```ts
diagnostics: withPromptArtifactDiagnostics({ ...agentResult.diagnostics, executionMapArtifact }, promptArtifact),
```

- [ ] **Step 3: Emit side artifact events in run-job**

In `core/engine/run-job.ts`, emit events for every persisted side artifact before returning any phase result, including failed or blocked checklist-aware phases. Diagnostics may carry artifact handles, but the event-indexed artifact JSON is the durable source.

```ts
for (const artifact of Object.values(result.diagnostics || {}).filter((value: any) => value?.kind && value?.name)) {
  if (artifact.name === result.artifact?.name) continue;
  await writeRuntimeArtifactEvent({ cpbRoot, project, jobId, dataRoot, phase, artifact, appendEvent });
}
```

This makes phase-produced side artifacts durable through event replay. Do not use diagnostics themselves as completion or audit facts.

- [ ] **Step 4: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-execution-map.test.ts tests/checklist-artifact-index.test.ts
```

Expected: execution map event exists, artifact index recognizes it, artifact JSON preserves mappings and normalized paths, and unmapped changed files are not hidden.

- [ ] **Step 5: Commit**

```bash
git add core/phases/execute.ts core/engine/run-job.ts tests/checklist-execution-map.test.ts
git commit -m "Persist execution maps as event-visible artifacts

Execution mappings connect changed files back to acceptance items and must
survive event replay rather than living only in phase diagnostics.

Confidence: medium
Scope-risk: moderate
Tested: checklist execution map and artifact index tests, including unmapped-file enforcement
Not-tested: full provider-generated checklist mapping quality"
```

## Task 7: Persist Evidence Ledger And Checklist Verdict

**Files:**
- Modify: `core/phases/verify.ts`
- Create: `tests/checklist-verifier-gate.test.ts`

- [ ] **Step 1: Write verifier gate tests**

Create `tests/checklist-verifier-gate.test.ts` with two cases:

- checklist-aware job with legacy verifier pass and no `checklistVerdict` fails with `VERDICT_INVALID` and still emits event-visible `evidence-ledger` plus a synthesized failing `checklist-verdict`
- checklist-aware job with `checklistVerdict` and fresh evidence passes verify and emits `evidence-ledger` plus `checklist-verdict` artifact events

Assert event visibility and replayability, not diagnostics only:

```ts
assert.ok(events.some((event) => event.type === "artifact_created" && event.kind === "evidence-ledger"));
assert.ok(events.some((event) => event.type === "artifact_created" && event.kind === "checklist-verdict"));
const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
const verdictEntry = index.entries.find((entry) => entry.kind === "checklist-verdict");
assert.ok(verdictEntry?.path);
const persistedVerdict = JSON.parse(await readFile(verdictEntry.path, "utf8"));
assert.equal(persistedVerdict.status, "fail");
```

- [ ] **Step 2: Build evidence ledger with finalWorktree**

In `core/phases/verify.ts`, import:

```ts
import { createHash } from "node:crypto";
import { validateChecklistVerdict } from "../workflow/acceptance-checklist.js";
```

Extend `collectGitEvidence` initial object with:

```ts
head: null,
diffHash: null,
```

Set them after `git diff`:

```ts
const head = await git(cwd, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "" }));
evidence.head = head.stdout.trim() || null;
evidence.diffHash = diff.stdout ? `sha256:${createHash("sha256").update(diff.stdout).digest("hex")}` : "sha256:empty";
```

Create ledger:

```ts
function buildEvidenceLedger({ jobId, project, verificationEvidence, ledgerId }: any) {
  const finalWorktree = {
    head: verificationEvidence.git?.head || null,
    diffHash: verificationEvidence.git?.diffHash || null,
  };
  const evidence = [];
  let index = 1;
  for (const check of verificationEvidence.hardGate?.checks || []) {
    evidence.push({
      id: `EV-${String(index++).padStart(3, "0")}`,
      type: "command",
      command: check.command || check.gate,
      exitCode: check.ok ? 0 : check.exitCode ?? 1,
      summary: check.ok ? `${check.gate || check.command} passed` : check.reason || `${check.gate || check.command} failed`,
      worktreeHead: finalWorktree.head,
      diffHash: finalWorktree.diffHash,
      ...(check.poisonedSession === true ? { poisonedSession: true, poisonedReasons: check.poisonedReasons || [] } : {}),
    });
  }
  return { schemaVersion: 1, jobId, project, ledgerId, finalWorktree, evidence };
}
```

Ledger-level `poisonedSession` is only a mirror for verifier-collected command evidence. Runtime-classified `phase_poisoned_session` and `job_panic` events are authoritative and are collected by the completion gate from event replay in Task 8.

- [ ] **Step 3: Persist evidence ledger and checklist verdict**

When `acceptanceChecklist` exists in `ctx.sourceContext`, require an event-visible `checklist-verdict`. If the verifier omits or returns an invalid `checklistVerdict`, synthesize a failing verdict with every required item marked `unchecked`, persist it, emit its `artifact_created` event, and then return `phaseFailed`.

Choose the ledger id before writing the artifact so artifact JSON, evidence refs, and metadata cannot diverge:

```ts
const ledgerId = `evidence-ledger-${jobId}-${Date.now()}`;
const evidenceLedger = buildEvidenceLedger({ jobId, project, verificationEvidence, ledgerId });
const evidenceLedgerArtifact = await writeArtifact(cpbRoot, {
  project,
  jobId,
  kind: "evidence-ledger",
  content: JSON.stringify(evidenceLedger, null, 2),
  dataRoot,
  metadata: evidenceLedger,
});
```

Validate and persist checklist verdict:

```ts
if (acceptanceChecklist) {
  const checklistVerdict = verdict.checklistVerdict || synthesizeUncheckedChecklistVerdict({
    jobId,
    acceptanceChecklist,
    reason: "checklist-aware job requires checklistVerdict",
  });
  const verdictValidation = validateChecklistVerdict(checklistVerdict, acceptanceChecklist);
  const persistedChecklistVerdict = verdictValidation.ok ? checklistVerdict : synthesizeUncheckedChecklistVerdict({
    jobId,
    acceptanceChecklist,
    reason: verdictValidation.reason,
  });
  const checklistVerdictArtifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "checklist-verdict",
    content: JSON.stringify(persistedChecklistVerdict, null, 2),
    dataRoot,
    metadata: persistedChecklistVerdict,
  });
  if (!verdictValidation.ok) {
    return phaseFailed({ phase: "verify", failure: failure({ kind: FailureKind.VERDICT_INVALID, phase: "verify", reason: verdictValidation.reason, retryable: true, cause: { checklistVerdict: persistedChecklistVerdict } }), diagnostics: withPromptArtifactDiagnostics({ ...agentResult.diagnostics, evidenceLedgerArtifact, checklistVerdictArtifact }, promptArtifact) });
  }
}
```

Return `evidenceLedgerArtifact` and `checklistVerdictArtifact` handles in diagnostics so the run-job side-artifact event emission records them before returning success or failure. Completion and audit must later read the artifact JSON through artifact events/index, not these diagnostics handles.

- [ ] **Step 4: Add verifier prompt context**

In `buildVerifyPrompt`, add:

```text
This is a checklist-aware job. You MUST return checklistVerdict. Cover every required checklist id. A pass item must cite evidenceRefs from the evidence ledger. Do not use executor summary as pass evidence.
```

- [ ] **Step 5: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-verifier-gate.test.ts tests/engine-provider-event.test.ts
```

Expected: checklist-aware legacy pass fails, checklist verdict pass emits artifacts, existing provider event tests keep passing.

- [ ] **Step 6: Commit**

```bash
git add core/phases/verify.ts tests/checklist-verifier-gate.test.ts
git commit -m "Require checklist verdicts with fresh evidence ledgers

Checklist-aware verification now produces evidence and itemized verdict
artifacts that completion can audit independently of executor claims.

Confidence: medium
Scope-risk: moderate
Tested: checklist verifier gate; engine provider event focused tests
Not-tested: real verifier prompt adherence"
```

## Task 8: Gate Completion On Checklist State

**Files:**
- Modify: `core/engine/completion-gate.ts`
- Modify: `core/engine/run-job.ts`
- Modify: `server/services/event/event-store.ts`
- Create: `tests/checklist-completion-gate.test.ts`

- [ ] **Step 1: Add pure and materialized gate tests**

Create `tests/checklist-completion-gate.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateCompletionGate, completionGateEvent } from "../core/engine/completion-gate.js";
import { materializeJob } from "../server/services/event/event-store.js";

test("completion gate blocks stale checklist evidence", () => {
  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    checklist: {
      schemaVersion: 1,
      jobId: "job-1",
      project: "flow",
      status: "frozen",
      source: { task: "task", issue: null, documents: [] },
      items: [{ id: "AC-001", requirement: "required behavior", source: "user_task", required: true, area: "cli", risk: "medium", verificationMethod: "command", expectedEvidence: "command output", dependsOn: [], allowedFiles: [] }],
      assumptions: [],
    },
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-1",
      status: "pass",
      items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "ok", reason: "ok", fixScope: [] }],
      blocking: [],
      fixScope: [],
      reason: "ok",
    },
    evidenceLedger: {
      ledgerId: "evidence-ledger-001",
      finalWorktree: { head: "abc", diffHash: "sha256:new" },
      evidence: [{ id: "EV-001", worktreeHead: "abc", diffHash: "sha256:old" }],
    },
    executionMap: {
      schemaVersion: 1,
      mappings: [{ checklistId: "AC-001", changedFiles: ["cli/commands/status.ts"] }],
      changedFiles: ["cli/commands/status.ts"],
      unmappedChangedFiles: [],
    },
  });
  assert.equal(result.outcome, "evidence_stale");
});

test("completion gate blocks unresolved runtime failures", () => {
  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    checklist: { schemaVersion: 1, jobId: "job-1", project: "flow", status: "frozen", source: { task: "task", issue: null, documents: [] }, items: [{ id: "AC-001", requirement: "required behavior", source: "user_task", required: true, area: "runtime", risk: "high", verificationMethod: "runtime_event", expectedEvidence: "no runtime failure event", dependsOn: [], allowedFiles: [] }], assumptions: [] },
    checklistVerdict: { schemaVersion: 1, jobId: "job-1", status: "pass", items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "ok", reason: "ok", fixScope: [] }], blocking: [], fixScope: [], reason: "ok" },
    evidenceLedger: { ledgerId: "evidence-ledger-001", finalWorktree: { head: "abc", diffHash: "sha256:one" }, evidence: [{ id: "EV-001", worktreeHead: "abc", diffHash: "sha256:one" }] },
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{ type: "phase_poisoned_session", phase: "verify", nodeId: "verify", reason: "provider output was poisoned" }],
  });
  assert.equal(result.outcome, "poisoned_session");
  assert.equal(result.details.checklist.runtimeFailureRefs[0].type, "phase_poisoned_session");
});

test("completion gate event preserves checklist fields in materialized state", () => {
  const event = completionGateEvent("job-1", "flow", {
    outcome: "checklist_failed",
    reason: "required checklist items failed",
    missingGates: ["checklist"],
    details: {
      checklist: {
        outcome: "checklist_failed",
        failedChecklistIds: ["AC-002"],
        uncheckedChecklistIds: [],
        missingEvidenceRefs: [],
        staleEvidenceRefs: [],
        poisonedEvidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }],
        runtimeFailureRefs: [{ type: "phase_poisoned_session", phase: "verify", nodeId: "verify", reason: "provider output was poisoned" }],
        unmappedChangedFiles: [],
      },
    },
  });
  const state = materializeJob([event]);
  assert.equal(state.completionGate.checklistOutcome, "checklist_failed");
  assert.deepEqual(state.completionGate.failedChecklistIds, ["AC-002"]);
  assert.equal(state.completionGate.runtimeFailureCount, 1);
});
```

Add integration-style negative cases:

- A checklist-aware job with `phaseSourceContext` and diagnostics claiming pass, but no `acceptance-checklist artifact_created`, must not complete through the checklist path.
- A checklist-aware `workflow: "readonly"` or `planMode: "none"` job with an event-indexed `acceptance-checklist` and legacy `VERDICT: PASS`, but no `checklist-verdict`, must fail the checklist gate instead of using legacy fallback.
- Clearing phase diagnostics after artifacts are emitted must not change completion output; the gate must replay from artifact events, artifact index, and artifact JSON.
- `artifactsByKind` without a readable artifact JSON file must fail closed as `artifact_invalid`.
- `execution-map.unmappedChangedFiles` non-empty must block completion even when every checklist item is `pass` and evidence is fresh.
- An unresolved `phase_poisoned_session` or `job_panic` event for the completed attempt must block completion even when every checklist artifact is valid and fresh.

- [ ] **Step 2: Extend completion gate**

In `core/engine/completion-gate.ts`, import:

```ts
import { evaluateChecklistCompletion } from "../workflow/acceptance-checklist.js";
```

Add optional args:

```ts
checklist,
checklistVerdict,
evidenceLedger,
executionMap,
runtimeFailures,
```

Before legacy verdict pass/fail check:

```ts
if (checklist) {
  const checklistResult = evaluateChecklistCompletion({ checklist, verdict: checklistVerdict, evidenceLedger, executionMap, runtimeFailures });
  if (checklistResult.outcome !== "complete") {
    return gateResult(checklistResult.outcome, checklistResult.reason, ["checklist"], {
      ...details,
      checklist: checklistResult,
    });
  }
}
```

Extend `completionGateEvent`:

```ts
const checklist = gateResult.details?.checklist || {};
return {
  type: "completion_gate_evaluated",
  jobId,
  project,
  outcome: gateResult.outcome,
  reason: gateResult.reason,
  missingGates: gateResult.missingGates,
  checklistOutcome: checklist.outcome || null,
  failedChecklistIds: checklist.failedChecklistIds || [],
  uncheckedChecklistIds: checklist.uncheckedChecklistIds || [],
  missingEvidenceRefs: checklist.missingEvidenceRefs || [],
  staleEvidenceRefs: checklist.staleEvidenceRefs || [],
  poisonedEvidenceRefs: checklist.poisonedEvidenceRefs || [],
  runtimeFailureRefs: checklist.runtimeFailureRefs || [],
  runtimeFailureCount: Array.isArray(checklist.runtimeFailureRefs) ? checklist.runtimeFailureRefs.length : 0,
  unmappedChangedFiles: checklist.unmappedChangedFiles || [],
  unmappedChangedFileCount: Array.isArray(checklist.unmappedChangedFiles) ? checklist.unmappedChangedFiles.length : 0,
  ts: new Date().toISOString(),
};
```

- [ ] **Step 3: Feed artifacts from run-job**

In `core/engine/run-job.ts`, load checklist gate inputs from event-visible artifact JSON only. Use a helper that selects the latest `artifact_created` event for each checklist kind, resolves it through the artifact index/path, verifies the content hash when available, and parses JSON:

```ts
const checklistArtifacts = await readChecklistArtifactsFromEventIndex({
  cpbRoot,
  dataRoot,
  project,
  jobId,
  requiredKinds: ["acceptance-checklist", "execution-map", "evidence-ledger", "checklist-verdict"],
});
const acceptanceChecklist = checklistArtifacts["acceptance-checklist"];
const executionMap = checklistArtifacts["execution-map"];
const checklistVerdict = checklistArtifacts["checklist-verdict"];
const evidenceLedger = checklistArtifacts["evidence-ledger"];
const runtimeFailures = await readRuntimeFailureRefsFromEventReplay({
  cpbRoot,
  dataRoot,
  project,
  jobId,
  eventTypes: ["phase_poisoned_session", "job_panic"],
  failureKinds: ["poisoned_session", "runjob_panic"],
});
```

Pass artifact inputs and `runtimeFailures` to `evaluateCompletionGate`.

Do not use `phaseSourceContext`, phase diagnostics, prompt text, legacy parsed verdict, or artifact metadata as authoritative checklist inputs. They may remain in process only as handles or compatibility context.
Do not allow fresh artifact JSON to clear runtime failures. Only retry attempt boundaries or explicit recovery events may make older runtime failures irrelevant, and V1 should fail closed if attempt ownership is ambiguous.
The checklist-aware branch is selected by readable event-indexed `acceptance-checklist`, not by mutating/non-mutating workflow classification. Legacy verdict fallback runs only when no readable acceptance checklist artifact exists.

- [ ] **Step 4: Materialize checklist gate fields**

In `server/services/event/event-store.ts`, update `completion_gate_evaluated` reducer:

```ts
completion_gate_evaluated(state, event) {
  state.completionGate = {
    outcome: event.outcome ?? null,
    reason: event.reason ?? null,
    missingGates: Array.isArray(event.missingGates) ? event.missingGates : [],
    checklistOutcome: event.checklistOutcome ?? null,
    failedChecklistIds: Array.isArray(event.failedChecklistIds) ? event.failedChecklistIds : [],
    uncheckedChecklistIds: Array.isArray(event.uncheckedChecklistIds) ? event.uncheckedChecklistIds : [],
    missingEvidenceRefs: Array.isArray(event.missingEvidenceRefs) ? event.missingEvidenceRefs : [],
    staleEvidenceRefs: Array.isArray(event.staleEvidenceRefs) ? event.staleEvidenceRefs : [],
    poisonedEvidenceRefs: Array.isArray(event.poisonedEvidenceRefs) ? event.poisonedEvidenceRefs : [],
    runtimeFailureRefs: Array.isArray(event.runtimeFailureRefs) ? event.runtimeFailureRefs : [],
    runtimeFailureCount: Number.isFinite(event.runtimeFailureCount) ? event.runtimeFailureCount : 0,
    unmappedChangedFiles: Array.isArray(event.unmappedChangedFiles) ? event.unmappedChangedFiles : [],
    unmappedChangedFileCount: Number.isFinite(event.unmappedChangedFileCount) ? event.unmappedChangedFileCount : 0,
    evaluatedAt: event.ts ?? null,
  };
}
```

- [ ] **Step 5: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-completion-gate.test.ts tests/engine-run-job.test.ts tests/event-store.test.ts
```

Expected: checklist gate tests pass and legacy completion tests continue passing.

- [ ] **Step 6: Commit**

```bash
git add core/engine/completion-gate.ts core/engine/run-job.ts server/services/event/event-store.ts tests/checklist-completion-gate.test.ts
git commit -m "Gate checklist-aware jobs on fresh item evidence

Completion now evaluates itemized checklist verdicts and preserves checklist
failure details in replayed job state.

Confidence: medium
Scope-risk: moderate
Tested: checklist completion gate; engine run-job and event-store focused tests
Not-tested: audit UI rendering of checklist gate fields"
```

## Task 9: Route Retry With Checklist Targets And File Scope

**Files:**
- Modify: `server/orchestrator/reconciler.ts`
- Modify: `server/orchestrator/failure-router.ts`
- Modify: `core/engine/run-job.ts`
- Create: `tests/checklist-retry-routing.test.ts`
- Modify: `tests/assignment-reconciler.test.ts`

- [ ] **Step 1: Add retry tests**

Create `tests/checklist-retry-routing.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { FailureRouter } from "../server/orchestrator/failure-router.js";

test("failure router retries checklist failure with file fix scope", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "AC-002 failed",
        cause: {
          verdict: {
            checklistVerdict: {
              items: [{ checklistId: "AC-002", result: "fail", fixScope: ["cli/commands/status.ts"] }],
              fixScope: ["cli/commands/status.ts"],
            },
          },
        },
      },
    },
  });
  assert.equal(decision.action, "retry_same_worker");
  assert.equal(decision.retryable, true);
});

test("failure router does not execute-retry checklist failure without file scope", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "AC-002 failed",
        cause: { verdict: { checklistVerdict: { items: [{ checklistId: "AC-002", result: "fail", fixScope: [] }], fixScope: [] } } },
      },
    },
  });
  assert.equal(decision.action, "mark_failed");
});

test("failure router can retry verifier for missing evidence without file scope", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "AC-003 evidence missing",
        cause: {
          routingLabel: "evidence_missing",
          retryPhase: "verify",
          targetChecklistIds: ["AC-003"],
          fixScope: [],
        },
      },
    },
  });
  assert.equal(decision.action, "retry_same_worker");
  assert.equal(decision.retryPhase, "verify");
  assert.equal(decision.retryable, true);
});
```

- [ ] **Step 2: Extract checklist retry state in reconciler**

In `server/orchestrator/reconciler.ts`, extend compact verdict with:

```ts
const checklistItems = Array.isArray(verdict.checklistVerdict?.items) ? verdict.checklistVerdict.items : [];
const failedChecklistIds = checklistItems.filter((item) => item.result === "fail").map((item) => item.checklistId).filter(Boolean);
const uncheckedChecklistIds = checklistItems.filter((item) => item.result === "unchecked").map((item) => item.checklistId).filter(Boolean);
const passedChecklistIds = checklistItems.filter((item) => item.result === "pass").map((item) => item.checklistId).filter(Boolean);
const previousEvidenceRefs = checklistItems.filter((item) => item.result === "pass").flatMap((item) => Array.isArray(item.evidenceRefs) ? item.evidenceRefs : []);
const checklistFixScope = [
  ...(Array.isArray(verdict.checklistVerdict?.fixScope) ? verdict.checklistVerdict.fixScope : []),
  ...checklistItems.flatMap((item) => Array.isArray(item.fixScope) ? item.fixScope : []),
].filter(Boolean);
```

Return:

```ts
checklistVerdict: {
  failedChecklistIds,
  uncheckedChecklistIds,
  lockedPassedChecklistIds: passedChecklistIds,
  previousEvidenceRefs,
  targetChecklistIds: [...new Set([...failedChecklistIds, ...uncheckedChecklistIds])],
},
fixScope: [...new Set([...retryScope, ...checklistFixScope])],
```

- [ ] **Step 3: Extract file-only scope in failure router**

In `server/orchestrator/failure-router.ts`, update `collectVerificationRetryScope` so it adds only files:

```ts
const checklistVerdict = verdict.checklistVerdict || failure.cause?.checklistVerdict || {};
addMany(checklistVerdict.fixScope);
for (const item of Array.isArray(checklistVerdict.items) ? checklistVerdict.items : []) {
  addMany(item?.fixScope);
}
```

Do not add checklist ids to this scope set.

- [ ] **Step 4: Feed retry context without checklist ids as paths**

In `core/engine/run-job.ts`, normalize legacy retry fields into canonical `fixScope` before scope guard reads them:

```ts
const retryFixScope =
  normalizeFixScope(
    phaseSourceContext?.retryContext?.fixScope
    || phaseSourceContext?.retry?.fixScope
    || phaseSourceContext?.retryContext?.fix_scope
    || phaseSourceContext?.retry?.fix_scope
    || phaseSourceContext?.retry?.verification?.retryScope
    || []
  )
  || [];
```

Use `targetChecklistIds` only in prompts/source context, not `validateScopeConstraint`.

Add assertions to `tests/assignment-reconciler.test.ts`:

```ts
assert.deepEqual(sourceContext.retry.targetChecklistIds, ["AC-002"]);
assert.deepEqual(sourceContext.retry.lockedPassedChecklistIds, ["AC-001"]);
assert.deepEqual(sourceContext.retry.previousEvidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
assert.deepEqual(sourceContext.retry.fixScope, ["cli/commands/status.ts"]);
assert.equal(JSON.stringify(sourceContext.retry.fixScope).includes("AC-002"), false);
```

- [ ] **Step 5: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-retry-routing.test.ts tests/assignment-reconciler.test.ts
```

Expected: retry routing tests pass; existing reconciler tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/reconciler.ts server/orchestrator/failure-router.ts core/engine/run-job.ts tests/checklist-retry-routing.test.ts tests/assignment-reconciler.test.ts
git commit -m "Route checklist retries with item targets and file scope

Retry now carries logical checklist targets separately from file paths used by
scope guard, avoiding false scope violations and verify-only repair loops.

Confidence: medium
Scope-risk: moderate
Tested: checklist retry routing; assignment reconciler focused tests
Not-tested: long-running worker recovery job"
```

## Task 10: Map Checklist Routing Labels To Failure Kinds

**Files:**
- Modify: `core/contracts/failure.ts`
- Modify: `core/workflow/acceptance-checklist.ts`
- Modify: `core/engine/run-job.ts`
- Modify: `server/orchestrator/failure-router.ts`
- Create: `tests/checklist-failure-kind.test.ts`

- [ ] **Step 1: Add failure-kind and routing matrix tests**

Create `tests/checklist-failure-kind.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind, failure } from "../core/contracts/failure.js";
import { mapChecklistRoutingLabel } from "../core/workflow/acceptance-checklist.js";

test("scope violation is a valid failure kind for checklist routing", () => {
  const result = failure({
    kind: FailureKind.SCOPE_VIOLATION,
    phase: "execute",
    reason: "changed file outside fix scope",
    retryable: false,
  });
  assert.equal(result.kind, "scope_violation");
});

test("checklist routing labels map to closed failure contracts", () => {
  assert.deepEqual(mapChecklistRoutingLabel("scope_violation", {}), {
    kind: FailureKind.SCOPE_VIOLATION,
    action: "mark_failed",
    retryPhase: null,
    requiresFixScope: false,
    retryable: false,
  });
  assert.deepEqual(mapChecklistRoutingLabel("checklist_failed", { fixScope: ["cli/status.ts"] }), {
    kind: FailureKind.VERIFICATION_FAILED,
    action: "retry_same_worker",
    retryPhase: "execute",
    requiresFixScope: true,
    retryable: true,
  });
  assert.deepEqual(mapChecklistRoutingLabel("evidence_missing", { fixScope: [] }), {
    kind: FailureKind.VERIFICATION_FAILED,
    action: "retry_same_worker",
    retryPhase: "verify",
    requiresFixScope: false,
    retryable: true,
  });
  assert.deepEqual(mapChecklistRoutingLabel("poisoned_session", {}), {
    kind: FailureKind.POISONED_SESSION,
    action: "mark_failed",
    retryPhase: null,
    requiresFixScope: false,
    retryable: false,
  });
  assert.deepEqual(mapChecklistRoutingLabel("runjob_panic", {}), {
    kind: FailureKind.RUNJOB_PANIC,
    action: "mark_failed",
    retryPhase: null,
    requiresFixScope: false,
    retryable: false,
  });
  assert.equal(mapChecklistRoutingLabel("unknown_label", {}).action, "mark_failed");
});
```

- [ ] **Step 2: Add explicit failure kind**

In `core/contracts/failure.ts`, add:

```ts
SCOPE_VIOLATION: "scope_violation",
```

Use existing `HUMAN_APPROVAL_REQUIRED` for `needs_clarification` routing. Preserve current runtime hardening kinds `RUNJOB_PANIC` and `POISONED_SESSION`; checklist routing must fail closed on both.

Add `mapChecklistRoutingLabel(label, context)` in `core/workflow/acceptance-checklist.ts` or an adjacent workflow contract module. It must return `{ kind, action, retryPhase, requiresFixScope, retryable }` using only router actions the current reconciler supports. V1 uses `action: "retry_same_worker"` plus `retryPhase: "verify"` for verifier-only retry; it does not introduce a new router action.

Document the closed routing matrix in the failure module or adjacent tests. `SCOPE_VIOLATION` is non-retryable by default; adding it to the enum is not enough unless `FailureRouter.route()` has a deterministic action for it. Unknown labels must fail closed instead of falling back to `UNKNOWN`.

- [ ] **Step 3: Use SCOPE_VIOLATION in scope guard failures**

In `core/engine/run-job.ts`, replace scope guard failures that currently use generic verification/artifact failure with:

```ts
kind: FailureKind.SCOPE_VIOLATION,
```

Keep `cause.routingLabel = "scope_violation"` when useful for audit.
Runtime event/code names such as `scope_guard_violation` may remain as event diagnostics, but shared failure contracts must use `FailureKind.SCOPE_VIOLATION` and `cause.routingLabel = "scope_violation"`.

- [ ] **Step 4: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-failure-kind.test.ts tests/engine-run-job.test.ts
```

Expected: failure kind test passes and scope guard tests remain valid.

- [ ] **Step 5: Commit**

```bash
git add core/contracts/failure.ts core/workflow/acceptance-checklist.ts core/engine/run-job.ts server/orchestrator/failure-router.ts tests/checklist-failure-kind.test.ts
git commit -m "Represent scope violations as a first-class failure kind

Checklist routing needs executable failure taxonomy instead of labels that
cannot pass the shared failure contract.

Confidence: high
Scope-risk: narrow
Tested: checklist failure kind; engine run-job focused tests
Not-tested: external scheduler display of new kind"
```

## Task 11: Bind Checklist IDs To DAG Events

**Files:**
- Modify: `core/engine/run-job.ts`
- Modify: `core/workflow/acceptance-checklist.ts`
- Create: `tests/checklist-dag-binding.test.ts`

- [ ] **Step 1: Add DAG event tests**

Create `tests/checklist-dag-binding.test.ts` by extending the runJob fixture from `tests/checklist-prepare-dag.test.ts`. Do not add a self-constructed object test. Assert production events:

```ts
const dagEvent = events.find((event) => event.type === "workflow_dag_materialized");
assert.deepEqual(dagEvent.workflowDag.nodes.find((node) => node.phase === "execute").checklistIds, ["AC-001"]);
assert.deepEqual(events.find((event) => event.type === "dag_node_started" && event.phase === "execute").checklistIds, ["AC-001"]);
assert.deepEqual(events.find((event) => event.type === "dag_node_completed" && event.phase === "verify").checklistIds, ["AC-001"]);
```

Add negative fixtures:

- A custom mutating/dynamic node lacks `checklistIds` and is not `checklistNeutral: true`; checklist-aware completion fails with `dag_uncovered`.
- A verify node does not depend on an execute node covering the same required ids; checklist-aware completion fails with `dag_uncovered`.

- [ ] **Step 2: Emit checklist ids on DAG node events**

When appending `dag_node_started`, `dag_node_completed`, `dag_node_failed`, and retry/skipped node events in `core/engine/run-job.ts`, include:

```ts
checklistIds: Array.isArray(dagNode.checklistIds) ? dagNode.checklistIds : [],
```

- [ ] **Step 3: Do not require nodeConfig for executor nodes**

Keep checklist metadata on `workflowDag.nodes`. Do not assert `dynamicAgentPlan.nodeConfig["execute"]` unless `nodeConfigForDag` is intentionally generalized in a separate task.

Add DAG validation for checklist-aware jobs:

- Side-effecting or verifier nodes must have `checklistIds`, or `checklistNeutral: true`.
- Verify nodes must depend on execute nodes covering the same required ids.
- DAG completion is coverage evidence only. Item pass still requires `checklist-verdict.items[*].result === "pass"` and fresh evidence refs.

Implement this as a production helper:

```ts
export function validateChecklistDagCoverage(workflowDag: AnyRecord, acceptanceChecklist: AnyRecord) {
  // returns { ok: boolean, violations: [], outcome: "complete" | "dag_uncovered" }
}
```

Call it after DAG materialization for checklist-aware jobs and inside completion gate before accepting checklist completion. Unknown/custom dynamic nodes fail closed unless they carry non-empty `checklistIds` or `checklistNeutral: true`.

- [ ] **Step 4: Verify**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/checklist-dag-binding.test.ts tests/checklist-prepare-dag.test.ts tests/engine-prepare-task.test.ts
```

Expected: DAG metadata tests pass and existing DAG tests remain passing.

- [ ] **Step 5: Commit**

```bash
git add core/engine/run-job.ts tests/checklist-dag-binding.test.ts tests/checklist-prepare-dag.test.ts
git commit -m "Carry checklist ids through workflow DAG events

Checklist metadata belongs on DAG nodes and node events in V1, not on dynamic
agent node config for executor nodes.

Confidence: medium
Scope-risk: narrow
Tested: checklist DAG binding; prepare DAG and engine prepare focused tests
Not-tested: parallel DAG execution"
```

## Task 12: Extend Audit JSON Export

**Files:**
- Modify: `server/services/readiness-checks.ts`
- Modify: `tests/audit-export.test.ts`

- [ ] **Step 1: Add audit export test**

Add to `tests/audit-export.test.ts`:

```ts
test("audit export includes checklist artifacts from artifact index", async () => {
  const cpbRoot = await tempRoot("cpb-audit-checklist");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "proj");
  const outputs = path.join(dataRoot, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });
  const artifacts = {
    "acceptance-checklist": { schemaVersion: 1, jobId: "job-audit-checklist", project: "proj", status: "frozen", items: [{ id: "AC-001", required: true }] },
    "execution-map": { schemaVersion: 1, mappings: [{ checklistId: "AC-001", changedFiles: ["README.md"] }], changedFiles: ["README.md"], unmappedChangedFiles: [] },
    "evidence-ledger": { schemaVersion: 1, ledgerId: "evidence-ledger-001", finalWorktree: { head: "abc", diffHash: "sha256:one" }, evidence: [{ id: "EV-001", worktreeHead: "abc", diffHash: "sha256:one" }] },
    "checklist-verdict": { schemaVersion: 1, status: "pass", items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], fixScope: [] }] },
  };
  for (const [kind, content] of Object.entries(artifacts)) {
    const name = `${kind}-001`;
    await writeFile(path.join(outputs, `${name}.md`), JSON.stringify(content), "utf8");
    await appendEvent(cpbRoot, "proj", "job-audit-checklist", {
      type: "artifact_created",
      jobId: "job-audit-checklist",
      project: "proj",
      phase: "verify",
      kind,
      artifactKind: kind,
      artifact: name,
      artifactId: "001",
      ts: "2026-06-12T00:00:00Z",
    }, { dataRoot });
  }
  await appendEvent(cpbRoot, "proj", "job-audit-checklist", {
    type: "phase_poisoned_session",
    jobId: "job-audit-checklist",
    project: "proj",
    phase: "verify",
    nodeId: "verify",
    reasons: ["provider output was poisoned"],
    classifier: "poisoned-session-v1",
    ts: "2026-06-12T00:00:01Z",
  }, { dataRoot });
  const audit = await buildJobAuditExport(cpbRoot, "proj", "job-audit-checklist", { dataRoot });
  assert.equal(audit.checklist.items[0].id, "AC-001");
  assert.deepEqual(audit.executionMap.changedFiles, ["README.md"]);
  assert.equal(audit.evidenceLedger.finalWorktree.diffHash, "sha256:one");
  assert.deepEqual(audit.checklistVerdict.items[0].evidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
  assert.equal(audit.runtimeFailures[0].type, "phase_poisoned_session");
  assert.equal(audit.completionGate?.checklistOutcome ?? null, null);
});
```

- [ ] **Step 2: Read checklist artifacts safely**

In `server/services/readiness-checks.ts`, inside `buildJobAuditExport`, import both `readEventsReadOnly` and `materializeJob` from the event store, then find entries:

```ts
const latestByKind = (kind) => [...artifactIndex.entries].reverse().find((entry) => entry.kind === kind && !entry.broken);
const checklistEntry = latestByKind("acceptance-checklist");
const executionMapEntry = latestByKind("execution-map");
const evidenceLedgerEntry = latestByKind("evidence-ledger");
const checklistVerdictEntry = latestByKind("checklist-verdict");
const materialized = materializeJob(events);
```

Add helper:

```ts
async function readJsonArtifact(entry) {
  if (!entry?.path) return null;
  try {
    return JSON.parse(await readFile(entry.path, "utf8"));
  } catch {
    return null;
  }
}
```

Add helper:

```ts
function collectRuntimeFailureRefs(events) {
  return events
    .filter((event) => event.type === "phase_poisoned_session" || event.type === "job_panic")
    .map((event) => ({
      type: event.type,
      phase: event.phase || null,
      nodeId: event.nodeId || null,
      reason: event.reason || (Array.isArray(event.reasons) ? event.reasons.join(", ") : null),
      ts: event.ts || null,
    }));
}
```

Return:

```ts
checklist: await readJsonArtifact(checklistEntry),
executionMap: await readJsonArtifact(executionMapEntry),
evidenceLedger: await readJsonArtifact(evidenceLedgerEntry),
checklistVerdict: await readJsonArtifact(checklistVerdictEntry),
runtimeFailures: collectRuntimeFailureRefs(events),
completionGate: materialized.completionGate || null,
```

This code path must not read checklist content from phase diagnostics or source context. Runtime failures come from event replay, not artifact metadata. If an artifact index entry points to a missing or invalid JSON file, include `null` for that section and preserve the broken entry in `artifactIndex` rather than fabricating success.

- [ ] **Step 3: Keep audit safety tests passing**

Run:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit tests/audit-export.test.ts
```

Expected: new checklist audit test and existing absolute-path/traversal audit safety tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/services/readiness-checks.ts tests/audit-export.test.ts
git commit -m "Expose checklist artifacts in job audit export

Audit JSON now includes the frozen checklist, execution map, evidence ledger,
checklist verdict, and completion gate state needed to review task acceptance.

Confidence: high
Scope-risk: narrow
Tested: audit export focused tests
Not-tested: full filesystem review bundle"
```

## Task 13: Document The Runtime Contract

**Files:**
- Modify: `docs/architecture/runtime-boundaries.md`
- Modify: `README.md`

- [ ] **Step 1: Document task acceptance boundary**

Add to `docs/architecture/runtime-boundaries.md`:

```md
## Task Acceptance Boundary

Checklist-aware jobs treat the prepare-time `acceptance-checklist` artifact as
the frozen execution contract. Planner and executor summaries are audit context
only. Verifier pass requires itemized `checklist-verdict` entries backed by
fresh `evidence-ledger` refs. Completion gate must reject required failed or
unchecked items, missing evidence, stale evidence, unresolved scope violations,
and checklist verdict status that conflicts with item results.

Checklist artifacts must be event-visible and indexable. Diagnostics-only
artifact references are not sufficient for audit or completion.
```

- [ ] **Step 2: Document user-facing audit behavior**

Add to `README.md` near the `cpb artifacts` / `cpb verdict` section:

```md
Checklist-aware tasks also produce a frozen acceptance checklist, execution map,
evidence ledger, checklist verdict, and completion gate details. These artifacts
show what was required, what changed, what was verified, and why CPB accepted or
rejected the task.
```

- [ ] **Step 3: Verify docs only**

Run:

```bash
git diff --check -- README.md docs/architecture/runtime-boundaries.md
```

Expected: no whitespace errors.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/architecture/runtime-boundaries.md
git commit -m "Document checklist-aware task acceptance boundaries

The runtime contract now states that frozen checklist artifacts and fresh
evidence, not executor summaries, are the basis for task completion.

Confidence: high
Scope-risk: narrow
Tested: git diff --check
Not-tested: rendered README layout"
```

## Task 14: Final Integration Verification

**Files:**
- No new files expected.

- [ ] **Step 1: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript typecheck succeeds.

- [ ] **Step 2: Run full root tests**

Run:

```bash
npm test
```

Expected: Node and shell tests pass.

- [ ] **Step 3: Export a checklist-aware audit fixture**

Run the focused checklist and audit tests one more time:

```bash
npm run build:node && npm run build:tests
node dist/scripts/run-node-tests.js --unit \
  tests/checklist-artifact-index.test.ts \
  tests/acceptance-checklist-contract.test.ts \
  tests/checklist-prepare-dag.test.ts \
  tests/checklist-execution-map.test.ts \
  tests/checklist-verifier-gate.test.ts \
  tests/checklist-completion-gate.test.ts \
  tests/checklist-retry-routing.test.ts \
  tests/checklist-dag-binding.test.ts \
  tests/audit-export.test.ts
```

Expected: all checklist-focused tests pass.

- [ ] **Step 4: Commit final integration fixes if needed**

If verification required small fixes, commit them with a Lore-style message:

```bash
git add <changed-files>
git commit -m "Stabilize checklist-first verification integration

Final integration fixes keep the checklist task contract, evidence ledger,
retry context, and audit export aligned after full verification.

Confidence: medium
Scope-risk: moderate
Tested: npm run typecheck; npm test; checklist focused test suite
Not-tested: live provider task run"
```

## Self-Review Checklist

- Spec coverage: tasks cover prepare-time checklist generation, artifact event/index visibility, execution mapping, verifier evidence, completion gate, retry, DAG metadata, failure taxonomy, and audit export.
- Compatibility: legacy verdict-only jobs remain supported until a job has an `acceptance-checklist` artifact.
- Test shape: every runtime behavior change starts with a focused failing test.
- Risk control: V1 avoids per-item DAG splitting, checklist mutation, and full bundle generation.
- Stop condition: implementation is done only when `npm run typecheck`, `npm test`, and checklist-focused tests pass.
