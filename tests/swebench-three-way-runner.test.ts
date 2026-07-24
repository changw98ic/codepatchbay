import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  killTree,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../core/runtime/process-tree.js";
import {
  buildFrozenManifests,
  promptLeakageViolations,
  summarizeCandidateFreeze,
  classifySolverOutcome,
  correlateSolverAndHarnessOutcomes,
  isTransientSolverFailure,
  solverRetryDelayMs,
  isRetryableDatasetStatus,
  isTransientSourceFetchFailure,
  harnessResumeDecision,
  buildHarnessEnvironment,
  buildExecutionContract,
  buildDatasetCacheEnvelope,
  buildNativeClaudeIsolatedEnv,
  buildNativeClaudeSettings,
  buildNativeClaudeArgs,
  observedModelAttestation,
  observedModelContractViolation,
  sliceValidatedDatasetCacheEnvelope,
  validateDatasetCacheEnvelope,
  latestCandidateReplayBundle,
  parseHarnessInstanceReport,
  selectHarnessRetryIds,
  summarizeHarnessTestMetrics,
  nextHarnessAttemptNumber,
  parseRuntimeRoots,
  runtimePackageCacheDenyRoots,
  findBoundaryProbeTarget,
  discoverExecutablePackageRoots,
  runtimeConfigReadRoots,
  evaluateBoundaryProbe,
  parseClaudeRuntimeBoundaryStream,
  claudeRuntimeBoundaryRetryReason,
  assertRunNotInvalidated,
  agentLaunchContractViolation,
  independentVerificationContractViolation,
  archiveLaneAttempt,
  prepareLaneForSolverInvocation,
  parseSolverLaneConcurrency,
  runIndependentLaneQueues,
  reconcileInterruptedSolverInvocations,
  compactLaneEphemeralArtifacts,
  quarantineSweBenchRunPath,
  prepareSource,
  sourceCacheLockDirectory,
  withSourceCacheLock,
  recoverInterruptedClaudeBoundaryPreflight,
  nextSolverAttemptNumber,
  recoverHarnessInstanceReports,
  runHarness,
  runCommand,
  startQuotaDelegate,
  commitHarnessJsonArtifacts,
  harnessArtifactOwnerAlive,
  withHarnessArtifactLockTestHooks,
  installCliSignalHandlers,
  type HarnessInstanceResult,
} from "../scripts/run-swebench-three-way.js";
import {
  cleanupScopedCodegraphDaemons,
  runCommand as runProductValidationCommand,
  runManagedWorker,
} from "../scripts/run-swebench-product-validation.js";
import {
  AssignmentStore,
  withAssignmentStoreTestHooksForTests,
  type AssignmentStoreTestHooks,
} from "../shared/orchestrator/assignment-store.js";
import { tempRoot } from "./helpers.js";

const assignmentStoreTestHookScope = new AsyncLocalStorage<AssignmentStoreTestHooks>();
const __assignmentStoreTestHooks = new Proxy({} as AssignmentStoreTestHooks, {
  get(_target, property) {
    return Reflect.get(assignmentStoreTestHookScope.getStore() || {}, property);
  },
  set(_target, property, value) {
    const hooks = assignmentStoreTestHookScope.getStore();
    if (!hooks) throw new Error("assignment store test hook mutation requires a scoped test");
    return Reflect.set(hooks, property, value);
  },
  deleteProperty(_target, property) {
    const hooks = assignmentStoreTestHookScope.getStore();
    if (!hooks) return true;
    return Reflect.deleteProperty(hooks, property);
  },
});

function test(name: string, fn: (context: TestContext) => void | Promise<void>) {
  return nodeTest(name, (context) => {
    const hooks: AssignmentStoreTestHooks = {};
    return assignmentStoreTestHookScope.run(
      hooks,
      () => withAssignmentStoreTestHooksForTests(hooks, () => fn(context)),
    );
  });
}

const row = {
  instance_id: "owner__repo-123",
  repo: "owner/repo",
  base_commit: "0123456789abcdef",
  problem_statement: "Fix the cache invalidation bug for renamed keys.",
  FAIL_TO_PASS: JSON.stringify(["tests/test_cache.py::test_rename"]),
  PASS_TO_PASS: JSON.stringify(["tests/test_cache.py::test_get"]),
};

async function waitForCondition(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function pidIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function nestedErrorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [
      String(error),
      ...error.errors.flatMap((nested) => nestedErrorMessages(nested)),
      ...(error.cause === undefined ? [] : nestedErrorMessages(error.cause)),
    ];
  }
  return [
    String(error),
    ...(error instanceof Error && error.cause !== undefined ? nestedErrorMessages(error.cause) : []),
  ];
}

function nestedErrorMatches(error: unknown, pattern: RegExp) {
  return nestedErrorMessages(error).some((message) => pattern.test(message));
}

async function harnessArtifactScratch(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  const entry = entries.find((candidate) => (
    candidate.isDirectory()
    && candidate.name.startsWith("cpb-harness-artifacts-")
    && candidate.name !== ".cpb-harness-artifacts.lock"
  ));
  assert.ok(entry, "expected harness artifact transaction scratch directory");
  return path.join(root, entry.name);
}

async function fileExists(filePath: string) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function syntheticExactIdentity(pid: number, birthId = `test-birth-${pid}`): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-07-21T00:00:00.000Z",
    birthIdPrecision: "exact",
  };
}

function claudeBoundaryOwner(
  preflightRoot: string,
  pid: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    format: "cpb-claude-boundary-owner/v1",
    ownerToken: `00000000-0000-4000-8000-${String(pid).padStart(12, "0")}`,
    preflightRoot: path.resolve(preflightRoot),
    host: "test-host",
    pid,
    startedAt: "2026-07-21T00:00:00.000Z",
    processIdentity: syntheticExactIdentity(pid),
    ...overrides,
  };
}

async function withTemporaryEnv<T>(updates: Record<string, string | undefined>, callback: () => Promise<T> | T) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function spawnExactIdentityFixture() {
  const child = spawnChild(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
  ], { stdio: "ignore" });
  assert.ok(child.pid, "expected identity fixture pid");
  let identity: ProcessIdentity | null = null;
  const captured = await waitForCondition(() => {
    try {
      identity = captureProcessIdentity(child.pid as number, { strict: true });
      return identity !== null;
    } catch {
      return false;
    }
  });
  if (!captured || !identity) {
    child.kill("SIGTERM");
    throw new Error(`could not capture exact identity fixture for pid ${child.pid}`);
  }
  return {
    child,
    identity,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      await closed;
    },
  };
}

test("runCommand returns a pre-aborted result without spawning", async () => {
  const controller = new AbortController();
  controller.abort("test pre-abort");
  const root = await tempRoot("cpb-run-command-preabort-logs");
  const logs = {
    stdoutPath: path.join(root, "stdout.log"),
    stderrPath: path.join(root, "stderr.log"),
    activityPath: path.join(root, "activity.jsonl"),
  };
  const result = await runCommand({
    command: "definitely-not-a-real-cpb-command",
    args: [],
    cwd: process.cwd(),
    timeoutMs: 30_000,
    logs,
    signal: controller.signal,
  });

  assert.equal(result.code, null);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, true);
  assert.equal(result.error, "test pre-abort");
  assert.equal(await fileExists(logs.stdoutPath), false);
  assert.equal(await fileExists(logs.stderrPath), false);
  assert.equal(await fileExists(logs.activityPath), false);
});

test("runCommand initializes empty logs transactionally before recording output", async () => {
  const root = await tempRoot("cpb-run-command-log-init-success");
  const logs = {
    stdoutPath: path.join(root, "stdout.log"),
    stderrPath: path.join(root, "stderr.log"),
    activityPath: path.join(root, "activity.jsonl"),
  };
  await writeFile(logs.stdoutPath, "stale stdout\n", "utf8");
  await writeFile(logs.stderrPath, "stale stderr\n", "utf8");
  await writeFile(logs.activityPath, "stale activity\n", "utf8");

  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('fresh stdout\\n'); process.stderr.write('fresh stderr\\n');"],
    cwd: process.cwd(),
    timeoutMs: 30_000,
    logs,
  });

  assert.equal(result.code, 0);
  assert.equal(await readFile(logs.stdoutPath, "utf8"), "fresh stdout\n");
  assert.equal(await readFile(logs.stderrPath, "utf8"), "fresh stderr\n");
  const activity = (await readFile(logs.activityPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(activity.map((entry) => entry.stream).sort(), ["stderr", "stdout"]);
});

test("runCommand log initialization abort preserves preexisting logs and removes temporary files", async () => {
  const controller = new AbortController();
  const root = await tempRoot("cpb-run-command-log-init-transaction");
  const logs = {
    stdoutPath: path.join(root, "stdout.log"),
    stderrPath: path.join(root, "stderr.log"),
    activityPath: path.join(root, "activity.jsonl"),
    beforeCommitForTest: () => controller.abort("abort during log init"),
  };
  await writeFile(logs.stdoutPath, "old stdout\n", "utf8");
  await writeFile(logs.stderrPath, "old stderr\n", "utf8");
  await writeFile(logs.activityPath, "old activity\n", "utf8");

  const result = await runCommand({
    command: "definitely-not-a-real-cpb-command",
    args: [],
    cwd: process.cwd(),
    timeoutMs: 30_000,
    logs,
    signal: controller.signal,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.error, "abort during log init");
  assert.equal(await readFile(logs.stdoutPath, "utf8"), "old stdout\n");
  assert.equal(await readFile(logs.stderrPath, "utf8"), "old stderr\n");
  assert.equal(await readFile(logs.activityPath, "utf8"), "old activity\n");
  assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".tmp-")), []);
});

test("runCommand log initialization rolls back every target when abort lands mid-commit", async () => {
  const controller = new AbortController();
  const root = await tempRoot("cpb-run-command-log-init-mid-commit");
  const logs = {
    stdoutPath: path.join(root, "stdout.log"),
    stderrPath: path.join(root, "stderr.log"),
    activityPath: path.join(root, "activity.jsonl"),
    afterTargetCommitForTest: (_targetPath: string, index: number) => {
      if (index === 0) controller.abort("abort after first log publish");
    },
  };
  await writeFile(logs.stdoutPath, "old stdout\n", "utf8");
  await writeFile(logs.stderrPath, "old stderr\n", "utf8");
  await writeFile(logs.activityPath, "old activity\n", "utf8");

  const result = await runCommand({
    command: "definitely-not-a-real-cpb-command",
    args: [],
    cwd: process.cwd(),
    timeoutMs: 30_000,
    logs,
    signal: controller.signal,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.error, "abort after first log publish");
  assert.equal(await readFile(logs.stdoutPath, "utf8"), "old stdout\n");
  assert.equal(await readFile(logs.stderrPath, "utf8"), "old stderr\n");
  assert.equal(await readFile(logs.activityPath, "utf8"), "old activity\n");
  assert.deepEqual(
    (await readdir(root)).filter((entry) => entry.includes(".tmp-") || entry.includes(".backup-")),
    [],
  );
});

test("runCommand log initialization preserves abort and rollback-cleanup failures together", async () => {
  const controller = new AbortController();
  const root = await tempRoot("cpb-run-command-log-init-dual-failure");
  const logs = {
    stdoutPath: path.join(root, "stdout.log"),
    stderrPath: path.join(root, "stderr.log"),
    activityPath: path.join(root, "activity.jsonl"),
    afterTargetCommitForTest: (_targetPath: string, index: number) => {
      if (index === 0) controller.abort("abort before hostile log rollback");
    },
  };
  await writeFile(logs.stdoutPath, "old stdout\n", "utf8");
  await writeFile(logs.stderrPath, "old stderr\n", "utf8");
  await writeFile(logs.activityPath, "old activity\n", "utf8");
  let displacedPath = "";
  let successorPath = "";

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      beforeArtifactRemove: async ({ phase, artifactPath }) => {
        if (phase !== "rollback-quarantine-remove" || successorPath) return;
        successorPath = artifactPath;
        displacedPath = `${artifactPath}.displaced`;
        await rename(artifactPath, displacedPath);
        await writeFile(artifactPath, "hostile successor\n", "utf8");
      },
    }, () => runCommand({
      command: "definitely-not-a-real-cpb-command",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      logs,
      signal: controller.signal,
    })),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(nestedErrorMatches(error, /abort before hostile log rollback/), true);
      assert.equal(nestedErrorMatches(error, /successor/), true);
      return true;
    },
  );

  assert.equal(await readFile(logs.stdoutPath, "utf8"), "old stdout\n");
  assert.equal(await readFile(logs.stderrPath, "utf8"), "old stderr\n");
  assert.equal(await readFile(logs.activityPath, "utf8"), "old activity\n");
  assert.equal(await readFile(successorPath, "utf8"), "hostile successor\n");
  assert.equal(await fileExists(displacedPath), true);
});

test("runCommand abort tears down the child process group including grandchildren", async () => {
  const root = await tempRoot("cpb-run-command-abort-tree");
  const grandchildPidPath = path.join(root, "grandchild.pid");
  const grandchildTermPath = path.join(root, "grandchild-term.txt");
  const grandchildReadyPath = path.join(root, "grandchild-ready.txt");
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const [pidPath, termPath, readyPath] = process.argv.slice(1);",
    "const grandchild = spawn(process.execPath, ['-e', `",
    "const fs = require('node:fs');",
    "const [termPath, readyPath] = process.argv.slice(1);",
    "process.on('SIGTERM', () => { fs.writeFileSync(termPath, 'SIGTERM'); setTimeout(() => process.exit(0), 10); });",
    "fs.writeFileSync(readyPath, 'ready');",
    "setInterval(() => {}, 1000);",
    "` , termPath, readyPath], { stdio: 'ignore' });",
    "fs.writeFileSync(pidPath, String(grandchild.pid));",
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const controller = new AbortController();
  const { result, grandchildPid } = await withTemporaryEnv({ CPB_KILL_GRACE_MS: "20" }, async () => {
    const pending = runCommand({
      command: process.execPath,
      args: ["-e", script, grandchildPidPath, grandchildTermPath, grandchildReadyPath],
      cwd: root,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    assert.equal(await waitForCondition(async () => {
      try {
        return Number(await readFile(grandchildPidPath, "utf8")) > 0;
      } catch {
        return false;
      }
    }), true);
    const spawnedGrandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
    assert.equal(await waitForCondition(async () => {
      try {
        return (await readFile(grandchildReadyPath, "utf8")) === "ready";
      } catch {
        return false;
      }
    }), true);
    controller.abort("test active abort");
    return { result: await pending, grandchildPid: spawnedGrandchildPid };
  });

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, "test active abort");
  assert.equal(
    await waitForCondition(async () => {
      try {
        return (await readFile(grandchildTermPath, "utf8")) === "SIGTERM";
      } catch {
        return false;
      }
    }),
    true,
  );
  assert.equal(pidIsAlive(grandchildPid), false);
});

test("runCommand aggregates the abort reason with verified tree-cleanup failure", async () => {
  const root = await tempRoot("cpb-run-command-cleanup-failure");
  const controller = new AbortController();
  const enumerationFailure = Object.assign(new Error("process enumeration unavailable during cleanup"), {
    code: "PROCESS_ENUMERATION_UNAVAILABLE",
  });
  const processTreeSystemForTest: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => ({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 1,
      signal: null,
      error: enumerationFailure,
    })) as unknown as ProcessTreeSystem["spawnSync"],
    kill: process.kill,
    captureIdentity: (pid) => captureProcessIdentity(pid, { strict: true }),
  };
  const pending = runCommand({
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"],
    cwd: root,
    timeoutMs: 30_000,
    signal: controller.signal,
    processTreeSystemForTest,
  });

  controller.abort("test cleanup failure");
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(nestedErrorMatches(error, /test cleanup failure/), true);
    assert.equal(nestedErrorMatches(error, /process enumeration unavailable during descendant cleanup/), true);
    return true;
  });
});

async function writeFakeHarnessPython(root: string) {
  const fakePython = path.join(root, "fake-harness-python.cjs");
  await writeFile(fakePython, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "if (process.argv.includes('-c')) process.exit(0);",
    "if (process.env.CPB_FAKE_HARNESS_STARTED_FILE) fs.writeFileSync(process.env.CPB_FAKE_HARNESS_STARTED_FILE, 'started');",
    "if (process.env.CPB_FAKE_HARNESS_WRITE_REPORTS === '1') {",
    "  const arg = (name) => process.argv[process.argv.indexOf(name) + 1];",
    "  const runId = arg('--run_id');",
    "  const reportDir = arg('--report_dir');",
    "  const ids = process.argv.slice(process.argv.indexOf('--instance_ids') + 1);",
    "  const lane = process.env.CPB_FAKE_HARNESS_LANE || 'native_codex';",
    "  for (const id of ids) {",
    "    const dir = require('node:path').join(process.cwd(), 'logs', 'run_evaluation', runId, lane, id);",
    "    fs.mkdirSync(dir, { recursive: true });",
    "    fs.writeFileSync(require('node:path').join(dir, 'report.json'), JSON.stringify({ [id]: { resolved: true, tests_status: { FAIL_TO_PASS: { success: ['a'], failure: [] }, PASS_TO_PASS: { success: ['b'], failure: [] } } } }));",
    "  }",
    "  fs.writeFileSync(require('node:path').join(process.cwd(), `${lane}.${runId}.json`), JSON.stringify({ empty_patch_ids: [] }));",
    "}",
    "const sleepMs = Number(process.env.CPB_FAKE_HARNESS_SLEEP_MS || 0);",
    "setTimeout(() => process.exit(Number(process.env.CPB_FAKE_HARNESS_EXIT_CODE || 0)), sleepMs);",
  ].join("\n"), "utf8");
  await chmod(fakePython, 0o755);
  return fakePython;
}

function harnessTestOptions(runRoot: string, signal: AbortSignal, overrides: Record<string, unknown> = {}) {
  return {
    runRoot,
    runId: "harness-abort-test",
    count: 1,
    offset: 0,
    timeoutMs: 30_000,
    solverLaneConcurrency: { native_codex: 1, native_claude_glm: 1, cpb_high_assurance: 1 },
    solverAttempts: 1,
    solverRetryBackoffMs: 10,
    codexModel: "",
    codexReasoningEffort: "",
    glmModel: "",
    harnessTimeoutSeconds: 1,
    maxHarnessWorkers: 1,
    harnessAttempts: 2,
    harnessRetryBackoffMs: 1_000,
    execute: false,
    score: true,
    keepFailed: false,
    lanes: ["native_codex"],
    signal,
    ...overrides,
  } as Parameters<typeof runHarness>[3];
}

async function writeHarnessPredictions(root: string) {
  const predictionsPath = path.join(root, "predictions.jsonl");
  await writeFile(predictionsPath, `${JSON.stringify({ instance_id: "owner__repo-123", model_patch: "diff --git a/a b/a\n" })}\n`, "utf8");
  return predictionsPath;
}

const harnessEvaluatorTasks = [{
  opaqueId: "owner__repo-123",
  rowIndex: 0,
  instanceId: "owner__repo-123",
  failToPass: ["tests/test_cache.py::test_rename"],
  passToPass: ["tests/test_cache.py::test_get"],
}];

test("official harness abort after command start leaves no command artifacts", async () => {
  const root = await tempRoot("cpb-harness-command-abort-no-artifacts");
  const fakePython = await writeFakeHarnessPython(root);
  const predictionsPath = await writeHarnessPredictions(root);
  const startedPath = path.join(root, "started.txt");
  const controller = new AbortController();
  const pending = withTemporaryEnv({
    CPB_SWEBENCH_HARNESS_PYTHON: fakePython,
    CPB_FAKE_HARNESS_STARTED_FILE: startedPath,
    CPB_FAKE_HARNESS_SLEEP_MS: "30000",
    CPB_KILL_GRACE_MS: "20",
  }, async () => runHarness("native_codex", predictionsPath, harnessEvaluatorTasks, harnessTestOptions(root, controller.signal)));

  assert.equal(await waitForCondition(() => fileExists(startedPath), 10_000), true);
  controller.abort("abort harness command");
  await assert.rejects(pending, /abort harness command/);

  const attemptRoot = path.join(root, "harness", "native_codex", "attempts", "attempt-001");
  for (const artifact of ["predictions.jsonl", "command.full.txt", "command.json", "stdout.log", "stderr.log", "result.json"]) {
    assert.equal(await fileExists(path.join(attemptRoot, artifact)), false, `${artifact} should not be written after abort`);
  }
  assert.equal(await fileExists(attemptRoot), false, "uncommitted attempt root should be removed after abort");
});

test("official harness preabort does not create the harness root", async () => {
  const root = await tempRoot("cpb-harness-preabort-no-root");
  const predictionsPath = await writeHarnessPredictions(root);
  const controller = new AbortController();
  controller.abort("preabort harness");

  await assert.rejects(
    () => runHarness("native_codex", predictionsPath, harnessEvaluatorTasks, harnessTestOptions(root, controller.signal)),
    /preabort harness/,
  );
  assert.equal(await fileExists(path.join(root, "harness")), false);
});

test("official harness abort during attempt setup quarantines the owned attempt with recovery evidence", async () => {
  const root = await tempRoot("cpb-harness-attempt-window-cleanup");
  const fakePython = await writeFakeHarnessPython(root);
  const predictionsPath = await writeHarnessPredictions(root);
  const controller = new AbortController();
  const attemptRoot = path.join(root, "harness", "native_codex", "attempts", "attempt-001");
  const attemptPredictionsPath = path.join(attemptRoot, "predictions.jsonl");

  const pending = withTemporaryEnv({
    CPB_SWEBENCH_HARNESS_PYTHON: fakePython,
    CPB_FAKE_HARNESS_SLEEP_MS: "30000",
    CPB_KILL_GRACE_MS: "20",
  }, async () => runHarness("native_codex", predictionsPath, harnessEvaluatorTasks, harnessTestOptions(root, controller.signal)));

  assert.equal(await waitForCondition(() => fileExists(attemptPredictionsPath)), true);
  controller.abort("abort during attempt setup");
  let cleanupDisposition: { quarantinePath: string } | null = null;
  await assert.rejects(pending, (error: unknown) => {
    assert.match(String(error), /abort during attempt setup/);
    cleanupDisposition = (error as { cleanupDisposition?: { quarantinePath: string } }).cleanupDisposition || null;
    assert.ok(cleanupDisposition);
    assert.ok((error as { recoveryPaths?: string[] }).recoveryPaths?.includes(cleanupDisposition.quarantinePath));
    return true;
  });
  assert.equal(await fileExists(attemptPredictionsPath), false);
  assert.equal(await fileExists(attemptRoot), false);
  assert.equal(
    await readFile(path.join((cleanupDisposition as { quarantinePath: string }).quarantinePath, "predictions.jsonl"), "utf8"),
    await readFile(predictionsPath, "utf8"),
  );
});

test("official harness retry delay abort does not start or write the next attempt", async () => {
  const root = await tempRoot("cpb-harness-retry-abort-no-next-attempt");
  const fakePython = await writeFakeHarnessPython(root);
  const predictionsPath = await writeHarnessPredictions(root);
  const controller = new AbortController();
  const pending = withTemporaryEnv({
    CPB_SWEBENCH_HARNESS_PYTHON: fakePython,
    CPB_FAKE_HARNESS_SLEEP_MS: "0",
  }, async () => runHarness("native_codex", predictionsPath, harnessEvaluatorTasks, harnessTestOptions(root, controller.signal, {
    harnessRetryBackoffMs: 30_000,
  })));

  const firstSummaryPath = path.join(root, "harness", "native_codex", "attempts", "attempt-001", "attempt-summary.json");
  assert.equal(await waitForCondition(() => fileExists(firstSummaryPath)), true);
  controller.abort("abort harness retry delay");
  await assert.rejects(pending, /abort harness retry delay/);

  const secondAttemptRoot = path.join(root, "harness", "native_codex", "attempts", "attempt-002");
  for (const artifact of ["command.full.txt", "command.json", "stdout.log", "stderr.log", "result.json", "attempt-summary.json"]) {
    assert.equal(await fileExists(path.join(secondAttemptRoot, artifact)), false, `${artifact} should not be written for an aborted retry attempt`);
  }
});

test("official harness abort cleanup failure preserves the original abort", async () => {
  const root = await tempRoot("cpb-harness-attempt-cleanup-aggregate");
  const fakePython = await writeFakeHarnessPython(root);
  const predictionsPath = await writeHarnessPredictions(root);
  const controller = new AbortController();
  const attemptRoot = path.join(root, "harness", "native_codex", "attempts", "attempt-001");
  const attemptPredictionsPath = path.join(attemptRoot, "predictions.jsonl");

  const pending = withTemporaryEnv({
    CPB_SWEBENCH_HARNESS_PYTHON: fakePython,
    CPB_FAKE_HARNESS_SLEEP_MS: "30000",
    CPB_KILL_GRACE_MS: "20",
  }, async () => runHarness("native_codex", predictionsPath, harnessEvaluatorTasks, harnessTestOptions(root, controller.signal, {
    removeAttemptRootForTest: async () => {
      throw new Error("attempt cleanup rm failed");
    },
  })));

  assert.equal(await waitForCondition(() => fileExists(attemptPredictionsPath)), true);
  controller.abort("abort with cleanup failure");
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    const aggregate = error as AggregateError;
    assert.match(String(aggregate.errors[0]), /abort with cleanup failure/);
    assert.match(String(aggregate.errors[1]), /attempt cleanup rm failed/);
    return true;
  });
});

test("official harness final artifact abort rolls back partial final-looking files and preserves previous resume artifacts", async () => {
  const root = await tempRoot("cpb-harness-final-commit-rollback");
  const fakePython = await writeFakeHarnessPython(root);
  const predictionsPath = await writeHarnessPredictions(root);
  const harnessRoot = path.join(root, "harness", "native_codex");
  await mkdir(harnessRoot, { recursive: true });
  const previousSummary = {
    lane: "native_codex",
    runId: "harness-abort-test-native_codex",
    predictionsSha256: createHash("sha256").update(await readFile(predictionsPath)).digest("hex"),
    totalInstances: 1,
    instanceResults: [{ instanceId: "owner__repo-123", resolved: false }],
    aggregatePath: path.join(harnessRoot, "official-merged-report.json"),
  };
  await writeFile(path.join(harnessRoot, "official-score-summary.json"), JSON.stringify(previousSummary) + "\n", "utf8");
  await writeFile(path.join(harnessRoot, "official-merged-report.json"), JSON.stringify({ previous: true }) + "\n", "utf8");
  const controller = new AbortController();
  let artifactCount = 0;

  await withTemporaryEnv({
    CPB_SWEBENCH_HARNESS_PYTHON: fakePython,
    CPB_FAKE_HARNESS_WRITE_REPORTS: "1",
  }, async () => {
    await assert.rejects(() => runHarness("native_codex", predictionsPath, harnessEvaluatorTasks, harnessTestOptions(root, controller.signal, {
      harnessAttempts: 1,
      harnessFinalArtifactForTest: async () => {
        artifactCount += 1;
        if (artifactCount === 1) controller.abort("abort during final artifact commit");
      },
    })), /abort during final artifact commit/);
  });

  assert.deepEqual(JSON.parse(await readFile(path.join(harnessRoot, "official-score-summary.json"), "utf8")), previousSummary);
  assert.deepEqual(JSON.parse(await readFile(path.join(harnessRoot, "official-merged-report.json"), "utf8")), { previous: true });
  assert.equal(await fileExists(path.join(harnessRoot, "official-report.json")), false);
});

test("harness artifact rollback refuses to delete or overwrite a successor artifact", async () => {
  const root = await tempRoot("cpb-harness-artifact-successor-aba");
  const controller = new AbortController();
  const aggregatePath = path.join(root, "official-merged-report.json");
  const reportPath = path.join(root, "official-report.json");
  const summaryPath = path.join(root, "official-score-summary.json");
  await mkdir(root, { recursive: true });
  await writeFile(aggregatePath, JSON.stringify({ previous: true }) + "\n", "utf8");
  await writeFile(reportPath, JSON.stringify({ previousReport: true }) + "\n", "utf8");
  await writeFile(summaryPath, JSON.stringify({ previousSummary: true }) + "\n", "utf8");

  await assert.rejects(
    () => commitHarnessJsonArtifacts([
      { path: aggregatePath, value: { aggregate: "ours" } },
      { path: reportPath, value: { report: "ours" } },
      { path: summaryPath, value: { summary: "ours" } },
    ], controller.signal, async (targetPath) => {
      if (targetPath === aggregatePath) {
        await writeFile(aggregatePath, JSON.stringify({ successor: true }) + "\n", "utf8");
        controller.abort("abort after successor publish");
      }
    }),
    (error: unknown) => nestedErrorMatches(error, /successor artifact replaced committed file/),
  );

  assert.deepEqual(JSON.parse(await readFile(aggregatePath, "utf8")), { successor: true });
  assert.equal(await fileExists(reportPath), true);
  assert.equal(await fileExists(summaryPath), true);
});

test("harness artifact rollback refuses same-content successor ABA", async () => {
  const root = await tempRoot("cpb-harness-artifact-same-content-aba");
  const controller = new AbortController();
  const aggregatePath = path.join(root, "official-merged-report.json");
  const reportPath = path.join(root, "official-report.json");
  const summaryPath = path.join(root, "official-score-summary.json");
  await mkdir(root, { recursive: true });
  await writeFile(aggregatePath, JSON.stringify({ previous: true }) + "\n", "utf8");
  await writeFile(reportPath, JSON.stringify({ previousReport: true }) + "\n", "utf8");
  await writeFile(summaryPath, JSON.stringify({ previousSummary: true }) + "\n", "utf8");
  const sameContent = `${JSON.stringify({ aggregate: "ours" }, null, 2)}\n`;

  await assert.rejects(
    () => commitHarnessJsonArtifacts([
      { path: aggregatePath, value: { aggregate: "ours" } },
      { path: reportPath, value: { report: "ours" } },
      { path: summaryPath, value: { summary: "ours" } },
    ], controller.signal, async (targetPath) => {
      if (targetPath === aggregatePath) {
        await writeFile(aggregatePath, sameContent, "utf8");
        controller.abort("abort after same-content successor publish");
      }
    }),
    (error: unknown) => nestedErrorMatches(error, /successor artifact replaced committed file/),
  );

  assert.equal(await readFile(aggregatePath, "utf8"), sameContent);
});

test("harness artifact transaction propagates non-ENOENT stat failures", async () => {
  const root = await tempRoot("cpb-harness-artifact-stat-failure");
  const fileParent = path.join(root, "not-a-directory");
  await writeFile(fileParent, "file parent\n", "utf8");

  await assert.rejects(
    () => commitHarnessJsonArtifacts([
      { path: path.join(fileParent, "official-merged-report.json"), value: { aggregate: true } },
      { path: path.join(fileParent, "official-report.json"), value: { report: true } },
      { path: path.join(fileParent, "official-score-summary.json"), value: { summary: true } },
    ], undefined),
    /EEXIST|file already exists|ENOTDIR|not a directory/,
  );
});

test("harness artifact backup cleanup failure after full publish is committed and non-destructive", async () => {
  const root = await tempRoot("cpb-harness-artifact-backup-cleanup");
  const aggregatePath = path.join(root, "official-merged-report.json");
  const reportPath = path.join(root, "official-report.json");
  const summaryPath = path.join(root, "official-score-summary.json");
  await mkdir(root, { recursive: true });
  for (const targetPath of [aggregatePath, reportPath, summaryPath]) {
    await writeFile(targetPath, JSON.stringify({ previous: path.basename(targetPath) }) + "\n", "utf8");
  }

  await assert.rejects(
    () => commitHarnessJsonArtifacts([
      { path: aggregatePath, value: { aggregate: "published" } },
      { path: reportPath, value: { report: "published" } },
      { path: summaryPath, value: { summary: "published" } },
    ], undefined, async (targetPath) => {
      if (targetPath !== summaryPath) return;
      const scratchRoot = await harnessArtifactScratch(root);
      const backupPath = path.join(scratchRoot, "backup-2.json");
      await rm(backupPath, { force: true });
      await mkdir(path.join(backupPath, "child"), { recursive: true });
    }),
    (error: unknown) => {
      assert.equal((error as { committed?: boolean }).committed, true);
      return nestedErrorMatches(error, /committed but cleanup failed|EISDIR|is a directory|directory not empty/i);
    },
  );

  assert.deepEqual(JSON.parse(await readFile(aggregatePath, "utf8")), { aggregate: "published" });
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), { report: "published" });
  assert.deepEqual(JSON.parse(await readFile(summaryPath, "utf8")), { summary: "published" });
});

test("harness artifact owner reads reject symlinks and oversized metadata without following", async (t) => {
  const validIdentity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(validIdentity);
  const owner = {
    format: "cpb-harness-artifact-owner/v1",
    ownerToken: "bounded-owner",
    directory: "",
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    processIdentity: validIdentity,
  };

  await t.test("symlink owner", async () => {
    const root = await tempRoot("cpb-harness-owner-symlink");
    const lockPath = path.join(root, ".cpb-harness-artifacts.lock");
    const outsideOwner = path.join(root, "outside-owner.json");
    const targetPath = path.join(root, "official-score-summary.json");
    owner.directory = root;
    await mkdir(lockPath);
    await writeFile(outsideOwner, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    await symlink(outsideOwner, path.join(lockPath, "owner.json"));

    await assert.rejects(
      () => commitHarnessJsonArtifacts([{ path: targetPath, value: { mustNotPublish: true } }], undefined),
      (error: unknown) => (error as { code?: string }).code === "HARNESS_ARTIFACT_OWNER_UNSAFE",
    );
    assert.equal(await fileExists(targetPath), false);
    assert.equal(JSON.parse(await readFile(outsideOwner, "utf8")).ownerToken, "bounded-owner");
  });

  await t.test("oversized owner", async () => {
    const root = await tempRoot("cpb-harness-owner-oversized");
    const lockPath = path.join(root, ".cpb-harness-artifacts.lock");
    const targetPath = path.join(root, "official-score-summary.json");
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, "owner.json"), "x".repeat(64 * 1024 + 1), "utf8");

    await assert.rejects(
      () => commitHarnessJsonArtifacts([{ path: targetPath, value: { mustNotPublish: true } }], undefined),
      (error: unknown) => (error as { code?: string }).code === "HARNESS_ARTIFACT_OWNER_UNSAFE",
    );
    assert.equal(await fileExists(targetPath), false);
  });
});

test("harness artifact owner read rejects same-content path-generation ABA", async () => {
  const root = await tempRoot("cpb-harness-owner-generation-aba");
  const lockPath = path.join(root, ".cpb-harness-artifacts.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const displacedPath = path.join(lockPath, "owner.displaced.json");
  const targetPath = path.join(root, "official-score-summary.json");
  const identity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(identity);
  const rawOwner = `${JSON.stringify({
    format: "cpb-harness-artifact-owner/v1",
    ownerToken: "generation-owner",
    directory: root,
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    processIdentity: identity,
  }, null, 2)}\n`;
  await mkdir(lockPath);
  await writeFile(ownerPath, rawOwner, "utf8");

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      ownerRead: {
        beforePathGenerationCheck: async () => {
          await rename(ownerPath, displacedPath);
          await writeFile(ownerPath, rawOwner, "utf8");
        },
      },
    }, () => commitHarnessJsonArtifacts([{ path: targetPath, value: { mustNotPublish: true } }], undefined)),
    (error: unknown) => (error as { code?: string }).code === "HARNESS_ARTIFACT_OWNER_UNSAFE",
  );
  assert.equal(await fileExists(targetPath), false);
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).ownerToken, "generation-owner");
  assert.equal(JSON.parse(await readFile(displacedPath, "utf8")).ownerToken, "generation-owner");
});

test("harness artifact publish fsync failure reports committed ambiguity and recovery paths", async () => {
  const root = await tempRoot("cpb-harness-publish-fsync");
  const targetPath = path.join(root, "official-score-summary.json");
  const fsyncFailure = Object.assign(new Error("publish directory fsync failed"), { code: "EIO" });

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      syncDirectory: async (_directory, phase) => {
        if (phase === "artifact-publish-target") throw fsyncFailure;
      },
    }, () => commitHarnessJsonArtifacts([{ path: targetPath, value: { published: true } }], undefined)),
    (error: unknown) => {
      const failure = error as Error & { code?: string; committed?: boolean; recoveryPaths?: string[] };
      assert.equal(failure.code, "HARNESS_ARTIFACT_PUBLISH_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.ok(failure.recoveryPaths?.includes(targetPath));
      assert.equal(failure.cause, fsyncFailure);
      return true;
    },
  );
  assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { published: true });
});

test("harness artifact rollback restore fsync failure reports ambiguity after no-clobber restore", async () => {
  const root = await tempRoot("cpb-harness-restore-fsync");
  const targetPath = path.join(root, "official-score-summary.json");
  const controller = new AbortController();
  const fsyncFailure = Object.assign(new Error("restore directory fsync failed"), { code: "EIO" });
  await writeFile(targetPath, `${JSON.stringify({ previous: true })}\n`, "utf8");

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      syncDirectory: async (_directory, phase) => {
        if (phase === "artifact-rollback-restore-target") throw fsyncFailure;
      },
    }, () => commitHarnessJsonArtifacts([
      { path: targetPath, value: { published: true } },
    ], controller.signal, () => controller.abort("abort after publish"))),
    (error: unknown) => {
      const failure = error as Error & { code?: string; committed?: boolean; recoveryPaths?: string[] };
      assert.equal(failure.code, "HARNESS_ARTIFACT_RESTORE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.ok(failure.recoveryPaths?.includes(targetPath));
      assert.equal(failure.cause, fsyncFailure);
      return true;
    },
  );
  assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { previous: true });
});

test("harness artifact cleanup remove fsync failure preserves committed publication", async () => {
  const root = await tempRoot("cpb-harness-cleanup-remove-fsync");
  const targetPath = path.join(root, "official-score-summary.json");
  const fsyncFailure = Object.assign(new Error("backup removal fsync failed"), { code: "EIO" });
  await writeFile(targetPath, `${JSON.stringify({ previous: true })}\n`, "utf8");

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      syncDirectory: async (_directory, phase) => {
        if (phase === "artifact-cleanup-backup-remove") throw fsyncFailure;
      },
    }, () => commitHarnessJsonArtifacts([{ path: targetPath, value: { published: true } }], undefined)),
    (error: unknown) => {
      const failure = error as Error & { code?: string; committed?: boolean; recoveryPaths?: string[] };
      assert.equal(failure.code, "HARNESS_ARTIFACT_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.ok(failure.recoveryPaths?.includes(targetPath));
      assert.equal(failure.cause, fsyncFailure);
      return true;
    },
  );
  assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { published: true });
});

test("harness artifact rollback restore never overwrites empty or file successors", async (t) => {
  for (const successorKind of ["empty", "file"] as const) {
    await t.test(`${successorKind} successor`, async () => {
      const root = await tempRoot(`cpb-harness-rollback-${successorKind}-successor`);
      const targetPath = path.join(root, "official-score-summary.json");
      const controller = new AbortController();
      await writeFile(targetPath, `${JSON.stringify({ previous: true })}\n`, "utf8");

      await assert.rejects(
        () => withHarnessArtifactLockTestHooks({
          afterArtifactMutation: async ({ phase }) => {
            if (phase !== "rollback-quarantine") return;
            if (successorKind === "empty") await mkdir(targetPath);
            else await writeFile(targetPath, `${JSON.stringify({ successor: true })}\n`, "utf8");
          },
        }, () => commitHarnessJsonArtifacts([
          { path: targetPath, value: { published: true } },
        ], controller.signal, () => controller.abort("abort before rollback restore"))),
        (error: unknown) => {
          const failure = error as AggregateError & { recoveryPaths?: string[] };
          assert.ok(failure.recoveryPaths?.some((candidate) => candidate.includes("backup-0.json")));
          assert.ok(failure.recoveryPaths?.some((candidate) => candidate.includes("rollback-0.json")));
          return nestedErrorMatches(error, /refusing to overwrite|successor/i);
        },
      );

      if (successorKind === "empty") assert.deepEqual(await readdir(targetPath), []);
      else assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { successor: true });
    });
  }
});

test("harness artifact owner liveness is EPERM-safe and does not hide other probe failures", () => {
  const identity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(identity);
  const owner = {
    format: "cpb-harness-artifact-owner/v1" as const,
    ownerToken: "owner-token",
    directory: "/tmp/harness-artifacts",
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    processIdentity: identity,
  };
  const permissionDenied = Object.assign(new Error("permission denied"), { code: "EPERM" });
  assert.equal(harnessArtifactOwnerAlive(owner, {
    identityAlive: () => { throw permissionDenied; },
  }), true);
  assert.equal(harnessArtifactOwnerAlive(owner, {
    identityAlive: () => {
      throw Object.assign(new Error("exact identity temporarily unavailable"), {
        code: "PROCESS_IDENTITY_UNAVAILABLE",
      });
    },
  }), true);
  assert.throws(
    () => harnessArtifactOwnerAlive(owner, {
      identityAlive: () => { throw Object.assign(new Error("identity probe failed"), { code: "EIO" }); },
    }),
    /identity probe failed/,
  );
});

test("failed harness artifact lock acquisition preserves a post-claim successor", async () => {
  const root = await tempRoot("cpb-harness-lock-acquire-successor");
  const lockPath = path.join(root, ".cpb-harness-artifacts.lock");
  const displacedPath = path.join(root, ".cpb-harness-artifacts.lock.displaced");
  const targetPath = path.join(root, "official-score-summary.json");

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      afterAcquireDirectoryCreated: async () => {
        await rename(lockPath, displacedPath);
        await mkdir(lockPath);
        throw new Error("forced failure after lock claim replacement");
      },
    }, () => commitHarnessJsonArtifacts([
      { path: targetPath, value: { mustNotPublish: true } },
    ], undefined)),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(nestedErrorMatches(error, /forced failure after lock claim replacement/), true);
      assert.equal(nestedErrorMatches(error, /successor replaced a failed acquisition/), true);
      return true;
    },
  );

  assert.deepEqual(await readdir(lockPath), []);
  assert.deepEqual(await readdir(displacedPath), []);
  assert.equal(await fileExists(targetPath), false);
});

test("harness artifact lock never reclaims an owner whose exact precision is missing", async () => {
  const root = await tempRoot("cpb-harness-artifact-missing-precision");
  const lockPath = path.join(root, ".cpb-harness-artifacts.lock");
  const targetPath = path.join(root, "official-score-summary.json");
  const deadPid = 2_000_000_000;
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-harness-artifact-owner/v1",
    ownerToken: "owner-without-exact-precision",
    directory: root,
    pid: deadPid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    processIdentity: {
      pid: deadPid,
      birthId: "unmarked-start",
      incarnation: `${deadPid}:unmarked-start`,
      capturedAt: new Date().toISOString(),
    },
  }, null, 2)}\n`, "utf8");

  await withTemporaryEnv({ CPB_HARNESS_ARTIFACT_LOCK_TIMEOUT_MS: "75" }, async () => {
    await assert.rejects(
      () => commitHarnessJsonArtifacts([{ path: targetPath, value: { mustNotPublish: true } }], undefined),
      /timed out waiting for harness artifact lock/,
    );
  });
  assert.equal(await fileExists(targetPath), false);
  assert.equal(
    JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).ownerToken,
    "owner-without-exact-precision",
  );
});

test("harness artifact lock recovers a reused PID generation but preserves its live successor", async () => {
  const root = await tempRoot("cpb-harness-artifact-pid-reuse");
  const lockPath = path.join(root, ".cpb-harness-artifacts.lock");
  const targetPath = path.join(root, "official-score-summary.json");
  const currentIdentity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(currentIdentity);
  const writeOwner = async (ownerToken: string, processIdentity: typeof currentIdentity) => {
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
      format: "cpb-harness-artifact-owner/v1",
      ownerToken,
      directory: root,
      pid: process.pid,
      host: hostname(),
      acquiredAt: new Date().toISOString(),
      processIdentity,
    }, null, 2)}\n`, "utf8");
  };

  await writeOwner("stale-generation", {
    ...currentIdentity,
    birthId: "reused-pid-predecessor",
    incarnation: `${process.pid}:reused-pid-predecessor`,
  });
  await commitHarnessJsonArtifacts([{ path: targetPath, value: { generation: "published" } }], undefined);
  assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { generation: "published" });
  assert.equal(await fileExists(lockPath), false);

  await writeOwner("live-successor", currentIdentity);
  await withTemporaryEnv({ CPB_HARNESS_ARTIFACT_LOCK_TIMEOUT_MS: "75" }, async () => {
    await assert.rejects(
      () => commitHarnessJsonArtifacts(
        [{ path: targetPath, value: { generation: "must-not-publish" } }],
        undefined,
      ),
      /timed out waiting for harness artifact lock/,
    );
  });
  assert.equal(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).ownerToken, "live-successor");
  assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { generation: "published" });
});

test("harness artifact lock preserves an empty successor created after quarantine", async () => {
  const root = await tempRoot("cpb-harness-artifact-empty-successor");
  const lockPath = path.join(root, ".cpb-harness-artifacts.lock");
  const targetPath = path.join(root, "official-score-summary.json");
  let quarantinePath = "";

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      afterQuarantineRename: async (context) => {
        if (context.disposition !== "released") return;
        quarantinePath = context.quarantinePath;
        await mkdir(context.lockPath);
        await writeFile(
          path.join(context.quarantinePath, "owner.json"),
          `${JSON.stringify({
            format: "cpb-harness-artifact-owner/v1",
            ownerToken: "changed-after-quarantine",
            directory: root,
            pid: process.pid,
            host: hostname(),
            acquiredAt: new Date().toISOString(),
            processIdentity: captureProcessIdentity(process.pid, { strict: true }),
          }, null, 2)}\n`,
          "utf8",
        );
      },
    }, () => commitHarnessJsonArtifacts([
      { path: targetPath, value: { published: true } },
    ], undefined)),
    (error: unknown) => {
      const failure = error as AggregateError & {
        committed?: boolean;
        successorPreserved?: boolean;
        residualPath?: string;
      };
      assert.equal(failure.committed, true, "artifact publication committed before lock release failed");
      assert.equal(failure.successorPreserved, true);
      assert.equal(failure.residualPath, quarantinePath);
      assert.match(String(failure), /preserv.*successor/i);
      assert.ok(failure.errors.some((cause) => /owner changed while released/.test(String(cause))));
      return true;
    },
  );

  assert.deepEqual(await readdir(lockPath), [], "the owner-less successor reservation is untouched");
  const preservedEntries = await readdir(quarantinePath);
  assert.ok(preservedEntries.includes("owner.json"));
  assert.equal(preservedEntries.filter((entry) => entry.startsWith(".owner-") && entry.endsWith(".tmp")).length, 1);
  assert.equal(
    JSON.parse(await readFile(path.join(quarantinePath, "owner.json"), "utf8")).ownerToken,
    "changed-after-quarantine",
  );
  assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { published: true });
});

test("harness artifact lock preserves a same-token quarantine directory replacement", async () => {
  const root = await tempRoot("cpb-harness-artifact-same-token-directory-aba");
  const targetPath = path.join(root, "official-score-summary.json");
  const identity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(identity);
  let displacedPath = "";
  let replacementPath = "";

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      beforeQuarantineRemove: async (context) => {
        if (context.disposition !== "released") return;
        assert.ok(context.expectedToken);
        replacementPath = context.quarantinePath;
        displacedPath = `${context.quarantinePath}.displaced`;
        await rename(context.quarantinePath, displacedPath);
        await mkdir(context.quarantinePath, { mode: 0o700 });
        await writeFile(path.join(context.quarantinePath, "owner.json"), `${JSON.stringify({
          format: "cpb-harness-artifact-owner/v1",
          ownerToken: context.expectedToken,
          directory: root,
          pid: process.pid,
          host: hostname(),
          acquiredAt: new Date().toISOString(),
          processIdentity: identity,
        }, null, 2)}\n`, "utf8");
      },
    }, () => commitHarnessJsonArtifacts([
      { path: targetPath, value: { published: true } },
    ], undefined)),
    (error: unknown) => {
      assert.equal((error as { committed?: boolean }).committed, true);
      return nestedErrorMatches(error, /quarantine generation changed/);
    },
  );

  assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { published: true });
  assert.equal(
    JSON.parse(await readFile(path.join(replacementPath, "owner.json"), "utf8")).ownerToken,
    JSON.parse(await readFile(path.join(displacedPath, "owner.json"), "utf8")).ownerToken,
  );
});

test("harness artifact removal quarantines a post-check successor instead of deleting it", async () => {
  const root = await tempRoot("cpb-harness-artifact-remove-successor");
  const targetPath = path.join(root, "official-score-summary.json");
  await writeFile(targetPath, `${JSON.stringify({ previous: true })}\n`, "utf8");
  let displacedPath = "";
  let successorPath = "";

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      beforeArtifactRemove: async ({ phase, artifactPath }) => {
        if (phase !== "cleanup-backup-remove") return;
        successorPath = artifactPath;
        displacedPath = `${artifactPath}.displaced`;
        await rename(artifactPath, displacedPath);
        await writeFile(artifactPath, `${JSON.stringify({ successor: true })}\n`, "utf8");
      },
    }, () => commitHarnessJsonArtifacts([
      { path: targetPath, value: { published: true } },
    ], undefined)),
    (error: unknown) => {
      const failure = error as AggregateError & { committed?: boolean; recoveryPaths?: string[] };
      assert.equal(failure.committed, true);
      assert.ok(failure.recoveryPaths?.includes(successorPath));
      return nestedErrorMatches(error, /successor/);
    },
  );

  assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { published: true });
  assert.deepEqual(JSON.parse(await readFile(successorPath, "utf8")), { successor: true });
  assert.deepEqual(JSON.parse(await readFile(displacedPath, "utf8")), { previous: true });
});

test("harness artifact lock release reports committed durability ambiguity with owned quarantine retained", async () => {
  const root = await tempRoot("cpb-harness-artifact-remove-fsync");
  const lockPath = path.join(root, ".cpb-harness-artifacts.lock");
  const targetPath = path.join(root, "official-score-summary.json");
  const fsyncFailure = Object.assign(new Error("harness lock parent fsync failed"), { code: "EIO" });

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      syncDirectory: async (_directory, phase) => {
        if (phase === "remove") throw fsyncFailure;
      },
    }, () => commitHarnessJsonArtifacts([
      { path: targetPath, value: { published: true } },
    ], undefined)),
    (error: unknown) => {
      const ambiguity = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryRoot?: string;
        recoveryPaths?: string[];
        cause?: unknown;
      };
      assert.equal(ambiguity.code, "HARNESS_ARTIFACT_LOCK_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(ambiguity.committed, true);
      assert.match(ambiguity.committedPath || "", /\.released-/);
      assert.match(ambiguity.recoveryRoot || "", /\.quarantine-/);
      assert.ok(ambiguity.recoveryPaths?.includes(ambiguity.committedPath || ""));
      assert.ok(ambiguity.recoveryPaths?.includes(ambiguity.recoveryRoot || ""));
      assert.equal(ambiguity.cause, fsyncFailure);
      return true;
    },
  );

  assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), { published: true });
  assert.equal(await fileExists(lockPath), false);
  const retainedLocks = (await readdir(root))
    .filter((entry) => entry.startsWith(".cpb-harness-artifacts.lock.released-"));
  assert.equal(retainedLocks.length, 1);
  const retainedOwner = JSON.parse(await readFile(path.join(root, retainedLocks[0], "owner.json"), "utf8"));
  assert.match(retainedOwner.ownerToken, /^[0-9a-f-]+$/);
});

test("harness artifact owner lock serializes concurrent A/B bundles", async () => {
  const root = await tempRoot("cpb-harness-artifact-concurrent-bundles");
  const paths = [
    path.join(root, "official-merged-report.json"),
    path.join(root, "official-report.json"),
    path.join(root, "official-score-summary.json"),
  ];
  const eventsPath = path.join(root, "publish-events.log");
  const moduleHref = new URL("../scripts/run-swebench-three-way.js", import.meta.url).href;
  const childSource = [
    "import { appendFile } from 'node:fs/promises';",
    `import { commitHarnessJsonArtifacts } from ${JSON.stringify(moduleHref)};`,
    "import path from 'node:path';",
    "const [root, owner, eventsPath] = process.argv.slice(1);",
    "const names = ['official-merged-report.json', 'official-report.json', 'official-score-summary.json'];",
    "await commitHarnessJsonArtifacts(names.map((name, index) => ({",
    "  path: path.join(root, name),",
    "  value: { owner, index },",
    "})), undefined, async () => {",
    "  await appendFile(eventsPath, owner, 'utf8');",
    "  await new Promise((resolve) => setTimeout(resolve, 10));",
    "});",
  ].join("\n");
  const runCommitProcess = (owner: "A" | "B") => new Promise<void>((resolve, reject) => {
    const child = spawnChild(process.execPath, ["--input-type=module", "-e", childSource, root, owner, eventsPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code, childSignal) => {
      if (code === 0) resolve();
      else reject(new Error(`artifact commit child ${owner} exited ${code} signal ${childSignal}: ${stderr}`));
    });
  });

  await Promise.all([runCommitProcess("A"), runCommitProcess("B")]);

  const events = await readFile(eventsPath, "utf8");
  assert.ok(["AAABBB", "BBBAAA"].includes(events), `artifact publishes interleaved: ${events}`);
  const values = await Promise.all(paths.map(async (targetPath) => JSON.parse(await readFile(targetPath, "utf8"))));
  assert.equal(new Set(values.map((value) => value.owner)).size, 1);
  assert.deepEqual(values.map((value) => value.index), [0, 1, 2]);
});

test("source cache durable lease serializes operations across independent processes", async () => {
  const root = await tempRoot("cpb-source-cache-cross-process-lock");
  const cachePath = path.join(root, "source-cache", "owner__repo.git");
  const eventsPath = path.join(root, "events.log");
  const moduleHref = new URL("../scripts/run-swebench-three-way.js", import.meta.url).href;
  const childSource = [
    "import { appendFile } from 'node:fs/promises';",
    `import { withSourceCacheLock } from ${JSON.stringify(moduleHref)};`,
    "const [cachePath, owner, eventsPath] = process.argv.slice(1);",
    "await withSourceCacheLock(cachePath, async () => {",
    "  for (let index = 0; index < 3; index += 1) {",
    "    await appendFile(eventsPath, owner, 'utf8');",
    "    await new Promise((resolve) => setTimeout(resolve, 20));",
    "  }",
    "});",
  ].join("\n");
  const runChild = (owner: "A" | "B") => new Promise<void>((resolve, reject) => {
    const child = spawnChild(process.execPath, ["--input-type=module", "-e", childSource, cachePath, owner, eventsPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code, childSignal) => {
      if (code === 0) resolve();
      else reject(new Error(`source-cache lock child ${owner} exited ${code} signal ${childSignal}: ${stderr}`));
    });
  });

  await Promise.all([runChild("A"), runChild("B")]);
  const events = await readFile(eventsPath, "utf8");
  assert.ok(["AAABBB", "BBBAAA"].includes(events), `source-cache operations interleaved: ${events}`);
});

test("source cache durable lease reclaims a reused PID generation but not its live successor", async () => {
  const root = await tempRoot("cpb-source-cache-pid-reuse");
  const cachePath = path.join(root, "source-cache", "owner__repo.git");
  const lockDirectory = sourceCacheLockDirectory(cachePath);
  const lockPath = path.join(lockDirectory, ".cpb-harness-artifacts.lock");
  const currentIdentity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(currentIdentity);
  const writeOwner = async (ownerToken: string, processIdentity: ProcessIdentity) => {
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
      format: "cpb-harness-artifact-owner/v1",
      ownerToken,
      directory: lockDirectory,
      pid: process.pid,
      host: hostname(),
      acquiredAt: new Date().toISOString(),
      processIdentity,
    }, null, 2)}\n`, "utf8");
  };

  await writeOwner("stale-source-cache-owner", {
    ...currentIdentity,
    birthId: "reused-source-cache-predecessor",
    incarnation: `${process.pid}:reused-source-cache-predecessor`,
  });
  let acquired = 0;
  await withSourceCacheLock(cachePath, async () => { acquired += 1; });
  assert.equal(acquired, 1);

  await writeOwner("live-source-cache-successor", currentIdentity);
  await withTemporaryEnv({ CPB_HARNESS_ARTIFACT_LOCK_TIMEOUT_MS: "75" }, async () => {
    await assert.rejects(
      () => withSourceCacheLock(cachePath, async () => { acquired += 1; }),
      /timed out waiting for harness artifact lock/,
    );
  });
  assert.equal(acquired, 1);
  assert.equal(
    JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).ownerToken,
    "live-source-cache-successor",
  );
});

test("source cache fence preserves a successor and reports the primary failure", async () => {
  const root = await tempRoot("cpb-source-cache-fence-successor");
  const cachePath = path.join(root, "source-cache", "owner__repo.git");
  const lockDirectory = sourceCacheLockDirectory(cachePath);
  const lockPath = path.join(lockDirectory, ".cpb-harness-artifacts.lock");
  const displacedPath = path.join(lockDirectory, ".cpb-harness-artifacts.lock.displaced");
  const identity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(identity);

  await assert.rejects(
    () => withSourceCacheLock(cachePath, async () => {
      await rename(lockPath, displacedPath);
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
        format: "cpb-harness-artifact-owner/v1",
        ownerToken: "source-cache-successor",
        directory: lockDirectory,
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        processIdentity: identity,
      }, null, 2)}\n`, "utf8");
      throw new Error("source cache primary operation failed");
    }),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(nestedErrorMatches(error, /source cache primary operation failed/), true);
      assert.equal(nestedErrorMatches(error, /ownership fence was lost/), true);
      return true;
    },
  );
  assert.equal(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).ownerToken, "source-cache-successor");
  assert.equal((await readdir(displacedPath)).includes("owner.json"), true);
});

test("source cache operation and lock cleanup failures are aggregated without clobbering a successor", async () => {
  const root = await tempRoot("cpb-source-cache-cleanup-dual-failure");
  const cachePath = path.join(root, "source-cache", "owner__repo.git");
  let successorPath = "";
  let quarantinePath = "";

  await assert.rejects(
    () => withHarnessArtifactLockTestHooks({
      afterQuarantineRename: async (context) => {
        if (context.disposition !== "released") return;
        successorPath = context.lockPath;
        quarantinePath = context.quarantinePath;
        await mkdir(successorPath);
        await writeFile(path.join(quarantinePath, "owner.json"), `${JSON.stringify({
          format: "cpb-harness-artifact-owner/v1",
          ownerToken: "changed-during-source-cache-release",
          directory: path.dirname(context.lockPath),
          pid: process.pid,
          host: hostname(),
          acquiredAt: new Date().toISOString(),
          processIdentity: captureProcessIdentity(process.pid, { strict: true }),
        }, null, 2)}\n`, "utf8");
      },
    }, () => withSourceCacheLock(cachePath, async () => {
      throw new Error("source cache primary before cleanup failure");
    })),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(nestedErrorMatches(error, /source cache primary before cleanup failure/), true);
      assert.equal(nestedErrorMatches(error, /owner changed while released/), true);
      return true;
    },
  );

  assert.deepEqual(await readdir(successorPath), []);
  assert.equal(
    JSON.parse(await readFile(path.join(quarantinePath, "owner.json"), "utf8")).ownerToken,
    "changed-during-source-cache-release",
  );
});

test("harness rollback preserves current artifact when its owned backup is missing", async () => {
  const root = await tempRoot("cpb-harness-artifact-missing-backup");
  const controller = new AbortController();
  const paths = [
    path.join(root, "official-merged-report.json"),
    path.join(root, "official-report.json"),
    path.join(root, "official-score-summary.json"),
  ];
  for (const [index, targetPath] of paths.entries()) {
    await writeFile(targetPath, `${JSON.stringify({ previous: index })}\n`, "utf8");
  }

  await assert.rejects(
    () => commitHarnessJsonArtifacts(
      paths.map((targetPath, index) => ({ path: targetPath, value: { owner: "ours", index } })),
      controller.signal,
      async (targetPath) => {
        if (targetPath !== paths[0]) return;
        const scratchRoot = await harnessArtifactScratch(root);
        await rm(path.join(scratchRoot, "backup-0.json"));
        controller.abort("abort after backup removal");
      },
    ),
    (error: unknown) => nestedErrorMatches(error, /without its owned backup/),
  );

  assert.deepEqual(JSON.parse(await readFile(paths[0], "utf8")), { owner: "ours", index: 0 });
  assert.deepEqual(JSON.parse(await readFile(paths[1], "utf8")), { previous: 1 });
  assert.deepEqual(JSON.parse(await readFile(paths[2], "utf8")), { previous: 2 });
});

test("harness rollback preserves current and recovery artifacts on quarantine rename failure", async () => {
  const root = await tempRoot("cpb-harness-artifact-rename-failure");
  const controller = new AbortController();
  const paths = [
    path.join(root, "official-merged-report.json"),
    path.join(root, "official-report.json"),
    path.join(root, "official-score-summary.json"),
  ];
  for (const [index, targetPath] of paths.entries()) {
    await writeFile(targetPath, `${JSON.stringify({ previous: index })}\n`, "utf8");
  }

  let scratchRoot = "";
  await assert.rejects(
    () => commitHarnessJsonArtifacts(
      paths.map((targetPath, index) => ({ path: targetPath, value: { owner: "ours", index } })),
      controller.signal,
      async (targetPath) => {
        if (targetPath !== paths[0]) return;
        scratchRoot = await harnessArtifactScratch(root);
        await mkdir(path.join(scratchRoot, "rollback-0.json"));
        controller.abort("abort before quarantine rename");
      },
    ),
    (error: unknown) => nestedErrorMatches(error, /EISDIR|ENOTDIR|not a directory|directory not empty/i),
  );

  assert.deepEqual(JSON.parse(await readFile(paths[0], "utf8")), { owner: "ours", index: 0 });
  assert.equal(await fileExists(path.join(scratchRoot, "backup-0.json")), true);
  assert.deepEqual(await readdir(path.join(scratchRoot, "rollback-0.json")), []);
});

test("runCommand preserves normal no-signal command behavior", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "ok");
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(result.error, null);
});

test("product validation command timeout waits for identity-bound tree teardown", async () => {
  const root = await tempRoot("cpb-product-command-timeout");
  let notifySpawn: (identity: NonNullable<Awaited<ReturnType<typeof runProductValidationCommand>>["rootIdentity"]>) => void = () => {};
  const spawned = new Promise<NonNullable<Awaited<ReturnType<typeof runProductValidationCommand>>["rootIdentity"]>>((resolve) => {
    notifySpawn = resolve;
  });
  let cleanupFinished = false;
  const pending = withTemporaryEnv({ CPB_KILL_GRACE_MS: "20" }, async () => runProductValidationCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    root,
    30,
    {
      onSpawn: notifySpawn,
      teardownProcessTree: async (pid, { expectedRootIdentity }) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await killTree(pid, 20, { requireDescendantScan: true, expectedRootIdentity });
        cleanupFinished = true;
      },
    },
  ));

  const identity = await spawned;
  await assert.rejects(pending, /timed out after 30ms/);
  assert.equal(cleanupFinished, true);
  assert.equal(isProcessIdentityAlive(identity), false);
});

test("scoped Codegraph cleanup refuses a PID successor before invoking teardown", async () => {
  const worktreePath = await tempRoot("cpb-codegraph-successor");
  const fixture = await spawnExactIdentityFixture();
  const originalIdentity = fixture.identity;
  const successorIdentity = {
    ...originalIdentity,
    birthId: `${originalIdentity.birthId}:simulated-successor`,
    incarnation: `${originalIdentity.pid}:${originalIdentity.birthId}:simulated-successor`,
  };
  let captureCount = 0;
  let teardownInvoked = false;

  try {
    await assert.rejects(
      () => cleanupScopedCodegraphDaemons(worktreePath, {
        listProcesses: async () => `${originalIdentity.pid} codegraph serve --mcp ${worktreePath}\n`,
        readProcessCommand: async () => `codegraph serve --mcp ${worktreePath}`,
        captureIdentity: () => captureCount++ === 0 ? originalIdentity : successorIdentity,
        isIdentityAlive: () => true,
        teardownProcessTree: async () => { teardownInvoked = true; },
      }),
      (error: unknown) => nestedErrorMatches(error, /refusing to signal successor/),
    );
    assert.equal(teardownInvoked, false);
  } finally {
    await fixture.stop();
  }
});

test("scoped Codegraph cleanup awaits teardown and propagates permission errors", async () => {
  const worktreePath = await tempRoot("cpb-codegraph-cleanup-settle");
  const fixture = await spawnExactIdentityFixture();
  const identity = fixture.identity;
  const command = `codegraph serve --mcp ${worktreePath}`;
  let alive = true;
  let cleanupFinished = false;
  try {
    const result = await cleanupScopedCodegraphDaemons(worktreePath, {
      listProcesses: async () => `${identity.pid} ${command}\n`,
      readProcessCommand: async () => command,
      captureIdentity: () => identity,
      isIdentityAlive: () => alive,
      teardownProcessTree: async (_pid, { expectedRootIdentity }) => {
        assert.equal(expectedRootIdentity, identity);
        await new Promise((resolve) => setTimeout(resolve, 40));
        alive = false;
        cleanupFinished = true;
      },
    });
    assert.equal(cleanupFinished, true);
    assert.deepEqual(result.killedPids, [identity.pid]);

    const permissionError = Object.assign(new Error("operation not permitted during cleanup"), { code: "EPERM" });
    await assert.rejects(
      () => cleanupScopedCodegraphDaemons(worktreePath, {
        listProcesses: async () => `${identity.pid} ${command}\n`,
        readProcessCommand: async () => command,
        captureIdentity: () => identity,
        isIdentityAlive: () => true,
        teardownProcessTree: async () => { throw permissionError; },
      }),
      (error: unknown) => nestedErrorMatches(error, /operation not permitted during cleanup/),
    );
  } finally {
    await fixture.stop();
  }
});

async function writeFakeManagedWorkerDist(root: string) {
  const distRoot = path.join(root, "dist");
  const workerScript = path.join(distRoot, "runtime", "worker", "managed-worker.js");
  await mkdir(path.dirname(workerScript), { recursive: true });
  await writeFile(workerScript, [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.CPB_FAKE_WORKER_PID_FILE, String(process.pid));",
    "if (process.env.CPB_FAKE_WORKER_OUTPUT_BYTES) {",
    "  fs.writeSync(1, Buffer.alloc(Number(process.env.CPB_FAKE_WORKER_OUTPUT_BYTES), 'x'));",
    "  fs.writeSync(1, 'MANAGED-WORKER-TAIL');",
    "  if (process.env.CPB_FAKE_WORKER_OUTPUT_DONE_FILE) fs.writeFileSync(process.env.CPB_FAKE_WORKER_OUTPUT_DONE_FILE, 'done');",
    "}",
    "const grandchild = spawn(process.execPath, ['-e', `",
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.CPB_FAKE_GRANDCHILD_PID_FILE, String(process.pid));",
    "setInterval(() => {}, 1000);",
    "`], { env: process.env, stdio: 'ignore' });",
    "fs.writeFileSync(process.env.CPB_FAKE_GRANDCHILD_PARENT_FILE, String(grandchild.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  await chmod(workerScript, 0o755);
  return distRoot;
}

const managedWorkerAgents = {
  planner: "codex",
  executor: "claude-glm",
  verifier: "codex",
  adversarial_verifier: "codex",
};

test("runManagedWorker abort waits for verified worker and grandchild teardown", async () => {
  const root = await tempRoot("cpb-managed-worker-abort-tree");
  const distRoot = await writeFakeManagedWorkerDist(root);
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const workerPidPath = path.join(root, "worker.pid");
  const grandchildPidPath = path.join(root, "grandchild.pid");
  const grandchildParentPath = path.join(root, "grandchild-parent.pid");
  const controller = new AbortController();

  const pending = withTemporaryEnv({ CPB_KILL_GRACE_MS: "20" }, async () => runManagedWorker({
    workerId: "worker-test",
    hubRoot,
    cpbRoot,
    assignmentId: "assignment-test",
    phaseAgents: managedWorkerAgents,
    timeoutMs: 30_000,
    distRoot,
    signal: controller.signal,
    extraEnv: {
      CPB_FAKE_WORKER_PID_FILE: workerPidPath,
      CPB_FAKE_GRANDCHILD_PID_FILE: grandchildPidPath,
      CPB_FAKE_GRANDCHILD_PARENT_FILE: grandchildParentPath,
    },
  }));

  assert.equal(await waitForCondition(() => fileExists(workerPidPath)), true);
  assert.equal(await waitForCondition(() => fileExists(grandchildPidPath)), true);
  const workerPid = Number(await readFile(workerPidPath, "utf8"));
  const grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
  assert.equal(pidIsAlive(workerPid), true);
  assert.equal(pidIsAlive(grandchildPid), true);

  controller.abort("abort managed worker");
  const result = await pending;

  assert.match(result.errorMessage || "", /abort managed worker/);
  assert.equal(await waitForCondition(() => !pidIsAlive(workerPid)), true);
  assert.equal(await waitForCondition(() => !pidIsAlive(grandchildPid)), true);
});

test("runManagedWorker abort rejects when process-tree cleanup verification fails", async () => {
  const root = await tempRoot("cpb-managed-worker-cleanup-fail");
  const distRoot = await writeFakeManagedWorkerDist(root);
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const workerPidPath = path.join(root, "worker.pid");
  const controller = new AbortController();
  const pending = runManagedWorker({
    workerId: "worker-cleanup-fail",
    hubRoot,
    cpbRoot,
    assignmentId: "assignment-cleanup-fail",
    phaseAgents: managedWorkerAgents,
    timeoutMs: 30_000,
    distRoot,
    signal: controller.signal,
    teardownProcessTree: async (pid, { expectedRootIdentity }) => {
      assert.equal(expectedRootIdentity.pid, pid);
      assert.equal(expectedRootIdentity.birthIdPrecision, "exact");
      await killTree(pid, 20, { requireDescendantScan: true, expectedRootIdentity });
      throw new Error("managed worker cleanup could not be verified");
    },
    extraEnv: {
      CPB_FAKE_WORKER_PID_FILE: workerPidPath,
      CPB_FAKE_GRANDCHILD_PID_FILE: path.join(root, "grandchild.pid"),
      CPB_FAKE_GRANDCHILD_PARENT_FILE: path.join(root, "grandchild-parent.pid"),
    },
  });

  assert.equal(await waitForCondition(() => fileExists(workerPidPath)), true);
  controller.abort("abort cleanup failure");
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    const aggregate = error as AggregateError;
    assert.match(String(aggregate.errors[0]), /abort cleanup failure/);
    assert.match(String(aggregate.errors[1]), /managed worker cleanup could not be verified/);
    return true;
  });
});

test("runManagedWorker preabort rejects before spawning the worker", async () => {
  const root = await tempRoot("cpb-managed-worker-preabort-no-spawn");
  const distRoot = await writeFakeManagedWorkerDist(root);
  const controller = new AbortController();
  const workerPidPath = path.join(root, "worker.pid");
  controller.abort("preabort managed worker");

  await assert.rejects(() => runManagedWorker({
    workerId: "worker-preabort",
    hubRoot: path.join(root, "hub"),
    cpbRoot: path.join(root, "cpb"),
    assignmentId: "assignment-preabort",
    phaseAgents: managedWorkerAgents,
    timeoutMs: 30_000,
    distRoot,
    signal: controller.signal,
    extraEnv: {
      CPB_FAKE_WORKER_PID_FILE: workerPidPath,
      CPB_FAKE_GRANDCHILD_PID_FILE: path.join(root, "grandchild.pid"),
      CPB_FAKE_GRANDCHILD_PARENT_FILE: path.join(root, "grandchild-parent.pid"),
    },
  }), /preabort managed worker/);

  assert.equal(await fileExists(workerPidPath), false);
});

test("runManagedWorker timeout starts teardown at timeoutMs without the legacy 30s delay", async () => {
  const root = await tempRoot("cpb-managed-worker-precise-timeout");
  const distRoot = await writeFakeManagedWorkerDist(root);
  const workerPidPath = path.join(root, "worker.pid");
  const startedAt = Date.now();

  const result = await withTemporaryEnv({ CPB_KILL_GRACE_MS: "20" }, async () => runManagedWorker({
    workerId: "worker-timeout",
    hubRoot: path.join(root, "hub"),
    cpbRoot: path.join(root, "cpb"),
    assignmentId: "assignment-timeout",
    phaseAgents: managedWorkerAgents,
    timeoutMs: 100,
    distRoot,
    extraEnv: {
      CPB_FAKE_WORKER_PID_FILE: workerPidPath,
      CPB_FAKE_GRANDCHILD_PID_FILE: path.join(root, "grandchild.pid"),
      CPB_FAKE_GRANDCHILD_PARENT_FILE: path.join(root, "grandchild-parent.pid"),
    },
  }));

  assert.equal(result.timedOut, true);
  assert.match(result.errorMessage || "", /timed out after 100ms/);
  assert.ok(Date.now() - startedAt < 5000, "timeout must not wait for the previous timeoutMs + 30s trigger");
});

test("runManagedWorker includes bounded timeout cancel-write failures before settling", async () => {
  const root = await tempRoot("cpb-managed-worker-timeout-cancel-write");
  const distRoot = await writeFakeManagedWorkerDist(root);
  const hubRootFile = path.join(root, "hub-as-file");
  await writeFile(hubRootFile, "not a directory", "utf8");

  const result = await withTemporaryEnv({ CPB_KILL_GRACE_MS: "20" }, async () => runManagedWorker({
    workerId: "worker-timeout-cancel-write",
    hubRoot: hubRootFile,
    cpbRoot: path.join(root, "cpb"),
    assignmentId: "assignment-timeout-cancel-write",
    phaseAgents: managedWorkerAgents,
    timeoutMs: 100,
    distRoot,
    extraEnv: {
      CPB_FAKE_WORKER_PID_FILE: path.join(root, "worker.pid"),
      CPB_FAKE_GRANDCHILD_PID_FILE: path.join(root, "grandchild.pid"),
      CPB_FAKE_GRANDCHILD_PARENT_FILE: path.join(root, "grandchild-parent.pid"),
    },
  }));

  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /failed to request worker cancellation/);
});

test("runManagedWorker caps stdout by bytes while retaining the useful tail", async () => {
  const root = await tempRoot("cpb-managed-worker-output-byte-cap");
  const distRoot = await writeFakeManagedWorkerDist(root);
  const outputDonePath = path.join(root, "output.done");
  const controller = new AbortController();
  let notifySpawn: (identity: NonNullable<Awaited<ReturnType<typeof runManagedWorker>>["rootIdentity"]>) => void = () => {};
  const spawned = new Promise<NonNullable<Awaited<ReturnType<typeof runManagedWorker>>["rootIdentity"]>>((resolve) => {
    notifySpawn = resolve;
  });
  const pending = withTemporaryEnv({ CPB_KILL_GRACE_MS: "20" }, async () => runManagedWorker({
    workerId: "worker-output-byte-cap",
    hubRoot: path.join(root, "hub"),
    cpbRoot: path.join(root, "cpb"),
    assignmentId: "assignment-output-byte-cap",
    phaseAgents: managedWorkerAgents,
    timeoutMs: 30_000,
    distRoot,
    signal: controller.signal,
    onSpawn: notifySpawn,
    extraEnv: {
      CPB_FAKE_WORKER_PID_FILE: path.join(root, "worker.pid"),
      CPB_FAKE_GRANDCHILD_PID_FILE: path.join(root, "grandchild.pid"),
      CPB_FAKE_GRANDCHILD_PARENT_FILE: path.join(root, "grandchild-parent.pid"),
      CPB_FAKE_WORKER_OUTPUT_BYTES: "2100000",
      CPB_FAKE_WORKER_OUTPUT_DONE_FILE: outputDonePath,
    },
  }));
  const workerIdentity = await spawned;
  assert.equal(await waitForCondition(() => fileExists(outputDonePath), 10_000), true);
  controller.abort("output writer completed");
  const result = await pending;

  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 2_000_000);
  assert.equal(result.stdout.endsWith("MANAGED-WORKER-TAIL"), true);
  assert.ok(result.rootIdentity);
  assert.equal(result.rootIdentity.incarnation, workerIdentity.incarnation);
  assert.equal(isProcessIdentityAlive(workerIdentity), false);
});

test("runManagedWorker cancel deadline leaves no post-settle mutation", async () => {
  const root = await tempRoot("cpb-managed-worker-cancel-post-settle");
  const distRoot = await writeFakeManagedWorkerDist(root);
  const hubRoot = path.join(root, "hub");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: "cancel-post-settle",
    projectId: "project",
    task: "cancel after deadline",
    sourcePath: root,
  });
  const assignmentId = String(assignment.assignmentId);
  await store.createAttempt(assignmentId, { workerId: "worker-cancel-post-settle", orchestratorEpoch: 1 });
  const lockDir = path.join(hubRoot, "assignments", assignmentId, "state.lock");
  await rm(lockDir, { recursive: true, force: true });
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({
    ownerToken: "held-through-cancel-deadline",
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
  })}\n`, "utf8");
  const postCommitMarker = path.join(root, "post-settle-cancel-commit.marker");
  __assignmentStoreTestHooks.afterLocalCancelCommit = async () => {
    await writeFile(postCommitMarker, "late cancel commit\n", "utf8");
  };

  try {
    const result = await withTemporaryEnv({
      CPB_KILL_GRACE_MS: "20",
      CPB_MANAGED_WORKER_CANCEL_WRITE_TIMEOUT_MS: "50",
    }, async () => runManagedWorker({
      workerId: "worker-cancel-post-settle",
      hubRoot,
      cpbRoot: path.join(root, "cpb"),
      assignmentId,
      phaseAgents: managedWorkerAgents,
      timeoutMs: 100,
      distRoot,
      extraEnv: {
        CPB_FAKE_WORKER_PID_FILE: path.join(root, "worker.pid"),
        CPB_FAKE_GRANDCHILD_PID_FILE: path.join(root, "grandchild.pid"),
        CPB_FAKE_GRANDCHILD_PARENT_FILE: path.join(root, "grandchild-parent.pid"),
      },
    }));
    assert.equal(result.timedOut, true);
    assert.match(result.stderr, /cancel write timed out|deadline exceeded|assignment operation aborted/);
    await rm(lockDir, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await fileExists(postCommitMarker), false);
    assert.equal(await store.readCancel(assignmentId, 1), null);
  } finally {
    __assignmentStoreTestHooks.afterLocalCancelCommit = undefined;
    await rm(lockDir, { recursive: true, force: true });
  }
});

test("runManagedWorker preserves Error abort reason details", async () => {
  const root = await tempRoot("cpb-managed-worker-error-reason");
  const distRoot = await writeFakeManagedWorkerDist(root);
  const workerPidPath = path.join(root, "worker.pid");
  const controller = new AbortController();
  let notifySpawn: (identity: NonNullable<Awaited<ReturnType<typeof runManagedWorker>>["rootIdentity"]>) => void = () => {};
  const spawned = new Promise<NonNullable<Awaited<ReturnType<typeof runManagedWorker>>["rootIdentity"]>>((resolve) => {
    notifySpawn = resolve;
  });
  const pending = withTemporaryEnv({ CPB_KILL_GRACE_MS: "20" }, async () => runManagedWorker({
    workerId: "worker-error-reason",
    hubRoot: path.join(root, "hub"),
    cpbRoot: path.join(root, "cpb"),
    assignmentId: "assignment-error-reason",
    phaseAgents: managedWorkerAgents,
    timeoutMs: 30_000,
    distRoot,
    signal: controller.signal,
    onSpawn: notifySpawn,
    extraEnv: {
      CPB_FAKE_WORKER_PID_FILE: workerPidPath,
      CPB_FAKE_GRANDCHILD_PID_FILE: path.join(root, "grandchild.pid"),
      CPB_FAKE_GRANDCHILD_PARENT_FILE: path.join(root, "grandchild-parent.pid"),
    },
  }));

  const workerIdentity = await spawned;
  const cause = new Error("inner cause");
  const reason = Object.assign(new Error("structured abort", { cause }), { name: "StructuredAbort", code: "STRUCTURED_ABORT" });
  controller.abort(reason);
  const result = await pending;

  assert.equal(result.errorMessage, "structured abort");
  assert.equal(result.errorName, "StructuredAbort");
  assert.equal(result.errorCode, "STRUCTURED_ABORT");
  assert.equal(result.errorCause, cause);
  assert.equal(isProcessIdentityAlive(workerIdentity), false);
});

test("runManagedWorker aggregates synchronous teardown failures after the primary abort reason", async () => {
  const root = await tempRoot("cpb-managed-worker-sync-cleanup-failure");
  const distRoot = await writeFakeManagedWorkerDist(root);
  const workerPidPath = path.join(root, "worker.pid");
  const controller = new AbortController();
  const reason = Object.assign(new Error("primary abort reason"), { code: "PRIMARY_ABORT" });
  let notifySpawn: (identity: NonNullable<Awaited<ReturnType<typeof runManagedWorker>>["rootIdentity"]>) => void = () => {};
  const spawned = new Promise<NonNullable<Awaited<ReturnType<typeof runManagedWorker>>["rootIdentity"]>>((resolve) => {
    notifySpawn = resolve;
  });
  const pending = runManagedWorker({
    workerId: "worker-sync-cleanup-failure",
    hubRoot: path.join(root, "hub"),
    cpbRoot: path.join(root, "cpb"),
    assignmentId: "assignment-sync-cleanup-failure",
    phaseAgents: managedWorkerAgents,
    timeoutMs: 30_000,
    distRoot,
    signal: controller.signal,
    onSpawn: notifySpawn,
    teardownProcessTree: (pid) => {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
      throw new Error("sync cleanup failure");
    },
    extraEnv: {
      CPB_FAKE_WORKER_PID_FILE: workerPidPath,
      CPB_FAKE_GRANDCHILD_PID_FILE: path.join(root, "grandchild.pid"),
      CPB_FAKE_GRANDCHILD_PARENT_FILE: path.join(root, "grandchild-parent.pid"),
    },
  });

  const workerIdentity = await spawned;
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    const aggregate = error as AggregateError;
    assert.equal(aggregate.errors[0], reason);
    assert.match(String(aggregate.errors[1]), /sync cleanup failure/);
    return true;
  });
  assert.equal(isProcessIdentityAlive(workerIdentity), false);
});

test("runManagedWorker rejects when teardown hangs past the watchdog", async () => {
  const root = await tempRoot("cpb-managed-worker-teardown-watchdog");
  const distRoot = await writeFakeManagedWorkerDist(root);
  const workerPidPath = path.join(root, "worker.pid");
  const controller = new AbortController();
  let productionRootIdentity: ProcessIdentity | null = null;
  const pending = withTemporaryEnv({
    CPB_MANAGED_WORKER_TEARDOWN_TIMEOUT_MS: "50",
  }, async () => runManagedWorker({
    workerId: "worker-teardown-watchdog",
    hubRoot: path.join(root, "hub"),
    cpbRoot: path.join(root, "cpb"),
    assignmentId: "assignment-teardown-watchdog",
    phaseAgents: managedWorkerAgents,
    timeoutMs: 30_000,
    distRoot,
    signal: controller.signal,
    teardownProcessTree: async (pid, { signal, expectedRootIdentity }) => {
      assert.equal(expectedRootIdentity.pid, pid);
      assert.equal(expectedRootIdentity.birthIdPrecision, "exact");
      productionRootIdentity = expectedRootIdentity;
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await killTree(pid, 20, { requireDescendantScan: true, expectedRootIdentity });
      throw signal.reason;
    },
    extraEnv: {
      CPB_FAKE_WORKER_PID_FILE: workerPidPath,
      CPB_FAKE_GRANDCHILD_PID_FILE: path.join(root, "grandchild.pid"),
      CPB_FAKE_GRANDCHILD_PARENT_FILE: path.join(root, "grandchild-parent.pid"),
    },
  }));

  assert.equal(await waitForCondition(() => fileExists(workerPidPath)), true);
  const workerPid = Number(await readFile(workerPidPath, "utf8"));
  controller.abort("abort teardown watchdog");
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    const aggregate = error as AggregateError;
    assert.match(String(aggregate.errors[0]), /abort teardown watchdog/);
    assert.match(String(aggregate.errors[1]), /managed worker teardown timed out after 50ms/);
    return true;
  });
  const fallbackIdentity = productionRootIdentity as ProcessIdentity | null;
  assert.ok(fallbackIdentity, "production teardown must provide the spawn-bound worker identity");
  await killTree(workerPid, 20, {
    requireDescendantScan: true,
    expectedRootIdentity: fallbackIdentity,
  }).catch(() => undefined);
});

async function writeFakeQuotaDelegateDist(root: string) {
  const distRoot = path.join(root, "dist");
  const script = path.join(distRoot, "server", "services", "quota-delegate.js");
  await mkdir(path.dirname(script), { recursive: true });
  const processTreeModule = pathToFileURL(path.join(process.cwd(), "dist", "core", "runtime", "process-tree.js")).href;
  await writeFile(script, [
    "import { spawn, spawnSync } from 'node:child_process';",
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    `const { captureProcessIdentity } = await import(${JSON.stringify(processTreeModule)});`,
    "const hubRoot = process.argv[process.argv.indexOf('--hub-root') + 1];",
    "const ownerToken = process.argv[process.argv.indexOf('--owner-token') + 1];",
    "const processIdentity = captureProcessIdentity(process.pid, { strict: true });",
    "if (!processIdentity) throw new Error('fake quota delegate exact process identity unavailable');",
    "const delegateDir = path.join(hubRoot, 'providers', 'delegate');",
    "mkdirSync(delegateDir, { recursive: true });",
    "writeFileSync(path.join(delegateDir, 'delegate.lock'), JSON.stringify({",
    "  pid: process.pid,",
    "  hubRoot,",
    "  startedAt: new Date().toISOString(),",
    "  ownerToken,",
    "  generation: ownerToken,",
    "  processIdentity,",
    "  incarnation: processIdentity.incarnation,",
    "}));",
    "if (process.env.CPB_FAKE_DELEGATE_PID_FILE) writeFileSync(process.env.CPB_FAKE_DELEGATE_PID_FILE, String(process.pid));",
    "const grandchild = spawn(process.execPath, ['-e', \"setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
    "if (process.env.CPB_FAKE_DELEGATE_GRANDCHILD_PID_FILE) writeFileSync(process.env.CPB_FAKE_DELEGATE_GRANDCHILD_PID_FILE, String(grandchild.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  await chmod(script, 0o755);
  return distRoot;
}

test("startQuotaDelegate stops the detached delegate tree and propagates cleanup failures", async () => {
  const root = await tempRoot("cpb-quota-delegate-tree-cleanup");
  const distRoot = await writeFakeQuotaDelegateDist(root);
  const hubRoot = path.join(root, "hub");
  const laneRoot = path.join(root, "lane");
  await mkdir(laneRoot, { recursive: true });
  const delegatePidPath = path.join(root, "delegate.pid");
  const grandchildPidPath = path.join(root, "delegate-grandchild.pid");

  const stop = await withTemporaryEnv({
    CPB_KILL_GRACE_MS: "20",
    CPB_FAKE_DELEGATE_PID_FILE: delegatePidPath,
    CPB_FAKE_DELEGATE_GRANDCHILD_PID_FILE: grandchildPidPath,
  }, async () => startQuotaDelegate(hubRoot, laneRoot, distRoot));

  assert.equal(await waitForCondition(() => fileExists(delegatePidPath)), true);
  assert.equal(await waitForCondition(() => fileExists(grandchildPidPath)), true);
  const delegatePid = Number(await readFile(delegatePidPath, "utf8"));
  const grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
  await stop();
  assert.equal(await waitForCondition(() => !pidIsAlive(delegatePid)), true);
  assert.equal(await waitForCondition(() => !pidIsAlive(grandchildPid)), true);

  const failingRoot = await tempRoot("cpb-quota-delegate-cleanup-failure");
  const failingDistRoot = await writeFakeQuotaDelegateDist(failingRoot);
  const failingHubRoot = path.join(failingRoot, "hub");
  const failingLaneRoot = path.join(failingRoot, "lane");
  await mkdir(failingLaneRoot, { recursive: true });
  const failingStop = await startQuotaDelegate(
    failingHubRoot,
    failingLaneRoot,
    failingDistRoot,
    undefined,
    async (pid, { expectedRootIdentity }) => {
      assert.equal(expectedRootIdentity.pid, pid);
      assert.equal(expectedRootIdentity.birthIdPrecision, "exact");
      await killTree(pid, 20, { requireDescendantScan: true, expectedRootIdentity });
      throw new Error("quota delegate cleanup could not be verified");
    },
  );
  await assert.rejects(failingStop, /quota delegate cleanup failed/);
});

test("startQuotaDelegate handles spawn errors and removes startup abort listeners", async () => {
  const root = await tempRoot("cpb-quota-delegate-spawn-error");
  const hubRoot = path.join(root, "hub");
  const laneRoot = path.join(root, "lane");
  await mkdir(laneRoot, { recursive: true });
  const controller = new AbortController();
  let abortListeners = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
    if (type === "abort") abortListeners += 1;
    return originalAdd(type, listener, options);
  }) as AbortSignal["addEventListener"];
  controller.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => {
    if (type === "abort") abortListeners -= 1;
    return originalRemove(type, listener, options);
  }) as AbortSignal["removeEventListener"];

  await assert.rejects(
    () => startQuotaDelegate(hubRoot, laneRoot, path.join(root, "missing-dist"), controller.signal),
    /quota delegate failed to start|quota delegate exited during startup/,
  );
  assert.equal(abortListeners, 0);
});

test("startQuotaDelegate cancels a hung teardown and waits for it to converge", async () => {
  const root = await tempRoot("cpb-quota-delegate-close-watchdog");
  const distRoot = await writeFakeQuotaDelegateDist(root);
  const hubRoot = path.join(root, "hub");
  const laneRoot = path.join(root, "lane");
  await mkdir(laneRoot, { recursive: true });
  const delegatePidPath = path.join(root, "delegate.pid");
  await withTemporaryEnv({
    CPB_FAKE_DELEGATE_PID_FILE: delegatePidPath,
    CPB_QUOTA_DELEGATE_TEARDOWN_TIMEOUT_MS: "50",
    CPB_QUOTA_DELEGATE_CLOSE_TIMEOUT_MS: "500",
  }, async () => {
    const stop = await startQuotaDelegate(
      hubRoot,
      laneRoot,
      distRoot,
      undefined,
      async (pid, { signal, expectedRootIdentity }) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await killTree(pid, 20, { requireDescendantScan: true, expectedRootIdentity });
        throw signal.reason;
      },
    );

    assert.equal(await waitForCondition(() => fileExists(delegatePidPath)), true);
    const delegatePid = Number(await readFile(delegatePidPath, "utf8"));
    await assert.rejects(stop, (error: unknown) => nestedErrorMatches(error, /teardown timed out after 50ms/));
    assert.equal(await waitForCondition(() => !pidIsAlive(delegatePid)), true);
  });
});

test("CLI signal handlers abort with conventional exit code and clean listeners", () => {
  for (const [signal, expectedExitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    const target = new EventEmitter();
    const installed = installCliSignalHandlers(new AbortController(), target);
    assert.equal(target.listenerCount("SIGINT"), 1);
    assert.equal(target.listenerCount("SIGTERM"), 1);

    target.emit(signal);
    assert.equal(installed.signal.aborted, true);
    assert.equal(installed.exitCode, expectedExitCode);
    installed.cleanup();
    assert.equal(target.listenerCount("SIGINT"), 0);
    assert.equal(target.listenerCount("SIGTERM"), 0);
  }
});

test("solver dependency roots exclude broad runtime prefixes and identify package caches", async () => {
  const prefix = path.join(await tempRoot("cpb-runtime-prefix"), "conda");
  const sitePackages = path.join(prefix, "lib", "python3.12", "site-packages");
  const parsed = parseRuntimeRoots(JSON.stringify({
    paths: [sitePackages],
    runtimePaths: [path.join(prefix, "include", "python3.12"), path.join(prefix, "bin")],
    prefixes: [prefix],
  }));

  assert.deepEqual(parsed.readRoots.sort(), [
    path.join(prefix, "bin"),
    path.join(prefix, "include", "python3.12"),
    path.join(prefix, "lib"),
    sitePackages,
  ].sort());
  assert.deepEqual(parsed.prefixes, [prefix]);
  assert.equal(parsed.readRoots.includes(prefix), false);
  assert.deepEqual(runtimePackageCacheDenyRoots(parsed.prefixes), [
    path.join(prefix, "conda-bld"),
    path.join(prefix, "pkgs"),
  ]);
});

test("source-boundary preflight probes a file inside denied directories", async () => {
  const root = await tempRoot("cpb-boundary-probe-target");
  const deniedPackage = path.join(root, "pkgs", "project_pkg-2.0", "site-packages", "project_pkg");
  const sentinel = path.join(deniedPackage, "__init__.py");
  await mkdir(deniedPackage, { recursive: true });
  await writeFile(sentinel, "future implementation\n", "utf8");

  assert.equal(await findBoundaryProbeTarget(deniedPackage), sentinel);
});

test("runtime tool shims expose only their package roots and never the task package", async () => {
  const root = await tempRoot("cpb-runtime-tool-shims");
  const bin = path.join(root, "bin");
  const npmRoot = path.join(root, "lib", "node_modules", "npm");
  const taskRoot = path.join(root, "lib", "node_modules", "project-pkg");
  await mkdir(path.join(npmRoot, "bin"), { recursive: true });
  await mkdir(path.join(taskRoot, "bin"), { recursive: true });
  await writeFile(path.join(npmRoot, "package.json"), JSON.stringify({ name: "npm" }), "utf8");
  await writeFile(path.join(taskRoot, "package.json"), JSON.stringify({ name: "project-pkg" }), "utf8");
  await writeFile(path.join(npmRoot, "bin", "npm-cli.js"), "", "utf8");
  await writeFile(path.join(taskRoot, "bin", "cli.js"), "", "utf8");
  await mkdir(bin, { recursive: true });
  await symlink(path.relative(bin, path.join(npmRoot, "bin", "npm-cli.js")), path.join(bin, "npm"));
  await symlink(path.relative(bin, path.join(taskRoot, "bin", "cli.js")), path.join(bin, "project-cli"));

  assert.deepEqual(await discoverExecutablePackageRoots([bin], ["project_pkg"]), [await realpath(npmRoot)]);
});

test("runtime config roots are exact and do not restore install prefixes", () => {
  assert.deepEqual(runtimeConfigReadRoots(["/opt/conda"], {
    OPENSSL_CONF: "/custom/ssl/openssl.cnf",
  }), [
    "/System/Library/OpenSSL",
    "/custom/ssl",
    "/opt/conda/ssl",
  ]);
});

test("source-boundary verdict accepts only permission-denied evidence", () => {
  const deniedTargets = [
    { deniedPath: "/runtime/project", target: "/runtime/project/__init__.py", kind: "file" as const },
  ];
  assert.deepEqual(evaluateBoundaryProbe({
    inside: { ok: true, code: null },
    denied: [{ target: deniedTargets[0].target, ok: false, code: "EPERM" }],
    network: { connected: false, code: "EACCES" },
  }, deniedTargets), []);
  assert.deepEqual(evaluateBoundaryProbe({
    inside: { ok: true, code: null },
    denied: [{ target: deniedTargets[0].target, ok: false, code: "ENOENT" }],
    network: { connected: false, code: "ECONNREFUSED" },
  }, deniedTargets), [
    "denied_target_not_permission_blocked:/runtime/project/__init__.py:ENOENT",
    "network_not_permission_blocked:ECONNREFUSED",
  ]);
});

test("Claude runtime boundary stream proves restricted tools, hook execution, and exact probe command", () => {
  const command = "node -e probe";
  const probe = {
    inside: { ok: true, code: null },
    denied: [{ target: "/denied/file", ok: false, code: "EPERM" }],
    network: { connected: false, code: "EACCES" },
  };
  const stdout = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      model: "glm-5.2",
      tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Write"],
      mcp_servers: [],
      slash_commands: [],
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "probe-1", name: "Bash", input: { command } }] },
    }),
    JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_name: "PreToolUse:Bash",
      output: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }),
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "probe-1", content: JSON.stringify(probe) }] },
    }),
  ].join("\n");

  const parsed = parseClaudeRuntimeBoundaryStream(stdout, command, "glm-5.2");
  assert.deepEqual(parsed.violations, []);
  assert.deepEqual(parsed.probe, probe);
  assert.equal(parsed.hookAllowed, true);

  const changed = parseClaudeRuntimeBoundaryStream(stdout, `${command} changed`, "glm-5.2");
  assert.deepEqual(changed.violations, ["claude_bash_probe_command_changed"]);
  assert.equal(claudeRuntimeBoundaryRetryReason(changed), "model_changed_bash_probe_command");

  const refusal = parseClaudeRuntimeBoundaryStream(stdout.split("\n")[0], command, "glm-5.2");
  assert.deepEqual(refusal.violations, [
    "claude_bash_probe_missing",
    "claude_bash_probe_command_changed",
    "claude_path_guard_hook_not_observed",
  ]);
  assert.equal(claudeRuntimeBoundaryRetryReason(refusal), "model_did_not_invoke_bash_probe");
  assert.equal(
    claudeRuntimeBoundaryRetryReason(refusal, "API Error: 429 限额将在 2026-07-16 19:58:30 重置"),
    "provider_transient_failure",
  );

  const missingHook = parseClaudeRuntimeBoundaryStream([
    stdout.split("\n")[0],
    stdout.split("\n")[1],
  ].join("\n"), command, "glm-5.2");
  assert.equal(claudeRuntimeBoundaryRetryReason(missingHook), null);
});

test("invalidated runs cannot be resumed or scored", async () => {
  const root = await tempRoot("cpb-invalidated-run");
  await writeFile(path.join(root, "INVALIDATED.json"), JSON.stringify({ reason: "source_boundary_leak" }), "utf8");
  await assert.rejects(
    () => assertRunNotInvalidated(root),
    /permanently invalidated \(source_boundary_leak\)/,
  );
});

test("three-way manifests keep evaluator identity and oracle tests out of the solver projection", () => {
  const manifests = buildFrozenManifests([{ rowIndex: 7, row }], "comparison-run");
  const solverJson = JSON.stringify(manifests.solver);
  const evaluatorJson = JSON.stringify(manifests.evaluator);

  assert.match(solverJson, /Fix the cache invalidation bug/);
  assert.match(solverJson, /owner\/repo/);
  assert.doesNotMatch(solverJson, /owner__repo-123|FAIL_TO_PASS|PASS_TO_PASS|test_rename|test_get/);
  assert.match(evaluatorJson, /owner__repo-123|test_rename|test_get/);
  assert.equal(manifests.evaluator.solverManifestSha256, manifests.solver.manifestSha256);
  assert.match(manifests.solver.tasks[0].opaqueId, /^task-[a-f0-9]{16}$/);
});

test("prompt leakage gate catches benchmark identity and evaluator contracts", () => {
  assert.deepEqual(promptLeakageViolations("Fix the cache invalidation bug.", "owner__repo-123"), []);
  const violations = promptLeakageViolations(
    "Run SWE-bench owner__repo-123 FAIL_TO_PASS with the official harness and gold patch.",
    "owner__repo-123",
  );
  assert.deepEqual(violations.sort(), [
    "benchmark_name",
    "fail_to_pass",
    "gold_patch",
    "instance_id",
    "official_harness",
  ]);
});

test("official scoring accepts frozen solver failures but rejects leakage or missing candidates", () => {
  const frozenFailure = {
    lane: "cpb_high_assurance" as const,
    opaqueId: "task-a",
    status: "failed" as const,
    patchPath: "/run/task-a/candidate.patch",
    patchSha256: "a".repeat(64),
    patchBytes: 128,
    error: "independent verification environment was not executable",
    timedOut: false,
    metadata: {
      jobFailure: {
        kind: "verification_failed",
        cause: {
          verificationInfrastructure: { failureClass: "verification_infrastructure" },
        },
      },
    },
  };
  const accepted = summarizeCandidateFreeze([frozenFailure]);
  assert.equal(accepted.complete, true);
  assert.equal(accepted.solverFailures.length, 1);
  assert.equal(accepted.solverFailures[0].failureClass, "verification_infrastructure");
  assert.equal(accepted.solverOutcomeSummary.totals.verification_infrastructure, 1);

  const blocked = summarizeCandidateFreeze([{ ...frozenFailure, status: "blocked" as const }]);
  assert.equal(blocked.complete, false);
  assert.equal(blocked.blocked.length, 1);

  const missing = summarizeCandidateFreeze([{ ...frozenFailure, patchSha256: "" }]);
  assert.equal(missing.complete, false);
  assert.equal(missing.missingArtifacts.length, 1);
});

test("solver classifications stay separate from official implementation failures", () => {
  const base = {
    lane: "cpb_high_assurance" as const,
    opaqueId: "task-a",
    status: "failed" as const,
    timedOut: false,
    error: null,
  };
  const verificationInfrastructure = {
    ...base,
    metadata: {
      jobFailure: {
        kind: "verification_failed",
        cause: { verificationInfrastructure: { failureClass: "verification_infrastructure" } },
      },
    },
  };
  assert.equal(classifySolverOutcome(verificationInfrastructure), "verification_infrastructure");
  assert.equal(classifySolverOutcome({
    ...base,
    metadata: { jobFailure: { kind: "verification_failed", cause: {} } },
  }), "semantic_verification_failure");
  assert.equal(classifySolverOutcome({
    ...base,
    metadata: { jobFailure: { kind: "scope_violation", cause: {} } },
  }), "workflow_policy_failure");

  const correlation = correlateSolverAndHarnessOutcomes(
    [verificationInfrastructure],
    [{ opaqueId: "task-a", instanceId: "owner__repo-123" }],
    [{
      lane: "cpb_high_assurance",
      resolvedIds: ["owner__repo-123"],
      unresolvedIds: [],
      errorIds: [],
    }],
  );
  assert.equal(
    correlation.totals["verification_infrastructure->official_resolved"],
    1,
  );
  assert.deepEqual(correlation.internalFalseNegatives, [{
    lane: "cpb_high_assurance",
    opaqueId: "task-a",
    instanceId: "owner__repo-123",
  }]);
});

test("solver retries are limited to transient infrastructure and provider failures", () => {
  const base = { status: "failed" as const, timedOut: false, error: null, metadata: {} };
  assert.equal(isTransientSolverFailure({ ...base, error: "529 overloaded after retry budget" }), true);
  assert.equal(isTransientSolverFailure({ ...base, error: "stream disconnected before completion" }), true);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "codex exited null: ",
    metadata: { jobFailure: { kind: "agent_unavailable", retryable: true } },
  }), true);
  assert.equal(isTransientSolverFailure({
    ...base,
    metadata: { jobFailure: { kind: "runtime_interrupted", retryable: true } },
  }), true);
  assert.equal(isTransientSolverFailure({
    ...base,
    metadata: { jobFailure: { kind: "runtime_interrupted", retryable: false } },
  }), false);
  assert.equal(isTransientSolverFailure({
    ...base,
    metadata: { jobFailure: { kind: "unknown", retryable: true } },
  }, "timeout while unrelated lease monitor was stopping"), false);
  assert.equal(isTransientSolverFailure({ ...base, timedOut: true }), true);
  assert.equal(isTransientSolverFailure({ ...base, error: "verification failed: assertion mismatch" }), false);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "verification failed: assertion mismatch",
    metadata: { jobFailure: { kind: "verification_failed", retryable: true } },
  }, "worker execution lease renewal temporarily unavailable"), false);
  assert.equal(isTransientSolverFailure({ ...base, status: "blocked" as const, error: "529" }), false);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "agent contract invalid",
    metadata: { idleTimeoutMs: 120000, jobFailure: { kind: "agent_contract_invalid" } },
  }), false);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "generated checklist contract invalid",
    metadata: { jobFailure: { kind: "artifact_invalid", retryable: true } },
  }), true);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "planner exceeded its bounded discovery budget",
    metadata: { jobFailure: { kind: "tool_budget_exceeded", retryable: true } },
  }), true);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "planner exceeded its bounded discovery budget",
    metadata: { jobFailure: { kind: "tool_budget_exceeded", retryable: false } },
  }), false);
  assert.equal(isTransientSolverFailure({
    ...base,
    metadata: { jobFailure: { kind: "human_approval_required", retryable: false } },
  }, "worker lease renewal temporarily unavailable"), false);
});

test("solver retry delay honors provider reset timestamps instead of burning the queue", () => {
  const nowMs = Date.parse("2026-07-16T11:00:00.000Z");
  assert.equal(solverRetryDelayMs({ error: null, metadata: {} }, "529 overloaded", 10_000, nowMs), 10_000);
  assert.equal(solverRetryDelayMs({
    error: null,
    metadata: {
      jobFailure: {
        reason: "provider claude:glm unavailable until 2026-07-16T11:58:30.000Z",
      },
    },
  }, "", 10_000, nowMs), 3_511_000);

  const localNowMs = new Date(2026, 6, 16, 19, 0, 0).getTime();
  assert.equal(solverRetryDelayMs(
    { error: null, metadata: {} },
    "[1308][已达到 5 小时的使用上限。您的限额将在 2026-07-16 19:58:30 重置。]",
    10_000,
    localNowMs,
  ), 3_511_000);
});

test("solver attempt history is append-only across resumed invocations", async () => {
  const runRoot = await tempRoot("cpb-solver-attempt-history");
  const lane = "cpb_high_assurance" as const;
  const opaqueId = "task-resume-safe";
  const laneRoot = path.join(runRoot, "lanes", lane, opaqueId);
  const writeFailedAttempt = async (marker: string) => {
    const stdoutPath = path.join(laneRoot, "stdout.log");
    const stderrPath = path.join(laneRoot, "stderr.log");
    const patchPath = path.join(laneRoot, "candidate.patch");
    const eventPath = path.join(laneRoot, "trace", "events.jsonl");
    await mkdir(path.dirname(eventPath), { recursive: true });
    await writeFile(stdoutPath, `${marker}-stdout\n`, "utf8");
    await writeFile(stderrPath, `${marker}-stderr\n`, "utf8");
    await writeFile(patchPath, "", "utf8");
    await writeFile(eventPath, `${marker}-event\n`, "utf8");
    const result = {
      lane,
      opaqueId,
      status: "failed" as const,
      startedAt: "2026-07-15T00:00:00.000Z",
      completedAt: "2026-07-15T00:01:00.000Z",
      sourcePath: path.join(laneRoot, "source"),
      patchPath,
      patchSha256: createHash("sha256").update("").digest("hex"),
      patchBytes: 0,
      exitCode: 0,
      signal: null,
      timedOut: false,
      error: `${marker}-failure`,
      promptLeakage: [],
      stdoutPath,
      stderrPath,
      metadata: {
        eventPath,
        jobFailure: {
          kind: "agent_contract_invalid",
          phase: "assurance_plan",
          reason: `${marker}-budget-exceeded`,
          retryable: true,
        },
      },
    };
    await writeFile(path.join(laneRoot, "result.json"), JSON.stringify(result), "utf8");
    await writeFile(path.join(laneRoot, "state.json"), JSON.stringify(result), "utf8");
    return result;
  };

  assert.equal(nextSolverAttemptNumber(["index.json", "attempt-001", "attempt-009"]), 10);
  const first = await archiveLaneAttempt(
    await writeFailedAttempt("first"),
    1,
    { runRoot, solverRetryBackoffMs: 10 },
    "invocation-a",
  );
  const second = await archiveLaneAttempt(
    await writeFailedAttempt("second"),
    1,
    { runRoot, solverRetryBackoffMs: 10 },
    "invocation-b",
  );

  assert.equal(first.historyAttempt, 1);
  assert.equal(second.historyAttempt, 2);
  const historyRoot = path.join(runRoot, "attempt-history", lane, opaqueId);
  assert.equal(await readFile(path.join(historyRoot, "attempt-001", "stdout.log"), "utf8"), "first-stdout\n");
  assert.equal(await readFile(path.join(historyRoot, "attempt-002", "stdout.log"), "utf8"), "second-stdout\n");
  const firstRecord = JSON.parse(await readFile(path.join(historyRoot, "attempt-001", "archive-record.json"), "utf8"));
  assert.equal(firstRecord.invocationId, "invocation-a");
  assert.equal(firstRecord.decision, "retry_transient_failure");
  assert.equal(firstRecord.artifacts.some((artifact: { path: string }) => artifact.path.endsWith("trace/events.jsonl")), true);
  assert.equal(firstRecord.pathRelocations.some((entry: { archivedPath: string }) => entry.archivedPath.includes("attempt-001")), true);
  const index = JSON.parse(await readFile(path.join(historyRoot, "index.json"), "utf8"));
  assert.deepEqual(index.attempts.map((attempt: { historyAttempt: number }) => attempt.historyAttempt), [1, 2]);
  assert.deepEqual(index.attempts.map((attempt: { invocationId: string }) => attempt.invocationId), ["invocation-a", "invocation-b"]);
});

test("solver resume archives an interrupted lane before starting clean", async () => {
  const runRoot = await tempRoot("cpb-solver-interrupted-lane");
  const lane = "native_codex" as const;
  const opaqueId = "task-interrupted";
  const laneRoot = path.join(runRoot, "lanes", lane, opaqueId);
  await mkdir(laneRoot, { recursive: true });
  await writeFile(path.join(laneRoot, "stdout.log"), "partial trace\n", "utf8");

  const existing = await prepareLaneForSolverInvocation(
    lane,
    opaqueId,
    { runRoot, solverRetryBackoffMs: 10 },
    "invocation-resume",
  );

  assert.equal(existing, null);
  const archiveRoot = path.join(runRoot, "attempt-history", lane, opaqueId, "attempt-001");
  assert.equal(await readFile(path.join(archiveRoot, "stdout.log"), "utf8"), "partial trace\n");
  const record = JSON.parse(await readFile(path.join(archiveRoot, "archive-record.json"), "utf8"));
  assert.equal(record.decision, "resume_interrupted_attempt");
  assert.equal(record.result, null);
});

test("solver lane concurrency is explicit, bounded, and defaults independently", () => {
  assert.deepEqual(parseSolverLaneConcurrency(null), {
    native_codex: 1,
    native_claude_glm: 1,
    cpb_high_assurance: 1,
  });
  assert.deepEqual(parseSolverLaneConcurrency("2"), {
    native_codex: 2,
    native_claude_glm: 2,
    cpb_high_assurance: 2,
  });
  assert.deepEqual(parseSolverLaneConcurrency("native_codex=2,cpb_high_assurance=3"), {
    native_codex: 2,
    native_claude_glm: 1,
    cpb_high_assurance: 3,
  });
  assert.throws(() => parseSolverLaneConcurrency("native_codex=0"), /at least 1/);
  assert.throws(() => parseSolverLaneConcurrency("unknown=2"), /unknown lane/);
  assert.throws(() => parseSolverLaneConcurrency("native_codex=2,native_codex=3"), /repeats lane/);
});

test("solver lanes advance independently without a per-task barrier", async () => {
  let releaseSlowLane = () => {};
  const slowLaneGate = new Promise<void>((resolve) => { releaseSlowLane = resolve; });
  const completions: string[] = [];
  const output = await runIndependentLaneQueues({
    lanes: ["native_codex", "native_claude_glm", "cpb_high_assurance"],
    taskCount: 3,
    laneConcurrency: {
      native_codex: 2,
      native_claude_glm: 1,
      cpb_high_assurance: 1,
    },
    run: async (lane, taskIndex) => {
      if (lane === "cpb_high_assurance" && taskIndex === 0) await slowLaneGate;
      await new Promise<void>((resolve) => setImmediate(resolve));
      completions.push(`${lane}:${taskIndex}`);
      if (lane === "native_codex" && taskIndex === 2) releaseSlowLane();
      return `${lane}:${taskIndex}`;
    },
  });

  assert.equal(completions.indexOf("native_codex:2") < completions.indexOf("cpb_high_assurance:0"), true);
  assert.deepEqual(output.map((entry) => entry.value), [
    "native_codex:0", "native_claude_glm:0", "cpb_high_assurance:0",
    "native_codex:1", "native_claude_glm:1", "cpb_high_assurance:1",
    "native_codex:2", "native_claude_glm:2", "cpb_high_assurance:2",
  ]);
});

test("solver invocation recovery marks dead owners interrupted and rejects live owners", async () => {
  const runRoot = await tempRoot("cpb-solver-invocation-recovery");
  const invocationRoot = path.join(runRoot, "solver-invocations");
  await mkdir(invocationRoot, { recursive: true });
  await writeFile(path.join(invocationRoot, "dead.json"), JSON.stringify({
    schemaVersion: 2,
    invocationId: "dead",
    status: "running",
    host: "test-host",
    pid: 100,
    processIdentity: {
      pid: 100,
      birthId: "exact-dead-owner",
      incarnation: "100:exact-dead-owner",
      capturedAt: "2026-07-21T00:00:00.000Z",
      birthIdPrecision: "exact",
      processGroupId: 100,
    },
  }), "utf8");

  let pidProbeCalls = 0;
  assert.deepEqual(await reconcileInterruptedSolverInvocations(runRoot, {
    currentPid: 200,
    currentHost: "test-host",
    isPidAlive: () => { pidProbeCalls += 1; return false; },
    isIdentityAlive: () => false,
  }), ["dead"]);
  assert.equal(pidProbeCalls, 0);
  const recovered = JSON.parse(await readFile(path.join(invocationRoot, "dead.json"), "utf8"));
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.interruptionReason, "owner_process_missing");

  await writeFile(path.join(invocationRoot, "live.json"), JSON.stringify({
    schemaVersion: 2,
    invocationId: "live",
    status: "running",
    host: "test-host",
    pid: 300,
    processIdentity: {
      pid: 300,
      birthId: "exact-live-owner",
      incarnation: "300:exact-live-owner",
      capturedAt: "2026-07-21T00:00:00.000Z",
      birthIdPrecision: "exact",
      processGroupId: 300,
    },
  }), "utf8");
  await assert.rejects(() => reconcileInterruptedSolverInvocations(runRoot, {
    currentPid: 200,
    currentHost: "test-host",
    isPidAlive: () => { throw new Error("PID-only liveness must not be used"); },
    isIdentityAlive: () => true,
  }), /solver invocation already active: live/);
});

test("solver invocation recovery preserves legacy running records without exact identity", async () => {
  const runRoot = await tempRoot("cpb-solver-invocation-legacy-identity");
  const invocationRoot = path.join(runRoot, "solver-invocations");
  const invocationPath = path.join(invocationRoot, "legacy.json");
  await mkdir(invocationRoot, { recursive: true });
  await writeFile(invocationPath, JSON.stringify({
    invocationId: "legacy",
    status: "running",
    host: "test-host",
    pid: 300,
  }), "utf8");

  let pidProbeCalls = 0;
  await assert.rejects(
    () => reconcileInterruptedSolverInvocations(runRoot, {
      currentPid: 200,
      currentHost: "test-host",
      isPidAlive: () => { pidProbeCalls += 1; return false; },
      isIdentityAlive: () => false,
    }),
    (error: unknown) => (error as { code?: string }).code === "SOLVER_INVOCATION_OWNER_IDENTITY_UNSAFE",
  );
  assert.equal(pidProbeCalls, 0);
  assert.equal(JSON.parse(await readFile(invocationPath, "utf8")).status, "running");
});

test("solver invocation recovery distinguishes a reused PID predecessor from its live successor", async () => {
  const runRoot = await tempRoot("cpb-solver-invocation-pid-reuse");
  const invocationRoot = path.join(runRoot, "solver-invocations");
  await mkdir(invocationRoot, { recursive: true });
  const currentIdentity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(currentIdentity);
  const currentPid = process.pid === 1 ? 2 : 1;

  await writeFile(path.join(invocationRoot, "predecessor.json"), JSON.stringify({
    invocationId: "predecessor",
    status: "running",
    host: "test-host",
    pid: process.pid,
    processIdentity: {
      ...currentIdentity,
      birthId: "reused-pid-predecessor",
      incarnation: `${process.pid}:reused-pid-predecessor`,
    },
  }), "utf8");
  assert.deepEqual(await reconcileInterruptedSolverInvocations(runRoot, {
    currentPid,
    currentHost: "test-host",
    isPidAlive: () => true,
  }), ["predecessor"]);

  await writeFile(path.join(invocationRoot, "successor.json"), JSON.stringify({
    invocationId: "successor",
    status: "running",
    host: "test-host",
    pid: process.pid,
    processIdentity: currentIdentity,
  }), "utf8");
  await assert.rejects(() => reconcileInterruptedSolverInvocations(runRoot, {
    currentPid,
    currentHost: "test-host",
    isPidAlive: () => false,
  }), /solver invocation already active: successor/);
  assert.equal(JSON.parse(await readFile(path.join(invocationRoot, "successor.json"), "utf8")).status, "running");
});

test("solver invocation recovery fails closed on persisted coarse process identity", async () => {
  const runRoot = await tempRoot("cpb-solver-invocation-coarse-identity");
  const invocationRoot = path.join(runRoot, "solver-invocations");
  await mkdir(invocationRoot, { recursive: true });

  await writeFile(path.join(invocationRoot, "coarse.json"), JSON.stringify({
    invocationId: "coarse",
    status: "running",
    host: "test-host",
    pid: 300,
    processIdentity: {
      pid: 300,
      birthId: "ps-lstart:Tue Jul 21 00:00:00 2026",
      incarnation: "300:ps-lstart:Tue Jul 21 00:00:00 2026",
      capturedAt: "2026-07-21T00:00:00.000Z",
      birthIdPrecision: "coarse",
      processGroupId: 300,
    },
  }), "utf8");

  await assert.rejects(() => reconcileInterruptedSolverInvocations(runRoot, {
    currentPid: 200,
    currentHost: "test-host",
    isPidAlive: () => false,
  }), /solver invocation already active: coarse/);
  assert.equal(JSON.parse(await readFile(path.join(invocationRoot, "coarse.json"), "utf8")).status, "running");
});

test("runCommand fails closed without bare-PID teardown when spawn identity is unavailable", async () => {
  let terminationSignals = 0;
  const processTreeSystemForTest: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => ({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 1,
      signal: null,
    })) as unknown as ProcessTreeSystem["spawnSync"],
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal !== undefined && signal !== 0) terminationSignals += 1;
      return process.kill(pid, signal);
    }) as typeof process.kill,
    captureIdentity: () => null,
  };
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    stdin: null,
    processTreeSystemForTest,
  });

  assert.equal(terminationSignals, 0);
  assert.match(String(result.error), /root process identity unavailable after spawn/);
});

test("source preparation scrubs hostile ambient Git execution config and quarantines its predecessor", async () => {
  const runRoot = await tempRoot("cpb-swebench-source-predecessor");
  const laneRoot = path.join(runRoot, "lanes", "native_codex", "task-a");
  const seedRoot = path.join(runRoot, "seed");
  const cachePath = path.join(runRoot, "source-cache", "owner__repo.git");
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = async (args: string[], cwd: string) => {
    const result = await runCommand({ command: "git", args, cwd, env: gitEnv, timeoutMs: 30_000 });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  await mkdir(seedRoot, { recursive: true });
  await git(["init"], seedRoot);
  await git(["config", "user.email", "cpb-test@example.invalid"], seedRoot);
  await git(["config", "user.name", "CPB Test"], seedRoot);
  await writeFile(path.join(seedRoot, "README.md"), "frozen source\n", "utf8");
  await writeFile(path.join(seedRoot, ".gitattributes"), "README.md filter=evil\n", "utf8");
  await git(["add", "README.md", ".gitattributes"], seedRoot);
  await git(["-c", "commit.gpgsign=false", "commit", "-m", "seed"], seedRoot);
  const baseCommit = await git(["rev-parse", "HEAD"], seedRoot);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await git(["clone", "--bare", seedRoot, cachePath], runRoot);
  await git(["remote", "set-url", "origin", "https://github.com/owner/repo.git"], cachePath);
  const predecessorMarker = path.join(laneRoot, "source", "predecessor.txt");
  await mkdir(path.dirname(predecessorMarker), { recursive: true });
  await writeFile(predecessorMarker, "predecessor generation\n", "utf8");

  const hostileRoot = path.join(runRoot, "hostile-git");
  const hookMarker = path.join(hostileRoot, "hook-ran.txt");
  const filterMarker = path.join(hostileRoot, "filter-ran.txt");
  const fsmonitorMarker = path.join(hostileRoot, "fsmonitor-ran.txt");
  const hooksRoot = path.join(hostileRoot, "hooks");
  const smudgePath = path.join(hostileRoot, "smudge.sh");
  const fsmonitorPath = path.join(hostileRoot, "fsmonitor.sh");
  const hostileConfigPath = path.join(hostileRoot, "config");
  await mkdir(hooksRoot, { recursive: true });
  await writeFile(path.join(hooksRoot, "post-checkout"), `#!/bin/sh\nprintf ran > ${hookMarker}\n`, "utf8");
  await writeFile(smudgePath, `#!/bin/sh\nprintf ran > ${filterMarker}\ncat\n`, "utf8");
  await writeFile(fsmonitorPath, `#!/bin/sh\nprintf ran > ${fsmonitorMarker}\n`, "utf8");
  await chmod(path.join(hooksRoot, "post-checkout"), 0o700);
  await chmod(smudgePath, 0o700);
  await chmod(fsmonitorPath, 0o700);
  await writeFile(hostileConfigPath, [
    "[core]",
    `  hooksPath = ${hooksRoot}`,
    `  fsmonitor = ${fsmonitorPath}`,
    '[filter "evil"]',
    `  smudge = ${smudgePath}`,
    "  required = true",
    "",
  ].join("\n"), "utf8");

  const sourcePath = await withTemporaryEnv({
    GIT_CONFIG_GLOBAL: hostileConfigPath,
    GIT_CONFIG_SYSTEM: hostileConfigPath,
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooksRoot,
  }, () => prepareSource({
    opaqueId: "task-a",
    rowIndex: 0,
    repository: "owner/repo",
    baseCommit,
    task: "ordinary task",
    taskSha256: createHash("sha256").update("ordinary task").digest("hex"),
  }, laneRoot, runRoot));

  assert.equal(await git(["rev-parse", "HEAD"], sourcePath), baseCommit);
  const record = JSON.parse(await readFile(path.join(laneRoot, "source-prepare.json"), "utf8"));
  assert.equal(record.cacheHit, true);
  assert.equal(record.cachePredecessor, null);
  assert.match(record.sourcePredecessor.quarantinePath, /\.quarantine-/);
  assert.equal(
    await readFile(path.join(record.sourcePredecessor.quarantinePath, "predecessor.txt"), "utf8"),
    "predecessor generation\n",
  );
  assert.equal(await fileExists(hookMarker), false);
  assert.equal(await fileExists(filterMarker), false);
  assert.equal(await fileExists(fsmonitorMarker), false);
  assert.equal(await readFile(path.join(sourcePath, "README.md"), "utf8"), "frozen source\n");
});

test("run-path quarantine preserves a successor inserted after ownership validation", async () => {
  const runRoot = await tempRoot("cpb-swebench-run-path-successor");
  const targetPath = path.join(runRoot, "source");
  const displacedPath = path.join(runRoot, "source.displaced");
  await mkdir(targetPath);
  await writeFile(path.join(targetPath, "owner.txt"), "original generation\n", "utf8");
  let quarantineContainer = "";

  await assert.rejects(
    () => quarantineSweBenchRunPath(targetPath, runRoot, {
      hooks: {
        afterOwnershipValidated: async (context) => {
          quarantineContainer = context.quarantineContainer;
          await rename(targetPath, displacedPath);
          await mkdir(targetPath);
          await writeFile(path.join(targetPath, "owner.txt"), "successor generation\n", "utf8");
        },
      },
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "SWEBENCH_RUN_PATH_SUCCESSOR_PRESERVED");
      assert.equal((error as { successorPreserved?: boolean }).successorPreserved, true);
      return true;
    },
  );

  assert.equal(await readFile(path.join(targetPath, "owner.txt"), "utf8"), "successor generation\n");
  assert.equal(await readFile(path.join(displacedPath, "owner.txt"), "utf8"), "original generation\n");
  assert.deepEqual(await readdir(quarantineContainer), []);
});

test("frozen lane compaction removes only rebuildable state and preserves diff and trace evidence", async () => {
  const runRoot = await tempRoot("cpb-solver-lane-compaction");
  const laneRoot = path.join(runRoot, "lanes", "cpb_high_assurance", "task-a");
  const projectRoot = path.join(laneRoot, "hub", "projects", "project-a");
  const preserved = [
    path.join(laneRoot, "candidate.patch"),
    path.join(laneRoot, "stdout.log"),
    path.join(projectRoot, "events", "job.jsonl"),
    path.join(projectRoot, "acp-streams", "execute.jsonl"),
  ];
  const removed = [
    path.join(laneRoot, "source", "large-build.bin"),
    path.join(laneRoot, "tmp", "scratch"),
    path.join(laneRoot, "agent-homes", "native", "cache"),
    path.join(laneRoot, "hub", "worktrees", "job-a", "checkout"),
    path.join(projectRoot, "agent-homes", "codex", "cache"),
  ];
  for (const file of [...preserved, ...removed]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, path.basename(file), "utf8");
  }

  const record = await compactLaneEphemeralArtifacts(laneRoot, runRoot);
  for (const file of preserved) assert.equal(await readFile(file, "utf8"), path.basename(file));
  for (const file of removed) await assert.rejects(() => readFile(file, "utf8"));
  assert.equal(record.removed.some((entry) => entry.endsWith("/source")), true);
  assert.equal(record.removed.some((entry) => entry.endsWith("/hub/worktrees")), true);
  assert.equal(record.preserved.some((entry) => entry.endsWith("/candidate.patch")), true);
  const sourceQuarantine = record.retainedQuarantines.find((entry) => entry.targetPath.endsWith("/source"));
  assert.ok(sourceQuarantine);
  assert.equal(
    await readFile(path.join(runRoot, sourceQuarantine.quarantinePath, "large-build.bin"), "utf8"),
    "large-build.bin",
  );
  const persisted = JSON.parse(await readFile(path.join(laneRoot, "artifact-retention.json"), "utf8"));
  assert.deepEqual(persisted.removed, record.removed);
  assert.deepEqual(persisted.retainedQuarantines, record.retainedQuarantines);

  await assert.rejects(
    () => compactLaneEphemeralArtifacts(runRoot, runRoot),
    /outside the run lanes root/,
  );
});

test("frozen lane compaction propagates discovery failures before moving any artifact", async () => {
  const runRoot = await tempRoot("cpb-solver-lane-compaction-discovery-failure");
  const laneRoot = path.join(runRoot, "lanes", "cpb_high_assurance", "task-a");
  const sourceMarker = path.join(laneRoot, "source", "must-remain.txt");
  await mkdir(path.dirname(sourceMarker), { recursive: true });
  await writeFile(sourceMarker, "preserved after discovery failure\n", "utf8");
  await mkdir(path.join(laneRoot, "hub"), { recursive: true });
  await writeFile(path.join(laneRoot, "hub", "projects"), "not a directory\n", "utf8");

  await assert.rejects(
    () => compactLaneEphemeralArtifacts(laneRoot, runRoot),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
  );
  assert.equal(await readFile(sourceMarker, "utf8"), "preserved after discovery failure\n");
});

test("frozen lane compaction reports prior quarantines when a later boundary check fails", async () => {
  const runRoot = await tempRoot("cpb-solver-lane-compaction-partial-evidence");
  const laneRoot = path.join(runRoot, "lanes", "cpb_high_assurance", "task-a");
  const agentHomeMarker = path.join(laneRoot, "agent-homes", "must-be-recoverable.txt");
  const sourceMarker = path.join(laneRoot, "source", "must-remain-canonical.txt");
  const outsideHub = path.join(runRoot, "outside-hub");
  await mkdir(path.dirname(agentHomeMarker), { recursive: true });
  await mkdir(path.dirname(sourceMarker), { recursive: true });
  await mkdir(outsideHub);
  await writeFile(agentHomeMarker, "recoverable generation\n", "utf8");
  await writeFile(sourceMarker, "not reached\n", "utf8");
  await symlink(outsideHub, path.join(laneRoot, "hub"));

  let completedQuarantine: { quarantinePath: string } | null = null;
  await assert.rejects(
    () => compactLaneEphemeralArtifacts(laneRoot, runRoot),
    (error: unknown) => {
      const failure = error as {
        partiallyCommitted?: boolean;
        completedQuarantines?: Array<{ quarantinePath: string }>;
        recoveryPaths?: string[];
      };
      assert.equal(failure.partiallyCommitted, true);
      assert.equal(failure.completedQuarantines?.length, 1);
      completedQuarantine = failure.completedQuarantines?.[0] || null;
      assert.ok(completedQuarantine);
      assert.ok(failure.recoveryPaths?.includes(completedQuarantine.quarantinePath));
      return true;
    },
  );

  assert.equal(await fileExists(agentHomeMarker), false);
  assert.equal(
    await readFile(path.join((completedQuarantine as { quarantinePath: string }).quarantinePath, "must-be-recoverable.txt"), "utf8"),
    "recoverable generation\n",
  );
  assert.equal(await readFile(sourceMarker, "utf8"), "not reached\n");
});

test("interrupted Claude boundary preflight is append-only archived before a clean retry", async () => {
  const runRoot = await tempRoot("cpb-claude-preflight-recovery");
  const preflightRoot = path.join(runRoot, "preflight", "claude-runtime-boundary");
  const partialLog = path.join(preflightRoot, "attempts", "attempt-001", "stdout.log");
  await mkdir(path.dirname(partialLog), { recursive: true });
  await writeFile(partialLog, "partial boundary stream\n", "utf8");
  await writeFile(
    path.join(preflightRoot, "owner.json"),
    `${JSON.stringify(claudeBoundaryOwner(preflightRoot, 100), null, 2)}\n`,
    "utf8",
  );

  const recovered = await recoverInterruptedClaudeBoundaryPreflight(runRoot, {
    currentHost: "test-host",
    currentPid: 200,
    identityAlive: () => false,
  });
  assert.equal(recovered?.decision, "resume_interrupted_preflight");
  assert.match(String(recovered?.archiveRoot), /^preflight\/claude-runtime-boundary-history\/attempt-001-[0-9a-f-]+$/);
  const archiveRoot = path.join(runRoot, String(recovered?.archiveRoot));
  assert.equal(await readFile(path.join(archiveRoot, "attempts", "attempt-001", "stdout.log"), "utf8"), "partial boundary stream\n");
  const recoveryRecord = JSON.parse(await readFile(path.join(archiveRoot, "recovery-record.json"), "utf8"));
  assert.equal(recoveryRecord.historyAttempt, 1);
  assert.match(recoveryRecord.recoveryToken, /^[0-9a-f-]+$/);
  await assert.rejects(() => readFile(partialLog, "utf8"));

  await mkdir(preflightRoot, { recursive: true });
  await writeFile(
    path.join(preflightRoot, "owner.json"),
    `${JSON.stringify(claudeBoundaryOwner(preflightRoot, 300), null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(() => recoverInterruptedClaudeBoundaryPreflight(runRoot, {
    currentHost: "test-host",
    currentPid: 200,
    identityAlive: (identity) => identity.pid === 300,
  }), /preflight already active/);
});

test("Claude boundary recovery rejects unsafe owner metadata without following or archiving it", async (t) => {
  await t.test("symlink owner", async () => {
    const runRoot = await tempRoot("cpb-claude-preflight-owner-symlink");
    const preflightRoot = path.join(runRoot, "preflight", "claude-runtime-boundary");
    const outsideOwner = path.join(runRoot, "outside-owner.json");
    await mkdir(preflightRoot, { recursive: true });
    await writeFile(outsideOwner, `${JSON.stringify(claudeBoundaryOwner(preflightRoot, 100), null, 2)}\n`, "utf8");
    await symlink(outsideOwner, path.join(preflightRoot, "owner.json"));

    await assert.rejects(
      () => recoverInterruptedClaudeBoundaryPreflight(runRoot, { identityAlive: () => false }),
      (error) => (error as { code?: string }).code === "CLAUDE_BOUNDARY_OWNER_UNSAFE",
    );
    assert.equal(await realpath(path.join(preflightRoot, "owner.json")), await realpath(outsideOwner));
    assert.equal(
      JSON.parse(await readFile(outsideOwner, "utf8")).ownerToken,
      "00000000-0000-4000-8000-000000000100",
    );
  });

  await t.test("oversized owner", async () => {
    const runRoot = await tempRoot("cpb-claude-preflight-owner-oversized");
    const preflightRoot = path.join(runRoot, "preflight", "claude-runtime-boundary");
    await mkdir(preflightRoot, { recursive: true });
    await writeFile(path.join(preflightRoot, "owner.json"), "x".repeat(64 * 1024 + 1), "utf8");

    await assert.rejects(
      () => recoverInterruptedClaudeBoundaryPreflight(runRoot, { identityAlive: () => false }),
      (error) => (error as { code?: string }).code === "CLAUDE_BOUNDARY_OWNER_UNSAFE",
    );
    assert.equal((await readFile(path.join(preflightRoot, "owner.json"))).byteLength, 64 * 1024 + 1);
  });

  await t.test("legacy pid-only owner", async () => {
    const runRoot = await tempRoot("cpb-claude-preflight-owner-legacy");
    const preflightRoot = path.join(runRoot, "preflight", "claude-runtime-boundary");
    await mkdir(preflightRoot, { recursive: true });
    await writeFile(path.join(preflightRoot, "owner.json"), JSON.stringify({ host: "test-host", pid: 100 }), "utf8");

    await assert.rejects(
      () => recoverInterruptedClaudeBoundaryPreflight(runRoot, { identityAlive: () => false }),
      (error) => (error as { code?: string }).code === "CLAUDE_BOUNDARY_OWNER_UNSAFE",
    );
    assert.equal(JSON.parse(await readFile(path.join(preflightRoot, "owner.json"), "utf8")).pid, 100);
  });
});

test("Claude boundary recovery rejects a same-content owner path ABA", async () => {
  const runRoot = await tempRoot("cpb-claude-preflight-owner-path-aba");
  const preflightRoot = path.join(runRoot, "preflight", "claude-runtime-boundary");
  const ownerPath = path.join(preflightRoot, "owner.json");
  const displacedPath = path.join(preflightRoot, "owner.displaced.json");
  const rawOwner = `${JSON.stringify(claudeBoundaryOwner(preflightRoot, 100), null, 2)}\n`;
  await mkdir(preflightRoot, { recursive: true });
  await writeFile(ownerPath, rawOwner, "utf8");
  let swapped = false;

  await assert.rejects(
    () => recoverInterruptedClaudeBoundaryPreflight(runRoot, {
      currentHost: "test-host",
      identityAlive: () => false,
      hooks: {
        ownerRead: {
          beforePathGenerationCheck: async ({ filePath }) => {
            if (swapped || filePath !== ownerPath) return;
            swapped = true;
            await rename(ownerPath, displacedPath);
            await writeFile(ownerPath, rawOwner, "utf8");
          },
        },
      },
    }),
    (error) => (error as { code?: string }).code === "CLAUDE_BOUNDARY_OWNER_UNSAFE",
  );

  assert.equal(swapped, true);
  assert.equal(await readFile(ownerPath, "utf8"), rawOwner);
  assert.equal(await readFile(displacedPath, "utf8"), rawOwner);
});

test("Claude boundary recovery preserves a same-owner ABA replacement without path reconstruction", async () => {
  const runRoot = await tempRoot("cpb-claude-preflight-owner-aba");
  const preflightRoot = path.join(runRoot, "preflight", "claude-runtime-boundary");
  await mkdir(preflightRoot, { recursive: true });
  const owner = claudeBoundaryOwner(preflightRoot, 100);
  await writeFile(path.join(preflightRoot, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
  let quarantineRoot = "";
  let displacedRoot = "";

  await assert.rejects(
    () => recoverInterruptedClaudeBoundaryPreflight(runRoot, {
      currentHost: "test-host",
      identityAlive: () => false,
      hooks: {
        afterQuarantineRename: async (context) => {
          quarantineRoot = context.quarantineRoot;
          displacedRoot = `${quarantineRoot}.displaced`;
          await rename(quarantineRoot, displacedRoot);
          await mkdir(quarantineRoot, { recursive: true });
          await writeFile(path.join(quarantineRoot, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
        },
      },
    }),
    (error) => (error as { code?: string }).code === "CLAUDE_BOUNDARY_RECOVERY_CHANGED",
  );

  assert.ok(quarantineRoot);
  assert.equal(JSON.parse(await readFile(path.join(quarantineRoot, "owner.json"), "utf8")).ownerToken, owner.ownerToken);
  assert.equal(JSON.parse(await readFile(path.join(displacedRoot, "owner.json"), "utf8")).ownerToken, owner.ownerToken);
  await assert.rejects(() => readFile(path.join(preflightRoot, "owner.json"), "utf8"));
});

test("Claude boundary recovery does not move a same-owner successor installed before quarantine", async () => {
  const runRoot = await tempRoot("cpb-claude-preflight-owner-pre-rename-aba");
  const preflightRoot = path.join(runRoot, "preflight", "claude-runtime-boundary");
  const displacedRoot = `${preflightRoot}.displaced`;
  await mkdir(preflightRoot, { recursive: true });
  const owner = claudeBoundaryOwner(preflightRoot, 100);
  await writeFile(path.join(preflightRoot, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
  let quarantineRoot = "";

  await assert.rejects(
    () => recoverInterruptedClaudeBoundaryPreflight(runRoot, {
      currentHost: "test-host",
      identityAlive: () => false,
      hooks: {
        beforeQuarantineRename: async (context) => {
          quarantineRoot = context.quarantineRoot;
          await rename(preflightRoot, displacedRoot);
          await mkdir(preflightRoot, { recursive: true });
          await writeFile(path.join(preflightRoot, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
        },
      },
    }),
    (error) => (error as { code?: string }).code === "CLAUDE_BOUNDARY_RECOVERY_CHANGED",
  );

  assert.equal(JSON.parse(await readFile(path.join(preflightRoot, "owner.json"), "utf8")).ownerToken, owner.ownerToken);
  assert.equal(JSON.parse(await readFile(path.join(displacedRoot, "owner.json"), "utf8")).ownerToken, owner.ownerToken);
  await assert.rejects(() => readFile(path.join(quarantineRoot, "owner.json"), "utf8"));
});

test("Claude boundary recovery never overwrites pre-existing recovery evidence", async () => {
  const runRoot = await tempRoot("cpb-claude-preflight-recovery-record-no-clobber");
  const preflightRoot = path.join(runRoot, "preflight", "claude-runtime-boundary");
  const preservedRecord = { source: "pre-existing-evidence" };
  await mkdir(preflightRoot, { recursive: true });
  await writeFile(
    path.join(preflightRoot, "owner.json"),
    `${JSON.stringify(claudeBoundaryOwner(preflightRoot, 100), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(preflightRoot, "recovery-record.json"),
    `${JSON.stringify(preservedRecord)}\n`,
    "utf8",
  );

  let preservedRoot = "";
  await assert.rejects(
    () => recoverInterruptedClaudeBoundaryPreflight(runRoot, {
      currentHost: "test-host",
      identityAlive: () => false,
    }),
    (error) => {
      const typed = error as { code?: string; residualPath?: string };
      preservedRoot = typed.residualPath || "";
      return typed.code === "CLAUDE_BOUNDARY_RECOVERY_PRESERVED";
    },
  );

  assert.ok(preservedRoot);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(preservedRoot, "recovery-record.json"), "utf8")),
    preservedRecord,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(preservedRoot, "owner.json"), "utf8")).ownerToken,
    "00000000-0000-4000-8000-000000000100",
  );
});

test("CPB comparison lane owns the quota delegate lifecycle", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "..", "..", "scripts", "run-swebench-three-way.ts"), "utf8");
  assert.match(source, /const hubRoot = assignment\.hubRoot;/);
  assert.match(source, /startQuotaDelegate\(hubRoot, laneRoot, frozenDistRoot, options\.signal\)/);
  assert.match(source, /finally\s*\{[\s\S]*await stopQuotaDelegate\(\);[\s\S]*\}/);
  assert.match(source, /isDelegateAlive\(hubRoot\)/);
});

test("dataset manifest fetch retries only transient HTTP classes", () => {
  assert.equal(isRetryableDatasetStatus(null), true);
  assert.equal(isRetryableDatasetStatus(408), true);
  assert.equal(isRetryableDatasetStatus(429), true);
  assert.equal(isRetryableDatasetStatus(502), true);
  assert.equal(isRetryableDatasetStatus(400), false);
  assert.equal(isRetryableDatasetStatus(404), false);
});

test("dataset slice cache is range-bound and hash-validated before reuse", () => {
  const rows = [
    { rowIndex: 7, row },
    { rowIndex: 8, row: { ...row, instance_id: "owner__repo-124" } },
  ];
  const envelope = buildDatasetCacheEnvelope(rows, 7, 2, "python_datasets_offline");
  const valid = validateDatasetCacheEnvelope(envelope, { offset: 7, count: 2 });
  assert.equal(valid.ok, true);

  const tampered = structuredClone(envelope);
  tampered.rows[1].row.problem_statement = "A different task slipped into the cache.";
  assert.deepEqual(validateDatasetCacheEnvelope(tampered, { offset: 7, count: 2 }), {
    ok: false,
    reason: "cache_hash_mismatch",
  });
  assert.deepEqual(validateDatasetCacheEnvelope(envelope, { offset: 0, count: 2 }), {
    ok: false,
    reason: "cache_metadata_mismatch",
  });

  const sliced = sliceValidatedDatasetCacheEnvelope(envelope, { offset: 8, count: 1 });
  assert.equal(sliced.ok, true);
  if (sliced.ok) {
    assert.equal(sliced.envelope.offset, 8);
    assert.equal(sliced.envelope.count, 1);
    assert.equal(sliced.envelope.rows[0]?.rowIndex, 8);
    assert.equal(validateDatasetCacheEnvelope(sliced.envelope, { offset: 8, count: 1 }).ok, true);
  }
  assert.deepEqual(sliceValidatedDatasetCacheEnvelope(envelope, { offset: 9, count: 1 }), {
    ok: false,
    reason: "source_cache_does_not_contain_range",
  });

  const corruptSource = structuredClone(envelope);
  corruptSource.rows[0].row.problem_statement = "tampered before slicing";
  assert.deepEqual(sliceValidatedDatasetCacheEnvelope(corruptSource, { offset: 7, count: 1 }), {
    ok: false,
    reason: "source_cache_hash_mismatch",
  });
});

test("source preparation retries transport failures but not invalid commits", () => {
  assert.equal(isTransientSourceFetchFailure("LibreSSL SSL_connect: SSL_ERROR_SYSCALL"), true);
  assert.equal(isTransientSourceFetchFailure("RPC failed; curl 92 HTTP/2 stream was not closed cleanly"), true);
  assert.equal(isTransientSourceFetchFailure("fatal: couldn't find remote ref not-a-commit"), false);
  assert.equal(isTransientSolverFailure({
    status: "failed",
    timedOut: false,
    error: "source preparation failed: SSL_ERROR_SYSCALL",
    metadata: { failureStage: "source_prepare" },
  }), true);
  assert.equal(isTransientSolverFailure({
    status: "failed",
    timedOut: false,
    error: "source preparation failed: couldn't find remote ref deadbeef",
    metadata: { failureStage: "source_prepare" },
  }), false);
});

test("source preparation uses a run cache and verifies the exact base commit", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "..", "..", "scripts", "run-swebench-three-way.ts"), "utf8");
  assert.match(source, /path\.join\(runRoot, "source-cache"/);
  assert.match(source, /source identity mismatch/);
  assert.match(source, /source-fetch-attempts\.json/);
  assert.doesNotMatch(source, /if \(await exists\(path\.join\(sourcePath, "\.git"\)\)\) return sourcePath/);
  assert.match(source, /transientExhausted: true/);
  assert.match(source, /resume the same frozen run/);
});

test("official harness resume requires the same frozen predictions and run identity", () => {
  const expected = {
    lane: "native_codex" as const,
    runId: "comparison-native_codex",
    predictionsSha256: "a".repeat(64),
    totalInstances: 50,
  };
  const summary = {
    ...expected,
    submittedInstances: 50,
    completedInstances: 50,
    emptyPatchInstances: 0,
    errorInstances: 0,
    aggregatePath: "/run/harness/native_codex/report.json",
  };
  assert.equal(harnessResumeDecision(summary, expected).reusable, true);
  assert.deepEqual(harnessResumeDecision({ ...summary, predictionsSha256: "b".repeat(64) }, expected), {
    reusable: false,
    reason: "summary_mismatch:predictions_sha256",
  });
  assert.equal(harnessResumeDecision({ ...summary, totalInstances: 49 }, expected).reusable, false);
  assert.deepEqual(harnessResumeDecision({ ...summary, completedInstances: 49, errorInstances: 1 }, expected), {
    reusable: false,
    reason: "summary_mismatch:incomplete_or_error",
  });
  assert.equal(harnessResumeDecision({ ...summary, completedInstances: 49, emptyPatchInstances: 1 }, expected).reusable, true);
});

test("official harness retries only instances without a valid verdict report", () => {
  const resolved = { alpha: { resolved: true, tests_status: {} } };
  const unresolved = { beta: { resolved: false } };
  const corrupt = { gamma: { resolved: "yes" } };
  assert.equal(parseHarnessInstanceReport(resolved, "alpha").ok, true);
  assert.equal(parseHarnessInstanceReport(unresolved, "beta").ok, true);
  assert.equal(parseHarnessInstanceReport(corrupt, "gamma").ok, false);
  assert.deepEqual(selectHarnessRetryIds({
    requestedIds: ["alpha", "beta", "gamma", "delta", "empty"],
    aggregate: { error_ids: ["gamma", "delta"], empty_patch_ids: ["empty"] },
    reports: { alpha: resolved, beta: unresolved, gamma: corrupt, delta: null },
  }), ["gamma", "delta"]);
});

test("official harness metrics preserve per-instance FAIL_TO_PASS and PASS_TO_PASS evidence", () => {
  const metrics = summarizeHarnessTestMetrics([
    {
      instanceId: "alpha",
      resolved: true,
      reportPath: "/run/alpha/report.json",
      attempt: 1,
      testsStatus: {
        FAIL_TO_PASS: { success: ["f2p-a"], failure: [] },
        PASS_TO_PASS: { success: ["p2p-a"], failure: ["p2p-b"] },
      },
    },
    {
      instanceId: "beta",
      resolved: false,
      reportPath: "/run/beta/report.json",
      attempt: 2,
      testsStatus: null,
    },
  ]);
  assert.deepEqual(metrics.metricsAvailableIds, ["alpha"]);
  assert.deepEqual(metrics.metricsMissingIds, ["beta"]);
  assert.deepEqual(metrics.micro.FAIL_TO_PASS, { success: 1, failure: 0, total: 1, rate: 1 });
  assert.deepEqual(metrics.micro.PASS_TO_PASS, { success: 1, failure: 1, total: 2, rate: 0.5 });
  assert.equal(metrics.perInstance.beta.metricsAvailable, false);
});

test("official harness never reuses an attempt directory after a partial crash", () => {
  assert.equal(nextHarnessAttemptNumber([{ attempt: 1 }], [1, 2]), 3);
  assert.equal(nextHarnessAttemptNumber([], [4]), 5);
});

test("official harness resume recovers verdict and test metrics from legacy and attempt reports", async () => {
  const root = await tempRoot("cpb-harness-report-recovery");
  const lane = "cpb_high_assurance" as const;
  const runId = "comparison-cpb_high_assurance";
  const legacyPath = path.join(root, "logs", "run_evaluation", runId, lane, "alpha", "report.json");
  const attemptPath = path.join(root, "attempts", "attempt-002", "beta", "report.json");
  await mkdir(path.dirname(legacyPath), { recursive: true });
  await mkdir(path.dirname(attemptPath), { recursive: true });
  await writeFile(legacyPath, JSON.stringify({
    alpha: {
      resolved: true,
      tests_status: { FAIL_TO_PASS: { success: ["f2p"], failure: [] } },
    },
  }));
  await writeFile(attemptPath, JSON.stringify({ beta: { resolved: false, tests_status: {} } }));
  const results = new Map<string, HarnessInstanceResult>([
    ["alpha", { instanceId: "alpha", resolved: true, reportPath: null, attempt: null, testsStatus: null }],
  ]);
  await recoverHarnessInstanceReports({
    harnessRoot: root,
    lane,
    runId,
    expectedIds: ["alpha", "beta"],
    instanceResults: results,
    attemptHistory: [{ attempt: 2, reportPaths: { beta: attemptPath } }],
  });
  assert.deepEqual(results.get("alpha")?.testsStatus, {
    FAIL_TO_PASS: { success: ["f2p"], failure: [] },
  });
  assert.equal(results.get("alpha")?.reportPath, legacyPath);
  assert.equal(results.get("beta")?.resolved, false);
  assert.equal(results.get("beta")?.attempt, 2);
});

test("official harness environment keeps Docker credential helpers discoverable", () => {
  const harnessEnv = buildHarnessEnvironment({ PATH: "/usr/bin:/bin" });
  const entries = String(harnessEnv.PATH).split(path.delimiter);
  assert.equal(entries.includes("/usr/local/bin"), true);
  if (process.platform === "darwin") {
    assert.equal(entries.includes("/Applications/Docker.app/Contents/Resources/bin"), true);
  }
});

test("execution contract freezes comparable models without provider credentials", () => {
  const contract = buildExecutionContract({
    runId: "comparison-run",
    count: 50,
    offset: 0,
    lanes: ["native_codex", "native_claude_glm", "cpb_high_assurance"],
    timeoutMs: 3_600_000,
    solverLaneConcurrency: {
      native_codex: 2,
      native_claude_glm: 2,
      cpb_high_assurance: 2,
    },
    solverAttempts: 3,
    solverRetryBackoffMs: 60_000,
    harnessTimeoutSeconds: 1_800,
    maxHarnessWorkers: 2,
    harnessAttempts: 3,
    harnessRetryBackoffMs: 60_000,
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "xhigh",
    glmModel: "glm-5.1[1m]",
  }, {
    codex: "codex-cli 0.144.1",
    claude: "2.1.168 (Claude Code)",
    codexAcp: {
      packageName: "@agentclientprotocol/codex-acp",
      packageVersion: "1.1.2",
      sha256: "b".repeat(64),
    },
  });

  assert.equal(contract.models.codex.effective, "gpt-5.6-sol");
  assert.equal(contract.schemaVersion, 16);
  assert.equal(contract.models.claudeGlm.effective, "glm-5.1");
  assert.equal(contract.models.claudeGlm.observedAssistantModelRequired, "glm-5.1");
  assert.equal(contract.models.claudeGlm.syntheticTransportErrorsExcludedFromIdentity, true);
  assert.deepEqual(contract.cpbRoute, {
    allowedAgents: ["codex", "claude-glm"],
    plannerA: "codex",
    plannerB: "claude-glm",
    executor: "claude-glm",
    verifier: "codex",
    verifierIndependentOfFinalMutator: true,
    invalidVerifierContractFeedbackRetry: true,
    baselineContractUsesDisposableWritableReplay: true,
  });
  assert.equal(contract.phaseBudgetPolicy.highAssurancePlanSemantics, "terminal_deny_only_without_budget_override");
  assert.equal(contract.phaseBudgetPolicy.byRisk.high.plan.toolCallBudget, 60);
  assert.equal(contract.phaseBudgetPolicy.byRisk.high.plan.toolEventBudget, 240);
  assert.equal(contract.phaseBudgetPolicy.byRisk.high.verify.toolCallBudget, 45);
  assert.deepEqual(contract.sourceBoundary.claudeRuntime, {
    bareMode: false,
    failIfSandboxUnavailable: true,
    pathGuardHook: true,
    strictEmptyMcpConfig: true,
    restrictedBuiltInTools: true,
    providerResetAwareRetry: true,
  });
  assert.equal(contract.binaries.codexAcp.packageVersion, "1.1.2");
  assert.deepEqual(contract.harness, {
    timeoutSeconds: 1_800,
    maxWorkers: 2,
    attempts: 3,
    retryBackoffMs: 60_000,
  });
  assert.deepEqual(contract.solver.laneConcurrency, {
    native_codex: 2,
    native_claude_glm: 2,
    cpb_high_assurance: 2,
  });
  assert.equal(contract.solver.retryableToolBudgetExceeded, true);
  assert.equal(contract.solver.providerResetAwareBackoff, true);
  assert.match(contract.contractSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(contract), /api[_-]?key|auth[_-]?token|secret/i);
});

test("CPB completion audit rejects same-family verification after an executor fallback", () => {
  const eventStream = (executeAgent: string, verifyAgent: string) => [
    JSON.stringify({ type: "phase_result", phase: "plan", agent: "codex", status: "passed" }),
    JSON.stringify({ type: "phase_result", phase: "execute", agent: executeAgent, status: "passed" }),
    JSON.stringify({ type: "phase_result", phase: "verify", agent: verifyAgent, status: "passed" }),
  ].join("\n");

  assert.equal(independentVerificationContractViolation(eventStream("claude-glm", "codex")), null);
  assert.equal(independentVerificationContractViolation(eventStream("codex", "claude-glm")), null);
  assert.equal(
    independentVerificationContractViolation(eventStream("codex", "codex")),
    "independent_verification_provider_reuse:codex:codex",
  );
});

test("CPB launch audit fails closed when any agent is outside the frozen universe", () => {
  const validAudit = [
    JSON.stringify({ event: "agent_launch", agent: "codex", command: "codex-acp" }),
    JSON.stringify({ event: "agent_launch", agent: "claude-glm", command: "claude", model: "glm-5.2" }),
  ].join("\n");
  assert.equal(agentLaunchContractViolation(validAudit, ["codex", "claude-glm"]), null);

  const contaminated = `${validAudit}\n${JSON.stringify({
    event: "agent_launch",
    agent: "claude",
    command: "claude-agent-acp",
  })}`;
  assert.equal(
    agentLaunchContractViolation(contaminated, ["codex", "claude-glm"]),
    "agent_launch_outside_contract:claude",
  );
  assert.equal(
    agentLaunchContractViolation("", ["codex", "claude-glm"]),
    "agent_launch_audit_missing",
  );
});

test("Claude/GLM streams attest the actual assistant model and reject drift", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", model: "glm-5.2" }),
    "not-json",
    JSON.stringify({ type: "assistant", message: { model: "glm-5.2" } }),
    JSON.stringify({ type: "result", modelUsage: { "glm-5.2": { outputTokens: 4 } } }),
  ].join("\n");
  const attestation = observedModelAttestation(stream);
  assert.deepEqual(attestation, {
    initModels: ["glm-5.2"],
    assistantModels: ["glm-5.2"],
    modelUsageModels: ["glm-5.2"],
  });
  assert.equal(observedModelContractViolation(attestation, "glm-5.2"), null);
  assert.equal(
    observedModelContractViolation(attestation, "glm-5.1"),
    "observed_assistant_model_mismatch:glm-5.2:expected:glm-5.1",
  );
  assert.equal(
    observedModelContractViolation({ ...attestation, assistantModels: [] }, "glm-5.2"),
    "observed_assistant_model_missing",
  );
  assert.equal(observedModelContractViolation({
    ...attestation,
    assistantModels: ["<synthetic>"],
    modelUsageModels: [],
  }, "glm-5.2"), null);
  assert.equal(observedModelContractViolation({
    ...attestation,
    assistantModels: ["<synthetic>", "glm-5.2"],
  }, "glm-5.2"), null);
  assert.equal(
    observedModelContractViolation({
      ...attestation,
      assistantModels: ["<synthetic>", "glm-5.1"],
    }, "glm-5.2"),
    "observed_assistant_model_mismatch:glm-5.1:expected:glm-5.2",
  );
});

test("native Claude comparison lane has a fail-closed native sandbox and path hook", async () => {
  const root = await tempRoot("cpb-native-claude-sandbox");
  const sourcePath = path.join(root, "source");
  const laneRoot = path.join(root, "lane");
  await mkdir(sourcePath, { recursive: true });
  const env = buildNativeClaudeIsolatedEnv(laneRoot, { PATH: process.env.PATH });
  const guardScript = path.join(root, "runtime-dist", "scripts", "claude-path-guard.js");
  const dependencyRoot = path.join(root, "runtime", "site-packages");
  const installedProject = path.join(dependencyRoot, "project_pkg");
  const boundary = {
    schemaVersion: 1 as const,
    homeDenyRoot: root,
    projectPackageNames: ["project_pkg"],
    dependencyReadRoots: [dependencyRoot],
    denyReadPaths: [installedProject],
  };
  const settings = buildNativeClaudeSettings(
    sourcePath,
    String(env.HOME),
    String(env.TMPDIR),
    guardScript,
    boundary,
  );
  assert.deepEqual(settings.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    filesystem: {
      allowWrite: [sourcePath, path.join(laneRoot, "agent-homes", "claude-glm"), path.join(laneRoot, "tmp", "claude-glm")],
      denyRead: [root, installedProject],
      allowRead: [
        path.join(laneRoot, "agent-homes", "claude-glm"),
        sourcePath,
        path.join(laneRoot, "tmp", "claude-glm"),
      ].sort(),
    },
    network: { allowedDomains: [] },
  });
  assert.deepEqual(settings.permissions.deny, [
    "WebSearch",
    "WebFetch",
    `Read(//${installedProject.replace(/^\/+/, "")}/**)`,
  ]);
  assert.equal(settings.hooks.PreToolUse[0].matcher, "Read|Edit|Write|MultiEdit|Bash");
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /claude-path-guard\.js/);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /source/);
  assert.equal(env.HOME, path.join(laneRoot, "agent-homes", "claude-glm"));
  const args = buildNativeClaudeArgs("glm-5.2", path.join(laneRoot, "settings.json"), "fix the bug");
  assert.equal(args.includes("--bare"), false);
  assert.equal(args.includes("--include-hook-events"), true);
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.equal(args.includes("--disable-slash-commands"), true);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Edit,Write,Glob,Grep,Bash");
});

test("comparison scoring reads the immutable CPB replay bundle instead of a verifier-mutated worktree", async () => {
  const root = await tempRoot("cpb-comparison-candidate-replay");
  const outputs = path.join(root, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });
  const patch = "diff --git a/a.txt b/a.txt\n";
  const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const unsigned = {
    schemaVersion: 1 as const,
    baseSha: "a".repeat(40),
    expectedTreeHash: "b".repeat(40),
    candidateIdentityHash: `sha256:${"c".repeat(64)}`,
    patchSha256: digest(patch),
    patchBytes: Buffer.byteLength(patch),
    patch,
  };
  const bundleHash = digest(JSON.stringify({
    schemaVersion: unsigned.schemaVersion,
    baseSha: unsigned.baseSha,
    expectedTreeHash: unsigned.expectedTreeHash,
    candidateIdentityHash: unsigned.candidateIdentityHash,
    patchSha256: unsigned.patchSha256,
    patchBytes: unsigned.patchBytes,
  }));
  const bundlePath = path.join(outputs, "candidate-replay-bundle-1.md");
  await writeFile(bundlePath, JSON.stringify({ ...unsigned, bundleHash }), "utf8");

  const replay = await latestCandidateReplayBundle(outputs);
  assert.equal(replay.error, null);
  assert.equal(replay.path, bundlePath);
  assert.equal(replay.bundle?.patch, patch);
});
