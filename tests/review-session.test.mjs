#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
  parseIssues,
} from "../server/services/review-session.js";

const TMP = path.join(process.cwd(), "test-review-tmp-" + Date.now());

describe("review-session service", () => {
  beforeEach(async () => {
    await mkdir(TMP, { recursive: true });
  });
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true }).catch(() => {});
  });

  it("creates a session with correct defaults", async () => {
    const s = await createSession(TMP, { project: "my-proj", intent: "add dark mode" });
    assert.ok(s.sessionId.startsWith("rev-"));
    assert.equal(s.project, "my-proj");
    assert.equal(s.intent, "add dark mode");
    assert.equal(s.status, "idle");
    assert.equal(s.round, 0);
    assert.deepEqual(s.research, { codex: null, claude: null });
    assert.equal(s.plan, null);
    assert.deepEqual(s.reviews, []);
    assert.equal(s.userVerdict, null);
  });

  it("gets a session by id", async () => {
    const created = await createSession(TMP, { project: "p1", intent: "do stuff" });
    const loaded = await getSession(TMP, created.sessionId);
    assert.equal(loaded.sessionId, created.sessionId);
    assert.equal(loaded.project, "p1");
  });

  it("returns null for non-existent session", async () => {
    const loaded = await getSession(TMP, "rev-nonexistent");
    assert.equal(loaded, null);
  });

  it("lists all created sessions", async () => {
    const s1 = await createSession(TMP, { project: "p1", intent: "a" });
    const s2 = await createSession(TMP, { project: "p2", intent: "b" });
    const list = await listSessions(TMP);
    assert.equal(list.length, 2);
    const ids = list.map((s) => s.sessionId);
    assert.ok(ids.includes(s1.sessionId));
    assert.ok(ids.includes(s2.sessionId));
  });

  it("returns empty list when no sessions", async () => {
    const list = await listSessions(TMP);
    assert.deepEqual(list, []);
  });

  it("updates session fields", async () => {
    const s = await createSession(TMP, { project: "p1", intent: "test" });
    const updated = await updateSession(TMP, s.sessionId, {
      status: "researching",
      round: 1,
    });
    assert.equal(updated.status, "researching");
    assert.equal(updated.round, 1);
  });

  it("preserves immutable fields on update", async () => {
    const s = await createSession(TMP, { project: "p1", intent: "original" });
    const updated = await updateSession(TMP, s.sessionId, {
      status: "researching",
      project: "hacked",
      intent: "changed",
      sessionId: "fake",
    });
    assert.equal(updated.project, "p1");
    assert.equal(updated.intent, "original");
    assert.equal(updated.sessionId, s.sessionId);
  });

  it("allows valid state transitions", async () => {
    const s = await createSession(TMP, { project: "p1", intent: "test" });
    await updateSession(TMP, s.sessionId, { status: "researching" });
    await updateSession(TMP, s.sessionId, { status: "planning" });
    await updateSession(TMP, s.sessionId, { status: "reviewing" });
    await updateSession(TMP, s.sessionId, { status: "user_review" });
    await updateSession(TMP, s.sessionId, { status: "dispatched" });
  });

  it("rejects invalid state transitions", async () => {
    const s = await createSession(TMP, { project: "p1", intent: "test" });
    await assert.rejects(
      () => updateSession(TMP, s.sessionId, { status: "dispatched" }),
      /invalid transition/
    );
  });

  it("allows revising → reviewing cycle", async () => {
    const s = await createSession(TMP, { project: "p1", intent: "test" });
    await updateSession(TMP, s.sessionId, { status: "researching" });
    await updateSession(TMP, s.sessionId, { status: "planning" });
    await updateSession(TMP, s.sessionId, { status: "reviewing" });
    await updateSession(TMP, s.sessionId, { status: "revising" });
    await updateSession(TMP, s.sessionId, { status: "reviewing" });
    await updateSession(TMP, s.sessionId, { status: "user_review" });
  });

  it("allows transition to expired from any active state", async () => {
    const s = await createSession(TMP, { project: "p1", intent: "test" });
    await updateSession(TMP, s.sessionId, { status: "researching" });
    await updateSession(TMP, s.sessionId, { status: "expired" });
  });

  it("throws on update of non-existent session", async () => {
    await assert.rejects(
      () => updateSession(TMP, "rev-nonexistent", { status: "researching" }),
      /review session not found/
    );
  });
});

describe("parseIssues", () => {
  it("extracts issues with severity", () => {
    const text = "[P0] Critical bug here\nSome details\n[P2] Medium issue\n[P3] Minor thing";
    const issues = parseIssues(text);
    assert.equal(issues.length, 3);
    assert.equal(issues[0].severity, 0);
    assert.ok(issues[0].description.includes("Critical bug here"));
    assert.equal(issues[1].severity, 2);
    assert.equal(issues[2].severity, 3);
  });

  it("returns empty for null/undefined", () => {
    assert.deepEqual(parseIssues(null), []);
    assert.deepEqual(parseIssues(undefined), []);
  });

  it("returns empty for REVIEW: PASS", () => {
    assert.deepEqual(parseIssues("REVIEW: PASS"), []);
  });

  it("returns empty for plain text without tags", () => {
    assert.deepEqual(parseIssues("no issues here"), []);
  });
});
