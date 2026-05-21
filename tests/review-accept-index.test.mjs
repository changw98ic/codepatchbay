#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import fs from "fs/promises";
import path from "path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { reviewRoutes } from "../server/routes/review.js";
import { readProjectIndex, writeProjectIndex } from "../server/services/project-index.js";
import { resolveHubRoot } from "../server/services/hub-registry.js";
import { materializeJob } from "../server/services/event-store.js";
import { registerProject } from "../server/services/hub-registry.js";

async function buildApp(cpbRoot) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.addHook("onRequest", (req, _res, done) => {
    req.cpbRoot = cpbRoot;
    done();
  });
  await app.register(reviewRoutes);
  await app.ready();
  return app;
}

describe("review accept — module integration", () => {
  it("exposes reviewRoutes with writeProjectIndex import chain", async () => {
    const mod = await import("../server/routes/review.js");
    assert.ok(mod.reviewRoutes);
  });

  it("writeProjectIndex is callable from review context", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-review-rt-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-review-src-"));
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-review-cpb-"));
    const projectId = "review-proj";

    await registerProject(hubRoot, { id: projectId, name: projectId, sourcePath: sourceRoot });

    // Simulate what review accept does after a successful merge
    await writeProjectIndex(hubRoot, cpbRoot, projectId, {
      state: "merged_indexed",
      branch: "main",
      gitHead: "abc123def456",
      indexedFrom: "merge:job-review-001",
      timestamp: new Date().toISOString(),
    });

    const idx = await readProjectIndex(hubRoot, cpbRoot, projectId);
    assert.equal(idx.state, "indexed");
    assert.equal(idx.raw, "merged_indexed");
    assert.equal(idx.branch, "main");
    assert.equal(idx.indexedFrom, "merge:job-review-001");

    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
  });

  it("writeProjectIndex persists merge_failed state", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-review-rt-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-review-src-"));
    const projectId = "fail-review-proj";

    await registerProject(hubRoot, { id: projectId, name: projectId, sourcePath: sourceRoot });

    await writeProjectIndex(hubRoot, null, projectId, {
      state: "merge_failed",
      branch: "main",
      gitHead: "oldhead123",
      indexedFrom: "merge:job-review-002",
      timestamp: new Date().toISOString(),
      error: "merge conflict in src/index.js",
    });

    const idx = await readProjectIndex(hubRoot, null, projectId);
    assert.equal(idx.state, "failed");
    assert.equal(idx.raw, "merge_failed");
    assert.equal(idx.error, "merge conflict in src/index.js");

    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it("stale index detection marks previously indexed as stale", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-review-rt-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-review-src-"));
    const projectId = "stale-proj";

    await registerProject(hubRoot, { id: projectId, name: projectId, sourcePath: sourceRoot });

    // First write indexed state
    await writeProjectIndex(hubRoot, null, projectId, {
      state: "merged_indexed",
      branch: "main",
      gitHead: "oldhead123",
      indexedFrom: "merge:job-old",
      timestamp: "2026-05-21T10:00:00.000Z",
    });

    // Then update to stale (simulating what hub claim would do on HEAD drift)
    await writeProjectIndex(hubRoot, null, projectId, {
      state: "merged_index_stale",
      branch: "main",
      gitHead: "oldhead123",
      indexedFrom: "merge:job-old",
      timestamp: "2026-05-21T11:00:00.000Z",
      error: "HEAD drift: indexed oldhead123 but current is newhead456",
    });

    const idx = await readProjectIndex(hubRoot, null, projectId);
    assert.equal(idx.state, "stale");
    assert.equal(idx.raw, "merged_index_stale");
    assert.match(idx.error, /HEAD drift/);

    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  });
});

describe("event-store — merge_index_status materialization", () => {
  it("materializes merge_index_status event fields", () => {
    const events = [
      { type: "job_created", jobId: "j1", project: "p1", task: "t", ts: "2026-01-01T00:00:00Z" },
      { type: "merge_index_status", indexState: "merged_indexed", branch: "main", gitHead: "abc123", indexedFrom: "merge:j1", ts: "2026-01-01T00:01:00Z" },
      { type: "job_completed", ts: "2026-01-01T00:02:00Z" },
      { type: "merge_index_status", indexState: "merged_index_stale", branch: "main", gitHead: "abc123", indexedFrom: "merge:j1", ts: "2026-01-01T00:03:00Z" },
    ];

    const state = materializeJob(events);
    assert.equal(state.mergeIndexStatus, "merged_index_stale");
    assert.equal(state.mergeIndexBranch, "main");
    assert.equal(state.mergeIndexGitHead, "abc123");
    assert.equal(state.mergeIndexedFrom, "merge:j1");
  });

  it("keeps default null values when no merge_index_status events", () => {
    const events = [
      { type: "job_created", jobId: "j2", project: "p2", task: "t", ts: "2026-01-01T00:00:00Z" },
      { type: "job_completed", ts: "2026-01-01T00:01:00Z" },
    ];

    const state = materializeJob(events);
    assert.equal(state.mergeIndexStatus, null);
    assert.equal(state.mergeIndexBranch, null);
    assert.equal(state.mergeIndexGitHead, null);
    assert.equal(state.mergeIndexedFrom, null);
  });
});
