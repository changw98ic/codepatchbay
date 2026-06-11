// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";

import * as healthCheck from "../cli/commands/health-check.js";

test("health-check defaults to the unauthenticated health endpoint", () => {
  assert.equal(typeof healthCheck.parseArgs, "function");

  const options = healthCheck.parseArgs([], { CPB_PORT: "4567" });

  assert.equal(options.url, "http://127.0.0.1:4567/api/health");
});

test("health-check delegates tests and web build to repository scripts", async () => {
  assert.equal(typeof healthCheck.check, "function");

  const httpCalls = [];
  const runCalls = [];
  const checks = await healthCheck.check({
    cpbRoot: "/tmp/cpb",
    executorRoot: "/tmp/cpb",
    options: healthCheck.parseArgs([], { CPB_PORT: "4567" }),
    httpCheckFn: async (url, maxAttempts, intervalMs) => {
      httpCalls.push({ url, maxAttempts, intervalMs });
      return true;
    },
    runCmdFn: async (cmd, args, cwd) => {
      runCalls.push({ cmd, args, cwd });
      return { ok: true, output: "" };
    },
  });

  assert.deepEqual(httpCalls, [
    {
      url: "http://127.0.0.1:4567/api/health",
      maxAttempts: 10,
      intervalMs: 3000,
    },
  ]);
  assert.deepEqual(runCalls, [
    { cmd: "npm", args: ["run", "test:node"], cwd: "/tmp/cpb" },
    { cmd: "npm", args: ["run", "build:web"], cwd: "/tmp/cpb" },
  ]);
  assert.deepEqual(checks.map(({ name, ok }) => ({ name, ok })), [
    { name: "http", ok: true },
    { name: "tests", ok: true },
    { name: "build", ok: true },
  ]);
});
