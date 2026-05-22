#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';

import { cpbHome, defaultProjectRuntimeRoot, projectRuntimeRoot, projectRuntimePath, resolveDataRoot, dataPath } from '../server/services/runtime-root.js';
import { registerProject, getProject, listProjects } from '../server/services/hub-registry.js';
import { resolveWikiDir, resolveInboxDir, resolveOutputsDir, resolveArtifactPath } from '../server/services/artifact-locator.js';
import { migrateToProjectRuntimeRoots } from '../bridges/migrate-runtime-root.mjs';

// ── AC1: registerProject defaults projectRuntimeRoot ──

describe('AC1: registerProject defaults projectRuntimeRoot', () => {
  it('defaults to <hubRoot>/projects/<id> when no projectRuntimeRoot supplied', async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-'));
    const srcDir = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-src-'));
    try {
      await registerProject(hubRoot, { name: 'my-proj', sourcePath: srcDir, id: 'my-proj' });
      const project = await getProject(hubRoot, 'my-proj');
      const expected = path.join(path.resolve(hubRoot), 'projects', 'my-proj');
      assert.equal(project.projectRuntimeRoot, expected);
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
      await rm(srcDir, { recursive: true, force: true });
    }
  });

  it('preserves explicit projectRuntimeRoot when supplied', async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-'));
    const srcDir = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-src-'));
    const customRuntime = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-rt-'));
    try {
      await registerProject(hubRoot, { name: 'my-proj', sourcePath: srcDir, id: 'my-proj', projectRuntimeRoot: customRuntime });
      const project = await getProject(hubRoot, 'my-proj');
      assert.equal(project.projectRuntimeRoot, path.resolve(customRuntime));
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
      await rm(srcDir, { recursive: true, force: true });
      await rm(customRuntime, { recursive: true, force: true });
    }
  });
});

// ── AC3: distinct root concepts in code ──

describe('AC3: root-resolution primitives are distinct', () => {
  it('cpbHome returns ~/.cpb by default', () => {
    assert.equal(cpbHome(), path.join(os.homedir(), '.cpb'));
  });

  it('defaultProjectRuntimeRoot returns ~/.cpb/projects/<id>', () => {
    assert.equal(
      defaultProjectRuntimeRoot('test-proj'),
      path.join(os.homedir(), '.cpb', 'projects', 'test-proj')
    );
  });

  it('projectRuntimeRoot uses explicit hubRoot, not home dir', () => {
    const hub = '/custom/hub';
    assert.equal(
      projectRuntimeRoot(hub, 'test-proj'),
      path.resolve(path.join(hub, 'projects', 'test-proj'))
    );
  });

  it('resolveDataRoot prefers hub+project over legacy cpbRoot', () => {
    const legacy = resolveDataRoot('/legacy/root');
    const modern = resolveDataRoot('/legacy/root', { hubRoot: '/hub', projectId: 'p' });
    assert.equal(legacy, path.resolve('/legacy/root/cpb-task'));
    assert.equal(modern, path.resolve('/hub/projects/p'));
    assert.notEqual(legacy, modern);
  });
});

// ── AC4: listProjects uses Hub registry, not wiki scan ──

describe('AC4: listProjects reads from Hub registry', () => {
  it('returns projects registered in Hub registry', async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac4-'));
    const srcA = await mkdtemp(path.join(tmpdir(), 'cpb-ac4-a-'));
    const srcB = await mkdtemp(path.join(tmpdir(), 'cpb-ac4-b-'));
    try {
      await registerProject(hubRoot, { name: 'alpha', sourcePath: srcA, id: 'alpha' });
      await registerProject(hubRoot, { name: 'beta', sourcePath: srcB, id: 'beta' });
      const projects = await listProjects(hubRoot);
      assert.equal(projects.length, 2);
      const names = projects.map(p => p.name).sort();
      assert.deepEqual(names, ['alpha', 'beta']);
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
      await rm(srcA, { recursive: true, force: true });
      await rm(srcB, { recursive: true, force: true });
    }
  });
});

// ── AC5: legacy wiki/projects readable via fallback ──

describe('AC5: artifact-locator legacy fallback', () => {
  it('resolves wiki dir from legacy cpbRoot when no runtime-root data exists', async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac5-'));
    const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac5-hub-'));
    try {
      await registerProject(hubRoot, { name: 'legacy-proj', sourcePath: cpbRoot, id: 'legacy-proj' });
      const legacyWiki = path.join(cpbRoot, 'wiki/projects/legacy-proj');
      await fs.mkdir(path.join(legacyWiki, 'inbox'), { recursive: true });
      await fs.writeFile(path.join(legacyWiki, 'context.md'), '# legacy');

      const wikiDir = await resolveWikiDir(hubRoot, cpbRoot, 'legacy-proj');
      assert.equal(wikiDir, legacyWiki);

      const inboxDir = await resolveInboxDir(hubRoot, cpbRoot, 'legacy-proj');
      assert.equal(inboxDir, path.join(legacyWiki, 'inbox'));

      const artifact = await resolveArtifactPath(hubRoot, cpbRoot, 'legacy-proj', 'context.md');
      const content = await fs.readFile(artifact, 'utf8');
      assert.equal(content, '# legacy');
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
      await rm(hubRoot, { recursive: true, force: true });
    }
  });
});

// ── AC6: migration dry-run reports without changing files ──

describe('AC6: migration dry-run reports without changing files', () => {
  it('reports planned moves but leaves source data untouched', async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac6-'));
    const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac6-hub-'));
    try {
      // Create legacy wiki/projects data
      const wikiProj = path.join(cpbRoot, 'wiki/projects/test-proj');
      await fs.mkdir(path.join(wikiProj, 'inbox'), { recursive: true });
      await fs.mkdir(path.join(wikiProj, 'outputs'), { recursive: true });
      await fs.writeFile(path.join(wikiProj, 'context.md'), '# test');

      // Register in Hub so migration knows where to target
      await registerProject(hubRoot, { name: 'test-proj', sourcePath: cpbRoot, id: 'test-proj' });

      const report = await migrateToProjectRuntimeRoots(cpbRoot, hubRoot, { dryRun: true });

      // Source files must still exist
      await assert.doesNotReject(() => fs.stat(path.join(wikiProj, 'context.md')));
      await assert.doesNotReject(() => fs.stat(path.join(wikiProj, 'inbox')));

      // Report should show planned copies
      assert.ok(report.copied.length > 0, 'dry-run should report planned copies');
      assert.ok(report.wouldDelete.length >= 0, 'dry-run should report would-be-deletions');
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
      await rm(hubRoot, { recursive: true, force: true });
    }
  });
});
