#!/usr/bin/env node
// @ts-nocheck

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import fs from 'fs/promises';
import path from 'path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { taskRoutes } from '../server/routes/tasks.js';
import { registerProject } from '../server/services/hub-registry.js';

/**
 * Build a test Fastify app with task routes.
 * Sets up cpbRoot and cpbHubRoot for proper isolation.
 */
async function buildApp(cpbRoot, hubRoot) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cors, { origin: true });
  app.addHook('onRequest', (req, _res, done) => {
    req.cpbRoot = cpbRoot;
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(taskRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

/**
 * Set up temp roots: cpbRoot (legacy data), hubRoot (hub registry + queue),
 * projectRoot (source code). Create minimal hub structure and CodeGraph fixture.
 */
async function setupTempRoots() {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-tasks-'));
  const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-hub-'));
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-project-'));

  await mkdir(path.join(cpbRoot, 'cpb-task/state'), { recursive: true });
  await mkdir(path.join(cpbRoot, 'wiki/projects'), { recursive: true });
  await mkdir(path.join(hubRoot, 'queue'), { recursive: true });

  await registerProject(hubRoot, { skipCodeGraphGate: true, name: 'test-proj', sourcePath: projectRoot, id: 'test-proj' });

  return { cpbRoot, hubRoot, projectRoot };
}

// ── GET /api/tasks/running ──

describe('GET /api/tasks/running', () => {
  let cpbRoot, hubRoot, projectRoot, app;

  beforeEach(async () => {
    ({ cpbRoot, hubRoot, projectRoot } = await setupTempRoots());
    app = await buildApp(cpbRoot, hubRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('returns empty array initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks/running' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });
});

// ── GET /api/tasks/durable ──

describe('GET /api/tasks/durable', () => {
  let cpbRoot, hubRoot, projectRoot, app;

  beforeEach(async () => {
    ({ cpbRoot, hubRoot, projectRoot } = await setupTempRoots());
    app = await buildApp(cpbRoot, hubRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('returns empty array when no durable jobs exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks/durable' });
    assert.equal(res.statusCode, 200);
    const jobs = res.json();
    // Should be empty — tmpRoot has no events, hub has no queued jobs
    assert.ok(Array.isArray(jobs));
    assert.equal(jobs.length, 0);
  });

  it('returns jobs from the event store', async () => {
    const eventsDir = path.join(cpbRoot, 'cpb-task/events/test-proj');
    await mkdir(eventsDir, { recursive: true });
    const jobEvent = {
      type: 'job_created',
      jobId: 'job-20260513-120000-abc123',
      project: 'test-proj',
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
    assert.ok(Array.isArray(jobs));
    // Job should appear in the list
    const found = jobs.find(j => j.jobId === 'job-20260513-120000-abc123');
    assert.ok(found, 'should find the created job');
    assert.equal(found.project, 'test-proj');
    assert.equal(found.task, 'Add tests');
  });
});

// ── POST /api/tasks/:name/pipeline ──

describe('POST /api/tasks/:name/pipeline', () => {
  let cpbRoot, hubRoot, projectRoot, app;

  beforeEach(async () => {
    ({ cpbRoot, hubRoot, projectRoot } = await setupTempRoots());
    app = await buildApp(cpbRoot, hubRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('queues a valid pipeline request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/test-proj/pipeline',
      payload: { task: 'Add unit tests' },
    });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.queued, true);
    assert.ok(body.entry);
    assert.ok(body.entry.id);
    assert.equal(body.entry.description, 'Add unit tests');
  });

  it('returns 400 when task is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/test-proj/pipeline',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('task'));
  });

  it('returns 404 for unregistered project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/unknown-proj/pipeline',
      payload: { task: 'Do something' },
    });
    assert.equal(res.statusCode, 404);
  });
});

// ── Project name validation ──

describe('Project name validation', () => {
  let cpbRoot, hubRoot, projectRoot, app;

  beforeEach(async () => {
    ({ cpbRoot, hubRoot, projectRoot } = await setupTempRoots());
    app = await buildApp(cpbRoot, hubRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('rejects project name with spaces', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/bad%20name/pipeline',
      payload: { task: 'Do something' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Invalid project name'));
  });

  it('rejects project name with special characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/hack.name/pipeline',
      payload: { task: 'Do something' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects project name starting with hyphen', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/-bad/pipeline',
      payload: { task: 'Do something' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('accepts valid project name with hyphens', async () => {
    // Register this project in hub
    const extraSrc = await mkdtemp(path.join(tmpdir(), 'cpb-test-extra-'));
    await registerProject(hubRoot, { skipCodeGraphGate: true, name: 'my-valid-project', sourcePath: extraSrc, id: 'my-valid-project' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/my-valid-project/pipeline',
      payload: { task: 'Do something' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().queued, true);

    await rm(extraSrc, { recursive: true, force: true });
  });
});
