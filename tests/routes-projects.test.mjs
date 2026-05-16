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
import { fileURLToPath } from 'url';

import { projectRoutes } from '../server/routes/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build a test Fastify app with project routes registered.
 * Reproduces the same registration pattern as server/index.js:
 *   app.register(projectRoutes, { prefix: '/api' })
 * which yields URL paths like /api/projects.
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

/**
 * Create a minimal project directory structure under a temp root.
 */
async function createProjectDir(root, name, opts = {}) {
  const projDir = path.join(root, 'wiki/projects', name);
  await fs.mkdir(path.join(projDir, 'inbox'), { recursive: true });
  await fs.mkdir(path.join(projDir, 'outputs'), { recursive: true });

  if (opts.context) {
    await fs.writeFile(path.join(projDir, 'context.md'), opts.context);
  }
  if (opts.tasks) {
    await fs.writeFile(path.join(projDir, 'tasks.md'), opts.tasks);
  }
  if (opts.decisions) {
    await fs.writeFile(path.join(projDir, 'decisions.md'), opts.decisions);
  }
  if (opts.log) {
    await fs.writeFile(path.join(projDir, 'log.md'), opts.log);
  }
  if (opts.inboxFiles) {
    for (const f of opts.inboxFiles) {
      await fs.writeFile(path.join(projDir, 'inbox', f), `# ${f}`);
    }
  }
  if (opts.outputFiles) {
    for (const f of opts.outputFiles) {
      await fs.writeFile(path.join(projDir, 'outputs', f), `# ${f}`);
    }
  }

  return projDir;
}

describe('GET /api/projects', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-projects-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('returns empty list when no projects exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });

  it('returns projects with correct structure', async () => {
    await createProjectDir(tmpRoot, 'my-app', {
      inboxFiles: ['plan-001.md'],
      outputFiles: ['deliverable-001.md', 'verdict-001.md'],
      log: '- **Plan** created\n- **Execute** started\n- **Verify** done',
    });

    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.length, 1);

    const project = body[0];
    assert.equal(project.name, 'my-app');
    assert.equal(project.inbox, 1);
    assert.equal(project.outputs, 2);
    assert.ok(Array.isArray(project.recentLog));
    assert.equal(project.pipelineState, null);
  });

  it('skips _template and dot-prefixed directories', async () => {
    await createProjectDir(tmpRoot, 'real-project');
    await createProjectDir(tmpRoot, '_template');
    await createProjectDir(tmpRoot, '.hidden');

    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(res.statusCode, 200);

    const names = res.json().map(p => p.name);
    assert.ok(names.includes('real-project'));
    assert.ok(!names.includes('_template'));
    assert.ok(!names.includes('.hidden'));
  });
});

describe('GET /api/projects/:name', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-detail-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('returns project detail with context, tasks, decisions', async () => {
    await createProjectDir(tmpRoot, 'demo', {
      context: '# Demo context\nSome details here',
      tasks: '# Tasks\n- Task A',
      decisions: '# Decisions\n- Use X',
      log: '- **Init** done',
    });

    const res = await app.inject({ method: 'GET', url: '/api/projects/demo' });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.name, 'demo');
    assert.equal(body.context, '# Demo context\nSome details here');
    assert.equal(body.tasks, '# Tasks\n- Task A');
    assert.equal(body.decisions, '# Decisions\n- Use X');
    assert.equal(body.log, '- **Init** done');
    assert.equal(body.pipelineState, null);
  });

  it('returns 404 for non-existent project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/nonexist' });
    assert.equal(res.statusCode, 404);
    assert.ok(res.json().message.includes("not found"));
  });

  it('returns null for missing context/tasks/decisions files', async () => {
    await createProjectDir(tmpRoot, 'minimal');

    const res = await app.inject({ method: 'GET', url: '/api/projects/minimal' });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.context, null);
    assert.equal(body.tasks, null);
    assert.equal(body.decisions, null);
    assert.equal(body.log, null);
  });

  it('includes pipelineState from job projection when events exist', async () => {
    await createProjectDir(tmpRoot, 'with-state');
    const { appendEvent } = await import('../server/services/event-store.js');
    await appendEvent(tmpRoot, 'with-state', 'job-20260514-test', {
      type: 'job_created',
      jobId: 'job-20260514-test',
      project: 'with-state',
      task: 'test task',
      ts: '2026-05-14T12:00:00.000Z',
    });
    await appendEvent(tmpRoot, 'with-state', 'job-20260514-test', {
      type: 'phase_started',
      jobId: 'job-20260514-test',
      project: 'with-state',
      phase: 'plan',
      attempt: 1,
      ts: '2026-05-14T12:00:01.000Z',
    });

    const res = await app.inject({ method: 'GET', url: '/api/projects/with-state' });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.pipelineState.project, 'with-state');
    assert.equal(body.pipelineState.phase, 'plan');
    assert.equal(body.pipelineState.status, 'EXECUTING');
  });
});

describe('GET /api/projects/:name/inbox', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-inbox-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('lists inbox markdown files', async () => {
    await createProjectDir(tmpRoot, 'proj', {
      inboxFiles: ['plan-001.md', 'plan-002.md'],
    });

    const res = await app.inject({ method: 'GET', url: '/api/projects/proj/inbox' });
    assert.equal(res.statusCode, 200);

    const files = res.json();
    assert.equal(files.length, 2);
    assert.ok(files.includes('plan-001.md'));
    assert.ok(files.includes('plan-002.md'));
  });

  it('returns empty array when no inbox files', async () => {
    await createProjectDir(tmpRoot, 'empty');

    const res = await app.inject({ method: 'GET', url: '/api/projects/empty/inbox' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });

  it('filters out non-markdown files', async () => {
    const projDir = await createProjectDir(tmpRoot, 'mixed');
    // Write a non-md file into inbox
    await fs.writeFile(path.join(projDir, 'inbox', 'data.json'), '{}');

    const res = await app.inject({ method: 'GET', url: '/api/projects/mixed/inbox' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });
});

describe('GET /api/projects/:name/outputs', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-outputs-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('lists output markdown files', async () => {
    await createProjectDir(tmpRoot, 'proj', {
      outputFiles: ['deliverable-001.md', 'verdict-001.md'],
    });

    const res = await app.inject({ method: 'GET', url: '/api/projects/proj/outputs' });
    assert.equal(res.statusCode, 200);

    const files = res.json();
    assert.equal(files.length, 2);
    assert.ok(files.includes('deliverable-001.md'));
    assert.ok(files.includes('verdict-001.md'));
  });

  it('returns empty array when no output files', async () => {
    await createProjectDir(tmpRoot, 'empty');

    const res = await app.inject({ method: 'GET', url: '/api/projects/empty/outputs' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });
});

describe('GET /api/projects/:name/files/*', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-files-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('returns file content for a valid file', async () => {
    await createProjectDir(tmpRoot, 'proj', {
      context: '# Project Context\nDetails here',
    });

    const res = await app.inject({ method: 'GET', url: '/api/projects/proj/files/context.md' });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.path, 'context.md');
    assert.equal(body.content, '# Project Context\nDetails here');
  });

  it('returns file content from subdirectory', async () => {
    const projDir = await createProjectDir(tmpRoot, 'proj');
    await fs.mkdir(path.join(projDir, 'inbox'), { recursive: true });
    await fs.writeFile(path.join(projDir, 'inbox/plan-001.md'), '# Plan 1');

    const res = await app.inject({ method: 'GET', url: '/api/projects/proj/files/inbox/plan-001.md' });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.path, 'inbox/plan-001.md');
    assert.equal(body.content, '# Plan 1');
  });

  it('returns 404 for non-existent file', async () => {
    await createProjectDir(tmpRoot, 'proj');

    const res = await app.inject({ method: 'GET', url: '/api/projects/proj/files/nope.md' });
    assert.equal(res.statusCode, 404);
    assert.ok(res.json().message.includes('not found'));
  });

  it('rejects path traversal with .. segments', async () => {
    await createProjectDir(tmpRoot, 'proj');

    // Fastify normalizes /../ in URLs before routing, so ../.. gets resolved
    // and the route never matches with a wildcard pattern that escapes.
    // This means the Fastify router itself prevents the traversal at the URL level.
    // The route handler's additional check (resolved.startsWith(projDir)) provides
    // defense in depth if a crafted request somehow reaches it.
    //
    // Test that the URL /api/projects/etc/passwd does not exist as a route:
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj/files/../../etc/passwd',
    });
    // Fastify resolves the path to /api/projects/etc/passwd -> 404 route not found
    assert.equal(res.statusCode, 404);
  });
});

describe('Path traversal protection on project name param', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-traversal-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    await createProjectDir(tmpRoot, 'real-proj', { context: '# real' });
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  const badNames = [
    '..',           // directory traversal
    '../etc',       // traversal with target
    'a..b',         // dots in middle (rejected by SAFE_NAME)
    'a/b',          // path separator
    'a\\b',         // backslash separator
    '.hidden',      // dot prefix
    'proj name',    // space
    '',             // empty — won't match route but test anyway
  ];

  for (const badName of badNames) {
    if (!badName) continue; // empty name can't form a route

    it(`getProject rejects "${badName}"`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/projects/${encodeURIComponent(badName)}` });
      assert.ok(res.statusCode === 400 || res.statusCode === 404,
        `Expected 400/404 for "${badName}", got ${res.statusCode}`);
    });

    it(`getProjectInbox rejects "${badName}"`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/projects/${encodeURIComponent(badName)}/inbox` });
      assert.ok(res.statusCode === 400 || res.statusCode === 404,
        `Expected 400/404 for "${badName}", got ${res.statusCode}`);
    });

    it(`getProjectOutputs rejects "${badName}"`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/projects/${encodeURIComponent(badName)}/outputs` });
      assert.ok(res.statusCode === 400 || res.statusCode === 404,
        `Expected 400/404 for "${badName}", got ${res.statusCode}`);
    });

    it(`getProjectFiles rejects "${badName}"`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/projects/${encodeURIComponent(badName)}/files/context.md` });
      assert.ok(res.statusCode === 400 || res.statusCode === 404 || res.statusCode === 403,
        `Expected 400/403/404 for "${badName}", got ${res.statusCode}`);
    });
  }

  // Verify legitimate project names still work across all four handlers
  it('valid project name works in getProject', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/real-proj' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().name, 'real-proj');
  });

  it('valid project name works in getProjectInbox', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/real-proj/inbox' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('valid project name works in getProjectOutputs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/real-proj/outputs' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('valid project name works in getProjectFiles', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/real-proj/files/context.md' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().content, '# real');
  });

  // Wildcard path traversal in getProjectFiles
  it('getProjectFiles rejects wildcard path with ..', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/real-proj/files/../../etc/passwd' });
    assert.ok(res.statusCode === 400 || res.statusCode === 403 || res.statusCode === 404,
      `Expected 400/403/404, got ${res.statusCode}`);
  });
});

describe('Encoded path variant protection', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-encvar-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    await createProjectDir(tmpRoot, 'real-proj', { context: '# real' });
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  // After Fastify URL-decodes, SAFE_NAME regex rejects all of these
  // because the decoded value contains characters outside [a-zA-Z0-9-]
  const encodedNameVariants = [
    { label: '%2e%2e (URL-encoded ..)', raw: '%2e%2e' },
    { label: '..%2f (.. + URL-encoded /)', raw: '..%2f' },
    { label: '%2f (URL-encoded /)', raw: '%2f' },
    { label: '%5c (URL-encoded \\)', raw: '%5c' },
    { label: '%2e%2e%5c (URL-encoded ..\\)', raw: '%2e%2e%5c' },
    { label: '%2e%2e%2f (URL-encoded ../)', raw: '%2e%2e%2f' },
  ];

  for (const variant of encodedNameVariants) {
    it(`getProject rejects ${variant.label}`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/projects/${variant.raw}` });
      assert.ok(res.statusCode === 400 || res.statusCode === 404,
        `Expected 400/404 for ${variant.label}, got ${res.statusCode}`);
    });

    it(`getProjectInbox rejects ${variant.label}`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/projects/${variant.raw}/inbox` });
      assert.ok(res.statusCode === 400 || res.statusCode === 404,
        `Expected 400/404 for ${variant.label}, got ${res.statusCode}`);
    });

    it(`getProjectOutputs rejects ${variant.label}`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/projects/${variant.raw}/outputs` });
      assert.ok(res.statusCode === 400 || res.statusCode === 404,
        `Expected 400/404 for ${variant.label}, got ${res.statusCode}`);
    });

    it(`getProjectFiles rejects ${variant.label}`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/projects/${variant.raw}/files/context.md` });
      assert.ok(res.statusCode === 400 || res.statusCode === 404 || res.statusCode === 403,
        `Expected 400/403/404 for ${variant.label}, got ${res.statusCode}`);
    });
  }

  // Encoded path traversal in getProjectFiles wildcard file path
  const filePathVariants = [
    { label: '%2e%2e/etc/passwd', urlPath: '%2e%2e/etc/passwd' },
    { label: '%2e%2e%2f%2e%2e/etc/passwd', urlPath: '%2e%2e%2f%2e%2e/etc/passwd' },
    { label: '..%5c..%5c/etc/passwd', urlPath: '..%5c..%5c/etc/passwd' },
  ];

  for (const variant of filePathVariants) {
    it(`getProjectFiles rejects encoded file path: ${variant.label}`, async () => {
      const res = await app.inject({ method: 'GET', url: `/api/projects/real-proj/files/${variant.urlPath}` });
      assert.ok(res.statusCode === 400 || res.statusCode === 403 || res.statusCode === 404,
        `Expected 400/403/404 for ${variant.label}, got ${res.statusCode}`);
    });
  }

  // Verify legitimate project still works after encoded variant protection
  it('legitimate project name still resolves after encoded variant tests', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/real-proj' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().name, 'real-proj');
  });
});

describe('POST /api/projects/init', () => {
  let tmpRoot, app;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-test-init-'));
    await fs.mkdir(path.join(tmpRoot, 'wiki/projects'), { recursive: true });
    app = await buildApp(tmpRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpRoot, { recursive: true });
  });

  it('rejects invalid project name with special characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/some/path', name: 'bad project!' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('alphanumeric'));
  });

  it('rejects missing path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { name: 'my-proj' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('path'));
  });

  it('rejects missing name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/some/path' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('name'));
  });

  it('rejects name starting with hyphen', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/some/path', name: '-bad' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects name ending with hyphen', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/init',
      payload: { path: '/some/path', name: 'bad-' },
    });
    assert.equal(res.statusCode, 400);
  });
});
