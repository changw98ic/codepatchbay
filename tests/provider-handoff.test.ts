import assert from "node:assert/strict";
import { test } from "node:test";

import {
  preflightProvider,
  resolveProviderKey,
  resolveRawAgent,
} from "../core/engine/provider-handoff.js";

test("preflightProvider returns null when provider availability service is absent", async () => {
  const result = await preflightProvider({
    providerServices: {},
    hubRoot: "/tmp/cpb-hub",
    pool: null,
    phase: "plan",
    role: "planner",
    agents: { planner: "codex" },
    agent: null,
  });

  assert.equal(result, null);
});

test("preflightProvider selects a fallback candidate when the preferred provider is unavailable", async () => {
  const checkedProviders: string[] = [];
  const pool = {
    providerKey(agent: string, variant: string | null) {
      return variant ? `${agent}:${variant}` : agent;
    },
    fallbackCandidates() {
      return [{ providerKey: "codex", agent: "codex", variant: null }];
    },
  };
  const providerServices = {
    async assertProviderAvailable(_hubRoot: string, payload: { providerKey: string }) {
      checkedProviders.push(payload.providerKey);
      if (payload.providerKey === "claude:sonnet") {
        throw new Error("rate limited");
      }
    },
  };

  const result = await preflightProvider({
    providerServices,
    hubRoot: "/tmp/cpb-hub",
    pool,
    phase: "plan",
    role: "planner",
    agents: { planner: { agent: "claude", variant: "sonnet" } },
    agent: "claude",
  });

  assert.deepEqual(checkedProviders, ["claude:sonnet", "codex"]);
  assert.equal(result?.available, true);
  assert.equal(result?.switched, true);
  assert.equal(result?.from, "claude:sonnet");
  assert.equal(result?.selectedProviderKey, "codex");
  assert.equal(result?.selectedAgent, "codex");
  assert.equal(result?.reason, "fallback from claude:sonnet");
});

test("preflightProvider reports all providers unavailable when every fallback fails", async () => {
  const pool = {
    providerKey(agent: string, variant: string | null) {
      return variant ? `${agent}:${variant}` : agent;
    },
    fallbackCandidates() {
      return [{ providerKey: "codex", agent: "codex", variant: null }];
    },
  };
  const providerServices = {
    async assertProviderAvailable() {
      throw new Error("unavailable");
    },
  };

  const result = await preflightProvider({
    providerServices,
    hubRoot: "/tmp/cpb-hub",
    pool,
    phase: "plan",
    role: "planner",
    agents: { planner: { agent: "claude", variant: "sonnet" } },
    agent: "claude",
  });

  assert.equal(result?.available, false);
  assert.equal(result?.switched, false);
  assert.equal(result?.from, "claude:sonnet");
  assert.equal(result?.selectedProviderKey, null);
  assert.equal(result?.reason, "all providers unavailable for planner");
});

test("resolveProviderKey and resolveRawAgent preserve legacy selection semantics", () => {
  assert.deepEqual(
    resolveRawAgent({ planner: { name: "claude", variant: "opus" } }, null, "planner", "plan"),
    { agent: "claude", variant: "opus" },
  );
  assert.equal(resolveProviderKey(null, { agent: "claude", variant: "sonnet" }, null), "claude:sonnet");
  assert.equal(resolveProviderKey(null, null, "codex"), "codex");
});
