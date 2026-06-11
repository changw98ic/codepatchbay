# DW 对抗性代码审计报告

Date: 2026-06-11

## Current Verdict

DW strict completion is implementation-ready for the stabilized contract, but the current local runtime is operationally blocked.

The stabilized contract now separates these states:

| Capability | Status | Evidence |
| --- | --- | --- |
| Runtime health gate | Implemented, runtime currently blocked | `./cpb dw-status` reports explicit blockers instead of claiming readiness |
| Workflow single source | Ready | Server adapter delegates to `core/workflow/definition.ts`; `tests/workflow-definition-contract.test.ts` covers built-ins and registered DAGs |
| DAG metadata | Ready | `workflow_dag_materialized` emits nodes, edges, and readiness metadata |
| DAG node-first sequential execution | Ready | `runJob` iterates DAG ready nodes sequentially; same-phase dependency-order regression passes |
| DAG resume | Ready | `deriveDagResumeState()` preserves concrete node ids and falls back to phase ids only for legacy jobs |
| DAG parallel execution | Not ready by design | `dag_parallel_execution_ready: false`; current executor runs one ready node at a time |
| Attention projection | Ready | Inbox and Hub delegate to `buildAttentionProjection()` |
| Dashboard attention consumption | Ready | Dashboard fetches canonical attention rows and preserves API order |
| TypeScript migration | Ready with typing caveat | Source-wide scan excluding dependencies, generated output, runtime homes, and vendored browser bundles has no remaining `.js`/`.mjs`/`.cjs`; compiled `dist/` is the runnable package path |
| Package publish shape | Ready | `npm pack --dry-run --json --ignore-scripts` includes browser fixture HTML and `dist/web/dist/index.html`, and excludes tests, runtime state, local tarballs, and non-template wiki artifacts |

## Remaining Runtime Blockers

The current checkout should not be described as fully DW-ready while local runtime health reports blockers:

- Active release differs from source: source `0.3.13`, active release `0.3.12`.
- Queue contains CodeGraph-unavailable entries.
- Stale jobs are present.
- Jobs-index divergence is currently a reconcile warning.

These are operational state problems, not missing implementation for the stabilized DAG/attention contract.

## Fixed Findings From The Earlier Audit

- Completion gate is now invoked before `completeJob()`.
- `run-job` uses the phase policy path for resolved phases.
- Scope guard violations now fail the job instead of remaining advisory-only.
- DAG node events are materialized into `workflowDag`, `nodeStates`, `completedNodes`, and `dagResume`.
- Same-phase DAG nodes use node ids as the authoritative resume identity.
- `dw-status` now prints `dag_metadata_ready`, `dag_node_first_sequential_ready`, `dag_resume_ready`, and `dag_parallel_execution_ready`.

## Known Design Boundaries

- Phase-level events still repeat for same-phase DAG nodes. For DAG ordering and resume decisions, consumers must use `dag_node_*` events and `dagResume`, not phase names alone.
- Parallel DAG scheduling remains a future milestone. `maxConcurrentNodes` is preserved as metadata, but the current executor intentionally runs sequentially.
- Runtime health checks are read-only; recovery or reconcile operations must be explicit.
- First-observed jobs-index divergence is a warning. It escalates only with prior divergence history or failed reconcile evidence.

## Verification Snapshot

Commands run during stabilization:

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
- Web tests passed: 3 files, 3 tests.
- Full `npm test` passed: unit 477/477, integration 101/101, isolated integration 43/43, shell smoke passed.
- Source-wide legacy JS/MJS/CJS count is 0 outside dependencies, generated output, runtime homes, and the vendored browser bundle.
- Package dry-run reports no tests, no runtime `.omc` state, no local `.tgz` files, no non-template wiki artifacts, and includes the compiled web UI plus browser fixture HTML.
- `./cpb dw-status` exited non-zero due runtime blockers while correctly exposing DAG readiness and not claiming parallel execution.

Typing caveat:

- Migrated Node files currently use `// @ts-nocheck`; the TypeScript pass verifies module graph and emit viability, not full semantic typing. Removing those guards should be a follow-up hardening sequence.
