import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  loadProvider,
  listProviders,
} from "../../core/agents/drivers/browser/provider-loader.mjs";
import { ProviderProfileError } from "../../core/agents/drivers/browser/profile-schema.mjs";

describe("provider-loader", () => {
  it("loadProvider loads chatgpt by name", async () => {
    const profile = await loadProvider("chatgpt");
    assert.equal(profile.name, "chatgpt");
    assert.equal(profile.displayName, "ChatGPT");
    assert.ok(profile.support);
    assert.equal(profile.input.kind, "textarea");
  });

  it("loadProvider loads deepseek-web by alias 'deepseek'", async () => {
    const profile = await loadProvider("deepseek");
    assert.equal(profile.name, "deepseek-web");
    assert.ok(profile.aliases.includes("deepseek"));
  });

  it("loadProvider throws ProviderProfileError for missing provider", async () => {
    await assert.rejects(async () => loadProvider("nonexistent-xyz"), (err) => {
      assert.ok(err instanceof ProviderProfileError);
      assert.match(err.message, /nonexistent-xyz/);
      return true;
    });
  });

  it("loadProvider throws for empty name", async () => {
    await assert.rejects(async () => loadProvider(""), (err) => {
      assert.ok(err instanceof ProviderProfileError);
      return true;
    });
  });

  it("loadProvider throws for non-string name", async () => {
    await assert.rejects(async () => loadProvider(null), (err) => {
      assert.ok(err instanceof ProviderProfileError);
      return true;
    });
  });

  it("listProviders returns array with chatgpt and deepseek-web", async () => {
    const providers = await listProviders();
    assert.ok(Array.isArray(providers));
    assert.ok(providers.length >= 2);

    const names = providers.map((p) => p.name);
    assert.ok(names.includes("chatgpt"));
    assert.ok(names.includes("deepseek-web"));
  });

  it("listProviders entries have required fields", async () => {
    const providers = await listProviders();
    for (const p of providers) {
      assert.equal(typeof p.name, "string");
      assert.equal(typeof p.displayName, "string");
      assert.ok(p.support && typeof p.support === "object");
    }
  });

  it("loadProvider validates profile schema", async () => {
    // mock.json has stableRounds: 1 which is >= min 1, so it should be valid
    const profile = await loadProvider("mock");
    assert.equal(profile.name, "mock");
    assert.equal(profile.support.tier, "official");
  });
});
