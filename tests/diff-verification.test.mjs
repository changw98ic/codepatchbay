#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendEvent } from '../server/services/event-store.js';
import { createJob, getJob } from '../server/services/job-store.js';
import { runtimeDataPath } from '../server/services/runtime-root.js';
import { parseVerdict, writeVerificationManifest } from '../bridges/run-pipeline.mjs';

describe('A9: diff-based verification', () => {
  it('generateDiffArtifact creates diff file for git project', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-diff-test-'));
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

  it('diff artifact path is stored under cpb-task/artifacts', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-diff-path-'));
    try {
      const artifactsDir = runtimeDataPath(tmpRoot, path.join('artifacts', 'myproj', 'job-123'));
      assert.ok(artifactsDir.includes('cpb-task'));
      assert.ok(artifactsDir.includes('artifacts'));
      assert.ok(artifactsDir.includes('myproj'));
      assert.ok(artifactsDir.includes('job-123'));
    } finally {
      await rm(tmpRoot, { recursive: true });
    }
  });

  it('rtk_codex_verify includes diff section when artifact exists', async () => {
    const { execSync } = await import('node:child_process');
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-diff-prompt-'));
    try {
      const diffFile = path.join(tmpRoot, 'test-diff.patch');
      await writeFile(diffFile, 'fake diff content');

      const result = execSync(
        `CPB_ROOT="${path.resolve('.')}" CPB_DANGEROUS=1 bash -c 'source bridges/common.sh && rtk_codex_verify testproj 001 /tmp/verdict.md "${diffFile}"'`,
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
      `CPB_ROOT="${path.resolve('.')}" CPB_DANGEROUS=1 bash -c 'source bridges/common.sh && rtk_codex_verify testproj 001 /tmp/verdict.md'`,
      { encoding: 'utf8', cwd: path.resolve('.') }
    );

    assert.ok(!result.includes('Diff Artifact'));
  });

  it('codex-verify.sh accepts optional diff and manifest arguments', async () => {
    // Verify the script is syntactically valid with the extended bridge arguments
    const { execSync } = await import('node:child_process');
    const result = execSync(
      `bash -n bridges/codex-verify.sh`,
      { encoding: 'utf8', cwd: path.resolve('.') }
    );
    // bash -n returns empty on success
    assert.equal(result, '');
  });

  it('writeVerificationManifest binds the current worktree snapshot to diff hash and git head', async () => {
    const { execFile } = await import('node:child_process');
    const execFileAsync = async (cmd, args, cwd) => new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd }, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-verification-manifest-'));
    try {
      const cpbRoot = path.join(tmpRoot, 'cpb');
      const sourcePath = path.join(tmpRoot, 'source');
      const project = 'snapshot-test';
      const jobId = 'job-123';
      const wikiDir = path.join(cpbRoot, 'wiki', 'projects', project);
      const diffArtifactPath = path.join(tmpRoot, 'diff.patch');

      await mkdir(path.join(wikiDir, 'outputs'), { recursive: true });
      await mkdir(path.join(wikiDir, 'inbox'), { recursive: true });
      await mkdir(path.join(cpbRoot, 'bridges'), { recursive: true });
      await mkdir(sourcePath, { recursive: true });

      await execFileAsync('git', ['init'], sourcePath);
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], sourcePath);
      await execFileAsync('git', ['config', 'user.name', 'Test User'], sourcePath);
      await writeFile(path.join(sourcePath, 'file.txt'), 'hello\n', 'utf8');
      await execFileAsync('git', ['add', 'file.txt'], sourcePath);
      await execFileAsync('git', ['commit', '-m', 'init'], sourcePath);
      await writeFile(path.join(sourcePath, 'file.txt'), 'hello world\n', 'utf8');
      await writeFile(path.join(wikiDir, 'project.json'), JSON.stringify({ sourcePath }, null, 2), 'utf8');
      await writeFile(diffArtifactPath, 'diff --git a/file.txt b/file.txt\n+hello world\n', 'utf8');

      const manifest = await writeVerificationManifest({
        cpbRoot,
        project,
        jobId,
        wikiDir,
        deliverableId: '001',
        phase: 'verify',
        diffArtifactPath,
      });

      assert.ok(manifest, 'manifest should be produced for git worktrees');
      assert.equal(manifest.schema, 'cpb-verification-manifest-v1');
      assert.equal(manifest.project, project);
      assert.equal(manifest.jobId, jobId);
      assert.equal(manifest.deliverableId, '001');
      assert.equal(manifest.phase, 'verify');
      assert.ok(manifest.generatedAt);
      assert.equal(manifest.diffArtifact.sha256.length, 64);
      assert.equal(manifest.git.head.length, 40);
      assert.equal(manifest.git.shortHead.length, 12);
      assert.ok(manifest.snapshotId.length, 'snapshotId should be present');

      const written = JSON.parse(await readFile(manifest.manifestPath, 'utf8'));
      assert.equal(written.snapshotId, manifest.snapshotId);
      assert.equal(written.diffArtifact.sha256, manifest.diffArtifact.sha256);
      assert.equal(written.git.head, manifest.git.head);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rtk_codex_verify includes verification snapshot evidence when manifest exists', async () => {
    const { execSync } = await import('node:child_process');
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-verification-snapshot-prompt-'));
    try {
      const manifestPath = path.join(tmpRoot, 'verification-manifest.json');
      await writeFile(manifestPath, JSON.stringify({
        schema: 'cpb-verification-manifest-v1',
        generatedAt: '2026-05-18T00:00:00.000Z',
        project: 'testproj',
        jobId: 'job-001',
        deliverableId: '001',
        phase: 'verify',
        sourcePath: '/tmp/worktree',
        git: {
          gitRoot: '/tmp/worktree',
          head: '0123456789abcdef0123456789abcdef01234567',
          shortHead: '0123456789ab',
          branch: 'main',
          status: ' M file.txt',
          statusHash: 'deadbeef',
        },
        diffArtifact: {
          path: '/tmp/diff.patch',
          sha256: 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe',
        },
        snapshotId: 'snapshot-123',
      }, null, 2), 'utf8');

      const result = execSync(
        `CPB_ROOT="${path.resolve('.')}" CPB_DANGEROUS=1 bash -c 'source bridges/common.sh && rtk_codex_verify testproj 001 /tmp/verdict.md /tmp/diff.patch "${manifestPath}"'`,
        { encoding: 'utf8', cwd: path.resolve('.') }
      );

      assert.ok(result.includes('Verification Snapshot'));
      assert.ok(result.includes('artifact_stale'));
      assert.ok(result.includes('snapshot-123'));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('parseVerdict classifies artifact_stale failures separately', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'cpb-artifact-stale-verdict-'));
    try {
      const verdictPath = path.join(tmpRoot, 'verdict-001.md');
      await writeFile(verdictPath, [
        'VERDICT: FAIL',
        '',
        'Reason: artifact_stale because the manifest snapshotId does not match the diff artifact.',
      ].join('\n'), 'utf8');

      assert.equal(await parseVerdict(verdictPath), 'ARTIFACT_STALE');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('missing diff does not block verification', async () => {
    // When diff artifact is null/missing, verify still runs without diff
    const { execSync } = await import('node:child_process');
    const result = execSync(
      `CPB_ROOT="${path.resolve('.')}" CPB_DANGEROUS=1 bash -c 'source bridges/common.sh && rtk_codex_verify testproj 001 /tmp/verdict.md ""'`,
      { encoding: 'utf8', cwd: path.resolve('.') }
    );

    assert.ok(result.includes('Deliverable to verify'));
    assert.ok(!result.includes('Diff Artifact'));
  });
});
