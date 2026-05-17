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
import { resetAllPoolRuntimes } from '../server/services/acp-pool-runtime.js';
import { getHubRuntime, resetInstances as resetHubRuntimeInstances } from '../server/services/hub-runtime.js';

async function buildApp(cpbRoot, hubRoot) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cors, { origin: true });
  resetHubRuntimeInstances();
  const hubRuntime = getHubRuntime(cpbRoot, hubRoot);
  app.addHook('onRequest', (req, _res, done) => {
    req.cpbRoot = cpbRoot;
    req.cpbHubRoot = hubRoot;
    req.hubRuntime = hubRuntime;
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
    resetAllPoolRuntimes();
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

  it('shares the same pool instance across /api/hub/acp calls', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/hub/acp' });
    const second = await app.inject({ method: 'GET', url: '/api/hub/acp' });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.json().createdAt, second.json().createdAt);
    assert.ok(first.json().pools.codex.capabilities.includes('live-requests'));
    assert.ok(Array.isArray(first.json().pools.codex.activeRequests));
  });

  it('reflects pool singleton state changes through /api/hub/acp', async () => {
    const { getPoolRuntime } = await import('../server/services/acp-pool-runtime.js');
    const pool = getPoolRuntime(hubRoot, cpbRoot);

    pool.requestCount.set('codex', 42);
    pool.errorCount.set('codex', 3);

    const acp = await app.inject({ method: 'GET', url: '/api/hub/acp' });
    assert.equal(acp.json().pools.codex.requestCount, 42);
    assert.equal(acp.json().pools.codex.errorCount, 3);
  });

  it('includes runtime metadata in /api/hub/status', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/hub/status' });
    assert.equal(status.statusCode, 200);
    const body = status.json();
    assert.ok(body.runtime, 'response should contain runtime');
    assert.equal(body.runtime.pid, process.pid);
    assert.equal(body.runtime.version, '0.2.0');
    assert.equal(body.runtime.health, 'alive');
    assert.equal(body.runtime.runtime, 'node');
    assert.ok(body.runtime.startedAt);
    assert.ok(body.runtime.statePath);
  });

  it('returns diagnostics bundle without secrets', async () => {
    await mkdir(path.join(hubRoot, 'providers'), { recursive: true });
    await writeFile(
      path.join(hubRoot, 'providers', 'rate-limits.json'),
      JSON.stringify({
        claude: {
          agent: 'claude',
          untilTs: '2026-05-17T12:00:00.000Z',
          reason: 'api_key=sk-secret Bearer tok_hidden',
        },
      }),
      'utf8',
    );

    const res = await app.inject({ method: 'GET', url: '/api/hub/diagnostics' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.gatheredAt);
    assert.ok(body.hub);
    assert.ok(body.queue);
    assert.ok(body.acp);
    assert.ok(body.knowledgePolicy);
    assert.ok(Array.isArray(body.recentJobs));

    const reason = body.acp?.rateLimits?.claude?.reason || '';
    assert.ok(!reason.includes('sk-secret'));
    assert.ok(!reason.includes('tok_hidden'));
  });

  it('returns promotion candidates for projects with session memory', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/hub/projects/attach',
      payload: { sourcePath: projectRoot, name: 'promo-project' },
    });

    const sessionDir = path.join(projectRoot, 'cpb-task', 'sessions', 'sess-001');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, 'memory.md'), 'useful insight', 'utf8');

    const res = await app.inject({ method: 'GET', url: '/api/hub/knowledge/promotion-candidates' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.candidates));
    const entry = body.candidates.find((c) => c.projectId === 'promo-project');
    assert.ok(entry, 'should have promotion candidates for promo-project');
    assert.equal(entry.candidates.length, 1);
    assert.equal(entry.candidates[0].kind, 'session-memory');
    assert.equal(entry.candidates[0].targetKind, 'project-memory');
  });
});
