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
    assert.equal(acp.json().pools.codex.mode, 'bounded-one-shot');
    assert.equal(acp.json().rateLimits.codex.reason, '429');
  });
});
