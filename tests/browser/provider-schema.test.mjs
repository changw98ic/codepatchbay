import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateProviderProfile,
  LoginRequiredError,
  ProviderProfileError,
} from "../../core/agents/drivers/browser/profile-schema.mjs";

function makeValidProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "test-provider",
    displayName: "Test Provider",
    aliases: ["tp"],
    support: {
      tier: "official",
      requiresManualLogin: false,
      lastVerified: null,
    },
    startUrl: "https://example.com",
    auth: {
      type: "persistent-profile",
      loginUrl: "https://example.com/login",
      loginCheck: { mode: "selector-visible", selector: ".login" },
      readyCheck: { mode: "selector-visible", selector: ".ready" },
    },
    input: {
      selector: "#input",
      kind: "textarea",
      method: "fill",
      clearBeforeInput: true,
      submit: { mode: "button", selector: "#send" },
    },
    response: {
      messageSelector: ".message",
      textSelector: ".text",
      mode: "last-message",
      stableRounds: 3,
      minChars: 10,
      pollIntervalMs: 2000,
      maxWaitMs: 900000,
      doneWhen: [{ type: "text-stable", rounds: 3 }],
    },
    continue: {
      enabled: true,
      selector: "#continue",
      maxClicks: 5,
      cooldownMs: 1000,
    },
    diagnostics: {
      screenshotOnFailure: true,
      traceOnFailure: false,
    },
    ...overrides,
  };
}

describe("profile-schema: validateProviderProfile", () => {
  it("accepts a fully valid profile", () => {
    const result = validateProviderProfile(makeValidProfile());
    assert.equal(result.valid, true);
    assert.ok(!result.errors || result.errors.length === 0);
  });

  it("rejects null profile", () => {
    const result = validateProviderProfile(null);
    assert.equal(result.valid, false);
    assert.equal(result.errors[0], "profile must be an object");
  });

  it("rejects missing name", () => {
    const profile = makeValidProfile();
    delete profile.name;
    const result = validateProviderProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("name")));
  });

  it("rejects empty name", () => {
    const result = validateProviderProfile(makeValidProfile({ name: "" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("name")));
  });

  it("rejects missing displayName", () => {
    const profile = makeValidProfile();
    delete profile.displayName;
    const result = validateProviderProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("displayName")));
  });

  it("rejects invalid aliases (non-array)", () => {
    const result = validateProviderProfile(makeValidProfile({ aliases: "oops" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("aliases")));
  });

  it("rejects invalid support.tier", () => {
    const result = validateProviderProfile(
      makeValidProfile({ support: { ...makeValidProfile().support, tier: "premium" } })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("tier")));
  });

  it("rejects missing support.requiresManualLogin", () => {
    const profile = makeValidProfile();
    delete profile.support.requiresManualLogin;
    const result = validateProviderProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("requiresManualLogin")));
  });

  it("rejects invalid input.kind", () => {
    const result = validateProviderProfile(
      makeValidProfile({ input: { ...makeValidProfile().input, kind: "div" } })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("kind")));
  });

  it("rejects invalid input.method", () => {
    const result = validateProviderProfile(
      makeValidProfile({ input: { ...makeValidProfile().input, method: "click" } })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("method")));
  });

  it("rejects invalid input.submit.mode", () => {
    const result = validateProviderProfile(
      makeValidProfile({ input: { ...makeValidProfile().input, submit: { mode: "ctrl" } } })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("submit.mode")));
  });

  it("rejects missing response.messageSelector", () => {
    const profile = makeValidProfile();
    delete profile.response.messageSelector;
    const result = validateProviderProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("messageSelector")));
  });

  it("rejects invalid doneWhen type", () => {
    const result = validateProviderProfile(
      makeValidProfile({
        response: {
          ...makeValidProfile().response,
          doneWhen: [{ type: "typing-complete" }],
        },
      })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("doneWhen")));
  });

  it("rejects doneWhen selector-hidden without selector", () => {
    const result = validateProviderProfile(
      makeValidProfile({
        response: {
          ...makeValidProfile().response,
          doneWhen: [{ type: "selector-hidden" }],
        },
      })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("selector")));
  });

  it("rejects doneWhen selector-visible without selector", () => {
    const result = validateProviderProfile(
      makeValidProfile({
        response: {
          ...makeValidProfile().response,
          doneWhen: [{ type: "selector-visible" }],
        },
      })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("selector")));
  });

  it("accepts send-enabled doneWhen without selector", () => {
    const result = validateProviderProfile(
      makeValidProfile({
        response: {
          ...makeValidProfile().response,
          doneWhen: [{ type: "send-enabled" }],
        },
      })
    );
    assert.equal(result.valid, true);
  });

  it("accepts all valid doneWhen types together", () => {
    const result = validateProviderProfile(
      makeValidProfile({
        response: {
          ...makeValidProfile().response,
          doneWhen: [
            { type: "text-stable", rounds: 2 },
            { type: "selector-hidden", selector: ".done" },
            { type: "selector-visible", selector: ".result" },
            { type: "send-enabled" },
          ],
        },
      })
    );
    assert.equal(result.valid, true);
  });

  it("rejects negative stableRounds", () => {
    const result = validateProviderProfile(
      makeValidProfile({ response: { ...makeValidProfile().response, stableRounds: 0 } })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("stableRounds")));
  });

  it("rejects pollIntervalMs below minimum", () => {
    const result = validateProviderProfile(
      makeValidProfile({ response: { ...makeValidProfile().response, pollIntervalMs: 50 } })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("pollIntervalMs")));
  });

  it("LoginRequiredError has correct code", () => {
    const err = new LoginRequiredError("need login");
    assert.equal(err.name, "LoginRequiredError");
    assert.equal(err.code, "LOGIN_REQUIRED");
  });

  it("ProviderProfileError has correct code", () => {
    const err = new ProviderProfileError("bad profile");
    assert.equal(err.name, "ProviderProfileError");
    assert.equal(err.code, "PROFILE_INVALID");
  });
});
