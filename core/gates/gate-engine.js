/**
 * Gate engine — registry + evaluator for pipeline gates.
 *
 * Gates are condition checks that run between workflow phases.
 * Each gate is a named async function: (ctx) => GateResult.
 *
 * Usage:
 *   const engine = createGateEngine();
 *   engine.register(approvalGate);
 *   const result = await engine.evaluate(["approval"], ctx);
 */

import { isGatePassed } from "./gate-result.js";

/**
 * Create a gate engine. Starts empty — register gates explicitly or
 * use createGateEngineWithBuiltins() for the async factory.
 *
 * @param {object} [options]
 * @param {Array}  [options.gates] - gate definitions to register at creation
 * @returns {{ register, evaluate, evaluateForPhase, has, list, get }}
 */
export function createGateEngine({ gates = [] } = {}) {
  const registry = new Map();

  for (const gate of gates) {
    validateGate(gate);
    registry.set(gate.type, gate);
  }

  return {
    register(gate) {
      validateGate(gate);
      registry.set(gate.type, gate);
    },

    has(type) {
      return registry.has(type);
    },

    get(type) {
      return registry.get(type) ?? null;
    },

    list() {
      return [...registry.values()];
    },

    /**
     * Evaluate a list of gates sequentially. Short-circuits on first
     * non-passed result (blocked or failed).
     *
     * @param {string[]} gateTypes - ordered list of gate type names
     * @param {object} ctx - evaluation context
     * @returns {{ results: GateResult[], overall: "passed"|"blocked"|"failed" }}
     */
    async evaluate(gateTypes, ctx) {
      const results = [];

      for (const type of gateTypes) {
        const gate = registry.get(type);
        if (!gate) {
          results.push({
            schemaVersion: 1,
            gateType: type,
            status: "failed",
            reason: `unknown gate type: ${type}`,
            metadata: {},
            createdAt: new Date().toISOString(),
          });
          return { results, overall: "failed" };
        }

        const result = await gate.evaluate(ctx);
        results.push(result);

        if (!isGatePassed(result)) {
          return { results, overall: result.status };
        }
      }

      return { results, overall: "passed" };
    },

    /**
     * Evaluate gates configured for a specific phase transition.
     *
     * @param {string} phase - the phase about to start
     * @param {object} ctx - evaluation context
     * @param {object} [ctx.workflowGates] - { phaseName: ["gate1", "gate2"] }
     * @returns {{ results: GateResult[], overall: "passed"|"blocked"|"failed" }}
     */
    async evaluateForPhase(phase, ctx) {
      const gateTypes = resolveGatesForPhase(phase, ctx);
      if (gateTypes.length === 0) {
        return { results: [], overall: "passed" };
      }
      return this.evaluate(gateTypes, ctx);
    },
  };
}

function validateGate(gate) {
  if (!gate?.type || typeof gate.type !== "string") {
    throw new Error("gate must have a string .type");
  }
  if (typeof gate.evaluate !== "function") {
    throw new Error(`gate "${gate.type}" must have an .evaluate function`);
  }
}

function resolveGatesForPhase(phase, ctx) {
  if (!ctx?.workflowGates) return [];
  const gates = ctx.workflowGates[phase];
  if (!Array.isArray(gates)) return [];
  return gates.filter((g) => typeof g === "string");
}

/**
 * Async factory — loads all built-in gates via dynamic import and
 * returns a fully-populated gate engine.
 */
export async function createGateEngineWithBuiltins() {
  const gates = [];

  const modules = [
    import("./approval-gate.js"),
    import("./artifact-gate.js"),
    import("./policy-gate.js"),
    import("./test-gate.js"),
  ];

  const loaded = await Promise.allSettled(modules);
  for (const result of loaded) {
    if (result.status === "fulfilled" && result.value?.default) {
      gates.push(result.value.default);
    }
  }

  return createGateEngine({ gates });
}
