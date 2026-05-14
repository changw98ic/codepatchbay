#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendEvent } from '../server/services/event-store.js';
import { createJob, requestCancelJob, requestRedirectJob, getJob, consumeRedirect } from '../server/services/job-store.js';
import { nextPhaseFor, recoverJobs } from '../server/services/supervisor.js';

describe('A3: cancel enforcement', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-cancel-enforce-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true });
  });

  it('nextPhaseFor returns empty string for cancel-requested job', async () => {
    const job = await createJob(tmpRoot, { project: 'test', task: 'cancel test' });
    await requestCancelJob(tmpRoot, 'test', job.jobId, { reason: 'stop it' });
    const updated = await getJob(tmpRoot, 'test', job.jobId);

    assert.equal(updated.cancelRequested, true);
    assert.equal(nextPhaseFor(updated), '');
  });

  it('recoverJobs terminates cancel-requested jobs instead of recovering', async () => {
    const job = await createJob(tmpRoot, { project: 'test', task: 'cancel recovery' });
    await appendEvent(tmpRoot, 'test', job.jobId, {
      type: 'phase_started',
      jobId: job.jobId,
      project: 'test',
      phase: 'plan',
      attempt: 1,
      leaseId: `lease-${job.jobId}-plan`,
      ts: new Date().toISOString(),
    });
    await requestCancelJob(tmpRoot, 'test', job.jobId, { reason: 'user cancel' });

    const recoverable = await recoverJobs(tmpRoot);
    assert.equal(recoverable.length, 0);

    const updated = await getJob(tmpRoot, 'test', job.jobId);
    assert.equal(updated.status, 'cancelled');
  });

  it('redirect context is consumed and cleared', async () => {
    const job = await createJob(tmpRoot, { project: 'test', task: 'redirect test' });
    const redirect = await requestRedirectJob(tmpRoot, 'test', job.jobId, {
      instructions: 'Use TypeScript strict mode',
      reason: 'project policy',
    });

    const redirectEventId = redirect.redirectEventId;
    assert.ok(redirectEventId);

    // Before consume: redirect is pending
    const before = await getJob(tmpRoot, 'test', job.jobId);
    assert.equal(before.redirectContext, 'Use TypeScript strict mode');
    assert.equal(before.redirectEventId, redirectEventId);

    // Consume it
    await consumeRedirect(tmpRoot, 'test', job.jobId, { redirectEventId });

    // After consume: redirect is cleared
    const after = await getJob(tmpRoot, 'test', job.jobId);
    assert.equal(after.redirectContext, null);
    assert.equal(after.redirectEventId, null);
    assert.ok(after.consumedRedirectIds.includes(redirectEventId));
  });

  it('cancelled job with active lease is not recovered', async () => {
    const job = await createJob(tmpRoot, { project: 'test', task: 'lease cancel' });
    // Simulate a phase with a lease that is still valid (not stale)
    const futureTs = new Date(Date.now() + 300_000).toISOString();
    await appendEvent(tmpRoot, 'test', job.jobId, {
      type: 'phase_started',
      jobId: job.jobId,
      project: 'test',
      phase: 'plan',
      attempt: 1,
      leaseId: `lease-${job.jobId}-plan`,
      ts: new Date().toISOString(),
    });

    // Write a non-stale lease
    const { acquireLease } = await import('../server/services/lease-manager.js');
    await acquireLease(tmpRoot, {
      leaseId: `lease-${job.jobId}-plan`,
      jobId: job.jobId,
      phase: 'plan',
      ttlMs: 300_000,
    });

    await requestCancelJob(tmpRoot, 'test', job.jobId, { reason: 'cancel with lease' });

    // Even with active lease, cancel-requested job should not be recovered
    const recoverable = await recoverJobs(tmpRoot);
    // With active lease, the cancel won't be written yet (lease is still fresh)
    // The job just won't appear in recoverable because nextPhaseFor returns ""
    assert.ok(!recoverable.some(r => r.jobId === job.jobId));
  });
});
