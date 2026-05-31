import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  BOUNDARY_VERSION,
  REQUIRED_ADAPTER_METHODS,
  REQUIRED_TRANSPORT_METHODS,
  SUPPORTED_PLATFORMS,
  isValidPlatform,
  validateGitPlatformAdapter,
  validateTransportResult,
} from "../core/contracts/git-platform.js";
import { resolveGitPlatform, clearAdapterCache, registerAdapter } from "../server/services/git-platform-adapter.js";

describe("git-platform contract", () => {
  it("exports BOUNDARY_VERSION as a semver string", () => {
    assert.match(BOUNDARY_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it("REQUIRED_ADAPTER_METHODS is a non-empty frozen array", () => {
    assert.ok(Array.isArray(REQUIRED_ADAPTER_METHODS));
    assert.ok(REQUIRED_ADAPTER_METHODS.length > 0);
    assert.ok(Object.isFrozen(REQUIRED_ADAPTER_METHODS));
  });

  it("REQUIRED_TRANSPORT_METHODS is a non-empty frozen array", () => {
    assert.ok(Array.isArray(REQUIRED_TRANSPORT_METHODS));
    assert.ok(REQUIRED_TRANSPORT_METHODS.length > 0);
    assert.ok(Object.isFrozen(REQUIRED_TRANSPORT_METHODS));
  });

  it("SUPPORTED_PLATFORMS contains github", () => {
    assert.ok(SUPPORTED_PLATFORMS.includes("github"));
  });

  describe("isValidPlatform()", () => {
    it("returns true for github", () => {
      assert.equal(isValidPlatform("github"), true);
    });

    it("returns false for unknown platforms", () => {
      assert.equal(isValidPlatform("gitlab"), false);
      assert.equal(isValidPlatform(""), false);
      assert.equal(isValidPlatform(null), false);
    });
  });

  describe("validateGitPlatformAdapter()", () => {
    function makeValidAdapter() {
      const adapter = { platform: "github" };
      for (const m of REQUIRED_ADAPTER_METHODS) {
        adapter[m] = () => {};
      }
      return adapter;
    }

    it("accepts a valid adapter with all required methods", () => {
      const adapter = makeValidAdapter();
      assert.equal(validateGitPlatformAdapter(adapter), adapter);
    });

    it("rejects null", () => {
      assert.throws(() => validateGitPlatformAdapter(null), /non-null object/);
    });

    it("rejects missing platform", () => {
      const adapter = makeValidAdapter();
      delete adapter.platform;
      assert.throws(() => validateGitPlatformAdapter(adapter), /platform/);
    });

    it("rejects empty platform", () => {
      const adapter = makeValidAdapter();
      adapter.platform = "";
      assert.throws(() => validateGitPlatformAdapter(adapter), /platform/);
    });

    it("rejects missing required methods", () => {
      const adapter = makeValidAdapter();
      delete adapter.resolveTransport;
      assert.throws(() => validateGitPlatformAdapter(adapter), /resolveTransport/);
    });

    it("rejects non-function required method", () => {
      const adapter = makeValidAdapter();
      adapter.resolveTransport = "not a function";
      assert.throws(() => validateGitPlatformAdapter(adapter), /resolveTransport/);
    });

    it("rejects mismatched boundaryVersion", () => {
      const adapter = makeValidAdapter();
      adapter.boundaryVersion = "9.9.9";
      assert.throws(() => validateGitPlatformAdapter(adapter), /boundary version mismatch/);
    });

    it("accepts adapter without boundaryVersion (optional)", () => {
      const adapter = makeValidAdapter();
      assert.equal(validateGitPlatformAdapter(adapter), adapter);
    });
  });

  describe("validateTransportResult()", () => {
    it("accepts a healthy transport with all methods", () => {
      const transport = {
        mode: "api",
        healthy: true,
        postComment: () => {},
        createPullRequest: () => {},
        closeIssue: () => {},
      };
      assert.equal(validateTransportResult(transport), transport);
    });

    it("accepts an unavailable transport with null methods", () => {
      const transport = {
        mode: "unavailable",
        healthy: false,
        postComment: null,
        createPullRequest: null,
        closeIssue: null,
      };
      assert.equal(validateTransportResult(transport), transport);
    });

    it("rejects null", () => {
      assert.throws(() => validateTransportResult(null), /non-null object/);
    });

    it("rejects missing mode", () => {
      assert.throws(() => validateTransportResult({ healthy: true }), /mode/);
    });

    it("rejects missing healthy", () => {
      assert.throws(() => validateTransportResult({ mode: "api" }), /healthy/);
    });

    it("rejects healthy transport with missing methods", () => {
      const transport = { mode: "api", healthy: true };
      assert.throws(() => validateTransportResult(transport), /postComment/);
    });
  });
});

describe("git-platform adapter resolution", () => {
  beforeEach(() => {
    clearAdapterCache();
  });

  it("resolves github adapter by default", () => {
    const adapter = resolveGitPlatform();
    assert.equal(adapter.platform, "github");
  });

  it("resolves github adapter by name", () => {
    const adapter = resolveGitPlatform("github");
    assert.equal(adapter.platform, "github");
  });

  it("caches adapter instances", () => {
    const a = resolveGitPlatform("github");
    const b = resolveGitPlatform("github");
    assert.equal(a, b);
  });

  it("throws for unsupported platform", () => {
    assert.throws(() => resolveGitPlatform("gitlab"), /unsupported platform/);
  });

  it("github adapter has all required methods", () => {
    const adapter = resolveGitPlatform("github");
    for (const m of REQUIRED_ADAPTER_METHODS) {
      assert.equal(typeof adapter[m], "function", `github adapter missing method: ${m}`);
    }
  });

  describe("registerAdapter()", () => {
    it("registers and returns a validated custom adapter", () => {
      const custom = { platform: "github" };
      for (const m of REQUIRED_ADAPTER_METHODS) {
        custom[m] = () => {};
      }
      const result = registerAdapter(custom);
      assert.equal(result.platform, "github");
      assert.equal(resolveGitPlatform("github"), result);
    });

    it("rejects an invalid adapter", () => {
      assert.throws(() => registerAdapter({}), /platform/);
    });
  });
});
