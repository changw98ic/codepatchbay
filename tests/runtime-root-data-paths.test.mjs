#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { appendEvent, readEvents, listEventFiles, writeCheckpoint, readCheckpoint } from '../server/services/event-store.js';
import { createJob, getJob, startPhase, completePhase, failJob, blockJob, completeJob, recordActivity, listJobs } from '../server/services/job-store.js';
import { acquireLease, readLease, releaseLease } from '../server/services/lease-manager.js';
import { updateJobsIndexEntry, listJobsFromIndex, rebuildJobsIndex } from '../server/services/jobs-index.js';
import { runtimeDataRoot } from '../server/services/runtime-root.js';

// Helper: create temp dirs simulating CPB_ROOT (source tree) and dataRoot (runtime root)
async function makeTestRoots() {
  const srcRoot = await mkdtemp(path.join(tmpdir(), 'cpb-src-'));
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cpb-data-'));
  return { srcRoot, dataRoot };
}

// Helper: check that a path exists
async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

// Helper: list all files recursively under a dir
async function listAllFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(root);
  return files;
}

// ── Event store ──

describe('event-store: writes go to dataRoot', () => {
  let roots;
  beforeEach(async () => { roots = await makeTestRoots(); });
  afterEach(async () => {
    await rm(roots.srcRoot, { recursive: true, force: true });
    await rm(roots.dataRoot, { recursive: true, force: true });
  });

  it('appendEvent writes events under dataRoot, not srcRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    await appendEvent(srcRoot, 'proj', 'job-001', { type: 'job_created', jobId: 'job-001', project: 'proj', ts: new Date().toISOString() }, { dataRoot });

    const dataFiles = await listAllFiles(dataRoot);
    const srcFiles = await listAllFiles(srcRoot);

    assert.ok(dataFiles.length > 0, 'event file should exist under dataRoot');
    assert.ok(dataFiles.some(f => f.includes('events') && f.endsWith('.jsonl')), 'jsonl event file under dataRoot/events');
    assert.equal(srcFiles.length, 0, 'no files should be written to srcRoot');
  });

  it('readEvents reads from dataRoot when present', async () => {
    const { srcRoot, dataRoot } = roots;
    await appendEvent(srcRoot, 'proj', 'job-002', { type: 'job_created', jobId: 'job-002', project: 'proj', ts: new Date().toISOString() }, { dataRoot });

    const events = await readEvents(srcRoot, 'proj', 'job-002', { dataRoot });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'job_created');
  });

  it('readEvents falls back to legacy when dataRoot has no data', async () => {
    const { srcRoot, dataRoot } = roots;
    // Write to legacy path (no dataRoot)
    await appendEvent(srcRoot, 'proj', 'job-003', { type: 'job_created', jobId: 'job-003', project: 'proj', ts: new Date().toISOString() });

    // Read with dataRoot set to different location — should fall back to legacy
    const events = await readEvents(srcRoot, 'proj', 'job-003', { dataRoot });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'job_created');
  });

  it('listEventFiles scans both dataRoot and legacy paths', async () => {
    const { srcRoot, dataRoot } = roots;
    // Write one event to dataRoot
    await appendEvent(srcRoot, 'proj', 'job-a', { type: 'job_created', jobId: 'job-a', project: 'proj', ts: new Date().toISOString() }, { dataRoot });
    // Write one event to legacy
    await appendEvent(srcRoot, 'proj', 'job-b', { type: 'job_created', jobId: 'job-b', project: 'proj', ts: new Date().toISOString() });

    const files = await listEventFiles(srcRoot, { dataRoot });
    const jobIds = files.map(f => f.jobId).sort();
    assert.ok(jobIds.includes('job-a'), 'should find dataRoot event file');
    assert.ok(jobIds.includes('job-b'), 'should find legacy event file');
  });

  it('writeCheckpoint writes under dataRoot, not srcRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    await writeCheckpoint(srcRoot, 'proj', 'job-004', { jobId: 'job-004', status: 'completed' }, { dataRoot });

    const dataFiles = await listAllFiles(dataRoot);
    const srcFiles = await listAllFiles(srcRoot);

    assert.ok(dataFiles.some(f => f.includes('checkpoints')), 'checkpoint under dataRoot');
    assert.equal(srcFiles.length, 0, 'no files in srcRoot');
  });

  it('readCheckpoint reads from dataRoot, falls back to legacy', async () => {
    const { srcRoot, dataRoot } = roots;
    // Write to legacy
    await writeCheckpoint(srcRoot, 'proj', 'job-005', { jobId: 'job-005', status: 'completed' });
    // Read with dataRoot — should fall back to legacy
    const legacy = await readCheckpoint(srcRoot, 'proj', 'job-005', { dataRoot });
    assert.equal(legacy.jobId, 'job-005');

    // Write to dataRoot, should prefer dataRoot
    await writeCheckpoint(srcRoot, 'proj', 'job-005', { jobId: 'job-005', status: 'running' }, { dataRoot });
    const rt = await readCheckpoint(srcRoot, 'proj', 'job-005', { dataRoot });
    assert.equal(rt.status, 'running');
  });
});

// ── Job store ──

describe('job-store: lifecycle writes go to dataRoot', () => {
  let roots;
  beforeEach(async () => { roots = await makeTestRoots(); });
  afterEach(async () => {
    await rm(roots.srcRoot, { recursive: true, force: true });
    await rm(roots.dataRoot, { recursive: true, force: true });
  });

  it('createJob writes events under dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    const job = await createJob(srcRoot, { project: 'proj', task: 'test task', dataRoot });

    assert.ok(job.jobId, 'job should have an ID');
    const dataFiles = await listAllFiles(dataRoot);
    const srcFiles = await listAllFiles(srcRoot);
    assert.ok(dataFiles.length > 0, 'files exist under dataRoot');
    assert.equal(srcFiles.length, 0, 'no files in srcRoot');
  });

  it('full lifecycle (create→start→complete) writes to dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    const job = await createJob(srcRoot, { project: 'proj', task: 'lifecycle', dataRoot });
    const started = await startPhase(srcRoot, 'proj', job.jobId, { phase: 'plan', dataRoot });
    assert.equal(started.status, 'running');

    const completed = await completePhase(srcRoot, 'proj', job.jobId, { phase: 'plan', dataRoot });
    assert.ok(completed.completedPhases.includes('plan'));

    // Read back from dataRoot
    const fetched = await getJob(srcRoot, 'proj', job.jobId, { dataRoot });
    assert.equal(fetched.jobId, job.jobId);
    assert.ok(fetched.completedPhases.includes('plan'));

    // Confirm srcRoot is clean
    const srcFiles = await listAllFiles(srcRoot);
    assert.equal(srcFiles.length, 0, 'no files in srcRoot');
  });

  it('failJob writes to dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    const job = await createJob(srcRoot, { project: 'proj', task: 'fail-test', dataRoot });
    const failed = await failJob(srcRoot, 'proj', job.jobId, { reason: 'test fail', dataRoot });
    assert.equal(failed.status, 'failed');

    const fetched = await getJob(srcRoot, 'proj', job.jobId, { dataRoot });
    assert.equal(fetched.status, 'failed');
  });

  it('blockJob and completeJob write to dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    const job = await createJob(srcRoot, { project: 'proj', task: 'block-test', dataRoot });
    const blocked = await blockJob(srcRoot, 'proj', job.jobId, { reason: 'stuck', dataRoot });
    assert.equal(blocked.status, 'blocked');
  });

  it('recordActivity writes to dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    const job = await createJob(srcRoot, { project: 'proj', task: 'activity-test', dataRoot });
    const updated = await recordActivity(srcRoot, 'proj', job.jobId, { message: 'doing work', dataRoot });
    assert.equal(updated.lastActivityMessage, 'doing work');
  });

  it('listJobs reads from dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    await createJob(srcRoot, { project: 'proj', task: 'list-test-1', dataRoot });
    await createJob(srcRoot, { project: 'proj', task: 'list-test-2', dataRoot });

    const jobs = await listJobs(srcRoot, { dataRoot });
    assert.ok(jobs.length >= 2, 'should list jobs from dataRoot');
  });
});

// ── Lease manager ──

describe('lease-manager: writes go to dataRoot', () => {
  let roots;
  beforeEach(async () => { roots = await makeTestRoots(); });
  afterEach(async () => {
    await rm(roots.srcRoot, { recursive: true, force: true });
    await rm(roots.dataRoot, { recursive: true, force: true });
  });

  it('acquireLease writes under dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    const lease = await acquireLease(srcRoot, {
      leaseId: 'lease-001',
      jobId: 'job-001',
      phase: 'plan',
      ttlMs: 60000,
      dataRoot,
    });

    assert.ok(lease.leaseId, 'lease should have an ID');
    const dataFiles = await listAllFiles(dataRoot);
    const srcFiles = await listAllFiles(srcRoot);
    assert.ok(dataFiles.some(f => f.includes('leases')), 'lease file under dataRoot');
    assert.equal(srcFiles.length, 0, 'no files in srcRoot');
  });

  it('readLease reads from dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    await acquireLease(srcRoot, {
      leaseId: 'lease-002',
      jobId: 'job-002',
      phase: 'plan',
      ttlMs: 60000,
      dataRoot,
    });

    const lease = await readLease(srcRoot, 'lease-002', { dataRoot });
    assert.equal(lease.leaseId, 'lease-002');
  });

  it('readLease falls back to legacy when dataRoot has no lease', async () => {
    const { srcRoot, dataRoot } = roots;
    // Write to legacy
    await acquireLease(srcRoot, {
      leaseId: 'lease-003',
      jobId: 'job-003',
      phase: 'plan',
      ttlMs: 60000,
    });

    // Read with different dataRoot — should fall back
    const lease = await readLease(srcRoot, 'lease-003', { dataRoot });
    assert.equal(lease.leaseId, 'lease-003');
  });

  it('releaseLease removes lease from dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    const lease = await acquireLease(srcRoot, {
      leaseId: 'lease-004',
      jobId: 'job-004',
      phase: 'plan',
      ttlMs: 60000,
      dataRoot,
    });

    await releaseLease(srcRoot, 'lease-004', { ownerToken: lease.ownerToken, dataRoot });
    const afterRelease = await readLease(srcRoot, 'lease-004', { dataRoot });
    assert.equal(afterRelease, null);
  });
});

// ── Jobs index ──

describe('jobs-index: writes go to dataRoot', () => {
  let roots;
  beforeEach(async () => { roots = await makeTestRoots(); });
  afterEach(async () => {
    await rm(roots.srcRoot, { recursive: true, force: true });
    await rm(roots.dataRoot, { recursive: true, force: true });
  });

  it('updateJobsIndexEntry writes index to dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    await updateJobsIndexEntry(srcRoot, 'proj', 'job-001', { jobId: 'job-001', project: 'proj', status: 'running', createdAt: new Date().toISOString() }, { dataRoot });

    const dataFiles = await listAllFiles(dataRoot);
    const srcFiles = await listAllFiles(srcRoot);
    assert.ok(dataFiles.some(f => f.includes('jobs-index')), 'index file under dataRoot');
    assert.equal(srcFiles.length, 0, 'no files in srcRoot');
  });

  it('listJobsFromIndex reads from dataRoot', async () => {
    const { srcRoot, dataRoot } = roots;
    // Create a job with events under dataRoot
    await createJob(srcRoot, { project: 'proj', task: 'index-test', dataRoot });

    const jobs = await listJobsFromIndex(srcRoot, { dataRoot });
    assert.ok(jobs.some(j => j.task === 'index-test'), 'should find job from dataRoot index');
  });
});

// ── Cross-cutting: no source-tree pollution ──

describe('cross-cutting: zero source-tree writes when dataRoot is set', () => {
  let roots;
  beforeEach(async () => { roots = await makeTestRoots(); });
  afterEach(async () => {
    await rm(roots.srcRoot, { recursive: true, force: true });
    await rm(roots.dataRoot, { recursive: true, force: true });
  });

  it('complete job lifecycle produces zero files in srcRoot', async () => {
    const { srcRoot, dataRoot } = roots;

    // Create
    const job = await createJob(srcRoot, { project: 'proj', task: 'full-lifecycle', dataRoot });
    // Start phase
    await startPhase(srcRoot, 'proj', job.jobId, { phase: 'plan', dataRoot });
    // Complete phase
    await completePhase(srcRoot, 'proj', job.jobId, { phase: 'plan', dataRoot });
    // Record activity
    await recordActivity(srcRoot, 'proj', job.jobId, { message: 'progress', dataRoot });
    // Acquire lease
    const lease = await acquireLease(srcRoot, {
      leaseId: `lease-${job.jobId}`,
      jobId: job.jobId,
      phase: 'execute',
      ttlMs: 60000,
      dataRoot,
    });
    // Release lease
    await releaseLease(srcRoot, `lease-${job.jobId}`, { ownerToken: lease.ownerToken, dataRoot });
    // Complete job
    await completeJob(srcRoot, 'proj', job.jobId, { dataRoot });

    // Verify dataRoot has content
    const dataFiles = await listAllFiles(dataRoot);
    assert.ok(dataFiles.length > 0, 'dataRoot should have files');

    // Verify srcRoot is completely clean
    const srcFiles = await listAllFiles(srcRoot);
    assert.equal(srcFiles.length, 0, `srcRoot must be empty, found: ${srcFiles.join(', ')}`);
  });

  it('legacy fallback reads work alongside new dataRoot writes', async () => {
    const { srcRoot, dataRoot } = roots;

    // Write a job to legacy path
    const legacyJob = await createJob(srcRoot, { project: 'proj', task: 'legacy-job' });
    // Read it back without dataRoot
    const legacyRead = await getJob(srcRoot, 'proj', legacyJob.jobId);
    assert.equal(legacyRead.task, 'legacy-job');

    // Write a new job to dataRoot
    const newJob = await createJob(srcRoot, { project: 'proj', task: 'new-job', dataRoot });
    // Read it back with dataRoot
    const newRead = await getJob(srcRoot, 'proj', newJob.jobId, { dataRoot });
    assert.equal(newRead.task, 'new-job');

    // Legacy data still exists in srcRoot
    const srcFiles = await listAllFiles(srcRoot);
    assert.ok(srcFiles.length > 0, 'legacy data in srcRoot');

    // New data in dataRoot
    const dataFiles = await listAllFiles(dataRoot);
    assert.ok(dataFiles.length > 0, 'new data in dataRoot');
  });
});
