#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadState, saveState,
  loadBacklog, popIssue, pushIssues, updateIssue,
  appendHistory,
} from "../server/services/evolve-state.js";

const TMP = path.join(process.cwd(), "test-evolve-tmp-" + Date.now());

describe("evolve-state", () => {
  beforeEach(async () => {
    await mkdir(path.join(TMP, "cpb-task", "self-evolve"), { recursive: true });
  });
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true }).catch(() => {});
  });

  it("loads default state when no file exists", async () => {
    const state = await loadState(TMP);
    assert.equal(state.status, "idle");
    assert.equal(state.round, 0);
    assert.equal(state.knownGoodCommit, null);
  });

  it("saves and loads state round-trip", async () => {
    await saveState(TMP, { status: "running", round: 5, knownGoodCommit: "abc123", maxRounds: 20 });
    const loaded = await loadState(TMP);
    assert.equal(loaded.status, "running");
    assert.equal(loaded.round, 5);
    assert.equal(loaded.knownGoodCommit, "abc123");
  });

  it("loads empty backlog", async () => {
    const backlog = await loadBacklog(TMP);
    assert.deepEqual(backlog, []);
  });

  it("pushes issues and deduplicates", async () => {
    const count = await pushIssues(TMP, [
      { priority: "P1", description: "fix auth bug" },
      { priority: "P2", description: "add logging" },
    ]);
    assert.equal(count, 2);

    // Duplicate should be skipped
    const count2 = await pushIssues(TMP, [
      { priority: "P1", description: "fix auth bug" },
    ]);
    assert.equal(count2, 2);
  });

  it("pops highest priority issue first", async () => {
    await pushIssues(TMP, [
      { priority: "P2", description: "low priority" },
      { priority: "P0", description: "critical" },
      { priority: "P1", description: "high" },
    ]);
    const { issue } = await popIssue(TMP);
    assert.equal(issue.priority, "P0");
    assert.equal(issue.description, "critical");
    assert.equal(issue.status, "in_progress");
  });

  it("returns null when no pending issues", async () => {
    const result = await popIssue(TMP);
    assert.equal(result, null);
  });

  it("updates issue status", async () => {
    await pushIssues(TMP, [{ priority: "P1", description: "fix bug" }]);
    await updateIssue(TMP, "fix bug", "done", "all good");
    const backlog = await loadBacklog(TMP);
    assert.equal(backlog[0].status, "done");
    assert.equal(backlog[0].detail, "all good");
  });

  it("appends history as JSONL", async () => {
    await appendHistory(TMP, { round: 1, action: "scan", result: "empty" });
    await appendHistory(TMP, { round: 2, action: "fix", result: "success" });
    const raw = await readFile(path.join(TMP, "cpb-task", "self-evolve", "history.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);
    const entry1 = JSON.parse(lines[0]);
    assert.equal(entry1.round, 1);
    assert.ok(entry1.timestamp);
  });
});
