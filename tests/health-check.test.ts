import assert from "node:assert/strict";
import { test } from "node:test";

import * as healthCheck from "../cli/commands/health-check.js";

test("health-check parseArgs returns valid defaults", () => {
  assert.equal(typeof healthCheck.parseArgs, "function");

  const options = healthCheck.parseArgs([]);
  assert.equal(options.skipTests, false);
  assert.equal(options.fakeAcpSmoke, false);
  assert.equal(options.help, false);
});

test("health-check delegates tests to repository scripts", async () => {
  assert.equal(typeof healthCheck.check, "function");

  const runCalls = [];
  const checks = await healthCheck.check({
    cpbRoot: "/tmp/cpb",
    executorRoot: "/tmp/cpb",
    options: healthCheck.parseArgs([]),
    runCmdFn: async (cmd, args, cwd) => {
      runCalls.push({ cmd, args, cwd });
      return { ok: true, output: "" };
    },
  });

  assert.deepEqual(runCalls, [
    { cmd: "npm", args: ["run", "test:node"], cwd: "/tmp/cpb" },
  ]);
  assert.deepEqual(checks.map(({ name, ok }) => ({ name, ok })), [
    { name: "tests", ok: true },
  ]);
});
