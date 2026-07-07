import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildDecomposePrompt } from "../core/workflow/checklist-decomposer.js";
import { FailureKind } from "../core/contracts/failure.js";
import { validateAcceptanceChecklist } from "../core/workflow/acceptance-checklist.js";
import { buildExecutePrompt } from "../core/phases/execute.js";
import { buildVerifyPrompt } from "../core/phases/verify.js";
import { buildSweBenchAcpEnv } from "../core/phases/swebench-env.js";
import {
  buildTask,
  buildSweBenchAcceptanceChecklist,
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

const djangoMiddlewareRow = {
  problem_statement: "Fixed async detection for middleware instances.",
  FAIL_TO_PASS: JSON.stringify([
    "test_coroutine (deprecation.test_middleware_mixin.MiddlewareMixinTests)",
  ]),
  PASS_TO_PASS: JSON.stringify([
    "test_deprecation (deprecation.test_middleware_mixin.MiddlewareMixinTests)",
  ]),
};

const flaskRecord = {
  benchmarkInstanceId: "pallets__flask-5014",
  representativeRepository: "pallets/flask",
  baseCommit: "7ee9ceb71e868944a46e1ff00b506772a53a4f1d",
};

const flaskRow = {
  problem_statement: "Require a non-empty name for Blueprints.",
  FAIL_TO_PASS: JSON.stringify([
    "tests/test_blueprints.py::test_empty_name_not_allowed",
  ]),
  PASS_TO_PASS: JSON.stringify([
    "tests/test_blueprints.py::test_blueprint_specific_error_handling",
    "tests/test_blueprints.py::test_blueprint_specific_user_error_handling",
    "tests/test_blueprints.py::test_blueprint_app_error_handling",
    "tests/test_blueprints.py::test_blueprint_prefix_slash[-/-/]",
    "tests/test_blueprints.py::test_blueprint_prefix_slash[/--/]",
  ]),
};

test("SWE-bench Django task supplies runnable canonical verification commands", () => {
  const commands = deriveSweBenchVerificationCommands(djangoRow, djangoRecord);
  const diagnosticCommands = deriveSweBenchDiagnosticCommands(djangoRow, djangoRecord);

  assert.deepEqual(commands.failToPass, [
    "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction expressions.tests.FTimeDeltaTests.test_time_subtraction expressions.tests.FTimeDeltaTests.test_datetime_subtraction_microseconds",
  ]);
  assert.deepEqual(commands.passToPass, [
    "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTests.test_deepcopy expressions.tests.CombinableTests.test_and expressions.tests.ExpressionWrapperTests.test_empty_group_by expressions.tests.ExpressionOperatorTests.test_lefthand_bitwise_or",
  ]);
  assert.deepEqual(diagnosticCommands, [
    "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests",
  ]);

  const task = buildTask(djangoRow, djangoRecord);
  const canonicalSection = task.slice(
    task.indexOf("Canonical local verification commands:"),
    task.indexOf("Problem statement:"),
  );
  assert.match(task, /Canonical local verification commands:/);
  assert.match(task, /FAIL_TO_PASS: PYTHONPATH=\. python3 tests\/runtests\.py expressions\.tests\.FTimeDeltaTests\.test_date_subtraction/);
  assert.match(task, /Treat SWE-bench FAIL_TO_PASS\/PASS_TO_PASS test names as verification targets/);
  assert.match(task, /add or update a minimal real in-repo regression test/i);
  assert.match(task, /fails before the implementation change and passes after/i);
  assert.match(task, /Do not satisfy this by editing fakes, fixtures, snapshots, or generated test doubles/);
  assert.match(task, /Do not replace these canonical commands with broad package, app, full-suite, or self-invented test commands/i);
  assert.match(task, /Run the exact canonical commands when recording SWE-bench acceptance evidence/i);
  assert.match(task, /Do not split, shorten, pipe, redirect, wrap, tail/i);
  assert.match(task, /bounded code inspection or explicitly allowed diagnostics/i);
  assert.match(task, /supplement but never replace canonical acceptance evidence/i);
  assert.match(task, /Allowed bounded diagnostic commands:/);
  assert.match(task, /DIAGNOSTIC: PYTHONPATH=\. python3 tests\/runtests\.py expressions\.tests\.FTimeDeltaTests/);
  assert.match(task, /Use the exact canonical FAIL_TO_PASS command for failing-before and passing-after regression evidence/i);
  assert.doesNotMatch(task, /Run the new or updated regression test directly/i);
  assert.doesNotMatch(task, /focused follow-ups/i);
  assert.match(task, /SWE-bench FAIL_TO_PASS summary: 3 tests/);
  assert.match(task, /SWE-bench PASS_TO_PASS summary: 5 tests/);
  assert.doesNotMatch(task, /SWE-bench PASS_TO_PASS tests:\n\[/);
  assert.doesNotMatch(canonicalSection, /\.\/runtests\.py/);
  assert.doesNotMatch(canonicalSection, /expressions\.tests\.ValueTests/);
});

test("SWE-bench task forbids external web and live repository lookups", () => {
  const task = buildTask(djangoRow, djangoRecord);

  assert.match(task, /Do not use external web search, webReader, browsers, or live GitHub\/network lookups/i);
  assert.match(task, /checked-out repository, the problem statement, and the listed SWE-bench tests as the only source of truth/i);
});

test("SWE-bench execute prompt separates implementation from canonical verification", async () => {
  const commands = deriveSweBenchVerificationCommands(djangoRow, djangoRecord);
  const canonicalCommands = [
    ...commands.failToPass,
    ...commands.passToPass,
  ];

  const prompt = await buildExecutePrompt({
    task: buildTask(djangoRow, djangoRecord),
    project: "swebench-django-django-13128",
    sourceContext: {
      productValidation: {
        validationMode: "swe-bench-verified",
        canonicalCommands,
      },
    },
  }, {
    name: "plan-123.md",
    excerpt: [
      "## Files To Modify",
      "- django/db/models/fields/json.py: add KeyTransformIn.",
      "## Implementation Steps",
      "1. Define KeyTransformIn for JSONField key transforms.",
      "2. Run exactly PYTHONPATH=. python3 tests/runtests.py model_fields.test_jsonfield.TestQuerying.test_key_in model_fields.test_jsonfield.TestQuerying.test_key_iregex.",
      "3. Run the exact canonical PASS_TO_PASS smoke command after the implementation.",
    ].join("\n"),
  });

  assert.match(prompt, /SWE-bench execute phase hard constraints/i);
  assert.match(prompt, /Execute-Only Plan Excerpt/i);
  assert.match(prompt, /KeyTransformIn/);
  assert.match(prompt, /Do not run tests in execute/i);
  assert.match(prompt, /verify phase will run the exact canonical commands/i);
  assert.match(prompt, /Do not create ad hoc test scripts/i);
  assert.match(prompt, /Do not re-derive the plan/i);
  assert.match(prompt, /Inspect the files named by the plan first/i);
  assert.match(prompt, /After at most .* targeted read\/search operations/i);
  assert.match(prompt, /Do not use shell grep\/find\/head loops/i);
  assert.doesNotMatch(prompt, /Canonical local verification commands:/);
  assert.doesNotMatch(prompt, /SWE-bench FAIL_TO_PASS summary:/);
  assert.doesNotMatch(prompt, /SWE-bench PASS_TO_PASS summary:/);
  assert.doesNotMatch(prompt, /FAIL_TO_PASS: PYTHONPATH=\. python3 tests\/runtests\.py/);
  assert.doesNotMatch(prompt, /Run exactly PYTHONPATH=\. python3 tests\/runtests\.py/i);
  assert.doesNotMatch(prompt, /exact canonical PASS_TO_PASS/i);
  assert.doesNotMatch(prompt, /test_key_iregex/);
});

test("SWE-bench phase env enables ACP canonical test command guard", () => {
  const commands = deriveSweBenchVerificationCommands(djangoRow, djangoRecord);
  const canonicalCommands = [
    ...commands.failToPass,
    ...commands.passToPass,
  ];
  const diagnosticCommands = [
    "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests || true",
  ];

  const env = buildSweBenchAcpEnv({
    env: { CPB_EXISTING: "kept" },
    sourceContext: {
      productValidation: {
        validationMode: "swe-bench-verified",
        canonicalCommands,
        diagnosticCommands,
      },
    },
  });

  assert.equal(env.CPB_EXISTING, "kept");
  assert.equal(env.CPB_ACP_SWEBENCH_TEST_GUARD, "1");
  assert.deepEqual(JSON.parse(String(env.CPB_SWEBENCH_CANONICAL_COMMANDS_JSON)), canonicalCommands);
  assert.deepEqual(JSON.parse(String(env.CPB_SWEBENCH_DIAGNOSTIC_COMMANDS_JSON)), diagnosticCommands);
});

test("SWE-bench verify prompt hides executable canonical commands from ACP verifier", async () => {
  const commands = deriveSweBenchVerificationCommands(djangoRow, djangoRecord);
  const canonicalCommands = [
    ...commands.failToPass,
    ...commands.passToPass,
  ];
  const task = buildTask(djangoRow, djangoRecord);
  const checklist = buildSweBenchAcceptanceChecklist(djangoRow, djangoRecord, {
    jobId: "job-django-django-13128",
    projectId: "swebench-django-django-13128",
    task,
  });

  const prompt = await buildVerifyPrompt({
    task,
    project: "swebench-django-django-13128",
    jobId: "job-django-django-13128",
    cpbRoot: ".",
    previousResults: [],
    sourceContext: {
      productValidation: {
        validationMode: "swe-bench-verified",
        canonicalCommands,
      },
    },
  }, {
    name: "plan-123.md",
    excerpt: [
      "## Implementation Steps",
      "1. Add KeyTransformIn.",
      `2. Run exactly ${canonicalCommands[0]}.`,
    ].join("\n"),
  }, {
    sourceOfTruth: ["task", "plan", "current_diff", "hard_gates"],
    plan: {
      available: true,
      excerpt: `Use KeyTransformIn, then run ${canonicalCommands[0]}.`,
    },
    git: {
      changedFiles: ["django/db/models/fields/json.py", "tests/model_fields/test_jsonfield.py"],
      diffExcerpt: "class KeyTransformIn(lookups.In):",
    },
    hardGate: { ok: true, checks: [] },
  }, {
    acceptanceChecklist: checklist,
    evidenceLedger: {
      ledgerId: "evidence-ledger-job-django-django-13128",
      evidence: [
        {
          id: "EV-001",
          checklistId: checklist.items[2].id,
          verificationMethod: "test",
          predicateId: checklist.items[2].predicateId,
          result: "pass",
          evidenceClass: "canonical_oracle_test",
          evidenceOrigin: "benchmark_required",
          command: canonicalCommands[0],
          summary: canonicalCommands[0],
        },
      ],
    },
  });

  assert.match(prompt, /SWE-bench verify phase hard constraints/i);
  assert.match(prompt, /Do not run tests or terminal commands/i);
  assert.match(prompt, /EV-001/);
  assert.match(prompt, /Runtime canonical test evidence is available/i);
  assert.match(prompt, /real-path coverage/i);
  assert.match(prompt, /agent-written regression\/static scope item alone is not sufficient/i);
  assert.doesNotMatch(prompt, /Canonical local verification commands:/);
  assert.doesNotMatch(prompt, /SWE-bench FAIL_TO_PASS summary:/);
  assert.doesNotMatch(prompt, /SWE-bench PASS_TO_PASS summary:/);
  assert.doesNotMatch(prompt, /PYTHONPATH=\. python3 tests\/runtests\.py/);
  assert.doesNotMatch(prompt, /Run focused tests/);
});

test("SWE-bench verify prompt includes dynamic repair guidance after ACP quality interception", async () => {
  const prompt = await buildVerifyPrompt({
    task: "Verify without running commands.",
    project: "swebench-django-django-13128",
    jobId: "job-django-django-13128",
    cpbRoot: ".",
    previousResults: [],
    sourceContext: {
      productValidation: {
        validationMode: "swe-bench-verified",
        canonicalCommands: ["PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction"],
      },
      retry: {
        retryClass: "quality_interception",
        failureKind: FailureKind.BROAD_TEST_COMMAND_DENIED,
        failureReason: "broad_test_command_denied: verifier tried to run a terminal command",
        instruction: "Do not run terminal commands in verify. Judge only from the evidence snapshot.",
        previousOutput: "python3 tests/runtests.py",
        attempt: 1,
      },
    },
  }, null, {
    sourceOfTruth: ["hard_gates", "current_diff"],
    git: { changedFiles: ["django/db/models/fields/json.py"] },
    hardGate: { ok: false, checks: [] },
  });

  assert.match(prompt, /Previous Attempt Failed/i);
  assert.match(prompt, /quality_interception/i);
  assert.match(prompt, /broad_test_command_denied/i);
  assert.match(prompt, /Do not run terminal commands in verify/i);
});

test("SWE-bench Django commands ignore non-label PASS_TO_PASS headings", () => {
  const row = {
    ...djangoRow,
    PASS_TO_PASS: JSON.stringify([
      "file_storage.tests.GetStorageClassTests",
      "file_storage.tests.FieldCallableFileStorageTests",
      "file_storage.tests.FileSystemStorageTests",
      "Regression test for #9610.",
      "file_storage.tests.FileStoragePathParsing",
    ]),
  };

  const commands = deriveSweBenchVerificationCommands(row, {
    ...djangoRecord,
    benchmarkInstanceId: "django__django-13343",
  });

  assert.deepEqual(commands.passToPass, [
    "PYTHONPATH=. python3 tests/runtests.py file_storage.tests.GetStorageClassTests file_storage.tests.FieldCallableFileStorageTests file_storage.tests.FileSystemStorageTests file_storage.tests.FileStoragePathParsing",
  ]);

  const task = buildTask(row, djangoRecord);
  const canonicalSection = task.slice(
    task.indexOf("Canonical local verification commands:"),
    task.indexOf("Problem statement:"),
  );
  assert.doesNotMatch(canonicalSection, /Regression test for #9610/);
  assert.match(task, /SWE-bench PASS_TO_PASS summary: 5 tests/);
});

test("SWE-bench Django diagnostics include class-level real-path command for middleware issue shape", () => {
  const diagnosticCommands = deriveSweBenchDiagnosticCommands(djangoMiddlewareRow, {
    ...djangoRecord,
    benchmarkInstanceId: "django__django-13344",
  });

  assert.deepEqual(diagnosticCommands, [
    "PYTHONPATH=. python3 tests/runtests.py deprecation.test_middleware_mixin.MiddlewareMixinTests",
  ]);

  const task = buildTask(djangoMiddlewareRow, {
    ...djangoRecord,
    benchmarkInstanceId: "django__django-13344",
  });
  assert.match(task, /DIAGNOSTIC: PYTHONPATH=\. python3 tests\/runtests\.py deprecation\.test_middleware_mixin\.MiddlewareMixinTests/);
});

test("SWE-bench non-Django task supplies pytest oracle commands without test-file edits", () => {
  const commands = deriveSweBenchVerificationCommands(flaskRow, flaskRecord);
  const diagnosticCommands = deriveSweBenchDiagnosticCommands(flaskRow, flaskRecord);

  assert.deepEqual(commands.failToPass, [
    "python3 -m pytest -q tests/test_blueprints.py::test_empty_name_not_allowed",
  ]);
  assert.deepEqual(commands.passToPass, [
    "python3 -m pytest -q tests/test_blueprints.py::test_blueprint_specific_error_handling tests/test_blueprints.py::test_blueprint_specific_user_error_handling tests/test_blueprints.py::test_blueprint_app_error_handling tests/test_blueprints.py::test_blueprint_prefix_slash[-/-/]",
  ]);
  assert.deepEqual(diagnosticCommands, [
    "python3 -m pytest -q tests/test_blueprints.py",
  ]);
  assert.match(commands.notes.join("\n"), /add or update a minimal real in-repo regression test/i);

  const task = buildTask(flaskRow, flaskRecord);
  assert.match(task, /FAIL_TO_PASS: python3 -m pytest -q tests\/test_blueprints\.py::test_empty_name_not_allowed/);
  assert.match(task, /PASS_TO_PASS smoke: python3 -m pytest -q tests\/test_blueprints\.py::test_blueprint_specific_error_handling/);
  assert.match(task, /DIAGNOSTIC: python3 -m pytest -q tests\/test_blueprints\.py/);
  assert.match(task, /Do not satisfy this by editing fakes, fixtures, snapshots, or generated test doubles/);
  assert.doesNotMatch(task, /tests\/runtests\.py/);
});

test("checklist decomposition prompt preserves canonical command evidence", () => {
  const prompt = buildDecomposePrompt(buildTask(djangoRow, djangoRecord));

  assert.match(
    prompt,
    /use those commands verbatim for command\/test expectedEvidence instead of inventing alternate commands/,
  );
  assert.match(
    prompt,
    /Do not create static test-file coverage items from benchmark test names/,
  );
  assert.match(prompt, /PYTHONPATH=\. python3 tests\/runtests\.py expressions\.tests\.FTimeDeltaTests\.test_date_subtraction/);
});

test("SWE-bench product validation keeps transient retry paths enabled", () => {
  assert.doesNotMatch(validationRunnerSource, /CPB_PHASE_RETRY_MAX:\s*"0"/);
  assert.match(validationRunnerSource, /CPB_PHASE_RETRY_MAX:\s*process\.env\.CPB_PHASE_RETRY_MAX\s*\|\|\s*"3"/);
  assert.doesNotMatch(validationRunnerSource, /CPB_PHASE_FEEDBACK_RETRY_MAX:\s*"0"/);
  assert.match(validationRunnerSource, /CPB_CHECKLIST_DECOMPOSE_RETRY_MAX/);
});

test("SWE-bench product validation requests structured cancellation before killing timed-out workers", () => {
  assert.match(validationRunnerSource, /writeCancel/);
  assert.match(validationRunnerSource, /product validation timed out/);
});

test("SWE-bench product validation keeps full planning as default but allows light planning", () => {
  assert.match(validationRunnerSource, /function parsePlanMode/);
  assert.match(validationRunnerSource, /value === null \|\| value === "full"/);
  assert.match(validationRunnerSource, /value === "light"/);
  assert.match(validationRunnerSource, /argValue\(args, "--plan-mode"\)/);
  assert.match(validationRunnerSource, /planMode: options\.planMode/);
});

test("SWE-bench product validation defaults to split codex and claude agents", () => {
  assert.deepEqual(DEFAULT_PRODUCT_VALIDATION_AGENTS, {
    planner: "codex",
    executor: "claude-glm",
    verifier: "claude-mimo",
    adversarial_verifier: "claude-mimo",
  });
  assert.deepEqual(resolveProductValidationAgents([]), DEFAULT_PRODUCT_VALIDATION_AGENTS);
  assert.match(validationRunnerSource, /CPB_DYNAMIC_VERIFIER_AGENT:\s*phaseAgents\.verifier/);
  assert.match(validationRunnerSource, /adversarial_verifier:\s*agents\.adversarial_verifier/);
});

test("SWE-bench product validation keeps single-agent override for controlled comparisons", () => {
  assert.deepEqual(resolveProductValidationAgents(["--agent", "codex"]), {
    planner: "codex",
    executor: "codex",
    verifier: "codex",
    adversarial_verifier: "codex",
  });
});

test("SWE-bench product validation injects deterministic oracle checklist", () => {
  const task = buildTask(djangoRow, djangoRecord);
  const checklist = buildSweBenchAcceptanceChecklist(djangoRow, djangoRecord, {
    jobId: "job-django-django-13128",
    projectId: "swebench-django-django-13128",
    task,
  });

  assert.equal(validateAcceptanceChecklist(checklist).ok, true);
  assert.equal(checklist.items.length, 4);
  assert.equal(checklist.items[0].verificationMethod, "static");
  assert.match(checklist.items[0].requirement, /real in-repo regression test/i);
  assert.equal(checklist.items[0].evidenceClass, "agent_regression_test");
  assert.deepEqual(checklist.items[0].allowedFiles, ["tests/", "**/tests/"]);
  assert.equal(checklist.items[1].verificationMethod, "static");
  assert.equal(checklist.items[1].predicateId, "swebench-real-path-trace");
  assert.equal(checklist.items[1].evidenceClass, "real_path_trace");
  assert.match(checklist.items[1].requirement, /real problem-statement path/i);
  assert.deepEqual(checklist.items[1].allowedFiles, ["django/"]);
  assert.equal(checklist.items[2].verificationMethod, "test");
  assert.match(checklist.items[2].expectedEvidence, /PYTHONPATH=\. python3 tests\/runtests\.py/);
  assert.equal(checklist.items[2].evidenceClass, "canonical_oracle_test");
  assert.deepEqual(checklist.items[2].allowedFiles, ["django/", "tests/", "**/tests/"]);
  assert.match(validationRunnerSource, /acceptanceChecklist/);
});
