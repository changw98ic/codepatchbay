/**
 * Test gate — verifies test results before proceeding.
 *
 * Checks ctx.testResults for passing tests. Useful for preventing
 * merge/deploy when tests fail.
 *
 * Context fields:
 *   testResults: { passed: number, failed: number, total: number }
 *   testCommand: string (optional, the command that was run)
 *   requireAllPass: boolean (default: true)
 */

import { gatePassed, gateFailed } from "./gate-result.js";

const testGate = {
  type: "test",
  description: "Verifies test results before proceeding",

  async evaluate(ctx) {
    const results = ctx.testResults;

    if (!results) {
      // No test results available — pass by default (tests haven't run)
      return gatePassed({
        gateType: "test",
        reason: "no test results available",
      });
    }

    const passed = Number(results.passed) || 0;
    const failed = Number(results.failed) || 0;
    const total = Number(results.total) || passed + failed;
    const requireAll = ctx.requireAllPass !== false;

    if (requireAll && failed > 0) {
      return gateFailed({
        gateType: "test",
        reason: `${failed} test(s) failed out of ${total}`,
        metadata: {
          passed,
          failed,
          total,
          testCommand: ctx.testCommand || null,
        },
      });
    }

    if (total === 0) {
      return gatePassed({
        gateType: "test",
        reason: "no tests executed",
        metadata: { passed: 0, failed: 0, total: 0 },
      });
    }

    return gatePassed({
      gateType: "test",
      reason: `${passed}/${total} tests passed`,
      metadata: {
        passed,
        failed,
        total,
        testCommand: ctx.testCommand || null,
      },
    });
  },
};

export default testGate;
