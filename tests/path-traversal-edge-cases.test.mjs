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

import { projectRoutes } from '../server/routes/projects.js';

/**
 * Build a test Fastify app — mirrors routes-projects.test.mjs.
 */
async function buildApp(cpbRoot) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cors, { origin: true });
  app.addHook('onRequest', (req, _res, done) => {
    req.cpbRoot = cpbRoot;
    done();
  });
  await app.register(projectRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

async function createProjectDir(root, name) {
  const projDir = path.join(root, 'wiki/projects', name);
  await fs.mkdir(path.join(projDir, 'inbox'), { recursive: true });
  await fs.mkdir(path.join(projDir, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(projDir, 'context.md'), '# context');
  return projDir;
}

describe('Path traversal edge cases', () => {
  let tmpRoot, app, projDir;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-traversal-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    app = await buildApp(tmpRoot);
    projDir = await createProjectDir(tmpRoot, 'proj');
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  // 1. URL-encoded traversal (%2e = '.', %2f = '/')
  it('rejects URL-encoded path traversal', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj/files/%2e%2e%2f%2e%2e/etc/passwd',
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 403 || res.statusCode === 404,
      `Expected 400/403/404, got ${res.statusCode}`);
  });

  // 2. Double-encoded traversal (%252e = '%2e' after first decode)
  it('rejects double-encoded path traversal', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj/files/%252e%252e%252f',
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 403 || res.statusCode === 404,
      `Expected 400/403/404, got ${res.statusCode}`);
  });

  // 3. Absolute path after project dir
  it('rejects absolute path in file route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj/files//etc/passwd',
    });
    // Fastify collapses // or the resolved path escapes projDir
    assert.ok(res.statusCode === 400 || res.statusCode === 403 || res.statusCode === 404,
      `Expected 400/403/404, got ${res.statusCode}`);
  });

  // 4. Null byte injection
  it('rejects null byte injection', async () => {
    // app.inject does not URL-decode, so we pass the raw URL with %00
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj/files/test%00.md',
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 403 || res.statusCode === 404,
      `Expected 400/403/404, got ${res.statusCode}`);
  });

  // 9. Symlink escape — realpath resolves symlinks before boundary check,
  //    so a symlink pointing outside projDir is rejected.
  it('rejects symlink pointing outside project root', async () => {
    const secretFile = path.join(tmpRoot, 'secret.txt');
    await fs.writeFile(secretFile, 'top-secret');

    const linkPath = path.join(projDir, 'escape-link.txt');
    await fs.symlink('../../../secret.txt', linkPath);

    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj/files/escape-link.txt',
    });

    assert.equal(res.statusCode, 403,
      'Symlink escape must be rejected');
  });

  // 10. Symlink within project — still allowed after realpath fix
  it('allows symlink pointing to file within project', async () => {
    const linkPath = path.join(projDir, 'link-to-context.md');
    await fs.symlink('context.md', linkPath);

    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj/files/link-to-context.md',
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().content, '# context');
  });

  // 11. Dangling symlink — realpath fails with ENOENT, returns 404 (not 500)
  it('returns 404 for dangling symlink', async () => {
    const linkPath = path.join(projDir, 'dangling.md');
    await fs.symlink('nonexistent.md', linkPath);

    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj/files/dangling.md',
    });

    assert.equal(res.statusCode, 404);
  });
});

describe('Project name validation edge cases', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-name-edge-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  // 5. Unicode in project name
  it('rejects unicode project name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/tmp', name: 'test项目' },
    });
    assert.equal(res.statusCode, 400);
  });

  // 6. Very long project name (> 256 chars) — SAFE_NAME regex has no length
  //    limit, so the name passes validation and fails later at execFileAsync.
  //    This documents that the server does NOT enforce length constraints.
  it('long project name passes validation but fails at init script (no length limit)', async () => {
    const longName = 'a'.repeat(300);
    const validPath = await mkdtemp(path.join(process.env.HOME, '.cpb-test-'));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/init',
        payload: { path: validPath, name: longName },
      });
      // SAFE_NAME regex accepts any length, so this hits execFileAsync (500 — script missing in test env)
      assert.equal(res.statusCode, 500,
        'Long name passes SAFE_NAME but fails at exec — no length guard exists');
    } finally {
      await rm(validPath, { recursive: true }).catch(() => {});
    }
  });

  // 7. Project name with only hyphens
  it('rejects project name with only hyphens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/tmp', name: '---' },
    });
    assert.equal(res.statusCode, 400);
  });

  // 8. Project name with encoded space
  it('rejects project name with space (percent-encoded in URL)', async () => {
    // POST body is JSON — the name arrives as a literal string with a space
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/tmp', name: 'test project' },
    });
    assert.equal(res.statusCode, 400);
  });

  // Additional edge: single character name (valid)
  it('accepts single character project name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/tmp', name: 'a' },
    });
    // May fail on exec of init-project.sh, but should NOT be a 400 validation error
    assert.ok(res.statusCode !== 400,
      `Expected non-400 (validation pass), got ${res.statusCode}`);
  });

  // Additional edge: empty name
  it('rejects empty project name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/tmp', name: '' },
    });
    assert.equal(res.statusCode, 400);
  });

  // Additional edge: name with dots
  it('rejects project name with dots', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/tmp', name: 'my.project' },
    });
    assert.equal(res.statusCode, 400);
  });

  // Additional edge: name with underscores
  it('rejects project name with underscores', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/tmp', name: 'my_project' },
    });
    assert.equal(res.statusCode, 400);
  });
});
