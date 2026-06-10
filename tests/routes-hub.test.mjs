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
import { resetAllPoolRuntimes } from '../server/services/acp-pool.js';
import { getHubRuntime, resetInstances as resetHubRuntimeInstances } from '../server/services/hub-runtime.js';
import { enqueue, updateEntry } from '../server/services/hub-queue.js';

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
    const acpBody = acp.json();
    assert.equal(acpBody.pools.codex.mode, 'pool-admission-singleton');
    assert.equal(acpBody.pools.codex.transport, 'persistent-acp-agent-process');
    assert.equal(acpBody.pools.codex.providerProcessReuse, true);
    assert.equal(acpBody.providerProcessReuse, true);
    assert.equal(acpBody.poolSingleton, true);
    assert.ok(acpBody.pools.codex.capabilities.includes('pool-singleton'));
    assert.ok(acpBody.pools.codex.capabilities.includes('provider-process-reuse'));
    assert.equal(acpBody.rateLimits.codex.reason, '429');
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
    const { getPoolRuntime } = await import('../server/services/acp-pool.js');
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

  it('returns observability summary via /api/hub/observability', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/hub/projects/attach',
      payload: { sourcePath: projectRoot, name: 'obs-route-project' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/hub/projects/obs-route-project/heartbeat',
      payload: { workerId: 'obs-worker', status: 'online', capabilities: ['scan'] },
    });

    const res = await app.inject({ method: 'GET', url: '/api/hub/observability' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.generatedAt);
    assert.equal(body.workers.online, 1);
    assert.equal(body.workers.details.length, 1);
    assert.equal(body.workers.details[0].id, 'obs-route-project');
    assert.equal(body.workers.details[0].status, 'online');
    assert.ok(typeof body.workers.details[0].ageMs === 'number');
    assert.ok(body.queue);
    assert.ok(body.pools);
    assert.ok(body.dispatchSummary);
    assert.equal(body.dispatchSummary.total, 0);
  });

  it('returns UI-readable task history via /api/hub/task-history', async () => {
    await enqueue(hubRoot, {
      projectId: 'flow',
      sourcePath: projectRoot,
      description: 'P0.8a: Add CPB version and runtime identity report',
      metadata: {
        source: 'github_issue',
        issueNumber: 20,
        issueUrl: 'https://github.com/changw98ic/codepatchbay/issues/20',
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/hub/task-history?limit=5&kinds=queue' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.generatedAt);
    assert.equal(body.summary.totalItems, 1);
    assert.equal(body.summary.visibleItems, 1);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].kind, 'queue');
    assert.equal(body.items[0].title, 'P0.8a: Add CPB version and runtime identity report');
    assert.equal(body.items[0].links[0].label, '#20');
  });

  it('returns human and agent task ledger via /api/hub/task-ledger', async () => {
    await mkdir(path.join(hubRoot, 'github'), { recursive: true });
    await writeFile(
      path.join(hubRoot, 'github', 'issues.json'),
      JSON.stringify({
        issues: [
          {
            repository: 'changw98ic/codepatchbay',
            number: 20,
            title: 'P0.8a: Add CPB version and runtime identity report',
            state: 'OPEN',
            url: 'https://github.com/changw98ic/codepatchbay/issues/20',
            body: '## Goal\n\nExpose a machine-readable CPB identity report.',
            labels: ['enhancement', 'cpb-queued'],
            createdAt: '2026-05-20T06:00:00.000Z',
            updatedAt: '2026-05-20T06:40:00.000Z',
          },
        ],
      }),
      'utf8',
    );
    await enqueue(hubRoot, {
      projectId: 'flow',
      sourcePath: projectRoot,
      priority: 'P1',
      description: 'P0.8a: Add CPB version and runtime identity report',
      metadata: {
        repo: 'changw98ic/codepatchbay',
        source: 'github_issue',
        issueNumber: 20,
        issueUrl: 'https://github.com/changw98ic/codepatchbay/issues/20',
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/hub/task-ledger?limit=5' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.summary.total, 1);
    assert.equal(body.summary.ready, 1);
    assert.equal(body.tasks[0].status, 'ready');
    assert.equal(body.tasks[0].source.label, 'GitHub issue #20');
    assert.ok(body.tasks[0].human.summary.includes('Expose a machine-readable'));
    assert.ok(body.tasks[0].agent.execution.queueEntryId);
  });

  it('observability pool lifecycle includes requestCount and errorCount', async () => {
    const { getPoolRuntime } = await import('../server/services/acp-pool.js');
    const pool = getPoolRuntime(hubRoot, cpbRoot);
    pool.requestCount.set('codex', 10);
    pool.errorCount.set('codex', 1);

    const res = await app.inject({ method: 'GET', url: '/api/hub/observability' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.pools.codex.requestCount, 10);
    assert.equal(body.pools.codex.errorCount, 1);
    assert.ok(typeof body.pools.codex.processAgeMs === 'number' || body.pools.codex.processAgeMs === null);
    assert.ok(body.pools.codex.mode);
    assert.ok(body.pools.codex.transport);
    assert.equal(body.pools.codex.providerProcessReuse, true);
  });

  it('POST /hub/queue/claim skips busy project and claims from another', async () => {
    const a1 = await enqueue(hubRoot, { projectId: 'proj-a', sourcePath: projectRoot, description: 'a-task-1' });
    await updateEntry(hubRoot, a1.id, { status: 'in_progress', claimedBy: 'w1', workerId: 'w1', claimedAt: new Date().toISOString() });
    await enqueue(hubRoot, { projectId: 'proj-a', sourcePath: projectRoot, description: 'a-task-2' });
    await enqueue(hubRoot, { projectId: 'proj-b', sourcePath: projectRoot, description: 'b-task-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/hub/queue/claim',
      payload: { workerId: 'w2', maxActivePerProject: 1 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.claimed, true);
    assert.equal(body.entry.projectId, 'proj-b');
    assert.ok(body.skippedBusy.includes('proj-a'));
    // dispatch is null when dispatch recording not enabled
  });

  it('POST /hub/queue/claim returns no-claim when all projects busy', async () => {
    const a1 = await enqueue(hubRoot, { projectId: 'proj-a', sourcePath: projectRoot, description: 'a-task-1' });
    await updateEntry(hubRoot, a1.id, { status: 'in_progress', claimedBy: 'w1', workerId: 'w1', claimedAt: new Date().toISOString() });
    await enqueue(hubRoot, { projectId: 'proj-a', sourcePath: projectRoot, description: 'a-task-2' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/hub/queue/claim',
      payload: { workerId: 'w2', maxActivePerProject: 1 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.claimed, false);
    assert.equal(body.reason, 'all-projects-busy');
  });

  it('POST /hub/queue/claim respects providerSlotsAvailable', async () => {
    await enqueue(hubRoot, { projectId: 'proj-a', sourcePath: projectRoot, description: 'a-task-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/hub/queue/claim',
      payload: { workerId: 'w1', providerSlotsAvailable: false },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.claimed, false);
    assert.equal(body.reason, 'provider-slots-exhausted');
  });

  it('GET /hub/queue/status includes per-project breakdown', async () => {
    const a1 = await enqueue(hubRoot, { projectId: 'proj-a', sourcePath: projectRoot, description: 'a-task-1' });
    await updateEntry(hubRoot, a1.id, { status: 'in_progress', claimedBy: 'w1', workerId: 'w1', claimedAt: new Date().toISOString() });
    await enqueue(hubRoot, { projectId: 'proj-b', sourcePath: projectRoot, description: 'b-task-1' });

    const res = await app.inject({ method: 'GET', url: '/api/hub/queue/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 2);
    assert.ok(body.projects);
    assert.equal(body.projects['proj-a'].activeMutating, 1);
    assert.ok(Array.isArray(body.activeProjects));
    assert.equal(body.activeProjects[0].projectId, 'proj-a');
  });
});
