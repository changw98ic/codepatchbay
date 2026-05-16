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
  worktree_created:       { class: 'state',    consumer: 'job-store, worktree-manager', testFile: 'worktree-manager.test.mjs', testMatch: ['worktree'] },
  phase_started:          { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['phase_started', 'startPhase'] },
  phase_completed:        { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['phase_completed', 'completePhase'] },
  phase_failed:           { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'job-runner.test.mjs', testMatch: ['phase_failed'] },
  budget_exceeded:        { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['budget_exceeded', 'budgetExceeded'] },
  job_blocked:            { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'event-compaction.test.mjs', testMatch: ['job_blocked', 'blockJob'] },
  job_failed:             { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['job_failed', 'failJob'] },
  job_completed:          { class: 'state',    consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['job_completed', 'completeJob'] },
  job_cancel_requested:   { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'cancel-enforcement.test.mjs', testMatch: ['job_cancel_requested', 'requestCancelJob'] },
  job_cancelled:          { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'cancel-redirect.test.mjs', testMatch: ['job_cancelled', 'cancelJob'] },
  job_redirect_requested: { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'cancel-enforcement.test.mjs', testMatch: ['job_redirect_requested', 'requestRedirectJob'] },
  job_redirect_consumed:  { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'cancel-enforcement.test.mjs', testMatch: ['job_redirect_consumed', 'consumeRedirect'] },
  job_retried:            { class: 'control',  consumer: 'job-store, supervisor',     testFile: 'job-store.test.mjs', testMatch: ['job_retried', 'retryJob'] },
  workflow_selected:      { class: 'state',    consumer: 'supervisor',                testFile: 'workflow-definition.test.mjs', testMatch: ['workflow_selected'] },
  phase_activity:         { class: 'activity', consumer: 'job-projection, dashboard', testFile: 'activity-events.test.mjs', testMatch: ['phase_activity'] },
};

const VALID_CLASSES = new Set(['state', 'control', 'activity', 'audit']);

describe('R4: event extension gate', () => {
  it('every event type has a materialization rule', () => {
    for (const [eventType] of Object.entries(EVENT_REGISTRY)) {
      const hasCase = EVENT_STORE.includes(`case "${eventType}":`);
      assert.ok(hasCase, `${eventType} missing materialization rule in materializeJob`);
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
    const caseRegex = /case "([^"]+)":/g;
    const materialized = new Set();
    let match;
    while ((match = caseRegex.exec(EVENT_STORE)) !== null) {
      materialized.add(match[1]);
    }
    for (const eventType of materialized) {
      assert.ok(EVENT_REGISTRY[eventType], `${eventType} in materializeJob but missing from EVENT_REGISTRY`);
    }
  });
});
