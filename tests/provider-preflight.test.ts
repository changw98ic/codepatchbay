import assert from "node:assert/strict";
import { test } from "node:test";

import { runProviderPreflight } from "../core/engine/provider-preflight.js";

test("runProviderPreflight permits an explicit provider fallback for a required role", async () => {
  const phaseAgents: Record<string, unknown> = {
    executor: { agent: "claude-glm", variant: "glm" },
  };
  const handoffState = { count: 0, from: null, to: null, reason: null };
  const events: Record<string, unknown>[] = [];

  const result = await runProviderPreflight({
    hubRoot: "/tmp/cpb-hub",
    pool: {
      providerKey(agent: string, variant: string | null) {
        return variant ? `${agent}:${variant}` : agent;
      },
      fallbackCandidates() {
        return [{
          providerKey: "claude:mimo-v2.5pro",
          agent: "claude-mimo",
          variant: "mimo-v2.5pro",
          providerFallback: true,
        }];
      },
    },
    providerServices: {
      async assertProviderAvailable(_hubRoot: string, payload: { providerKey: string }) {
        if (payload.providerKey !== "claude:mimo-v2.5pro") throw new Error("GLM unavailable");
      },
    },
    cpbRoot: "/tmp/cpb",
    project: "project-1",
    jobId: "job-1",
    phase: "execute",
    role: "executor",
    phaseAgents,
    agent: "claude-glm",
    dynamicAgent: { required: true },
    allowedAgents: ["claude-glm", "claude-mimo"],
    handoffState,
    appendEvent: async (_root, _project, _jobId, event) => {
      events.push(event);
    },
    reportProgress: async () => {},
    now: () => "2026-07-17T00:00:00.000Z",
  });

  assert.equal(result, null);
  assert.deepEqual(phaseAgents.executor, {
    agent: "claude-mimo",
    variant: "mimo-v2.5pro",
  });
  assert.deepEqual(handoffState, {
    count: 1,
    from: "claude-glm:glm",
    to: "claude:mimo-v2.5pro",
    reason: "fallback from claude-glm:glm",
  });
  assert.equal(events[0]?.type, "provider_handoff");
  assert.equal(events[0]?.handoffKind, "provider_fallback");
});
