/**
 * GitPlatform interface contract tests.
 *
 * Tests that the base interface defines the expected contract
 * and that errors work correctly.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  GitPlatform,
  GitPlatformError,
  NotImplementedError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
} from "../../server/platform/git-platform.js";

describe("GitPlatform interface", () => {
  describe("base class", () => {
    let platform;

    beforeEach(() => {
      platform = new GitPlatform();
    });

    it("has name property", () => {
      assert.strictEqual(platform.name, "base");
    });

    it("postComment throws NotImplementedError by default", async () => {
      await assert.rejects(
        async () => platform.postComment({ repo: "test/repo", issueNumber: 1, body: "test" }),
        (err) => {
          assert(err instanceof NotImplementedError);
          assert.strictEqual(err.code, "NOT_IMPLEMENTED");
          assert.strictEqual(err.message.includes("postComment"), true);
          return true;
        }
      );
    });

    it("createPullRequest throws NotImplementedError by default", async () => {
      await assert.rejects(
        async () => platform.createPullRequest({ repo: "test/repo", title: "test", body: "test", head: "feat", base: "main" }),
        (err) => {
          assert(err instanceof NotImplementedError);
          return true;
        }
      );
    });

    it("getIssue throws NotImplementedError by default", async () => {
      await assert.rejects(
        async () => platform.getIssue({ repo: "test/repo", issueNumber: 1 }),
        (err) => {
          assert(err instanceof NotImplementedError);
          return true;
        }
      );
    });

    it("listChangedFiles throws NotImplementedError by default", async () => {
      await assert.rejects(
        async () => platform.listChangedFiles({ repo: "test/repo", prNumber: 1 }),
        (err) => {
          assert(err instanceof NotImplementedError);
          return true;
        }
      );
    });

    it("closeIssue throws NotImplementedError by default", async () => {
      await assert.rejects(
        async () => platform.closeIssue({ repo: "test/repo", number: 1 }),
        (err) => {
          assert(err instanceof NotImplementedError);
          return true;
        }
      );
    });

    it("verifyWebhook throws NotImplementedError by default", async () => {
      await assert.rejects(
        async () => platform.verifyWebhook({ signature: "sig", payload: "payload", secret: "secret" }),
        (err) => {
          assert(err instanceof NotImplementedError);
          return true;
        }
      );
    });

    it("getBranch throws NotImplementedError by default", async () => {
      await assert.rejects(
        async () => platform.getBranch({ repo: "test/repo", branch: "main" }),
        (err) => {
          assert(err instanceof NotImplementedError);
          return true;
        }
      );
    });

    it("healthCheck returns not healthy by default", async () => {
      const result = await platform.healthCheck();
      assert.strictEqual(result.healthy, false);
      assert.strictEqual(result.diagnostics.length, 1);
      assert.strictEqual(result.diagnostics[0].level, "error");
    });
  });

  describe("GitPlatformError", () => {
    it("creates base error", () => {
      const err = new GitPlatformError("test message", { code: "TEST_CODE", platform: "testplat" });
      assert.strictEqual(err.name, "GitPlatformError");
      assert.strictEqual(err.message, "test message");
      assert.strictEqual(err.code, "TEST_CODE");
      assert.strictEqual(err.platform, "testplat");
    });

    it("NotImplementedError has correct defaults", () => {
      const err = new NotImplementedError("testMethod", "github");
      assert.strictEqual(err.name, "NotImplementedError");
      assert.strictEqual(err.code, "NOT_IMPLEMENTED");
      assert.strictEqual(err.platform, "github");
      assert.strictEqual(err.message.includes("testMethod"), true);
      assert.strictEqual(err.message.includes("github"), true);
    });

    it("AuthenticationError has correct defaults", () => {
      const err = new AuthenticationError("auth failed", "gitlab");
      assert.strictEqual(err.name, "AuthenticationError");
      assert.strictEqual(err.code, "AUTHENTICATION_FAILED");
      assert.strictEqual(err.platform, "gitlab");
    });

    it("NotFoundError has correct defaults", () => {
      const err = new NotFoundError("not found", "gitea");
      assert.strictEqual(err.name, "NotFoundError");
      assert.strictEqual(err.code, "NOT_FOUND");
      assert.strictEqual(err.platform, "gitea");
    });

    it("RateLimitError has correct defaults", () => {
      const resetAt = new Date();
      const err = new RateLimitError("rate limited", "github", { resetAt });
      assert.strictEqual(err.name, "RateLimitError");
      assert.strictEqual(err.code, "RATE_LIMIT_EXCEEDED");
      assert.strictEqual(err.platform, "github");
      assert.strictEqual(err.resetAt, resetAt);
    });
  });

  describe("extensibility", () => {
    it("allows subclass to override methods", () => {
      class CustomAdapter extends GitPlatform {
        name = "custom";

        async postComment({ repo, issueNumber, body }) {
          return { url: `https://example.com/${repo}/${issueNumber}`, id: 123 };
        }
      }

      const adapter = new CustomAdapter();
      assert.strictEqual(adapter.name, "custom");

      return adapter.postComment({ repo: "test/repo", issueNumber: 1, body: "test" })
        .then((result) => {
          assert.strictEqual(result.url, "https://example.com/test/repo/1");
          assert.strictEqual(result.id, 123);
        });
    });
  });
});
