import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePhaseAdapterExport,
  runPhase,
  validatePhaseResult,
} from "../core/engine/run-phase.js";

test("runPhase rejects unsafe phase identifiers with contract diagnostics and still releases resources", async () => {
  const releases: Array<{ cwd: string; reason: string }> = [];

  const result = await runPhase({
    phase: "../unit_unknown_phase",
    cwd: "/tmp/cpb-unknown-phase",
    pool: {
      releaseWorktree: async (cwd: string, reason: string) => {
        releases.push({ cwd, reason });
      },
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.phase, "../unit_unknown_phase");
  assert.match(String(result.failure?.reason), /phase adapter identifier is invalid.*unit_unknown_phase/i);
  assert.deepEqual(result.diagnostics?.phaseAdapterContract, {
    code: "PHASE_ADAPTER_IDENTIFIER_INVALID",
    phase: "../unit_unknown_phase",
    boundary: "phase-adapter",
  });
  assert.deepEqual(releases, [{
    cwd: "/tmp/cpb-unknown-phase",
    reason: "phase_../unit_unknown_phase_complete",
  }]);
});

test("resolvePhaseAdapterExport requires the registered named export to be callable", () => {
  assert.throws(
    () => resolvePhaseAdapterExport("plan", { runPlan: null }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "PhaseAdapterContractError");
      assert.equal((error as Error & { code?: string }).code, "PHASE_ADAPTER_EXPORT_INVALID");
      assert.match(error.message, /plan/);
      assert.match(error.message, /runPlan/);
      return true;
    },
  );
});

test("validatePhaseResult fails closed on malformed or cross-phase adapter results", () => {
  assert.throws(
    () => validatePhaseResult("plan", {
      schemaVersion: 1,
      phase: "execute",
      status: "passed",
      artifact: null,
      failure: null,
      diagnostics: {},
      createdAt: new Date().toISOString(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "PHASE_RESULT_INVALID");
      assert.match(error.message, /expected phase "plan"/i);
      return true;
    },
  );

  assert.throws(
    () => validatePhaseResult("verify", {
      schemaVersion: 1,
      phase: "verify",
      status: "passed",
      artifact: null,
      failure: { kind: "unknown" },
      diagnostics: {},
      createdAt: new Date().toISOString(),
    }),
    /passed result must have failure=null/i,
  );

  assert.throws(
    () => validatePhaseResult("execute", {
      schemaVersion: 1,
      phase: "execute",
      status: "failed",
      artifact: null,
      failure: {
        kind: "invented_failure_kind",
        reason: "not canonical",
        retryable: false,
      },
      diagnostics: {},
      createdAt: new Date().toISOString(),
    }),
    /canonical FailureKind/i,
  );
});

test("validatePhaseResult normalizes a missing createdAt on an otherwise canonical result", () => {
  const result = {
    schemaVersion: 1,
    phase: "review",
    status: "failed",
    artifact: null,
    failure: {
      kind: "unknown",
      reason: "review unavailable",
      retryable: false,
    },
    diagnostics: { provider: "test" },
  };

  const validated = validatePhaseResult("review", result);
  assert.deepEqual({ ...validated, createdAt: undefined }, { ...result, createdAt: undefined });
  assert.equal(typeof validated.createdAt, "string");
  assert.ok(!Number.isNaN(Date.parse(validated.createdAt ?? "")));
});
