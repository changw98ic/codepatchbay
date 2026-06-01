import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyAuthStateToContext, mergeAuthStates } from "../../core/agents/drivers/browser/auth-state.mjs";

describe("auth-state: mergeAuthStates", () => {
  it("keeps a newer current cookie when a runtime only has the launch snapshot", () => {
    const base = {
      cookies: [{ name: "session", value: "old", domain: ".example.com", path: "/", expires: 100 }],
      origins: [],
    };
    const current = {
      cookies: [{ name: "session", value: "newer", domain: ".example.com", path: "/", expires: 300 }],
      origins: [],
    };
    const runtime = {
      cookies: [{ name: "session", value: "old", domain: ".example.com", path: "/", expires: 100 }],
      origins: [],
    };

    const merged = mergeAuthStates({ base, current, runtime });

    assert.equal(merged.cookies.length, 1);
    assert.equal(merged.cookies[0].value, "newer");
  });

  it("promotes the cookie with the later expiry when both runtime and current changed", () => {
    const base = {
      cookies: [{ name: "session", value: "old", domain: ".example.com", path: "/", expires: 100 }],
      origins: [],
    };
    const current = {
      cookies: [{ name: "session", value: "current", domain: ".example.com", path: "/", expires: 200 }],
      origins: [],
    };
    const runtime = {
      cookies: [{ name: "session", value: "runtime", domain: ".example.com", path: "/", expires: 400 }],
      origins: [],
    };

    const merged = mergeAuthStates({ base, current, runtime });

    assert.equal(merged.cookies.length, 1);
    assert.equal(merged.cookies[0].value, "runtime");
  });

  it("keeps current localStorage when runtime did not change it from the launch snapshot", () => {
    const base = {
      cookies: [],
      origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "old" }] }],
    };
    const current = {
      cookies: [],
      origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "newer" }] }],
    };
    const runtime = {
      cookies: [],
      origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "old" }] }],
    };

    const merged = mergeAuthStates({ base, current, runtime });

    assert.deepEqual(merged.origins, [
      { origin: "https://example.com", localStorage: [{ name: "token", value: "newer" }] },
    ]);
  });
});

describe("auth-state: applyAuthStateToContext", () => {
  it("loads cookies and localStorage overlay into a browser context", async () => {
    let cookies = null;
    let initScriptArg = null;
    const context = {
      async addCookies(value) { cookies = value; },
      async addInitScript(_fn, value) { initScriptArg = value; },
    };

    await applyAuthStateToContext(context, {
      cookies: [{ name: "session", value: "abc", domain: ".example.com", path: "/", expires: -1 }],
      origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "fresh" }] }],
    });

    assert.deepEqual(cookies, [{ name: "session", value: "abc", domain: ".example.com", path: "/" }]);
    assert.deepEqual(initScriptArg, [
      { origin: "https://example.com", localStorage: [{ name: "token", value: "fresh" }] },
    ]);
  });
});
