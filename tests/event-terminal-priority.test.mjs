#!/usr/bin/env node

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { materializeJob } from '../server/services/event-store.js';

const baseEvents = [
  { type: 'job_created', jobId: 'j1', project: 'p', task: 't', ts: 'T0' },
  { type: 'phase_started', jobId: 'j1', phase: 'plan', leaseId: 'l1', ts: 'T1' },
  { type: 'phase_completed', jobId: 'j1', phase: 'plan', artifact: 'a.md', ts: 'T2' },
];

describe('Terminal event state priority', () => {
  it('phase_started after job_completed is ignored', () => {
    const state = materializeJob([
      ...baseEvents,
      { type: 'job_completed', jobId: 'j1', ts: 'T3' },
      { type: 'phase_started', jobId: 'j1', phase: 'verify', leaseId: 'l2', ts: 'T4' },
    ]);
    assert.equal(state.status, 'completed');
    assert.equal(state.phase, 'completed');
    assert.equal(state.leaseId, null);
  });

  it('phase_completed after job_failed is ignored', () => {
    const state = materializeJob([
      ...baseEvents,
      { type: 'job_failed', jobId: 'j1', reason: 'crash', ts: 'T3' },
      { type: 'phase_completed', jobId: 'j1', phase: 'execute', artifact: 'out.md', ts: 'T4' },
    ]);
    assert.equal(state.status, 'failed');
    assert.equal(state.artifacts.execute, undefined);
  });

  it('phase_started after job_cancelled is ignored', () => {
    const state = materializeJob([
      ...baseEvents,
      { type: 'job_cancelled', jobId: 'j1', ts: 'T3' },
      { type: 'phase_started', jobId: 'j1', phase: 'execute', leaseId: 'l3', ts: 'T4' },
    ]);
    assert.equal(state.status, 'cancelled');
    assert.equal(state.phase, 'plan');
  });

  it('phase_completed after job_blocked is ignored', () => {
    const state = materializeJob([
      ...baseEvents,
      { type: 'job_blocked', jobId: 'j1', reason: 'approval', ts: 'T3' },
      { type: 'phase_completed', jobId: 'j1', phase: 'plan', artifact: 'p.md', ts: 'T4' },
    ]);
    assert.equal(state.status, 'blocked');
    assert.equal(state.blockedReason, 'approval');
  });

  it('last terminal event wins: failed then completed', () => {
    const state = materializeJob([
      ...baseEvents,
      { type: 'job_failed', jobId: 'j1', reason: 'timeout', ts: 'T3' },
      { type: 'job_completed', jobId: 'j1', ts: 'T4' },
    ]);
    assert.equal(state.status, 'completed');
  });

  it('last terminal event wins: cancelled then failed', () => {
    const state = materializeJob([
      ...baseEvents,
      { type: 'job_cancelled', jobId: 'j1', ts: 'T3' },
      { type: 'job_failed', jobId: 'j1', reason: 'died', ts: 'T4' },
    ]);
    assert.equal(state.status, 'failed');
    assert.equal(state.blockedReason, 'died');
  });

  it('phase_activity after terminal status records activity but preserves status', () => {
    const state = materializeJob([
      ...baseEvents,
      { type: 'job_completed', jobId: 'j1', ts: 'T3' },
      { type: 'phase_activity', jobId: 'j1', ts: 'T4', message: 'late output' },
    ]);
    assert.equal(state.status, 'completed');
    assert.equal(state.lastActivityAt, 'T4');
    assert.equal(state.lastActivityMessage, 'late output');
  });

  it('redirect after terminal status is ignored', () => {
    const state = materializeJob([
      ...baseEvents,
      { type: 'job_completed', jobId: 'j1', ts: 'T3' },
      { type: 'job_redirect_requested', jobId: 'j1', instructions: 'redo', reason: 'quality', redirectEventId: 'r1', ts: 'T4' },
    ]);
    assert.equal(state.status, 'completed');
    assert.equal(state.redirectContext, null);
  });
});
