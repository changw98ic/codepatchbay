import assert from "node:assert/strict";
import { test } from "node:test";

import type { LooseRecord } from "../core/contracts/types.js";
import { headlessCodexConfigArgs } from "../core/acp/policy.js";

import {
  buildCodingComparisonSummary,
  codingComparisonEvaluationFingerprint,
  codingComparisonInputFingerprint,
  codingComparisonPermissionFingerprint,
  extractCodingComparisonTelemetry,
  parseNativeCodexJsonl,
  validateCodingComparisonManifest,
  type CodingComparisonLaneResult,
} from "../core/evaluation/coding-comparison.js";
import {
  buildSolverLaneInput,
  cleanupCodingComparisonWorkspaces,
  cleanupUnidentifiedComparisonDelegate,
  laneOrderForTask,
  nativeCodexArgs,
} from "../scripts/run-coding-comparison.js";

type MutableManifest = LooseRecord & {
  tasks: Array<LooseRecord & { checks: LooseRecord[] }>;
};

function manifest(overrides: LooseRecord = {}): MutableManifest {
  return {
    schemaVersion: 1,
    tasks: [{
      id: "ordinary-addition-fix",
      repository: "/tmp/example",
      base: "HEAD",
      task: "Fix add() so it returns the sum of both inputs.",
      model: "gpt-5.5",
      reasoningEffort: "high",
      timeoutMs: 120_000,
      checks: [{ id: "public-api", command: "node", args: ["test.js"] }],
    }],
    ...overrides,
  };
}

test("comparison manifest accepts only generic task and post-terminal check fields", () => {
  const parsed = validateCodingComparisonManifest(manifest());
  assert.equal(parsed.tasks[0].task, "Fix add() so it returns the sum of both inputs.");
  assert.deepEqual(parsed.tasks[0].checks[0], {
    id: "public-api",
    command: "node",
    args: ["test.js"],
  });
});

test("comparison manifest rejects benchmark oracle and expected-patch fields", () => {
  const withGold = manifest();
  withGold.tasks[0].gold_patch = "secret";
  assert.throws(() => validateCodingComparisonManifest(withGold), /forbidden solver-oracle field/);
  const withOracle = manifest({ oracle: { answer: true } });
  assert.throws(() => validateCodingComparisonManifest(withOracle), /forbidden solver-oracle field/);
  const withUnknown = manifest();
  withUnknown.tasks[0].promptSuffix = "run hidden checks";
  assert.throws(() => validateCodingComparisonManifest(withUnknown), /unknown field/);
});

test("comparison manifest rejects evaluator cwd escape and shell-shaped args", () => {
  const escaped = manifest();
  (escaped.tasks[0].checks[0] as LooseRecord).cwd = "../outside";
  assert.throws(() => validateCodingComparisonManifest(escaped), /inside the lane worktree/);
  const stringArgs = manifest();
  Reflect.set(stringArgs.tasks[0].checks[0], "args", "test.js");
  assert.throws(() => validateCodingComparisonManifest(stringArgs), /array of strings/);
});

test("solver input fingerprint excludes evaluator commands while evaluator fingerprint tracks them", () => {
  const task = validateCodingComparisonManifest(manifest()).tasks[0];
  const changed = structuredClone(task);
  changed.checks[0].args = ["different-test.js"];
  assert.equal(codingComparisonInputFingerprint(task, "abc"), codingComparisonInputFingerprint(changed, "abc"));
  assert.notEqual(codingComparisonEvaluationFingerprint(task), codingComparisonEvaluationFingerprint(changed));
});

test("native Codex JSONL parser preserves unknown telemetry and counts failed tools", () => {
  const parsed = parseNativeCodexJsonl([
    JSON.stringify({ type: "item.started", item: { id: "tool-1", type: "command_execution", status: "in_progress" } }),
    JSON.stringify({ type: "item.completed", item: { id: "tool-1", type: "command_execution", status: "failed", exit_code: 1 } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }),
    JSON.stringify({ type: "message", last_agent_message: "done" }),
  ].join("\n"));
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.failedToolCalls, 1);
  assert.equal(parsed.totalTokens, 14);
  assert.equal(parsed.cachedInputTokens, null);
  assert.equal(parsed.tokenCoverage, 1);
  assert.equal(parsed.finalOutput, "done");
});

test("comparison telemetry preserves partial coverage instead of inventing zero values", () => {
  const telemetry = extractCodingComparisonTelemetry({ usage: { input_tokens: 9 } });
  assert.equal(telemetry.inputTokens, 9);
  assert.equal(telemetry.outputTokens, null);
  assert.equal(telemetry.totalTokens, null);
  assert.equal(telemetry.tokenCoverage, 1 / 3);
});

test("lane rotation and permission contract are deterministic", () => {
  assert.deepEqual(laneOrderForTask(0), ["native_codex", "cpb_codex", "cpb_smart"]);
  assert.deepEqual(laneOrderForTask(1), ["cpb_codex", "cpb_smart", "native_codex"]);
  assert.match(codingComparisonPermissionFingerprint(), /^sha256:[0-9a-f]{64}$/);
});

test("solver lane input excludes every post-terminal evaluator field", () => {
  const task = validateCodingComparisonManifest(manifest()).tasks[0];
  const input = buildSolverLaneInput({
    lane: "cpb_codex",
    task,
    baseSha: "abc",
    worktree: "/tmp/worktree",
    cpbRoot: "/tmp/cpb",
    hubRoot: "/tmp/hub",
    project: "project",
    projectRuntimeRoot: "/tmp/hub/projects/project",
    jobId: "job-project",
  });
  assert.equal(Object.hasOwn(input, "checks"), false);
  assert.equal(Object.hasOwn(input, "evaluationFingerprint"), false);
  assert.equal(JSON.stringify(input).includes("test.js"), false);
  assert.equal(input.workflow, "standard");
  assert.equal(input.planMode, "light");
});

test("native Codex uses the same headless worktree-write contract and CodeGraph tool", () => {
  const task = validateCodingComparisonManifest(manifest()).tasks[0];
  const args = nativeCodexArgs(task, "/tmp/worktree");
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "--ephemeral", "--ignore-user-config"]);
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes("features.apps=false"));
  assert.ok(args.includes("features.plugins=false"));
  assert.ok(args.includes("features.remote_plugin=false"));
  assert.ok(args.some((arg) => arg.includes("mcp_servers.codegraph")));
  assert.equal(args.some((arg) => arg.includes("test.js")), false);
});

test("CPB Codex headless launches exclude undeclared remote apps and plugins", () => {
  const args = headlessCodexConfigArgs("codex-acp");
  assert.ok(args.includes("features.apps=false"));
  assert.ok(args.includes("features.plugins=false"));
  assert.ok(args.includes("features.remote_plugin=false"));
});

test("comparison quota delegate cleanup refuses bare-PID termination without exact identity", async () => {
  let killCalls = 0;
  let stdinClosed = false;
  let stderrDestroyed = false;
  const child = {
    pid: 24690,
    exitCode: null,
    signalCode: null,
    kill() {
      killCalls += 1;
      return true;
    },
    stdin: {
      destroyed: false,
      end() {
        stdinClosed = true;
      },
    },
    stderr: {
      destroy() {
        stderrDestroyed = true;
      },
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      void event;
      void listener;
      return child;
    },
  };

  await assert.rejects(
    cleanupUnidentifiedComparisonDelegate(child as never),
    (error) => {
      assert.equal((error as NodeJS.ErrnoException).code, "PROCESS_CLEANUP_UNVERIFIED");
      assert.match((error as Error).message, /did not exit before cleanup deadline/);
      return true;
    },
  );
  assert.equal(killCalls, 0);
  assert.equal(stdinClosed, true);
  assert.equal(stderrDestroyed, true);
});

test("comparison cleanup preserves the repository root when any worktree cleanup fails", async () => {
  const order: string[] = [];
  const cleanupFailure = new Error("worktree registration still active");
  const root = {
    rootPath: "/tmp/comparison-root",
    cleanup: async () => {
      order.push("root");
      return {} as never;
    },
  };
  const first = {
    rootPath: "/tmp/worktree-one",
    cleanup: async () => {
      order.push("first");
      return {} as never;
    },
  };
  const second = {
    rootPath: "/tmp/worktree-two",
    cleanup: async () => {
      order.push("second");
      throw cleanupFailure;
    },
  };

  const cleanup = await cleanupCodingComparisonWorkspaces(
    root,
    [first, second] as never,
  );

  assert.deepEqual(order, ["second", "first"]);
  assert.equal(cleanup.root, null);
  assert.equal(cleanup.rootPreservedForWorktreeRecovery, true);
  assert.deepEqual(cleanup.errors, [cleanupFailure]);
});

test("comparison cleanup closes every worktree before its mirror repository root", async () => {
  const order: string[] = [];
  const rootProof = { kind: "root" };
  const root = {
    rootPath: "/tmp/comparison-root",
    cleanup: async () => {
      order.push("root");
      return rootProof as never;
    },
  };
  const worktrees = ["first", "second"].map((name) => ({
    rootPath: `/tmp/${name}`,
    cleanup: async () => {
      order.push(name);
      return { kind: name } as never;
    },
  }));

  const cleanup = await cleanupCodingComparisonWorkspaces(root, worktrees as never);

  assert.deepEqual(order, ["second", "first", "root"]);
  assert.equal(cleanup.root, rootProof);
  assert.equal(cleanup.rootPreservedForWorktreeRecovery, false);
  assert.equal(cleanup.errors.length, 0);
});

function laneResult(lane, correct): CodingComparisonLaneResult {
  return {
    lane,
    taskId: "task-1",
    inputFingerprint: "sha256:input",
    evaluationFingerprint: "sha256:evaluation",
    permissionFingerprint: codingComparisonPermissionFingerprint(),
    baseSha: "abc",
    model: "gpt-5.5",
    reasoningEffort: "high",
    timeoutMs: 1000,
    status: correct ? "completed" : "failed",
    metrics: {
      correct,
      firstPass: correct,
      repairCount: 0,
      toolCalls: null,
      failedToolCalls: null,
      solverElapsedMs: 10,
      evaluationElapsedMs: 2,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      tokenCoverage: 0,
    },
  };
}

test("comparison summary identifies CPB-Codex regressions without fabricating metrics", () => {
  const summary = buildCodingComparisonSummary([
    laneResult("native_codex", true),
    laneResult("cpb_codex", false),
    laneResult("cpb_smart", true),
  ]);
  assert.equal(summary.fairnessComplete, true);
  assert.deepEqual(summary.cpbCodexRegressions, ["task-1"]);
  assert.equal(summary.lanes[0].toolCalls, null);
  assert.equal(summary.lanes[0].tokenCoverage, 0);
});
