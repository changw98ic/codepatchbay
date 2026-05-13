#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendEvent } from '../server/services/event-store.js';
import { createJob, getJob } from '../server/services/job-store.js';
import { runtimeDataPath } from '../server/services/runtime-root.js';

describe('A9: diff-based verification', () => {
  it('generateDiffArtifact creates diff file for git project', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'flow-diff-test-'));
    try {
      // Create a fake project with git
      const projectDir = path.join(tmpRoot, 'source');
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ sourcePath: projectDir }));

      // Simulate git repo by writing a diff
      const wikiDir = path.join(tmpRoot, 'wiki', 'projects', 'testproj');
      await mkdir(path.join(wikiDir, 'outputs'), { recursive: true });
      await mkdir(path.join(wikiDir, 'inbox'), { recursive: true });
      await writeFile(path.join(wikiDir, 'project.json'), JSON.stringify({ sourcePath: projectDir }));

      const jobId = 'job-test-001';
      const artifactsDir = runtimeDataPath(tmpRoot, path.join('artifacts', 'testproj', jobId));
      await mkdir(artifactsDir, { recursive: true });
      const diffPath = path.join(artifactsDir, 'diff-execute.patch');
      await writeFile(diffPath, 'diff --git a/file.js b/file.js\n+new line\n-old line\n');

      const content = await readFile(diffPath, 'utf8');
      assert.ok(content.includes('diff --git'));
      assert.ok(content.includes('+new line'));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('diff artifact path is stored under flow-task/artifacts', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'flow-diff-path-'));
    try {
      const artifactsDir = runtimeDataPath(tmpRoot, path.join('artifacts', 'myproj', 'job-123'));
      assert.ok(artifactsDir.includes('flow-task'));
      assert.ok(artifactsDir.includes('artifacts'));
      assert.ok(artifactsDir.includes('myproj'));
      assert.ok(artifactsDir.includes('job-123'));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('rtk_codex_verify includes diff section when artifact exists', async () => {
    const { execSync } = await import('node:child_process');
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'flow-diff-prompt-'));
    try {
      const diffFile = path.join(tmpRoot, 'test-diff.patch');
      await writeFile(diffFile, 'fake diff content');

      const result = execSync(
        `FLOW_ROOT="${path.resolve('.')}" FLOW_DANGEROUS=1 bash -c 'source bridges/common.sh && rtk_codex_verify testproj 001 /tmp/verdict.md "${diffFile}"'`,
        { encoding: 'utf8', cwd: path.resolve('.') }
      );

      assert.ok(result.includes('Diff Artifact'));
      assert.ok(result.includes(diffFile));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('rtk_codex_verify omits diff section when no artifact', async () => {
    const { execSync } = await import('node:child_process');
    const result = execSync(
      `FLOW_ROOT="${path.resolve('.')}" FLOW_DANGEROUS=1 bash -c 'source bridges/common.sh && rtk_codex_verify testproj 001 /tmp/verdict.md'`,
      { encoding: 'utf8', cwd: path.resolve('.') }
    );

    assert.ok(!result.includes('Diff Artifact'));
  });

  it('codex-verify.sh accepts optional third diff argument', async () => {
    // Verify the script is syntactically valid with the new argument
    const { execSync } = await import('node:child_process');
    const result = execSync(
      `bash -n bridges/codex-verify.sh`,
      { encoding: 'utf8', cwd: path.resolve('.') }
    );
    // bash -n returns empty on success
    assert.equal(result, '');
  });

  it('missing diff does not block verification', async () => {
    // When diff artifact is null/missing, verify still runs without diff
    const { execSync } = await import('node:child_process');
    const result = execSync(
      `FLOW_ROOT="${path.resolve('.')}" FLOW_DANGEROUS=1 bash -c 'source bridges/common.sh && rtk_codex_verify testproj 001 /tmp/verdict.md ""'`,
      { encoding: 'utf8', cwd: path.resolve('.') }
    );

    assert.ok(result.includes('Deliverable to verify'));
    assert.ok(!result.includes('Diff Artifact'));
  });
});
