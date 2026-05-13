#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import fs from 'fs/promises';
import path from 'path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { taskRoutes } from '../server/routes/tasks.js';

/**
 * Build a test Fastify app with task routes registered.
 * Mirrors server/index.js registration: app.register(taskRoutes, { prefix: '/api' })
 */
async function buildApp(flowRoot) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cors, { origin: true });
  app.addHook('onRequest', (req, _res, done) => {
    req.flowRoot = flowRoot;
    done();
  });
  await app.register(taskRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

/**
 * Seed a job event file so that requestCancelJob / requestRedirectJob
 * can materialize the job and return state.
 */
async function seedJob(flowRoot, project, jobId, task = 'test task') {
  const eventsDir = path.join(flowRoot, 'flow-task', 'events', project);
  await fs.mkdir(eventsDir, { recursive: true });
  const event = JSON.stringify({
    type: 'job_created',
    jobId,
    project,
    task,
    workflow: 'standard',
    ts: new Date().toISOString(),
  });
  await fs.writeFile(path.join(eventsDir, `${jobId}.jsonl`), `${event}\n`, 'utf8');
}

describe('POST /api/tasks/:name/cancel', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'flow-test-cancel-'));
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('returns 200 with cancel metadata for valid jobId', async () => {
    await seedJob(tmpRoot, 'my-proj', 'job-20260514-abc123');
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/cancel',
      payload: { jobId: 'job-20260514-abc123', reason: 'user abort' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.jobId, 'job-20260514-abc123');
    assert.equal(body.project, 'my-proj');
    assert.equal(body.cancelRequested, true);
    assert.equal(body.cancelReason, 'user abort');
  });

  it('returns 400 when jobId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/cancel',
      payload: { reason: 'nope' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('jobId'));
  });

  it('returns 400 for invalid project name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/bad!name/cancel',
      payload: { jobId: 'job-123', reason: 'test' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns cancel state for non-existent project/job (no prior events)', async () => {
    // requestCancelJob appends a job_cancel_requested event; materializeJob
    // picks up jobId, project, cancelRequested from that single event,
    // but task/status/createdAt remain null since there was no job_created.
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/ghost/cancel',
      payload: { jobId: 'job-nonexist', reason: 'gone' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.jobId, 'job-nonexist');
    assert.equal(body.project, 'ghost');
    assert.equal(body.cancelRequested, true);
    assert.equal(body.cancelReason, 'gone');
    // No prior job_created event, so these remain null
    assert.equal(body.task, null);
    assert.equal(body.status, null);
    assert.equal(body.createdAt, null);
  });
});

describe('POST /api/tasks/:name/redirect', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'flow-test-redirect-'));
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('returns 200 with redirect metadata for valid jobId', async () => {
    await seedJob(tmpRoot, 'my-proj', 'job-20260514-def456');
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/redirect',
      payload: {
        jobId: 'job-20260514-def456',
        instructions: 'Focus on error handling',
        reason: 'scope change',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.jobId, 'job-20260514-def456');
    assert.equal(body.project, 'my-proj');
    assert.equal(body.redirectContext, 'Focus on error handling');
    assert.equal(body.redirectReason, 'scope change');
    assert.ok(body.redirectEventId);
  });

  it('returns 400 when jobId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/redirect',
      payload: { instructions: 'do stuff' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('jobId'));
  });

  it('returns 400 when instructions are missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/redirect',
      payload: { jobId: 'job-123', reason: 'why not' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('instructions'));
  });

  it('returns 400 when both jobId and instructions are missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/redirect',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });
});
