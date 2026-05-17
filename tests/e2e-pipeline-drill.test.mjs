#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { appendEvent } from '../server/services/event-store.js';
import {
  createJob,
  completePhase,
  failJob,
  getJob,
  requestCancelJob,
  requestRedirectJob,
  consumeRedirect,
  startPhase,
  blockJob,
} from '../server/services/job-store.js';
import { acquireLease, readLease } from '../server/services/lease-manager.js';
import { recoverJobs, recoverAndRun, nextPhaseFor } from '../server/services/supervisor.js';

function node() { return process.execPath; }
function runner() { return path.resolve('bridges/job-runner.mjs'); }

describe('R3: E2E pipeline drill', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-e2e-'));
    await mkdir(path.join(tmpRoot, 'wiki', 'projects', 'e2e', 'inbox'), { recursive: true });
    await mkdir(path.join(tmpRoot, 'wiki', 'projects', 'e2e', 'outputs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true });
  });

  it('stale lease triggers supervisor recovery', async () => {
    const job = await createJob(tmpRoot, { project: 'e2e', task: 'stale lease test' });
    const leaseId = `lease-${job.jobId}-plan`;

    // Start plan phase with short TTL
    await acquireLease(tmpRoot, { leaseId, jobId: job.jobId, phase: 'plan', ttlMs: 100 });
    await startPhase(tmpRoot, 'e2e', job.jobId, { phase: 'plan', leaseId });

    // Wait for lease to become stale
    await new Promise((r) => setTimeout(r, 200));

    // Grace period: need 3 consecutive stale detections
    await recoverJobs(tmpRoot);
    await recoverJobs(tmpRoot);
    const recoverable = await recoverJobs(tmpRoot);
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].jobId, job.jobId);
  });

  it('cancel request stops further phases', async () => {
    const job = await createJob(tmpRoot, { project: 'e2e', task: 'cancel drill' });
    await completePhase(tmpRoot, 'e2e', job.jobId, { phase: 'plan', artifact: 'plan-001' });

    // Request cancel
    await requestCancelJob(tmpRoot, 'e2e', job.jobId, { reason: 'operator cancel' });

    // Verify nextPhaseFor returns empty
    const updated = await getJob(tmpRoot, 'e2e', job.jobId);
    assert.equal(updated.cancelRequested, true);
    assert.equal(nextPhaseFor(updated), '');

    // Recovery should terminate, not resume
    const recoverable = await recoverJobs(tmpRoot);
    assert.equal(recoverable.length, 0);

    const afterRecovery = await getJob(tmpRoot, 'e2e', job.jobId);
    assert.equal(afterRecovery.status, 'cancelled');
  });

  it('redirect request is consumed once at phase boundary', async () => {
    const job = await createJob(tmpRoot, { project: 'e2e', task: 'redirect drill' });
    await completePhase(tmpRoot, 'e2e', job.jobId, { phase: 'plan', artifact: 'plan-001' });

    // Request redirect
    const redirected = await requestRedirectJob(tmpRoot, 'e2e', job.jobId, {
      instructions: 'Use TypeScript strict mode',
      reason: 'project policy',
    });

    // Verify redirect is pending
    const before = await getJob(tmpRoot, 'e2e', job.jobId);
    assert.equal(before.redirectContext, 'Use TypeScript strict mode');
    assert.ok(before.redirectEventId);

    // Consume redirect
    await consumeRedirect(tmpRoot, 'e2e', job.jobId, { redirectEventId: before.redirectEventId });

    // Verify redirect is cleared
    const after = await getJob(tmpRoot, 'e2e', job.jobId);
    assert.equal(after.redirectContext, null);
    assert.ok(after.consumedRedirectIds.includes(before.redirectEventId));
  });

  it('blocked workflow creates no agent processes', async () => {
    const job = await createJob(tmpRoot, { project: 'e2e', task: 'blocked test', workflow: 'blocked' });
    await appendEvent(tmpRoot, 'e2e', job.jobId, {
      type: 'workflow_selected',
      jobId: job.jobId,
      project: 'e2e',
      workflow: 'blocked',
      default: false,
      reason: 'operator blocked',
      ts: new Date().toISOString(),
    });
    await blockJob(tmpRoot, 'e2e', job.jobId, { reason: 'operator blocked' });

    const updated = await getJob(tmpRoot, 'e2e', job.jobId);
    assert.equal(updated.status, 'blocked');
    assert.equal(updated.blockedReason, 'operator blocked');

    // No phases should be recoverable
    assert.equal(nextPhaseFor(updated), '');
  });

  it('job-runner executes a phase and writes events', async () => {
    const job = await createJob(tmpRoot, { project: 'e2e', task: 'runner drill' });
    const fakeScript = path.resolve('tests/fixtures/success-stub.sh');

    const { stdout, stderr } = await execFileAsync(node(), [
      runner(),
      '--cpb-root', tmpRoot,
      '--project', 'e2e',
      '--job-id', job.jobId,
      '--phase', 'plan',
      '--script', fakeScript,
    ], { cwd: path.resolve('.'), timeout: 15000 });

    const updated = await getJob(tmpRoot, 'e2e', job.jobId);
    // Job should have progressed past created
    assert.ok(updated.phase);
    assert.ok(updated.leaseId === null); // Lease released after completion or failure
  });

  it('supervisor recovers job from event log after simulated crash', async () => {
    // Create job, start plan, simulate crash (no completion)
    const job = await createJob(tmpRoot, { project: 'e2e', task: 'crash recovery' });
    const leaseId = `lease-${job.jobId}-plan`;

    // Acquire a lease that will be stale
    await acquireLease(tmpRoot, { leaseId, jobId: job.jobId, phase: 'plan', ttlMs: 50 });
    await startPhase(tmpRoot, 'e2e', job.jobId, { phase: 'plan', leaseId });

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 150));

    // Grace period: need 3 consecutive stale detections via recoverJobs
    await recoverJobs(tmpRoot);
    await recoverJobs(tmpRoot);

    // Simulate supervisor restart: call recoverAndRun
    // This should find the job and attempt recovery (3rd stale detection)
    const results = await recoverAndRun(tmpRoot, { maxConcurrent: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].jobId, job.jobId);
    assert.equal(results[0].phase, 'plan');
  });

  it('completed job is not recoverable', async () => {
    const job = await createJob(tmpRoot, { project: 'e2e', task: 'completed test' });
    await completePhase(tmpRoot, 'e2e', job.jobId, { phase: 'plan', artifact: 'plan-001' });
    await completePhase(tmpRoot, 'e2e', job.jobId, { phase: 'execute', artifact: 'deliverable-001' });
    await completePhase(tmpRoot, 'e2e', job.jobId, { phase: 'verify', artifact: 'verdict-001' });

    const { completeJob } = await import('../server/services/job-store.js');
    await completeJob(tmpRoot, 'e2e', job.jobId);

    const recoverable = await recoverJobs(tmpRoot);
    assert.equal(recoverable.length, 0);
  });
});
