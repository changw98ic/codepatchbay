import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createSession,
  getSession,
  updateSession,
  startSessionResearch,
  noteReviewAcpCall,
  assertReviewBudget,
} from "../server/services/review-session.js";

describe("review-budget-idempotency", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cpb-test-budget-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates session with budget fields", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "review code" });
    assert.ok(session.budget);
    assert.equal(typeof session.budget.maxRounds, "number");
    assert.equal(typeof session.budget.maxPromptBytes, "number");
    assert.equal(typeof session.budget.maxAcpCalls, "number");
    assert.equal(session.budget.usedAcpCalls, 0);
    assert.equal(session.budget.usedPromptBytes, 0);
  });

  it("creates session with idempotency fields", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "review code" });
    assert.ok(session.idempotency);
    assert.equal(session.idempotency.startKey, null);
    assert.equal(session.idempotency.dispatchKey, null);
  });

  it("startSessionResearch with same key is idempotent", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "do work" });
    const key = "key-123";

    const first = await startSessionResearch(tmpDir, session.sessionId, key);
    assert.equal(first.status, "researching");
    assert.equal(first.idempotency.startKey, key);

    const second = await startSessionResearch(tmpDir, session.sessionId, key);
    assert.equal(second.status, "researching");
    assert.equal(second.idempotency.startKey, key);
  });

  it("startSessionResearch with different key throws conflict", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "do work" });

    await startSessionResearch(tmpDir, session.sessionId, "key-alpha");

    await assert.rejects(
      () => startSessionResearch(tmpDir, session.sessionId, "key-beta"),
      { message: /idempotency conflict/ },
    );
  });

  it("noteReviewAcpCall increments usedAcpCalls and usedPromptBytes", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "do work" });
    await updateSession(tmpDir, session.sessionId, { status: "researching" });

    const afterFirst = await noteReviewAcpCall(tmpDir, session.sessionId, { agent: "codex", promptBytes: 500 });
    assert.equal(afterFirst.budget.usedAcpCalls, 1);
    assert.equal(afterFirst.budget.usedPromptBytes, 500);

    const afterSecond = await noteReviewAcpCall(tmpDir, session.sessionId, { agent: "claude", promptBytes: 300 });
    assert.equal(afterSecond.budget.usedAcpCalls, 2);
    assert.equal(afterSecond.budget.usedPromptBytes, 800);
  });

  it("assertReviewBudget throws when usedAcpCalls >= maxAcpCalls", () => {
    const session = {
      budget: {
        maxRounds: 5,
        maxPromptBytes: 120000,
        maxAcpCalls: 3,
        usedAcpCalls: 3,
        usedPromptBytes: 1000,
      },
    };
    assert.throws(
      () => assertReviewBudget(session),
      { message: /budget exhausted.*usedAcpCalls/ },
    );
  });

  it("assertReviewBudget throws when usedPromptBytes >= maxPromptBytes", () => {
    const session = {
      budget: {
        maxRounds: 5,
        maxPromptBytes: 1000,
        maxAcpCalls: 30,
        usedAcpCalls: 5,
        usedPromptBytes: 1000,
      },
    };
    assert.throws(
      () => assertReviewBudget(session),
      { message: /budget exhausted.*usedPromptBytes/ },
    );
  });

  it("assertReviewBudget returns session when budget is within limits", () => {
    const session = {
      budget: {
        maxRounds: 5,
        maxPromptBytes: 120000,
        maxAcpCalls: 30,
        usedAcpCalls: 5,
        usedPromptBytes: 1000,
      },
    };
    const result = assertReviewBudget(session);
    assert.equal(result, session);
  });

  it("budget exhaustion causes early termination in simulated review flow", async () => {
    const session = await createSession(tmpDir, { project: "p", intent: "do work" });
    await startSessionResearch(tmpDir, session.sessionId, "sim-key");

    // Simulate exhausting ACP call budget with very low limit
    const maxCalls = 2;
    await updateSession(tmpDir, session.sessionId, {
      budget: {
        maxRounds: 5,
        maxPromptBytes: 120000,
        maxAcpCalls: maxCalls,
        usedAcpCalls: 0,
        usedPromptBytes: 0,
      },
    }, { skipTransitionCheck: true });

    // Consume budget
    await noteReviewAcpCall(tmpDir, session.sessionId, { agent: "codex", promptBytes: 100 });
    await noteReviewAcpCall(tmpDir, session.sessionId, { agent: "claude", promptBytes: 100 });

    // Next budget check should fail
    const exhausted = await getSession(tmpDir, session.sessionId);
    assert.throws(
      () => assertReviewBudget(exhausted),
      { message: /budget exhausted/ },
    );
  });
});
