# Acceptance Record — LLM checklist decomposition (production closure)

Task: let the default acceptance checklist close in production by decomposing the
task into structured items carrying `allowedFiles` scope, so the probe runner
matches >0 (was `allowedFiles:[]` → `matchCount:0` → `evidence_mismatch` for every
auto-constructed item). Plan: `docs/superpowers/plans/2026-06-14-checklist-default-needs-probe-runner.md`
(6th layer of the dependency chain).

Bootstrap Task Acceptance Protocol per `docs/superpowers/plans/2026-06-12-...` line 67-113.

## Task Acceptance Record

| Checklist id | Criterion | Evidence | Result |
| --- | --- | --- | --- |
| DECOMP-001 | decomposeTaskToChecklistItems calls the planner and returns structured items | `tests/checklist-decompose-integration.test.ts` "pool returns valid items -> ok with allowedFiles" (fake pool → `{ok:true, items[0].allowedFiles=["cli/commands/status.ts"]}`) | pass |
| DECOMP-002 | decomposedItems extracted from planner JSON envelope | `tests/checklist-decomposer.test.ts` "chain: well-formed planner output parses + validates into items" + "chain: non-ok agent status fails parse" | pass |
| DECOMP-003 | validateDecomposedItems strict (requirement / unique predicateId / valid method / non-empty allowedFiles / repo-relative paths) | `tests/checklist-decomposer.test.ts` 7 cases: accepts well-formed; rejects empty, missing requirement, duplicate predicateId, bad method, empty allowedFiles, invalid path | pass |
| DECOMP-004 | buildAcceptanceChecklist uses decomposedItems to emit items with non-empty allowedFiles | `tests/checklist-decomposer.test.ts` "decomposedItems produce items with non-empty allowedFiles" + "without decomposedItems keeps deterministic []-scope (kill-switch path)" | pass |
| DECOMP-005 | freezeChecklist decompose failure -> ARTIFACT_INVALID fail-closed | `core/engine/run-job.ts` freezeChecklistAndMaterializeDag (blockPreparedJob on `!decomposition.ok`); `tests/checklist-decompose-integration.test.ts` 4 fail-closed cases (no items / malformed / empty allowedFiles / agent throw) | pass |
| DECOMP-006 | end-to-end: auto checklist carries allowedFiles -> probe matchCount>0 | `tests/probe-runner.test.ts` "DECOMP-006: checklist built from LLM decomposedItems yields probe matchCount>0" — `buildAcceptanceChecklist(decomposedItems)` → `runChecklistProbes` on a matching git diff → `matchCount>0`. Chain covered link-by-link: decompose (DECOMP-001) → items with allowedFiles (DECOMP-004) → probe matches (this test). Full runJob-with-real-agent+codegraph integration not exercised in the unit suite, but every link is now directly tested. | pass |
| DECOMP-007 | CPB_CHECKLIST_DECOMPOSE=0 kill switch returns to deterministic construction | `scripts/run-node-tests.ts` sets the default for the test pool; full suite 893+45+17 pass, 0 fail under the switch; production default-on unchanged (env unset → decompose runs) | pass |

Changed files:
- `core/workflow/checklist-decomposer.ts` (new) — decomposeTaskToChecklistItems + buildDecomposePrompt; mirrors verifier checklistVerdict contract (runAgent → parseAgentJson → validateDecomposedItems → fail-closed)
- `core/workflow/acceptance-checklist.ts` — validateDecomposedItems (export) + buildAcceptanceChecklist `decomposedItems` path
- `core/engine/run-job.ts` — freezeChecklistAndMaterializeDag calls decompose before build, fail-closed ARTIFACT_INVALID, CPB_CHECKLIST_DECOMPOSE kill switch
- `scripts/run-node-tests.ts` — test-default kill switch (fake-agent test pool does not run real LLM decomposition)
- `tests/checklist-decomposer.test.ts` (new) — 13 cases
- `tests/checklist-decompose-integration.test.ts` (new) — 5 cases

Verification commands:
- `npm run build:node && npm run build:tests` → tsc clean, core/ stays free of server/bridges imports
- `node --test dist/tests/checklist-decomposer.test.js` → 13 pass / 0 fail
- `node --test dist/tests/checklist-decompose-integration.test.js` → 5 pass / 0 fail
- `node dist/scripts/run-node-tests.js` → 893+45+17 pass / 0 fail

Retry/blocking:
- `targetChecklistIds`: `[]`
- `fixScope`: `[]`
- `unchecked`: `[]`
- `blockingReason`: `null`
- `humanBlockingReason`: `null`

Note: every required item (DECOMP-001..007) is pass with direct test evidence.
The full runJob integration with a real codegraph index + live agent pool is not
exercised in the unit suite (it needs that integration environment); each link of
the chain is tested directly instead.
