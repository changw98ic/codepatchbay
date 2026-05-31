import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  loadProvider,
  listProviders,
} from "../../core/agents/drivers/browser/provider-loader.mjs";
import { validateProviderProfile } from "../../core/agents/drivers/browser/profile-schema.mjs";

describe("bundled-providers: all 9 bundled provider profiles are valid", () => {
  it("all bundled providers pass schema validation", async () => {
    const providers = await listProviders();
    // Should have exactly the 9 bundled providers (mock + 8 real ones)
    assert.ok(providers.length >= 9, `expected at least 9 providers, got ${providers.length}`);

    for (const p of providers) {
      const profile = await loadProvider(p.name);
      const result = validateProviderProfile(profile);
      assert.equal(result.valid, true, `provider "${p.name}" invalid: ${result.errors.join("; ")}`);
    }
  });

  it("provider names are unique", async () => {
    const providers = await listProviders();
    const names = providers.map((p) => p.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `duplicate provider names found: ${names}`);
  });

  it("provider aliases are unique across all providers", async () => {
    const providers = await listProviders();
    const allAliases = [];
    for (const p of providers) {
      const profile = await loadProvider(p.name);
      if (profile.aliases) {
        for (const alias of profile.aliases) {
          allAliases.push(alias);
        }
      }
    }
    const unique = new Set(allAliases);
    assert.equal(unique.size, allAliases.length, `duplicate aliases found: ${allAliases}`);
  });

  it("no bundled provider contains absolute local paths", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const providersDir = new URL("../../core/agents/drivers/browser/providers/", import.meta.url);
    const files = await readdir(providersDir).catch(() => []);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    for (const f of jsonFiles) {
      const raw = await readFile(new URL(f, providersDir), "utf8");
      const profile = JSON.parse(raw);
      const urls = [profile.startUrl, profile.auth?.loginUrl].filter(Boolean);
      for (const url of urls) {
        assert.ok(
          !url.includes("/Users/") && !url.includes("/home/"),
          `provider "${profile.name}" in ${f} contains absolute path: ${url}`
        );
      }
    }
  });

  it("all providers have valid support fields", async () => {
    const providers = await listProviders();
    const validTiers = ["official", "best-effort", "experimental"];
    for (const p of providers) {
      const profile = await loadProvider(p.name);
      assert.ok(validTiers.includes(profile.support.tier), `provider "${p.name}" has invalid tier: ${profile.support.tier}`);
      assert.equal(typeof profile.support.requiresManualLogin, "boolean", `provider "${p.name}" requiresManualLogin must be boolean`);
    }
  });
});
