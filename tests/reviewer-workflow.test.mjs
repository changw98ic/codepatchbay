#!/usr/bin/env node

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getWorkflow, nextPhase, bridgeForPhase, roleForPhase } from '../server/services/workflow-definition.js';
import { bridgeForRole } from '../server/services/role-bridge.js';
import { loadProfile, listProfiles } from '../server/services/profile-loader.js';
import { nextPhaseFor } from '../server/services/supervisor.js';

describe('A8: reviewer workflow', () => {
  it('complex workflow includes review phase', () => {
    const wf = getWorkflow('complex');
    assert.equal(wf.name, 'complex');
    assert.deepEqual(wf.phases, ['plan', 'execute', 'review', 'verify']);
  });

  it('review phase comes between execute and verify', () => {
    const wf = getWorkflow('complex');
    assert.equal(nextPhase(wf, 'execute'), 'review');
    assert.equal(nextPhase(wf, 'review'), 'verify');
  });

  it('review phase uses reviewer-review.sh bridge', () => {
    const wf = getWorkflow('complex');
    assert.equal(bridgeForPhase(wf, 'review'), 'reviewer-review.sh');
  });

  it('review phase maps to codex role', () => {
    const wf = getWorkflow('complex');
    assert.equal(roleForPhase(wf, 'review'), 'codex');
  });

  it('role-bridge maps codex_review to reviewer bridge', () => {
    assert.equal(bridgeForRole('codex_review'), 'reviewer-review.sh');
  });

  it('supervisor returns review after execute in complex workflow', () => {
    const state = {
      status: 'running',
      workflow: 'complex',
      artifacts: { plan: 'plan-001', execute: 'deliverable-001' },
      cancelRequested: false,
    };
    assert.equal(nextPhaseFor(state), 'review');
  });

  it('supervisor returns verify after review in complex workflow', () => {
    const state = {
      status: 'running',
      workflow: 'complex',
      artifacts: { plan: 'plan-001', execute: 'deliverable-001', review: 'review-001' },
      cancelRequested: false,
    };
    assert.equal(nextPhaseFor(state), 'verify');
  });

  it('reviewer profile loads with correct config', async () => {
    const cpbRoot = process.cwd();
    const profile = await loadProfile(cpbRoot, 'reviewer');
    assert.equal(profile.role, 'reviewer');
    assert.ok(profile.soulMd);
    assert.ok(profile.soulMd.includes('Reviewer'));
    assert.deepEqual(profile.permissions.deny_tools, ['terminal/create', 'fs/write_text_file']);
    assert.equal(profile.agent.command, 'codex-acp');
  });

  it('reviewer profile is listed', async () => {
    const cpbRoot = process.cwd();
    const profiles = await listProfiles(cpbRoot);
    assert.ok(profiles.includes('reviewer'));
  });
});
