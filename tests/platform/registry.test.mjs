/**
 * Platform registry tests.
 *
 * Tests the platform registry and resolution logic.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";
import {
  loadRegistry,
  listPlatforms,
  listPlatformNames,
  hasPlatform,
  getDescriptor,
  resolvePlatformFromUrl,
  resolvePlatformFromUrlOrDefault,
} from "../../server/platform/registry.js";

describe("Platform registry", () => {
  before(async () => {
    await loadRegistry();
  });

  describe("listPlatforms", () => {
    it("returns array of platforms", () => {
      const platforms = listPlatforms();
      assert(Array.isArray(platforms));
    });

    it("includes github platform", () => {
      const platforms = listPlatforms();
      const github = platforms.find((p) => p.name === "github");
      assert(github);
      assert.strictEqual(github.name, "github");
      assert.strictEqual(github.displayName, "GitHub");
      assert.strictEqual(github.protocol, "https");
    });
  });

  describe("listPlatformNames", () => {
    it("returns array of platform names", () => {
      const names = listPlatformNames();
      assert(Array.isArray(names));
      assert(names.includes("github"));
    });
  });

  describe("hasPlatform", () => {
    it("returns true for github", () => {
      assert.strictEqual(hasPlatform("github"), true);
    });

    it("returns false for unknown platform", () => {
      assert.strictEqual(hasPlatform("unknown"), false);
    });
  });

  describe("getDescriptor", () => {
    it("returns github descriptor", () => {
      const desc = getDescriptor("github");
      assert(desc);
      assert.strictEqual(desc.name, "github");
      assert.strictEqual(desc.displayName, "GitHub");
    });

    it("returns null for unknown platform", () => {
      const desc = getDescriptor("unknown");
      assert.strictEqual(desc, null);
    });
  });

  describe("resolvePlatformFromUrl", () => {
    it("resolves github.com URLs", () => {
      assert.strictEqual(resolvePlatformFromUrl("https://github.com/owner/repo"), "github");
      assert.strictEqual(resolvePlatformFromUrl("http://github.com/owner/repo"), "github");
      assert.strictEqual(resolvePlatformFromUrl("https://www.github.com/owner/repo"), "github");
      assert.strictEqual(resolvePlatformFromUrl("https://api.github.com/owner/repo"), "github");
    });

    it("resolves owner/repo format to github", () => {
      assert.strictEqual(resolvePlatformFromUrl("owner/repo"), "github");
      assert.strictEqual(resolvePlatformFromUrl("my-org/my-project"), "github");
    });

    it("resolves gitlab.com URLs to gitlab", () => {
      assert.strictEqual(resolvePlatformFromUrl("https://gitlab.com/owner/repo"), "gitlab");
    });

    it("resolves gitea.io URLs to gitea", () => {
      assert.strictEqual(resolvePlatformFromUrl("https://gitea.io/owner/repo"), "gitea");
    });

    it("resolves gitee.com URLs to gitee", () => {
      assert.strictEqual(resolvePlatformFromUrl("https://gitee.com/owner/repo"), "gitee");
    });

    it("returns null for unknown URLs", () => {
      assert.strictEqual(resolvePlatformFromUrl("https://unknown.com/owner/repo"), null);
      assert.strictEqual(resolvePlatformFromUrl("https://bitbucket.org/owner/repo"), null);
    });

    it("returns null for malformed input", () => {
      assert.strictEqual(resolvePlatformFromUrl(null), null);
      assert.strictEqual(resolvePlatformFromUrl(undefined), null);
      assert.strictEqual(resolvePlatformFromUrl(""), null);
      assert.strictEqual(resolvePlatformFromUrl("not-a-url"), null);
    });

    it("handles git@host:owner/repo.git format", () => {
      assert.strictEqual(resolvePlatformFromUrl("git@github.com:owner/repo.git"), "github");
      assert.strictEqual(resolvePlatformFromUrl("git@gitlab.com:owner/repo.git"), "gitlab");
    });
  });

  describe("resolvePlatformFromUrlOrDefault", () => {
    it("returns resolved platform when found", () => {
      assert.strictEqual(resolvePlatformFromUrlOrDefault("owner/repo"), "github");
      assert.strictEqual(resolvePlatformFromUrlOrDefault("https://gitlab.com/owner/repo"), "gitlab");
    });

    it("returns default platform when not found", () => {
      assert.strictEqual(resolvePlatformFromUrlOrDefault("https://unknown.com/repo"), "github");
    });

    it("supports custom default platform", () => {
      assert.strictEqual(resolvePlatformFromUrlOrDefault("https://unknown.com/repo", { defaultPlatform: "gitlab" }), "gitlab");
    });
  });
});
