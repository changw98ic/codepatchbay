/**
 * GitHub adapter tests.
 *
 * Tests the GitHub adapter implementation.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { GitHubAdapter } from "../../server/platform/github-adapter.js";

describe("GitHub adapter", () => {
  let adapter;
  let mockRunCommand;

  beforeEach(() => {
    mockRunCommand = mock.fn(async () => ({ stdout: "", stderr: "" }));
    adapter = new GitHubAdapter({ runCommand: mockRunCommand });
  });

  describe("constructor", () => {
    it("sets name to github", () => {
      assert.strictEqual(adapter.name, "github");
    });

    it("accepts custom runCommand", () => {
      const customFn = async () => ({});
      const customAdapter = new GitHubAdapter({ runCommand: customFn });
      assert.strictEqual(customAdapter.runCommand, customFn);
    });
  });

  describe("postComment", () => {
    it("calls gh issue comment", async () => {
      mockRunCommand.mock.mockImplementationOnce(async () => ({
        stdout: "https://github.com/owner/repo/issues/1#comment-123",
      }));

      const result = await adapter.postComment({
        repo: "owner/repo",
        issueNumber: 1,
        body: "test comment",
      });

      assert.strictEqual(result.url, "https://github.com/owner/repo/issues/1#comment-123");
    });

    it("returns null url if stdout has no url", async () => {
      mockRunCommand.mock.mockImplementationOnce(async () => ({
        stdout: "comment posted",
      }));

      const result = await adapter.postComment({
        repo: "owner/repo",
        issueNumber: 1,
        body: "test comment",
      });

      assert.strictEqual(result.url, null);
      assert.strictEqual(result.id, null);
    });
  });

  describe("createPullRequest", () => {
    it("calls gh pr create", async () => {
      mockRunCommand.mock.mockImplementationOnce(async () => ({
        stdout: "https://github.com/owner/repo/pull/123",
        stderr: "",
      }));

      const result = await adapter.createPullRequest({
        repo: "owner/repo",
        title: "test pr",
        body: "pr body",
        head: "feature",
        base: "main",
        draft: true,
      });

      assert.strictEqual(result.url, "https://github.com/owner/repo/pull/123");
      assert.strictEqual(result.html_url, "https://github.com/owner/repo/pull/123");
      assert.strictEqual(result.number, 123);
    });
  });

  describe("getIssue", () => {
    it("calls gh issue view with json output", async () => {
      const mockIssue = {
        number: 42,
        title: "Test issue",
        state: "OPEN",
        body: "Issue body",
        url: "https://github.com/owner/repo/issues/42",
        labels: [{ name: "bug" }, { name: "high-priority" }],
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
      };

      mockRunCommand.mock.mockImplementationOnce(async () => ({
        stdout: JSON.stringify(mockIssue),
      }));

      const result = await adapter.getIssue({
        repo: "owner/repo",
        issueNumber: 42,
      });

      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Test issue");
      assert.strictEqual(result.state, "OPEN");
      assert.strictEqual(result.body, "Issue body");
      assert.deepStrictEqual(result.labels, ["bug", "high-priority"]);
    });
  });

  describe("listChangedFiles", () => {
    it("calls gh pr diff with name-status", async () => {
      mockRunCommand.mock.mockImplementationOnce(async () => ({
        stdout: "M\tpath/to/file.js\nA\tnewfile.ts\nD\tdeleted.js",
      }));

      const result = await adapter.listChangedFiles({
        repo: "owner/repo",
        prNumber: 10,
      });

      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].path, "path/to/file.js");
      assert.strictEqual(result[0].status, "M");
      assert.strictEqual(result[1].path, "newfile.ts");
      assert.strictEqual(result[1].status, "A");
      assert.strictEqual(result[2].path, "deleted.js");
      assert.strictEqual(result[2].status, "D");
    });

    it("handles lines without tabs gracefully", async () => {
      mockRunCommand.mock.mockImplementationOnce(async () => ({
        stdout: "M path/to/file.js",
      }));

      const result = await adapter.listChangedFiles({
        repo: "owner/repo",
        prNumber: 10,
      });

      // When line has no tab, the entire line is treated as path
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, "M path/to/file.js");
      // status defaults to "modified" when no tab found
      assert.strictEqual(result[0].status, "modified");
    });
  });

  describe("closeIssue", () => {
    it("calls gh issue close", async () => {
      mockRunCommand.mock.mockImplementationOnce(async () => ({
        stdout: "",
      }));

      const result = await adapter.closeIssue({
        repo: "owner/repo",
        number: 42,
        body: "Closing as resolved",
      });

      assert.strictEqual(result.url, "https://github.com/owner/repo/issues/42");
      assert.strictEqual(result.html_url, "https://github.com/owner/repo/issues/42");
      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.state, "closed");
    });
  });

  describe("verifyWebhook", () => {
    it("returns false for missing signature", async () => {
      const result = await adapter.verifyWebhook({
        signature: null,
        payload: "test",
        secret: "secret",
      });
      assert.strictEqual(result, false);
    });

    it("returns false for missing payload", async () => {
      const result = await adapter.verifyWebhook({
        signature: "sha256=abc",
        payload: null,
        secret: "secret",
      });
      assert.strictEqual(result, false);
    });

    it("returns false for missing secret", async () => {
      const result = await adapter.verifyWebhook({
        signature: "sha256=abc",
        payload: "test",
        secret: null,
      });
      assert.strictEqual(result, false);
    });

    it("returns false for invalid signature prefix", async () => {
      const result = await adapter.verifyWebhook({
        signature: "invalid=value",
        payload: "test",
        secret: "secret",
      });
      assert.strictEqual(result, false);
    });

    it("verifies valid HMAC-SHA256 signature", async () => {
      const { createHmac } = await import("node:crypto");
      const payload = "test payload";
      const secret = "webhook-secret";
      const hmac = createHmac("sha256", secret);
      hmac.update(payload);
      const signature = `sha256=${hmac.digest("hex")}`;

      const result = await adapter.verifyWebhook({
        signature,
        payload,
        secret,
      });
      assert.strictEqual(result, true);
    });

    it("rejects invalid signature", async () => {
      const result = await adapter.verifyWebhook({
        signature: "sha256=invalidhexdigest",
        payload: "test",
        secret: "secret",
      });
      assert.strictEqual(result, false);
    });
  });

  describe("getBranch", () => {
    it("calls gh api for branch info", async () => {
      mockRunCommand.mock.mockImplementationOnce(async () => ({
        stdout: JSON.stringify({
          name: "main",
          commit: { sha: "abc123def456" },
          protected: true,
        }),
      }));

      const result = await adapter.getBranch({
        repo: "owner/repo",
        branch: "main",
      });

      assert.strictEqual(result.name, "main");
      assert.strictEqual(result.commit, "abc123def456");
      assert.strictEqual(result.protected, true);
    });
  });

  describe("healthCheck", () => {
    it("returns healthy when gh is available", async () => {
      mockRunCommand.mock.mockImplementationOnce(async () => ({
        stdout: "gh version 2.0.0",
      }));

      const result = await adapter.healthCheck();

      assert.strictEqual(result.healthy, true);
      assert.strictEqual(result.diagnostics.length, 1);
      assert.strictEqual(result.diagnostics[0].level, "info");
      assert.strictEqual(result.diagnostics[0].message, "gh CLI is available");
    });

    it("returns unhealthy when gh is not available", async () => {
      mockRunCommand.mock.mockImplementationOnce(async () => {
        throw new Error("command not found");
      });

      const result = await adapter.healthCheck();

      assert.strictEqual(result.healthy, false);
      assert.strictEqual(result.diagnostics.length, 1);
      assert.strictEqual(result.diagnostics[0].level, "error");
      assert.strictEqual(result.diagnostics[0].message, "gh CLI not available");
    });
  });
});
