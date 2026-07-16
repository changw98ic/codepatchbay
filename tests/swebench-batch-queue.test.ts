import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hasAgent, loadRegistry } from "../core/agents/registry.js";
import { envForAgent, providerKeyForAgent } from "../server/services/acp/acp-pool.js";
import { getProviderAdapter } from "../server/services/provider-adapters.js";
import { DEFAULT_PRODUCT_VALIDATION_AGENTS } from "../scripts/run-swebench-product-validation.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import { recordValue } from "../shared/types.js";
import {
  buildSweBenchBatchReport,
  collectSweBenchBatchEvidence,
  loadSweBenchScorerEvidenceByAssignmentId,
  scorerEvidenceByInstanceId,
  validateSweBenchBatchReport,
  buildBatchAssignmentInput,
  buildDatasetRowsUrl,
  buildManagedWorkerEnv,
  buildNotificationCommand,
  defaultBatchWaitTimeoutMs,
  recordFromDatasetRow,
  liveProviderPreflightHandshake,
  preflightFailureMessage,
  resolveBatchQueueOptions,
  runSweBenchProviderPreflight,
  runRequiredWithRetries,
  startQuotaDelegate,
  stopStartedWorkers,
  waitForAssignments,
  writePreflightFailureOutputs,
  writeSweBenchBatchOutputs,
} from "../scripts/queue-swebench-batch.js";

const batchQueueSource = readFileSync(new URL("../scripts/queue-swebench-batch.js", import.meta.url), "utf8");

const sampleRow = {
  instance_id: "django__django-13128",
  repo: "django/django",
  base_commit: "2d67222472f80f251607ae1b720527afceba06ad",
  problem_statement: "Remove the need for ExpressionWrapper on temporal subtraction.",
  FAIL_TO_PASS: JSON.stringify([
    "test_date_subtraction (expressions.tests.FTimeDeltaTests)",
  ]),
  PASS_TO_PASS: JSON.stringify([
    "test_deepcopy (expressions.tests.FTests)",
    "test_and (expressions.tests.CombinableTests)",
  ]),
};

const secondSampleRow = {
  instance_id: "pallets__flask-5014",
  repo: "pallets/flask",
  base_commit: "c7a0c0f5d8f6b1d33e061c7c1a961b4f0a1c65d9",
  problem_statement: "Preserve CLI context when nested commands fail.",
  FAIL_TO_PASS: JSON.stringify([
    "tests/test_cli.py::test_nested_cli_context",
  ]),
  PASS_TO_PASS: JSON.stringify([
    "tests/test_basic.py::test_url_generation",
  ]),
};

test("SWE-bench batch queue defaults to 50 full-plan split-agent assignments", () => {
  const opts = resolveBatchQueueOptions(["node", "queue-swebench-batch.js"]);

  assert.equal(opts.count, 50);
  assert.equal(opts.planMode, "full");
  assert.deepEqual(opts.agents, DEFAULT_PRODUCT_VALIDATION_AGENTS);
  assert.equal(opts.workerCount, 1);
  assert.equal(opts.timeoutMs, 1_200_000);
  assert.equal(opts.waitTimeoutMs, 1_200_000);
  assert.equal(opts.notify, true);
});

test("SWE-bench batch wait timeout scales with locally started workers", () => {
  assert.equal(
    defaultBatchWaitTimeoutMs({ count: 50, startWorkers: 2, timeoutMs: 1_200_000 }),
    120_000_000,
  );

  const opts = resolveBatchQueueOptions([
    "node",
    "queue-swebench-batch.js",
    "--count",
    "50",
    "--worker-count",
    "2",
    "--start-workers",
    "2",
  ]);
  assert.equal(opts.timeoutMs, 1_200_000);
  assert.equal(opts.waitTimeoutMs, 120_000_000);
});

test("SWE-bench batch wait timeout can be overridden independently from phase timeout", () => {
  const opts = resolveBatchQueueOptions([
    "node",
    "queue-swebench-batch.js",
    "--timeout-ms",
    "12345",
    "--wait-timeout-ms",
    "67890",
  ]);

  assert.equal(opts.timeoutMs, 12345);
  assert.equal(opts.waitTimeoutMs, 67890);
});

test("SWE-bench batch queue accepts report rebuild scorer evidence options", () => {
  const opts = resolveBatchQueueOptions([
    "node",
    "queue-swebench-batch.js",
    "--rebuild-report",
    "--output",
    "/tmp/cpb-batch/manifest.json",
    "--report-output",
    "/tmp/cpb-batch/report.scored.json",
    "--scorer-evidence",
    "/tmp/cpb-batch/official-score-summary.json",
    "--scorer-required",
  ]);

  assert.equal(opts.rebuildReport, true);
  assert.equal(opts.outputPath, "/tmp/cpb-batch/manifest.json");
  assert.equal(opts.reportPath, "/tmp/cpb-batch/report.scored.json");
  assert.equal(opts.scorerEvidencePath, "/tmp/cpb-batch/official-score-summary.json");
  assert.equal(opts.scorerRequired, true);
});

test("SWE-bench batch queue resolves report output next to manifest by default", () => {
  const opts = resolveBatchQueueOptions([
    "node",
    "queue-swebench-batch.js",
    "--output",
    "/tmp/cpb-batch/custom-manifest.json",
  ]);
  const custom = resolveBatchQueueOptions([
    "node",
    "queue-swebench-batch.js",
    "--output",
    "/tmp/cpb-batch/custom-manifest.json",
    "--report-output",
    "/tmp/cpb-batch/custom-report.json",
  ]);

  assert.equal(opts.reportPath, "/tmp/cpb-batch/swebench-batch-report.json");
  assert.equal(custom.reportPath, "/tmp/cpb-batch/custom-report.json");
});

test("SWE-bench batch queue default agents are registered before runtime", async () => {
  await loadRegistry("");

  for (const [role, agent] of Object.entries(DEFAULT_PRODUCT_VALIDATION_AGENTS)) {
    assert.equal(hasAgent(agent), true, `${role} agent is not registered: ${agent}`);
  }
});

test("SWE-bench batch queue Claude-compatible aliases resolve provider variants", () => {
  const env = {
    MIMO_BASE_URL: "https://example.invalid/mimo",
    MIMO_API_KEY: "redacted",
    MIMO_MODEL: "mimo-test-model[1m]",
    ZHIPU_BASE_URL: "https://example.invalid/glm",
    ZHIPU_API_KEY: "redacted",
    ZHIPU_MODEL: "glm-test-model[1m]",
  };

  assert.equal(providerKeyForAgent("claude-glm", env), "claude:glm");
  assert.equal(providerKeyForAgent("claude-mimo", env), "claude:mimo-v2.5pro");

  const glmEnv = envForAgent("claude-glm", env);
  assert.equal(glmEnv.CPB_CLAUDE_VARIANT, "glm");
  assert.equal(glmEnv.CPB_ACTIVE_CLAUDE_VARIANT, "glm");
  assert.equal(glmEnv.ANTHROPIC_MODEL, "glm-test-model");
  assert.equal(glmEnv.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");

  const mimoEnv = envForAgent("claude-mimo", env);
  assert.equal(mimoEnv.CPB_CLAUDE_VARIANT, "mimo-v2.5pro");
  assert.equal(mimoEnv.CPB_ACTIVE_CLAUDE_VARIANT, "mimo-v2.5pro");
  assert.equal(mimoEnv.ANTHROPIC_MODEL, "mimo-test-model");
  assert.equal(mimoEnv.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");

  assert.equal(recordValue(getProviderAdapter("claude:glm")).timezone, "Asia/Shanghai");
  assert.equal(recordValue(getProviderAdapter("claude:mimo-v2.5pro")).timezone, "Asia/Shanghai");
});

test("SWE-bench batch queue MiMo alias preserves provider model spelling", () => {
  const env = {
    MIMO_BASE_URL: "https://example.invalid/mimo",
    MIMO_API_KEY: "redacted",
    XIAOMI_MODEL: "mimo-v2.5-pro[1m]",
  };

  const mimoEnv = envForAgent("claude-mimo", env);
  assert.equal(mimoEnv.CPB_CLAUDE_VARIANT, "mimo-v2.5pro");
  assert.equal(mimoEnv.CPB_ACTIVE_CLAUDE_VARIANT, "mimo-v2.5pro");
  assert.equal(mimoEnv.ANTHROPIC_MODEL, "mimo-v2.5-pro");
  assert.notEqual(mimoEnv.ANTHROPIC_MODEL, "mimo-v2.5-pro[1m]");
});

test("SWE-bench batch provider preflight freezes split provider route", async () => {
  const result = await runSweBenchProviderPreflight({
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    env: {
      MIMO_BASE_URL: "https://example.invalid/mimo",
      MIMO_API_KEY: "redacted",
      MIMO_MODEL: "mimo-test-model",
      ZHIPU_BASE_URL: "https://example.invalid/glm",
      ZHIPU_API_KEY: "redacted",
      ZHIPU_MODEL: "glm-test-model",
    },
    handshake: async ({ phase, providerKey, outputPath }) => ({
      ok: true,
      phase,
      providerKey,
      outputPath,
      wroteStructuredOutput: true,
      denyRulesHonored: true,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.failureKind, null);
  assert.deepEqual(
    result.phases.map((phase) => recordValue(phase).providerKey),
    ["codex", "claude:glm", "claude:mimo-v2.5pro", "claude:mimo-v2.5pro"],
  );
  assert.deepEqual(
    result.phases.map((phase) => recordValue(phase).handshakeOk),
    [true, true, true, true],
  );
});

test("SWE-bench batch provider preflight surfaces handshake failure detail", async () => {
  const result = await runSweBenchProviderPreflight({
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    env: {
      MIMO_BASE_URL: "https://example.invalid/mimo",
      MIMO_API_KEY: "redacted",
      MIMO_MODEL: "mimo-test-model",
      ZHIPU_BASE_URL: "https://example.invalid/glm",
      ZHIPU_API_KEY: "redacted",
      ZHIPU_MODEL: "glm-test-model",
    },
    handshake: async ({ role }) => role === "executor"
      ? { ok: false, error: "429 reset at 07:30" }
      : { ok: true, wroteStructuredOutput: true, denyRulesHonored: true },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "provider_unavailable");
  assert.match(result.violations.join("\n"), /executor provider claude:glm failed structured handshake: 429 reset at 07:30/);
});

test("SWE-bench batch provider preflight propagates rate-limit failure kind", async () => {
  const result = await runSweBenchProviderPreflight({
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    env: {
      MIMO_BASE_URL: "https://example.invalid/mimo",
      MIMO_API_KEY: "redacted",
      MIMO_MODEL: "mimo-test-model",
      ZHIPU_BASE_URL: "https://example.invalid/glm",
      ZHIPU_API_KEY: "redacted",
      ZHIPU_MODEL: "glm-test-model",
    },
    handshake: async ({ role }) => role === "executor"
      ? { ok: false, failureKind: "agent_rate_limited", error: "429 usage limit reset at 15:30" }
      : { ok: true, wroteStructuredOutput: true, denyRulesHonored: true },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "agent_rate_limited");
});

test("SWE-bench batch provider preflight failure message uses specific failure kind", () => {
  const message = preflightFailureMessage({
    ok: false,
    failureKind: "agent_rate_limited",
    violations: ["executor provider claude:glm failed structured handshake: 429"],
  });

  assert.match(message, /^agent_rate_limited:/);
  assert.match(message, /claude:glm/);
});

test("SWE-bench batch provider preflight fails missing configured providers", async () => {
  const result = await runSweBenchProviderPreflight({
    agents: {
      ...DEFAULT_PRODUCT_VALIDATION_AGENTS,
      executor: "missing-claude-glm",
    },
    handshake: async () => ({ ok: true }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "provider_unavailable");
  assert.match(result.violations.join("\n"), /executor agent is not registered: missing-claude-glm/);
});

test("SWE-bench live provider preflight invokes ACP client and records command failures", async () => {
  const calls: Array<{
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number | undefined;
    options: Record<string, unknown>;
  }> = [];

  const result = await liveProviderPreflightHandshake({
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    command: "claude-agent-acp",
    args: [],
    outputPath: "/tmp/cpb-preflight-output.json",
    env: {
      ZHIPU_BASE_URL: "https://example.invalid/glm",
      ZHIPU_API_KEY: "redacted",
      ZHIPU_MODEL: "glm-test-model",
    },
    denyRules: ["web_tool_denied"],
  }, {
    repoRoot: "/repo",
    distRoot: "/dist",
    timeoutMs: 1234,
    runner: async (command, args, cwd, timeoutMs, options) => {
      calls.push({ command, args, cwd, timeoutMs, options: options as Record<string, unknown> });
      return { code: 1, stdout: "", stderr: "429 reset at 07:30" };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "live");
  assert.match(String(result.error), /429 reset at 07:30/);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    "/dist/server/services/acp/acp-client.js",
    "--agent",
    "claude-glm",
    "--cwd",
    "/repo",
  ]);
  assert.equal(calls[0].cwd, "/repo");
  assert.equal(calls[0].timeoutMs, 1234);
  assert.match(String(calls[0].options.input), /CPB_PROVIDER_PREFLIGHT_OK/);
  assert.equal(recordValue(calls[0].options.env).CPB_ACP_TERMINAL, "deny");
  assert.equal(recordValue(calls[0].options.env).ZHIPU_MODEL, "glm-test-model");
});

test("SWE-bench live provider preflight default timeout covers Codex ACP cold start", async () => {
  const previous = process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT_TIMEOUT_MS;
  delete process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT_TIMEOUT_MS;
  const calls: Array<{ timeoutMs: number | undefined }> = [];
  try {
    const result = await liveProviderPreflightHandshake({
      phase: "plan",
      role: "planner",
      agent: "codex",
      providerKey: "codex",
      command: "codex-acp",
      args: [],
      outputPath: "/tmp/cpb-preflight-output.json",
      env: {},
      denyRules: [],
    }, {
      repoRoot: "/repo",
      distRoot: "/dist",
      runner: async (_command, _args, _cwd, timeoutMs) => {
        calls.push({ timeoutMs });
        return { code: 0, stdout: "CPB_PROVIDER_PREFLIGHT_OK", stderr: "" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls[0].timeoutMs, 120_000);
  } finally {
    if (previous === undefined) {
      delete process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT_TIMEOUT_MS;
    } else {
      process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT_TIMEOUT_MS = previous;
    }
  }
});

test("SWE-bench batch queue builds dataset row refs and normalized records", () => {
  assert.equal(
    buildDatasetRowsUrl({ offset: 7, length: 1 }),
    "https://datasets-server.huggingface.co/rows?dataset=SWE-bench%2FSWE-bench_Verified&config=default&split=test&offset=7&length=1",
  );

  const record = recordFromDatasetRow(sampleRow, 7);
  assert.equal(record.benchmarkInstanceId, "django__django-13128");
  assert.equal(record.representativeRepository, "django/django");
  assert.equal(record.baseCommit, "2d67222472f80f251607ae1b720527afceba06ad");
  assert.equal(record.datasetRowRef, buildDatasetRowsUrl({ offset: 7, length: 1 }));
  assert.equal(record.failToPassTests, 1);
  assert.equal(record.passToPassTests, 2);
  assert.match(String(record.problemStatementSha256), /^[a-f0-9]{64}$/);
});

test("SWE-bench batch queue submits the unmodified problem statement without oracle hints", () => {
  const record = recordFromDatasetRow(sampleRow, 7);
  const input = buildBatchAssignmentInput({
    record,
    row: sampleRow,
    sourcePath: "/tmp/source/django-django-13128",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    planMode: "full",
  });

  assert.equal(input.entryId, "django-django-13128");
  assert.equal(input.projectId, "swebench-django-django-13128");
  assert.equal(input.workflow, "standard");
  assert.equal(input.planMode, "full");
  const metadata = recordValue(input.metadata);
  const productValidation = recordValue(metadata.productValidation);
  const sourceContext = recordValue(input.sourceContext);
  const sourceProductValidation = recordValue(sourceContext.productValidation);
  assert.deepEqual(metadata.agents, DEFAULT_PRODUCT_VALIDATION_AGENTS);
  assert.deepEqual(productValidation.agents, DEFAULT_PRODUCT_VALIDATION_AGENTS);
  assert.equal(input.task, sampleRow.problem_statement);
  assert.equal(Object.hasOwn(sourceContext, "acceptanceChecklist"), false);
  assert.equal(Object.hasOwn(productValidation, "canonicalCommands"), false);
  assert.equal(Object.hasOwn(productValidation, "diagnosticCommands"), false);
  assert.equal(Object.hasOwn(sourceProductValidation, "canonicalCommands"), false);
  assert.equal(sourceContext.benchmarkInstanceId, "django__django-13128");
});

test("SWE-bench batch report validation rejects omitted manifest assignments", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const secondRecord = recordFromDatasetRow(secondSampleRow, 8);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 2,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
      {
        record: secondRecord,
        queued: { assignmentId: "assignment-two", attempt: 1 },
      },
    ],
  };
  const report = {
    schemaVersion: 1,
    manifest: {
      count: 2,
      assignmentCount: 2,
    },
    jobs: [
      {
        benchmarkInstanceId: firstRecord.benchmarkInstanceId,
        assignmentId: "assignment-one",
      },
    ],
  };

  const result = validateSweBenchBatchReport({ manifest, report });

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /missing report job for pallets__flask-5014/);
});

test("SWE-bench batch report validation rejects jobs outside the frozen manifest", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  const report = {
    schemaVersion: 1,
    manifest: {
      count: 1,
      assignmentCount: 1,
    },
    jobs: [
      {
        benchmarkInstanceId: firstRecord.benchmarkInstanceId,
        assignmentId: "assignment-one",
      },
      {
        benchmarkInstanceId: "sympy__sympy-99999",
        assignmentId: "assignment-replacement",
      },
    ],
  };

  const result = validateSweBenchBatchReport({ manifest, report });

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /report job is not in manifest: sympy__sympy-99999/);
});

test("SWE-bench batch report validation rejects completed jobs without patch evidence", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  const report = {
    schemaVersion: 1,
    manifest: {
      count: 1,
      assignmentCount: 1,
    },
    jobs: [
      {
        benchmarkInstanceId: firstRecord.benchmarkInstanceId,
        assignmentId: "assignment-one",
        status: "completed",
        attempts: { count: 1, lineageCount: 1 },
        patch: {
          path: null,
          sha256: null,
          bytes: 0,
          changedFileCount: 0,
        },
        regressionEvidence: {
          status: "unknown",
        },
        scorer: {
          required: false,
        },
      },
    ],
  };

  const result = validateSweBenchBatchReport({ manifest, report });

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /completed job django__django-13128 is missing patch evidence/);
  assert.match(result.violations.join("\n"), /completed job django__django-13128 is missing regression evidence/);
});

test("SWE-bench batch report validation rejects scorer-required jobs without scorer evidence", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  const report = {
    schemaVersion: 1,
    manifest: {
      count: 1,
      assignmentCount: 1,
    },
    jobs: [
      {
        benchmarkInstanceId: firstRecord.benchmarkInstanceId,
        assignmentId: "assignment-one",
        status: "completed",
        attempts: { count: 1, lineageCount: 1 },
        patch: {
          path: "/tmp/patch.diff",
          sha256: "a".repeat(64),
          bytes: 123,
          changedFileCount: 1,
        },
        regressionEvidence: {
          status: "present",
        },
        scorer: {
          required: true,
          completed: false,
          logPath: null,
        },
      },
    ],
  };

  const result = validateSweBenchBatchReport({ manifest, report });

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /job django__django-13128 requires scorer evidence/);
});

test("SWE-bench scorer-required validation covers failed jobs with source patches", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", failureKind: "agent_exit_nonzero" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };

  const report = buildSweBenchBatchReport({
    manifest,
    scorerRequired: true,
    evidenceByAssignmentId: {
      "assignment-one": {
        patch: {
          path: "/tmp/patch.diff",
          sha256: "a".repeat(64),
          bytes: 123,
          changedFiles: ["django/db/models/expressions.py"],
          changedFileCount: 1,
        },
      },
    },
  });

  const job = recordValue(report.jobs[0]);
  assert.equal(recordValue(job.scorer).required, true);
  assert.equal(recordValue(report.validation).valid, false);
  assert.match(String(recordValue(report.validation).violations), /job django__django-13128 requires scorer evidence/);
});

test("SWE-bench scorer-required report exempts failed test-only patches with explicit reason", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", failureKind: "agent_exit_nonzero" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };

  const report = buildSweBenchBatchReport({
    manifest,
    scorerRequired: true,
    evidenceByAssignmentId: {
      "assignment-one": {
        patch: {
          path: "/tmp/patch.diff",
          sha256: "a".repeat(64),
          bytes: 123,
          changedFiles: ["tests/expressions/tests.py"],
          changedFileCount: 1,
        },
      },
    },
  });

  const scorer = recordValue(recordValue(report.jobs[0]).scorer);
  assert.equal(scorer.required, false);
  assert.equal(scorer.exempt, true);
  assert.equal(scorer.exemptionReason, "source_patch_absent");
  assert.equal(recordValue(report.summary).scorerRequired, 0);
  assert.equal(recordValue(report.summary).scorerExempted, 1);
  assert.equal(recordValue(report.validation).valid, true);
});

test("SWE-bench batch report validation rejects fixture-only regression evidence", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  const report = {
    schemaVersion: 1,
    manifest: {
      count: 1,
      assignmentCount: 1,
    },
    jobs: [
      {
        benchmarkInstanceId: firstRecord.benchmarkInstanceId,
        assignmentId: "assignment-one",
        status: "completed",
        patch: {
          path: "/tmp/patch.diff",
          sha256: "a".repeat(64),
          bytes: 123,
          changedFiles: ["tests/fixtures/expression-wrapper.json"],
          changedFileCount: 1,
        },
        regressionEvidence: {
          status: "present",
        },
        scorer: {
          required: false,
        },
      },
    ],
  };

  const result = validateSweBenchBatchReport({ manifest, report });

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /fixture\/fake\/snapshot-only changes/);
});

test("SWE-bench batch report validation rejects rewritten oracle tests without external scorer", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const canonicalCommand = "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction";
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "completed" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };

  const report = buildSweBenchBatchReport({
    manifest,
    evidenceByAssignmentId: {
      "assignment-one": {
        patch: {
          path: "/tmp/patch.diff",
          sha256: "a".repeat(64),
          bytes: 123,
          changedFiles: ["django/db/models/expressions.py", "tests/expressions/tests.py"],
          changedFileCount: 2,
        },
        regressionEvidence: {
          status: "present",
          canonicalCommandsRun: [canonicalCommand],
          canonicalCommandsMissing: [],
        },
        scorer: {
          required: false,
          completed: false,
          resolved: false,
        },
      },
    },
  });

  const job = recordValue(report.jobs[0]);
  const oracleIntegrity = recordValue(recordValue(job.regressionEvidence).oracleIntegrity);

  assert.equal(recordValue(report.validation).valid, false);
  assert.match(String(recordValue(report.validation).violations), /rewritten oracle test evidence/);
  assert.deepEqual(oracleIntegrity.pollutedChangedTestFiles, ["tests/expressions/tests.py"]);
  assert.equal(oracleIntegrity.externalOracleRequired, true);
});

test("SWE-bench batch report validation accepts rewritten tests when scorer resolves", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const canonicalCommand = "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction";
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "completed" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };

  const report = buildSweBenchBatchReport({
    manifest,
    evidenceByAssignmentId: {
      "assignment-one": {
        patch: {
          path: "/tmp/patch.diff",
          sha256: "a".repeat(64),
          bytes: 123,
          changedFiles: ["django/db/models/expressions.py", "tests/expressions/tests.py"],
          changedFileCount: 2,
        },
        regressionEvidence: {
          status: "present",
          canonicalCommandsRun: [canonicalCommand],
          canonicalCommandsMissing: [],
        },
        scorer: {
          required: false,
          completed: true,
          resolved: true,
          unresolved: false,
          failed: false,
          logPath: "/tmp/scorer.log",
        },
      },
    },
  });

  const job = recordValue(report.jobs[0]);
  const oracleIntegrity = recordValue(recordValue(job.regressionEvidence).oracleIntegrity);

  assert.equal(recordValue(report.validation).valid, true);
  assert.equal(oracleIntegrity.externalOracleRequired, true);
  assert.equal(oracleIntegrity.externalOracleSatisfied, true);
});

test("SWE-bench scorer summary imports official resolved evidence by instance id", () => {
  const summary = {
    runId: "cpb-source-only",
    aggregateReport: "/tmp/aggregate-report.json",
    prediction: "/tmp/prediction.jsonl",
    instances: [
      {
        instance_id: "django__django-13128",
        resolved: true,
        patch_successfully_applied: true,
        fail_to_pass_success: 1,
        fail_to_pass_failure: 0,
        pass_to_pass_success: 23,
        pass_to_pass_failure: 0,
        report: "/tmp/django__django-13128/report.json",
        test_output: "/tmp/django__django-13128/test_output.txt",
      },
    ],
  };

  const byInstance = scorerEvidenceByInstanceId(summary, "/tmp/official-score-summary.json");
  const scorer = recordValue(byInstance["django__django-13128"]);

  assert.equal(scorer.completed, true);
  assert.equal(scorer.resolved, true);
  assert.equal(scorer.unresolved, false);
  assert.equal(scorer.failed, false);
  assert.equal(scorer.patchSuccessfullyApplied, true);
  assert.equal(scorer.failToPassSuccess, 1);
  assert.equal(scorer.passToPassSuccess, 23);
  assert.equal(scorer.logPath, "/tmp/django__django-13128/report.json");
});

test("SWE-bench report rebuild can merge official scorer evidence into failed verifier jobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-scorer-rebuild-"));
  const manifestPath = path.join(root, "manifest.json");
  const reportPath = path.join(root, "report.json");
  const scorerEvidencePath = path.join(root, "official-score-summary.json");
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", failureKind: "agent_exit_nonzero" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  await writeFile(scorerEvidencePath, JSON.stringify({
    runId: "cpb-source-only",
    aggregateReport: "/tmp/aggregate-report.json",
    prediction: "/tmp/prediction.jsonl",
    instances: [
      {
        instance_id: firstRecord.benchmarkInstanceId,
        resolved: true,
        patch_successfully_applied: true,
        fail_to_pass_success: 1,
        fail_to_pass_failure: 0,
        pass_to_pass_success: 23,
        pass_to_pass_failure: 0,
        report: "/tmp/report.json",
      },
    ],
  }));

  const assignmentScorer = await loadSweBenchScorerEvidenceByAssignmentId({ manifest, scorerEvidencePath });
  assert.equal(recordValue(recordValue(assignmentScorer["assignment-one"]).scorer).resolved, true);

  const outputs = await writeSweBenchBatchOutputs({
    manifest,
    manifestPath,
    reportPath,
    scorerRequired: true,
    scorerEvidencePath,
  });
  const report = recordValue(outputs.report);
  const jobs = Array.isArray(report.jobs) ? report.jobs : [];
  const job = recordValue(jobs[0]);
  const scorer = recordValue(job.scorer);

  assert.equal(job.status, "failed");
  assert.equal(scorer.required, true);
  assert.equal(scorer.completed, true);
  assert.equal(scorer.resolved, true);
  assert.equal(recordValue(report.summary).scorerRequired, 1);
  assert.equal(recordValue(report.summary).scorerCompleted, 1);
  assert.equal(recordValue(report.summary).scorerResolved, 1);
  assert.equal(recordValue(report.validation).valid, true);
  assert.deepEqual(recordValue(report.validation).violations, []);
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).jobs[0].scorer.resolved, true);
});

test("SWE-bench batch report validation rejects incomplete attempt lineage", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", attempts: 2 },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  const report = {
    schemaVersion: 1,
    manifest: {
      count: 1,
      assignmentCount: 1,
    },
    jobs: [
      {
        benchmarkInstanceId: firstRecord.benchmarkInstanceId,
        assignmentId: "assignment-one",
        status: "failed",
        attempts: { count: 1, lineageCount: 1 },
      },
    ],
  };

  const result = validateSweBenchBatchReport({ manifest, report });

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /attempt lineage incomplete for django__django-13128/);
});

test("SWE-bench batch report validation rejects hard-constraint attempts", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };

  const report = buildSweBenchBatchReport({
    manifest,
    evidenceByAssignmentId: {
      "assignment-one": {
        blockedEvents: {
          broadTestCommandAttempts: 1,
          broadTestCommandBlocked: 1,
        },
      },
    },
  });

  assert.equal(recordValue(report.validation).valid, false);
  assert.match(String(recordValue(report.validation).violations), /hard-constraint attempt/);
});

test("SWE-bench batch report builder emits manifest hash and integrity fields", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const secondRecord = recordFromDatasetRow(secondSampleRow, 8);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 2,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
      {
        record: secondRecord,
        queued: { assignmentId: "assignment-two", attempt: 1 },
      },
    ],
  };

  const report = buildSweBenchBatchReport({
    manifest,
    generatedAt: "2026-07-05T00:01:00.000Z",
  });

  assert.equal(report.generatedAt, "2026-07-05T00:01:00.000Z");
  assert.match(String(recordValue(report.manifest).hash), /^[a-f0-9]{64}$/);
  assert.equal(recordValue(report.manifest).assignmentCount, 2);
  assert.equal(report.jobs?.length, 2);
  const firstJob = recordValue(report.jobs?.[0]);
  assert.equal(firstJob.benchmarkInstanceId, "django__django-13128");
  assert.deepEqual(recordValue(recordValue(firstJob.providerRoute).expected), DEFAULT_PRODUCT_VALIDATION_AGENTS);
  assert.equal(recordValue(firstJob.scorer).required, false);
  assert.equal(recordValue(firstJob.regressionEvidence).status, "unknown");
  assert.equal(recordValue(report.summary).residualProcesses, 0);
  assert.equal(recordValue(report.validation).valid, true);
});

test("SWE-bench batch report builder summarizes terminal assignment states", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const secondRecord = recordFromDatasetRow(secondSampleRow, 8);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 2,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "completed" },
      { assignmentId: "assignment-two", status: "failed", failureKind: "phase_timeout" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
      {
        record: secondRecord,
        queued: { assignmentId: "assignment-two", attempt: 1 },
      },
    ],
  };

  const report = buildSweBenchBatchReport({ manifest });
  const secondJob = recordValue(report.jobs[1]);

  assert.equal(recordValue(report.summary).terminalJobs, 2);
  assert.deepEqual(recordValue(report.summary).terminalStates, {
    completed: 1,
    failed: 1,
  });
  assert.equal(recordValue(report.jobs[0]).status, "completed");
  assert.equal(secondJob.status, "failed");
  assert.equal(secondJob.failureKind, "phase_timeout");
});

test("SWE-bench batch report builder includes worker cleanup evidence", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", failureKind: "phase_timeout" },
    ],
    workerCleanup: {
      workerCleanupEvents: 1,
      forcedKills: 1,
      residualProcesses: 2,
      workerIds: ["w-swebench-01"],
      pids: [12345],
      reasons: ["batch_wait_completed"],
    },
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };

  const report = buildSweBenchBatchReport({ manifest });

  const summary = recordValue(report.summary);
  assert.equal(summary.cleanupEvents, 1);
  assert.equal(summary.forcedKills, 1);
  assert.equal(summary.residualProcesses, 2);
  assert.equal(recordValue(recordValue(report.manifest).workerCleanup).residualProcesses, 2);
  assert.equal(recordValue(report.validation).valid, false);
  assert.match(String(recordValue(report.validation).violations), /residual process/);
});

test("SWE-bench batch report builder derives failure kind from phase evidence", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };

  const report = buildSweBenchBatchReport({
    manifest,
    evidenceByAssignmentId: {
      "assignment-one": {
        phaseEvidence: {
          execute: {
            ok: false,
            failureKind: "agent_rate_limited",
          },
        },
      },
    },
  });

  assert.equal(recordValue(report.jobs[0]).failureKind, "agent_rate_limited");
});

test("SWE-bench batch queue stops started workers before writing final report", async () => {
  const livePids = new Set([12345]);
  const signals: string[] = [];

  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345 },
  ], {
    reason: "test-cleanup",
    graceMs: 0,
    pollMs: 0,
    processAlive: (pid) => livePids.has(pid),
    killProcess: (pid, signal) => {
      signals.push(`${pid}:${signal}`);
      if (signal === "SIGKILL") livePids.delete(pid);
    },
  });

  assert.deepEqual(signals, ["12345:SIGTERM", "12345:SIGKILL"]);
  assert.equal(cleanup.workerCleanupEvents, 1);
  assert.equal(cleanup.forcedKills, 1);
  assert.equal(cleanup.residualProcesses, 0);
  assert.deepEqual(cleanup.workerIds, ["w-swebench-01"]);
});

test("SWE-bench batch queue starts quota delegate before managed workers", async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown>; unref?: boolean }> = [];
  let aliveChecks = 0;

  const started = await startQuotaDelegate({
    hubRoot: "/tmp/cpb-hub",
    cpbRoot: "/tmp/cpb-root",
    repoRoot: "/repo",
    distRoot: "/dist",
    readyPollMs: 0,
    readyTimeoutMs: 100,
    isDelegateAliveFn: async () => {
      aliveChecks += 1;
      return aliveChecks > 1;
    },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options: options as Record<string, unknown> });
      return {
        pid: 24680,
        unref: () => {
          calls[0].unref = true;
        },
      };
    },
  });

  assert.equal(started?.workerId, "quota-delegate");
  assert.equal(started?.pid, 24680);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    "/dist/server/services/quota-delegate.js",
    "--hub-root",
    "/tmp/cpb-hub",
  ]);
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(recordValue(calls[0].options.env).CPB_HUB_ROOT, "/tmp/cpb-hub");
  assert.equal(recordValue(calls[0].options.env).CPB_ROOT, "/tmp/cpb-root");
  assert.equal(calls[0].unref, true);
});

test("SWE-bench batch report builder merges patch regression and scorer evidence", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "completed" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };

  const report = buildSweBenchBatchReport({
    manifest,
    scorerRequired: true,
    evidenceByAssignmentId: {
      "assignment-one": {
        patch: {
          path: "/tmp/patch.diff",
          sha256: "b".repeat(64),
          bytes: 234,
          changedFiles: ["django/db/models/expressions.py"],
          changedFileCount: 1,
          applyStatus: "applies",
        },
        regressionEvidence: {
          status: "present",
          canonicalCommandsRun: ["PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction"],
          canonicalCommandsMissing: [],
        },
        scorer: {
          required: true,
          completed: true,
          resolved: true,
          unresolved: false,
          failed: false,
          logPath: "/tmp/scorer.log",
          patchSha256: "b".repeat(64),
          image: "sweb.eval.x86_64.django",
          command: "python -m swebench.harness.run_evaluation ...",
          exitCode: 0,
        },
      },
    },
  });

  const job = recordValue(report.jobs[0]);
  assert.equal(recordValue(job.patch).sha256, "b".repeat(64));
  assert.equal(recordValue(job.regressionEvidence).status, "present");
  assert.equal(recordValue(job.scorer).completed, true);
  assert.equal(recordValue(report.summary).scorerRequired, 1);
  assert.equal(recordValue(report.summary).scorerCompleted, 1);
  assert.equal(recordValue(report.validation).valid, true);
});

test("SWE-bench batch evidence collector ingests assignment result phase artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-evidence-test-"));
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "completed" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  const attemptDir = path.join(root, "assignments", "assignment-one", "attempts", "001");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
    status: "completed",
    phaseResults: [
      {
        phase: "execute",
        artifact: {
          path: "/tmp/deliverable.md",
          sha256: "c".repeat(64),
          bytes: 456,
          metadata: {
            changedFiles: [" M django/db/models/expressions.py"],
          },
        },
      },
      {
        phase: "verify",
        artifact: {
          metadata: {
            status: "pass",
            tests: ["PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction"],
          },
        },
      },
    ],
  }), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const job = recordValue(report.jobs[0]);

  assert.equal(recordValue(job.patch).sha256, "c".repeat(64));
  assert.deepEqual(recordValue(job.patch).changedFiles, ["django/db/models/expressions.py"]);
  assert.equal(recordValue(job.patch).changedFileCount, 1);
  assert.equal(recordValue(job.regressionEvidence).status, "present");
  assert.equal(recordValue(report.validation).valid, true);
});

test("SWE-bench batch evidence collector ingests real jobResult phase evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-real-evidence-test-"));
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const canonicalFailToPass = "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction";
  const canonicalPassToPass = "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTests.test_deepcopy expressions.tests.CombinableTests.test_and";
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "completed" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  const attemptDir = path.join(root, "assignments", "assignment-one", "attempts", "001");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
    status: "completed",
    jobResult: {
      status: "completed",
      phaseResults: [
        {
          phase: "execute",
          status: "passed",
          artifact: {
            path: "/tmp/deliverable.md",
            sha256: "e".repeat(64),
            bytes: 456,
            metadata: {
              changedFiles: [],
            },
          },
          diagnostics: {
            elapsedMs: 1234,
            usage: { toolCalls: 207 },
          },
        },
        {
          phase: "verify",
          status: "passed",
          artifact: {
            metadata: {
              status: "pass",
            },
          },
          diagnostics: {
            elapsedMs: 567,
            verificationEvidence: {
              git: {
                changedFiles: [
                  "django/db/models/expressions.py",
                  "tests/expressions/tests.py",
                ],
                diffHash: "sha256:" + "f".repeat(64),
              },
            },
            evidenceLedgerArtifact: {
              metadata: {
                evidence: [
                  { observationType: "test", command: canonicalFailToPass, result: "pass" },
                  { observationType: "test", command: canonicalPassToPass, result: "pass" },
                ],
              },
            },
          },
        },
      ],
    },
  }), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const job = recordValue(report.jobs[0]);
  const patch = recordValue(job.patch);
  const regression = recordValue(job.regressionEvidence);
  const phaseEvidence = recordValue(job.phaseEvidence);

  assert.equal(patch.sha256, "e".repeat(64));
  assert.deepEqual(patch.changedFiles, [
    "django/db/models/expressions.py",
    "tests/expressions/tests.py",
  ]);
  assert.equal(patch.changedFileCount, 2);
  assert.equal(regression.status, "present");
  assert.deepEqual(regression.canonicalCommandsRun, [canonicalFailToPass, canonicalPassToPass]);
  assert.deepEqual(recordValue(regression.oracleIntegrity).pollutedChangedTestFiles, ["tests/expressions/tests.py"]);
  assert.equal(recordValue(phaseEvidence.execute).durationMs, 1234);
  assert.equal(recordValue(phaseEvidence.verify).durationMs, 567);
  assert.equal(recordValue(phaseEvidence.execute).toolEvents, 207);
  assert.equal(recordValue(report.validation).valid, false);
  assert.match(String(recordValue(report.validation).violations), /rewritten oracle test evidence/);
});

test("SWE-bench batch evidence collector records phase metrics and audit counts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-phase-metrics-test-"));
  const auditPath = path.join(root, "audit.jsonl");
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "completed" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  await writeFile(auditPath, [
    JSON.stringify({ event: "session_update", phase: "execute" }),
    JSON.stringify({ event: "tool_call", phase: "execute", toolCallId: "tool-1" }),
    JSON.stringify({ event: "terminal_create", phase: "execute", command: "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction" }),
  ].join("\n"), "utf8");
  const attemptDir = path.join(root, "assignments", "assignment-one", "attempts", "001");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
    status: "completed",
    phaseResults: [
      {
        phase: "execute",
        ok: true,
        durationMs: 1234,
        attempt: 1,
        diagnostics: { acpAuditFile: auditPath },
        artifact: {
          path: "/tmp/deliverable.md",
          sha256: "d".repeat(64),
          bytes: 789,
          metadata: {
            changedFiles: [" M django/db/models/expressions.py"],
          },
        },
      },
    ],
  }), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const phaseEvidence = recordValue(recordValue(report.jobs[0]).phaseEvidence);
  const executeEvidence = recordValue(phaseEvidence.execute);
  const summary = recordValue(report.summary);

  assert.equal(executeEvidence.durationMs, 1234);
  assert.equal(executeEvidence.structuredOutputBytes, 789);
  assert.equal(executeEvidence.toolEvents, 1);
  assert.equal(executeEvidence.auditUpdateEvents, 1);
  assert.equal(executeEvidence.terminalCommands, 1);
  assert.equal(recordValue(summary.phaseDurationsMs).executeMax, 1234);
  assert.equal(recordValue(summary.structuredOutputBytes).execute, 789);
  assert.equal(recordValue(summary.toolEventCounts).execute, 1);
  assert.equal(recordValue(summary.terminalCommandCounts).execute, 1);
  assert.equal(recordValue(summary.auditUpdateEvents).execute, 1);
});

test("SWE-bench batch evidence collector records runtime phase retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-phase-retry-test-"));
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const projectId = "swebench-django-django-13128";
  const jobId = "job-django-django-13128";
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "completed", projectId },
    ],
    assignments: [
      {
        projectId,
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  const attemptDir = path.join(root, "assignments", "assignment-one", "attempts", "001");
  const eventDir = path.join(root, "projects", projectId, "events", projectId);
  await mkdir(attemptDir, { recursive: true });
  await mkdir(eventDir, { recursive: true });
  await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
    status: "completed",
    jobResult: {
      status: "completed",
      jobId,
      phaseResults: [
        {
          phase: "execute",
          status: "passed",
          artifact: {
            path: "/tmp/deliverable.md",
            sha256: "1".repeat(64),
            bytes: 456,
            metadata: { changedFiles: ["django/db/models/expressions.py"] },
          },
        },
        {
          phase: "verify",
          status: "passed",
          artifact: {
            metadata: {
              status: "pass",
              tests: ["PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction"],
            },
          },
        },
      ],
    },
  }), "utf8");
  await writeFile(path.join(eventDir, `${jobId}.jsonl`), [
    JSON.stringify({
      type: "phase_retry",
      phase: "execute",
      failureKind: "timeout",
      reason: "claude-glm timed out after 1200000ms",
    }),
  ].join("\n"), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const executeEvidence = recordValue(recordValue(recordValue(report.jobs[0]).phaseEvidence).execute);

  assert.equal(executeEvidence.retryCount, 1);
  assert.equal(executeEvidence.failureKind, "timeout");
  assert.equal(recordValue(recordValue(report.summary).phaseRetryCounts).execute, 1);
});

test("SWE-bench batch evidence collector summarizes ACP blocked audit events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-audit-evidence-test-"));
  const auditPath = path.join(root, "audit.jsonl");
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", failureKind: "broad_test_command_denied" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  await writeFile(auditPath, [
    JSON.stringify({ event: "tool_blocked", reason: "web tool use is disabled for this ACP run" }),
    JSON.stringify({ event: "terminal_blocked", classification: "broad_test_command_denied", reason: "broad_test_command_denied: tests/runtests.py models" }),
    JSON.stringify({ event: "tool_blocked", reason: "read-only phase \"verify\" cannot run mutating terminal command (git stash)" }),
  ].join("\n"), "utf8");
  const attemptDir = path.join(root, "assignments", "assignment-one", "attempts", "001");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
    status: "failed",
    phaseResults: [
      {
        phase: "execute",
        diagnostics: { acpAuditFile: auditPath },
      },
    ],
  }), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const blockedEvents = recordValue(recordValue(report.jobs[0]).blockedEvents);

  assert.equal(blockedEvents.webToolAttempts, 1);
  assert.equal(blockedEvents.webToolBlocked, 1);
  assert.equal(blockedEvents.broadTestCommandAttempts, 1);
  assert.equal(blockedEvents.broadTestCommandBlocked, 1);
  assert.equal(blockedEvents.readOnlyMutationAttempts, 1);
  assert.equal(blockedEvents.readOnlyMutationBlocked, 1);
  assert.equal(recordValue(report.summary).webToolAttempts, 1);
  assert.equal(recordValue(report.summary).broadTestCommandAttempts, 1);
});

test("SWE-bench batch report preserves hard-constraint failure over coarse agent exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-hard-failure-kind-test-"));
  const auditPath = path.join(root, "audit.jsonl");
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", failureKind: "agent_exit_nonzero" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  await writeFile(auditPath, JSON.stringify({
    event: "tool_blocked",
    phase: "adversarial_verify",
    classification: "broad_test_command_denied",
    reason: "broad_test_command_denied: canonical command was wrapped with tail",
  }), "utf8");
  const attemptDir = path.join(root, "assignments", "assignment-one", "attempts", "001");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
    status: "failed",
    jobResult: {
      failure: {
        kind: "agent_exit_nonzero",
        reason: "claude-mimo exited 1: canonical command was wrapped with tail",
      },
    },
    phaseResults: [
      {
        phase: "adversarial_verify",
        diagnostics: { acpAuditFile: auditPath },
        failure: { kind: "agent_exit_nonzero" },
      },
    ],
  }), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const job = recordValue(report.jobs[0]);
  const adversarial = recordValue(recordValue(job.phaseEvidence).adversarial_verify);

  assert.equal(job.failureKind, "broad_test_command_denied");
  assert.equal(adversarial.failureKind, "broad_test_command_denied");
});

test("SWE-bench batch report preserves no-edit execute failure over coarse agent exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-no-edit-failure-kind-test-"));
  const auditPath = path.join(root, "audit.jsonl");
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", failureKind: "agent_exit_nonzero" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  await writeFile(auditPath, JSON.stringify({
    event: "tool_blocked",
    phase: "execute",
    classification: "swebench_execute_no_edit_progress",
    reason: "swebench_execute_no_edit_progress: SWE-bench execute phase exceeded no-edit read/search limit 5",
  }), "utf8");
  const attemptDir = path.join(root, "assignments", "assignment-one", "attempts", "001");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
    status: "failed",
    jobResult: {
      failure: {
        kind: "agent_exit_nonzero",
        reason: "claude-glm exited 1",
      },
    },
    phaseResults: [
      {
        phase: "execute",
        diagnostics: { acpAuditFile: auditPath },
        failure: { kind: "agent_exit_nonzero" },
      },
    ],
  }), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const job = recordValue(report.jobs[0]);
  const execute = recordValue(recordValue(job.phaseEvidence).execute);

  assert.equal(job.failureKind, "swebench_execute_no_edit_progress");
  assert.equal(execute.failureKind, "swebench_execute_no_edit_progress");
});

test("SWE-bench batch evidence collector summarizes cleanup audit evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-cleanup-evidence-test-"));
  const auditPath = path.join(root, "audit.jsonl");
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", failureKind: "phase_timeout" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  await writeFile(auditPath, [
    JSON.stringify({
      event: "terminal_cleanup",
      reason: "phase_timeout",
      terminalIds: ["term-1"],
      forcedKillCount: 1,
      residualProcesses: 0,
    }),
  ].join("\n"), "utf8");
  const attemptDir = path.join(root, "assignments", "assignment-one", "attempts", "001");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
    status: "failed",
    phaseResults: [
      {
        phase: "execute",
        diagnostics: { acpAuditFile: auditPath },
      },
    ],
  }), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const cleanup = recordValue(recordValue(report.jobs[0]).cleanup);

  assert.equal(cleanup.terminalCleanupEvents, 1);
  assert.equal(cleanup.forcedKills, 1);
  assert.equal(cleanup.residualProcesses, 0);
  assert.equal(recordValue(report.summary).cleanupEvents, 1);
  assert.equal(recordValue(report.summary).forcedKills, 1);
  assert.equal(recordValue(report.summary).residualProcesses, 0);
});

test("SWE-bench batch output writer stores manifest and report JSON side by side", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-report-test-"));
  const manifestPath = path.join(root, "swebench-batch-queue-manifest.json");
  const reportPath = path.join(root, "swebench-batch-report.json");
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };

  const outputs = await writeSweBenchBatchOutputs({ manifest, manifestPath, reportPath });
  const writtenManifest = JSON.parse(await readFile(outputs.manifestPath, "utf8"));
  const writtenReport = JSON.parse(await readFile(outputs.reportPath, "utf8"));

  assert.equal(writtenManifest.count, 1);
  assert.equal(writtenReport.jobs.length, 1);
  assert.match(String(recordValue(writtenReport.manifest).hash), /^[a-f0-9]{64}$/);
  assert.equal(recordValue(writtenReport.validation).valid, true);
});

test("SWE-bench batch queue writes manifest and report when provider preflight fails before enqueue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-preflight-fail-"));
  const manifestPath = path.join(root, "manifest.json");
  const reportPath = path.join(root, "report.json");
  const options = resolveBatchQueueOptions([
    "node",
    "queue-swebench-batch.js",
    "--hub-root",
    path.join(root, "hub"),
    "--cpb-root",
    path.join(root, "cpb"),
    "--source-root",
    path.join(root, "sources"),
    "--output",
    manifestPath,
    "--report-output",
    reportPath,
    "--provider-preflight",
    "live",
  ]);

  const outputs = await writePreflightFailureOutputs({
    options,
    providerPreflight: {
      schemaVersion: 1,
      ok: false,
      failureKind: "provider_unavailable",
      violations: ["executor provider claude:glm failed structured handshake: 429"],
      phases: [],
      providers: [],
    },
    startedAt: "2026-07-05T00:00:00.000Z",
  });

  const manifest = JSON.parse(await readFile(outputs.manifestPath, "utf8"));
  const report = JSON.parse(await readFile(outputs.reportPath, "utf8"));

  assert.equal(manifest.count, 0);
  assert.deepEqual(manifest.assignments, []);
  assert.equal(recordValue(manifest.providerPreflight).ok, false);
  assert.equal(recordValue(report.summary).totalJobs, 0);
  assert.equal(recordValue(report.summary).providerPreflightOk, false);
  assert.equal(recordValue(report.validation).valid, false);
  assert.match(String(recordValue(report.validation).violations), /provider preflight failed/);
});

test("SWE-bench batch output writer includes hub result evidence when available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-output-evidence-test-"));
  const manifestPath = path.join(root, "swebench-batch-queue-manifest.json");
  const reportPath = path.join(root, "swebench-batch-report.json");
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId: "assignment-one", status: "completed" },
    ],
    assignments: [
      {
        record: firstRecord,
        queued: { assignmentId: "assignment-one", attempt: 1 },
      },
    ],
  };
  const attemptDir = path.join(root, "assignments", "assignment-one", "attempts", "001");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
    status: "completed",
    phaseResults: [
      {
        phase: "execute",
        artifact: {
          path: "/tmp/deliverable.md",
          sha256: "d".repeat(64),
          bytes: 456,
          metadata: { changedFiles: [" M django/db/models/expressions.py"] },
        },
      },
      {
        phase: "verify",
        artifact: { metadata: { status: "pass", tests: ["focused regression test"] } },
      },
    ],
  }), "utf8");

  const outputs = await writeSweBenchBatchOutputs({ manifest, manifestPath, reportPath, hubRoot: root });
  const writtenReport = JSON.parse(await readFile(outputs.reportPath, "utf8"));

  assert.equal(recordValue(recordValue(writtenReport.jobs[0]).patch).sha256, "d".repeat(64));
  assert.equal(recordValue(writtenReport.validation).valid, true);
});

test("SWE-bench worker env keeps infrastructure settings but injects no solving policy", () => {
  const env = buildManagedWorkerEnv({
    repoRoot: "/repo",
    hubRoot: "/tmp/hub",
    cpbRoot: "/tmp/cpb",
    phaseAgents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    timeoutMs: 12345,
  });

  assert.equal(env.CPB_DYNAMIC_VERIFIER_AGENT, "claude-mimo");
  assert.equal(env.CPB_WORKER_EXIT_ON_IDLE, "1");
  assert.equal(env.CPB_WORKER_IDLE_EXIT_MS, "60000");
  assert.equal(env.CPB_ACP_TIMEOUT_MS, "12345");
  assert.equal(env.CPB_ACP_IDLE_TIMEOUT_MS, "12345");
  assert.equal(env.CPB_ACP_SESSION_UPDATE_IDLE_TIMEOUT_MS, "12345");
  for (const key of [
    "CPB_ACP_SWEBENCH_EXECUTE_NO_EDIT_TOOL_LIMIT",
    "CPB_PHASE_RETRY_MAX",
    "CPB_CHECKLIST_DECOMPOSE",
    "CPB_ACP_DISABLE_WEB_TOOLS",
    "CPB_ACP_TOOL_CALL_BUDGET_PLAN",
    "CPB_ACP_TOOL_CALL_BUDGET_EXECUTE",
    "CPB_ACP_TOOL_CALL_BUDGET_VERIFY",
    "CPB_ACP_TOOL_CALL_BUDGET_ADVERSARIAL_VERIFY",
    "CPB_ACP_TOOL_EVENT_BUDGET_PLAN",
    "CPB_ACP_TOOL_EVENT_BUDGET_EXECUTE",
    "CPB_ACP_TOOL_EVENT_BUDGET_VERIFY",
    "CPB_ACP_TOOL_EVENT_BUDGET_ADVERSARIAL_VERIFY",
  ]) {
    assert.equal(Object.hasOwn(env, key), false, key);
  }
  const longEnv = buildManagedWorkerEnv({
    repoRoot: "/repo",
    hubRoot: "/tmp/hub",
    cpbRoot: "/tmp/cpb",
    phaseAgents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    timeoutMs: 999999,
  });
  assert.equal(longEnv.CPB_ACP_IDLE_TIMEOUT_MS, "600000");
  assert.equal(longEnv.CPB_ACP_SESSION_UPDATE_IDLE_TIMEOUT_MS, "600000");
  assert.equal(Object.hasOwn(longEnv, "CPB_ACP_SWEBENCH_EXECUTE_NO_EDIT_TOOL_LIMIT"), false);
});

test("SWE-bench batch queue does not weaken CodeGraph readiness", () => {
  assert.doesNotMatch(batchQueueSource, /CPB_CODEGRAPH_INDEX_ONLY_OK\s*:\s*"1"/);
  assert.match(batchQueueSource, /registerProject/);
});

test("SWE-bench batch wait marks stale assignments failed at timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-wait-timeout-"));
  const store = new AssignmentStore(root);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: "timeout-one",
    projectId: "swebench-timeout-one",
    task: "stale assignment",
    sourcePath: root,
  });
  const attempt = await store.createAttempt(String(assignment.assignmentId), {
    workerId: "w-timeout",
    orchestratorEpoch: 1,
  });

  const states = await waitForAssignments(root, [{ assignmentId: assignment.assignmentId }], {
    intervalMs: 1,
    timeoutMs: 1,
    reason: "unit_timeout",
  });

  assert.equal(states[0]?.status, "failed");
  const resultPath = path.join(root, "assignments", String(assignment.assignmentId), "attempts", "001", "result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(result.attemptToken, attempt.attemptToken);
  assert.equal(result.failureKind, "unit_timeout");
});

test("SWE-bench batch report keeps synthetic timeout failure kind", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-timeout-report-"));
  const assignmentId = "assignment-timeout";
  const resultDir = path.join(root, "assignments", assignmentId, "attempts", "001");
  await mkdir(resultDir, { recursive: true });
  await writeFile(path.join(resultDir, "result.json"), `${JSON.stringify({
    assignmentId,
    attempt: 1,
    attemptToken: "tok-timeout",
    status: "failed",
    failureKind: "batch_wait_timeout",
    error: "batch_wait_timeout: assignment did not reach a terminal state before batch wait timeout",
  }, null, 2)}\n`, "utf8");

  const record = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    terminalStates: [
      { assignmentId, status: "failed", attempts: 1 },
    ],
    assignments: [
      {
        record,
        queued: { assignmentId, attempt: 1 },
      },
    ],
  };
  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });

  assert.equal(report.jobs[0].failureKind, "batch_wait_timeout");
});

test("SWE-bench batch queue notification command uses native macOS notifications", () => {
  const command = buildNotificationCommand({
    platform: "darwin",
    title: "CPB SWE-bench",
    message: "Queued 50 assignments",
  });

  assert.equal(command?.command, "osascript");
  assert.deepEqual(command?.args, [
    "-e",
    "display notification \"Queued 50 assignments\" with title \"CPB SWE-bench\"",
  ]);
});

test("SWE-bench batch queue retries transient command failures", async () => {
  let calls = 0;
  const result = await runRequiredWithRetries("git", ["fetch", "--depth=1", "origin", "abc123"], "/tmp/repo", {
    attempts: 3,
    retryDelayMs: 0,
    runner: async () => {
      calls += 1;
      if (calls === 1) {
        return { stdout: "", stderr: "fatal: early EOF", code: 128 };
      }
      return { stdout: "ok", stderr: "", code: 0 };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.stdout, "ok");
});

test("SWE-bench batch queue reports exhausted command retries", async () => {
  let calls = 0;
  await assert.rejects(
    runRequiredWithRetries("git", ["fetch", "--depth=1", "origin", "abc123"], "/tmp/repo", {
      attempts: 2,
      retryDelayMs: 0,
      runner: async () => {
        calls += 1;
        return { stdout: "", stderr: "fatal: early EOF", code: 128 };
      },
    }),
    /failed after 2 attempts/,
  );
  assert.equal(calls, 2);
});
