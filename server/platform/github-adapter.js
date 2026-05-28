/**
 * GitHub platform adapter implementation.
 *
 * Implements GitPlatform interface for GitHub using existing github-* services.
 */

import { GitPlatform, RateLimitError } from "./git-platform.js";
import {
  postGithubCommentWithGh,
} from "../services/github-comments.js";
import {
  closeGithubIssueWithGh as closeWithGh,
  normalizeGithubIssue,
} from "../services/github-issues.js";
import {
  createPullRequestWithGh,
} from "../services/github-pr.js";

/**
 * GitHub adapter implementation.
 *
 * Uses gh CLI for all operations. Falls back gracefully if gh is unavailable.
 */
export class GitHubAdapter extends GitPlatform {
  name = "github";

  /**
   * Create a new GitHub adapter.
   *
   * @param {Object} options
   * @param {Function} [options.runCommand] - Custom command runner (for testing)
   */
  constructor({ runCommand } = {}) {
    super();
    this.runCommand = runCommand;
  }

  /**
   * Post a comment to an issue or pull request.
   */
  async postComment({ repo, issueNumber, body }) {
    try {
      const result = await postGithubCommentWithGh({ repo, issueNumber, body }, { runCommand: this.runCommand });
      return {
        url: result.stdout?.match(/https:\/\/github\.com\/[^\s]+/)?.[0] || null,
        id: null,
      };
    } catch (error) {
      throw this._wrapError(error, "postComment");
    }
  }

  /**
   * Create a pull request.
   */
  async createPullRequest({ repo, title, body, head, base, draft = true }) {
    try {
      const result = await createPullRequestWithGh(
        { repo, title, body, head, base, draft },
        { runCommand: this.runCommand }
      );
      return {
        url: result.url || null,
        html_url: result.url || null,
        number: result.number || null,
      };
    } catch (error) {
      throw this._wrapError(error, "createPullRequest");
    }
  }

  /**
   * Get an issue by number.
   */
  async getIssue({ repo, issueNumber }) {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const runCommand = this.runCommand || promisify(execFile);

      const result = await runCommand("gh", [
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repo,
        "--json",
        "number,title,state,body,url,labels,createdAt,updatedAt",
      ], { maxBuffer: 1024 * 1024 });

      const issue = JSON.parse(result.stdout);
      return normalizeGithubIssue(issue, { repo });
    } catch (error) {
      throw this._wrapError(error, "getIssue");
    }
  }

  /**
   * List changed files in a pull request.
   */
  async listChangedFiles({ repo, prNumber }) {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const runCommand = this.runCommand || promisify(execFile);

      const result = await runCommand("gh", [
        "pr",
        "diff",
        String(prNumber),
        "--repo",
        repo,
        "--name-status",
      ], { maxBuffer: 1024 * 1024 });

      const lines = result.stdout?.trim().split("\n") || [];
      const validStatuses = new Set(["A", "C", "D", "M", "R", "T", "U", "X"]);

      return lines.map((line) => {
        const parts = line.split("\t");
        const status = parts[0];
        const path = parts[1] || line;

        // Validate status - use "modified" as default for malformed output
        const normalizedStatus = (status && status.length === 1 && validStatuses.has(status))
          ? status
          : "modified";

        return {
          path,
          status: normalizedStatus,
          additions: 0,
          deletions: 0,
        };
      }).filter((f) => f.path);
    } catch (error) {
      throw this._wrapError(error, "listChangedFiles");
    }
  }

  /**
   * Close an issue.
   */
  async closeIssue({ repo, number, body }) {
    try {
      await closeWithGh({ repo, number, body }, { runCommand: this.runCommand });
      return {
        url: `https://github.com/${repo}/issues/${number}`,
        html_url: `https://github.com/${repo}/issues/${number}`,
        number,
        state: "closed",
      };
    } catch (error) {
      throw this._wrapError(error, "closeIssue");
    }
  }

  /**
   * Verify a webhook signature.
   *
   * GitHub uses HMAC-SHA1 with X-Hub-Signature-256 header.
   */
  async verifyWebhook({ signature, payload, secret }) {
    if (!signature || !payload || !secret) return false;

    try {
      const { createHmac } = await import("node:crypto");
      const expectedPrefix = "sha256=";
      if (!signature.startsWith(expectedPrefix)) return false;

      const hmac = createHmac("sha256", secret);
      hmac.update(payload);
      const expected = `${expectedPrefix}${hmac.digest("hex")}`;
      return signature === expected;
    } catch {
      return false;
    }
  }

  /**
   * Get branch information.
   */
  async getBranch({ repo, branch }) {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const runCommand = this.runCommand || promisify(execFile);

      const result = await runCommand("gh", [
        "api",
        `/repos/${repo}/branches/${branch}`,
      ], { maxBuffer: 1024 * 1024 });

      const info = JSON.parse(result.stdout);
      return {
        name: info.name || branch,
        commit: info.commit?.sha || null,
        protected: info.protected || false,
      };
    } catch (error) {
      throw this._wrapError(error, "getBranch");
    }
  }

  /**
   * Check if the adapter is properly configured and ready.
   */
  async healthCheck() {
    const diagnostics = [];
    let healthy = true;

    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const runCommand = this.runCommand || promisify(execFile);

      await runCommand("gh", ["--version"], { timeout: 5000 });
      diagnostics.push({ level: "info", message: "gh CLI is available" });
    } catch {
      healthy = false;
      diagnostics.push({ level: "error", message: "gh CLI not available" });
    }

    return { healthy, diagnostics };
  }

  /**
   * Wrap an error with platform context.
   */
  _wrapError(error, operation) {
    const message = error?.message || String(error);
    const stderr = error?.stderr || "";

    // Detect rate limiting
    if (stderr.includes("rate limit") || message.includes("rate limit")) {
      return new RateLimitError(`GitHub rate limit exceeded during ${operation}`, "github", {
        resetAt: null,
      });
    }

    return error;
  }
}
