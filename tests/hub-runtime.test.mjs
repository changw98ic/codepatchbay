#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getHubRuntime, resetInstances, RUNTIME_VERSION } from "../server/services/hub-runtime.js";

describe("hub-runtime singleton", () => {
  let cpbRoot;
  let hubRoot;

  beforeEach(async () => {
    cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-rt-cpb-"));
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-rt-hub-"));
    resetInstances();
  });

  afterEach(async () => {
    resetInstances();
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
  });

  it("returns the same instance for the same (cpbRoot, hubRoot)", () => {
    const a = getHubRuntime(cpbRoot, hubRoot);
    const b = getHubRuntime(cpbRoot, hubRoot);
    assert.strictEqual(a, b);
    assert.strictEqual(a.startedAt, b.startedAt);
    assert.strictEqual(a.pid, b.pid);
  });

  it("returns different instances for different hub roots", () => {
    const a = getHubRuntime(cpbRoot, hubRoot);
    const otherHub = path.join(hubRoot, "other");
    const b = getHubRuntime(cpbRoot, otherHub);
    assert.notStrictEqual(a, b);
  });

  it("exposes required metadata fields", () => {
    const rt = getHubRuntime(cpbRoot, hubRoot);
    assert.equal(rt.pid, process.pid);
    assert.equal(rt.version, RUNTIME_VERSION);
    assert.equal(rt.cpbRoot, path.resolve(cpbRoot));
    assert.equal(rt.hubRoot, path.resolve(hubRoot));
    assert.equal(rt.runtime, "node");
    assert.equal(rt.health, "alive");
    assert.ok(rt.startedAt);
    assert.ok(new Date(rt.startedAt).getTime() > 0);
  });

  it("status() returns a snapshot with statePath", () => {
    const rt = getHubRuntime(cpbRoot, hubRoot);
    const s = rt.status();
    assert.equal(s.statePath, path.join(path.resolve(hubRoot), "state", "hub.json"));
    assert.equal(s.pid, process.pid);
    assert.equal(s.version, RUNTIME_VERSION);
  });

  it("persists hub.json to <hubRoot>/state/hub.json", async () => {
    const rt = getHubRuntime(cpbRoot, hubRoot);
    await rt.persist();
    const raw = await readFile(rt.statePath, "utf8");
    const data = JSON.parse(raw);
    assert.equal(data.pid, process.pid);
    assert.equal(data.version, RUNTIME_VERSION);
    assert.equal(data.hubRoot, path.resolve(hubRoot));
    assert.equal(data.runtime, "node");
    assert.equal(data.health, "alive");
    assert.ok(data.startedAt);
  });

  it("repeated runtime access preserves process identity", () => {
    const first = getHubRuntime(cpbRoot, hubRoot);
    const second = getHubRuntime(cpbRoot, hubRoot);
    assert.strictEqual(first.startedAt, second.startedAt);
    assert.strictEqual(first.pid, second.pid);
    assert.strictEqual(first.version, second.version);
  });

  it("persist is idempotent and writes the same startedAt", async () => {
    const rt = getHubRuntime(cpbRoot, hubRoot);
    await rt.persist();
    const first = JSON.parse(await readFile(rt.statePath, "utf8"));
    await rt.persist();
    const second = JSON.parse(await readFile(rt.statePath, "utf8"));
    assert.strictEqual(first.startedAt, second.startedAt);
    assert.strictEqual(first.pid, second.pid);
  });
});
