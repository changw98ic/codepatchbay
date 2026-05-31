import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildRunComment,
  addGithubLabels,
  removeGithubLabel,
  postGithubRunComment,
} from "../server/services/github-comments.js";
import {
  addGithubLabelsWithApi,
  removeGithubLabelWithApi,
  updateGithubPrBodyWithApi,
} from "../server/services/github-api.js";
import { updateGithubPrBodyWithGh } from "../server/services/github-pr.js";
import { buildCodePatchBayPrBody } from "../server/services/pr-body.js";

// --- buildRunComment ---

describe("buildRunComment", () => {
  it("builds a phase progress comment with defaults", () => {
    const body = buildRunComment({ phase: "execute", status: "completed" });
    assert.match(body, /⚡/);
    assert.match(body, /Executing/);
    assert.match(body, /done/);
  });

  it("includes artifact path when provided", () => {
    const body = buildRunComment({
      phase: "plan",
      status: "completed",
      details: { artifactPath: "wiki/plan-001.md" },
    });
    assert.match(body, /wiki\/plan-001\.md/);
  });

  it("includes duration when provided", () => {
    const body = buildRunComment({
      phase: "execute",
      status: "completed",
      details: { durationMs: 45000 },
    });
    assert.match(body, /45s/);
  });

  it("includes retry count when > 0", () => {
    const body = buildRunComment({
      phase: "verify",
      status: "completed",
      details: { retryCount: 2 },
    });
    assert.match(body, /Retries: 2/);
  });

  it("includes changed files", () => {
    const body = buildRunComment({
      phase: "execute",
      status: "completed",
      details: { changedFiles: ["src/index.js", "src/utils.js"] },
    });
    assert.match(body, /src\/index\.js/);
    assert.match(body, /src\/utils\.js/);
  });

  it("truncates changed files when > 10", () => {
    const files = Array.from({ length: 15 }, (_, i) => `file-${i}.js`);
    const body = buildRunComment({
      phase: "execute",
      status: "completed",
      details: { changedFiles: files },
    });
    assert.match(body, /\+5 more/);
  });

  it("includes failure reason", () => {
    const body = buildRunComment({
      phase: "verify",
      status: "failed",
      details: { reason: "test assertion failed" },
    });
    assert.match(body, /test assertion failed/);
  });

  it("includes summary text", () => {
    const body = buildRunComment({
      phase: "execute",
      status: "completed",
      details: { summary: "All tests passed" },
    });
    assert.match(body, /All tests passed/);
  });

  it("uses jobId from details when job has none", () => {
    const body = buildRunComment({
      job: {},
      phase: "plan",
      status: "in progress",
      details: { jobId: "job-123" },
    });
    assert.match(body, /job-123/);
  });
});

// --- addGithubLabels / removeGithubLabel (mocked transport) ---

describe("addGithubLabels (with mock transport)", () => {
  it("skips when labels array is empty", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-writeback-test-"));
    try {
      const result = await addGithubLabels({
        cpbRoot, project: "test", jobId: "job-1",
        repo: "org/repo", issueNumber: 1,
        labels: [],
        addLabels: async () => ({ added: [] }),
      });
      assert.equal(result.status, "skipped");
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("returns dry-run status when dryRun is true", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-writeback-test-"));
    try {
      const result = await addGithubLabels({
        cpbRoot, project: "test", jobId: "job-1",
        repo: "org/repo", issueNumber: 1,
        labels: ["cpb-done"],
        addLabels: async () => ({ added: ["cpb-done"] }),
        dryRun: true,
      });
      assert.equal(result.status, "dry-run");
      assert.deepEqual(result.added, ["cpb-done"]);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("calls addLabels transport and returns result", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-writeback-test-"));
    try {
      const calls = [];
      const result = await addGithubLabels({
        cpbRoot, project: "test", jobId: "job-1",
        repo: "org/repo", issueNumber: 1,
        labels: ["cpb-done", "automated"],
        addLabels: async (req) => {
          calls.push(req);
          return { added: req.labels };
        },
      });
      assert.equal(result.status, "posted");
      assert.deepEqual(result.added, ["cpb-done", "automated"]);
      assert.equal(calls[0].repo, "org/repo");
      assert.equal(calls[0].issueNumber, 1);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("returns failed status when transport throws", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-writeback-test-"));
    try {
      const result = await addGithubLabels({
        cpbRoot, project: "test", jobId: "job-1",
        repo: "org/repo", issueNumber: 1,
        labels: ["cpb-done"],
        addLabels: async () => { throw new Error("API error"); },
      });
      assert.equal(result.status, "failed");
      assert.match(result.error.message, /API error/);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("writes audit event on success", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-writeback-test-"));
    try {
      await addGithubLabels({
        cpbRoot, project: "test", jobId: "job-1",
        repo: "org/repo", issueNumber: 1,
        labels: ["cpb-done"],
        addLabels: async (req) => ({ added: req.labels }),
      });
      const { readEvents } = await import("../server/services/event-store.js");
      const events = await readEvents(cpbRoot, "test", "job-1");
      const labelEvents = events.filter((e) => e.type === "github_labels_added");
      assert.equal(labelEvents.length, 1);
      assert.deepEqual(labelEvents[0].labels, ["cpb-done"]);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("removeGithubLabel (with mock transport)", () => {
  it("skips when label is null", async () => {
    const result = await removeGithubLabel({
      label: null, removeLabel: async () => ({ removed: null }),
    });
    assert.equal(result.status, "skipped");
  });

  it("returns dry-run status when dryRun is true", async () => {
    const result = await removeGithubLabel({
      repo: "org/repo", issueNumber: 1, label: "cpb",
      removeLabel: async () => ({ removed: "cpb" }),
      dryRun: true,
    });
    assert.equal(result.status, "dry-run");
  });

  it("calls removeLabel transport", async () => {
    const calls = [];
    const result = await removeGithubLabel({
      repo: "org/repo", issueNumber: 1, label: "cpb",
      removeLabel: async (req) => {
        calls.push(req);
        return { removed: req.label };
      },
    });
    assert.equal(result.status, "posted");
    assert.equal(result.removed, "cpb");
    assert.equal(calls[0].label, "cpb");
  });
});

// --- postGithubRunComment (mocked transport) ---

describe("postGithubRunComment", () => {
  it("returns dry-run status when dryRun is true", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-run-comment-test-"));
    try {
      const result = await postGithubRunComment({
        cpbRoot, project: "test", jobId: "job-1",
        repo: "org/repo", issueNumber: 1,
        phase: "plan", status: "completed",
        postComment: async () => ({ id: 1 }),
        dryRun: true,
      });
      assert.equal(result.status, "dry-run");
      assert.ok(result.body);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("posts a run comment and writes audit event", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-run-comment-test-"));
    try {
      const posted = [];
      const result = await postGithubRunComment({
        cpbRoot, project: "test", jobId: "job-1",
        repo: "org/repo", issueNumber: 1,
        phase: "execute", status: "completed",
        details: { durationMs: 30000, retryCount: 1 },
        postComment: async (req) => {
          posted.push(req);
          return { id: 100, html_url: "https://github.com/org/repo/issues/1#issuecomment-100" };
        },
        transportMode: "api",
      });

      assert.equal(result.status, "posted");
      assert.equal(posted.length, 1);
      assert.match(posted[0].body, /⚡/);
      assert.match(posted[0].body, /30s/);
      assert.match(posted[0].body, /Retries: 1/);

      const { readEvents } = await import("../server/services/event-store.js");
      const events = await readEvents(cpbRoot, "test", "job-1");
      const commentEvents = events.filter((e) => e.type === "github_comment_posted" && e.commentKind === "run-progress");
      assert.equal(commentEvents.length, 1);
      assert.equal(commentEvents[0].phase, "execute");
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("returns failed status on transport error", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-run-comment-test-"));
    try {
      const result = await postGithubRunComment({
        cpbRoot, project: "test", jobId: "job-1",
        repo: "org/repo", issueNumber: 1,
        phase: "plan", status: "failed",
        postComment: async () => { throw new Error("transport down"); },
      });
      assert.equal(result.status, "failed");
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

// --- buildCodePatchBayPrBody with new sections ---

describe("buildCodePatchBayPrBody (enriched sections)", () => {
  it("includes changed files section", () => {
    const body = buildCodePatchBayPrBody({
      job: { jobId: "job-1", sourceContext: { issueNumber: 42, repo: "org/repo" } },
      routingContext: {
        routing: {},
        changedFiles: ["src/index.js", "src/utils.js", "tests/test.js"],
      },
    });
    assert.match(body, /## Changed Files/);
    assert.match(body, /src\/index\.js/);
    assert.match(body, /src\/utils\.js/);
  });

  it("truncates changed files when > 20", () => {
    const files = Array.from({ length: 25 }, (_, i) => `file-${i}.js`);
    const body = buildCodePatchBayPrBody({
      job: { jobId: "job-1", sourceContext: { issueNumber: 42, repo: "org/repo" } },
      routingContext: { routing: {}, changedFiles: files },
    });
    assert.match(body, /\+5 more/);
  });

  it("includes commit section", () => {
    const body = buildCodePatchBayPrBody({
      job: { jobId: "job-1", sourceContext: { issueNumber: 42, repo: "org/repo" } },
      routingContext: {
        routing: {},
        commit: { sha: "abc123", author: "bot", message: "fix login" },
      },
    });
    assert.match(body, /## Commit/);
    assert.match(body, /abc123/);
    assert.match(body, /fix login/);
  });

  it("includes run timeline section", () => {
    const body = buildCodePatchBayPrBody({
      job: { jobId: "job-1", sourceContext: { issueNumber: 42, repo: "org/repo" } },
      routingContext: {
        routing: {},
        runTimeline: [
          { phase: "plan", status: "completed", durationMs: 10000 },
          { phase: "execute", status: "completed", durationMs: 45000 },
          { phase: "verify", status: "completed", durationMs: 15000 },
        ],
      },
    });
    assert.match(body, /## Run Timeline/);
    assert.match(body, /\| plan \| completed \| 10s \|/);
    assert.match(body, /\| execute \| completed \| 45s \|/);
    assert.match(body, /\| verify \| completed \| 15s \|/);
  });

  it("omits new sections when no data provided", () => {
    const body = buildCodePatchBayPrBody({
      job: { jobId: "job-1", sourceContext: { issueNumber: 42, repo: "org/repo" } },
    });
    assert.doesNotMatch(body, /## Changed Files/);
    assert.doesNotMatch(body, /## Commit/);
    assert.doesNotMatch(body, /## Run Timeline/);
  });
});

// --- API transport functions exist and have correct signatures ---

describe("GitHub API transport functions", () => {
  it("exports addGithubLabelsWithApi", () => {
    assert.equal(typeof addGithubLabelsWithApi, "function");
  });

  it("exports removeGithubLabelWithApi", () => {
    assert.equal(typeof removeGithubLabelWithApi, "function");
  });

  it("exports updateGithubPrBodyWithApi", () => {
    assert.equal(typeof updateGithubPrBodyWithApi, "function");
  });

  it("exports updateGithubPrBodyWithGh", () => {
    assert.equal(typeof updateGithubPrBodyWithGh, "function");
  });
});
