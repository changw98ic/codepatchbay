import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("event-source", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-evt-test-"));
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("ingestEvent creates candidate entry", async () => {
    const { ingestEvent, listCandidates } = await import("../server/services/event-source.js");

    const result = await ingestEvent(tmpDir, {
      source: "github-issue",
      externalId: "42",
      projectId: "my-project",
      priority: "high",
      payload: { title: "Fix login bug" },
    });

    assert.ok(result.id);
    assert.equal(result.source, "github-issue");
    assert.equal(result.externalId, "42");
    assert.equal(result.status, "pending");
    assert.equal(result.dedupeKey, "github-issue:42");

    const candidates = await listCandidates(tmpDir);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].projectId, "my-project");
  });

  it("ingestEvent deduplicates by source+externalId", async () => {
    const { ingestEvent } = await import("../server/services/event-source.js");

    const first = await ingestEvent(tmpDir, {
      source: "test-dedup",
      externalId: "dup-1",
    });
    assert.equal(first.status, "pending");

    const second = await ingestEvent(tmpDir, {
      source: "test-dedup",
      externalId: "dup-1",
    });
    assert.equal(second.status, "duplicate");
  });

  it("ingestEvent rejects missing required fields", async () => {
    const { ingestEvent } = await import("../server/services/event-source.js");
    await assert.rejects(
      () => ingestEvent(tmpDir, { source: "test" }),
      /source and externalId/
    );
  });

  it("listCandidates filters by status", async () => {
    const { ingestEvent, listCandidates, updateCandidate } = await import("../server/services/event-source.js");

    await ingestEvent(tmpDir, {
      source: "filter-test",
      externalId: "s1",
    });

    const pending = await listCandidates(tmpDir, { status: "pending" });
    const processed = await listCandidates(tmpDir, { status: "processed" });
    assert.ok(pending.some((e) => e.source === "filter-test"));
    assert.ok(!processed.some((e) => e.source === "filter-test"));
  });

  it("updateCandidate changes status", async () => {
    const { ingestEvent, updateCandidate } = await import("../server/services/event-source.js");

    const created = await ingestEvent(tmpDir, {
      source: "update-test",
      externalId: "u1",
    });

    const updated = await updateCandidate(tmpDir, created.id, {
      status: "processed",
      reason: "created job",
    });

    assert.equal(updated.status, "processed");
    assert.equal(updated.statusReason, "created job");
  });

  it("updateCandidate returns null for unknown id", async () => {
    const { updateCandidate } = await import("../server/services/event-source.js");
    const result = await updateCandidate(tmpDir, "nonexistent", { status: "processed" });
    assert.equal(result, null);
  });

  it("githubIssueToCandidate normalizes issue", async () => {
    const { githubIssueToCandidate } = await import("../server/services/event-source.js");
    const candidate = githubIssueToCandidate({
      number: 99,
      title: "Fix crash",
      body: "App crashes on start",
      labels: ["bug", "P0-critical"],
      url: "https://github.com/org/repo/issues/99",
      state: "OPEN",
    }, { projectId: "my-proj" });

    assert.equal(candidate.source, "github-issue");
    assert.equal(candidate.externalId, "99");
    assert.equal(candidate.priority, "high");
    assert.equal(candidate.payload.title, "Fix crash");
    assert.deepEqual(candidate.payload.labels, ["bug", "P0-critical"]);
  });

  it("githubIssueToCandidate defaults to normal priority", async () => {
    const { githubIssueToCandidate } = await import("../server/services/event-source.js");
    const candidate = githubIssueToCandidate({
      number: 100,
      title: "Minor docs update",
      labels: ["docs"],
    });
    assert.equal(candidate.priority, "normal");
  });

  it("ciFailureToCandidate normalizes failure", async () => {
    const { ciFailureToCandidate } = await import("../server/services/event-source.js");
    const candidate = ciFailureToCandidate({
      runId: "run-123",
      workflow: "CI",
      branch: "main",
      message: "Tests failed",
    }, { projectId: "my-proj" });

    assert.equal(candidate.source, "ci-failure");
    assert.equal(candidate.externalId, "run-123");
    assert.equal(candidate.priority, "high");
    assert.equal(candidate.payload.workflow, "CI");
  });

  it("listCandidates returns empty for no queue file", async () => {
    const { listCandidates } = await import("../server/services/event-source.js");
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "cpb-empty-"));
    const result = await listCandidates(emptyDir);
    assert.deepEqual(result, []);
    await rm(emptyDir, { recursive: true });
  });
});

describe("task-brain", () => {
  it("classifyCategory identifies documentation", async () => {
    const { classifyCategory } = await import("../server/services/task-brain.js");
    assert.equal(classifyCategory({ title: "Fix typo in README", body: "" }), "documentation");
  });

  it("classifyCategory identifies test-fix", async () => {
    const { classifyCategory } = await import("../server/services/task-brain.js");
    assert.equal(classifyCategory({ title: "Fix flaky test in auth", body: "" }), "test-fix");
  });

  it("classifyCategory identifies lint-fix", async () => {
    const { classifyCategory } = await import("../server/services/task-brain.js");
    assert.equal(classifyCategory({ title: "ESLint errors in utils", body: "" }), "lint-fix");
  });

  it("classifyCategory identifies ci-diagnosis", async () => {
    const { classifyCategory } = await import("../server/services/task-brain.js");
    assert.equal(classifyCategory({ title: "CI build failure", body: "" }), "ci-diagnosis");
  });

  it("classifyCategory identifies risky categories", async () => {
    const { classifyCategory } = await import("../server/services/task-brain.js");
    assert.equal(classifyCategory({ title: "Delete deprecated files", body: "" }), "file-deletion");
    assert.equal(classifyCategory({ title: "Force push to fix history", body: "" }), "force-push");
    assert.equal(classifyCategory({ title: "Release v2.0", body: "" }), "release");
  });

  it("classifyCategory returns general for unknown", async () => {
    const { classifyCategory } = await import("../server/services/task-brain.js");
    assert.equal(classifyCategory({ title: "Something random", body: "" }), "general");
  });

  it("isSafeAuto returns true for safe categories", async () => {
    const { isSafeAuto, SAFE_AUTO_CATEGORIES } = await import("../server/services/task-brain.js");
    for (const cat of SAFE_AUTO_CATEGORIES) {
      assert.equal(isSafeAuto(cat), true, `${cat} should be safe-auto`);
    }
    assert.equal(isSafeAuto("general"), false);
    assert.equal(isSafeAuto("file-deletion"), false);
  });

  it("isRisky returns true for risky categories", async () => {
    const { isRisky, RISKY_CATEGORIES } = await import("../server/services/task-brain.js");
    for (const cat of RISKY_CATEGORIES) {
      assert.equal(isRisky(cat), true, `${cat} should be risky`);
    }
    assert.equal(isRisky("documentation"), false);
  });

  it("evaluateCandidate produces recommendation", async () => {
    const { evaluateCandidate } = await import("../server/services/task-brain.js");
    const result = await evaluateCandidate("/fake", {
      id: "test-1",
      source: "github-issue",
      payload: { title: "Fix typo in docs", body: "Minor spelling fix" },
    });

    assert.ok(result);
    assert.equal(result.recommendation.category, "documentation");
    assert.equal(result.recommendation.riskLevel, "low");
    assert.equal(result.recommendation.autoExecutable, true);
    assert.equal(result.recommendation.needsHumanApproval, false);
  });

  it("evaluateCandidate flags risky tasks", async () => {
    const { evaluateCandidate } = await import("../server/services/task-brain.js");
    const result = await evaluateCandidate("/fake", {
      id: "test-2",
      source: "github-issue",
      payload: { title: "Delete all legacy files", body: "" },
    });

    assert.ok(result);
    assert.equal(result.recommendation.category, "file-deletion");
    assert.equal(result.recommendation.riskLevel, "high");
    assert.equal(result.recommendation.autoExecutable, false);
    assert.equal(result.recommendation.needsHumanApproval, true);
  });

  it("evaluateCandidate returns null for empty candidate", async () => {
    const { evaluateCandidate } = await import("../server/services/task-brain.js");
    const result = await evaluateCandidate("/fake", null);
    assert.equal(result, null);
  });

  it("checkProactiveBudget rejects when CPB_PROACTIVE not set", async () => {
    const { checkProactiveBudget } = await import("../server/services/task-brain.js");
    const original = process.env.CPB_PROACTIVE;
    delete process.env.CPB_PROACTIVE;

    const result = await checkProactiveBudget("/fake");
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("disabled"));

    if (original !== undefined) process.env.CPB_PROACTIVE = original;
  });
});
