#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadProfile, listProfiles, loadProfileSkills, selectProfileSkills } from '../server/services/profile-loader.js';
import { bridgeEnvFromProfile } from '../server/services/role-bridge.js';

describe('profile-loader', () => {
  it('loads planner profile with config.json', async () => {
    const cpbRoot = path.resolve('.');
    const profile = await loadProfile(cpbRoot, 'planner');
    assert.equal(profile.role, 'planner');
    assert.ok(profile.soulMd);
    assert.ok(profile.soulMd.includes('Planner'));
    assert.deepEqual(profile.permissions.deny_tools, []);
    assert.equal(profile.agent.command, 'codex-acp');
  });

  it('loads executor profile with config.json', async () => {
    const cpbRoot = path.resolve('.');
    const profile = await loadProfile(cpbRoot, 'executor');
    assert.equal(profile.role, 'executor');
    assert.ok(profile.soulMd);
    assert.ok(profile.soulMd.includes('Executor'));
    assert.deepEqual(profile.permissions.deny_tools, []);
    assert.equal(profile.agent.command, 'claude-agent-acp');
  });

  it('loads verifier profile with text_edit deny only', async () => {
    const cpbRoot = path.resolve('.');
    const profile = await loadProfile(cpbRoot, 'verifier');
    assert.equal(profile.role, 'verifier');
    assert.ok(profile.soulMd);
    assert.ok(profile.soulMd.includes('Verifier'));
    assert.deepEqual(profile.permissions.deny_tools, ["text_edit", "text-edit"]);
    assert.equal(profile.agent.command, 'codex-acp');
  });

  it('returns defaults for unknown role', async () => {
    const cpbRoot = path.resolve('.');
    const profile = await loadProfile(cpbRoot, 'nonexistent');
    assert.equal(profile.role, 'nonexistent');
    assert.equal(profile.soulMd, null);
    assert.deepEqual(profile.permissions.write_paths, []);
    assert.equal(profile.agent.command, null);
  });

  it('loads profile from custom dir with only soul.md', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-profile-'));
    try {
      await mkdir(path.join(tmpRoot, 'profiles', 'reviewer'), { recursive: true });
      await writeFile(
        path.join(tmpRoot, 'profiles', 'reviewer', 'soul.md'),
        '# Reviewer\nYou review things.'
      );
      const profile = await loadProfile(tmpRoot, 'reviewer');
      assert.equal(profile.role, 'reviewer');
      assert.ok(profile.soulMd.includes('Reviewer'));
      assert.deepEqual(profile.permissions.deny_tools, []);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('loads profile with only config.json', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-profile-cfg-'));
    try {
      await mkdir(path.join(tmpRoot, 'profiles', 'minimal'), { recursive: true });
      await writeFile(
        path.join(tmpRoot, 'profiles', 'minimal', 'config.json'),
        JSON.stringify({ permissions: { deny_tools: ['fs/delete'] }, agent: { command: 'test-acp' } })
      );
      const profile = await loadProfile(tmpRoot, 'minimal');
      assert.equal(profile.soulMd, null);
      assert.deepEqual(profile.permissions.deny_tools, ['fs/delete']);
      assert.equal(profile.agent.command, 'test-acp');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('handles invalid JSON gracefully', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-profile-bad-'));
    try {
      await mkdir(path.join(tmpRoot, 'profiles', 'badjson'), { recursive: true });
      await writeFile(
        path.join(tmpRoot, 'profiles', 'badjson', 'config.json'),
        'not valid json'
      );
      const profile = await loadProfile(tmpRoot, 'badjson');
      // Falls back to defaults
      assert.deepEqual(profile.permissions.deny_tools, []);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('listProfiles returns available profile directories', async () => {
    const cpbRoot = path.resolve('.');
    const profiles = await listProfiles(cpbRoot);
    assert.ok(profiles.includes('planner'));
    assert.ok(profiles.includes('executor'));
    assert.ok(profiles.includes('verifier'));
    assert.ok(!profiles.includes('codex'));
    assert.ok(!profiles.includes('claude'));
  });

  it('listProfiles skips dot-prefixed dirs', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-profile-list-'));
    try {
      await mkdir(path.join(tmpRoot, 'profiles', 'visible'), { recursive: true });
      await mkdir(path.join(tmpRoot, 'profiles', '.hidden'), { recursive: true });
      const profiles = await listProfiles(tmpRoot);
      assert.ok(profiles.includes('visible'));
      assert.ok(!profiles.includes('.hidden'));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });
});

describe('role-bridge with profile', () => {
  it('bridgeEnvFromProfile lets permission matrix control planner terminal access', async () => {
    const cpbRoot = path.resolve('.');
    const env = await bridgeEnvFromProfile(cpbRoot, 'planner');
    assert.equal(env.CPB_ACP_DENY_TOOLS, undefined);
  });

  it('bridgeEnvFromProfile returns empty env for executor (no deny_tools)', async () => {
    const cpbRoot = path.resolve('.');
    const env = await bridgeEnvFromProfile(cpbRoot, 'executor');
    assert.equal(env.CPB_ACP_DENY_TOOLS, undefined);
  });

  it('bridgeEnvFromProfile denies text_edit for verifier', async () => {
    const cpbRoot = path.resolve('.');
    const env = await bridgeEnvFromProfile(cpbRoot, 'verifier');
    assert.equal(env.CPB_ACP_DENY_TOOLS, "text_edit,text-edit");
  });

  it('bridgeEnvFromProfile does not accept provider profile aliases', async () => {
    const cpbRoot = path.resolve('.');
    const env = await bridgeEnvFromProfile(cpbRoot, 'codex');
    assert.equal(env.CPB_ACP_DENY_TOOLS, undefined);
    assert.equal(env.CPB_ACP_CLAUDE_COMMAND, undefined);
  });

  it('bridgeEnvFromProfile returns defaults for unknown role', async () => {
    const cpbRoot = path.resolve('.');
    const env = await bridgeEnvFromProfile(cpbRoot, 'nonexistent');
    assert.equal(env.CPB_ACP_DENY_TOOLS, undefined);
    assert.equal(env.CPB_ACP_CLAUDE_COMMAND, undefined);
  });
});

describe('loadProfileSkills', () => {
  it('returns empty skills and diagnostics for missing skills directory', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-skills-missing-'));
    try {
      const result = await loadProfileSkills(tmpRoot, 'missing');
      assert.deepEqual(result.skills, []);
      assert.deepEqual(result.diagnostics, []);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('returns empty skills for empty skills directory', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-skills-empty-'));
    try {
      await mkdir(path.join(tmpRoot, 'profiles', 'myrole', 'skills'), { recursive: true });
      const result = await loadProfileSkills(tmpRoot, 'myrole');
      assert.deepEqual(result.skills, []);
      assert.deepEqual(result.diagnostics, []);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('loads skills in deterministic filename order', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-skills-order-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'b.md'), '---\nname: beta\ndescription: B skill\n---\nBeta content');
      await writeFile(path.join(skillsDir, 'a.md'), '---\nname: alpha\ndescription: A skill\n---\nAlpha content');
      await writeFile(path.join(skillsDir, 'c.md'), '---\nname: charlie\ndescription: C skill\n---\nCharlie content');
      const result = await loadProfileSkills(tmpRoot, 'myrole');
      assert.equal(result.skills.length, 3);
      assert.equal(result.skills[0].name, 'alpha');
      assert.equal(result.skills[1].name, 'beta');
      assert.equal(result.skills[2].name, 'charlie');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('enforces maxSkills limit with diagnostic', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-skills-limit-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'a.md'), '---\nname: alpha\ndescription: A\n---\nA');
      await writeFile(path.join(skillsDir, 'b.md'), '---\nname: beta\ndescription: B\n---\nB');
      await writeFile(path.join(skillsDir, 'c.md'), '---\nname: charlie\ndescription: C\n---\nC');
      const result = await loadProfileSkills(tmpRoot, 'myrole', { maxSkills: 2 });
      assert.equal(result.skills.length, 2);
      assert.ok(result.diagnostics.some(d => d.code === 'skill_limit'));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('enforces maxBytes limit with diagnostic', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-skills-bytes-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      const bigContent = '---\nname: big\n---\n' + 'x'.repeat(200);
      await writeFile(path.join(skillsDir, 'big.md'), bigContent);
      const result = await loadProfileSkills(tmpRoot, 'myrole', { maxBytes: 32 });
      assert.equal(result.skills.length, 0);
      assert.ok(result.diagnostics.some(d => d.code === 'size_limit' && d.source.includes('big.md')));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('skips malformed skill files without name with diagnostic', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-skills-malformed-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'bad.md'), '---\ndescription: no name\n---\nNo name content');
      const result = await loadProfileSkills(tmpRoot, 'myrole');
      assert.equal(result.skills.length, 0);
      assert.ok(result.diagnostics.some(d => d.code === 'malformed_skill'));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('skips unreadable files with diagnostic', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-skills-unread-'));
    const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
    try {
      await mkdir(skillsDir, { recursive: true });
      const filePath = path.join(skillsDir, 'secret.md');
      await writeFile(filePath, '---\nname: secret\ndescription: S\n---\nSecret');
      await chmod(filePath, 0o000);
      const result = await loadProfileSkills(tmpRoot, 'myrole');
      assert.equal(result.skills.length, 0);
      assert.ok(result.diagnostics.some(d => d.code === 'unreadable_skill'));
    } finally {
      await chmod(path.join(skillsDir, 'secret.md'), 0o600).catch(() => {});
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('skips dot and underscore prefixed files', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-skills-dot-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, '.hidden.md'), '---\nname: hidden\n---\nH');
      await writeFile(path.join(skillsDir, '_private.md'), '---\nname: private\n---\nP');
      await writeFile(path.join(skillsDir, 'visible.md'), '---\nname: visible\ndescription: V\n---\nV');
      const result = await loadProfileSkills(tmpRoot, 'myrole');
      assert.equal(result.skills.length, 1);
      assert.equal(result.skills[0].name, 'visible');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('returns source and content in skill objects', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-skills-obj-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'test.md'), '---\nname: test\ndescription: T\n---\nBody here');
      const result = await loadProfileSkills(tmpRoot, 'myrole');
      assert.equal(result.skills.length, 1);
      assert.ok(result.skills[0].source);
      assert.ok(result.skills[0].content.includes('Body here'));
      assert.ok(result.skills[0].description === 'T');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });
});

describe('selectProfileSkills', () => {
  it('selects skill matching phase name', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-sel-phase-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'plan.md'), '---\nname: plan\ndescription: Plan skill\n---\nPlan body');
      await writeFile(path.join(skillsDir, 'debug.md'), '---\nname: debug\ndescription: Debug skill\n---\nDebug body');
      const result = await selectProfileSkills(tmpRoot, 'myrole', { phase: 'plan' });
      assert.equal(result.length, 1);
      assert.equal(result[0].name, 'plan');
      assert.ok(result[0].reason.includes('phase:plan'));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('selects skill by explicit /name in task text', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-sel-task-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'tdd.md'), '---\nname: tdd\ndescription: TDD skill\n---\nTDD body');
      await writeFile(path.join(skillsDir, 'debug.md'), '---\nname: debug\ndescription: Debug skill\n---\nDebug body');
      const result = await selectProfileSkills(tmpRoot, 'myrole', { phase: 'execute', task: 'Use /tdd for this fix.' });
      assert.equal(result.length, 1);
      assert.equal(result[0].name, 'tdd');
      assert.ok(result[0].reason.includes('task:/tdd'));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('selects skill by $name in artifact text', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-sel-artifact-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'tdd.md'), '---\nname: tdd\ndescription: TDD skill\n---\nTDD body');
      const result = await selectProfileSkills(tmpRoot, 'myrole', { phase: 'execute', artifactText: 'Use $tdd for this.' });
      assert.equal(result.length, 1);
      assert.equal(result[0].name, 'tdd');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('selects skill by trigger matching context', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-sel-trigger-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'test.md'), '---\nname: test\ndescription: Test\ntriggers: run tests, coverage\n---\nTest body');
      const result = await selectProfileSkills(tmpRoot, 'myrole', { phase: 'execute', artifactText: 'We need run tests here.' });
      assert.equal(result.length, 1);
      assert.equal(result[0].name, 'test');
      assert.ok(result[0].reason.includes('trigger'));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('returns empty when nothing matches', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-sel-nomatch-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'debug.md'), '---\nname: debug\ndescription: Debug\n---\nDebug body');
      const result = await selectProfileSkills(tmpRoot, 'myrole', { phase: 'execute', task: 'Implement feature X' });
      assert.equal(result.length, 0);
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('rejects prefix false positive /test inside /testcase', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-sel-prefix-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'test.md'), '---\nname: test\ndescription: Test\n---\nTest body');
      const result = await selectProfileSkills(tmpRoot, 'myrole', { phase: 'execute', task: 'Run /testcase for coverage.' });
      assert.equal(result.length, 0, '/test must NOT match /testcase');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('rejects $test inside $testcase', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-sel-dollar-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'test.md'), '---\nname: test\ndescription: Test\n---\nTest body');
      const result = await selectProfileSkills(tmpRoot, 'myrole', { phase: 'execute', artifactText: 'Use $testcase var.' });
      assert.equal(result.length, 0, '$test must NOT match $testcase');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('rejects trigger substring match inside unrelated word', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-sel-trigger-word-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'test.md'), '---\nname: test\ndescription: Test\ntriggers: test\n---\nTest body');
      const result = await selectProfileSkills(tmpRoot, 'myrole', { phase: 'execute', artifactText: 'We ran a contest today.' });
      assert.equal(result.length, 0, 'trigger "test" must NOT match "contest"');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('accepts exact /name match followed by non-word char', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-sel-exact-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'test.md'), '---\nname: test\ndescription: Test\n---\nTest body');
      const result = await selectProfileSkills(tmpRoot, 'myrole', { phase: 'execute', task: 'Run /test now.' });
      assert.equal(result.length, 1);
      assert.equal(result[0].name, 'test');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('accepts trigger as whole phrase', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-sel-trigger-phrase-'));
    try {
      const skillsDir = path.join(tmpRoot, 'profiles', 'myrole', 'skills');
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, 'test.md'), '---\nname: test\ndescription: Test\ntriggers: run tests\n---\nTest body');
      const result = await selectProfileSkills(tmpRoot, 'myrole', { phase: 'execute', artifactText: 'We need to run tests today.' });
      assert.equal(result.length, 1);
      assert.equal(result[0].name, 'test');
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });
});
