#!/usr/bin/env node

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { getWorkflow, nextPhase, bridgeForPhase, roleForPhase } from '../server/services/workflow-definition.js';
import { bridgeForRole } from '../server/services/role-bridge.js';
import { materializeJob } from '../server/services/event-store.js';
import { bridgeForPhase as supervisorBridgeForPhase, nextPhaseFor } from '../server/services/supervisor.js';

describe('workflow-definition', () => {
  it('getWorkflow returns standard for known name', () => {
    const wf = getWorkflow('standard');
    assert.equal(wf.name, 'standard');
    assert.deepEqual(wf.phases, ['plan', 'execute', 'verify']);
  });

  it('getWorkflow returns blocked workflow', () => {
    const wf = getWorkflow('blocked');
    assert.equal(wf.name, 'blocked');
    assert.deepEqual(wf.phases, []);
  });

  it('getWorkflow falls back to standard for unknown name', () => {
    const wf = getWorkflow('nonexistent');
    assert.equal(wf.name, 'standard');
  });

  it('nextPhase returns first phase when current is null', () => {
    const wf = getWorkflow('standard');
    assert.equal(nextPhase(wf, null), 'plan');
  });

  it('nextPhase returns next phase in sequence', () => {
    const wf = getWorkflow('standard');
    assert.equal(nextPhase(wf, 'plan'), 'execute');
    assert.equal(nextPhase(wf, 'execute'), 'verify');
  });

  it('nextPhase returns null after last phase', () => {
    const wf = getWorkflow('standard');
    assert.equal(nextPhase(wf, 'verify'), null);
  });

  it('nextPhase returns null for blocked workflow', () => {
    const wf = getWorkflow('blocked');
    assert.equal(nextPhase(wf, null), null);
  });

  it('bridgeForPhase returns correct bridge scripts', () => {
    const wf = getWorkflow('standard');
    assert.equal(bridgeForPhase(wf, 'plan'), 'planner.sh');
    assert.equal(bridgeForPhase(wf, 'execute'), 'executor.sh');
    assert.equal(bridgeForPhase(wf, 'verify'), 'verifier.sh');
  });

  it('bridgeForPhase returns null for unknown phase', () => {
    const wf = getWorkflow('standard');
    assert.equal(bridgeForPhase(wf, 'unknown'), null);
  });

  it('roleForPhase returns correct roles', () => {
    const wf = getWorkflow('standard');
    assert.equal(roleForPhase(wf, 'plan'), 'planner');
    assert.equal(roleForPhase(wf, 'execute'), 'executor');
    assert.equal(roleForPhase(wf, 'verify'), 'verifier');
  });

  it('role-bridge maps roles to bridge scripts', () => {
    assert.equal(bridgeForRole('planner'), 'planner.sh');
    assert.equal(bridgeForRole('executor'), 'executor.sh');
    assert.equal(bridgeForRole('verifier'), 'verifier.sh');
    assert.equal(bridgeForRole('reviewer'), 'reviewer.sh');
    assert.equal(bridgeForRole('repairer'), 'repairer.sh');
    assert.equal(bridgeForRole('codex'), null);
    assert.equal(bridgeForRole('claude'), null);
    assert.equal(bridgeForRole('codex_verify'), null);
    assert.equal(bridgeForRole('unknown'), null);
  });
});

describe('workflow_selected event materialization', () => {
  it('workflow_selected sets workflow on job state', () => {
    const events = [
      { type: 'job_created', jobId: 'j1', project: 'p', task: 't', workflow: 'standard', ts: '2026-01-01T00:00:00Z' },
      { type: 'workflow_selected', jobId: 'j1', project: 'p', workflow: 'blocked', default: false, ts: '2026-01-01T00:00:01Z' },
    ];
    const state = materializeJob(events);
    assert.equal(state.workflow, 'blocked');
  });

  it('workflow_selected with default true keeps standard workflow', () => {
    const events = [
      { type: 'job_created', jobId: 'j1', project: 'p', task: 't', workflow: 'standard', ts: '2026-01-01T00:00:00Z' },
      { type: 'workflow_selected', jobId: 'j1', project: 'p', workflow: 'standard', default: true, ts: '2026-01-01T00:00:01Z' },
    ];
    const state = materializeJob(events);
    assert.equal(state.workflow, 'standard');
  });
});

describe('supervisor nextPhaseFor with workflow', () => {
  it('returns plan for new standard job', () => {
    const state = { status: 'running', workflow: 'standard', artifacts: {}, cancelRequested: false };
    assert.equal(nextPhaseFor(state), 'plan');
  });

  it('returns execute after plan artifact', () => {
    const state = { status: 'running', workflow: 'standard', artifacts: { plan: 'plan-001' }, cancelRequested: false };
    assert.equal(nextPhaseFor(state), 'execute');
  });

  it('returns verify after execute completes without a deliverable artifact', () => {
    const state = {
      status: 'running',
      workflow: 'standard',
      artifacts: { plan: 'plan-001', execute: '' },
      completedPhases: ['plan', 'execute'],
      cancelRequested: false,
    };
    assert.equal(nextPhaseFor(state), 'verify');
  });

  it('returns empty for blocked workflow', () => {
    const state = { status: 'running', workflow: 'blocked', artifacts: {}, cancelRequested: false };
    assert.equal(nextPhaseFor(state), '');
  });

  it('returns complete after all phases done', () => {
    const state = {
      status: 'running', workflow: 'standard',
      artifacts: { plan: 'plan-001', execute: 'deliverable-001', verify: 'verdict-001' },
      cancelRequested: false,
    };
    assert.equal(nextPhaseFor(state), 'complete');
  });

  it('uses job-id verifier mode when execute completed without deliverable artifact', () => {
    const job = {
      jobId: 'job-20260520-000000-deadbe',
      workflow: 'standard',
      artifacts: { plan: 'plan-001', execute: '' },
      task: 'verify without deliverable',
    };
    const bridge = supervisorBridgeForPhase('verify', 'demo', job);
    assert.deepEqual(bridge.args, ['demo', '--job-id', 'job-20260520-000000-deadbe']);
  });
});
