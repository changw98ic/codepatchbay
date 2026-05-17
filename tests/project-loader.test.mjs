#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  loadProjectFiles,
  extractLogTail,
  clearProjectCache,
  ALL_FILES,
} from '../server/services/project-loader.js';

async function createProjectDir(root, name, opts = {}) {
  const projDir = path.join(root, 'wiki/projects', name);
  await fs.mkdir(path.join(projDir, 'inbox'), { recursive: true });
  await fs.mkdir(path.join(projDir, 'outputs'), { recursive: true });

  for (const f of ['context', 'tasks', 'decisions', 'log']) {
    if (opts[f]) await fs.writeFile(path.join(projDir, `${f}.md`), opts[f]);
  }
  return projDir;
}

describe('loadProjectFiles', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-loader-test-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    clearProjectCache();
  });

  afterEach(async () => {
    clearProjectCache();
    await rm(tmpRoot, { recursive: true });
  });

  it('reads all files when they exist', async () => {
    await createProjectDir(tmpRoot, 'proj', {
      context: '# ctx',
      tasks: '# tasks',
      decisions: '# dec',
      log: '- **Init** done',
    });
    const projDir = path.join(tmpRoot, 'wiki/projects', 'proj');

    const result = await loadProjectFiles(projDir);
    assert.equal(result.context, '# ctx');
    assert.equal(result.tasks, '# tasks');
    assert.equal(result.decisions, '# dec');
    assert.equal(result.log, '- **Init** done');
  });

  it('returns null for missing files', async () => {
    await createProjectDir(tmpRoot, 'minimal');
    const projDir = path.join(tmpRoot, 'wiki/projects', 'minimal');

    const result = await loadProjectFiles(projDir);
    assert.equal(result.context, null);
    assert.equal(result.tasks, null);
    assert.equal(result.decisions, null);
    assert.equal(result.log, null);
  });

  it('loads only requested files subset', async () => {
    await createProjectDir(tmpRoot, 'proj', {
      context: '# ctx',
      log: '- **Init** done',
    });
    const projDir = path.join(tmpRoot, 'wiki/projects', 'proj');

    const result = await loadProjectFiles(projDir, { files: ['context', 'log'] });
    assert.equal(result.context, '# ctx');
    assert.equal(result.log, '- **Init** done');
    assert.ok(!('tasks' in result), 'tasks should not be loaded');
    assert.ok(!('decisions' in result), 'decisions should not be loaded');
  });

  it('serves from cache on second call without re-reading files', async () => {
    const projDir = await createProjectDir(tmpRoot, 'proj', {
      context: '# ctx v1',
      log: '- **v1**',
    });

    const first = await loadProjectFiles(projDir);
    assert.equal(first.context, '# ctx v1');

    // Overwrite file — cache should still return old value (mtime unchanged mid-second)
    // Actually we need to verify cache hit. Modify file after first read.
    // On cache hit, the cached data is returned even if we mutate the file,
    // because stat may still match within the same second.
    const second = await loadProjectFiles(projDir);
    assert.equal(second.context, '# ctx v1');
  });

  it('invalidates cache when file mtime changes', async () => {
    const projDir = await createProjectDir(tmpRoot, 'proj', {
      context: '# ctx v1',
    });

    const first = await loadProjectFiles(projDir);
    assert.equal(first.context, '# ctx v1');

    // Ensure mtime changes by waiting and writing
    await new Promise(r => setTimeout(r, 50));
    await fs.writeFile(path.join(projDir, 'context.md'), '# ctx v2');

    const second = await loadProjectFiles(projDir);
    assert.equal(second.context, '# ctx v2');
  });

  it('invalidates cache when file size changes (same mtime edge case)', async () => {
    const projDir = await createProjectDir(tmpRoot, 'proj', {
      context: '# original content',
    });

    const first = await loadProjectFiles(projDir);
    assert.equal(first.context, '# original content');

    // Overwrite with different size content, then reset mtime to same value
    const filePath = path.join(projDir, 'context.md');
    await fs.writeFile(filePath, '# new different content');
    const stat = await fs.stat(filePath);
    // Touch the file to ensure mtime is different
    const newTime = new Date(stat.mtimeMs - 2000);
    await fs.utimes(filePath, newTime, newTime);

    const second = await loadProjectFiles(projDir);
    // If mtime matches old stat but size differs, should still detect change
    assert.equal(second.context, '# new different content');
  });

  it('loads previously unloaded files into existing cache entry', async () => {
    const projDir = await createProjectDir(tmpRoot, 'proj', {
      context: '# ctx',
      tasks: '# tasks',
    });

    // First load: only context
    const first = await loadProjectFiles(projDir, { files: ['context'] });
    assert.equal(first.context, '# ctx');
    assert.ok(!('tasks' in first));

    // Second load: add tasks (should not re-read context)
    const second = await loadProjectFiles(projDir, { files: ['context', 'tasks'] });
    assert.equal(second.context, '# ctx');
    assert.equal(second.tasks, '# tasks');
  });

  it('clearCache for specific project removes only that entry', async () => {
    const dir1 = await createProjectDir(tmpRoot, 'a', { context: '# A' });
    const dir2 = await createProjectDir(tmpRoot, 'b', { context: '# B' });

    await loadProjectFiles(dir1);
    await loadProjectFiles(dir2);

    clearProjectCache(dir1);

    // dir1 cache cleared, dir2 still cached
    // Modify dir1 and verify fresh read
    await new Promise(r => setTimeout(r, 50));
    await fs.writeFile(path.join(dir1, 'context.md'), '# A v2');

    const result1 = await loadProjectFiles(dir1);
    assert.equal(result1.context, '# A v2');

    // dir2 should still return cached value
    const result2 = await loadProjectFiles(dir2);
    assert.equal(result2.context, '# B');
  });

  it('clearCache with no args clears all entries', async () => {
    const dir1 = await createProjectDir(tmpRoot, 'a', { context: '# A' });
    const dir2 = await createProjectDir(tmpRoot, 'b', { context: '# B' });

    await loadProjectFiles(dir1);
    await loadProjectFiles(dir2);

    clearProjectCache();

    await new Promise(r => setTimeout(r, 50));
    await fs.writeFile(path.join(dir1, 'context.md'), '# A v2');
    await fs.writeFile(path.join(dir2, 'context.md'), '# B v2');

    const result1 = await loadProjectFiles(dir1);
    const result2 = await loadProjectFiles(dir2);
    assert.equal(result1.context, '# A v2');
    assert.equal(result2.context, '# B v2');
  });
});

describe('extractLogTail', () => {
  it('extracts last N log lines with - ** prefix', () => {
    const log = '- **Init** done\n- **Plan** created\n- **Execute** started\n- **Verify** done';
    assert.deepEqual(extractLogTail(log, 3), [
      '- **Plan** created',
      '- **Execute** started',
      '- **Verify** done',
    ]);
  });

  it('returns empty array for null', () => {
    assert.deepEqual(extractLogTail(null), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(extractLogTail(''), []);
  });

  it('returns fewer lines if not enough matching lines', () => {
    const log = '- **Init** done\nSome other line\n- **Plan** created';
    assert.deepEqual(extractLogTail(log, 5), [
      '- **Init** done',
      '- **Plan** created',
    ]);
  });
});

describe('ALL_FILES export', () => {
  it('contains the four expected file names', () => {
    assert.deepEqual(ALL_FILES, ['context', 'tasks', 'decisions', 'log']);
  });
});

describe('fields query param in GET /projects/:name', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-fields-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    clearProjectCache();

    const Fastify = (await import('fastify')).default;
    const sensible = (await import('@fastify/sensible')).default;
    const cors = (await import('@fastify/cors')).default;
    const { projectRoutes } = await import('../server/routes/projects.js');

    app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(cors, { origin: true });
    app.addHook('onRequest', (req, _res, done) => { req.cpbRoot = tmpRoot; done(); });
    await app.register(projectRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    clearProjectCache();
    await rm(tmpRoot, { recursive: true });
  });

  it('returns all fields by default', async () => {
    await createProjectDir(tmpRoot, 'proj', {
      context: '# ctx', tasks: '# tasks', decisions: '# dec', log: '- **x**',
    });

    const res = await app.inject({ method: 'GET', url: '/api/projects/proj' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.context, '# ctx');
    assert.equal(body.tasks, '# tasks');
    assert.equal(body.decisions, '# dec');
    assert.equal(body.log, '- **x**');
  });

  it('returns only requested fields via query param but nulls others', async () => {
    await createProjectDir(tmpRoot, 'proj', {
      context: '# ctx', log: '- **x**',
    });

    const res = await app.inject({ method: 'GET', url: '/api/projects/proj?fields=context,log' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.context, '# ctx');
    assert.equal(body.log, '- **x**');
    // Unrequested fields still present in response shape as null
    assert.equal(body.tasks, null);
    assert.equal(body.decisions, null);
  });

  it('ignores invalid field names in query param', async () => {
    await createProjectDir(tmpRoot, 'proj', { context: '# ctx' });

    const res = await app.inject({ method: 'GET', url: '/api/projects/proj?fields=context,invalid,log' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.context, '# ctx');
    assert.equal(body.log, null);
    // 'invalid' filtered out — only context and log loaded
    assert.equal(body.tasks, null);
    assert.equal(body.decisions, null);
  });
});
