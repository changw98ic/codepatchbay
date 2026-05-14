#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadProfile, listProfiles } from '../server/services/profile-loader.js';
import { bridgeEnvFromProfile } from '../server/services/role-bridge.js';

describe('profile-loader', () => {
  it('loads codex profile with config.json', async () => {
    const cpbRoot = path.resolve('.');
    const profile = await loadProfile(cpbRoot, 'codex');
    assert.equal(profile.role, 'codex');
    assert.ok(profile.soulMd);
    assert.ok(profile.soulMd.includes('Codex'));
    assert.deepEqual(profile.permissions.deny_tools, ['terminal/create']);
    assert.equal(profile.agent.command, 'codex-acp');
  });

  it('loads claude profile with config.json', async () => {
    const cpbRoot = path.resolve('.');
    const profile = await loadProfile(cpbRoot, 'claude');
    assert.equal(profile.role, 'claude');
    assert.ok(profile.soulMd);
    assert.ok(profile.soulMd.includes('Claude'));
    assert.deepEqual(profile.permissions.deny_tools, []);
    assert.equal(profile.agent.command, 'claude-agent-acp');
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
    assert.ok(profiles.includes('codex'));
    assert.ok(profiles.includes('claude'));
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
  it('bridgeEnvFromProfile returns deny_tools env for codex', async () => {
    const cpbRoot = path.resolve('.');
    const env = await bridgeEnvFromProfile(cpbRoot, 'codex');
    assert.equal(env.CPB_ACP_DENY_TOOLS, 'terminal/create');
  });

  it('bridgeEnvFromProfile returns empty env for claude (no deny_tools)', async () => {
    const cpbRoot = path.resolve('.');
    const env = await bridgeEnvFromProfile(cpbRoot, 'claude');
    assert.equal(env.CPB_ACP_DENY_TOOLS, undefined);
  });

  it('bridgeEnvFromProfile returns defaults for unknown role', async () => {
    const cpbRoot = path.resolve('.');
    const env = await bridgeEnvFromProfile(cpbRoot, 'nonexistent');
    assert.equal(env.CPB_ACP_DENY_TOOLS, undefined);
    assert.equal(env.CPB_ACP_CLAUDE_COMMAND, undefined);
  });
});
