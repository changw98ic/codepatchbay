import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAgentHome, cleanupAgentHomes } from "../core/agents/isolation.js";

describe("agent isolation", () => {
  let cpbRoot;

  beforeEach(async () => {
    cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-iso-"));
  });

  afterEach(async () => {
    await rm(cpbRoot, { recursive: true, force: true });
  });

  it("createAgentHome creates directory structure", async () => {
    const env = await createAgentHome(cpbRoot, "codex", "job-001");

    assert.ok(env.HOME.startsWith(cpbRoot));
    assert.ok(env.XDG_CONFIG_HOME);
    assert.ok(env.XDG_DATA_HOME);
    assert.ok(env.XDG_CACHE_HOME);

    // Directories should exist
    const homeStat = await stat(env.HOME);
    assert.ok(homeStat.isDirectory());

    const configStat = await stat(env.XDG_CONFIG_HOME);
    assert.ok(configStat.isDirectory());

    const dataStat = await stat(env.XDG_DATA_HOME);
    assert.ok(dataStat.isDirectory());

    const cacheStat = await stat(env.XDG_CACHE_HOME);
    assert.ok(cacheStat.isDirectory());
  });

  it("createAgentHome uses agent name and job ID in path", async () => {
    const env = await createAgentHome(cpbRoot, "sample-agent", "job-abc");
    assert.ok(env.HOME.includes("sample-agent"));
    assert.ok(env.HOME.includes("job-abc"));
  });

  it("createAgentHome uses 'default' when no jobId", async () => {
    const env = await createAgentHome(cpbRoot, "claude");
    assert.ok(env.HOME.includes("default"));
  });

  it("createAgentHome isolates different agents", async () => {
    const envA = await createAgentHome(cpbRoot, "codex", "j1");
    const envB = await createAgentHome(cpbRoot, "claude", "j1");
    assert.notEqual(envA.HOME, envB.HOME);
  });

  it("createAgentHome isolates different jobs for same agent", async () => {
    const envA = await createAgentHome(cpbRoot, "codex", "j1");
    const envB = await createAgentHome(cpbRoot, "codex", "j2");
    assert.notEqual(envA.HOME, envB.HOME);
  });

  it("createAgentHome lets Codex reuse host auth inside isolated CODEX_HOME", async () => {
    const sourceHome = await mkdtemp(path.join(os.tmpdir(), "cpb-source-codex-"));
    try {
      const sourceCodexHome = path.join(sourceHome, ".codex");
      await mkdir(sourceCodexHome, { recursive: true });
      await writeFile(path.join(sourceCodexHome, "auth.json"), '{"token":"test"}\n');
      await writeFile(path.join(sourceCodexHome, "config.toml"), "model = \"test\"\n");

      const env = await createAgentHome(cpbRoot, "codex", "job-auth", {
        parentEnv: { HOME: sourceHome },
      });

      assert.equal(env.CODEX_HOME, path.join(env.HOME, ".codex"));
      assert.ok(env.CODEX_HOME.startsWith(cpbRoot));
      assert.equal(await readFile(path.join(env.CODEX_HOME, "auth.json"), "utf8"), '{"token":"test"}\n');
      assert.equal(await readFile(path.join(env.CODEX_HOME, "config.toml"), "utf8"), "model = \"test\"\n");
    } finally {
      await rm(sourceHome, { recursive: true, force: true });
    }
  });

  it("createAgentHome lets Claude reuse host auth without sharing runtime history", async () => {
    const sourceHome = await mkdtemp(path.join(os.tmpdir(), "cpb-source-claude-"));
    try {
      const sourceClaudeHome = path.join(sourceHome, ".claude");
      await mkdir(path.join(sourceClaudeHome, "sessions"), { recursive: true });
      await writeFile(path.join(sourceHome, ".claude.json"), '{"oauthAccount":"test"}\n');
      await writeFile(path.join(sourceClaudeHome, ".credentials.json"), '{"token":"test"}\n');
      await writeFile(path.join(sourceClaudeHome, "history.jsonl"), '{"prompt":"do not inherit"}\n');
      await writeFile(path.join(sourceClaudeHome, "sessions", "session.json"), '{"id":"do-not-inherit"}\n');

      const env = await createAgentHome(cpbRoot, "claude", "job-auth", {
        parentEnv: { HOME: sourceHome },
      });

      assert.ok(env.HOME.startsWith(cpbRoot));
      assert.equal(env.CLAUDE_HOME, undefined);
      assert.equal(await readFile(path.join(env.HOME, ".claude.json"), "utf8"), '{"oauthAccount":"test"}\n');
      assert.equal(await readFile(path.join(env.HOME, ".claude", ".credentials.json"), "utf8"), '{"token":"test"}\n');
      await assert.rejects(
        readFile(path.join(env.HOME, ".claude", "history.jsonl"), "utf8"),
        /ENOENT/,
      );
      await assert.rejects(
        readFile(path.join(env.HOME, ".claude", "sessions", "session.json"), "utf8"),
        /ENOENT/,
      );
    } finally {
      await rm(sourceHome, { recursive: true, force: true });
    }
  });

  it("cleanupAgentHomes removes old directories", async () => {
    await createAgentHome(cpbRoot, "codex", "old-job");
    await createAgentHome(cpbRoot, "codex", "new-job");

    // Cleanup with maxAge=1ms removes everything (dirs were just created, mtime is now)
    const cleaned = await cleanupAgentHomes(cpbRoot, { maxAgeMs: 1, now: Date.now() + 1000 });
    assert.ok(cleaned >= 2, `should clean at least 2, got ${cleaned}`);

    // Verify directories are gone
    const homesRoot = path.join(cpbRoot, "cpb-task", "agent-homes");
    let exists = true;
    try {
      await stat(homesRoot);
    } catch {
      exists = false;
    }
    // The root dir might still exist but subdirs should be gone
    if (exists) {
      const agents = await readdir(homesRoot).catch(() => []);
      for (const agent of agents) {
        const jobs = await readdir(path.join(homesRoot, agent)).catch(() => []);
        assert.equal(jobs.length, 0, `${agent} should have no jobs after cleanup`);
      }
    }
  });

  it("cleanupAgentHomes preserves recent directories", async () => {
    await createAgentHome(cpbRoot, "codex", "recent-job");

    // Cleanup with very large maxAge keeps everything
    const cleaned = await cleanupAgentHomes(cpbRoot, { maxAgeMs: 24 * 60 * 60 * 1000 });
    assert.equal(cleaned, 0, "should not clean recent directories");

    // Verify directory still exists
    const jobDir = path.join(cpbRoot, "cpb-task", "agent-homes", "codex", "recent-job");
    const info = await stat(jobDir);
    assert.ok(info.isDirectory());
  });

  it("cleanupAgentHomes handles empty root gracefully", async () => {
    const cleaned = await cleanupAgentHomes(cpbRoot);
    assert.equal(cleaned, 0);
  });

  it("cleanupAgentHomes skips directories with active lease", async () => {
    await createAgentHome(cpbRoot, "codex", "leased-job");
    await createAgentHome(cpbRoot, "codex", "expired-job");

    const activeLeases = new Set(["leased-job"]);
    const isLeaseActive = async (jobId) => activeLeases.has(jobId);

    const cleaned = await cleanupAgentHomes(cpbRoot, {
      maxAgeMs: 1,
      now: Date.now() + 1000,
      isLeaseActive,
    });

    assert.equal(cleaned, 1, "should only clean the expired job");

    const leasedDir = path.join(cpbRoot, "cpb-task", "agent-homes", "codex", "leased-job");
    const info = await stat(leasedDir);
    assert.ok(info.isDirectory(), "leased job directory should survive cleanup");
  });

  it("cleanupAgentHomes without isLeaseActive deletes all old dirs", async () => {
    await createAgentHome(cpbRoot, "codex", "old-1");

    const cleaned = await cleanupAgentHomes(cpbRoot, { maxAgeMs: 1, now: Date.now() + 1000 });
    assert.ok(cleaned >= 1);
  });
});
