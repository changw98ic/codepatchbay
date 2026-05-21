#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const executorRoot = path.resolve(path.join(import.meta.dirname, ".."));

function runCpbStatus(project, cpbRoot, extraEnv = {}) {
  return execSync(`bash "${executorRoot}/cpb" status ${project}`, {
    encoding: "utf8",
    env: {
      ...process.env,
      CPB_ROOT: cpbRoot,
      CPB_EXECUTOR_ROOT: executorRoot,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
  });
}

async function setupProject(cpbRoot, project, projectIndex) {
  const projectDir = path.join(cpbRoot, "wiki", "projects", project);
  await mkdir(path.join(projectDir, "inbox"), { recursive: true });
  await mkdir(path.join(projectDir, "outputs"), { recursive: true });
  const projectJson = {
    sourcePath: "/tmp/fake-source",
    projectIndex,
  };
  await writeFile(
    path.join(projectDir, "project.json"),
    JSON.stringify(projectJson, null, 2) + "\n",
    "utf8"
  );
}

describe("cpb status <project> — project-index output", () => {
  let cpbRoot;

  beforeEach(async () => {
    cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-status-"));
  });

  afterEach(async () => {
    await rm(cpbRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("shows Project index: indexed with all fields", () => {
    const project = "idx-test";
    return setupProject(cpbRoot, project, {
      state: "merged_indexed",
      branch: "main",
      gitHead: "abc123def456",
      indexedFrom: "merge:job-001",
      timestamp: "2026-05-21T12:00:00.000Z",
    }).then(() => {
      const out = runCpbStatus(project, cpbRoot);
      assert.match(out, /Project index: indexed/);
      assert.match(out, /branch:main/);
      assert.match(out, /gitHead:abc123def456/);
      assert.match(out, /indexedFrom:merge:job-001/);
      assert.match(out, /timestamp:2026-05-21T12:00:00/);
      assert.match(out, /raw:merged_indexed/);
    });
  });

  it("shows Project index: stale with error", () => {
    const project = "stale-test";
    return setupProject(cpbRoot, project, {
      state: "merged_index_stale",
      branch: "main",
      gitHead: "deadbeef",
      indexedFrom: "merge:job-002",
      timestamp: "2026-05-21T13:00:00.000Z",
      error: "HEAD drift detected",
    }).then(() => {
      const out = runCpbStatus(project, cpbRoot);
      assert.match(out, /Project index: stale/);
      assert.match(out, /branch:main/);
      assert.match(out, /gitHead:deadbeef/);
      assert.match(out, /indexedFrom:merge:job-002/);
      assert.match(out, /timestamp:2026-05-21T13:00:00/);
      assert.match(out, /error:HEAD drift detected/);
      assert.match(out, /raw:merged_index_stale/);
    });
  });

  it("shows Project index: failed with error", () => {
    const project = "fail-test";
    return setupProject(cpbRoot, project, {
      state: "merge_failed",
      branch: "develop",
      gitHead: "f00dcafe",
      indexedFrom: "merge:job-003",
      timestamp: "2026-05-21T14:00:00.000Z",
      error: "merge conflict",
    }).then(() => {
      const out = runCpbStatus(project, cpbRoot);
      assert.match(out, /Project index: failed/);
      assert.match(out, /branch:develop/);
      assert.match(out, /gitHead:f00dcafe/);
      assert.match(out, /indexedFrom:merge:job-003/);
      assert.match(out, /timestamp:2026-05-21T14:00:00/);
      assert.match(out, /error:merge conflict/);
      assert.match(out, /raw:merge_failed/);
    });
  });

  it("omits Project index line when no project-index metadata exists", () => {
    const project = "no-idx-test";
    return setupProject(cpbRoot, project, undefined).then(() => {
      const out = runCpbStatus(project, cpbRoot);
      assert.doesNotMatch(out, /Project index:/);
    });
  });

  it("handles normalized state without raw facet", () => {
    const project = "norm-test";
    return setupProject(cpbRoot, project, {
      state: "indexed",
      branch: "main",
      gitHead: "1234567890ab",
      indexedFrom: "merge:job-004",
      timestamp: "2026-05-21T15:00:00.000Z",
    }).then(() => {
      const out = runCpbStatus(project, cpbRoot);
      assert.match(out, /Project index: indexed/);
      assert.match(out, /branch:main/);
      assert.match(out, /gitHead:1234567890ab/);
      assert.doesNotMatch(out, /raw:/);
    });
  });
});

const { normalizeProjectIndex } = await import("../server/services/project-index.js");

describe("project-index service — normalizeProjectIndex", () => {

  it("normalizes merged_indexed to indexed", () => {
    const result = normalizeProjectIndex({ state: "merged_indexed", branch: "main", gitHead: "abc", timestamp: "2026-01-01T00:00:00Z" });
    assert.equal(result.state, "indexed");
    assert.equal(result.raw, "merged_indexed");
  });

  it("normalizes merged_index_stale to stale", () => {
    const result = normalizeProjectIndex({ state: "merged_index_stale", error: "drift" });
    assert.equal(result.state, "stale");
    assert.equal(result.raw, "merged_index_stale");
  });

  it("normalizes merge_failed to failed", () => {
    const result = normalizeProjectIndex({ state: "merge_failed", error: "conflict" });
    assert.equal(result.state, "failed");
    assert.equal(result.raw, "merge_failed");
  });

  it("passes through already-normal states", () => {
    for (const s of ["indexed", "stale", "failed", "indexing", "unmerged"]) {
      const result = normalizeProjectIndex({ state: s });
      assert.equal(result.state, s);
      assert.equal(result.raw, null);
    }
  });

  it("returns null for invalid input", () => {
    assert.equal(normalizeProjectIndex(null), null);
    assert.equal(normalizeProjectIndex(undefined), null);
    assert.equal(normalizeProjectIndex({}), null);
    assert.equal(normalizeProjectIndex({ state: "bogus" }), null);
  });

  it("shortens gitHead when > 12 chars", () => {
    const result = normalizeProjectIndex({ state: "indexed", gitHead: "abc123def456789000111222" });
    assert.equal(result.gitHeadShort, "abc123def456");
  });

  it("prefers timestamp over indexedAt/updatedAt", () => {
    const result = normalizeProjectIndex({
      state: "indexed",
      timestamp: "2026-05-21T12:00:00Z",
      indexedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    });
    assert.equal(result.timestamp, "2026-05-21T12:00:00.000Z");
  });

  it("falls back to indexedAt when timestamp absent", () => {
    const result = normalizeProjectIndex({
      state: "indexed",
      indexedAt: "2026-03-01T00:00:00Z",
    });
    assert.equal(result.timestamp, "2026-03-01T00:00:00.000Z");
  });
});
