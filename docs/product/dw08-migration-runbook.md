# DW-08 Migration Runbook: CodeGraph-Gated Dynamic Workflows

Date: 2026-06-08

## Summary

This runbook documents the DW-08 operational migration from the legacy workflow queue to CodeGraph-gated dynamic workflows. It includes the `index_unavailable` to `codegraph_unavailable` rename, the `WORKCPBS` to `WORKFLOWS` definition rename, and the new acceptance path for CodeGraph capability maps, RiskMap generation, workflow DAG materialization, dynamic verifier planning, and adversarial verification.

## What Changed

| Old | New | Files Affected |
|-----|-----|----------------|
| `INDEX_UNAVAILABLE` | `CODEGRAPH_UNAVAILABLE` | `core/contracts/failure.js` |
| `index_unavailable` | `codegraph_unavailable` | `server/services/hub-queue.js`, `server/services/index-freshness.js`, `server/services/queue-rules.js` |
| `recoverIndexUnavailable()` | `recoverCodegraphUnavailable()` | `server/services/queue-rules.js`, `server/services/hub-queue.js` |
| `WORKCPBS` | `WORKFLOWS` | `core/workflow/definition.js` |

New runtime signals and projections:

| Surface | Required Evidence |
|---------|-------------------|
| Project registration | `project_capability_map`, `safety_boundary_map`, `high_risk_area_map`, and high `capabilityMapConfidence` generated from a live CodeGraph state |
| Queue claim gate | missing or stale CodeGraph capability metadata blocks with `codegraph_unavailable` |
| Job events | `riskmap_generated`, `workflow_dag_materialized`, `dynamic_agent_plan_generated`, `dag_node_started`, `dag_node_completed`, `dag_node_failed` |
| High-risk verification | `adversarial_verify` runs after `verify` when the RiskMap requires it, and emits `adversarial_verdict` |
| Pipeline projection | `riskMap`, `dynamicAgentPlan`, `adversarialVerdict`, `workflowDag`, `riskLevel`, and `adversarialRequired` are visible to API/UI consumers |

## Migration Steps

1. Deploy the CodeGraph readiness and project capability map changes first. New project registration must fail closed when the live CodeGraph state is missing, even if an old SQLite index file exists.
2. Verify each registered project has `project_capability_map`, `safety_boundary_map`, and `high_risk_area_map` metadata with high confidence. Do not manually mark this metadata as high confidence unless it came from the CodeGraph inventory.
3. Deploy the workflow DAG and event projection changes. Confirm new jobs emit `workflow_dag_materialized` before phase node execution and emit `dag_node_started` / `dag_node_completed` for each node.
4. Deploy RiskMap and dynamic verifier planning. High-risk tasks must emit `riskmap_generated` and `dynamic_agent_plan_generated`, and the queue metadata should persist the same dynamic plan used by the engine.
5. Deploy the `adversarial_verify` phase. For high or critical RiskMap outputs, `adversarial_verify` must run after normal `verify` and must emit `adversarial_verdict`.
6. Deploy the UI/API projection fields after the event store is writing the new state, so clients can read `riskMap`, `dynamicAgentPlan`, `adversarialVerdict`, `workflowDag`, `riskLevel`, and `adversarialRequired`.
7. Run the verification commands below before enabling broad queue intake.

## Handling Stale Queue Entries

Existing runtime queue entries with status `index_unavailable` are pre-migration state. New writes use `codegraph_unavailable`, while queue counters and retry-window recovery accept both values during the migration window. Preserve queue evidence before any one-time runtime cleanup or migration.

If a pending entry is blocked as `codegraph_unavailable`, do not force it to `pending` until CodeGraph readiness and project capability map generation are healthy. The correct recovery path is:

1. Restore or restart the CodeGraph daemon for the source project.
2. Re-register or refresh the project so the queue entry receives high-confidence capability metadata.
3. Let queue retry-window recovery or an explicit safe retry return the entry to `pending`.

## High-Risk Task Acceptance

A high-risk queue task is accepted only when all of these are true:

1. The project has high-confidence capability metadata derived from CodeGraph.
2. `prepare_task` emits and persists a `riskMap` with `riskLevel` and `adversarialRequired`.
3. The engine emits `dynamic_agent_plan_generated` with independent verifier/adversarial verifier configuration when the RiskMap requires it.
4. The materialized DAG includes `adversarial_verify` after `verify`.
5. The final projection exposes `riskMap`, `dynamicAgentPlan`, `adversarialVerdict`, and `workflowDag`.

If `adversarial_verify` fails, treat the failure as a verifier failure with a tighter retry scope. Preserve the `adversarial_verdict` artifact, requeue through the reconciler retry path, and use the verdict's `fix_scope` to limit the next execution pass.

## Verification

- `rg 'INDEX_UNAVAILABLE|WORKCPBS|recoverIndexUnavailable' core server scripts` should return no production references.
- `rg 'index_unavailable' core server scripts` should only find the legacy compatibility alias that accepts pre-migration queue rows.
- `node --test tests/dw-codegraph-gate.test.mjs tests/riskmap-service.test.mjs tests/engine-prepare-task.test.mjs` should pass.
- `node --test tests/queue-orchestrator.test.mjs tests/scheduler-dag-provider.test.mjs` should pass.
- `node --test tests/dw08-acceptance.test.mjs` should pass.
- `npm run verify:p0p1` should pass before production rollout.
