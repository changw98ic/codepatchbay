// @ts-nocheck
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run as runDwStatus } from "../cli/commands/dw-status.js";

test("dw-status prints explicit DAG readiness labels without claiming parallel execution", async () => {
  const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-dw-status-"));
  const cpbHome = await mkdtemp(path.join(os.tmpdir(), "cpb-dw-home-"));
  const priorEnv = {
    CPB_HOME: process.env.CPB_HOME,
    CPB_PROJECT_RUNTIME_ROOT: process.env.CPB_PROJECT_RUNTIME_ROOT,
    CPB_HUB_ROOT: process.env.CPB_HUB_ROOT,
  };
  const lines = [];
  const priorLog = console.log;

  try {
    process.env.CPB_HOME = cpbHome;
    delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    delete process.env.CPB_HUB_ROOT;
    console.log = (...args) => {
      lines.push(args.join(" "));
    };

    await runDwStatus([], { cpbRoot, executorRoot: process.cwd() });
    const output = lines.join("\n");

    assert.match(output, /dag_metadata_ready\s*:\s*true/);
    assert.match(output, /dag_node_first_sequential_ready\s*:\s*true/);
    assert.match(output, /dag_resume_ready\s*:\s*true/);
    assert.match(output, /dag_parallel_execution_ready\s*:\s*false/);
    assert.doesNotMatch(output, /dag_parallel_execution_ready\s*:\s*true/);
  } finally {
    console.log = priorLog;
    if (priorEnv.CPB_HOME === undefined) delete process.env.CPB_HOME;
    else process.env.CPB_HOME = priorEnv.CPB_HOME;
    if (priorEnv.CPB_PROJECT_RUNTIME_ROOT === undefined) delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    else process.env.CPB_PROJECT_RUNTIME_ROOT = priorEnv.CPB_PROJECT_RUNTIME_ROOT;
    if (priorEnv.CPB_HUB_ROOT === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = priorEnv.CPB_HUB_ROOT;
  }
});

test("dw-status uses exported contracts instead of source string probes", async () => {
  const sourcePath = [
    path.join(process.cwd(), "cli", "commands", "dw-status.ts"),
    path.join(process.cwd(), "..", "cli", "commands", "dw-status.ts"),
  ].find((candidate) => existsSync(candidate));
  assert.ok(sourcePath, "dw-status.ts source should be available for contract-regression checks");
  const source = await readFile(sourcePath, "utf8");
  assert.doesNotMatch(source, /fileContains/);
  assert.doesNotMatch(source, /readFile/);
  assert.match(source, /checkModuleContract/);
});
