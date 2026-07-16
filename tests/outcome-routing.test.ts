import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyRoutingTaskCategory,
  providerFamilyFor,
  selectOutcomeAwareAgent,
} from "../core/agents/outcome-routing.js";

function metrics({
  sampleSize = 20,
  successes = 18,
  retries = 1,
  timeouts = 0,
  verifierRuns = 18,
  verifierPasses = 17,
  providerKey = null,
}: {
  sampleSize?: number;
  successes?: number;
  retries?: number;
  timeouts?: number;
  verifierRuns?: number;
  verifierPasses?: number;
  providerKey?: string | null;
} = {}) {
  return {
    sampleSize,
    successes,
    retries,
    timeouts,
    verifierRuns,
    verifierPasses,
    evidenceCoverage: verifierRuns / sampleSize,
    providerKey,
    scope: "task_category_phase_role",
  };
}

test("outcome routing preserves the configured agent when baseline evidence is sparse", () => {
  const decision = selectOutcomeAwareAgent({
    preferredAgent: "codex",
    candidateAgents: ["claude"],
    role: "executor",
    metrics: {
      agents: {
        codex: metrics({ sampleSize: 2, successes: 2, verifierRuns: 2, verifierPasses: 2 }),
        claude: metrics(),
      },
    },
  });

  assert.equal(decision.selectedAgent, "codex");
  assert.equal(decision.applied, false);
  assert.match(decision.reason, /insufficient baseline evidence/);
});

test("outcome routing switches only when a high-confidence candidate clears the margin", () => {
  const decision = selectOutcomeAwareAgent({
    preferredAgent: "claude",
    candidateAgents: ["codex"],
    role: "executor",
    metrics: {
      agents: {
        claude: metrics({ successes: 11, retries: 7, timeouts: 3, verifierPasses: 9 }),
        codex: metrics({ successes: 20, retries: 0, verifierRuns: 20, verifierPasses: 20 }),
      },
    },
  });

  assert.equal(decision.selectedAgent, "codex");
  assert.equal(decision.applied, true);
  assert.match(decision.reason, /outcome evidence selected codex over claude/);
  assert.ok(decision.candidates.every((candidate) => !("tokens" in candidate)));
});

test("outcome routing refuses an apparently successful executor without verifier coverage", () => {
  const decision = selectOutcomeAwareAgent({
    preferredAgent: "codex",
    candidateAgents: ["claude"],
    role: "executor",
    metrics: {
      agents: {
        codex: metrics({ successes: 15, verifierRuns: 15, verifierPasses: 12 }),
        claude: metrics({ successes: 20, verifierRuns: 1, verifierPasses: 1 }),
      },
    },
  });

  assert.equal(decision.selectedAgent, "codex");
  const candidate = decision.candidates.find((item) => item.agent === "claude");
  assert.equal(candidate?.eligible, false);
  assert.ok(candidate?.reasons.some((reason) => reason.startsWith("verifier_runs:")));
});

test("high-risk verification selects a different provider family even without quality history", () => {
  const decision = selectOutcomeAwareAgent({
    preferredAgent: "claude-mimo",
    candidateAgents: ["codex", "claude"],
    role: "verifier",
    excludedProviderFamily: "claude",
    metrics: { agents: {} },
  });

  assert.equal(decision.selectedAgent, "codex");
  assert.equal(decision.independenceApplied, true);
  assert.equal(decision.independenceConflict, false);
});

test("allowed-agent policy prevents outcome metrics from injecting an out-of-contract agent", () => {
  const decision = selectOutcomeAwareAgent({
    preferredAgent: "codex",
    candidateAgents: ["claude-glm", "claude"],
    allowedAgents: ["codex", "claude-glm"],
    role: "executor",
    metrics: {
      agents: {
        codex: metrics({ successes: 11, retries: 7, timeouts: 3, verifierPasses: 9 }),
        "claude-glm": metrics({ successes: 12, retries: 6, timeouts: 2, verifierPasses: 10 }),
        claude: metrics({ successes: 20, retries: 0, verifierRuns: 20, verifierPasses: 20 }),
      },
    },
  });

  assert.equal(decision.selectedAgent, "codex");
  assert.deepEqual(decision.allowedAgents, ["codex", "claude-glm"]);
  assert.equal(decision.candidates.some((candidate) => candidate.agent === "claude"), false);
});

test("independent verification chooses only an allowed provider family", () => {
  const decision = selectOutcomeAwareAgent({
    preferredAgent: "codex",
    candidateAgents: ["claude", "claude-glm"],
    allowedAgents: ["codex", "claude-glm"],
    role: "verifier",
    excludedProviderFamily: "codex",
    metrics: { agents: {} },
  });

  assert.equal(decision.selectedAgent, "claude-glm");
  assert.equal(decision.independenceApplied, true);
  assert.equal(decision.agentPolicyConflict, false);
  assert.equal(decision.candidates.some((candidate) => candidate.agent === "claude"), false);
});

test("a required agent outside the allowed universe fails closed", () => {
  const decision = selectOutcomeAwareAgent({
    preferredAgent: "claude",
    candidateAgents: ["codex", "claude-glm"],
    allowedAgents: ["codex", "claude-glm"],
    role: "verifier",
    locked: true,
    metrics: { agents: {} },
  });

  assert.equal(decision.selectedAgent, null);
  assert.equal(decision.agentPolicyConflict, true);
  assert.match(decision.reason, /required agent claude is outside allowed agent policy/);
});

test("task category and provider family classification are generic and explicit-first", () => {
  assert.equal(classifyRoutingTaskCategory("fix auth token validation"), "security");
  assert.equal(classifyRoutingTaskCategory("update README examples"), "docs");
  assert.equal(classifyRoutingTaskCategory("anything", { taskCategory: "custom-domain" }), "custom-domain");
  assert.equal(providerFamilyFor("claude-glm", "claude:glm"), "glm");
  assert.equal(providerFamilyFor("codex"), "codex");
  assert.equal(providerFamilyFor("openai", "openai:gpt-5"), "codex");
  assert.equal(providerFamilyFor("anthropic", "anthropic:sonnet"), "claude");
});
