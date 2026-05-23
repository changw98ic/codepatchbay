import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createSession,
  getSession,
  updateSession,
  listSessions,
  parseIssues,
} from "../server/services/review-session.js";

describe("review-session", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cpb-test-review-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates and retrieves a session", async () => {
    const session = await createSession(tmpDir, { project: "test-proj", intent: "fix auth bug" });
    assert.ok(session.sessionId);
    assert.equal(session.status, "idle");
    assert.equal(session.project, "test-proj");

    const loaded = await getSession(tmpDir, session.sessionId);
    assert.equal(loaded.status, "idle");
    assert.equal(loaded.intent, "fix auth bug");
  });

  it("lists sessions", async () => {
    await createSession(tmpDir, { project: "a", intent: "task a" });
    await createSession(tmpDir, { project: "b", intent: "task b" });
    const sessions = await listSessions(tmpDir);
    assert.equal(sessions.length, 2);
  });

  it("allows valid transition idle → researching", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "do work" });
    const updated = await updateSession(tmpDir, session.sessionId, { status: "researching" });
    assert.equal(updated.status, "researching");
  });

  it("rejects same-status transition (duplicate start protection)", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "do work" });
    await updateSession(tmpDir, session.sessionId, { status: "researching" });

    await assert.rejects(
      () => updateSession(tmpDir, session.sessionId, { status: "researching" }),
      { message: /already in status: researching/ },
    );
  });

  it("rejects invalid transition idle → reviewing", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "do work" });
    await assert.rejects(
      () => updateSession(tmpDir, session.sessionId, { status: "reviewing" }),
      { message: /invalid transition: idle → reviewing/ },
    );
  });

  it("allows full review lifecycle transitions", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "do work" });
    const sid = session.sessionId;

    await updateSession(tmpDir, sid, { status: "researching" });
    await updateSession(tmpDir, sid, { status: "planning" });
    await updateSession(tmpDir, sid, { status: "reviewing" });
    await updateSession(tmpDir, sid, { status: "user_review" });
    await updateSession(tmpDir, sid, { status: "completed" });

    const final = await getSession(tmpDir, sid);
    assert.equal(final.status, "completed");
  });

  it("allows dispatched → merge_failed → dispatched retry", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "do work" });
    const sid = session.sessionId;

    await updateSession(tmpDir, sid, { status: "researching" });
    await updateSession(tmpDir, sid, { status: "planning" });
    await updateSession(tmpDir, sid, { status: "reviewing" });
    await updateSession(tmpDir, sid, { status: "user_review" });
    await updateSession(tmpDir, sid, { status: "dispatched" });

    await updateSession(tmpDir, sid, { status: "merge_failed" });
    const afterFail = await getSession(tmpDir, sid);
    assert.equal(afterFail.status, "merge_failed");

    await updateSession(tmpDir, sid, { status: "dispatched" });
    const afterRetry = await getSession(tmpDir, sid);
    assert.equal(afterRetry.status, "dispatched");
  });

  it("simulates start route flow: first start ok, second start conflict", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "review code" });
    const sid = session.sessionId;

    // Simulate first /review/:id/start
    const first = await updateSession(tmpDir, sid, { status: "researching" });
    assert.equal(first.status, "researching");

    // Simulate second /review/:id/start — should fail
    await assert.rejects(
      () => updateSession(tmpDir, sid, { status: "researching" }),
      { message: /already in status/ },
    );

    // Session should still be researching (not corrupted)
    const current = await getSession(tmpDir, sid);
    assert.equal(current.status, "researching");
  });

  it("simulates dispatch background: researching already set by route", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "review code" });
    const sid = session.sessionId;

    // Route sets researching
    await updateSession(tmpDir, sid, { status: "researching" });

    // Dispatch reads session, sees it's already researching, skips update
    const current = await getSession(tmpDir, sid);
    assert.equal(current.status, "researching");
    // Dispatch proceeds without calling updateSession(status: "researching") again
  });

  it("parseIssues extracts severity and description", () => {
    const text = "[P0] Critical failure\nSomething broke\n[P2] Minor issue\n[P3] Style nit";
    const issues = parseIssues(text);
    assert.equal(issues.length, 3);
    assert.equal(issues[0].severity, 0);
    assert.equal(issues[1].severity, 2);
    assert.equal(issues[2].severity, 3);
  });
});
