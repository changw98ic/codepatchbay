import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildDecomposePrompt } from "../core/workflow/checklist-decomposer.js";
import { buildExecutePrompt } from "../core/phases/execute.js";
import { buildVerifyPrompt } from "../core/phases/verify.js";
import {
  buildTask,
  DEFAULT_PRODUCT_VALIDATION_AGENTS,
  deriveSweBenchDiagnosticCommands,
  deriveSweBenchVerificationCommands,
  resolveProductValidationAgents,
} from "../scripts/run-swebench-product-validation.js";

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
