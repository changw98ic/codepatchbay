#!/usr/bin/env node
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { cpbHome, defaultProjectRuntimeRoot, projectRuntimeRoot, resolveDataRoot } from '../server/services/runtime.js';
import { registerProject, getProject, listProjects } from '../server/services/hub/hub-registry.js';
import { listRuntimeDataRoots, resolveProjectDataRoot } from '../server/services/runtime.js';
import { resolveWikiDir, resolveInboxDir, resolveArtifactPath } from '../server/services/artifact-locator.js';
import { resolveParentPlan, resolveParentPlanCache, writeParentPlanCache } from '../server/services/phase-runner.js';
import { parentPlanRecordPath, parentPlanStoreDir } from '../server/services/phase-runner.js';
// ── AC1: registerProject defaults projectRuntimeRoot ──
describe('AC1: registerProject defaults projectRuntimeRoot', () => {
    it('defaults to <hubRoot>/projects/<id> when no projectRuntimeRoot supplied', async () => {
        const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-'));
        const srcDir = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-src-'));
        try {
            await registerProject(hubRoot, { skipCodeGraphGate: true, name: 'my-proj', sourcePath: srcDir, id: 'my-proj' });
            const project = await getProject(hubRoot, 'my-proj');
            const expected = path.join(path.resolve(hubRoot), 'projects', 'my-proj');
            assert.equal(project.projectRuntimeRoot, expected);
        }
        finally {
            await rm(hubRoot, { recursive: true, force: true });
            await rm(srcDir, { recursive: true, force: true });
        }
    });
    it('rejects explicit projectRuntimeRoot outside the hub-managed project path', async () => {
        const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-'));
        const srcDir = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-src-'));
        const customRuntime = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-rt-'));
        try {
            await assert.rejects(registerProject(hubRoot, { skipCodeGraphGate: true, name: 'my-proj', sourcePath: srcDir, id: 'my-proj', projectRuntimeRoot: customRuntime }), /invalid projectRuntimeRoot/);
            assert.equal(await getProject(hubRoot, 'my-proj'), null);
        }
        finally {
            await rm(hubRoot, { recursive: true, force: true });
            await rm(srcDir, { recursive: true, force: true });
            await rm(customRuntime, { recursive: true, force: true });
        }
    });
    it('accepts explicit projectRuntimeRoot inside the hub-managed project path', async () => {
        const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-'));
        const srcDir = await mkdtemp(path.join(tmpdir(), 'cpb-ac1-src-'));
        try {
            const runtimeRoot = path.join(path.resolve(hubRoot), 'projects', 'my-proj');
            await registerProject(hubRoot, { skipCodeGraphGate: true, name: 'my-proj', sourcePath: srcDir, id: 'my-proj', projectRuntimeRoot: runtimeRoot });
            const project = await getProject(hubRoot, 'my-proj');
            assert.equal(project.projectRuntimeRoot, runtimeRoot);
        }
        finally {
            await rm(hubRoot, { recursive: true, force: true });
            await rm(srcDir, { recursive: true, force: true });
        }
    });
});
// ── AC3: distinct root concepts in code ──
describe('AC3: root-resolution primitives are distinct', () => {
    it('cpbHome returns ~/.cpb by default', () => {
        assert.equal(cpbHome(), path.join(os.homedir(), '.cpb'));
    });
    it('defaultProjectRuntimeRoot returns ~/.cpb/projects/<id>', () => {
        assert.equal(defaultProjectRuntimeRoot('test-proj'), path.join(os.homedir(), '.cpb', 'projects', 'test-proj'));
    });
    it('projectRuntimeRoot uses explicit hubRoot, not home dir', () => {
        const hub = '/custom/hub';
        assert.equal(projectRuntimeRoot(hub, 'test-proj'), path.resolve(path.join(hub, 'projects', 'test-proj')));
    });
    it('resolveDataRoot prefers hub+project over legacy cpbRoot', () => {
        const legacy = resolveDataRoot('/legacy/root');
        const modern = resolveDataRoot('/legacy/root', { hubRoot: '/hub', projectId: 'p' });
        assert.equal(legacy, path.resolve('/legacy/root/cpb-task'));
        assert.equal(modern, path.resolve('/hub/projects/p'));
        assert.notEqual(legacy, modern);
    });
    it('resolveProjectDataRoot rejects env roots that do not match the Hub registry', async () => {
        const cpbRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac3-cpb-'));
        const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac3-hub-'));
        const srcDir = await mkdtemp(path.join(tmpdir(), 'cpb-ac3-src-'));
        const poisonedRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac3-poisoned-'));
        try {
            const project = await registerProject(hubRoot, { skipCodeGraphGate: true, name: 'my-proj', sourcePath: srcDir, id: 'my-proj' });
            assert.equal(await resolveProjectDataRoot(cpbRoot, 'my-proj', { hubRoot, dataRoot: project.projectRuntimeRoot }), project.projectRuntimeRoot);
            await assert.rejects(resolveProjectDataRoot(cpbRoot, 'my-proj', { hubRoot, dataRoot: poisonedRoot }), /CPB_PROJECT_RUNTIME_ROOT does not match Hub registry/);
        }
        finally {
            await rm(cpbRoot, { recursive: true, force: true });
            await rm(hubRoot, { recursive: true, force: true });
            await rm(srcDir, { recursive: true, force: true });
            await rm(poisonedRoot, { recursive: true, force: true });
        }
    });
    it('listRuntimeDataRoots fails closed on malformed Hub registry data', async () => {
        const cpbRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac3-bad-cpb-'));
        const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac3-bad-hub-'));
        try {
            await fs.writeFile(path.join(hubRoot, 'projects.json'), '{broken json', 'utf8');
            await assert.rejects(listRuntimeDataRoots(cpbRoot, { hubRoot, includeLegacy: false }), /Unexpected token|JSON/);
            assert.deepEqual(await listRuntimeDataRoots(cpbRoot, { hubRoot, includeHubProjects: false, includeLegacy: false }), []);
        }
        finally {
            await rm(cpbRoot, { recursive: true, force: true });
            await rm(hubRoot, { recursive: true, force: true });
        }
    });
});
// ── AC4: listProjects uses Hub registry, not wiki scan ──
describe('AC4: listProjects reads from Hub registry', () => {
    it('returns projects registered in Hub registry', async () => {
        const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac4-'));
        const srcA = await mkdtemp(path.join(tmpdir(), 'cpb-ac4-a-'));
        const srcB = await mkdtemp(path.join(tmpdir(), 'cpb-ac4-b-'));
        try {
            await registerProject(hubRoot, { skipCodeGraphGate: true, name: 'alpha', sourcePath: srcA, id: 'alpha' });
            await registerProject(hubRoot, { skipCodeGraphGate: true, name: 'beta', sourcePath: srcB, id: 'beta' });
            const projects = await listProjects(hubRoot);
            assert.equal(projects.length, 2);
            const names = projects.map(p => p.name).sort();
            assert.deepEqual(names, ['alpha', 'beta']);
        }
        finally {
            await rm(hubRoot, { recursive: true, force: true });
            await rm(srcA, { recursive: true, force: true });
            await rm(srcB, { recursive: true, force: true });
        }
    });
});
// ── AC5: artifact-locator hard-cuts hub runtime roots ──
describe('AC5: artifact-locator hub runtime root hard cut', () => {
    it('uses runtime wiki paths when hubRoot is present and only uses legacy without hubRoot', async () => {
        const cpbRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac5-'));
        const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac5-hub-'));
        try {
            await registerProject(hubRoot, { skipCodeGraphGate: true, name: 'legacy-proj', sourcePath: cpbRoot, id: 'legacy-proj' });
            const legacyWiki = path.join(cpbRoot, 'wiki/projects/legacy-proj');
            await fs.mkdir(path.join(legacyWiki, 'inbox'), { recursive: true });
            await fs.writeFile(path.join(legacyWiki, 'context.md'), '# legacy');
            const wikiDir = await resolveWikiDir(hubRoot, cpbRoot, 'legacy-proj');
            assert.equal(wikiDir, path.join(hubRoot, 'projects', 'legacy-proj', 'wiki'));
            const inboxDir = await resolveInboxDir(hubRoot, cpbRoot, 'legacy-proj');
            assert.equal(inboxDir, path.join(hubRoot, 'projects', 'legacy-proj', 'wiki', 'inbox'));
            const artifact = await resolveArtifactPath(hubRoot, cpbRoot, 'legacy-proj', 'context.md');
            assert.equal(artifact, path.join(hubRoot, 'projects', 'legacy-proj', 'wiki', 'context.md'));
            const legacyArtifact = await resolveArtifactPath('', cpbRoot, 'legacy-proj', 'context.md');
            const content = await fs.readFile(legacyArtifact, 'utf8');
            assert.equal(content, '# legacy');
        }
        finally {
            await rm(cpbRoot, { recursive: true, force: true });
            await rm(hubRoot, { recursive: true, force: true });
        }
    });
});
// ── AC6: parent plan cache uses project runtime root ──
describe('AC6: parent plan cache runtime root', () => {
    it('stores parent plan cache records under the registered project runtime root', async () => {
        const cpbRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac6-cpb-'));
        const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac6-hub-'));
        try {
            const project = await registerProject(hubRoot, {
                skipCodeGraphGate: true,
                name: 'flow',
                sourcePath: cpbRoot,
                id: 'flow',
            });
            const dataRoot = project.projectRuntimeRoot;
            await fs.mkdir(path.join(dataRoot, 'wiki', 'inbox'), { recursive: true });
            await fs.writeFile(path.join(dataRoot, 'wiki', 'inbox', 'plan-parent-1.md'), '# parent plan\n', 'utf8');
            const stored = await writeParentPlanCache(cpbRoot, {
                hubRoot,
                project: 'flow',
                task: 'Ship reliable onboarding',
                planId: 'parent-1',
            });
            assert.equal(stored.cachePath.startsWith(path.join(dataRoot, 'plan-cache', 'flow')), true);
            assert.equal(parentPlanStoreDir(cpbRoot, 'flow', { dataRoot }), path.join(dataRoot, 'plan-cache', 'flow'));
            assert.equal(parentPlanRecordPath(cpbRoot, 'flow', stored.planCacheKey, { dataRoot }), stored.cachePath);
            assert.equal(await fs.readFile(stored.cachePath, 'utf8').then((raw) => JSON.parse(raw).parentPlanId), 'parent-1');
            await assert.rejects(fs.stat(path.join(cpbRoot, 'cpb-task', 'plan-cache', 'flow', `${stored.planCacheKey}.json`)), /ENOENT/);
            const cache = await resolveParentPlanCache(cpbRoot, {
                hubRoot,
                project: 'flow',
                task: 'Ship reliable onboarding',
            });
            assert.equal(cache.cacheHit, true);
            assert.equal(cache.cachePath, stored.cachePath);
            assert.equal(cache.reusedPlanArtifact, 'plan-parent-1');
            const resolved = await resolveParentPlan(cpbRoot, {
                hubRoot,
                project: 'flow',
                task: 'Ship reliable onboarding',
            });
            assert.equal(resolved.cacheHit, true);
            assert.equal(resolved.source, 'cache');
            assert.equal(resolved.reusedPlanId, 'parent-1');
        }
        finally {
            await rm(cpbRoot, { recursive: true, force: true });
            await rm(hubRoot, { recursive: true, force: true });
        }
    });
    it('fails closed instead of writing plan cache records to legacy cpb-task when no project runtime root is registered', async () => {
        const cpbRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac6-cpb-'));
        const hubRoot = await mkdtemp(path.join(tmpdir(), 'cpb-ac6-hub-'));
        try {
            await assert.rejects(writeParentPlanCache(cpbRoot, {
                hubRoot,
                project: 'flow',
                task: 'Ship reliable onboarding',
                planId: 'parent-1',
            }), /project runtime root required/);
            await assert.rejects(resolveParentPlanCache(cpbRoot, {
                hubRoot,
                project: 'flow',
                task: 'Ship reliable onboarding',
            }), /project runtime root required/);
            assert.throws(() => parentPlanRecordPath(cpbRoot, 'flow', 'cache-key'), /project runtime root required/);
            await assert.rejects(fs.stat(path.join(cpbRoot, 'cpb-task', 'plan-cache')), /ENOENT/);
        }
        finally {
            await rm(cpbRoot, { recursive: true, force: true });
            await rm(hubRoot, { recursive: true, force: true });
        }
    });
});
