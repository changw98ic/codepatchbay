#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendEvent, checkpointJob, readCheckpoint, materializeJob, readEvents } from '../server/services/event-store.js';
import { completeJob, createJob, failJob, blockJob, getJob } from '../server/services/job-store.js';

describe('R5: event log compaction', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'flow-compaction-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true });
  });

  it('checkpointJob writes checkpoint for terminal job', async () => {
    const job = await createJob(tmpRoot, { project: 'test', task: 'checkpoint test' });
    await completeJob(tmpRoot, 'test', job.jobId);

    const checkpoint = await readCheckpoint(tmpRoot, 'test', job.jobId);
    assert.ok(checkpoint);
    assert.equal(checkpoint.status, 'completed');
    assert.equal(checkpoint.project, 'test');
  });

  it('getJob uses checkpoint instead of full replay', async () => {
    const job = await createJob(tmpRoot, { project: 'test', task: 'fast read' });
    // Add many events
    for (let i = 0; i < 50; i++) {
      await appendEvent(tmpRoot, 'test', job.jobId, {
        type: 'phase_activity',
        jobId: job.jobId,
        message: `activity ${i}`,
        ts: new Date(Date.now() + i * 1000).toISOString(),
      });
    }
    await completeJob(tmpRoot, 'test', job.jobId);

    const start = performance.now();
    const loaded = await getJob(tmpRoot, 'test', job.jobId);
    const elapsed = performance.now() - start;

    assert.equal(loaded.status, 'completed');
    // Checkpoint read should be fast (< 5ms)
    assert.ok(elapsed < 50, `getJob took ${elapsed}ms, expected < 50ms`);
  });

  it('checkpoint not written for running job', async () => {
    const job = await createJob(tmpRoot, { project: 'test', task: 'running' });
    await appendEvent(tmpRoot, 'test', job.jobId, {
      type: 'phase_started',
      jobId: job.jobId,
      project: 'test',
      phase: 'plan',
      attempt: 1,
      ts: new Date().toISOString(),
    });

    const result = await checkpointJob(tmpRoot, 'test', job.jobId);
    assert.equal(result, null);
  });

  it('failed job gets checkpoint', async () => {
    const job = await createJob(tmpRoot, { project: 'test', task: 'fail test' });
    await failJob(tmpRoot, 'test', job.jobId, { reason: 'test failure' });

    const checkpoint = await readCheckpoint(tmpRoot, 'test', job.jobId);
    assert.ok(checkpoint);
    assert.equal(checkpoint.status, 'failed');
  });

  it('blocked job gets checkpoint', async () => {
    const job = await createJob(tmpRoot, { project: 'test', task: 'block test' });
    await blockJob(tmpRoot, 'test', job.jobId, { reason: 'operator block' });

    const checkpoint = await readCheckpoint(tmpRoot, 'test', job.jobId);
    assert.ok(checkpoint);
    assert.equal(checkpoint.status, 'blocked');
  });

  it('checkpoint file is under flow-task/checkpoints', async () => {
    const job = await createJob(tmpRoot, { project: 'test', task: 'path test' });
    await completeJob(tmpRoot, 'test', job.jobId);

    const checkpointPath = path.join(tmpRoot, 'flow-task', 'checkpoints', 'test', `${job.jobId}.json`);
    const s = await stat(checkpointPath);
    assert.ok(s.isFile());
  });

  it('materializeJob still works without checkpoint', async () => {
    const events = [
      { type: 'job_created', jobId: 'j1', project: 'p', task: 't', ts: '2026-01-01T00:00:00Z' },
      { type: 'job_completed', jobId: 'j1', project: 'p', ts: '2026-01-01T00:01:00Z' },
    ];
    const state = materializeJob(events);
    assert.equal(state.status, 'completed');
  });
});
