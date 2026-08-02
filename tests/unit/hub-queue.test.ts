import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  priorityScore,
  isMutatingEntry,
  isActiveEntry,
  clearClaim,
  isLocalCodeIndexUnavailableStatus,
  validateIssueLink,
  recoverStaleInProgress,
  recoverLocalCodeIndexUnavailable,
  summarizeFailedTargets,
  buildProjectQueueStatus,
  matchAutomationRule,
  isExcluded,
} from "../../server/services/hub/hub-queue.js";

// --- priorityScore ---

describe("priorityScore", () => {
  test("P0 returns 0", () => {
    assert.equal(priorityScore("P0"), 0);
  });

  test("P1 returns 1", () => {
    assert.equal(priorityScore("P1"), 1);
  });

  test("P2 returns 2", () => {
    assert.equal(priorityScore("P2"), 2);
  });

  test("other returns 3", () => {
    assert.equal(priorityScore("P3"), 3);
    assert.equal(priorityScore("low"), 3);
    assert.equal(priorityScore(""), 3);
  });
});

// --- isMutatingEntry ---

describe("isMutatingEntry", () => {
  test("returns true when mutating is undefined", () => {
    assert.equal(isMutatingEntry({}), true);
  });

  test("returns true when mutating is true", () => {
    assert.equal(isMutatingEntry({ metadata: { mutating: true } }), true);
  });

  test("returns false when mutating is false", () => {
    assert.equal(isMutatingEntry({ metadata: { mutating: false } }), false);
  });
});

// --- isActiveEntry ---

describe("isActiveEntry", () => {
  test("returns true for in_progress", () => {
    assert.equal(isActiveEntry({ status: "in_progress" }), true);
  });

  test("returns true for scheduled", () => {
    assert.equal(isActiveEntry({ status: "scheduled" }), true);
  });

  test("returns false for pending", () => {
    assert.equal(isActiveEntry({ status: "pending" }), false);
  });

  test("returns false for completed", () => {
    assert.equal(isActiveEntry({ status: "completed" }), false);
  });

  test("returns false for failed", () => {
    assert.equal(isActiveEntry({ status: "failed" }), false);
  });
});

// --- clearClaim ---

describe("clearClaim", () => {
  test("clears claim fields", () => {
    const entry = { claimedBy: "worker-1", claimedAt: "2025-01-01", workerId: "w-1" };
    clearClaim(entry);
    assert.equal(entry.claimedBy, null);
    assert.equal(entry.claimedAt, null);
    assert.equal(entry.workerId, null);
  });
});

// --- isLocalCodeIndexUnavailableStatus ---

describe("isLocalCodeIndexUnavailableStatus", () => {
  test("returns true for local_code_index_unavailable", () => {
    assert.equal(isLocalCodeIndexUnavailableStatus("local_code_index_unavailable"), true);
  });

  test("returns false for other statuses", () => {
    assert.equal(isLocalCodeIndexUnavailableStatus("pending"), false);
    assert.equal(isLocalCodeIndexUnavailableStatus("failed"), false);
  });
});

// --- validateIssueLink ---

describe("validateIssueLink", () => {
  test("returns linked=false for null entry", () => {
    const result = validateIssueLink(null);
    assert.equal(result.linked, false);
    assert.equal(result.reason, "no entry");
  });

  test("returns linked=false for needs_issue_link status", () => {
    const result = validateIssueLink({ status: "needs_issue_link" });
    assert.equal(result.linked, false);
    assert.equal(result.reason, "awaiting issue link");
  });

  test("returns linked=false for archived status", () => {
    const result = validateIssueLink({ status: "archived" });
    assert.equal(result.linked, false);
    assert.equal(result.reason, "archived");
  });

  test("returns linked=true when issueNumber present", () => {
    const result = validateIssueLink({ status: "pending", metadata: { issueNumber: 42 } });
    assert.equal(result.linked, true);
    assert.equal(result.reason, null);
  });

  test("returns linked=true when issueUrl present", () => {
    const result = validateIssueLink({ status: "pending", metadata: { issueUrl: "https://github.com/owner/repo/issues/1" } });
    assert.equal(result.linked, true);
    assert.equal(result.reason, null);
  });

  test("returns linked=false when no issue link in metadata", () => {
    const result = validateIssueLink({ status: "pending", metadata: {} });
    assert.equal(result.linked, false);
    assert.equal(result.reason, null);
  });
});

// --- recoverStaleInProgress ---

describe("recoverStaleInProgress", () => {
  test("recovers stale in_progress entry with no active assignment", () => {
    const entries = [
      { id: "e1", status: "in_progress", claimedBy: "w1", claimedAt: new Date(0).toISOString(), workerId: "w1", updatedAt: "" },
    ];
    const assignmentStore = { getAssignmentSync: () => null };
    const result = recoverStaleInProgress(entries, { claimTimeoutMs: 60000, assignmentStore, nowMs: 120000 });
    assert.deepEqual(result.recovered, ["e1"]);
    assert.deepEqual(result.refreshed, []);
    assert.equal(entries[0].status, "pending");
    assert.equal(entries[0].claimedBy, null);
  });

  test("refreshes stale entry with active assignment", () => {
    const entries = [
      { id: "e1", status: "in_progress", claimedBy: "w1", claimedAt: new Date(0).toISOString(), workerId: "w1", updatedAt: "" },
    ];
    const assignmentStore = { getAssignmentSync: () => ({ status: "running" }) };
    const result = recoverStaleInProgress(entries, { claimTimeoutMs: 60000, assignmentStore, nowMs: 120000 });
    assert.deepEqual(result.recovered, []);
    assert.deepEqual(result.refreshed, ["e1"]);
    assert.equal(entries[0].status, "in_progress");
  });

  test("ignores fresh entries", () => {
    const entries = [
      { id: "e1", status: "in_progress", claimedBy: "w1", claimedAt: new Date(100000).toISOString(), workerId: "w1", updatedAt: "" },
    ];
    const assignmentStore = { getAssignmentSync: () => null };
    const result = recoverStaleInProgress(entries, { claimTimeoutMs: 60000, assignmentStore, nowMs: 120000 });
    assert.deepEqual(result.recovered, []);
    assert.deepEqual(result.refreshed, []);
  });

  test("ignores pending entries", () => {
    const entries = [
      { id: "e1", status: "pending", claimedBy: null, claimedAt: null, workerId: null, updatedAt: "" },
    ];
    const assignmentStore = { getAssignmentSync: () => null };
    const result = recoverStaleInProgress(entries, { claimTimeoutMs: 60000, assignmentStore, nowMs: 120000 });
    assert.deepEqual(result.recovered, []);
    assert.deepEqual(result.refreshed, []);
  });

  test("returns empty when claimTimeoutMs is 0", () => {
    const entries = [
      { id: "e1", status: "in_progress", claimedBy: "w1", claimedAt: new Date(0).toISOString(), workerId: "w1", updatedAt: "" },
    ];
    const result = recoverStaleInProgress(entries, { claimTimeoutMs: 0, assignmentStore: null, nowMs: 120000 });
    assert.deepEqual(result.recovered, []);
    assert.deepEqual(result.refreshed, []);
  });

  test("throws when assignmentStore is missing", () => {
    const entries = [
      { id: "e1", status: "in_progress", claimedBy: "w1", claimedAt: new Date(0).toISOString(), workerId: "w1", updatedAt: "" },
    ];
    assert.throws(() => recoverStaleInProgress(entries, { claimTimeoutMs: 60000, assignmentStore: null, nowMs: 120000 }), /assignmentStore/);
  });
});

// --- summarizeFailedTargets ---

describe("summarizeFailedTargets", () => {
  test("counts failed entries", () => {
    const entries = [
      { projectId: "p1", status: "failed", type: "candidate", metadata: {} },
      { projectId: "p1", status: "failed", type: "candidate", metadata: {} },
      { projectId: "p1", status: "completed", type: "candidate", metadata: {} },
    ];
    const result = summarizeFailedTargets(entries);
    assert.equal(result.failedEntries, 2);
  });

  test("returns zeros for empty array", () => {
    const result = summarizeFailedTargets([]);
    assert.equal(result.failedEntries, 0);
    assert.equal(result.failedTargets, 0);
    assert.equal(result.retryingFailedTargets, 0);
    assert.equal(result.retriedFailedTargets, 0);
    assert.equal(result.unretriedFailedTargets, 0);
  });
});

// --- buildProjectQueueStatus ---

describe("buildProjectQueueStatus", () => {
  test("counts entries by status per project", () => {
    const entries = [
      { projectId: "p1", status: "pending", metadata: {} },
      { projectId: "p1", status: "in_progress", metadata: { mutating: true } },
      { projectId: "p2", status: "failed", metadata: {} },
    ];
    const result = buildProjectQueueStatus(entries);
    assert.equal(result["p1"].pending, 1);
    assert.equal(result["p1"].inProgress, 1);
    assert.equal(result["p2"].failed, 1);
  });

  test("returns empty map for empty entries", () => {
    const result = buildProjectQueueStatus([]);
    assert.deepEqual(result, {});
  });
});

// --- matchAutomationRule ---

describe("matchAutomationRule", () => {
  test("matches on labels", () => {
    const issue = { labels: ["bug", "urgent"] };
    const rules = [{ name: "bug-rule", match: { labels: ["bug"] } }];
    const result = matchAutomationRule(issue, rules);
    assert.equal(result?.name, "bug-rule");
  });

  test("matches on title pattern", () => {
    const issue = { title: "Fix login bug" };
    const rules = [{ name: "bug-rule", match: { titlePattern: "fix.*bug" } }];
    const result = matchAutomationRule(issue, rules);
    assert.equal(result?.name, "bug-rule");
  });

  test("returns null when no rules match", () => {
    const issue = { labels: ["feature"], title: "Add feature" };
    const rules = [{ name: "bug-rule", match: { labels: ["bug"] } }];
    const result = matchAutomationRule(issue, rules);
    assert.equal(result, null);
  });

  test("returns null for empty rules", () => {
    const issue = { labels: ["bug"] };
    assert.equal(matchAutomationRule(issue, []), null);
    assert.equal(matchAutomationRule(issue, null as any), null);
  });

  test("skips invalid regex patterns", () => {
    const issue = { title: "test" };
    const rules = [{ name: "bad-regex", match: { titlePattern: "[invalid" } }];
    const result = matchAutomationRule(issue, rules);
    assert.equal(result, null);
  });

  test("requires all labels to match", () => {
    const issue = { labels: ["bug"] };
    const rules = [{ name: "strict", match: { labels: ["bug", "urgent"] } }];
    const result = matchAutomationRule(issue, rules);
    assert.equal(result, null);
  });
});

// --- isExcluded ---

describe("isExcluded", () => {
  test("returns true when issue has excluded label", () => {
    const issue = { labels: ["wontfix", "bug"] };
    const exclude = { labels: ["wontfix"] };
    assert.equal(isExcluded(issue, exclude), true);
  });

  test("returns false when issue has no excluded labels", () => {
    const issue = { labels: ["bug"] };
    const exclude = { labels: ["wontfix"] };
    assert.equal(isExcluded(issue, exclude), false);
  });

  test("returns false when exclude is null", () => {
    const issue = { labels: ["bug"] };
    assert.equal(isExcluded(issue, null), false);
  });

  test("returns false when exclude has no labels", () => {
    const issue = { labels: ["bug"] };
    assert.equal(isExcluded(issue, {}), false);
  });
});

// --- recoverLocalCodeIndexUnavailable ---

describe("recoverLocalCodeIndexUnavailable", () => {
  test("recovers entries older than retryMs", () => {
    const entries = [
      { id: "e1", status: "local_code_index_unavailable", updatedAt: new Date(0).toISOString(), metadata: { indexFreshness: { available: false } } },
    ];
    const result = recoverLocalCodeIndexUnavailable(entries, 60000, 120000);
    assert.deepEqual(result.recovered, ["e1"]);
    assert.equal(entries[0].status, "pending");
    // indexFreshness is deleted by the recovery function
    assert.equal((entries[0].metadata as any)?.indexFreshness, undefined);
  });

  test("skips entries within retry window", () => {
    const entries = [
      { id: "e1", status: "local_code_index_unavailable", updatedAt: new Date(100000).toISOString(), metadata: {} },
    ];
    const result = recoverLocalCodeIndexUnavailable(entries, 60000, 120000);
    assert.deepEqual(result.recovered, []);
    assert.equal(entries[0].status, "local_code_index_unavailable");
  });

  test("skips entries with non-unavailable status", () => {
    const entries = [
      { id: "e1", status: "pending", updatedAt: new Date(0).toISOString(), metadata: {} },
    ];
    const result = recoverLocalCodeIndexUnavailable(entries, 60000, 120000);
    assert.deepEqual(result.recovered, []);
  });

  test("returns empty when retryMs is 0", () => {
    const entries = [
      { id: "e1", status: "local_code_index_unavailable", updatedAt: new Date(0).toISOString(), metadata: {} },
    ];
    const result = recoverLocalCodeIndexUnavailable(entries, 0);
    assert.deepEqual(result.recovered, []);
  });

  test("skips entries with invalid updatedAt", () => {
    const entries = [
      { id: "e1", status: "local_code_index_unavailable", updatedAt: "not-a-date", metadata: {} },
    ];
    const result = recoverLocalCodeIndexUnavailable(entries, 60000, 120000);
    assert.deepEqual(result.recovered, []);
  });

  test("recovers entries with no updatedAt (treated as epoch)", () => {
    const entries = [
      { id: "e1", status: "local_code_index_unavailable", metadata: {} },
    ];
    const result = recoverLocalCodeIndexUnavailable(entries, 60000, 120000);
    // updatedAt defaults to 0 (epoch), which passes the retry window
    assert.deepEqual(result.recovered, ["e1"]);
  });
});
