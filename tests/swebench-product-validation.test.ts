import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDecomposePrompt } from "../core/workflow/checklist-decomposer.js";
import { buildExecutePrompt } from "../core/phases/execute.js";
import { buildVerifyPrompt } from "../core/phases/verify.js";
import {
  buildTask,
  cleanupScopedCodegraphDaemons,
  DEFAULT_PRODUCT_VALIDATION_AGENTS,
  deriveSweBenchDiagnosticCommands,
  deriveSweBenchVerificationCommands,
  resolveProductValidationAgents,
  runManagedWorker,
  runProductValidationTemporaryWorkspace,
} from "../scripts/run-swebench-product-validation.js";
import type { ProcessIdentity } from "../core/runtime/process-tree.js";
import type { TemporaryWorkspace } from "../core/runtime/temporary-workspace.js";

const validationRunnerSource = readFileSync(new URL("../scripts/run-swebench-product-validation.js", import.meta.url), "utf8");

const djangoRecord = {
  benchmarkInstanceId: "django__django-13128",
  representativeRepository: "django/django",
  baseCommit: "2d67222472f80f251607ae1b720527afceba06ad",
};

const djangoRow = {
  problem_statement: "Remove the need for ExpressionWrapper on temporal subtraction.",
  FAIL_TO_PASS: JSON.stringify([
    "test_date_subtraction (expressions.tests.FTimeDeltaTests)",
    "test_time_subtraction (expressions.tests.FTimeDeltaTests)",
    "test_datetime_subtraction_microseconds (expressions.tests.FTimeDeltaTests)",
  ]),
  PASS_TO_PASS: JSON.stringify([
    "test_deepcopy (expressions.tests.FTests)",
    "test_and (expressions.tests.CombinableTests)",
    "test_empty_group_by (expressions.tests.ExpressionWrapperTests)",
    "test_lefthand_bitwise_or (expressions.tests.ExpressionOperatorTests)",
    "test_deconstruct (expressions.tests.ValueTests)",
  ]),
};

const flaskRecord = {
  benchmarkInstanceId: "pallets__flask-5014",
  representativeRepository: "pallets/flask",
  baseCommit: "7ee9ceb71e868944a46e1ff00b506772a53a4f1d",
};

const flaskRow = {
  problem_statement: "Require a non-empty name for Blueprints.",
  FAIL_TO_PASS: JSON.stringify(["tests/test_blueprints.py::test_empty_name_not_allowed"]),
  PASS_TO_PASS: JSON.stringify([
    "tests/test_blueprints.py::test_blueprint_specific_error_handling",
    "tests/test_blueprints.py::test_blueprint_specific_user_error_handling",
    "tests/test_blueprints.py::test_blueprint_app_error_handling",
    "tests/test_blueprints.py::test_blueprint_prefix_slash[-/-/]",
    "tests/test_blueprints.py::test_blueprint_prefix_slash[/--/]",
  ]),
};

const codegraphWorktreePath = "/tmp/cpb-product-codegraph-worktree";
const codegraphCommand = `123 codegraph serve --mcp ${codegraphWorktreePath}`;

function processIdentity(pid = 123, birthId = "birth-123"): ProcessIdentity {
  return {
    pid,
    birthId,
    birthIdPrecision: "exact",
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-07-21T00:00:00.000Z",
    processGroupId: pid,
  };
}

function unresolvedCleanup(error: unknown) {
  return (error as Error & {
    unresolvedCleanup?: Array<{ pid: number; reason: string; message: string }>;
  }).unresolvedCleanup;
}

test("benchmark task surface is exactly the original problem statement", () => {
  const task = buildTask(djangoRow, djangoRecord);
  assert.equal(task, djangoRow.problem_statement);
  assert.doesNotMatch(task, /SWE-bench|FAIL_TO_PASS|PASS_TO_PASS|Canonical local verification commands/i);
  assert.doesNotMatch(task, /Do not use external web|must add.*regression test/i);
});

test("official oracle command derivation remains available only to the external evaluator", () => {
  const commands = deriveSweBenchVerificationCommands(djangoRow, djangoRecord);
  const diagnostics = deriveSweBenchDiagnosticCommands(djangoRow, djangoRecord);
  assert.deepEqual(commands.failToPass, [
    "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction expressions.tests.FTimeDeltaTests.test_time_subtraction expressions.tests.FTimeDeltaTests.test_datetime_subtraction_microseconds",
  ]);
  assert.deepEqual(commands.passToPass, [
    "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTests.test_deepcopy expressions.tests.CombinableTests.test_and expressions.tests.ExpressionWrapperTests.test_empty_group_by expressions.tests.ExpressionOperatorTests.test_lefthand_bitwise_or",
  ]);
  assert.deepEqual(diagnostics, [
    "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests",
  ]);
});

test("non-Django oracle derivation remains external to the task", () => {
  const commands = deriveSweBenchVerificationCommands(flaskRow, flaskRecord);
  assert.deepEqual(commands.failToPass, [
    "python3 -m pytest -q tests/test_blueprints.py::test_empty_name_not_allowed",
  ]);
  assert.match(commands.passToPass[0], /test_blueprint_specific_error_handling/);
  assert.deepEqual(deriveSweBenchDiagnosticCommands(flaskRow, flaskRecord), [
    "python3 -m pytest -q tests/test_blueprints.py",
  ]);
  assert.equal(buildTask(flaskRow, flaskRecord), flaskRow.problem_statement);
});

test("benchmark metadata does not add execute instructions or oracle evidence", async () => {
  const prompt = await buildExecutePrompt({
    task: buildTask(djangoRow, djangoRecord),
    project: "swebench-django-django-13128",
    sourceContext: {
      productValidation: {
        validationMode: "swe-bench-verified",
        benchmarkInstanceId: djangoRecord.benchmarkInstanceId,
      },
    },
  }, {
    name: "plan-123.md",
    excerpt: "## Files To Modify\n- django/db/models/expressions.py\n## Implementation Steps\n1. Fix temporal subtraction.",
  });

  assert.match(prompt, /Remove the need for ExpressionWrapper/);
  assert.match(prompt, /Fix temporal subtraction/);
  assert.doesNotMatch(prompt, /FAIL_TO_PASS|PASS_TO_PASS|Canonical local verification commands|SWE-bench execute phase/i);
});

test("execute prompt receives only the generic pre-execution observable oracle", async () => {
  const prompt = await buildExecutePrompt({
    task: "Improve a misleading exception message",
    project: "ordinary-project",
    sourceContext: {
      acceptanceChecklist: {
        items: [{
          id: "AC-001",
          requirement: "Render the compared collections without scalar wrappers",
          observableContract: {
            contractId: "OBS-001",
            contractSha256: `sha256:${"a".repeat(64)}`,
            frozenBeforeExecution: true,
            observationKind: "contains_text",
            probeInput: "Trigger expected [a,b], found [a]",
            expectedObservation: "expected [a,b] but found [a]",
            forbiddenObservations: ["expected '[a,b]' but found '[a]'"],
            oracleSourceRefs: [{ kind: "task_text", locator: "task:0" }],
            candidateIndependent: true,
          },
        }],
      },
    },
  }, null);

  assert.match(prompt, /Frozen Pre-Execution Observable Contracts/);
  assert.match(prompt, /expected \[a,b\] but found \[a\]/);
  assert.match(prompt, /neither your implementation nor an agent-authored test may redefine/);
  assert.doesNotMatch(prompt, /SWE-bench|FAIL_TO_PASS|PASS_TO_PASS/);
});

test("benchmark metadata does not add verifier oracle evidence", async () => {
  const prompt = await buildVerifyPrompt({
    task: buildTask(djangoRow, djangoRecord),
    project: "swebench-django-django-13128",
    jobId: "job-django-django-13128",
    cpbRoot: ".",
    previousResults: [],
    sourceContext: {
      productValidation: {
        validationMode: "swe-bench-verified",
        benchmarkInstanceId: djangoRecord.benchmarkInstanceId,
      },
    },
  }, null, {
    sourceOfTruth: ["task", "current_diff", "hard_gates"],
    git: { changedFiles: ["django/db/models/expressions.py"] },
    hardGate: { ok: true, checks: [] },
  });

  assert.match(prompt, /Remove the need for ExpressionWrapper/);
  assert.match(prompt, /native collection boundaries/);
  assert.doesNotMatch(prompt, /FAIL_TO_PASS|PASS_TO_PASS|canonical_oracle_test|benchmark_required|SWE-bench verify phase/i);
});

test("checklist decomposition sees only the original task text", () => {
  const prompt = buildDecomposePrompt(buildTask(djangoRow, djangoRecord));
  assert.match(prompt, /Remove the need for ExpressionWrapper/);
  assert.match(prompt, /Named acceptance, regression, or compatibility tests are verification targets/);
  assert.doesNotMatch(prompt, /PYTHONPATH=|FAIL_TO_PASS|PASS_TO_PASS/);
});

test("product validation runner injects no benchmark solving policy", () => {
  assert.doesNotMatch(validationRunnerSource, /acceptanceChecklist/);
  assert.doesNotMatch(validationRunnerSource, /CPB_ACP_SWEBENCH/);
  assert.doesNotMatch(validationRunnerSource, /CPB_CHECKLIST_DECOMPOSE/);
  assert.doesNotMatch(validationRunnerSource, /CPB_PHASE_RETRY_MAX/);
  assert.doesNotMatch(validationRunnerSource, /CPB_ACP_TOOL_(?:CALL|EVENT)_BUDGET/);
});

test("product validation still uses structured cancellation before killing timed-out workers", () => {
  assert.match(validationRunnerSource, /writeCancel/);
  assert.match(validationRunnerSource, /product validation timed out/);
});

test("product validation keeps full planning default and supports controlled agent comparisons", () => {
  assert.match(validationRunnerSource, /function parsePlanMode/);
  assert.match(validationRunnerSource, /value === null \|\| value === "full"/);
  assert.deepEqual(DEFAULT_PRODUCT_VALIDATION_AGENTS, {
    planner: "codex",
    executor: "claude-glm",
    verifier: "claude-mimo",
    adversarial_verifier: "claude-mimo",
  });
  assert.deepEqual(resolveProductValidationAgents(["--agent", "codex"]), {
    planner: "codex",
    executor: "codex",
    verifier: "codex",
    adversarial_verifier: "codex",
  });
});

test("Codegraph daemon cleanup fails closed when initial exact identity capture is unavailable", async () => {
  await assert.rejects(
    cleanupScopedCodegraphDaemons(codegraphWorktreePath, {
      listProcesses: async () => codegraphCommand,
      readProcessCommand: async () => codegraphCommand,
      captureIdentity: () => null,
      isIdentityAlive: () => false,
      teardownProcessTree: async () => {
        throw new Error("teardown must not be called without identity");
      },
    }),
    (error: unknown) => {
      assert.deepEqual(unresolvedCleanup(error)?.map(({ pid, reason }) => ({ pid, reason })), [
        { pid: 123, reason: "identity_unavailable" },
      ]);
      assert.match((error as Error).message, /failed to bind Codegraph daemon pid 123/);
      return true;
    },
  );
});

test("Codegraph daemon cleanup rejects a non-exact identity as unavailable", async () => {
  const nonExactIdentity = {
    ...processIdentity(),
    birthIdPrecision: undefined,
  } as unknown as ProcessIdentity;
  let teardownCalled = false;

  await assert.rejects(
    cleanupScopedCodegraphDaemons(codegraphWorktreePath, {
      listProcesses: async () => codegraphCommand,
      readProcessCommand: async () => codegraphCommand,
      captureIdentity: () => nonExactIdentity,
      isIdentityAlive: () => false,
      teardownProcessTree: async () => {
        teardownCalled = true;
      },
    }),
    (error: unknown) => {
      assert.deepEqual(unresolvedCleanup(error)?.map(({ pid, reason }) => ({ pid, reason })), [
        { pid: 123, reason: "identity_unavailable" },
      ]);
      return true;
    },
  );
  assert.equal(teardownCalled, false);
});

test("Codegraph daemon cleanup preserves a permission failure during exact identity capture", async () => {
  const permissionFailure = Object.assign(new Error("synthetic identity permission failure"), { code: "EPERM" });

  await assert.rejects(
    cleanupScopedCodegraphDaemons(codegraphWorktreePath, {
      listProcesses: async () => codegraphCommand,
      readProcessCommand: async () => codegraphCommand,
      captureIdentity: () => {
        throw permissionFailure;
      },
      isIdentityAlive: () => false,
      teardownProcessTree: async () => {
        throw new Error("teardown must not be called after identity probe failure");
      },
    }),
    (error: unknown) => {
      assert.deepEqual(unresolvedCleanup(error)?.map(({ pid, reason }) => ({ pid, reason })), [
        { pid: 123, reason: "identity_unavailable" },
      ]);
      assert.match(unresolvedCleanup(error)?.[0]?.message || "", /synthetic identity permission failure/);
      assert.equal((error as Error).cause, permissionFailure);
      return true;
    },
  );
});

test("Codegraph daemon cleanup fails closed on second exact identity capture loss or mismatch", async () => {
  for (const [name, secondIdentity, expectedReason] of [
    ["lost", null, "identity_unavailable"],
    ["mismatch", processIdentity(123, "birth-successor"), "identity_mismatch"],
  ] as const) {
    const identities = [processIdentity(), secondIdentity];
    await assert.rejects(
      cleanupScopedCodegraphDaemons(codegraphWorktreePath, {
        listProcesses: async () => codegraphCommand,
        readProcessCommand: async () => codegraphCommand,
        captureIdentity: () => identities.shift() ?? null,
        isIdentityAlive: () => false,
        teardownProcessTree: async () => {
          throw new Error(`teardown must not be called after ${name} identity`);
        },
      }),
      (error: unknown) => {
        assert.deepEqual(unresolvedCleanup(error)?.map(({ pid, reason }) => ({ pid, reason })), [
          { pid: 123, reason: expectedReason },
        ]);
        return true;
      },
    );
  }
});

test("Codegraph daemon cleanup records unresolved evidence when teardown fails", async () => {
  await assert.rejects(
    cleanupScopedCodegraphDaemons(codegraphWorktreePath, {
      listProcesses: async () => codegraphCommand,
      readProcessCommand: async () => codegraphCommand,
      captureIdentity: () => processIdentity(),
      isIdentityAlive: () => false,
      teardownProcessTree: async () => {
        throw new Error("synthetic teardown failure");
      },
    }),
    (error: unknown) => {
      assert.deepEqual(unresolvedCleanup(error)?.map(({ pid, reason }) => ({ pid, reason })), [
        { pid: 123, reason: "teardown_failed" },
      ]);
      assert.match(unresolvedCleanup(error)?.[0]?.message || "", /synthetic teardown failure/);
      return true;
    },
  );
});

test("Codegraph daemon cleanup treats EPERM during post-teardown liveness as unverified", async () => {
  const permissionFailure = Object.assign(new Error("synthetic liveness permission failure"), { code: "EPERM" });

  await assert.rejects(
    cleanupScopedCodegraphDaemons(codegraphWorktreePath, {
      listProcesses: async () => codegraphCommand,
      readProcessCommand: async () => codegraphCommand,
      captureIdentity: () => processIdentity(),
      isIdentityAlive: () => {
        throw permissionFailure;
      },
      teardownProcessTree: async () => {},
    }),
    (error: unknown) => {
      assert.deepEqual(unresolvedCleanup(error)?.map(({ pid, reason }) => ({ pid, reason })), [
        { pid: 123, reason: "cleanup_unverified" },
      ]);
      assert.match(unresolvedCleanup(error)?.[0]?.message || "", /synthetic liveness permission failure/);
      assert.equal((error as Error).cause, permissionFailure);
      return true;
    },
  );
});

test("Codegraph daemon cleanup reports killedPids only after exact teardown and same-incarnation post-check", async () => {
  const identity = processIdentity();
  let teardownIdentity: ProcessIdentity | null = null;
  const result = await cleanupScopedCodegraphDaemons(codegraphWorktreePath, {
    listProcesses: async () => codegraphCommand,
    readProcessCommand: async () => codegraphCommand,
    captureIdentity: () => identity,
    isIdentityAlive: (checkedIdentity) => {
      assert.deepEqual(checkedIdentity, identity);
      return false;
    },
    teardownProcessTree: async (pid, options) => {
      assert.equal(pid, 123);
      teardownIdentity = options.expectedRootIdentity;
    },
  });

  assert.deepEqual(teardownIdentity, identity);
  assert.deepEqual(result.matchedPids, [123]);
  assert.deepEqual(result.killedPids, [123]);
  assert.deepEqual(result.unresolvedCleanup, []);
});

test("managed worker teardown preserves a synchronous cleanup failure in AggregateError diagnostics", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-product-validation-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distRoot = path.join(root, "dist");
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  await mkdir(path.join(distRoot, "runtime", "worker"), { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(
    path.join(distRoot, "runtime", "worker", "managed-worker.js"),
    "setInterval(() => {}, 1000);\n",
  );
  const cleanupFailure = Object.assign(new Error("synthetic synchronous teardown failure"), {
    code: "SYNTHETIC_TEARDOWN_FAILURE",
  });
  const previousKillGraceMs = process.env.CPB_KILL_GRACE_MS;
  process.env.CPB_KILL_GRACE_MS = "0";
  t.after(() => {
    if (previousKillGraceMs === undefined) delete process.env.CPB_KILL_GRACE_MS;
    else process.env.CPB_KILL_GRACE_MS = previousKillGraceMs;
  });
  let failure: unknown;

  await runManagedWorker({
    workerId: "product-validation-test-worker",
    hubRoot,
    cpbRoot,
    assignmentId: "missing-assignment",
    phaseAgents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    timeoutMs: 50,
    distRoot,
    teardownProcessTree() {
      throw cleanupFailure;
    },
  }).catch((error: unknown) => { failure = error; });

  assert.ok(failure instanceof AggregateError);
  assert.match(failure.message, /managed worker cleanup failed/);
  assert.equal(failure.errors.some((error) => error === cleanupFailure), true);
  assert.equal(failure.cause, cleanupFailure);
  assert.equal(
    failure.errors.some((error) => (error as { code?: string }).code === "MANAGED_WORKER_TIMEOUT"),
    true,
  );
});

test("product validation workspace keeps primary and successor-preservation cleanup evidence", async () => {
  const primary = new Error("synthetic product validation failure");
  const recovery = {
    version: 1,
    kind: "temporary_workspace_recovery",
    code: "TEMPORARY_WORKSPACE_SUCCESSOR_PRESERVED",
    recoveryPaths: {
      canonicalRoot: "/tmp/cpb-swebench-product-owned",
      quarantineRoot: "/tmp/.cpb-quarantine-product-owned",
    },
    successorPreserved: true,
  } as const;
  const cleanupFailure = Object.assign(new Error("synthetic product cleanup race"), {
    temporaryWorkspaceRecovery: recovery,
  });
  let cleanupCalls = 0;
  const workspace = {
    rootPath: "/tmp/cpb-swebench-product-owned",
    cleanup: async () => {
      cleanupCalls += 1;
      throw cleanupFailure;
    },
  } as unknown as TemporaryWorkspace;

  await assert.rejects(
    runProductValidationTemporaryWorkspace({
      keepTemp: false,
      task: async (rootPath) => {
        assert.equal(rootPath, workspace.rootPath);
        throw primary;
      },
      createWorkspace: async () => workspace,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanupFailure]);
      assert.equal(error.cause, primary);
      assert.equal((error as { temporaryWorkspaceRecovery?: unknown }).temporaryWorkspaceRecovery, recovery);
      assert.deepEqual((error as { recoveryPaths?: unknown }).recoveryPaths, recovery.recoveryPaths);
      assert.equal((error as { successorPreserved?: unknown }).successorPreserved, true);
      return true;
    },
  );
  assert.equal(cleanupCalls, 1);
});

test("product validation --keep-temp transfers ownership without running cleanup", async () => {
  let cleanupCalls = 0;
  let retainedRoot = "";
  const workspace = {
    rootPath: "/tmp/cpb-swebench-product-retained",
    cleanup: async () => {
      cleanupCalls += 1;
      throw new Error("retained workspace must not be cleaned");
    },
  } as unknown as TemporaryWorkspace;

  const value = await runProductValidationTemporaryWorkspace({
    keepTemp: true,
    task: async () => "done",
    onKeepTemp: (rootPath) => { retainedRoot = rootPath; },
    createWorkspace: async () => workspace,
  });

  assert.equal(value, "done");
  assert.equal(retainedRoot, workspace.rootPath);
  assert.equal(cleanupCalls, 0);
});

test("product validation failure reports successful quarantine proof", async () => {
  const primary = new Error("synthetic validation failure");
  const cleanupProof = {
    version: 1,
    kind: "temporary_workspace_disposition",
    recoveryPaths: {
      canonicalRoot: "/tmp/cpb-swebench-proof-owned",
      quarantineRoot: "/tmp/.cpb-quarantine-swebench-proof-owned",
    },
    successorPreserved: false,
  } as const;
  const workspace = {
    rootPath: cleanupProof.recoveryPaths.canonicalRoot,
    cleanup: async () => cleanupProof,
  } as unknown as TemporaryWorkspace;

  await assert.rejects(
    runProductValidationTemporaryWorkspace({
      keepTemp: false,
      task: async () => { throw primary; },
      createWorkspace: async () => workspace,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary]);
      assert.equal(error.cause, primary);
      assert.equal((error as { temporaryWorkspaceRecovery?: unknown }).temporaryWorkspaceRecovery, cleanupProof);
      assert.deepEqual((error as { recoveryPaths?: unknown }).recoveryPaths, cleanupProof.recoveryPaths);
      return true;
    },
  );
});
