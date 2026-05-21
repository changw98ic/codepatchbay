#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

describe('Hub index routes', () => {
  let cpbRoot;
  let hubRoot;
  let projectRoot;
  let app;

  beforeEach(async () => {
    cpbRoot = await mkdtemp(path.join(tmpdir(), 'cpb-idx-route-cpb-'));
    hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-idx-route-hub-'));
    projectRoot = await mkdtemp(path.join(tmpdir(), 'cpb-idx-route-project-'));
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'route-idx-test',
      scripts: { test: 'node --test', build: 'echo build' },
    }, null, 2));
    await writeFile(path.join(projectRoot, 'src', 'index.js'), 'export function run() {}\n');
    app = await buildApp(cpbRoot, hubRoot);
  });

  afterEach(async () => {
    await app.close();
    resetAllPoolRuntimes();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('reports missing index before refresh', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/hub/projects/attach',
      payload: { sourcePath: projectRoot, id: 'idx-missing-test' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/hub/projects/idx-missing-test/index' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'missing');
  });

  it('refreshes index and reports ready', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/hub/projects/attach',
      payload: { sourcePath: projectRoot, id: 'idx-refresh-test' },
    });

    const refresh = await app.inject({ method: 'POST', url: '/api/hub/projects/idx-refresh-test/index/refresh' });
    assert.equal(refresh.statusCode, 200);
    const refreshBody = refresh.json();
    assert.equal(refreshBody.status, 'ready');
    assert.ok(refreshBody.fileCount > 0);

    const status = await app.inject({ method: 'GET', url: '/api/hub/projects/idx-refresh-test/index' });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().status, 'ready');
    assert.ok(status.json().fileCount > 0);
  });

  it('includes indexStatus in project list', async () => {
    const id = `idx-list-${randomUUID().slice(0, 8)}`;
    await app.inject({
      method: 'POST',
      url: '/api/hub/projects/attach',
      payload: { sourcePath: projectRoot, id },
    });

    await app.inject({ method: 'POST', url: `/api/hub/projects/${id}/index/refresh` });
    const after = await app.inject({ method: 'GET', url: '/api/hub/projects' });
    const projAfter = after.json().find((p) => p.id === id);
    assert.ok(projAfter, 'project found in list');
    assert.ok(projAfter.indexStatus, 'indexStatus present');
    assert.equal(projAfter.indexStatus.status, 'ready');
    assert.ok(projAfter.indexStatus.fileCount > 0);
    assert.ok(projAfter.indexStatus.commandCount >= 0);
  });

  it('returns 404 for unknown project index', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hub/projects/nonexistent/index' });
    assert.equal(res.statusCode, 404);
  });

  it('reports stale when artifacts are missing after refresh', async () => {
    const id = `idx-stale-${randomUUID().slice(0, 8)}`;
    await app.inject({
      method: 'POST',
      url: '/api/hub/projects/attach',
      payload: { sourcePath: projectRoot, id },
    });
    await app.inject({ method: 'POST', url: `/api/hub/projects/${id}/index/refresh` });

    const statusRes = await app.inject({ method: 'GET', url: `/api/hub/projects/${id}` });
    const proj = statusRes.json();
    const idxDir = path.join(proj.projectRuntimeRoot, 'index');
    const { unlink } = await import('node:fs/promises');
    await unlink(path.join(idxDir, 'files.json')).catch(() => {});

    const staleRes = await app.inject({ method: 'GET', url: `/api/hub/projects/${id}/index` });
    assert.equal(staleRes.json().status, 'stale');
  });
});
