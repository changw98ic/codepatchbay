#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  normalizeProjectIndex,
  readProjectIndex,
  writeProjectIndex,
  formatProjectIndexLine,
} from "../server/services/project-index.js";
import { registerProject } from "../server/services/hub-registry.js";

describe("project-index service — writeProjectIndex + readProjectIndex round-trip", () => {
  let hubRoot, sourceRoot;

  beforeEach(async () => {
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-hub-"));
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-src-"));
  });

  afterEach(async () => {
    await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("writes and reads merged_indexed via Hub registry", async () => {
    const projectId = "test-proj";
    await registerProject(hubRoot, { id: projectId, name: projectId, sourcePath: sourceRoot });

    const written = await writeProjectIndex(hubRoot, null, projectId, {
      state: "merged_indexed",
      branch: "main",
      gitHead: "abc123def456789",
      indexedFrom: "merge:job-001",
      timestamp: "2026-05-21T12:00:00.000Z",
    });

    assert.equal(written.state, "indexed");
    assert.equal(written.gitHead, "abc123def456789");

    const read = await readProjectIndex(hubRoot, null, projectId);
    assert.equal(read.state, "indexed");
    assert.equal(read.raw, "merged_indexed");
    assert.equal(read.branch, "main");
    assert.equal(read.gitHead, "abc123def456789");
    assert.equal(read.indexedFrom, "merge:job-001");
    assert.equal(read.timestamp, "2026-05-21T12:00:00.000Z");
  });

  it("writes and reads merge_failed via Hub registry", async () => {
    const projectId = "fail-proj";
    await registerProject(hubRoot, { id: projectId, name: projectId, sourcePath: sourceRoot });

    await writeProjectIndex(hubRoot, null, projectId, {
      state: "merge_failed",
      branch: "develop",
      gitHead: "deadbeef",
      indexedFrom: "merge:job-002",
      timestamp: "2026-05-21T13:00:00.000Z",
      error: "conflict in file.js",
    });

    const read = await readProjectIndex(hubRoot, null, projectId);
    assert.equal(read.state, "failed");
    assert.equal(read.raw, "merge_failed");
    assert.equal(read.error, "conflict in file.js");
  });

  it("writes and reads via legacy wiki project.json fallback", async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-legacy-"));
    const projectId = "legacy-proj";
    const projectDir = path.join(cpbRoot, "wiki", "projects", projectId);
    await mkdir(projectDir, { recursive: true });

    await writeProjectIndex(null, cpbRoot, projectId, {
      state: "indexed",
      branch: "main",
      gitHead: "cafe1234",
      indexedFrom: "merge:job-003",
      timestamp: "2026-05-21T14:00:00.000Z",
    });

    const read = await readProjectIndex(null, cpbRoot, projectId);
    assert.equal(read.state, "indexed");
    assert.equal(read.gitHead, "cafe1234");

    await rm(cpbRoot, { recursive: true, force: true });
  });

  it("updates existing project index on re-write", async () => {
    const projectId = "update-proj";
    await registerProject(hubRoot, { id: projectId, name: projectId, sourcePath: sourceRoot });

    await writeProjectIndex(hubRoot, null, projectId, {
      state: "merged_indexed",
      branch: "main",
      gitHead: "aaa111",
      indexedFrom: "merge:job-010",
      timestamp: "2026-05-21T10:00:00.000Z",
    });

    await writeProjectIndex(hubRoot, null, projectId, {
      state: "merged_index_stale",
      branch: "main",
      gitHead: "aaa111",
      indexedFrom: "merge:job-010",
      timestamp: "2026-05-21T11:00:00.000Z",
      error: "HEAD drift detected",
    });

    const read = await readProjectIndex(hubRoot, null, projectId);
    assert.equal(read.state, "stale");
    assert.equal(read.error, "HEAD drift detected");
  });

  it("returns null when no index exists", async () => {
    const projectId = "no-idx";
    await registerProject(hubRoot, { id: projectId, name: projectId, sourcePath: sourceRoot });
    const read = await readProjectIndex(hubRoot, null, projectId);
    assert.equal(read, null);
  });

  it("throws on invalid data", async () => {
    const projectId = "bad-proj";
    await registerProject(hubRoot, { id: projectId, name: projectId, sourcePath: sourceRoot });
    await assert.rejects(() => writeProjectIndex(hubRoot, null, projectId, { state: "bogus" }));
  });
});

describe("project-index service — formatProjectIndexLine", () => {
  it("formats indexed state", () => {
    const line = formatProjectIndexLine(normalizeProjectIndex({
      state: "merged_indexed", branch: "main", gitHead: "abc123", indexedFrom: "merge:job-1", timestamp: "2026-05-21T12:00:00Z",
    }));
    assert.match(line, /Project index: indexed/);
    assert.match(line, /branch:main/);
    assert.match(line, /raw:merged_indexed/);
  });

  it("formats stale state with error", () => {
    const line = formatProjectIndexLine(normalizeProjectIndex({
      state: "merged_index_stale", error: "drift", branch: "main", gitHead: "abc", indexedFrom: "merge:job-2", timestamp: "2026-05-21T12:00:00Z",
    }));
    assert.match(line, /Project index: stale/);
    assert.match(line, /error:drift/);
  });

  it("returns null for no input", () => {
    assert.equal(formatProjectIndexLine(null), null);
  });
});
