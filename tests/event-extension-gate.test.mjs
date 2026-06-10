#!/usr/bin/env node

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const EVENT_STORE = readFileSync(
  path.resolve('server/services/event-store.js'), 'utf8'
);

const EVENT_REGISTRY = {
  job_created:            { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['job_created', 'createJob'] },
  worktree_created:       { class: 'state',    consumer: 'job-store, worktree-manager', testFile: 'integration/worktree-manager.test.mjs', testMatch: ['worktree'] },
  phase_started:          { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['phase_started', 'startPhase'] },
  phase_completed:        { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['phase_completed', 'completePhase'] },
  phase_failed:           { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'integration/phase-runner.test.mjs', testMatch: ['phase_failed'] },
  budget_exceeded:        { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['budget_exceeded', 'budgetExceeded'] },
  job_blocked:            { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['job_blocked', 'blockJob'] },
  job_failed:             { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['job_failed', 'failJob'] },
  job_completed:          { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['job_completed', 'completeJob'] },
  job_cancel_requested:   { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'terminal-immutability.test.mjs', testMatch: ['job_cancel_requested', 'requestCancelJob'] },
  job_cancelled:          { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'terminal-immutability.test.mjs', testMatch: ['job_cancelled', 'cancelJob'] },
  job_redirect_requested: { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'event-store.test.mjs', testMatch: ['job_redirect_requested'] },
  job_redirect_consumed:  { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'event-store.test.mjs', testMatch: ['job_redirect_consumed'] },
  job_retried:            { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['job_retried', 'retryJob'] },
  job_superseded:         { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'event-store.test.mjs', testMatch: ['job_superseded'] },
  job_approved:           { class: 'control',  consumer: 'approval-gateway',          testFile: 'event-store.test.mjs', testMatch: ['job_approved'] },
  recovery_created:       { class: 'audit',    consumer: 'job-store, job-recovery',    testFile: 'job-recovery.test.mjs', testMatch: ['recovery_created', 'recoverAsNewJob'] },
  permission_denied:      { class: 'control',  consumer: 'permission-matrix, verifier', testFile: 'profile-loader.test.mjs', testMatch: ['deny'] },
  workflow_selected:      { class: 'state',    consumer: 'supervisor',                testFile: 'engine-provider-event.test.mjs', testMatch: ['workflow'] },
  workflow_dag_materialized: { class: 'state', consumer: 'supervisor, dag-engine',     testFile: 'engine-prepare-task.test.mjs', testMatch: ['workflow_dag_materialized'] },
  plan_decision:          { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'engine-provider-event.test.mjs', testMatch: ['planMode'] },
  plan_cache_decision:    { class: 'state',    consumer: 'job-store, plan-cache',     testFile: 'event-store.test.mjs', testMatch: ['plan_cache_decision'] },
  plan_cache_updated:     { class: 'state',    consumer: 'job-store, plan-cache',     testFile: 'event-store.test.mjs', testMatch: ['plan_cache_updated'] },
  phase_activity:         { class: 'activity', consumer: 'job-projection, dashboard', testFile: 'integration/reconcile.test.mjs', testMatch: ['phase_activity'] },
  pool_exhausted:         { class: 'control',  consumer: 'acp-pool, supervisor',      testFile: 'event-store.test.mjs', testMatch: ['pool_exhausted'] },
  riskmap_generated:      { class: 'state',    consumer: 'risk-engine, supervisor',   testFile: 'riskmap-service.test.mjs', testMatch: ['riskmap_generated'] },
  dynamic_agent_plan_generated: { class: 'state', consumer: 'planner, supervisor',    testFile: 'engine-prepare-task.test.mjs', testMatch: ['dynamic_agent_plan_generated'] },
  adversarial_verdict:    { class: 'state',    consumer: 'verifier, supervisor',      testFile: 'engine-prepare-task.test.mjs', testMatch: ['adversarialVerdict'] },
  executor_routing_feedback: { class: 'audit', consumer: 'routing-engine, supervisor', testFile: 'event-store.test.mjs', testMatch: ['executor_routing_feedback'] },
  agent_routing_decision: { class: 'state',    consumer: 'routing-engine, supervisor', testFile: 'engine-provider-event.test.mjs', testMatch: ['agent_routing_decision'] },
  approval_required:      { class: 'control',  consumer: 'approval-gateway, supervisor', testFile: 'event-store.test.mjs', testMatch: ['approval_required'] },
  approval_timed_out:     { class: 'control',  consumer: 'approval-gateway, supervisor', testFile: 'event-store.test.mjs', testMatch: ['approval_timed_out'] },
  review_bundle_accepted: { class: 'audit',    consumer: 'review-loop, supervisor',   testFile: 'event-store.test.mjs', testMatch: ['review_bundle_accepted'] },
  review_bundle_rejected: { class: 'audit',    consumer: 'review-loop, supervisor',   testFile: 'event-store.test.mjs', testMatch: ['review_bundle_rejected'] },
  dag_node_started:       { class: 'state',    consumer: 'dag-engine, supervisor',    testFile: 'event-store.test.mjs', testMatch: ['dag_node_started'] },
  dag_node_completed:     { class: 'state',    consumer: 'dag-engine, supervisor',    testFile: 'event-store.test.mjs', testMatch: ['dag_node_completed'] },
  dag_node_failed:        { class: 'state',    consumer: 'dag-engine, supervisor',    testFile: 'event-store.test.mjs', testMatch: ['dag_node_failed'] },
  dag_node_blocked:       { class: 'state',    consumer: 'dag-engine, supervisor',    testFile: 'event-store.test.mjs', testMatch: ['dag_node_blocked'] },
  dag_node_retrying:      { class: 'state',    consumer: 'dag-engine, supervisor',    testFile: 'event-store.test.mjs', testMatch: ['dag_node_retrying'] },
  dag_node_skipped:       { class: 'state',    consumer: 'dag-engine, supervisor',    testFile: 'event-store.test.mjs', testMatch: ['dag_node_skipped'] },
  dag_node_cancelled:     { class: 'state',    consumer: 'dag-engine, supervisor',    testFile: 'event-store.test.mjs', testMatch: ['dag_node_cancelled'] },
  external_remediation_started:   { class: 'audit', consumer: 'remediation, job-projection', testFile: 'event-store.test.mjs', testMatch: ['external_remediation_started'] },
  external_remediation_completed: { class: 'audit', consumer: 'remediation, job-projection', testFile: 'event-store.test.mjs', testMatch: ['external_remediation_completed'] },
  external_remediation_failed:    { class: 'audit', consumer: 'remediation, job-projection', testFile: 'event-store.test.mjs', testMatch: ['external_remediation_failed'] },
  external_repair_started:   { class: 'audit', consumer: 'repairer, job-projection', testFile: 'event-store.test.mjs', testMatch: ['external_repair_started'] },
  external_repair_completed: { class: 'audit', consumer: 'repairer, job-projection', testFile: 'event-store.test.mjs', testMatch: ['external_repair_completed'] },
  external_repair_failed:    { class: 'audit', consumer: 'repairer, job-projection', testFile: 'event-store.test.mjs', testMatch: ['external_repair_failed'] },
  finalizer_result:       { class: 'audit',    consumer: 'finalizer, job-projection', testFile: 'event-store.test.mjs', testMatch: ['finalizer_result'] },
  merge_index_status:     { class: 'audit',    consumer: 'merge-index, supervisor',   testFile: 'event-store.test.mjs', testMatch: ['merge_index_status'] },
  pr_opened:              { class: 'audit',    consumer: 'github-integration',        testFile: 'event-store.test.mjs', testMatch: ['pr_opened'] },
  completion_gate_evaluated: { class: 'audit', consumer: 'completion-gate, supervisor', testFile: 'event-store.test.mjs', testMatch: ['completion_gate_evaluated'] },
};

const VALID_CLASSES = new Set(['state', 'control', 'activity', 'audit']);

describe('R4: event extension gate', () => {
  it('every event type has a materialization rule', () => {
    for (const [eventType] of Object.entries(EVENT_REGISTRY)) {
      const hasHandler = EVENT_STORE.includes(`${eventType}(state`) || EVENT_STORE.includes(`${eventType}: `);
      assert.ok(hasHandler, `${eventType} missing handler in EVENT_HANDLERS`);
    }
  });

  it('every event type has a valid class', () => {
    for (const [eventType, meta] of Object.entries(EVENT_REGISTRY)) {
      assert.ok(VALID_CLASSES.has(meta.class), `${eventType} has invalid class: ${meta.class}`);
    }
  });

  it('every event type has a consumer', () => {
    for (const [eventType, meta] of Object.entries(EVENT_REGISTRY)) {
      assert.ok(meta.consumer && meta.consumer.length > 0, `${eventType} missing consumer`);
    }
  });

  it('every event type has a regression test file', () => {
    for (const [eventType, meta] of Object.entries(EVENT_REGISTRY)) {
      const testPath = path.resolve('tests', meta.testFile);
      let content;
      try {
        content = readFileSync(testPath, 'utf8');
      } catch {
        assert.fail(`${eventType} test file not found: tests/${meta.testFile}`);
      }
      const hasMatch = meta.testMatch.some((m) => content.includes(m));
      assert.ok(hasMatch, `${eventType} not referenced in tests/${meta.testFile} (checked: ${meta.testMatch.join(', ')})`);
    }
  });

  it('no materialized event type is missing from registry', () => {
    // Scan EVENT_HANDLERS keys from the source by finding lines like:
    //   event_name(state, ...) {   or   event_name: _sharedRef,
    const handlerKeyRegex = /^  ([a-z_]+)\(state|^  ([a-z_]+): _/gm;
    const materialized = new Set();
    let match;
    while ((match = handlerKeyRegex.exec(EVENT_STORE)) !== null) {
      materialized.add(match[1] || match[2]);
    }
    for (const eventType of materialized) {
      assert.ok(EVENT_REGISTRY[eventType], `${eventType} in EVENT_HANDLERS but missing from EVENT_REGISTRY`);
    }
  });
});
