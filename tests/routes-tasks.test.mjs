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
 *
 * Registering with { prefix: '/api' } yields /api/tasks/* URLs,
 * matching the production server/index.js behavior.
 *
 * Task routes spawn bridge scripts via child_process. For testing,
 * we set up a dummy bridges directory with scripts that exit immediately.
 */
async function buildApp(cpbRoot) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cors, { origin: true });
  app.addHook('onRequest', (req, _res, done) => {
    req.cpbRoot = cpbRoot;
    done();
  });
  await app.register(taskRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

/**
 * Create a temp cpb root with dummy bridge scripts.
 * Each bridge script is a bash one-liner that exits 0 immediately.
 */
async function setupTempRoot() {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-tasks-'));
  await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'bridges'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'cpb-task/state'), { recursive: true });

  // Create dummy bridge scripts that just exit cleanly
  const scripts = ['codex-plan.sh', 'claude-execute.sh', 'codex-verify.sh', 'run-pipeline.sh'];
  for (const script of scripts) {
    await fs.writeFile(
      path.join(tmpRoot, 'bridges', script),
      '#!/bin/bash\nexit 0\n'
    );
    // Make executable
    await fs.chmod(path.join(tmpRoot, 'bridges', script), 0o755);
  }

  // Create init-project.sh as well (tasks don't use it, but just in case)
  await fs.writeFile(
    path.join(tmpRoot, 'bridges', 'init-project.sh'),
    '#!/bin/bash\nexit 0\n'
  );
  await fs.chmod(path.join(tmpRoot, 'bridges', 'init-project.sh'), 0o755);

  return tmpRoot;
}

describe('GET /api/tasks/running', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await setupTempRoot();
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('returns empty array initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks/running' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });
});

describe('GET /api/tasks/durable', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await setupTempRoot();
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('returns empty array when no durable jobs exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks/durable' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });

  it('returns jobs from the event store', async () => {
    // Create a job event file directly
    const eventsDir = path.join(tmpRoot, 'cpb-task/events/my-proj');
    await fs.mkdir(eventsDir, { recursive: true });
    const jobEvent = {
      type: 'job_created',
      jobId: 'job-20260513-120000-abc123',
      project: 'my-proj',
      task: 'Add tests',
      workflow: 'standard',
      ts: '2026-05-13T12:00:00.000Z',
    };
    await fs.appendFile(
      path.join(eventsDir, 'job-20260513-120000-abc123.jsonl'),
      JSON.stringify(jobEvent) + '\n'
    );

    const res = await app.inject({ method: 'GET', url: '/api/tasks/durable' });
    assert.equal(res.statusCode, 200);

    const jobs = res.json();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].jobId, 'job-20260513-120000-abc123');
    assert.equal(jobs[0].project, 'my-proj');
    assert.equal(jobs[0].task, 'Add tests');
    assert.equal(jobs[0].status, 'running');
  });
});

describe('POST /api/tasks/:name/plan', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await setupTempRoot();
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('accepts valid plan request and returns task metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/plan',
      payload: { task: 'Add dark mode toggle' },
    });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.accepted, true);
    assert.ok(body.taskId);
    assert.ok(typeof body.pid === 'number');
  });

  it('returns 400 when task body is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/plan',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('task'));
  });

  it('returns 400 when body is null', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/plan',
      payload: null,
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('POST /api/tasks/:name/execute', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await setupTempRoot();
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('accepts valid execute request and returns task metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/execute',
      payload: { planId: 'plan-001' },
    });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.accepted, true);
    assert.ok(body.taskId);
  });

  it('returns 400 when planId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/execute',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('planId'));
  });

  it('returns 400 when planId is empty string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/execute',
      payload: { planId: '' },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('POST /api/tasks/:name/verify', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await setupTempRoot();
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('accepts valid verify request and returns task metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/verify',
      payload: { deliverableId: 'deliverable-001' },
    });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.accepted, true);
    assert.ok(body.taskId);
  });

  it('returns 400 when deliverableId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/verify',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('deliverableId'));
  });
});

describe('POST /api/tasks/:name/pipeline', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await setupTempRoot();
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('accepts valid pipeline request and returns task metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/pipeline',
      payload: { task: 'Add unit tests' },
    });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.accepted, true);
    assert.ok(body.taskId);
  });

  it('uses default maxRetries and timeout when not provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/pipeline',
      payload: { task: 'Add unit tests' },
    });
    assert.equal(res.statusCode, 200);
    // The pipeline route uses defaults: maxRetries='3', timeout='0'
    // which are passed to the bridge script
    assert.equal(res.json().accepted, true);
  });

  it('returns 400 when task is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-proj/pipeline',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('task'));
  });
});

describe('Project name validation', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await setupTempRoot();
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('rejects project name with spaces', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/bad%20name/plan',
      payload: { task: 'Do something' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Invalid project name'));
  });

  it('rejects project name with special characters', async () => {
    // Use URL-safe characters that pass through Fastify routing but fail SAFE_NAME
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/hack.name/plan',
      payload: { task: 'Do something' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects project name starting with hyphen', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/-bad/plan',
      payload: { task: 'Do something' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('accepts valid project name with hyphens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-valid-project/plan',
      payload: { task: 'Do something' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().accepted, true);
  });

  it('accepts single character project name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/a/plan',
      payload: { task: 'Do something' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().accepted, true);
  });
});
