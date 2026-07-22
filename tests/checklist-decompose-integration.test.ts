/**
 * Integration tests for decomposeTaskToChecklistItems: the runAgent → parse →
 * validate → fail-closed orchestration (DECOMP-001/005). Uses a fake pool that
 * mirrors how runAgent maps pool.execute results. Does not go through runJob/
 * freezeChecklist (those are covered by the unit suite + kill-switch gate), so
 * the run-node-tests CPB_CHECKLIST_DECOMPOSE=0 default does not affect this file.
 */
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { decomposeTaskToChecklistItems, resolveCodegraphTaskScope } from "../core/workflow/checklist-decomposer.js";
import { recordValue } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

function makeFakePool(outputOrError, onExecute = null) {
  return {
    async execute(agent, prompt, cwd, timeoutMs, meta) {
      if (onExecute) onExecute({ agent, prompt, cwd, timeoutMs, meta });
      if (outputOrError instanceof Error) throw outputOrError;
      return { output: outputOrError, providerKey: "fake", variant: null };
    },
  };
}

function makeSequencedPool(sequence) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async execute(_agent, _prompt, _cwd, _timeoutMs, _meta) {
      const value = sequence[Math.min(calls, sequence.length - 1)];
      calls += 1;
      if (value instanceof Error) throw value;
      return { output: value, providerKey: "fake", variant: null };
    },
  };
}

function makeCtx(pool) {
  return {
    pool,
    project: "p",
    jobId: "job-decompose",
    sourcePath: ".",
    cpbRoot: ".",
    dataRoot: null,
    env: {},
    agents: { planner: "fake-planner" },
  };
}

const VALID = '```json\n{"status":"ok","decomposedItems":[{"requirement":"support --json","predicateId":"status-json","verificationMethod":"static","allowedFiles":["cli/commands/status.ts"],"sourceRefs":[{"kind":"task_text","locator":"task:0"}]}]}\n```';

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

test("decompose: pool returns valid items -> ok with allowedFiles", async () => {
  const r = await decomposeTaskToChecklistItems({ task: "add --json to status", ctx: makeCtx(makeFakePool(VALID)) });
  assert.equal(r.ok, true);
  assert.equal(r.items!.length, 1);
  assert.equal(r.items![0].predicateId, "status-json");
  assert.deepEqual(r.items![0].allowedFiles, ["cli/commands/status.ts"]);
});

test("decompose: prepare_task agent call receives risk budget env", async () => {
  let observed;
  const ctx = {
    ...makeCtx(makeFakePool(VALID, (call) => { observed = call; })),
    workflow: "complex",
    sourceContext: { riskMap: { riskLevel: "high", domains: ["provider_pool"] } },
    env: {
      CPB_ACP_TOOL_CALL_BUDGET_PREPARE_TASK: "999",
    },
  };

  const r = await decomposeTaskToChecklistItems({ task: "fix provider pool queue behavior", ctx });

  assert.equal(r.ok, true);
  assert.equal(observed.agent, "fake-planner");
  assert.equal(observed.meta.phase, "prepare_task");
  assert.equal(observed.meta.role, "checklist_decomposer");
  assert.equal(observed.meta.env.CPB_TASK_RISK_LEVEL, "high");
  assert.equal(observed.meta.env.CPB_ACP_TOOL_CALL_BUDGET_PREPARE_TASK, "999");
  assert.equal(observed.meta.env.CPB_ACP_TOOL_EVENT_BUDGET_PREPARE_TASK, "0");
  assert.equal(observed.meta.env.CPB_ACP_TOOL_CALL_BUDGET_PLAN, undefined);
  assert.equal(JSON.parse(String(observed.meta.env.CPB_TASK_PHASE_BUDGET_POLICY_JSON)).phases.prepare_task.toolCallBudget, 60);
});

test("decompose: CodeGraph fast path runs with the explicit job env", async () => {
  const root = await tempRoot("cpb-checklist-codegraph-env");
  const command = path.join(root, "codegraph-fixture.sh");
  await writeFile(command, [
    "#!/bin/sh",
    "[ \"$CPB_TEST_MARKER\" = \"job-marker\" ] || exit 11",
    "[ -z \"$CPB_AMBIENT_SECRET\" ] || exit 12",
    "printf '%s\\n' '[{\"node\":{\"kind\":\"function\",\"name\":\"partition\",\"filePath\":\"src/partition.ts\"}}]'",
  ].join("\n") + "\n", "utf8");
  await chmod(command, 0o755);

  const r = await decomposeTaskToChecklistItems({
    task: "Fix partition() without mutating its input.",
    ctx: {
      ...makeCtx(makeFakePool(new Error("agent fallback must not run"))),
      cpbRoot: root,
      sourcePath: root,
      planMode: "light",
      sourceContext: { riskMap: { riskLevel: "low" } },
      env: {
        CPB_CODEGRAPH_COMMAND: command,
        CPB_TEST_MARKER: "job-marker",
      },
    },
  });

  assert.equal(r.ok, true);
  assert.deepEqual(r.items?.[0].allowedFiles, ["src/partition.ts"]);
  assert.equal(recordValue(r.diagnostics).source, "codegraph_exact_symbol");
});

test("decompose: CodeGraph fast path preabort does not query or fall back to agent", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("preabort codegraph", "AbortError"));
  let queryCalls = 0;

  await assert.rejects(
    resolveCodegraphTaskScope({
      task: "Fix partition() without mutating its input.",
      cwd: ".",
      signal: controller.signal,
      query: async () => {
        queryCalls += 1;
        return [];
      },
    }),
    isAbortError,
  );
  assert.equal(queryCalls, 0);

  let agentCalls = 0;
  await assert.rejects(
    decomposeTaskToChecklistItems({
      task: "Fix partition() without mutating its input.",
      ctx: {
        ...makeCtx(makeFakePool(VALID, () => { agentCalls += 1; })),
        planMode: "light",
        sourceContext: { riskMap: { riskLevel: "low" } },
        signal: controller.signal,
      },
    }),
    isAbortError,
  );
  assert.equal(agentCalls, 0);
});

test("decompose: CodeGraph query abort tears down child and grandchild", async () => {
  const root = await tempRoot("cpb-checklist-codegraph-abort-tree");
  const command = path.join(root, "codegraph-hang.mjs");
  const childPidFile = path.join(root, "child.pid");
  const grandchildPidFile = path.join(root, "grandchild.pid");
  await writeFile(command, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`require("fs").writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: "ignore" });
child.unref();
setInterval(() => {}, 1000);
`, "utf8");
  await chmod(command, 0o755);
  const controller = new AbortController();
  const run = resolveCodegraphTaskScope({
    task: "Fix partition() without mutating its input.",
    cwd: root,
    env: {
      ...process.env,
      CPB_CODEGRAPH_COMMAND: command,
      CPB_CHECKLIST_CODEGRAPH_QUERY_TIMEOUT_MS: "10000",
    },
    signal: controller.signal,
  });
  const waitForPid = async (file) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const pid = Number((await readFile(file, "utf8")).trim());
        if (Number.isInteger(pid) && pid > 0) return pid;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`pid file not written: ${file}`);
  };
  const childPid = await waitForPid(childPidFile);
  const grandchildPid = await waitForPid(grandchildPidFile);
  controller.abort(new DOMException("stop codegraph tree", "AbortError"));
  await assert.rejects(run, isAbortError);
  const eventuallyDead = async (pid) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  assert.equal(await eventuallyDead(childPid), true);
  assert.equal(await eventuallyDead(grandchildPid), true);
});

test("decompose: CodeGraph query timeout is bounded and does not fall back to agent", async () => {
  const root = await tempRoot("cpb-checklist-codegraph-timeout");
  const command = path.join(root, "codegraph-timeout.mjs");
  await writeFile(command, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", "utf8");
  await chmod(command, 0o755);

  await assert.rejects(
    decomposeTaskToChecklistItems({
      task: "Fix partition() without mutating its input.",
      ctx: {
        ...makeCtx(makeFakePool(new Error("agent fallback must not run"))),
        cpbRoot: root,
        sourcePath: root,
        planMode: "light",
        sourceContext: { riskMap: { riskLevel: "low" } },
        env: {
          CPB_CODEGRAPH_COMMAND: command,
          CPB_CHECKLIST_CODEGRAPH_QUERY_TIMEOUT_MS: "25",
        },
      },
    }),
    /timed out/,
  );
});

test("decompose: abort after first CodeGraph symbol does not query next symbol or agent", async () => {
  const controller = new AbortController();
  let queryCalls = 0;
  await assert.rejects(
    resolveCodegraphTaskScope({
      task: "Fix alpha() and beta()",
      cwd: ".",
      signal: controller.signal,
      query: async (_symbol, _cwd, signal) => {
        assert.equal(signal, controller.signal);
        queryCalls += 1;
        controller.abort(new DOMException("abort after first symbol", "AbortError"));
        return [];
      },
    }),
    isAbortError,
  );
  assert.equal(queryCalls, 1);
});

test("decompose: pool returns no decomposedItems -> fail-closed", async () => {
  const r = await decomposeTaskToChecklistItems({
    task: "t",
    ctx: makeCtx(makeFakePool('```json\n{"status":"ok","planMarkdown":"not a decomposition"}\n```')),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /decomposed items invalid|not valid JSON/);
});

test("decompose: pool returns malformed JSON -> fail-closed", async () => {
  const r = await decomposeTaskToChecklistItems({
    task: "t",
    ctx: makeCtx(makeFakePool("this is not json at all")),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /not valid JSON/);
});

test("decompose: pool returns items with empty allowedFiles -> fail-closed (scope required)", async () => {
  const r = await decomposeTaskToChecklistItems({
    task: "t",
    ctx: makeCtx(makeFakePool('```json\n{"status":"ok","decomposedItems":[{"requirement":"r","predicateId":"p","verificationMethod":"static","allowedFiles":[]}]}\n```')),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /allowedFiles/);
});

test("decompose: agent (pool) throws -> fail-closed", async () => {
  const r = await decomposeTaskToChecklistItems({
    task: "t",
    ctx: makeCtx(makeFakePool(new Error("agent unavailable"))),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /decompose agent failed/);
});

test("decompose: retryable agent failure preserves kind and retryability", async () => {
  const r = await decomposeTaskToChecklistItems({
    task: "t",
    ctx: {
      ...makeCtx(makeFakePool(new Error("fake-planner exited 1: temporary transport error"))),
      env: { CPB_CHECKLIST_DECOMPOSE_RETRY_MAX: "0" },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, FailureKind.AGENT_EXIT_NONZERO);
  assert.equal(r.retryable, true);
  assert.match(r.reason!, /temporary transport error/);
});

test("decompose: retries retryable agent failure before accepting valid output", async () => {
  const pool = makeSequencedPool([new Error("planner timed out after 10ms"), VALID]);
  const r = await decomposeTaskToChecklistItems({
    task: "add --json to status",
    ctx: {
      ...makeCtx(pool),
      env: {
        CPB_CHECKLIST_DECOMPOSE_RETRY_MAX: "1",
        CPB_CHECKLIST_DECOMPOSE_RETRY_BASE_DELAY_MS: "0",
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(pool.calls, 2);
  assert.equal(r.items![0].predicateId, "status-json");
});

test("decompose: abort during retry backoff returns promptly without a second provider call", async () => {
  const controller = new AbortController();
  const pool = makeSequencedPool([new Error("planner timed out after 10ms"), VALID]);
  setTimeout(() => controller.abort(), 0);

  await assert.rejects(
    decomposeTaskToChecklistItems({
      task: "add --json to status",
      ctx: {
        ...makeCtx(pool),
        signal: controller.signal,
        env: {
          CPB_CHECKLIST_DECOMPOSE_RETRY_MAX: "1",
          CPB_CHECKLIST_DECOMPOSE_RETRY_BASE_DELAY_MS: "10000",
        },
      },
    }),
    isAbortError,
  );

  assert.equal(pool.calls, 1);
});
