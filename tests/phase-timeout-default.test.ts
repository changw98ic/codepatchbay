import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_AGENT_PHASE_TIMEOUT_MS,
  resolveAgentPhaseTimeoutMs,
} from "../core/policy/phase-budget.js";

test("agent phases have a finite hard timeout by default", () => {
  assert.equal(resolveAgentPhaseTimeoutMs({ env: {} }), DEFAULT_AGENT_PHASE_TIMEOUT_MS);
  assert.equal(resolveAgentPhaseTimeoutMs({ timeoutMin: 0, env: {} }), DEFAULT_AGENT_PHASE_TIMEOUT_MS);
  assert.ok(DEFAULT_AGENT_PHASE_TIMEOUT_MS > 0);
});

test("agent phase timeout honors explicit job minutes and positive environment values", () => {
  assert.equal(resolveAgentPhaseTimeoutMs({ timeoutMin: 7, env: {} }), 7 * 60_000);
  assert.equal(resolveAgentPhaseTimeoutMs({ env: { CPB_ACP_PHASE_TIMEOUT_MS: "12345" } }), 12_345);
  assert.equal(resolveAgentPhaseTimeoutMs({ env: { CPB_ACP_POOL_TIMEOUT_MS: "67890" } }), 67_890);
});

test("zero or invalid environment timeouts cannot silently disable the hard limit", () => {
  assert.equal(
    resolveAgentPhaseTimeoutMs({ env: { CPB_ACP_PHASE_TIMEOUT_MS: "0" } }),
    DEFAULT_AGENT_PHASE_TIMEOUT_MS,
  );
  assert.equal(
    resolveAgentPhaseTimeoutMs({ env: { CPB_ACP_PHASE_TIMEOUT_MS: "not-a-number" } }),
    DEFAULT_AGENT_PHASE_TIMEOUT_MS,
  );
});
