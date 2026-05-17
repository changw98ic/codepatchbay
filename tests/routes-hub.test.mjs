#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { hubRoutes } from '../server/routes/hub.js';
import {
  getManagedAcpPool,
  resetManagedAcpPoolsForTests,
} from '../server/services/acp-pool-runtime.js';

async function buildApp(cpbRoot, hubRoot) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cors, { origin: true });
  app.addHook('onRequest', (req, _res, done) => {
    req.cpbRoot = cpbRoot;
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(hubRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not met');
}

describe('Hub routes', () => {
  let cpbRoot;
  let hubRoot;
  let projectRoot;
  let app;

  beforeEach(async () => {
    cpbRoot = await mkdtemp(path.join(tmpdir(), 'cpb-route-cpb-'));
    hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-route-hub-'));
    projectRoot = await mkdtemp(path.join(tmpdir(), 'cpb-route-project-'));
    app = await buildApp(cpbRoot, hubRoot);
  });

  afterEach(async () => {
    await app.close();
    resetManagedAcpPoolsForTests();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('attaches projects and returns Hub status through HTTP routes', async () => {
    const attach = await app.inject({
      method: 'POST',
      url: '/api/hub/projects/attach',
      payload: { sourcePath: projectRoot, name: 'route-project' },
    });
    assert.equal(attach.statusCode, 200);
    assert.equal(attach.json().project.id, 'route-project');

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/hub/projects/route-project/heartbeat',
      payload: { workerId: 'route-worker', status: 'online', capabilities: ['scan'] },
    });
    assert.equal(heartbeat.statusCode, 200);

    const status = await app.inject({ method: 'GET', url: '/api/hub/status' });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().projectCount, 1);
    assert.equal(status.json().workersOnline, 1);
    assert.equal(status.json().workersStale, 0);
    assert.equal(status.json().workersOffline, 0);

    const projects = await app.inject({ method: 'GET', url: '/api/hub/projects' });
    assert.equal(projects.statusCode, 200);
    assert.equal(projects.json()[0].worker.status, 'online');
    assert.equal(projects.json()[0].workerDerivedStatus, 'online');
  });

  it('returns ACP pool status with durable provider backoff', async () => {
    await mkdir(path.join(hubRoot, 'providers'), { recursive: true });
    await writeFile(
      path.join(hubRoot, 'providers', 'rate-limits.json'),
      JSON.stringify({
        codex: {
          agent: 'codex',
          untilTs: '2026-05-17T10:00:00.000Z',
          reason: '429',
        },
      }),
      'utf8',
    );

    const acp = await app.inject({ method: 'GET', url: '/api/hub/acp' });
    assert.equal(acp.statusCode, 200);
    assert.equal(acp.json().pools.codex.mode, 'managed-shared');
    assert.equal(acp.json().rateLimits.codex.reason, '429');
  });

  it('returns live ACP pool counters from the shared Hub runtime', async () => {
    const releases = [];
    getManagedAcpPool({
      cpbRoot,
      hubRoot,
      limits: { codex: 1 },
      runner: async () => {
        await new Promise((resolve) => {
          releases.push(resolve);
        });
        return 'ok';
      },
    });
    const pool = getManagedAcpPool({ cpbRoot, hubRoot });

    const first = pool.execute('codex', 'first');
    const second = pool.execute('codex', 'second');
    await waitFor(() => pool.status().pools.codex.active === 1 && pool.status().pools.codex.queued === 1);

    const acp = await app.inject({ method: 'GET', url: '/api/hub/acp' });
    assert.equal(acp.statusCode, 200);
    assert.equal(acp.json().pools.codex.active, 1);
    assert.equal(acp.json().pools.codex.queued, 1);
    assert.equal(acp.json().mode, 'managed-shared');

    releases.shift()();
    await first;
    await waitFor(() => releases.length === 1);
    releases.shift()();
    await second;
  });
});
