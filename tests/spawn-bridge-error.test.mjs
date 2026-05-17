#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'path';
import { tmpdir } from 'node:os';

import { spawnBridge } from '../server/routes/tasks.js';

describe('spawnBridge error handling', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-spawn-test-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true });
  });

  it('returns accepted:false on async spawn error (non-existent cwd)', async () => {
    const ghostRoot = path.join(tmpRoot, 'no-such-dir');
    const result = await spawnBridge(
      ghostRoot, 'test-proj', 'codex-plan.sh',
      ['test-proj', 'task'], null,
    );
    assert.equal(result.accepted, false);
    assert.ok(result.error, 'should have error message');
    assert.ok(result.taskId, 'should still have taskId');
  });

  it('returns accepted:false on sync spawn error (null byte in path)', () => {
    // spawn() throws synchronously when args contain null bytes
    const result = spawnBridge(
      '/tmp\x00evil', 'test-proj', 'codex-plan.sh',
      ['test-proj', 'task'], null,
    );
    assert.equal(result.accepted, false);
    assert.ok(result.error, 'should have error message');
    assert.ok(result.taskId, 'should still have taskId');
  });

  it('returns accepted:true on successful spawn', async () => {
    await mkdir(path.join(tmpRoot, 'bridges'), { recursive: true });
    const scriptPath = path.join(tmpRoot, 'bridges', 'test-script.sh');
    await writeFile(scriptPath, '#!/bin/bash\nexit 0\n');
    await chmod(scriptPath, 0o755);

    const result = await spawnBridge(
      tmpRoot, 'test-proj', 'test-script.sh',
      ['test-proj', 'task'], null,
    );
    assert.equal(result.accepted, true);
    assert.ok(result.taskId);
    assert.equal(typeof result.pid, 'number');
  });

  it('does not register task on async spawn failure', async () => {
    const ghostRoot = path.join(tmpRoot, 'no-such-dir');
    const result = await spawnBridge(ghostRoot, 'no-reg-proj', 'codex-plan.sh', ['no-reg-proj', 'task'], null);
    assert.equal(result.accepted, false);
    const { getRunningTasks } = await import('../server/services/executor.js');
    const running = getRunningTasks();
    const found = running.find(t => t.id === result.taskId);
    assert.equal(found, undefined, 'failed spawn should not register task');
  });
});
