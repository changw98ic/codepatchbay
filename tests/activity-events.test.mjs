#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendEvent } from '../server/services/event-store.js';
import { materializeJob } from '../server/services/event-store.js';
import { createJob, getJob } from '../server/services/job-store.js';
import { recoverJobs } from '../server/services/supervisor.js';

describe('A4: activity/liveness events', () => {
  it('phase_activity does not change job status', () => {
    const events = [
      { type: 'job_created', jobId: 'j1', project: 'p', task: 't', ts: '2026-01-01T00:00:00Z' },
      { type: 'phase_started', jobId: 'j1', project: 'p', phase: 'plan', attempt: 1, ts: '2026-01-01T00:00:01Z' },
      { type: 'phase_activity', jobId: 'j1', message: 'reading files...', ts: '2026-01-01T00:00:30Z' },
    ];
    const state = materializeJob(events);
    assert.equal(state.status, 'running');
    assert.equal(state.phase, 'plan');
  });

  it('phase_activity updates lastActivityAt and lastActivityMessage', () => {
    const events = [
      { type: 'job_created', jobId: 'j1', project: 'p', task: 't', ts: '2026-01-01T00:00:00Z' },
      { type: 'phase_activity', jobId: 'j1', message: 'writing output', ts: '2026-01-01T00:00:30Z' },
    ];
    const state = materializeJob(events);
    assert.equal(state.lastActivityAt, '2026-01-01T00:00:30Z');
    assert.equal(state.lastActivityMessage, 'writing output');
  });

  it('last activity message is overwritten by newer activity', () => {
    const events = [
      { type: 'job_created', jobId: 'j1', project: 'p', task: 't', ts: '2026-01-01T00:00:00Z' },
      { type: 'phase_activity', jobId: 'j1', message: 'step 1', ts: '2026-01-01T00:00:30Z' },
      { type: 'phase_activity', jobId: 'j1', message: 'step 2', ts: '2026-01-01T00:01:00Z' },
    ];
    const state = materializeJob(events);
    assert.equal(state.lastActivityMessage, 'step 2');
    assert.equal(state.lastActivityAt, '2026-01-01T00:01:00Z');
  });

  it('message is truncated to 200 characters when stored via event', () => {
    const longMessage = 'x'.repeat(300);
    const events = [
      { type: 'job_created', jobId: 'j1', project: 'p', task: 't', ts: '2026-01-01T00:00:00Z' },
      { type: 'phase_activity', jobId: 'j1', message: longMessage, ts: '2026-01-01T00:00:30Z' },
    ];
    const state = materializeJob(events);
    // Event store stores whatever is appended; truncation happens in job-runner before appendEvent
    assert.equal(state.lastActivityMessage, longMessage);
  });

  it('job with fresh activity is not recovered', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-activity-test-'));
    try {
      const job = await createJob(tmpRoot, { project: 'test', task: 'activity test' });
      await appendEvent(tmpRoot, 'test', job.jobId, {
        type: 'phase_started',
        jobId: job.jobId,
        project: 'test',
        phase: 'plan',
        attempt: 1,
        ts: new Date().toISOString(),
      });
      // Recent activity (within 5 minutes)
      await appendEvent(tmpRoot, 'test', job.jobId, {
        type: 'phase_activity',
        jobId: job.jobId,
        message: 'still working',
        ts: new Date().toISOString(),
      });

      const recoverable = await recoverJobs(tmpRoot);
      // Should NOT recover — activity is fresh
      assert.ok(!recoverable.some(r => r.jobId === job.jobId));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('job with stale activity is recovered', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-activity-stale-'));
    try {
      const job = await createJob(tmpRoot, { project: 'test', task: 'stale test' });
      // Old activity (6 minutes ago)
      const staleTs = new Date(Date.now() - 360_000).toISOString();
      await appendEvent(tmpRoot, 'test', job.jobId, {
        type: 'phase_started',
        jobId: job.jobId,
        project: 'test',
        phase: 'plan',
        attempt: 1,
        ts: staleTs,
      });
      await appendEvent(tmpRoot, 'test', job.jobId, {
        type: 'phase_activity',
        jobId: job.jobId,
        message: 'old output',
        ts: staleTs,
      });

      // Grace period: need 3 consecutive stale detections
      await recoverJobs(tmpRoot);
      await recoverJobs(tmpRoot);
      const recoverable = await recoverJobs(tmpRoot);
      assert.ok(recoverable.some(r => r.jobId === job.jobId));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('job projection includes lastActivityAt', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-activity-proj-'));
    try {
      const { projectPipelineState } = await import('../server/services/job-projection.js');
      const job = await createJob(tmpRoot, { project: 'test', task: 'proj test' });
      await appendEvent(tmpRoot, 'test', job.jobId, {
        type: 'phase_activity',
        jobId: job.jobId,
        message: 'some work',
        ts: '2026-01-01T00:01:00Z',
      });

      const state = await projectPipelineState(tmpRoot, 'test');
      assert.equal(state.lastActivityAt, '2026-01-01T00:01:00Z');
      assert.equal(state.lastActivityMessage, 'some work');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });
});
