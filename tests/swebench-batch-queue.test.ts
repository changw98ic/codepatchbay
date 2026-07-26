import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodeTest, { type TestContext } from "node:test";

import { hasAgent, loadRegistry } from "../core/agents/registry.js";
import type { ProcessIdentity } from "../core/runtime/process-tree.js";
import {
  _internalWithTemporaryWorkspaceHooks,
  temporaryWorkspaceErrorDetails,
} from "../core/runtime/temporary-workspace.js";
import { envForAgent, providerKeyForAgent } from "../server/services/acp/acp-pool.js";
import {
  registerProject as registerHubProject,
  withHubRegistryTestHooks,
} from "../server/services/hub/hub-registry.js";
import { getProviderAdapter } from "../server/services/provider-adapters.js";
import type { QuotaDelegateLockReceipt } from "../server/services/quota-delegate-client.js";
import { DEFAULT_PRODUCT_VALIDATION_AGENTS } from "../scripts/run-swebench-product-validation.js";
import {
  AssignmentStore,
  withAssignmentStoreTestHooksForTests,
  type AssignmentStoreTestHooks,
} from "../shared/orchestrator/assignment-store.js";
import {
  WorkerStore,
  withWorkerStoreTestHooksForTests,
  type WorkerStoreTestHooks,
} from "../shared/orchestrator/worker-store.js";
import { recordValue, type LooseRecord } from "../shared/types.js";
import {
  buildSweBenchBatchReport as buildSweBenchBatchReportProduction,
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
  controlPlaneAuditReferenceValid,
  writeControlPlaneAuditArtifact,
  queueBatchAssignmentAtomically,
  resolveBatchQueueOptions,
  runCommand,
  runSweBenchProviderPreflight,
  runRequiredWithRetries,
  scopedProcessPids,
  startQuotaDelegate,
  stopStartedWorkers,
  waitForAssignments,
  writePreflightFailureOutputs,
  writeSweBenchBatchOutputs as writeSweBenchBatchOutputsProduction,
} from "../scripts/queue-swebench-batch.js";

const assignmentStoreTestHookScope = new AsyncLocalStorage<AssignmentStoreTestHooks>();
const workerStoreTestHookScope = new AsyncLocalStorage<WorkerStoreTestHooks>();
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
const __workerStoreTestHooks = new Proxy({} as WorkerStoreTestHooks, {
  get(_target, property) {
    return Reflect.get(workerStoreTestHookScope.getStore() || {}, property);
  },
  set(_target, property, value) {
    const hooks = workerStoreTestHookScope.getStore();
    if (!hooks) throw new Error("worker store test hook mutation requires a scoped test");
    return Reflect.set(hooks, property, value);
  },
  deleteProperty(_target, property) {
    const hooks = workerStoreTestHookScope.getStore();
    if (!hooks) return true;
    return Reflect.deleteProperty(hooks, property);
  },
});

function test(name: string, fn: (context: TestContext) => void | Promise<void>) {
  return nodeTest(name, (context) => {
    const assignmentHooks: AssignmentStoreTestHooks = {};
    const workerHooks: WorkerStoreTestHooks = {};
    return assignmentStoreTestHookScope.run(assignmentHooks, () =>
      workerStoreTestHookScope.run(workerHooks, () =>
        withAssignmentStoreTestHooksForTests(assignmentHooks, () =>
          withWorkerStoreTestHooksForTests(workerHooks, () => fn(context)))));
  });
}

const batchQueueSource = readFileSync(new URL("../scripts/queue-swebench-batch.js", import.meta.url), "utf8");

function stableTestJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableTestJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableTestJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableTestJsonSha256(value: unknown) {
  return createHash("sha256").update(stableTestJson(value)).digest("hex");
}

async function fileExists(filePath: string) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function testControlPlaneEvidence({
  phase = "execute",
  role = "executor",
  agent = "claude-glm",
  providerKey = "claude:glm",
  transport = "claude-cli",
  overrides = {},
}: {
  phase?: string;
  role?: string;
  agent?: string;
  providerKey?: string;
  transport?: "acp" | "claude-cli";
  overrides?: Record<string, unknown>;
} = {}) {
  const policySummary = transport === "acp"
    ? {
        terminalPolicy: "deny",
        permissionRequests: "reject",
        webToolsDisabled: true,
        toolPolicy: {
          allow: [],
          deny: [
            "fs/read_text_file",
            "fs/write_text_file",
            "terminal/create",
            "terminal/kill",
            "terminal/output",
            "terminal/release",
            "terminal/wait_for_exit",
          ],
        },
      }
    : {
        terminalPolicy: "deny",
        permissionRequests: "reject",
        webToolsDisabled: true,
        tools: [],
        mcpServers: [],
        slashCommandsDisabled: true,
        settings: {
          permissions: {
            allow: [],
            deny: ["Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "WebFetch", "WebSearch", "Write"],
          },
          strictMcpConfig: true,
        },
      };
  const evidence = {
    transport,
    phase,
    role,
    agent,
    providerKey,
    agentLaunchObserved: true,
    sessionObserved: true,
    policyVerified: true,
    toolCallCount: 0,
    terminalLaunchCount: 0,
    policySummary,
    ...overrides,
  };
  return {
    controlPlaneEvidence: evidence,
    controlPlaneEvidenceSha256: stableTestJsonSha256(evidence),
  };
}

function testControlPlaneAuditRef(input: {
  phase: string;
  role: string;
  agent: string;
  providerKey: string;
  transport: "acp" | "claude-cli";
  command?: string;
  projectId?: string;
  jobId?: string;
  correlationNonce?: string;
  outputPath: string;
}, summary: unknown) {
  const dir = path.join(path.dirname(input.outputPath), "control-plane-audit");
  const file = path.join(dir, `${input.phase}-${input.agent}.json`);
  const rawFile = path.join(dir, `${input.phase}-${input.agent}.raw.jsonl`);
  const projectId = input.projectId || "cpb-provider-live-preflight";
  const correlationNonce = input.correlationNonce || "a".repeat(32);
  const jobId = input.jobId || `provider-preflight-${input.role}-${input.agent}-${correlationNonce}`;
  const summaryRecord = recordValue(summary);
  const launchPolicy = summaryRecord.policySummary;
  const rawLines = [
    JSON.stringify({
      ts: "2026-07-20T00:00:00.000Z",
      event: "agent_launch",
      agent: input.agent,
      phase: input.phase,
      role: input.role,
      projectId,
      jobId,
      correlationNonce,
      ...(input.transport === "acp" ? { mcpServers: [], mcpServerNames: [] } : {}),
      livePreflightPolicy: launchPolicy,
    }),
    JSON.stringify({ ts: "2026-07-20T00:00:01.000Z", event: "session_new", agent: input.agent, phase: input.phase, role: input.role, projectId, jobId, correlationNonce, sessionId: "fixture-session-id" }),
  ];
  const raw = `${rawLines.join("\n")}\n`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(rawFile, raw, "utf8");
  const rawBuffer = readFileSync(rawFile);
  const events = [
    {
      index: 0,
      ts: "2026-07-20T00:00:00.000Z",
      event: "agent_launch",
      kind: "launch",
      agent: input.agent,
      phase: input.phase,
      role: input.role,
      projectId,
      jobId,
      correlationNonce,
      policySummary: launchPolicy,
    },
    {
      index: 1,
      ts: "2026-07-20T00:00:01.000Z",
      event: "session_new",
      kind: "session",
      agent: input.agent,
      phase: input.phase,
      role: input.role,
      projectId,
      jobId,
      correlationNonce,
      sessionHash: createHash("sha256").update("fixture-session-id").digest("hex"),
    },
  ];
  const artifact = {
    schemaVersion: 1,
    generator: "scripts/queue-swebench-batch.ts#controlPlaneAuditArtifact",
    generatedAt: "2026-07-20T00:00:02.000Z",
    nonce: correlationNonce,
    jobIdentity: {
      projectId,
      jobId,
      correlationNonce,
      outputPathSha256: createHash("sha256").update(input.outputPath).digest("hex"),
      promptSha256: createHash("sha256").update([
        "CPB provider live preflight.",
        "Do not call tools. Do not inspect files. Reply exactly with: CPB_PROVIDER_PREFLIGHT_OK",
      ].join("\n")).digest("hex"),
      sentinelSha256: createHash("sha256").update("CPB_PROVIDER_PREFLIGHT_OK").digest("hex"),
    },
    route: {
      phase: input.phase,
      role: input.role,
      agent: input.agent,
      providerKey: input.providerKey,
      transport: input.transport,
      command: input.command || (input.transport === "acp" ? "codex-acp" : "claude"),
    },
    rawStream: {
      path: path.basename(rawFile),
      bytes: rawBuffer.byteLength,
      sha256: createHash("sha256").update(rawBuffer).digest("hex"),
      eventCount: rawLines.length,
    },
    events,
    summary,
    summarySha256: stableTestJsonSha256(summary),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const buffer = readFileSync(file);
  return {
    path: file,
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    rawPath: rawFile,
    rawBytes: rawBuffer.byteLength,
    rawSha256: createHash("sha256").update(rawBuffer).digest("hex"),
    summarySha256: stableTestJsonSha256(summary),
  };
}

function testHandshakeEvidence(input: {
  phase: string;
  role: string;
  agent: string;
  providerKey: string;
  transport: "acp" | "claude-cli";
  command?: string;
  projectId?: string;
  jobId?: string;
  correlationNonce?: string;
  outputPath: string;
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const controlPlane = testControlPlaneEvidence(input);
  const handshake = {
    ok: true,
    mode: "live",
    generator: "scripts/queue-swebench-batch.ts#liveProviderPreflightHandshake",
    sentinelVerified: true,
    phase: input.phase,
    role: input.role,
    agent: input.agent,
    providerKey: input.providerKey,
    transport: input.transport,
    command: input.command || (input.transport === "acp" ? "codex-acp" : "claude"),
    projectId: input.projectId || "cpb-provider-live-preflight",
    jobId: input.jobId || `provider-preflight-${input.role}-${input.agent}-${input.correlationNonce || "a".repeat(32)}`,
    correlationNonce: input.correlationNonce || "a".repeat(32),
    ...controlPlane,
    controlPlaneAudit: testControlPlaneAuditRef(input, controlPlane.controlPlaneEvidence),
    ...input.overrides,
  };
  mkdirSync(path.dirname(input.outputPath), { recursive: true });
  writeFileSync(input.outputPath, `${JSON.stringify(handshake, null, 2)}\n`, "utf8");
  return handshake;
}

function validProviderPreflightEnv() {
  return {
    MIMO_BASE_URL: "https://example.invalid/mimo",
    MIMO_API_KEY: "redacted",
    MIMO_MODEL: "mimo-test-model",
    ZHIPU_BASE_URL: "https://example.invalid/glm",
    ZHIPU_API_KEY: "redacted",
    ZHIPU_MODEL: "glm-test-model",
  };
}

async function writeTestAcpPreflightAudit(auditFile: string, input: {
  agent: string;
  phase: string;
  role: string;
  projectId: string;
  jobId: string;
  correlationNonce: string;
  mcpServers?: Array<Record<string, unknown>>;
}) {
  await mkdir(path.dirname(auditFile), { recursive: true });
  const mcpServers = input.mcpServers || [];
  const launch = {
    ts: "2026-07-20T00:00:00.000Z",
    event: "agent_launch",
    agent: input.agent,
    phase: input.phase,
    role: input.role,
    projectId: input.projectId,
    jobId: input.jobId,
    correlationNonce: input.correlationNonce,
    command: "codex-acp",
    mcpServers,
    mcpServerNames: mcpServers.map((server) => String(server.name || "")).filter(Boolean),
    livePreflightPolicy: {
      terminalPolicy: "deny",
      permissionRequests: "reject",
      webToolsDisabled: true,
      toolPolicy: {
        allow: [],
        deny: [
          "fs/read_text_file",
          "fs/write_text_file",
          "terminal/create",
          "terminal/kill",
          "terminal/output",
          "terminal/release",
          "terminal/wait_for_exit",
        ],
      },
    },
  };
  const sessionRequest = {
    ts: "2026-07-20T00:00:01.000Z",
    event: "session_new_request",
    agent: input.agent,
    phase: input.phase,
    role: input.role,
    projectId: input.projectId,
    jobId: input.jobId,
    correlationNonce: input.correlationNonce,
    mcpServers: [],
    mcpServerNames: [],
  };
  const session = {
    ts: "2026-07-20T00:00:02.000Z",
    event: "session_new",
    agent: input.agent,
    phase: input.phase,
    role: input.role,
    projectId: input.projectId,
    jobId: input.jobId,
    correlationNonce: input.correlationNonce,
    sessionId: "test-session",
    mcpServers: [],
    mcpServerNames: [],
  };
  const promptUsage = {
    ts: "2026-07-20T00:00:03.000Z",
    event: "prompt_usage",
    agent: input.agent,
    phase: input.phase,
    role: input.role,
    projectId: input.projectId,
    jobId: input.jobId,
    correlationNonce: input.correlationNonce,
    sessionId: "test-session",
  };
  const sessionClose = {
    ts: "2026-07-20T00:00:04.000Z",
    event: "session_close",
    agent: input.agent,
    phase: input.phase,
    role: input.role,
    projectId: input.projectId,
    jobId: input.jobId,
    correlationNonce: input.correlationNonce,
    sessionId: "test-session",
  };
  await writeFile(auditFile, `${[launch, sessionRequest, session, promptUsage, sessionClose].map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

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

test("SWE-bench command runner preserves stdin through process-tree cleanup boundary", async () => {
  // This test asserts stdin forwarding while the command is under the
  // process-tree cleanup boundary. The timeout is intentionally not a latency
  // SLO: the full suite runs many real child-process tests concurrently, and a
  // 2s window can be consumed by cold Node startup / scheduler pressure before
  // the child reads stdin.
  const result = await runCommand(process.execPath, [
    "-e",
    "let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => value += chunk); process.stdin.on('end', () => process.stdout.write(value));",
  ], process.cwd(), 30_000, { input: "CPB_PROVIDER_PREFLIGHT_OK" });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "CPB_PROVIDER_PREFLIGHT_OK");
  assert.equal(result.stderr, "");
});

async function withPatchedProcessKill<T>(
  impl: (pid: number, signal?: NodeJS.Signals | number) => true,
  fn: () => Promise<T>,
) {
  const originalKill = process.kill;
  Object.defineProperty(process, "kill", {
    configurable: true,
    value: impl,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "kill", {
      configurable: true,
      value: originalKill,
    });
  }
}

function errno(code: string) {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function testCodeGraphCleanupProof({
  assignmentId = "assignment-one",
  attempt = 1,
  attemptToken = "attempt-token-1",
  entryId = "entry-one",
  projectId = "proj",
  jobId = `job-${assignmentId}`,
  workerId = "w-swebench-01",
  orchestratorEpoch = 1,
  cleanupAttempt = 1,
}: {
  assignmentId?: string;
  attempt?: number;
  attemptToken?: string;
  entryId?: string;
  projectId?: string;
  jobId?: string;
  workerId?: string;
  orchestratorEpoch?: number;
  cleanupAttempt?: number;
} = {}) {
  return {
    generator: "runtime/worker/managed-worker.ts#stopAssignmentCodeGraphRuntime",
    assignmentId,
    attempt,
    attemptToken,
    entryId,
    projectId,
    jobId,
    workerId,
    orchestratorEpoch,
    context: "before_terminal_publication",
    cleanupAttempt,
    ok: true,
    cleanupVerified: true,
    processTreeStopped: true,
    stateRemoved: true,
    statePath: `/tmp/${assignmentId}/.codegraph/daemon.pid`,
    worktreePath: `/tmp/${assignmentId}`,
    startup: {
      ok: true,
      source: "fake_codegraph_daemon",
      pid: 12345,
      processPid: 12345,
      statePath: `/tmp/${assignmentId}/.codegraph/daemon.pid`,
      startedAt: "2026-07-20T00:00:00.000Z",
      readyAt: "2026-07-20T00:00:01.000Z",
    },
    startupSource: "fake_codegraph_daemon",
    pid: 12345,
    processPid: 12345,
    cleanupStartedAt: "2026-07-20T00:00:02.000Z",
    cleanupCompletedAt: "2026-07-20T00:00:03.000Z",
  };
}

function withLiveProviderPreflight(manifestValue: unknown): LooseRecord {
  const manifest = recordValue(manifestValue);
  const agents = {
    ...DEFAULT_PRODUCT_VALIDATION_AGENTS,
    ...recordValue(manifest.agents),
  };
  const routes = [
    { phase: "plan", role: "planner", agent: agents.planner },
    { phase: "execute", role: "executor", agent: agents.executor },
    { phase: "verify", role: "verifier", agent: agents.verifier },
    { phase: "adversarial_verify", role: "adversarial_verifier", agent: agents.adversarial_verifier },
  ];
  return {
    ...manifest,
    agents,
    workerCleanup: {
      workerCleanupEvents: 1,
      forcedKills: 0,
      residualProcesses: 0,
      residualScanOk: true,
      residualScanFailures: [],
      reasons: ["batch_wait_completed"],
      workerIds: ["w-swebench-01"],
      pids: [12345],
      ...recordValue(manifest.workerCleanup),
    },
    providerPreflight: {
      schemaVersion: 1,
      generator: "scripts/queue-swebench-batch.ts#runSweBenchProviderPreflight",
      generatedAt: String(manifest.generatedAt || "2026-07-20T00:00:00.000Z"),
      ok: true,
      violations: [],
      phases: routes.map((route) => {
        const transport = String(route.agent).startsWith("claude-") ? "claude-cli" : "acp";
        const command = transport === "claude-cli" ? "claude" : "codex-acp";
        const artifactRoot = mkdtempSync(path.join(os.tmpdir(), "cpb-test-provider-preflight-"));
        const outputPath = path.join(artifactRoot, `${route.phase}.json`);
        const handshake = testHandshakeEvidence({
          phase: String(route.phase),
          role: String(route.role),
          agent: String(route.agent),
          providerKey: "openai",
          command,
          transport: transport as "acp" | "claude-cli",
          outputPath,
        });
        const outputBuffer = readFileSync(outputPath);
        return {
          ...route,
          providerKey: "openai",
          transport,
          command,
          outputPath,
          outputBytes: outputBuffer.byteLength,
          outputSha256: createHash("sha256").update(outputBuffer).digest("hex"),
          denyRules: ["web_tool_denied", "read_only_mutation_denied", "broad_test_command_denied"],
          handshakeOk: true,
          handshake,
          violations: [],
        };
      }),
    },
  };
}

function buildSweBenchBatchReport(options: Parameters<typeof buildSweBenchBatchReportProduction>[0]) {
  const manifest = withLiveProviderPreflight(options.manifest);
  const evidenceByAssignmentId: Record<string, unknown> = {
    ...recordValue(options.evidenceByAssignmentId),
  };
  const terminalStates = new Map<string, LooseRecord>(
    (Array.isArray(manifest.terminalStates) ? manifest.terminalStates : [])
      .map((state): [string, LooseRecord] => [String(recordValue(state).assignmentId), recordValue(state)]),
  );
  for (const assignment of Array.isArray(manifest.assignments) ? manifest.assignments : []) {
    const assignmentRecord = recordValue(assignment);
    const queued = recordValue(assignmentRecord.queued);
    const assignmentId = String(queued.assignmentId || assignmentRecord.assignmentId || "");
    const terminalState = terminalStates.get(assignmentId);
    if (!assignmentId || terminalState?.status !== "completed") continue;
    assignmentRecord.entryId = String(assignmentRecord.entryId || queued.entryId || `entry-${assignmentId}`);
    assignmentRecord.projectId = String(assignmentRecord.projectId || queued.projectId || terminalState.projectId || "proj");
    assignmentRecord.workerId = String(assignmentRecord.workerId || queued.workerId || terminalState.workerId || "w-swebench-01");
    queued.attempt = Number(queued.attempt || terminalState.attempt || 1);
    queued.attemptToken = String(queued.attemptToken || assignmentRecord.attemptToken || "attempt-token-1");
    queued.orchestratorEpoch = Number(queued.orchestratorEpoch || assignmentRecord.orchestratorEpoch || terminalState.orchestratorEpoch || 1);
    assignmentRecord.queued = queued;
    terminalState.attempt = Number(terminalState.attempt || queued.attempt);
    terminalState.jobId = String(terminalState.jobId || `job-${assignmentId}`);
    terminalState.workerId = String(terminalState.workerId || assignmentRecord.workerId);
    terminalState.orchestratorEpoch = Number(terminalState.orchestratorEpoch || queued.orchestratorEpoch);
    const current = recordValue(evidenceByAssignmentId[assignmentId]);
    const cleanup = recordValue(current.cleanup);
    if (cleanup.codegraph === null || typeof cleanup.codegraph !== "object" || Array.isArray(cleanup.codegraph)) {
      cleanup.codegraph = testCodeGraphCleanupProof({
        assignmentId,
        attempt: Number(queued.attempt),
        attemptToken: String(queued.attemptToken),
        entryId: String(assignmentRecord.entryId),
        projectId: String(assignmentRecord.projectId),
        jobId: String(current.jobId || terminalState.jobId || `job-${assignmentId}`),
        workerId: String(assignmentRecord.workerId),
        orchestratorEpoch: Number(queued.orchestratorEpoch),
      });
      current.cleanup = cleanup;
      current.jobId = recordValue(cleanup.codegraph).jobId;
      evidenceByAssignmentId[assignmentId] = current;
    }
  }
  return buildSweBenchBatchReportProduction({
    ...options,
    manifest,
    evidenceByAssignmentId,
  });
}

function writeSweBenchBatchOutputs(options: Parameters<typeof writeSweBenchBatchOutputsProduction>[0]) {
  return writeSweBenchBatchOutputsProduction({
    ...options,
    manifest: withLiveProviderPreflight(options.manifest),
  });
}

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
    env: validProviderPreflightEnv(),
    handshake: async (input) => testHandshakeEvidence(input),
  });

  assert.equal(result.ok, true);
  assert.equal(result.failureKind, null);
  assert.deepEqual(
    result.phases.map((phase) => recordValue(phase).providerKey),
    ["codex", "claude:glm", "claude:mimo-v2.5pro", "claude:mimo-v2.5pro"],
  );
  assert.deepEqual(
    result.phases.map((phase) => recordValue(phase).transport),
    ["acp", "claude-cli", "claude-cli", "claude-cli"],
  );
  assert.deepEqual(
    result.phases.slice(1).map((phase) => recordValue(phase).command),
    ["claude", "claude", "claude"],
  );
  assert.deepEqual(
    result.phases.map((phase) => recordValue(recordValue(phase).handshake).transport),
    ["acp", "claude-cli", "claude-cli", "claude-cli"],
  );
  assert.deepEqual(
    result.phases.map((phase) => recordValue(phase).handshakeOk),
    [true, true, true, true],
  );
});

test("SWE-bench provider preflight audit reference accepts generation-time output identity omission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-audit-generation-"));
  const input = {
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli" as const,
    command: "claude",
    projectId: "cpb-provider-live-preflight",
    jobId: `provider-preflight-executor-claude-glm-${"b".repeat(32)}`,
    correlationNonce: "b".repeat(32),
    outputPath: path.join(root, "execute.json"),
  };
  const handshake = testHandshakeEvidence(input);

  const result = controlPlaneAuditReferenceValid(
    handshake.controlPlaneAudit,
    handshake.controlPlaneEvidence,
    {
      ...input,
      artifactBaseDir: root,
    },
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.violations, []);
});

test("SWE-bench provider preflight audit retention removes raw artifacts on abort", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-audit-abort-retention-"));
  const outputPath = path.join(root, "preflight", "execute.json");
  const auditFile = path.join(root, "audit-source", "audit.jsonl");
  const correlationNonce = "9".repeat(32);
  const input = {
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli" as const,
    command: "codex-acp",
    args: [],
    correlationNonce,
    projectId: "cpb-provider-live-preflight",
    jobId: `provider-preflight-executor-claude-glm-${correlationNonce}`,
    outputPath,
    env: {},
    denyRules: [],
    artifactBaseDir: path.dirname(outputPath),
  };
  await writeTestAcpPreflightAudit(auditFile, input);
  const auditEvents = (await readFile(auditFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => recordValue(JSON.parse(line)));
  const abort = new AbortController();

  await assert.rejects(
    () => writeControlPlaneAuditArtifact({
      auditFile,
      events: auditEvents,
      input,
      outputPath,
      signal: abort.signal,
      retentionStageHook: (stage) => {
        if (stage === "afterRawArtifactWrite") abort.abort(new DOMException("retention aborted", "AbortError"));
      },
    }),
    /retention aborted|aborted/,
  );

  const rawArtifactPath = path.join(
    path.dirname(outputPath),
    "control-plane-audit",
    `execute-claude-glm-${correlationNonce}.raw.jsonl`,
  );
  const auditArtifactPath = path.join(
    path.dirname(outputPath),
    "control-plane-audit",
    `execute-claude-glm-${correlationNonce}.json`,
  );
  await assert.rejects(() => readFile(rawArtifactPath, "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(auditArtifactPath, "utf8"), /ENOENT/);
});

test("SWE-bench provider preflight audit reference rejects partial post-write output identity", async (t) => {
  const cases: Array<{
    name: string;
    identity: (handshake: Record<string, unknown>, raw: Buffer) => Record<string, unknown>;
  }> = [
    {
      name: "only bytes",
      identity: (_handshake, raw) => ({ outputBytes: raw.byteLength }),
    },
    {
      name: "only hash",
      identity: (_handshake, raw) => ({
        outputSha256: createHash("sha256").update(raw).digest("hex"),
      }),
    },
    {
      name: "only content",
      identity: (handshake) => ({ outputContent: handshake }),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-audit-partial-"));
      const input = {
        phase: "execute",
        role: "executor",
        agent: "claude-glm",
        providerKey: "claude:glm",
        transport: "claude-cli" as const,
        command: "claude",
        projectId: "cpb-provider-live-preflight",
        jobId: `provider-preflight-executor-claude-glm-${"c".repeat(32)}`,
        correlationNonce: "c".repeat(32),
        outputPath: path.join(root, `${fixture.name.replace(/\W+/g, "-")}.json`),
      };
      const handshake = testHandshakeEvidence(input);
      const raw = await readFile(input.outputPath);

      const result = controlPlaneAuditReferenceValid(
        handshake.controlPlaneAudit,
        handshake.controlPlaneEvidence,
        {
          ...input,
          ...fixture.identity(handshake, raw),
          artifactBaseDir: root,
        },
      );

      assert.equal(result.valid, false);
      assert.match(result.violations.join("\n"), /provider preflight output artifact reference binding is invalid/);
    });
  }
});

test("SWE-bench provider preflight audit reference rejects post-write output content mismatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-audit-output-content-"));
  const input = {
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli" as const,
    command: "claude",
    projectId: "cpb-provider-live-preflight",
    jobId: `provider-preflight-executor-claude-glm-${"d".repeat(32)}`,
    correlationNonce: "d".repeat(32),
    outputPath: path.join(root, "execute.json"),
  };
  const handshake = testHandshakeEvidence(input);
  await writeFile(input.outputPath, `${JSON.stringify({ ...handshake, sentinelVerified: false }, null, 2)}\n`, "utf8");
  const raw = await readFile(input.outputPath);

  const result = controlPlaneAuditReferenceValid(
    handshake.controlPlaneAudit,
    handshake.controlPlaneEvidence,
    {
      ...input,
      outputBytes: raw.byteLength,
      outputSha256: createHash("sha256").update(raw).digest("hex"),
      outputContent: handshake,
      artifactBaseDir: root,
    },
  );

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /provider preflight output artifact does not match retained handshake/);
});

test("SWE-bench provider preflight audit reference rejects post-write output bytes or hash tampering", async (t) => {
  const cases: Array<{
    name: string;
    identity: (raw: Buffer, handshake: Record<string, unknown>) => Record<string, unknown>;
  }> = [
    {
      name: "wrong bytes",
      identity: (raw, handshake) => ({
        outputBytes: raw.byteLength + 1,
        outputSha256: createHash("sha256").update(raw).digest("hex"),
        outputContent: handshake,
      }),
    },
    {
      name: "wrong hash",
      identity: (raw, handshake) => ({
        outputBytes: raw.byteLength,
        outputSha256: "0".repeat(64),
        outputContent: handshake,
      }),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-audit-output-tamper-"));
      const input = {
        phase: "execute",
        role: "executor",
        agent: "claude-glm",
        providerKey: "claude:glm",
        transport: "claude-cli" as const,
        command: "claude",
        projectId: "cpb-provider-live-preflight",
        jobId: `provider-preflight-executor-claude-glm-${"e".repeat(32)}`,
        correlationNonce: "e".repeat(32),
        outputPath: path.join(root, `${fixture.name.replace(/\W+/g, "-")}.json`),
      };
      const handshake = testHandshakeEvidence(input);
      const raw = await readFile(input.outputPath);

      const result = controlPlaneAuditReferenceValid(
        handshake.controlPlaneAudit,
        handshake.controlPlaneEvidence,
        {
          ...input,
          ...fixture.identity(raw, handshake),
          artifactBaseDir: root,
        },
      );

      assert.equal(result.valid, false);
      assert.match(result.violations.join("\n"), /provider preflight output artifact bytes or hash do not match/);
    });
  }
});

test("SWE-bench provider preflight audit reference rejects tampered audit artifact content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-audit-artifact-tamper-"));
  const input = {
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli" as const,
    command: "claude",
    projectId: "cpb-provider-live-preflight",
    jobId: `provider-preflight-executor-claude-glm-${"f".repeat(32)}`,
    correlationNonce: "f".repeat(32),
    outputPath: path.join(root, "execute.json"),
  };
  const handshake = testHandshakeEvidence(input);
  const audit = recordValue(handshake.controlPlaneAudit);
  await writeFile(String(audit.path), "{\"tampered\":true}\n", "utf8");

  const result = controlPlaneAuditReferenceValid(
    handshake.controlPlaneAudit,
    handshake.controlPlaneEvidence,
    {
      ...input,
      artifactBaseDir: root,
    },
  );

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /control-plane audit artifact bytes or hash do not match/);
});

test("SWE-bench provider preflight audit reference rejects nonce mutation even with recomputed artifact binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-audit-nonce-tamper-"));
  const input = {
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli" as const,
    command: "claude",
    projectId: "cpb-provider-live-preflight",
    jobId: `provider-preflight-executor-claude-glm-${"1".repeat(32)}`,
    correlationNonce: "1".repeat(32),
    outputPath: path.join(root, "execute.json"),
  };
  const handshake = testHandshakeEvidence(input);
  const audit = recordValue(handshake.controlPlaneAudit);
  const artifact = JSON.parse(await readFile(String(audit.path), "utf8")) as Record<string, unknown>;
  artifact.nonce = "2".repeat(32);
  const mutatedRaw = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(String(audit.path), mutatedRaw);
  audit.bytes = mutatedRaw.byteLength;
  audit.sha256 = createHash("sha256").update(mutatedRaw).digest("hex");

  const result = controlPlaneAuditReferenceValid(
    handshake.controlPlaneAudit,
    handshake.controlPlaneEvidence,
    {
      ...input,
      artifactBaseDir: root,
    },
  );

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /control-plane audit artifact nonce is invalid/);
});

test("SWE-bench provider preflight audit reference rejects tampered raw audit stream content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-raw-audit-tamper-"));
  const input = {
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli" as const,
    command: "claude",
    projectId: "cpb-provider-live-preflight",
    jobId: `provider-preflight-executor-claude-glm-${"g".repeat(32)}`,
    correlationNonce: "g".repeat(32),
    outputPath: path.join(root, "execute.json"),
  };
  const handshake = testHandshakeEvidence(input);
  const audit = recordValue(handshake.controlPlaneAudit);
  await writeFile(String(audit.rawPath), "{\"event\":\"tampered\"}\n", "utf8");

  const result = controlPlaneAuditReferenceValid(
    handshake.controlPlaneAudit,
    handshake.controlPlaneEvidence,
    {
      ...input,
      artifactBaseDir: root,
    },
  );

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /control-plane raw audit stream bytes or hash do not match/);
});

test("SWE-bench provider preflight rejects callback output that differs from retained handshake", async () => {
  const result = await runSweBenchProviderPreflight({
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    env: validProviderPreflightEnv(),
    handshake: async (input) => {
      const handshake = testHandshakeEvidence(input);
      if (input.role === "executor") {
        await writeFile(input.outputPath, `${JSON.stringify({ ...handshake, sentinelVerified: false }, null, 2)}\n`, "utf8");
      }
      return handshake;
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /executor provider claude:glm output artifact does not match retained handshake/);
});

test("SWE-bench provider preflight rejects symlinked callback output artifacts", async () => {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-output-symlink-target-"));
  const result = await runSweBenchProviderPreflight({
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    env: validProviderPreflightEnv(),
    handshake: async (input) => {
      const handshake = testHandshakeEvidence(input);
      if (input.role === "executor") {
        const outsideFile = path.join(outsideRoot, "output.json");
        await writeFile(outsideFile, `${JSON.stringify(handshake, null, 2)}\n`, "utf8");
        await rm(input.outputPath);
        await symlink(outsideFile, input.outputPath);
      }
      return handshake;
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /executor provider claude:glm output artifact is missing, unsafe, or invalid/);
});

test("SWE-bench provider preflight rejects forged control-plane proof", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (handshake: Record<string, unknown>) => Record<string, unknown>;
  }> = [
    {
      name: "missing agent launch",
      mutate: (handshake) => {
        const proof = { ...recordValue(handshake.controlPlaneEvidence), agentLaunchObserved: false };
        return {
          ...handshake,
          controlPlaneEvidence: proof,
          controlPlaneEvidenceSha256: stableTestJsonSha256(proof),
        };
      },
    },
    {
      name: "wrong hash",
      mutate: (handshake) => ({ ...handshake, controlPlaneEvidenceSha256: "0".repeat(64) }),
    },
    {
      name: "non-zero tool count",
      mutate: (handshake) => {
        const proof = { ...recordValue(handshake.controlPlaneEvidence), toolCallCount: 1 };
        return {
          ...handshake,
          controlPlaneEvidence: proof,
          controlPlaneEvidenceSha256: stableTestJsonSha256(proof),
        };
      },
    },
    {
      name: "incomplete policy",
      mutate: (handshake) => {
        const proof = recordValue(handshake.controlPlaneEvidence);
        const policySummary = {
          ...recordValue(proof.policySummary),
          tools: ["Read"],
        };
        const nextProof = { ...proof, policySummary };
        return {
          ...handshake,
          controlPlaneEvidence: nextProof,
          controlPlaneEvidenceSha256: stableTestJsonSha256(nextProof),
        };
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
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
        handshake: async (input) => {
          const handshake = testHandshakeEvidence(input);
          const result = input.role === "executor" ? fixture.mutate(handshake) : handshake;
          writeFileSync(input.outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
          return result;
        },
      });

      assert.equal(result.ok, false);
      assert.match(result.violations.join("\n"), /failed structured handshake|control-plane safety proof/);
    });
  }
});

test("SWE-bench provider preflight rejects a hash-consistent ACP proof with an explicitly allowed tool", async () => {
  const result = await runSweBenchProviderPreflight({
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    env: validProviderPreflightEnv(),
    handshake: async (input) => {
      if (input.role !== "planner") return testHandshakeEvidence(input);
      const baseline = recordValue(testControlPlaneEvidence(input).controlPlaneEvidence);
      const baselinePolicy = recordValue(baseline.policySummary);
      const toolPolicy = recordValue(baselinePolicy.toolPolicy);
      const handshake = testHandshakeEvidence({
        ...input,
        overrides: {
          policySummary: {
            ...baselinePolicy,
            toolPolicy: {
              ...toolPolicy,
              allow: ["mcp__codegraph__codegraph_context"],
            },
          },
        },
      });
      delete handshake.policySummary;
      writeFileSync(input.outputPath, `${JSON.stringify(handshake, null, 2)}\n`, "utf8");
      return handshake;
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /planner provider codex failed structured handshake/);
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
    handshake: async (input) => input.role === "executor"
      ? { ok: false, error: "429 reset at 07:30" }
      : testHandshakeEvidence(input),
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
    handshake: async (input) => input.role === "executor"
      ? { ok: false, failureKind: "agent_rate_limited", error: "429 usage limit reset at 15:30" }
      : testHandshakeEvidence(input),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "agent_rate_limited");
});

test("SWE-bench batch provider preflight redacts secrets from thrown handshake errors", async () => {
  const result = await runSweBenchProviderPreflight({
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    env: {
      MIMO_BASE_URL: "https://example.invalid/mimo",
      MIMO_API_KEY: "configured",
      MIMO_MODEL: "mimo-test-model",
      ZHIPU_BASE_URL: "https://example.invalid/glm",
      ZHIPU_API_KEY: "configured",
      ZHIPU_MODEL: "glm-test-model",
    },
    handshake: async () => {
      throw new Error("Authorization: Bearer ghp_never_persist_this_secret");
    },
  });

  const serialized = JSON.stringify(result);
  assert.equal(result.ok, false);
  assert.doesNotMatch(serialized, /ghp_never_persist_this_secret/);
  assert.match(serialized, /redacted/i);
});

test("SWE-bench batch provider preflight redacts secrets returned by a custom handshake", async () => {
  const secrets = [
    "ghp_returned_secret_must_not_persist",
    "returned-api-key-must-not-persist",
    "returned-bearer-must-not-persist",
    "github_pat_returned_failure_kind_secret",
  ];
  const providerPreflight = await runSweBenchProviderPreflight({
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    env: {
      MIMO_BASE_URL: "https://example.invalid/mimo",
      MIMO_API_KEY: "configured",
      MIMO_MODEL: "mimo-test-model",
      ZHIPU_BASE_URL: "https://example.invalid/glm",
      ZHIPU_API_KEY: "configured",
      ZHIPU_MODEL: "glm-test-model",
    },
    handshake: async (input) => input.role === "executor"
      ? {
          ok: false,
          error: `Authorization: Bearer ${secrets[0]}`,
          reason: `api_key=${secrets[1]}`,
          stderr: `Bearer ${secrets[2]}`,
          failureKind: secrets[3],
        }
      : testHandshakeEvidence(input),
  });
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-20T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 0,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    providerPreflight,
    assignments: [],
    terminalStates: [],
  };
  const report = buildSweBenchBatchReportProduction({ manifest });
  const serialized = JSON.stringify({
    providerPreflight,
    failureMessage: preflightFailureMessage(providerPreflight),
    validation: report.validation,
  });

  assert.equal(providerPreflight.ok, false);
  for (const secret of secrets) assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /redacted/i);
});

test("SWE-bench batch provider preflight never persists agent launch arguments", async () => {
  const commandKey = "CPB_ACP_CODEX_COMMAND";
  const argsKey = "CPB_ACP_CODEX_ARGS";
  const previousCommand = process.env[commandKey];
  const previousArgs = process.env[argsKey];
  const secret = "github_pat_launch_argument_must_not_persist";
  process.env[commandKey] = "codex-acp";
  process.env[argsKey] = `--token ${secret}`;
  try {
    const providerPreflight = await runSweBenchProviderPreflight({
      agents: {
        planner: "codex",
        executor: "codex",
        verifier: "codex",
        adversarial_verifier: "codex",
      },
      env: {},
      handshake: async (input) => testHandshakeEvidence(input),
    });

    const serialized = JSON.stringify(providerPreflight);
    assert.equal(providerPreflight.ok, true);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.ok(providerPreflight.phases.every((phase) => !("args" in phase)));
  } finally {
    if (previousCommand === undefined) delete process.env[commandKey];
    else process.env[commandKey] = previousCommand;
    if (previousArgs === undefined) delete process.env[argsKey];
    else process.env[argsKey] = previousArgs;
  }
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

test("SWE-bench live provider preflight invokes ACP client and records command failures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-command-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
    transport: "claude-cli",
    command: "claude-agent-acp",
    args: [],
    outputPath: path.join(root, "cpb-preflight-output.json"),
    env: {
      CPB_CODEGRAPH_ENABLED: "1",
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
  assert.equal("stdoutTail" in result, false);
  assert.equal("stderrTail" in result, false);
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
  assert.equal(recordValue(calls[0].options.env).CPB_CODEGRAPH_ENABLED, "1");
  assert.equal(recordValue(calls[0].options.env).ZHIPU_MODEL, "glm-test-model");
});

test("SWE-bench provider preflight propagates abort signal and fails closed", async () => {
  const controller = new AbortController();
  let observedSignal = false;
  const result = await runSweBenchProviderPreflight({
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    env: validProviderPreflightEnv(),
    signal: controller.signal,
    handshake: async (input) => {
      observedSignal = input.signal === controller.signal;
      const evidence = testHandshakeEvidence(input);
      controller.abort(new Error("test abort after provider launch"));
      return evidence;
    },
  });

  assert.equal(observedSignal, true);
  assert.equal(result.ok, false);
  assert.equal(recordValue(result.phases[0]).handshakeOk, false);
  assert.equal(recordValue(recordValue(result.phases[0]).handshake).ok, false);
  assert.match(result.violations.join("\n"), /handshake aborted|test abort after provider launch/);
});

test("SWE-bench live provider preflight forwards abort signal to injected runner", async () => {
  const controller = new AbortController();
  const outputPath = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-signal-runner-")), "preflight.json");
  let observedSignal = false;

  const result = await liveProviderPreflightHandshake({
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli",
    command: "claude-agent-acp",
    args: [],
    outputPath,
    env: {},
    denyRules: [],
    signal: controller.signal,
  }, {
    repoRoot: "/repo",
    distRoot: "/dist",
    signal: controller.signal,
    runner: async (_command, _args, _cwd, _timeoutMs, options) => {
      observedSignal = options?.signal === controller.signal;
      return { code: 1, stdout: "", stderr: "runner failed without success evidence" };
    },
  });

  assert.equal(observedSignal, true);
  assert.equal(result.ok, false);
  assert.equal(result.sentinelVerified, false);
});

test("SWE-bench live provider preflight aggregates cleanup failures after retained artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-cleanup-failure-"));
  const outputPath = path.join(root, "output", "execute.json");
  const abort = new AbortController();
  const removeCalls: string[] = [];

  const run = liveProviderPreflightHandshake({
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli",
    command: "claude-agent-acp",
    args: [],
    outputPath,
    env: {},
    denyRules: [],
  }, {
    repoRoot: "/repo",
    distRoot: "/dist",
    timeoutMs: 1234,
    runner: async (_command, _args, _cwd, _timeoutMs, options) => {
      const env = recordValue(recordValue(options).env);
      const auditFile = String(env.CPB_ACP_AUDIT_FILE);
      const correlationNonce = String(env.CPB_PROVIDER_PREFLIGHT_NONCE);
      await writeTestAcpPreflightAudit(auditFile, {
        agent: "claude-glm",
        phase: "execute",
        role: "executor",
        projectId: "cpb-provider-live-preflight",
        jobId: `provider-preflight-executor-claude-glm-${correlationNonce}`,
        correlationNonce,
      });
      return { code: 0, stdout: "CPB_PROVIDER_PREFLIGHT_OK\n", stderr: "" };
    },
    signal: abort.signal,
    stageHook: (stage) => {
      if (stage === "afterOutputWrite") abort.abort(new DOMException("cleanup path abort", "AbortError"));
    },
    remove: async (targetPath) => {
      removeCalls.push(String(targetPath));
      throw new Error(`injected rm failure: ${String(targetPath)}`);
    },
  });

  await assert.rejects(run, (error) => {
    assert.equal(error instanceof AggregateError, true);
    const errors = (error as AggregateError).errors;
    assert.ok(errors.some((item) => String(item).includes("cleanup path abort")));
    assert.ok(errors.filter((item) => String(item).includes("injected rm failure")).length >= 3);
    return true;
  });
  assert.equal(removeCalls.includes(outputPath), true);
  assert.ok(removeCalls.some((target) => target.endsWith(".raw.jsonl")));
  assert.ok(removeCalls.some((target) => target.endsWith(".json")));
  assert.equal(removeCalls.some((target) => target.includes("cpb-provider-live-preflight-audit-")), false);
});

test("SWE-bench live provider preflight preserves a hostile audit-root successor and blocks success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-audit-successor-"));
  const outputPath = path.join(root, "output", "execute.json");
  let auditRoot = "";
  let movedAuditRoot = "";
  let failure: unknown;
  try {
    failure = await _internalWithTemporaryWorkspaceHooks({
      async afterOwnershipValidated({ rootPath }) {
        if (!path.basename(rootPath).startsWith("cpb-provider-live-preflight-audit-")) return;
        auditRoot = rootPath;
        movedAuditRoot = `${rootPath}.owned-by-test`;
        await rename(rootPath, movedAuditRoot);
        await mkdir(rootPath);
        await writeFile(path.join(rootPath, "successor.txt"), "preserve audit successor\n", "utf8");
      },
    }, async () => {
      try {
        await liveProviderPreflightHandshake({
          phase: "execute",
          role: "executor",
          agent: "claude-glm",
          providerKey: "claude:glm",
          transport: "claude-cli",
          command: "claude-agent-acp",
          args: [],
          outputPath,
          env: {},
          denyRules: [],
        }, {
          repoRoot: "/repo",
          distRoot: "/dist",
          runner: async (_command, _args, _cwd, _timeoutMs, options) => {
            const env = recordValue(options?.env);
            await writeTestAcpPreflightAudit(String(env.CPB_ACP_AUDIT_FILE), {
              agent: "claude-glm",
              phase: "execute",
              role: "executor",
              projectId: String(env.CPB_ACP_PROJECT),
              jobId: String(env.CPB_ACP_JOB_ID),
              correlationNonce: String(env.CPB_PROVIDER_PREFLIGHT_NONCE),
            });
            return { code: 0, stdout: "CPB_PROVIDER_PREFLIGHT_OK", stderr: "" };
          },
        });
      } catch (error) {
        return error;
      }
      assert.fail("expected hostile audit-root successor to block preflight success");
    });

    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.code, "TEMPORARY_WORKSPACE_OWNERSHIP_CONFLICT");
    assert.equal(details?.committed, false);
    assert.equal(details?.successorPreserved, true);
    assert.equal(recordValue(failure).cleanupLabel, "provider preflight temporary audit workspace");
    assert.equal(await readFile(path.join(auditRoot, "successor.txt"), "utf8"), "preserve audit successor\n");
    assert.equal(await fileExists(path.join(movedAuditRoot, "audit.jsonl")), true);
    assert.equal(await fileExists(outputPath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (auditRoot) await rm(auditRoot, { recursive: true, force: true });
    if (movedAuditRoot) await rm(movedAuditRoot, { recursive: true, force: true });
  }
});

test("SWE-bench live provider preflight cleans output after non-abort retained artifact failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-output-mismatch-cleanup-"));
  const outputPath = path.join(root, "output", "execute.json");
  let auditRoot: string | null = null;
  let retainedAuditPath: string | null = null;
  let retainedRawPath: string | null = null;

  const run = liveProviderPreflightHandshake({
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli",
    command: "claude-agent-acp",
    args: [],
    outputPath,
    env: {},
    denyRules: [],
  }, {
    repoRoot: "/repo",
    distRoot: "/dist",
    timeoutMs: 1234,
    runner: async (_command, _args, _cwd, _timeoutMs, options) => {
      const env = recordValue(recordValue(options).env);
      const auditFile = String(env.CPB_ACP_AUDIT_FILE);
      auditRoot = path.dirname(auditFile);
      const correlationNonce = String(env.CPB_PROVIDER_PREFLIGHT_NONCE);
      await writeTestAcpPreflightAudit(auditFile, {
        agent: "claude-glm",
        phase: "execute",
        role: "executor",
        projectId: "cpb-provider-live-preflight",
        jobId: `provider-preflight-executor-claude-glm-${correlationNonce}`,
        correlationNonce,
      });
      return { code: 0, stdout: "CPB_PROVIDER_PREFLIGHT_OK\n", stderr: "" };
    },
    stageHook: async (stage) => {
      if (stage === "afterAuditRetention") {
        const files = await readdir(root, { recursive: true });
        retainedAuditPath = files
          .map((file) => path.join(root, String(file)))
          .find((file) => file.endsWith(".json") && !file.endsWith("execute.json")) || null;
        retainedRawPath = files
          .map((file) => path.join(root, String(file)))
          .find((file) => file.endsWith(".raw.jsonl")) || null;
      }
      if (stage === "afterOutputWrite") {
        await writeFile(outputPath, "{\"tampered\":true}\n", "utf8");
      }
    },
  });

  await assert.rejects(run, /provider preflight output artifact does not match retained handshake/);
  assert.equal(await fileExists(outputPath), false);
  assert.equal(retainedAuditPath ? await fileExists(retainedAuditPath) : false, false);
  assert.equal(retainedRawPath ? await fileExists(retainedRawPath) : false, false);
  assert.equal(auditRoot ? await fileExists(path.join(auditRoot, "events.jsonl")) : false, false);
});

test("SWE-bench live provider preflight abort tears down production Claude process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-provider-abort-teardown-"));
  const command = path.join(root, "fake-claude-hang.mjs");
  const pidFile = path.join(root, "pid.txt");
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
`, "utf8");
  await import("node:fs/promises").then(({ chmod }) => chmod(command, 0o755));
  const controller = new AbortController();
  const waitForPid = async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        if (Number.isInteger(pid) && pid > 0) return pid;
      } catch {
        // wait until the fake provider records its pid
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("fake Claude process did not start");
  };
  const outputPath = path.join(root, "preflight.json");
  const run = liveProviderPreflightHandshake({
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli",
    command,
    args: [],
    outputPath,
    env: {
      ZHIPU_BASE_URL: "https://example.invalid/glm",
      ZHIPU_API_KEY: "configured",
      ZHIPU_MODEL: "glm-test-model",
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
    },
    denyRules: ["web_tool_denied", "read_only_mutation_denied", "broad_test_command_denied"],
    signal: controller.signal,
  }, {
    repoRoot: root,
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  const pid = await waitForPid();
  controller.abort(new Error("test abort production provider"));

  await assert.rejects(run, /provider live preflight aborted after probe|test abort production provider/);
  const deadline = Date.now() + 7_500;
  let exited = false;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        exited = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(exited, true, `fake Claude process still alive after abort: ${pid}`);
  assert.equal(await readFile(outputPath).then(() => true, () => false), false);
});

test("SWE-bench production provider preflight aggregates the primary failure with hostile runtime cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-provider-runtime-successor-"));
  const command = path.join(root, "fake-claude-failure.mjs");
  const outputPath = path.join(root, "preflight.json");
  let runtimeRoot = "";
  let movedRuntimeRoot = "";
  let auditQuarantine = "";
  let runtimeAttacked = false;
  let failure: unknown;
  await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {
  // Consume the complete prompt before reporting the provider failure.
}
console.error("provider primary failure marker");
process.exitCode = 23;
`, "utf8");
  await import("node:fs/promises").then(({ chmod }) => chmod(command, 0o755));

  try {
    failure = await _internalWithTemporaryWorkspaceHooks({
      async afterOwnershipValidated({ rootPath, quarantineRoot }) {
        const basename = path.basename(rootPath);
        if (basename.startsWith("cpb-provider-live-preflight-audit-")) {
          auditQuarantine = quarantineRoot;
          return;
        }
        if (runtimeAttacked || !basename.startsWith("cpb-provider-live-preflight-")) return;
        runtimeAttacked = true;
        runtimeRoot = rootPath;
        movedRuntimeRoot = `${rootPath}.owned-by-test`;
        await rename(rootPath, movedRuntimeRoot);
        await mkdir(rootPath);
        await writeFile(path.join(rootPath, "successor.txt"), "preserve runtime successor\n", "utf8");
      },
    }, async () => {
      try {
        await liveProviderPreflightHandshake({
          phase: "execute",
          role: "executor",
          agent: "claude-glm",
          providerKey: "claude:glm",
          transport: "claude-cli",
          command,
          args: [],
          outputPath,
          env: {
            ZHIPU_BASE_URL: "https://example.invalid/glm",
            ZHIPU_API_KEY: "configured",
            ZHIPU_MODEL: "glm-test-model",
            CPB_AGENT_SANDBOX: "off",
            CPB_AGENT_ISOLATE_HOME: "0",
            CPB_CLAUDE_CLI_COMMAND: command,
          },
          denyRules: ["web_tool_denied", "read_only_mutation_denied", "broad_test_command_denied"],
        }, {
          repoRoot: root,
          timeoutMs: 30_000,
        });
      } catch (error) {
        return error;
      }
      assert.fail("expected provider and hostile runtime cleanup to reject");
    });

    assert.equal(failure instanceof AggregateError, true);
    const errors = (failure as AggregateError).errors;
    assert.ok(errors.some((error) => String(error).includes("provider primary failure marker")));
    assert.ok(errors.some((error) => recordValue(error).cleanupLabel === "provider preflight runtime workspace"));
    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.code, "TEMPORARY_WORKSPACE_OWNERSHIP_CONFLICT");
    assert.equal(details?.committed, false);
    assert.equal(details?.successorPreserved, true);
    assert.equal(await readFile(path.join(runtimeRoot, "successor.txt"), "utf8"), "preserve runtime successor\n");
    assert.equal((await lstat(movedRuntimeRoot)).isDirectory(), true);
    assert.equal(await fileExists(outputPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
    if (movedRuntimeRoot) await rm(movedRuntimeRoot, { recursive: true, force: true });
    if (auditQuarantine) await rm(auditQuarantine, { recursive: true, force: true });
  }
});

test("SWE-bench live provider preflight follows production Claude-compatible CLI transport", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-provider-production-transport-"));
  const command = path.join(root, "fake-claude.mjs");
  const capture = path.join(root, "capture.txt");
  await writeFile(command, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
  variant: process.env.CPB_ACP_AGENT_VARIANT || "none",
  args: process.argv.slice(2),
  auditFileExposed: "CPB_ACP_AUDIT_FILE" in process.env,
  auditDerivationExposed: ["CPB_PROJECT_RUNTIME_ROOT", "CPB_ACP_PROJECT", "CPB_ACP_JOB_ID"].some((key) => key in process.env)
}) + "\\n");
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: prompt.includes("CPB_PROVIDER_PREFLIGHT_OK") ? "CPB_PROVIDER_PREFLIGHT_OK" : "wrong prompt",
  session_id: "provider-preflight-session",
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 }
}));
`, "utf8");
  await import("node:fs/promises").then(({ chmod }) => chmod(command, 0o755));

  const cases = [
    {
      agent: "claude-glm",
      providerKey: "claude:glm",
      transport: "claude-cli" as const,
      env: {
        ZHIPU_BASE_URL: "https://example.invalid/glm",
        ZHIPU_API_KEY: "configured",
        ZHIPU_MODEL: "glm-test-model",
        CPB_ACP_CLAUDE_GLM_COMMAND: path.join(root, "must-not-run-glm-acp"),
      },
    },
    {
      agent: "claude-mimo",
      providerKey: "claude:mimo-v2.5pro",
      transport: "claude-cli" as const,
      env: {
        MIMO_BASE_URL: "https://example.invalid/mimo",
        MIMO_API_KEY: "configured",
        MIMO_MODEL: "mimo-test-model",
        CPB_ACP_CLAUDE_MIMO_COMMAND: path.join(root, "must-not-run-mimo-acp"),
      },
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    const result = await liveProviderPreflightHandshake({
      phase: index === 0 ? "execute" : "verify",
      role: index === 0 ? "executor" : "verifier",
      agent: fixture.agent,
      providerKey: fixture.providerKey,
      transport: fixture.transport,
      command,
      args: [],
      outputPath: path.join(root, `preflight-${index}.json`),
      env: {
        ...fixture.env,
        CPB_AGENT_SANDBOX: "off",
        CPB_AGENT_ISOLATE_HOME: "0",
        CPB_CLAUDE_CLI_COMMAND: command,
      },
      denyRules: ["web_tool_denied", "read_only_mutation_denied", "broad_test_command_denied"],
    }, {
      repoRoot: root,
      // This verifies transport selection, not a five-second latency SLO. The
      // full suite intentionally saturates child-process capacity, while the
      // production preflight budget is 120 seconds.
      timeoutMs: 30_000,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sentinelVerified, true);
  }

  const captures = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(captures.map((item) => item.variant), ["glm", "mimo-v2.5pro"]);
  for (const item of captures) {
    assert.equal(item.args[item.args.indexOf("--tools") + 1], "");
    assert.equal(item.args.includes("--settings"), true);
    assert.equal(item.args.includes("--strict-mcp-config"), true);
    assert.equal(item.args.includes("--disable-slash-commands"), true);
    assert.equal(item.auditFileExposed, false);
    assert.equal(item.auditDerivationExposed, false);
  }
});

test("SWE-bench live provider preflight default timeout covers Codex ACP cold start", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-default-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT_TIMEOUT_MS;
  delete process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT_TIMEOUT_MS;
  const calls: Array<{ timeoutMs: number | undefined }> = [];
  try {
    const result = await liveProviderPreflightHandshake({
      phase: "plan",
      role: "planner",
      agent: "codex",
      providerKey: "codex",
      transport: "acp",
      command: "codex-acp",
      args: [],
      outputPath: path.join(root, "cpb-preflight-output.json"),
      env: {},
      denyRules: [],
    }, {
      repoRoot: "/repo",
      distRoot: "/dist",
      runner: async (_command, _args, _cwd, timeoutMs, options) => {
        calls.push({ timeoutMs });
        const env = recordValue(options?.env);
        await writeTestAcpPreflightAudit(String(env.CPB_ACP_AUDIT_FILE), {
          agent: "codex",
          phase: "plan",
          role: "planner",
          projectId: String(env.CPB_ACP_PROJECT),
          jobId: String(env.CPB_ACP_JOB_ID),
          correlationNonce: String(env.CPB_PROVIDER_PREFLIGHT_NONCE),
        });
        return { code: 0, stdout: "CPB_PROVIDER_PREFLIGHT_OK", stderr: "" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.generator, "scripts/queue-swebench-batch.ts#liveProviderPreflightHandshake");
    assert.equal(result.sentinelVerified, true);
    assert.equal(recordValue(result.controlPlaneEvidence).agentLaunchObserved, true);
    assert.equal(result.controlPlaneEvidenceSha256, stableTestJsonSha256(result.controlPlaneEvidence));
    assert.equal("stdout" in result, false);
    assert.equal("stderr" in result, false);
    assert.equal(calls[0].timeoutMs, 120_000);
  } finally {
    if (previous === undefined) {
      delete process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT_TIMEOUT_MS;
    } else {
      process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT_TIMEOUT_MS = previous;
    }
  }
});

test("SWE-bench live provider preflight accepts redacted Codex ACP MCP launch metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-provider-live-mcp-surface-"));
  const outputPath = path.join(root, "preflight.json");
  const result = await liveProviderPreflightHandshake({
    phase: "plan",
    role: "planner",
    agent: "codex",
    providerKey: "codex",
    transport: "acp",
    command: "codex-acp",
    args: [],
    outputPath,
    env: {},
    denyRules: [],
  }, {
    repoRoot: root,
    distRoot: "/dist",
    runner: async (_command, _args, _cwd, _timeoutMs, options) => {
      const env = recordValue(options?.env);
      await writeTestAcpPreflightAudit(String(env.CPB_ACP_AUDIT_FILE), {
        agent: "codex",
        phase: "plan",
        role: "planner",
        projectId: String(env.CPB_ACP_PROJECT),
        jobId: String(env.CPB_ACP_JOB_ID),
        correlationNonce: String(env.CPB_PROVIDER_PREFLIGHT_NONCE),
        mcpServers: [{ name: "codegraph", command: "codegraph" }],
      });
      return { code: 0, stdout: "CPB_PROVIDER_PREFLIGHT_OK", stderr: "" };
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
});

test("SWE-bench live provider preflight rejects incorrect sentinel output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-wrong-sentinel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await liveProviderPreflightHandshake({
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli",
    command: "claude-agent-acp",
    args: [],
    outputPath: path.join(root, "cpb-preflight-output-wrong-sentinel.json"),
    env: {},
    denyRules: [],
  }, {
    repoRoot: "/repo",
    distRoot: "/dist",
    runner: async () => ({ code: 0, stdout: "CPB_PROVIDER_PREFLIGHT_OK extra", stderr: "" }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "live");
  assert.match(String(result.error), /unexpected preflight sentinel/);
  assert.doesNotMatch(String(result.error), /stdout/);
});

test("SWE-bench live provider preflight redacts sensitive stderr", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-preflight-redaction-test-"));
  const outputPath = path.join(root, "preflight.json");
  const result = await liveProviderPreflightHandshake({
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    providerKey: "claude:glm",
    transport: "claude-cli",
    command: "claude-agent-acp",
    args: [],
    outputPath,
    env: {},
    denyRules: [],
  }, {
    repoRoot: "/repo",
    distRoot: "/dist",
    runner: async () => ({
      code: 1,
      stdout: "ignored",
      stderr: "Authorization: Bearer super-secret-token\nZHIPU_API_KEY=sk-live-secret",
    }),
  });
  const persisted = await readFile(outputPath, "utf8");

  assert.equal(result.ok, false);
  assert.match(String(result.error), /redacted/);
  assert.doesNotMatch(JSON.stringify(result), /super-secret-token|sk-live-secret|ZHIPU_API_KEY/);
  assert.doesNotMatch(persisted, /super-secret-token|sk-live-secret|ZHIPU_API_KEY/);
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
  assert.equal(sourceProductValidation.adversarialRequired, true);
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
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", failureKind: "provider_unavailable" },
      { assignmentId: "assignment-two", status: "failed", failureKind: "provider_unavailable" },
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
      residualScanOk: true,
      residualScanFailures: [],
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

test("SWE-bench batch report rejects an unverified residual process scan", () => {
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
      forcedKills: 0,
      residualProcesses: 0,
      residualScanOk: false,
      residualScanFailures: ["scoped_residual_scan_failed"],
      workerIds: ["w-swebench-01"],
      pids: [12345],
      reasons: ["batch_wait_completed"],
    },
    assignments: [{
      record: firstRecord,
      queued: { assignmentId: "assignment-one", attempt: 1 },
    }],
  };

  const report = buildSweBenchBatchReport({ manifest });

  assert.equal(recordValue(report.summary).residualScanOk, false);
  assert.equal(recordValue(report.validation).valid, false);
  assert.match(String(recordValue(report.validation).violations), /residual process scan failed/);
});

test("SWE-bench batch validation uses source worker cleanup when report cleanup is omitted", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = withLiveProviderPreflight({
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
      forcedKills: 0,
      residualProcesses: 0,
      residualScanOk: false,
      residualScanFailures: ["scoped_residual_scan_failed"],
      workerIds: ["w-swebench-01"],
      pids: [12345],
      reasons: ["batch_wait_completed"],
    },
    assignments: [{
      record: firstRecord,
      queued: { assignmentId: "assignment-one", attempt: 1 },
    }],
  });
  const report = buildSweBenchBatchReportProduction({ manifest });
  const reportManifest = recordValue(report.manifest);
  delete reportManifest.workerCleanup;

  const validation = validateSweBenchBatchReport({ manifest, report });

  assert.equal(validation.valid, false);
  assert.match(validation.violations.join("\n"), /residual process scan failed/);
  assert.match(validation.violations.join("\n"), /worker cleanup copy is inconsistent/);
});

test("SWE-bench batch validation uses source worker cleanup when report cleanup is flipped", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = withLiveProviderPreflight({
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
      forcedKills: 0,
      residualProcesses: 0,
      residualScanOk: false,
      residualScanFailures: ["scoped_residual_scan_failed"],
      workerIds: ["w-swebench-01"],
      pids: [12345],
      reasons: ["batch_wait_completed"],
    },
    assignments: [{
      record: firstRecord,
      queued: { assignmentId: "assignment-one", attempt: 1 },
    }],
  });
  const report = buildSweBenchBatchReportProduction({ manifest });
  const reportManifest = recordValue(report.manifest);
  reportManifest.workerCleanup = {
    ...recordValue(reportManifest.workerCleanup),
    residualScanOk: true,
    residualScanFailures: [],
  };

  const validation = validateSweBenchBatchReport({ manifest, report });

  assert.equal(validation.valid, false);
  assert.match(validation.violations.join("\n"), /residual process scan failed/);
  assert.match(validation.violations.join("\n"), /worker cleanup copy is inconsistent/);
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

test("SWE-bench scoped residual discovery excludes the queue process and its ancestors", () => {
  const scopeRoot = "/private/tmp/cpb-live-release-provider-test";
  const processTable = [
    "1 0 /sbin/launchd",
    `100 1 /bin/sh -c npm run queue:swebench-batch -- --hub-root ${scopeRoot}/hub`,
    `200 100 npm run queue:swebench-batch -- --source-root ${scopeRoot}/sources`,
    `300 200 node scripts/queue-swebench-batch.js --cpb-root ${scopeRoot}/cpb`,
    `400 300 node dist/runtime/worker/managed-worker.js --hub-root ${scopeRoot}/hub`,
    `401 400 codegraph serve --repo ${scopeRoot}/sources/astropy`,
    `500 1 codegraph serve --repo ${scopeRoot}/hub/worktrees/orphan`,
    "600 1 node unrelated.js /private/tmp/another-run",
    "",
  ].join("\n");

  assert.deepEqual(
    scopedProcessPids([scopeRoot], { currentPid: 300, processTable }),
    [400, 401, 500],
  );
});

test("SWE-bench batch queue stops started workers before writing final report", async () => {
  const identity = testProcessIdentity(12345);
  const liveIncarnations = new Set([identity.incarnation]);
  const kills: Array<{ pid: number; expected: unknown }> = [];

  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: identity },
  ], {
    reason: "test-cleanup",
    graceMs: 0,
    discoverResidualPids: () => [],
    identityAlive: (candidate) => liveIncarnations.has(candidate.incarnation),
    killTreeFn: async (pid, _graceMs, options) => {
      kills.push({ pid, expected: options?.expectedRootIdentity });
      liveIncarnations.delete(identity.incarnation);
    },
  });

  assert.deepEqual(kills, [{ pid: 12345, expected: identity }]);
  assert.equal(cleanup.workerCleanupEvents, 1);
  assert.equal(cleanup.forcedKills, 1);
  assert.equal(cleanup.residualProcesses, 0);
  assert.equal(cleanup.residualScanOk, true);
  assert.deepEqual(cleanup.workerIds, ["w-swebench-01"]);
});

test("SWE-bench batch cleanup tracks and kills detached descendants", async () => {
  const rootIdentity = testProcessIdentity(12345, "root");
  const firstDescendant = testProcessIdentity(12346, "first-descendant");
  const lateDescendant = testProcessIdentity(12347, "late-descendant");
  const liveIncarnations = new Set([
    rootIdentity.incarnation,
    firstDescendant.incarnation,
    lateDescendant.incarnation,
  ]);
  const kills: number[] = [];
  let scopedScan = 0;

  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: rootIdentity },
  ], {
    reason: "test-descendant-cleanup",
    graceMs: 0,
    discoverResidualPids: () => {
      scopedScan += 1;
      if (scopedScan === 1) return [firstDescendant];
      if (scopedScan === 2) return [lateDescendant];
      return [];
    },
    identityAlive: (identity) => liveIncarnations.has(identity.incarnation),
    killTreeFn: async (pid, _graceMs, options) => {
      assert.equal(options?.expectedRootIdentity?.pid, pid);
      kills.push(pid);
      liveIncarnations.delete(String(options?.expectedRootIdentity?.incarnation));
    },
  });

  assert.deepEqual(kills, [12345, 12346, 12347]);
  assert.deepEqual(cleanup.pids, [12345, 12346, 12347]);
  assert.equal(cleanup.forcedKills, 3);
  assert.equal(cleanup.residualProcesses, 0);
  assert.equal(cleanup.residualScanOk, true);
});

test("SWE-bench batch cleanup captures an incarnation before acting on a numeric scoped residual", async () => {
  const workerIdentity = testProcessIdentity(12345, "worker");
  const residualIdentity = testProcessIdentity(22345, "scoped-residual");
  const alive = new Set([residualIdentity.incarnation]);
  const captured: number[] = [];
  const killed: ProcessIdentity[] = [];
  let scans = 0;

  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: workerIdentity },
  ], {
    graceMs: 0,
    discoverResidualPids: () => (++scans === 1 ? [residualIdentity.pid] : []),
    captureIdentity: (pid) => {
      captured.push(pid);
      return pid === residualIdentity.pid ? residualIdentity : null;
    },
    identityAlive: (identity) => alive.has(identity.incarnation),
    killTreeFn: async (_pid, _graceMs, options) => {
      const expected = options?.expectedRootIdentity;
      if (!expected) throw new Error("missing expected root identity");
      killed.push(expected);
      alive.delete(expected.incarnation);
    },
  });

  assert.deepEqual(captured, [residualIdentity.pid]);
  assert.deepEqual(killed, [residualIdentity]);
  assert.equal(cleanup.residualScanOk, true);
  assert.equal(cleanup.residualProcesses, 0);
});

test("SWE-bench batch cleanup fails closed when residual discovery cannot run", async () => {
  const identity = testProcessIdentity(12345);
  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: identity },
  ], {
    graceMs: 0,
    identityAlive: () => false,
    discoverResidualPids: () => {
      throw new Error("process table unavailable");
    },
  });

  assert.equal(cleanup.residualProcesses, 0);
  assert.equal(cleanup.residualScanOk, false);
  assert.deepEqual(cleanup.residualScanFailures, ["scoped_residual_scan_failed"]);
});

test("SWE-bench batch cleanup never reports a verified residual scan when no scanner is configured", async () => {
  const identity = testProcessIdentity(12345);
  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: identity },
  ], {
    graceMs: 0,
    identityAlive: () => false,
  });

  assert.equal(cleanup.residualProcesses, 0);
  assert.equal(cleanup.residualScanOk, false);
  assert.deepEqual(cleanup.residualScanFailures, ["scoped_residual_scan_unconfigured"]);
});

test("SWE-bench batch cleanup refuses bare-PID teardown when spawn identity is unavailable", async () => {
  let killCalls = 0;
  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: null },
  ], {
    graceMs: 0,
    discoverResidualPids: () => [],
    killTreeFn: async () => { killCalls += 1; },
  });

  assert.equal(killCalls, 0);
  assert.equal(cleanup.residualProcesses, 1);
  assert.equal(cleanup.residualScanOk, false);
  assert.deepEqual(cleanup.residualScanFailures, ["process_identity_unavailable"]);
});

test("SWE-bench batch cleanup never re-owns an unowned spawn PID during residual discovery", async () => {
  let captureCalls = 0;
  let killCalls = 0;
  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: null },
  ], {
    graceMs: 0,
    discoverResidualPids: () => [12345],
    captureIdentity: () => {
      captureCalls += 1;
      return testProcessIdentity(12345, "later-observation");
    },
    killTreeFn: async () => { killCalls += 1; },
  });

  assert.equal(captureCalls, 0);
  assert.equal(killCalls, 0);
  assert.equal(cleanup.residualProcesses, 1);
  assert.equal(cleanup.residualScanOk, false);
  assert.deepEqual(
    cleanup.residualScanFailures,
    ["process_identity_unavailable", "residual_spawn_identity_unowned"],
  );
});

test("SWE-bench batch cleanup refuses persisted coarse process identities", async () => {
  let killCalls = 0;
  const coarseIdentity = {
    ...testProcessIdentity(12345, "coarse-start"),
    birthIdPrecision: "coarse" as const,
    processGroupId: 12345,
  };
  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: coarseIdentity },
  ], {
    graceMs: 0,
    discoverResidualPids: () => [],
    killTreeFn: async () => { killCalls += 1; },
  });

  assert.equal(killCalls, 0);
  assert.equal(cleanup.residualProcesses, 1);
  assert.equal(cleanup.residualScanOk, false);
  assert.deepEqual(cleanup.residualScanFailures, ["process_identity_invalid"]);
});

test("SWE-bench batch cleanup refuses process identities without explicit exact precision", async () => {
  let killCalls = 0;
  const { birthIdPrecision: _precision, ...unmarkedIdentity } = testProcessIdentity(12345, "unmarked-start");
  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: unmarkedIdentity },
  ], {
    graceMs: 0,
    discoverResidualPids: () => [],
    killTreeFn: async () => { killCalls += 1; },
  });

  assert.equal(killCalls, 0);
  assert.equal(cleanup.residualProcesses, 1);
  assert.equal(cleanup.residualScanOk, false);
  assert.deepEqual(cleanup.residualScanFailures, ["process_identity_invalid"]);
});

test("SWE-bench batch cleanup refuses non-canonical process incarnations", async () => {
  let killCalls = 0;
  const invalidIdentity = {
    ...testProcessIdentity(12345, "original"),
    incarnation: "12345:successor",
    processGroupId: 12345,
  };
  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: invalidIdentity },
  ], {
    graceMs: 0,
    discoverResidualPids: () => [],
    killTreeFn: async () => { killCalls += 1; },
  });

  assert.equal(killCalls, 0);
  assert.equal(cleanup.residualProcesses, 1);
  assert.equal(cleanup.residualScanOk, false);
  assert.deepEqual(cleanup.residualScanFailures, ["process_identity_invalid"]);
});

test("SWE-bench batch cleanup refuses unsafe or noncanonical exact identities", async () => {
  for (const [expectedFailure, invalidIdentity] of [
    ["process_identity_invalid", { ...testProcessIdentity(12345, "noncanonical-time"), capturedAt: "2026-07-21T00:00:00Z" }],
    ["process_identity_invalid", { ...testProcessIdentity(12345, "unsafe-group"), processGroupId: Number.MAX_SAFE_INTEGER + 1 }],
    ["worker_pid_invalid", {
      ...testProcessIdentity(12345, "unsafe-pid"),
      pid: Number.MAX_SAFE_INTEGER + 1,
      incarnation: `${Number.MAX_SAFE_INTEGER + 1}:unsafe-pid`,
    }],
  ] as const) {
    let killCalls = 0;
    const cleanup = await stopStartedWorkers([
      { workerId: "w-swebench-unsafe", pid: invalidIdentity.pid, processIdentity: invalidIdentity },
    ], {
      graceMs: 0,
      discoverResidualPids: () => [],
      killTreeFn: async () => { killCalls += 1; },
    });
    assert.equal(killCalls, 0);
    assert.equal(cleanup.residualScanOk, false);
    assert.deepEqual(cleanup.residualScanFailures, [expectedFailure]);
  }
});

test("SWE-bench batch cleanup fences PID reuse with the expected root incarnation", async () => {
  const original = testProcessIdentity(12345, "original");
  const successor = testProcessIdentity(12345, "successor");
  const expected: unknown[] = [];
  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: original },
  ], {
    graceMs: 0,
    discoverResidualPids: () => [],
    identityAlive: (identity) => identity.incarnation === original.incarnation,
    killTreeFn: async (_pid, _graceMs, options) => {
      expected.push(options?.expectedRootIdentity);
      assert.notEqual(options?.expectedRootIdentity?.incarnation, successor.incarnation);
      throw Object.assign(new Error("pid now belongs to successor"), { code: "PROCESS_IDENTITY_MISMATCH" });
    },
  });

  assert.deepEqual(expected, [original]);
  assert.equal(cleanup.residualScanOk, false);
  assert.deepEqual(cleanup.residualScanFailures, ["identity_cleanup_process_identity_mismatch"]);
});

test("SWE-bench batch cleanup preserves identity liveness probe failures", async () => {
  const identity = testProcessIdentity(12345);
  const cleanup = await stopStartedWorkers([
    { workerId: "w-swebench-01", pid: 12345, processIdentity: identity },
  ], {
    graceMs: 0,
    discoverResidualPids: () => [],
    identityAlive: () => { throw errno("EPERM"); },
    killTreeFn: async () => {},
  });

  assert.equal(cleanup.residualScanOk, false);
  assert.equal(cleanup.residualScanFailures.includes("process_identity_liveness_failed"), true);
  assert.ok(cleanup.residualProcesses > 0);
});

function testProcessIdentity(pid: number, birthId = `test-${pid}`) {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-07-21T00:00:00.000Z",
    birthIdPrecision: "exact" as const,
    processGroupId: pid,
  };
}

function quotaReceiptFor(
  hubRoot: string,
  expected: ProcessIdentity | QuotaDelegateLockReceipt,
): QuotaDelegateLockReceipt {
  if ("processIdentity" in expected) return expected;
  return {
    pid: expected.pid,
    hubRoot,
    startedAt: "2026-07-21T00:00:00.000Z",
    ownerToken: "test-owner",
    generation: `test-generation-${expected.pid}`,
    processIdentity: expected,
    incarnation: expected.incarnation,
  };
}

function verifiedQuotaCleanup(worker: { workerId: string; pid: number | null; processIdentity: ProcessIdentity | null }) {
  return {
    workerCleanupEvents: 1,
    forcedKills: 0,
    residualProcesses: 0,
    residualScanOk: true,
    residualScanFailures: [],
    reasons: ["quota_delegate_start_failed"],
    workerIds: [worker.workerId],
    pids: worker.pid ? [worker.pid] : [],
  };
}

test("SWE-bench queue abort preserves an Error reason, cause, and code", async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error("operator cancelled queue startup"), { code: "OPERATOR_CANCELLED" });
  controller.abort(reason);
  let spawned = false;

  await assert.rejects(startQuotaDelegate({
    hubRoot: "/tmp/cpb-hub-pre-abort",
    cpbRoot: "/tmp/cpb-root-pre-abort",
    signal: controller.signal,
    spawnImpl: () => {
      spawned = true;
      return { pid: 24679 };
    },
  }), (error) => {
    assert.equal((error as Error).name, "AbortError");
    assert.equal((error as Error).message, reason.message);
    assert.equal(recordValue(error).code, reason.code);
    assert.equal(recordValue(error).cause, reason);
    assert.equal(recordValue(error).reason, reason);
    return true;
  });
  assert.equal(spawned, false);
});

test("SWE-bench quota delegate startup fails closed when the spawned incarnation cannot be captured", async () => {
  let waited = false;
  let stoppedIdentity: ProcessIdentity | null | undefined;

  await assert.rejects(startQuotaDelegate({
    hubRoot: "/tmp/cpb-hub-missing-incarnation",
    cpbRoot: "/tmp/cpb-root-missing-incarnation",
    ownerToken: "quota-owner-missing-incarnation",
    isDelegateAliveFn: async () => false,
    captureProcessIdentityFn: () => null,
    waitForDelegateIncarnationFn: async () => {
      waited = true;
      return null;
    },
    spawnImpl: () => ({ pid: 24678, unref: () => {} }),
    stopSpawnedFn: async (worker) => {
      stoppedIdentity = worker.processIdentity;
      return verifiedQuotaCleanup(worker);
    },
  }), (error) => {
    assert.equal(recordValue(error).code, "QUOTA_DELEGATE_PROCESS_IDENTITY_UNAVAILABLE");
    return true;
  });

  assert.equal(waited, false);
  assert.equal(stoppedIdentity, null);
});

test("SWE-bench quota delegate rejects coarse and unmarked identities before readiness", async () => {
  for (const [label, identity] of [
    ["coarse", { ...testProcessIdentity(24677), birthIdPrecision: "coarse" as const }],
    ["unmarked", (() => {
      const { birthIdPrecision: _precision, ...unmarked } = testProcessIdentity(24677);
      return unmarked;
    })()],
  ] as const) {
    let waited = false;
    let stoppedIdentity: ProcessIdentity | null | undefined;
    await assert.rejects(startQuotaDelegate({
      hubRoot: `/tmp/cpb-hub-${label}-incarnation`,
      cpbRoot: `/tmp/cpb-root-${label}-incarnation`,
      ownerToken: `quota-owner-${label}-incarnation`,
      isDelegateAliveFn: async () => false,
      captureProcessIdentityFn: () => identity as ProcessIdentity,
      waitForDelegateIncarnationFn: async () => {
        waited = true;
        return null;
      },
      spawnImpl: () => ({ pid: 24677, unref: () => {} }),
      stopSpawnedFn: async (worker) => {
        stoppedIdentity = worker.processIdentity;
        return verifiedQuotaCleanup(worker);
      },
    }), (error) => {
      assert.equal(recordValue(error).code, "QUOTA_DELEGATE_PROCESS_IDENTITY_UNAVAILABLE");
      return true;
    });
    assert.equal(waited, false);
    assert.equal(stoppedIdentity, null);
  }
});

test("SWE-bench batch queue starts quota delegate before managed workers", async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown>; unref?: boolean }> = [];
  let readinessExpected: ProcessIdentity | QuotaDelegateLockReceipt | null = null;

  const started = await startQuotaDelegate({
    hubRoot: "/tmp/cpb-hub",
    cpbRoot: "/tmp/cpb-root",
    repoRoot: "/repo",
    distRoot: "/dist",
    readyPollMs: 0,
    readyTimeoutMs: 100,
    ownerToken: "quota-owner-24680",
    isDelegateAliveFn: async () => false,
    captureProcessIdentityFn: (pid) => testProcessIdentity(pid),
    waitForDelegateIncarnationFn: async (readyHubRoot, expected) => {
      readinessExpected = expected;
      return quotaReceiptFor(readyHubRoot, expected);
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
  assert.deepEqual(started?.processIdentity, testProcessIdentity(24680));
  assert.equal(started?.ownerToken, "quota-owner-24680");
  assert.equal((readinessExpected as QuotaDelegateLockReceipt).ownerToken, "quota-owner-24680");
  assert.deepEqual((readinessExpected as QuotaDelegateLockReceipt).processIdentity, testProcessIdentity(24680));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    "/dist/server/services/quota-delegate.js",
    "--hub-root",
    "/tmp/cpb-hub",
    "--owner-token",
    "quota-owner-24680",
  ]);
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(recordValue(calls[0].options.env).CPB_HUB_ROOT, "/tmp/cpb-hub");
  assert.equal(recordValue(calls[0].options.env).CPB_ROOT, "/tmp/cpb-root");
  assert.equal(recordValue(calls[0].options.env).CPB_DELEGATE_OWNER_TOKEN, "quota-owner-24680");
  assert.equal(calls[0].unref, true);
});

test("SWE-bench quota delegate startup abort cleans the spawned process before rejecting", async () => {
  const controller = new AbortController();
  const stopped: Array<{ workerId: string; pid: number | null; processIdentity: ProcessIdentity | null; ownerToken?: string }> = [];

  await assert.rejects(
    startQuotaDelegate({
      hubRoot: "/tmp/cpb-hub-abort",
      cpbRoot: "/tmp/cpb-root-abort",
      repoRoot: "/repo",
      distRoot: "/dist",
      readyPollMs: 10_000,
      readyTimeoutMs: 20_000,
      signal: controller.signal,
      ownerToken: "quota-owner-24681",
      isDelegateAliveFn: async () => false,
      captureProcessIdentityFn: (pid) => testProcessIdentity(pid),
      waitForDelegateIncarnationFn: async () => {
        controller.abort(new Error("abort delegate readiness"));
        return null;
      },
      spawnImpl: () => ({ pid: 24681, unref: () => {} }),
      stopSpawnedFn: async (worker) => {
        stopped.push(worker);
        return verifiedQuotaCleanup(worker);
      },
    }),
    /abort delegate readiness/,
  );

  assert.deepEqual(stopped, [{
    workerId: "quota-delegate",
    pid: 24681,
    processIdentity: testProcessIdentity(24681),
    ownerToken: "quota-owner-24681",
  }]);
});

test("SWE-bench quota delegate handles asynchronous child spawn errors and cleans the child", async () => {
  const spawnFailure = Object.assign(new Error("async spawn failed"), { code: "ENOENT" });
  const stopped: Array<{ workerId: string; pid: number | null; processIdentity: ProcessIdentity | null; ownerToken?: string }> = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();

  await assert.rejects(
    startQuotaDelegate({
      hubRoot: "/tmp/cpb-hub-spawn-error",
      cpbRoot: "/tmp/cpb-root-spawn-error",
      repoRoot: "/repo",
      distRoot: "/dist",
      readyPollMs: 10_000,
      readyTimeoutMs: 20_000,
      ownerToken: "quota-owner-24682",
      isDelegateAliveFn: async () => false,
      captureProcessIdentityFn: (pid) => testProcessIdentity(pid),
      waitForDelegateIncarnationFn: async () => null,
      spawnImpl: () => {
        const child = {
          pid: 24682,
          once(event: "error" | "close", listener: (...args: unknown[]) => void) {
            listeners.set(event, listener);
            return child;
          },
          unref() {
            setImmediate(() => listeners.get("error")?.(spawnFailure));
          },
        };
        return child;
      },
      stopSpawnedFn: async (worker) => {
        stopped.push(worker);
        return verifiedQuotaCleanup(worker);
      },
    }),
    (error) => error === spawnFailure,
  );

  assert.deepEqual(stopped, [{
    workerId: "quota-delegate",
    pid: 24682,
    processIdentity: testProcessIdentity(24682),
    ownerToken: "quota-owner-24682",
  }]);
});

test("SWE-bench quota delegate rejects an early child close before readiness", async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let stopped = 0;

  await assert.rejects(
    startQuotaDelegate({
      hubRoot: "/tmp/cpb-hub-early-close",
      cpbRoot: "/tmp/cpb-root-early-close",
      repoRoot: "/repo",
      distRoot: "/dist",
      readyPollMs: 10_000,
      readyTimeoutMs: 20_000,
      ownerToken: "quota-owner-24685",
      isDelegateAliveFn: async () => false,
      captureProcessIdentityFn: (pid) => testProcessIdentity(pid),
      waitForDelegateIncarnationFn: async () => null,
      spawnImpl: () => {
        const child = {
          pid: 24685,
          once(event: "error" | "close", listener: (...args: unknown[]) => void) {
            listeners.set(event, listener);
            return child;
          },
          unref() {
            setImmediate(() => listeners.get("close")?.(17, "SIGTERM"));
          },
        };
        return child;
      },
      stopSpawnedFn: async (worker) => {
        stopped += 1;
        return verifiedQuotaCleanup(worker);
      },
    }),
    (error) => {
      assert.equal(recordValue(error).code, "QUOTA_DELEGATE_EARLY_EXIT");
      assert.match((error as Error).message, /code=17, signal=SIGTERM/);
      return true;
    },
  );
  assert.equal(stopped, 1);
});

test("SWE-bench quota delegate aggregates the primary spawn error with cleanup failure", async () => {
  const spawnFailure = Object.assign(new Error("async spawn failed"), { code: "EACCES" });
  const cleanupFailure = new Error("spawned delegate cleanup failed");
  const listeners = new Map<string, (...args: unknown[]) => void>();

  await assert.rejects(
    startQuotaDelegate({
      hubRoot: "/tmp/cpb-hub-spawn-cleanup-error",
      cpbRoot: "/tmp/cpb-root-spawn-cleanup-error",
      repoRoot: "/repo",
      distRoot: "/dist",
      readyPollMs: 10_000,
      readyTimeoutMs: 20_000,
      ownerToken: "quota-owner-24683",
      isDelegateAliveFn: async () => false,
      captureProcessIdentityFn: (pid) => testProcessIdentity(pid),
      waitForDelegateIncarnationFn: async () => null,
      spawnImpl: () => {
        const child = {
          pid: 24683,
          once(event: "error" | "close", listener: (...args: unknown[]) => void) {
            listeners.set(event, listener);
            return child;
          },
          unref() {
            setImmediate(() => listeners.get("error")?.(spawnFailure));
          },
        };
        return child;
      },
      stopSpawnedFn: async () => { throw cleanupFailure; },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual((error as AggregateError).errors, [spawnFailure, cleanupFailure]);
      assert.equal((error as AggregateError & { cause?: unknown }).cause, spawnFailure);
      assert.equal((cleanupFailure as Error & { cleanupLabel?: string }).cleanupLabel, "quota_delegate_process");
      return true;
    },
  );
});

test("SWE-bench quota delegate treats residual cleanup processes as startup failure", async () => {
  const controller = new AbortController();
  const primary = new Error("abort delegate startup with residual");

  await assert.rejects(
    startQuotaDelegate({
      hubRoot: "/tmp/cpb-hub-residual",
      cpbRoot: "/tmp/cpb-root-residual",
      repoRoot: "/repo",
      distRoot: "/dist",
      readyPollMs: 10_000,
      readyTimeoutMs: 20_000,
      signal: controller.signal,
      ownerToken: "quota-owner-24684",
      isDelegateAliveFn: async () => false,
      captureProcessIdentityFn: (pid) => testProcessIdentity(pid),
      waitForDelegateIncarnationFn: async () => {
        controller.abort(primary);
        return null;
      },
      spawnImpl: () => ({ pid: 24684, unref: () => {} }),
      stopSpawnedFn: async () => ({
        workerCleanupEvents: 1,
        forcedKills: 1,
        residualProcesses: 1,
        residualScanOk: true,
        residualScanFailures: [],
        reasons: ["quota_delegate_start_failed"],
        workerIds: ["quota-delegate"],
        pids: [24684],
      }),
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      const errors = (error as AggregateError).errors;
      assert.equal((errors[0] as Error).message.includes("abort delegate startup with residual"), true);
      assert.equal(recordValue(errors[1]).code, "QUOTA_DELEGATE_CLEANUP_RESIDUAL");
      assert.equal(recordValue(recordValue(errors[1]).cleanup).residualProcesses, 1);
      return true;
    },
  );
});

test("SWE-bench quota delegate rejects cleanup when the residual scan is unverified", async () => {
  const controller = new AbortController();

  await assert.rejects(
    startQuotaDelegate({
      hubRoot: "/tmp/cpb-hub-unverified-cleanup",
      cpbRoot: "/tmp/cpb-root-unverified-cleanup",
      repoRoot: "/repo",
      distRoot: "/dist",
      readyPollMs: 10_000,
      readyTimeoutMs: 20_000,
      signal: controller.signal,
      ownerToken: "quota-owner-24686",
      isDelegateAliveFn: async () => false,
      captureProcessIdentityFn: (pid) => testProcessIdentity(pid),
      waitForDelegateIncarnationFn: async () => {
        controller.abort(new Error("abort delegate startup without cleanup proof"));
        return null;
      },
      spawnImpl: () => ({ pid: 24686, unref: () => {} }),
      stopSpawnedFn: async () => ({
        workerCleanupEvents: 1,
        forcedKills: 0,
        residualProcesses: 0,
        residualScanOk: false,
        residualScanFailures: ["scoped_residual_scan_failed"],
        reasons: ["quota_delegate_start_failed"],
        workerIds: ["quota-delegate"],
        pids: [24686],
      }),
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      const cleanupError = (error as AggregateError).errors[1];
      assert.equal(recordValue(cleanupError).code, "QUOTA_DELEGATE_CLEANUP_UNVERIFIED");
      assert.deepEqual(
        recordValue(recordValue(cleanupError).cleanup).residualScanFailures,
        ["scoped_residual_scan_failed"],
      );
      return true;
    },
  );
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
    cleanup: {
      codegraph: testCodeGraphCleanupProof({
        assignmentId: "assignment-one",
        jobId: "job-assignment-one",
      }),
    },
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
  const job = recordValue(report.jobs[0]);
  const executeEvidence = recordValue(recordValue(job.phaseEvidence).execute);

  assert.equal(executeEvidence.retryCount, 1);
  assert.deepEqual(executeEvidence.retryFailureKinds, ["timeout"]);
  assert.equal(executeEvidence.failureKind, "");
  assert.equal(job.failureKind, "");
  assert.equal(recordValue(recordValue(report.summary).phaseRetryCounts).execute, 1);
});

test("SWE-bench batch evidence collector records auditable prepare_task riskmap event evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-prepare-riskmap-test-"));
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
  const eventFile = path.join(eventDir, `${jobId}.jsonl`);
  const riskmapEvent = {
    type: "riskmap_generated",
    phase: "prepare_task",
    assignmentId: "assignment-one",
    riskmap: {
      files: ["django/db/models/expressions.py"],
      tests: ["expressions.tests.FTimeDeltaTests.test_date_subtraction"],
    },
    generatedAt: "2026-07-05T00:00:01.000Z",
  };
  await mkdir(attemptDir, { recursive: true });
  await mkdir(eventDir, { recursive: true });
  await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
    status: "completed",
    jobResult: {
      status: "completed",
      jobId,
    },
  }), "utf8");
  await writeFile(eventFile, [
    JSON.stringify({ type: "phase_retry", phase: "execute", failureKind: "timeout" }),
    JSON.stringify(riskmapEvent),
  ].join("\n"), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const prepareTask = recordValue(recordValue(recordValue(report.jobs[0]).phaseEvidence).prepare_task);
  const serialized = stableTestJson(riskmapEvent);

  assert.equal(prepareTask.ok, true);
  assert.equal(prepareTask.structuredOutputPath, `${eventFile}#riskmap_generated`);
  assert.equal(prepareTask.structuredOutputBytes, Buffer.byteLength(serialized, "utf8"));
  assert.equal(prepareTask.artifactSha256, stableTestJsonSha256(riskmapEvent));
  assert.ok(Number(prepareTask.structuredOutputBytes) > 0);
});

test("SWE-bench batch evidence collector does not fabricate prepare_task artifacts without riskmap event", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-prepare-no-riskmap-test-"));
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
    },
  }), "utf8");
  await writeFile(path.join(eventDir, `${jobId}.jsonl`), [
    JSON.stringify({ type: "phase_completed", phase: "prepare_task" }),
  ].join("\n"), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const prepareTask = recordValue(recordValue(recordValue(report.jobs[0]).phaseEvidence).prepare_task);

  assert.equal(prepareTask.ok, true);
  assert.equal(prepareTask.structuredOutputPath, null);
  assert.equal(prepareTask.structuredOutputBytes, 0);
  assert.equal(prepareTask.artifactSha256, null);
});

test("SWE-bench batch report rejects placeholder prepare_task artifact evidence for live completed jobs", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    providerPreflightMode: "live",
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
  const artifactEvidence = {
    ok: true,
    structuredOutputPath: "/tmp/phase-output.json",
    structuredOutputBytes: 123,
    artifactSha256: "a".repeat(64),
  };
  const report = buildSweBenchBatchReport({
    manifest,
    evidenceByAssignmentId: {
      "assignment-one": {
        phaseEvidence: {
          prepare_task: {
            ok: true,
            structuredOutputPath: "/tmp/events.jsonl",
            structuredOutputBytes: 0,
            artifactSha256: "b".repeat(64),
          },
          plan: artifactEvidence,
          execute: artifactEvidence,
          verify: artifactEvidence,
          adversarial_verify: artifactEvidence,
        },
        patch: {
          path: "/tmp/patch.diff",
          sha256: "c".repeat(64),
          bytes: 321,
          changedFiles: ["django/db/models/expressions.py"],
          changedFileCount: 1,
        },
        regressionEvidence: {
          status: "present",
          canonicalCommandsRun: ["PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction"],
        },
      },
    },
  });
  const validation = recordValue(report.validation);

  assert.equal(validation.valid, false);
  assert.match(String(validation.violations), /unauditable prepare_task artifact evidence/);
});

test("SWE-bench batch evidence collector fails validation on malformed referenced JSONL evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-malformed-jsonl-test-"));
  const auditPath = path.join(root, "audit.jsonl");
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
          diagnostics: { acpAuditFile: auditPath },
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
    JSON.stringify({ type: "phase_retry", phase: "execute", failureKind: "timeout" }),
    "{ not-json Authorization: Bearer ghp_never_persist_this_secret",
  ].join("\n"), "utf8");
  await writeFile(auditPath, [
    JSON.stringify({ event: "session_update", phase: "execute" }),
    "{ not-json API_KEY=sk-live-secret",
  ].join("\n"), "utf8");

  const evidence = await collectSweBenchBatchEvidence({ hubRoot: root, manifest });
  const report = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId: evidence.byAssignmentId });
  const job = recordValue(report.jobs[0]);
  const validation = recordValue(report.validation);
  const violations = String(validation.violations);

  assert.equal(validation.valid, false);
  assert.match(violations, /runtime event JSONL parse failed/);
  assert.match(violations, /ACP audit JSONL parse failed/);
  assert.doesNotMatch(violations, /ghp_never_persist_this_secret|sk-live-secret|API_KEY|Authorization/);
  const jobViolations = recordValue(job.evidenceValidation).violations;
  assert.equal(Array.isArray(jobViolations) ? jobViolations.length : 0, 2);
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
    workerCleanup: { workerCleanupEvents: 0 },
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
    terminalStates: [
      { assignmentId: "assignment-one", status: "failed", failureKind: "provider_unavailable" },
    ],
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

test("SWE-bench batch output writer fails closed when provider preflight evidence is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-missing-preflight-test-"));
  const manifestPath = path.join(root, "manifest.json");
  const reportPath = path.join(root, "report.json");
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 0,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [],
    terminalStates: [],
  };

  const outputs = await writeSweBenchBatchOutputsProduction({
    manifest,
    manifestPath,
    reportPath,
  });
  const writtenReport = JSON.parse(await readFile(outputs.reportPath, "utf8"));
  const validation = recordValue(writtenReport.validation);

  assert.equal(validation.valid, false);
  assert.match(String(validation.violations), /provider preflight evidence is missing/);
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

test("SWE-bench batch report fails closed when provider preflight evidence is missing or malformed", () => {
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 0,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [],
    terminalStates: [],
  };
  const report = {
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    manifest: {
      agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
      providerPreflight: null,
    },
    summary: {
      residualProcesses: 0,
    },
    jobs: [],
  };

  const missing = validateSweBenchBatchReport({ manifest, report });
  assert.equal(missing.valid, false);
  assert.match(missing.violations.join("\n"), /provider preflight evidence is missing/);

  const malformed = validateSweBenchBatchReport({
    manifest: {
      ...manifest,
      providerPreflight: "oops",
    },
    report: {
      ...report,
      manifest: {},
    },
  });
  assert.equal(malformed.valid, false);
  assert.match(malformed.violations.join("\n"), /provider preflight evidence must be a record/);
});

test("SWE-bench batch report rejects forged provider preflight success", () => {
  const manifest = withLiveProviderPreflight({
    schemaVersion: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 0,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [],
    terminalStates: [],
  });
  const providerPreflight = recordValue(manifest.providerPreflight);
  providerPreflight.ok = false;
  providerPreflight.violations = ["provider missing quota"];
  const report = buildSweBenchBatchReportProduction({ manifest });
  recordValue(report.manifest).providerPreflight = withLiveProviderPreflight({}).providerPreflight;

  const result = validateSweBenchBatchReport({ manifest, report });

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /provider preflight copy is inconsistent/);
  assert.match(result.violations.join("\n"), /provider preflight failed: provider missing quota/);
});

test("SWE-bench batch report rejects nested provider handshake launch and raw fields", () => {
  const secret = "github_pat_nested_provider_evidence_must_not_persist";
  const manifest = withLiveProviderPreflight({
    schemaVersion: 1,
    generatedAt: "2026-07-20T00:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 0,
    planMode: "full",
    assignments: [],
    terminalStates: [],
  });
  const preflight = recordValue(manifest.providerPreflight);
  const phases = preflight.phases as Array<Record<string, unknown>>;
  const handshake = recordValue(phases[0].handshake);
  handshake.env = { GITHUB_TOKEN: secret };
  handshake.rawOutput = secret;
  phases[0].handshake = handshake;
  const report = buildSweBenchBatchReportProduction({
    manifest,
    generatedAt: "2026-07-20T00:00:00.000Z",
  });

  const result = validateSweBenchBatchReport({ manifest, report });

  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /handshake evidence must not retain launch arguments/);
  assert.doesNotMatch(result.violations.join("\n"), new RegExp(secret));
});

test("SWE-bench batch report rejects assignments without terminal states", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = withLiveProviderPreflight({
    schemaVersion: 1,
    generatedAt: "2026-07-20T10:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [{
      record: firstRecord,
      queued: { assignmentId: "assignment-one", attempt: 1 },
    }],
    terminalStates: [],
  });

  const report = buildSweBenchBatchReportProduction({ manifest });

  assert.equal(recordValue(report.validation).valid, false);
  assert.match(String(recordValue(report.validation).violations), /missing terminal state|non-terminal status/);
});

test("SWE-bench batch report rejects missing or forged CodeGraph cleanup proof for live completed jobs", () => {
  const firstRecord = recordFromDatasetRow(sampleRow, 7);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-20T10:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    providerPreflightMode: "live",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    assignments: [{
      entryId: "entry-one",
      projectId: "proj",
      workerId: "w-swebench-01",
      record: firstRecord,
      queued: { assignmentId: "assignment-one", attempt: 1, attemptToken: "attempt-token-1", orchestratorEpoch: 1 },
    }],
    terminalStates: [{ assignmentId: "assignment-one", status: "completed", attempt: 1, jobId: "job-assignment-one", workerId: "w-swebench-01", orchestratorEpoch: 1 }],
  };
  const evidenceByAssignmentId = {
    "assignment-one": {
      jobId: "job-assignment-one",
      phaseEvidence: {
        prepare_task: { ok: true, structuredOutputPath: "/tmp/prepare.json#riskmap_generated", structuredOutputBytes: 1, artifactSha256: "a".repeat(64) },
        plan: { ok: true, structuredOutputPath: "/tmp/plan.json", structuredOutputBytes: 1, artifactSha256: "b".repeat(64) },
        execute: { ok: true, structuredOutputPath: "/tmp/execute.json", structuredOutputBytes: 1, artifactSha256: "c".repeat(64) },
        verify: { ok: true, structuredOutputPath: "/tmp/verify.json", structuredOutputBytes: 1, artifactSha256: "d".repeat(64) },
        adversarial_verify: { ok: true, structuredOutputPath: "/tmp/adversarial.json", structuredOutputBytes: 1, artifactSha256: "e".repeat(64) },
      },
      patch: {
        path: "/tmp/source.patch",
        sha256: "f".repeat(64),
        bytes: 1,
        changedFiles: ["django/db/models/expressions.py"],
        changedFileCount: 1,
      },
      regressionEvidence: {
        status: "present",
        canonicalCommandsRun: ["python tests/runtests.py expressions"],
      },
    },
  };
  const valid = buildSweBenchBatchReport({ manifest, evidenceByAssignmentId });
  assert.equal(recordValue(valid.validation).valid, true);
  const rehashReportManifest = (report: LooseRecord) => {
    recordValue(report.manifest).hash = stableTestJsonSha256(report.sourceManifest);
  };

  const missing = structuredClone(valid);
  delete recordValue(recordValue(missing.jobs[0]).cleanup).codegraph;
  missing.validation = validateSweBenchBatchReport({ manifest: missing.sourceManifest, report: missing });
  assert.equal(recordValue(missing.validation).valid, false);
  assert.match(String(recordValue(missing.validation).violations), /missing CodeGraph cleanup proof/);

  const identityMutations = [
    { field: "assignmentId", value: "other-assignment", pattern: /assignment identity mismatch/ },
    { field: "attempt", value: 2, pattern: /attempt identity mismatch/ },
    { field: "attemptToken", value: "other-token", pattern: /attempt token mismatch/ },
    { field: "entryId", value: "other-entry", pattern: /entry identity mismatch/ },
    { field: "projectId", value: "other-project", pattern: /project identity mismatch/ },
    { field: "jobId", value: "other-job", pattern: /job identity mismatch/ },
    { field: "workerId", value: "other-worker", pattern: /worker identity mismatch/ },
    { field: "orchestratorEpoch", value: 2, pattern: /orchestrator epoch mismatch/ },
  ] as const;
  for (const mutation of identityMutations) {
    const forged = structuredClone(valid);
    const proof = recordValue(recordValue(recordValue(forged.jobs[0]).cleanup).codegraph) as Record<string, unknown>;
    proof[mutation.field] = mutation.value;
    forged.validation = validateSweBenchBatchReport({ manifest: forged.sourceManifest, report: forged });
    assert.equal(recordValue(forged.validation).valid, false, mutation.field);
    assert.match(String(recordValue(forged.validation).violations), mutation.pattern, mutation.field);
  }

  const authorityConflicts = [
    {
      name: "terminal projectId conflict",
      mutate: (report: LooseRecord) => {
        recordValue((recordValue(report.sourceManifest).terminalStates as LooseRecord[])[0]).projectId = "other-project";
      },
      pattern: /conflicting authoritative projectId/,
    },
    {
      name: "terminal attempts conflict",
      mutate: (report: LooseRecord) => {
        recordValue((recordValue(report.sourceManifest).terminalStates as LooseRecord[])[0]).attempts = 2;
      },
      pattern: /conflicting authoritative attempt/,
    },
    {
      name: "terminal attemptToken conflict",
      mutate: (report: LooseRecord) => {
        recordValue((recordValue(report.sourceManifest).terminalStates as LooseRecord[])[0]).attemptToken = "other-token";
      },
      pattern: /conflicting authoritative attemptToken/,
    },
    {
      name: "terminal workerId conflict",
      mutate: (report: LooseRecord) => {
        recordValue((recordValue(report.sourceManifest).terminalStates as LooseRecord[])[0]).workerId = "other-worker";
      },
      pattern: /conflicting authoritative workerId/,
    },
    {
      name: "terminal orchestratorEpoch conflict",
      mutate: (report: LooseRecord) => {
        recordValue((recordValue(report.sourceManifest).terminalStates as LooseRecord[])[0]).orchestratorEpoch = 2;
      },
      pattern: /conflicting authoritative orchestratorEpoch/,
    },
  ] as const;
  for (const fixture of authorityConflicts) {
    const forged = structuredClone(valid);
    fixture.mutate(forged);
    rehashReportManifest(forged);
    forged.validation = validateSweBenchBatchReport({ manifest: forged.sourceManifest, report: forged });
    assert.equal(recordValue(forged.validation).valid, false, fixture.name);
    assert.match(String(recordValue(forged.validation).violations), fixture.pattern, fixture.name);
  }

  const missingEpochAuthority = structuredClone(valid);
  const missingAssignments = recordValue(missingEpochAuthority.sourceManifest).assignments as Array<LooseRecord>;
  const missingTerminalStates = recordValue(missingEpochAuthority.sourceManifest).terminalStates as Array<LooseRecord>;
  const missingAssignment = recordValue(missingAssignments[0]);
  delete recordValue(missingAssignment.queued).orchestratorEpoch;
  delete missingAssignment.orchestratorEpoch;
  delete recordValue(missingTerminalStates[0]).orchestratorEpoch;
  missingEpochAuthority.validation = validateSweBenchBatchReport({
    manifest: missingEpochAuthority.sourceManifest,
    report: missingEpochAuthority,
  });
  assert.equal(recordValue(missingEpochAuthority.validation).valid, false);
  assert.match(String(recordValue(missingEpochAuthority.validation).violations), /missing authoritative orchestratorEpoch/);

  const retry = structuredClone(valid);
  recordValue(recordValue(recordValue(retry.jobs[0]).cleanup).codegraph).cleanupAttempt = 2;
  retry.validation = validateSweBenchBatchReport({ manifest: retry.sourceManifest, report: retry });
  assert.equal(recordValue(retry.validation).valid, false);
  assert.match(String(recordValue(retry.validation).violations), /first cleanup attempt/);

  const proofTypeMutations = [
    { name: "proof pid 0", path: ["pid"], value: 0, pattern: /pids must be positive safe integers/ },
    { name: "proof processPid null", path: ["processPid"], value: null, pattern: /pids must be positive safe integers/ },
    { name: "startup pid 0", path: ["startup", "pid"], value: 0, pattern: /pids must be positive safe integers/ },
    { name: "startup processPid null", path: ["startup", "processPid"], value: null, pattern: /pids must be positive safe integers/ },
    { name: "cleanupAttempt string", path: ["cleanupAttempt"], value: "1", pattern: /first cleanup attempt/ },
    { name: "orchestratorEpoch string", path: ["orchestratorEpoch"], value: "1", pattern: /orchestrator epoch mismatch/ },
    { name: "attempt string", path: ["attempt"], value: "1", pattern: /attempt identity mismatch/ },
  ] as const;
  for (const mutation of proofTypeMutations) {
    const forged = structuredClone(valid);
    const proof = recordValue(recordValue(recordValue(forged.jobs[0]).cleanup).codegraph) as Record<string, unknown>;
    let target = proof;
    for (const segment of mutation.path.slice(0, -1)) {
      target = recordValue(target[segment]) as Record<string, unknown>;
    }
    target[mutation.path[mutation.path.length - 1]] = mutation.value;
    forged.validation = validateSweBenchBatchReport({ manifest: forged.sourceManifest, report: forged });
    assert.equal(recordValue(forged.validation).valid, false, mutation.name);
    assert.match(String(recordValue(forged.validation).violations), mutation.pattern, mutation.name);
  }

  const authorityTypeMutations = [
    {
      name: "queued orchestratorEpoch string",
      mutate: (report: LooseRecord) => {
        const assignment = recordValue((recordValue(report.sourceManifest).assignments as LooseRecord[])[0]);
        recordValue(assignment.queued).orchestratorEpoch = "1";
      },
      pattern: /missing authoritative orchestratorEpoch/,
    },
    {
      name: "terminal projectId null",
      mutate: (report: LooseRecord) => {
        recordValue((recordValue(report.sourceManifest).terminalStates as LooseRecord[])[0]).projectId = null;
      },
      pattern: /missing authoritative projectId/,
    },
    {
      name: "terminal attemptToken null",
      mutate: (report: LooseRecord) => {
        recordValue((recordValue(report.sourceManifest).terminalStates as LooseRecord[])[0]).attemptToken = null;
      },
      pattern: /missing authoritative attemptToken/,
    },
    {
      name: "terminal orchestratorEpoch string",
      mutate: (report: LooseRecord) => {
        recordValue((recordValue(report.sourceManifest).terminalStates as LooseRecord[])[0]).orchestratorEpoch = "1";
      },
      pattern: /missing authoritative orchestratorEpoch/,
    },
  ] as const;
  for (const mutation of authorityTypeMutations) {
    const forged = structuredClone(valid);
    mutation.mutate(forged);
    rehashReportManifest(forged);
    forged.validation = validateSweBenchBatchReport({ manifest: forged.sourceManifest, report: forged });
    assert.equal(recordValue(forged.validation).valid, false, mutation.name);
    assert.match(String(recordValue(forged.validation).violations), mutation.pattern, mutation.name);
  }
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

test("SWE-bench batch enqueue rolls back project and assignment state when abort races register/enqueue", async (t) => {
  const runAbortCase = async (
    stage: "afterRegister" | "afterEnqueue",
    { preserveConcurrent = false }: { preserveConcurrent?: boolean } = {},
  ) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `cpb-swebench-enqueue-${stage}-abort-`));
    const hubRoot = path.join(root, "hub");
    const sourcePath = path.join(root, "sources", "django__django-13128");
    const concurrentSourcePath = path.join(root, "sources", "concurrent");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(concurrentSourcePath, { recursive: true });
    await mkdir(hubRoot, { recursive: true });
    const record = recordFromDatasetRow(sampleRow, 7);
    const input = buildBatchAssignmentInput({
      record,
      row: sampleRow,
      sourcePath,
      agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
      planMode: "full",
    });
    const abort = new AbortController();
    await assert.rejects(
      () => queueBatchAssignmentAtomically({
        hubRoot,
        workerId: "worker-01",
        input,
        sourcePath,
        metadata: {
          productValidation: true,
          benchmarkDataset: "SWE-bench/SWE-bench_Verified",
          benchmarkInstanceId: record.benchmarkInstanceId,
          batchQueuedAt: "2026-07-20T00:00:00.000Z",
        },
        skipCodeGraphGate: true,
        signal: abort.signal,
        hooks: {
          [stage]: () => abort.abort(new DOMException(`${stage} abort`, "AbortError")),
          concurrentDuringRollback: preserveConcurrent
            ? async () => {
              await registerHubProject(hubRoot, {
                id: "concurrent-project",
                name: "concurrent-project",
                sourcePath: concurrentSourcePath,
                skipCodeGraphGate: true,
              });
              const concurrentStore = new AssignmentStore(hubRoot);
              await concurrentStore.init();
              const concurrentAssignment = await concurrentStore.getOrCreateAssignmentForEntry({
                entryId: "concurrent-entry",
                projectId: "concurrent-project",
                task: "preserve concurrent assignment",
                sourcePath: concurrentSourcePath,
              });
              assert.equal(concurrentAssignment.assignmentId, "a-concurrent-entry");
              assert.equal(concurrentAssignment.projectId, "concurrent-project");
              const concurrentAttempt = await concurrentStore.createAttempt(String(concurrentAssignment.assignmentId), {
                workerId: "worker-concurrent",
                orchestratorEpoch: 1,
              });
              assert.equal(concurrentAttempt.assignmentId, concurrentAssignment.assignmentId);
              assert.equal(concurrentAttempt.projectId, "concurrent-project");
            }
            : undefined,
        },
      }),
      /abort/,
    );

    const registry = recordValue(JSON.parse(await readFile(path.join(hubRoot, "projects.json"), "utf8")));
    const projects = recordValue(registry.projects);
    assert.equal(Object.hasOwn(projects, input.projectId), false);
    await assert.rejects(
      () => readFile(path.join(hubRoot, "assignments", `a-${input.entryId}`, "state.json"), "utf8"),
      /ENOENT/,
    );
    await assert.rejects(
      () => readFile(path.join(hubRoot, "workers", "inbox", "worker-01", `a-${input.entryId}-attempt-001.json`), "utf8"),
      /ENOENT/,
    );
    await assert.rejects(
      () => readFile(path.join(hubRoot, "workers", "inbox", "worker-01", `a-${input.entryId}.json`), "utf8"),
      /ENOENT/,
    );
    if (preserveConcurrent) {
      assert.match(String(recordValue(projects["concurrent-project"]).sourcePath), /sources\/concurrent$/);
      const concurrentState = recordValue(JSON.parse(await readFile(
        path.join(hubRoot, "assignments", "a-concurrent-entry", "state.json"),
        "utf8",
      )));
      assert.equal(concurrentState.projectId, "concurrent-project");
      assert.equal(concurrentState.status, "assigned");
    } else {
      assert.deepEqual(projects, {});
    }
  };

  await t.test("after register", () => runAbortCase("afterRegister"));
  await t.test("after enqueue", () => runAbortCase("afterEnqueue"));
  await t.test("preserves concurrent project and assignment", () => runAbortCase("afterEnqueue", { preserveConcurrent: true }));
});

test("SWE-bench batch enqueue compensates a committed registry warning before any assignment side effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-enqueue-registry-warning-"));
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "sources", "django__django-13128");
  await mkdir(sourcePath, { recursive: true });
  const record = recordFromDatasetRow(sampleRow, 7);
  const input = buildBatchAssignmentInput({
    record,
    row: sampleRow,
    sourcePath,
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    planMode: "full",
  });
  let injected = false;
  let afterRegisterCalled = false;

  await assert.rejects(
    () => withHubRegistryTestHooks({
      afterAtomicRename: (filePath) => {
        if (!injected && path.basename(filePath) === "projects.json") {
          injected = true;
          throw Object.assign(new Error("durability acknowledgement failed after registry rename"), { code: "EIO" });
        }
      },
    }, () => queueBatchAssignmentAtomically({
      hubRoot,
      workerId: "worker-01",
      input,
      sourcePath,
      metadata: { productValidation: true },
      skipCodeGraphGate: true,
      hooks: {
        afterRegister: () => { afterRegisterCalled = true; },
      },
    })),
    (error) => {
      assert.equal(recordValue(error).code, "HUB_REGISTRY_COMMITTED");
      assert.equal(recordValue(error).name, "HubRegistryCommitWarning");
      assert.ok(recordValue(error).projectReceipt);
      assert.equal(Array.isArray(recordValue(error).commitWarnings), true);
      return true;
    },
  );

  assert.equal(injected, true);
  assert.equal(afterRegisterCalled, false, "blocking warning stops the transaction immediately after receipt capture");
  const registry = recordValue(JSON.parse(await readFile(path.join(hubRoot, "projects.json"), "utf8")));
  assert.equal(Object.hasOwn(recordValue(registry.projects), input.projectId), false);
  assert.equal(await fileExists(path.join(hubRoot, "assignments", `a-${input.entryId}`, "state.json")), false);
  assert.equal(await fileExists(path.join(hubRoot, "workers", "inbox", "worker-01", `a-${input.entryId}.json`)), false);
});

test("local assignment enqueue self-compensates every pre-receipt write fault", async (t) => {
  const cases: Array<keyof typeof __assignmentStoreTestHooks> = [
    "afterLocalEnqueueInputWrite",
    "afterLocalEnqueueAttemptWrite",
    "afterLocalEnqueueStateWrite",
  ];
  for (const hookName of cases) {
    await t.test(String(hookName), async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `cpb-assignment-partial-${String(hookName)}-`));
      const hubRoot = path.join(root, "hub");
      const sourcePath = path.join(root, "sources", "django__django-13128");
      await mkdir(sourcePath, { recursive: true });
      const record = recordFromDatasetRow(sampleRow, 17);
      const input = buildBatchAssignmentInput({
        record,
        row: sampleRow,
        sourcePath,
        agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
        planMode: "full",
      });
      const assignmentId = `a-${input.entryId}`;
      __assignmentStoreTestHooks[hookName] = () => {
        throw Object.assign(new Error(`fault at ${String(hookName)}`), { code: "TEST_FAULT" });
      };
      try {
        await assert.rejects(
          () => queueBatchAssignmentAtomically({
            hubRoot,
            workerId: "worker-01",
            input,
            sourcePath,
            metadata: { productValidation: true },
            skipCodeGraphGate: true,
          }),
          /fault at/,
        );
      } finally {
        __assignmentStoreTestHooks[hookName] = undefined;
      }
      assert.equal(await fileExists(path.join(hubRoot, "assignments", assignmentId, "input.json")), false);
      assert.equal(await fileExists(path.join(hubRoot, "assignments", assignmentId, "state.json")), false);
      assert.deepEqual(await readdir(path.join(hubRoot, "assignments", assignmentId, "attempts")).catch(() => []), []);
    });
  }
});

test("local assignment enqueue restores an existing document at every pre-receipt fault", async (t) => {
  const hookNames: Array<keyof Pick<typeof __assignmentStoreTestHooks,
    "afterLocalEnqueueInputWrite" | "afterLocalEnqueueAttemptWrite" | "afterLocalEnqueueStateWrite">> = [
    "afterLocalEnqueueInputWrite",
    "afterLocalEnqueueAttemptWrite",
    "afterLocalEnqueueStateWrite",
  ];
  for (const hookName of hookNames) {
    await t.test(hookName, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `cpb-assignment-restore-${hookName}-`));
      const sourcePath = path.join(root, "source");
      await mkdir(sourcePath, { recursive: true });
      const store = new AssignmentStore(root);
      await store.init();
      const first = await store.enqueueWithReceipt({
        entryId: "restore-entry",
        projectId: "restore-project",
        task: "first task",
        sourcePath,
        sourceContext: { version: 1 },
        metadata: { generation: "first" },
      }, { workerId: "worker-01", orchestratorEpoch: 1 });
      assert.equal(Object.isFrozen(first), true);
      assert.equal(Object.isFrozen(first.committedDocument.attempts["1"]), true);
      assert.throws(() => { first.assignment.metadata = { mutatedByCaller: true }; }, TypeError);
      assert.throws(() => { first.attempt.attemptToken = "caller-mutated-token"; }, TypeError);

      __assignmentStoreTestHooks[hookName] = () => {
        throw Object.assign(new Error(`fault at ${hookName}`), { code: "TEST_FAULT" });
      };
      try {
        await assert.rejects(
          () => store.enqueueWithReceipt({
            entryId: "restore-entry",
            projectId: "restore-project",
            task: "second task",
            sourcePath,
            sourceContext: { version: 2 },
            metadata: { generation: "second" },
          }, { workerId: "worker-02", orchestratorEpoch: 2 }),
          new RegExp(`fault at ${hookName}`),
        );
      } finally {
        __assignmentStoreTestHooks[hookName] = undefined;
      }

      const restored = await store.getAssignment("a-restore-entry");
      assert.equal(restored?.task, "first task");
      assert.equal(recordValue(restored?.metadata).generation, "first");
      const attemptDirectory = path.join(root, "assignments", "a-restore-entry", "attempts");
      const attemptEntries = await readdir(attemptDirectory);
      const preservedAttemptEntries = attemptEntries.filter((entry) => entry.startsWith(".002.remove-"));
      assert.deepEqual(
        attemptEntries.filter((entry) => !entry.startsWith(".002.remove-")),
        ["001"],
      );
      assert.equal(
        preservedAttemptEntries.length,
        hookName === "afterLocalEnqueueInputWrite" ? 0 : 1,
      );
      if (preservedAttemptEntries.length === 1) {
        const preservedAttempt = recordValue(JSON.parse(await readFile(
          path.join(attemptDirectory, preservedAttemptEntries[0], "attempt.json"),
          "utf8",
        )));
        assert.equal(preservedAttempt.attempt, 2);
        assert.equal(preservedAttempt.workerId, "worker-02");
      }
      const attempt = recordValue(JSON.parse(await readFile(
        path.join(attemptDirectory, "001", "attempt.json"),
        "utf8",
      )));
      assert.equal(attempt.attemptToken, first.committedDocument.attempts["1"].attemptToken);
      if (first.writeFence.backend !== "local") throw new Error("expected local assignment write fence");
      const owner = recordValue(JSON.parse(await readFile(
        path.join(root, "assignments", "a-restore-entry", "enqueue-owner.json"),
        "utf8",
      )));
      assert.equal(owner.ownerToken, first.writeFence.ownerToken);
    });
  }
});

test("local assignment restore attempts every component and aggregates all failures", async (t) => {
  const prepare = async (suffix: string) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `cpb-assignment-restore-all-${suffix}-`));
    const sourcePath = path.join(root, "source");
    await mkdir(sourcePath, { recursive: true });
    const store = new AssignmentStore(root);
    await store.init();
    await store.enqueueWithReceipt({
      entryId: "restore-all",
      projectId: "restore-project",
      task: "first",
      sourcePath,
      metadata: { generation: 1 },
    }, { workerId: "worker-01", orchestratorEpoch: 1 });
    return { root, sourcePath, store };
  };
  const expected = ["input", "state", "owner", "removeAttempt", "restoreAttempt"];

  await t.test("pre-receipt rollback includes original and every cleanup failure", async () => {
    const { sourcePath, store } = await prepare("pre-receipt");
    const attempted: string[] = [];
    __assignmentStoreTestHooks.afterLocalEnqueueStateWrite = () => {
      throw Object.assign(new Error("original enqueue fault"), { code: "TEST_ORIGINAL" });
    };
    __assignmentStoreTestHooks.beforeLocalRestoreComponent = ({ component }) => {
      attempted.push(component);
      throw Object.assign(new Error(`restore ${component} fault`), { code: `TEST_RESTORE_${component}` });
    };
    try {
      await assert.rejects(
        () => store.enqueueWithReceipt({
          entryId: "restore-all",
          projectId: "restore-project",
          task: "second",
          sourcePath,
          metadata: { generation: 2 },
        }, { workerId: "worker-02", orchestratorEpoch: 2 }),
        (error) => {
          assert.equal(error instanceof AggregateError, true);
          const messages = (error as AggregateError).errors.map(String);
          assert.equal(messages.some((message) => message.includes("original enqueue fault")), true);
          for (const component of expected) {
            assert.equal(messages.some((message) => message.includes(`restore ${component} fault`)), true);
          }
          return true;
        },
      );
    } finally {
      __assignmentStoreTestHooks.afterLocalEnqueueStateWrite = undefined;
      __assignmentStoreTestHooks.beforeLocalRestoreComponent = undefined;
    }
    assert.deepEqual(new Set(attempted), new Set(expected));
  });

  await t.test("formal compensation attempts every restore component", async () => {
    const { sourcePath, store } = await prepare("formal");
    const receipt = await store.enqueueWithReceipt({
      entryId: "restore-all",
      projectId: "restore-project",
      task: "second",
      sourcePath,
      metadata: { generation: 2 },
    }, { workerId: "worker-02", orchestratorEpoch: 2 });
    const attempted: string[] = [];
    __assignmentStoreTestHooks.beforeLocalRestoreComponent = ({ component }) => {
      attempted.push(component);
      throw Object.assign(new Error(`formal ${component} fault`), { code: `TEST_FORMAL_${component}` });
    };
    try {
      await assert.rejects(
        () => store.compensateEnqueueReceipt(receipt),
        (error) => {
          assert.equal(error instanceof AggregateError, true);
          const messages = (error as AggregateError).errors.map(String);
          for (const component of expected) {
            assert.equal(messages.some((message) => message.includes(`formal ${component} fault`)), true);
          }
          return true;
        },
      );
    } finally {
      __assignmentStoreTestHooks.beforeLocalRestoreComponent = undefined;
    }
    assert.deepEqual(new Set(attempted), new Set(expected));
  });
});

test("local assignment receipts use normalized frozen JSON and reject same-value successors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-assignment-json-fence-"));
  const sourcePath = path.join(root, "source");
  await mkdir(sourcePath, { recursive: true });
  const store = new AssignmentStore(root);
  await store.init();

  const normalized = await store.enqueueWithReceipt({
    entryId: "normalized",
    projectId: "project",
    task: "normalized",
    sourcePath,
    metadata: { kept: true, omitted: undefined },
  }, { workerId: "worker-01", orchestratorEpoch: 1 });
  assert.equal(Object.hasOwn(recordValue(normalized.assignment.metadata), "omitted"), false);
  assert.equal(Object.isFrozen(normalized.writeFence), true);
  const persisted = recordValue(JSON.parse(await readFile(
    path.join(root, "assignments", "a-normalized", "state.json"),
    "utf8",
  )));
  assert.deepEqual(persisted, normalized.committedDocument.state);
  assert.equal(await store.compensateEnqueueReceipt(normalized), true);

  const fenced = await store.enqueueWithReceipt({
    entryId: "same-value",
    projectId: "project",
    task: "same value",
    sourcePath,
  }, { workerId: "worker-01", orchestratorEpoch: 1 });
  if (fenced.writeFence.backend !== "local") throw new Error("expected local assignment write fence");
  const beforeSuccessor = await store.getAssignment("a-same-value");
  const beforeOwner = JSON.parse(await readFile(
    path.join(root, "assignments", "a-same-value", "enqueue-owner.json"),
    "utf8",
  ));
  await store._withAssignmentLock("a-same-value", async () => undefined);
  assert.deepEqual(await store.getAssignment("a-same-value"), beforeSuccessor);
  assert.deepEqual(JSON.parse(await readFile(
    path.join(root, "assignments", "a-same-value", "enqueue-owner.json"),
    "utf8",
  )), beforeOwner);
  await assert.rejects(
    () => store.compensateEnqueueReceipt(fenced),
    (error: unknown) => recordValue(error).code === "HUB_ASSIGNMENT_COMPENSATION_CONFLICT",
  );
  assert.equal((await store.getAssignment("a-same-value"))?.task, "same value");

  await assert.rejects(
    () => store.enqueueWithReceipt({
      entryId: "uncloneable",
      projectId: "project",
      task: "uncloneable",
      sourcePath,
      metadata: { callback: () => true },
    }, { workerId: "worker-01", orchestratorEpoch: 1 }),
    (error: unknown) => recordValue(error).code === "HUB_ASSIGNMENT_JSON_INVALID",
  );
  assert.equal(await fileExists(path.join(root, "assignments", "a-uncloneable", "input.json")), false);
});

test("local assignment cancellation aborts before or during lock wait but linearizes after commit", async (t) => {
  const prepare = async (suffix: string) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `cpb-assignment-cancel-${suffix}-`));
    const store = new AssignmentStore(root);
    await store.init();
    const assignment = await store.getOrCreateAssignmentForEntry({
      entryId: suffix,
      projectId: "cancel-project",
      task: "cancel task",
      sourcePath: root,
    });
    await store.createAttempt(String(assignment.assignmentId), { workerId: "worker-01", orchestratorEpoch: 1 });
    return { root, store, assignmentId: String(assignment.assignmentId) };
  };

  await t.test("pre-aborted signal performs no mutation", async () => {
    const { store, assignmentId } = await prepare("pre-aborted");
    const controller = new AbortController();
    controller.abort(new DOMException("cancel before write", "AbortError"));
    await assert.rejects(
      () => store.writeCancel(assignmentId, 1, "must not persist", { signal: controller.signal }),
      /cancel before write/,
    );
    assert.equal(await store.readCancel(assignmentId, 1), null);
  });

  const assertStopsWhileWaiting = async (mode: "signal" | "deadline") => {
    const { root, store, assignmentId } = await prepare(`wait-${mode}`);
    const lockDir = path.join(root, "assignments", assignmentId, "state.lock");
    await rm(lockDir, { recursive: true, force: true });
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({
      ownerToken: `live-${mode}`,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
    })}\n`, "utf8");
    const controller = new AbortController();
    const timer = mode === "signal"
      ? setTimeout(() => controller.abort(new DOMException("cancel during lock wait", "AbortError")), 25)
      : null;
    const startedAt = Date.now();
    try {
      await assert.rejects(
        () => store.writeCancel(assignmentId, 1, "must not persist", mode === "signal"
          ? { signal: controller.signal }
          : { deadlineAt: Date.now() + 25 }),
        /cancel during lock wait|deadline exceeded/,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    assert.equal(Date.now() - startedAt < 1_000, true);
    assert.equal(await store.readCancel(assignmentId, 1), null);
  };

  await t.test("signal interrupts lock retry", () => assertStopsWhileWaiting("signal"));
  await t.test("deadline interrupts lock retry", () => assertStopsWhileWaiting("deadline"));

  await t.test("abort after durable commit returns the committed result", async () => {
    const { store, assignmentId } = await prepare("post-commit");
    const controller = new AbortController();
    __assignmentStoreTestHooks.afterLocalCancelCommit = () => {
      controller.abort(new DOMException("abort after commit", "AbortError"));
    };
    try {
      assert.equal(
        await store.writeCancel(assignmentId, 1, "persisted cancellation", { signal: controller.signal }),
        true,
      );
    } finally {
      __assignmentStoreTestHooks.afterLocalCancelCommit = undefined;
    }
    assert.equal(controller.signal.aborted, true);
    assert.equal((await store.readCancel(assignmentId, 1))?.reason, "persisted cancellation");
  });
});

test("local assignment lock recovery fails closed on unknown liveness and unsafe lock paths", async (t) => {
  const liveOwner = exactLocalLockOwner(
    "assignment-live-owner",
    testProcessIdentity(424242, "assignment-live-owner"),
  );

  for (const code of ["EPERM", "EIO"]) {
    await t.test(`process liveness ${code}`, () => {
      const store = new AssignmentStore(path.join(os.tmpdir(), `cpb-assignment-liveness-${code}`));
      const probeError = errno(code);
      __assignmentStoreTestHooks.isAssignmentProcessIdentityAlive = () => { throw probeError; };
      try {
        assert.throws(
          () => store._assignmentLockOwnerAlive(liveOwner),
          (error: unknown) => recordValue(error).code === "HUB_ASSIGNMENT_LOCK_CONFLICT"
            && recordValue(error).cause === probeError,
        );
      } finally {
        __assignmentStoreTestHooks.isAssignmentProcessIdentityAlive = undefined;
      }
    });
  }

  await t.test("legacy owner without exact identity fails closed without probing liveness", () => {
    const store = new AssignmentStore(path.join(os.tmpdir(), "cpb-assignment-legacy-liveness"));
    let probeCalls = 0;
    __assignmentStoreTestHooks.isAssignmentProcessIdentityAlive = () => {
      probeCalls += 1;
      return false;
    };
    try {
      assert.equal(store._assignmentLockOwnerAlive({
        ownerToken: "assignment-legacy-owner",
        pid: 99999999,
        host: os.hostname(),
        acquiredAt: "2026-07-20T00:00:00.000Z",
      }), true);
    } finally {
      __assignmentStoreTestHooks.isAssignmentProcessIdentityAlive = undefined;
    }
    assert.equal(probeCalls, 0);
  });

  await t.test("corrupt owner is not reclaimed as incomplete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-assignment-corrupt-lock-"));
    const store = new AssignmentStore(root);
    await store.init();
    const lockDir = path.join(root, "assignments", "a-corrupt", "state.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), "{not-json", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);
    await assert.rejects(
      () => store._assignmentLockRecoveryKind(lockDir, path.join(lockDir, "owner.json")),
      (error: unknown) => recordValue(error).code === "HUB_ASSIGNMENT_LOCK_CONFLICT",
    );
    assert.equal((await lstat(lockDir)).isDirectory(), true);
  });

  for (const kind of ["symlink", "file"] as const) {
    await t.test(`${kind} lock path is rejected without following it`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `cpb-assignment-${kind}-lock-`));
      const store = new AssignmentStore(root);
      await store.init();
      const assignmentDir = path.join(root, "assignments", `a-${kind}`);
      const lockDir = path.join(assignmentDir, "state.lock");
      await mkdir(assignmentDir, { recursive: true });
      if (kind === "symlink") {
        const target = path.join(root, "outside-lock-target");
        await mkdir(target);
        await writeFile(path.join(target, "owner.json"), `${JSON.stringify(exactLocalLockOwner(
          "symlink-target-owner",
          testProcessIdentity(99999999, "dead-assignment-symlink-target"),
        ))}\n`, "utf8");
        const old = new Date(Date.now() - 60_000);
        await utimes(target, old, old);
        await symlink(target, lockDir);
      } else {
        await writeFile(lockDir, "not a lock directory", "utf8");
      }
      await assert.rejects(
        () => store._assignmentLockRecoveryKind(lockDir, path.join(lockDir, "owner.json")),
        (error: unknown) => recordValue(error).code === "HUB_ASSIGNMENT_LOCK_CONFLICT",
      );
      const preserved = await lstat(lockDir);
      assert.equal(kind === "symlink" ? preserved.isSymbolicLink() : preserved.isFile(), true);
    });
  }
});

test("SWE-bench batch enqueue rollback refuses to overwrite a concurrent same-assignment change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-enqueue-same-assignment-conflict-"));
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "sources", "django__django-13128");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  const record = recordFromDatasetRow(sampleRow, 11);
  const input = buildBatchAssignmentInput({
    record,
    row: sampleRow,
    sourcePath,
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    planMode: "full",
  });
  const abort = new AbortController();
  const statePath = path.join(hubRoot, "assignments", `a-${input.entryId}`, "state.json");
  const inboxPath = path.join(hubRoot, "workers", "inbox", "worker-01", `a-${input.entryId}.json`);

  await assert.rejects(
    () => queueBatchAssignmentAtomically({
      hubRoot,
      workerId: "worker-01",
      input,
      sourcePath,
      metadata: {
        productValidation: true,
        benchmarkDataset: "SWE-bench/SWE-bench_Verified",
        benchmarkInstanceId: record.benchmarkInstanceId,
        batchQueuedAt: "2026-07-20T00:00:00.000Z",
      },
      skipCodeGraphGate: true,
      signal: abort.signal,
      hooks: {
        afterEnqueue: () => abort.abort(new DOMException("afterEnqueue abort", "AbortError")),
        concurrentDuringRollback: async () => {
          const currentState = recordValue(JSON.parse(await readFile(statePath, "utf8")));
          currentState.status = "running";
          currentState.concurrentMutationAt = "2026-07-20T00:00:01.000Z";
          await writeFile(statePath, `${JSON.stringify(currentState, null, 2)}\n`, "utf8");
        },
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(String(error), /rollback failed|transaction rollback failed/);
      assert.match(JSON.stringify((error as AggregateError).errors), /HUB_ASSIGNMENT_COMPENSATION_CONFLICT/);
      return true;
    },
  );

  const finalState = recordValue(JSON.parse(await readFile(statePath, "utf8")));
  assert.equal(finalState.status, "running");
  assert.equal(finalState.concurrentMutationAt, "2026-07-20T00:00:01.000Z");
  assert.equal(await fileExists(inboxPath), false);
});

test("SWE-bench batch enqueue rollback refuses to delete an inbox claim after attemptToken drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-enqueue-inbox-token-conflict-"));
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "sources", "django__django-13128");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  const record = recordFromDatasetRow(sampleRow, 13);
  const input = buildBatchAssignmentInput({
    record,
    row: sampleRow,
    sourcePath,
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    planMode: "full",
  });
  const abort = new AbortController();
  const inboxPath = path.join(hubRoot, "workers", "inbox", "worker-01", `a-${input.entryId}.json`);

  await assert.rejects(
    () => queueBatchAssignmentAtomically({
      hubRoot,
      workerId: "worker-01",
      input,
      sourcePath,
      metadata: {
        productValidation: true,
        benchmarkDataset: "SWE-bench/SWE-bench_Verified",
        benchmarkInstanceId: record.benchmarkInstanceId,
        batchQueuedAt: "2026-07-20T00:00:00.000Z",
      },
      skipCodeGraphGate: true,
      signal: abort.signal,
      hooks: {
        afterEnqueue: () => abort.abort(new DOMException("afterEnqueue abort", "AbortError")),
        concurrentDuringRollback: async () => {
          const inboxClaim = recordValue(JSON.parse(await readFile(inboxPath, "utf8")));
          inboxClaim.attemptToken = "tampered-token";
          inboxClaim.concurrentMutationAt = "2026-07-20T00:00:01.000Z";
          await writeFile(inboxPath, `${JSON.stringify(inboxClaim, null, 2)}\n`, "utf8");
        },
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(JSON.stringify((error as AggregateError).errors), /HUB_WORKER_INBOX_COMPENSATION_CONFLICT/);
      return true;
    },
  );

  const inboxClaim = recordValue(JSON.parse(await readFile(inboxPath, "utf8")));
  assert.equal(inboxClaim.attemptToken, "tampered-token");
  assert.equal(inboxClaim.concurrentMutationAt, "2026-07-20T00:00:01.000Z");
});

function exactLocalLockOwner(
  ownerToken: string,
  processIdentity: ProcessIdentity,
  acquiredAt = "2026-07-20T00:00:00.000Z",
) {
  return {
    ownerToken,
    pid: processIdentity.pid,
    host: os.hostname(),
    processIdentity,
    acquiredAt,
  };
}

test("local worker inbox lock recovers stale owner and publishes a frozen receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-inbox-stale-lock-"));
  const workerId = "worker-01";
  const assignmentId = "a-stale-lock";
  const store = new WorkerStore(root);
  await store.init();
  const lockDir = path.join(root, "workers", "inbox", workerId, `${assignmentId}.lock`);
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(exactLocalLockOwner(
    "dead-owner",
    testProcessIdentity(99999999, "dead-inbox-stale-lock"),
  ), null, 2)}\n`, "utf8");
  const old = new Date(Date.now() - 60_000);
  await utimes(lockDir, old, old);

  const payload: LooseRecord = {
    assignmentId,
    attempt: 1,
    attemptToken: "attempt-token-1",
    metadata: { generation: "original" },
  };
  const receipt = await store.writeInboxWithReceipt(workerId, payload);
  payload.metadata = { generation: "mutated-after-receipt" };

  assert.equal(receipt.backend, "local");
  assert.equal(receipt.ref, receipt.path);
  assert.match(String(receipt.path), new RegExp(`${assignmentId}\\.json$`));
  assert.equal(recordValue(receipt.committedRecord.metadata).generation, "original");
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.committedRecord), true);
  assert.equal((await readdir(lockDir)).some((entry) => entry.startsWith(".released-")), true);
  assert.equal(await store.compensateInboxReceipt(receipt), true);
  assert.equal(await fileExists(String(receipt.path)), false);
  assert.equal(await fileExists(`${String(receipt.path)}.write-owner`), false);
  assert.equal((await readdir(lockDir)).some((entry) => entry.startsWith(".released-")), true);
});

test("local worker inbox normalizes JSON before commit and fences same-value successors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-inbox-json-fence-"));
  const workerId = "worker-01";
  const store = new WorkerStore(root);
  await store.init();

  const normalized = await store.writeInboxWithReceipt(workerId, {
    assignmentId: "a-normalized",
    attempt: 1,
    attemptToken: "normalized-token",
    metadata: { kept: true, omitted: undefined },
  });
  assert.equal(Object.hasOwn(recordValue(normalized.committedRecord.metadata), "omitted"), false);
  assert.deepEqual(
    recordValue(JSON.parse(await readFile(String(normalized.path), "utf8"))),
    normalized.committedRecord,
  );
  assert.equal(await store.compensateInboxReceipt(normalized), true);

  const fenced = await store.writeInboxWithReceipt(workerId, {
    assignmentId: "a-same-value",
    attempt: 1,
    attemptToken: "same-value-token",
    metadata: { stable: true },
  });
  if (fenced.writeFence.backend !== "local") throw new Error("expected local worker inbox write fence");
  const successorOwner = { ...fenced.writeFence.committedOwner, ownerToken: "same-value-successor" };
  await writeFile(
    `${String(fenced.path)}.write-owner`,
    `${JSON.stringify(successorOwner, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    () => store.compensateInboxReceipt(fenced),
    (error: unknown) => recordValue(error).code === "HUB_WORKER_INBOX_COMPENSATION_CONFLICT",
  );
  assert.deepEqual(
    recordValue(JSON.parse(await readFile(String(fenced.path), "utf8"))),
    fenced.committedRecord,
  );

  const functionPath = path.join(root, "workers", "inbox", workerId, "a-uncloneable.json");
  await assert.rejects(
    () => store.writeInboxWithReceipt(workerId, {
      assignmentId: "a-uncloneable",
      attempt: 1,
      attemptToken: "uncloneable-token",
      callback: () => true,
    }),
    (error: unknown) => recordValue(error).code === "HUB_WORKER_INBOX_PAYLOAD_INVALID",
  );
  assert.equal(await fileExists(functionPath), false);

  assert.deepEqual(await store.readInbox("missing-worker"), []);
  const malformedDir = path.join(root, "workers", "inbox", "malformed-worker");
  await mkdir(malformedDir, { recursive: true });
  await writeFile(path.join(malformedDir, "broken.json"), "{not-json", "utf8");
  await assert.rejects(() => store.readInbox("malformed-worker"), SyntaxError);
});

test("local worker inbox lock owner and write-owner failures self-clean before receipt", async (t) => {
  await t.test("lock owner write failure removes the mkdir claim", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-lock-owner-fault-"));
    const store = new WorkerStore(root);
    await store.init();
    const lockDir = path.join(root, "workers", "inbox", "worker-01", "a-owner-fault.lock");
    __workerStoreTestHooks.afterLocalInboxLockMkdir = () => {
      throw Object.assign(new Error("lock owner write fault"), { code: "TEST_LOCK_OWNER_FAULT" });
    };
    try {
      await assert.rejects(
        () => store.writeInboxWithReceipt("worker-01", {
          assignmentId: "a-owner-fault",
          attempt: 1,
          attemptToken: "owner-fault-token",
        }),
        /lock owner write fault/,
      );
    } finally {
      __workerStoreTestHooks.afterLocalInboxLockMkdir = undefined;
    }
    await assert.rejects(() => readdir(lockDir), /ENOENT/);
  });

  await t.test("inbox write-owner failure restores the payload before rejecting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-write-owner-fault-"));
    const store = new WorkerStore(root);
    await store.init();
    const filePath = path.join(root, "workers", "inbox", "worker-01", "a-write-owner-fault.json");
    __workerStoreTestHooks.beforeLocalInboxWriteOwner = () => {
      throw Object.assign(new Error("inbox write owner fault"), { code: "TEST_INBOX_OWNER_FAULT" });
    };
    try {
      await assert.rejects(
        () => store.writeInboxWithReceipt("worker-01", {
          assignmentId: "a-write-owner-fault",
          attempt: 1,
          attemptToken: "write-owner-fault-token",
        }),
        /inbox write owner fault/,
      );
    } finally {
      __workerStoreTestHooks.beforeLocalInboxWriteOwner = undefined;
    }
    assert.equal(await fileExists(filePath), false);
    assert.equal(await fileExists(`${filePath}.write-owner`), false);
  });
});

test("local worker inbox lock preserves ABA successors during stale recovery and release", async (t) => {
  await t.test("stale quarantine revalidates the renamed owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-stale-aba-"));
    const workerId = "worker-01";
    const assignmentId = "a-stale-aba";
    const store = new WorkerStore(root);
    await store.init();
    const currentIdentity = store._captureCurrentProcessIdentity();
    const lockDir = path.join(root, "workers", "inbox", workerId, `${assignmentId}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(exactLocalLockOwner(
      "stale-owner",
      testProcessIdentity(99999999, "dead-inbox-stale-aba"),
    ))}\n`, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);
    __workerStoreTestHooks.beforeLocalInboxLockQuarantineRename = async ({ kind }) => {
      if (kind !== "stale") return;
      __workerStoreTestHooks.beforeLocalInboxLockQuarantineRename = undefined;
      await rename(lockDir, `${lockDir}.retired-test-owner`);
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(exactLocalLockOwner(
        "stale-successor",
        currentIdentity,
        new Date().toISOString(),
      ))}\n`, "utf8");
    };
    try {
      await assert.rejects(
        () => store.writeInboxWithReceipt(workerId, {
          assignmentId,
          attempt: 1,
          attemptToken: "stale-aba-token",
        }),
        (error: unknown) => recordValue(error).code === "HUB_WORKER_INBOX_LOCK_CONFLICT",
      );
    } finally {
      __workerStoreTestHooks.beforeLocalInboxLockQuarantineRename = undefined;
    }
    const successor = recordValue(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")));
    assert.equal(successor.ownerToken, "stale-successor");
  });

  await t.test("release marker revalidates token without removing the fixed successor path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-release-aba-"));
    const workerId = "worker-01";
    const assignmentId = "a-release-aba";
    const store = new WorkerStore(root);
    await store.init();
    const currentIdentity = store._captureCurrentProcessIdentity();
    const lockDir = path.join(root, "workers", "inbox", workerId, `${assignmentId}.lock`);
    __workerStoreTestHooks.beforeLocalInboxLockReleaseMarker = async () => {
      __workerStoreTestHooks.beforeLocalInboxLockReleaseMarker = undefined;
      await rename(lockDir, `${lockDir}.retired-test-owner`);
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(exactLocalLockOwner(
        "release-successor",
        currentIdentity,
        new Date().toISOString(),
      ))}\n`, "utf8");
    };
    try {
      await assert.rejects(
        () => store._withLocalInboxLock(workerId, assignmentId, async () => true),
        (error: unknown) => recordValue(error).code === "HUB_WORKER_INBOX_LOCK_CONFLICT",
      );
    } finally {
      __workerStoreTestHooks.beforeLocalInboxLockReleaseMarker = undefined;
    }
    const successor = recordValue(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")));
    assert.equal(successor.ownerToken, "release-successor");
    assert.equal((await readdir(lockDir)).includes("owner.json"), true);
  });

  await t.test("quarantine refuses to isolate a successor installed before the rename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-quarantine-gap-"));
    const workerId = "worker-01";
    const assignmentId = "a-quarantine-gap";
    const store = new WorkerStore(root);
    await store.init();
    const currentIdentity = store._captureCurrentProcessIdentity();
    const lockDir = path.join(root, "workers", "inbox", workerId, `${assignmentId}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(exactLocalLockOwner(
      "stale-owner",
      testProcessIdentity(99999999, "dead-inbox-quarantine-gap"),
    ))}\n`, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);
    __workerStoreTestHooks.beforeLocalInboxLockQuarantineRename = async ({ kind }) => {
      if (kind !== "stale") return;
      __workerStoreTestHooks.beforeLocalInboxLockQuarantineRename = undefined;
      await rename(lockDir, `${lockDir}.retired-stale-owner`);
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(exactLocalLockOwner(
        "second-owner",
        currentIdentity,
        new Date().toISOString(),
      ))}\n`, "utf8");
    };
    let afterQuarantineRan = false;
    __workerStoreTestHooks.afterLocalInboxLockQuarantineRename = async () => {
      afterQuarantineRan = true;
      __workerStoreTestHooks.afterLocalInboxLockQuarantineRename = undefined;
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(exactLocalLockOwner(
        "third-owner",
        currentIdentity,
        new Date().toISOString(),
      ))}\n`, "utf8");
    };
    try {
      await assert.rejects(
        () => store.writeInboxWithReceipt(workerId, {
          assignmentId,
          attempt: 1,
          attemptToken: "quarantine-gap-token",
        }),
        (error: unknown) => recordValue(error).code === "HUB_WORKER_INBOX_LOCK_CONFLICT",
      );
    } finally {
      __workerStoreTestHooks.beforeLocalInboxLockQuarantineRename = undefined;
      __workerStoreTestHooks.afterLocalInboxLockQuarantineRename = undefined;
    }
    const fixedOwner = recordValue(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")));
    assert.equal(fixedOwner.ownerToken, "second-owner");
    assert.equal(afterQuarantineRan, false);
    const parentEntries = await readdir(path.dirname(lockDir));
    const quarantineName = parentEntries.find((entry) => entry.startsWith(`${path.basename(lockDir)}.stale-`));
    assert.equal(quarantineName, undefined);
    const retiredOwner = recordValue(JSON.parse(await readFile(
      `${lockDir}.retired-stale-owner/owner.json`,
      "utf8",
    )));
    assert.equal(retiredOwner.ownerToken, "stale-owner");
  });
});

test("local worker inbox lock recovery fails closed on unknown liveness and unsafe paths", async (t) => {
  const liveOwner = exactLocalLockOwner(
    "worker-live-owner",
    testProcessIdentity(424242, "worker-live-owner"),
  );

  for (const code of ["EPERM", "EIO"]) {
    await t.test(`process liveness ${code}`, () => {
      const store = new WorkerStore(path.join(os.tmpdir(), `cpb-worker-liveness-${code}`));
      __workerStoreTestHooks.isLocalInboxProcessIdentityAlive = () => { throw errno(code); };
      try {
        assert.throws(
          () => store._localInboxLockOwnerAlive(liveOwner),
          (error: unknown) => recordValue(error).code === "HUB_WORKER_INBOX_LOCK_CONFLICT",
        );
      } finally {
        __workerStoreTestHooks.isLocalInboxProcessIdentityAlive = undefined;
      }
    });
  }

  await t.test("legacy owner without exact identity is rejected and preserved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-legacy-lock-"));
    const workerId = "worker-01";
    const assignmentId = "a-legacy-lock";
    const store = new WorkerStore(root);
    await store.init();
    const lockDir = path.join(root, "workers", "inbox", workerId, `${assignmentId}.lock`);
    const legacyOwner = {
      ownerToken: "legacy-owner",
      pid: 99999999,
      host: os.hostname(),
      acquiredAt: "2026-07-20T00:00:00.000Z",
    };
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(legacyOwner, null, 2)}\n`, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);

    await assert.rejects(
      () => store.writeInboxWithReceipt(workerId, {
        assignmentId,
        attempt: 1,
        attemptToken: "legacy-lock-token",
      }),
      /worker inbox lock busy/,
    );
    assert.deepEqual(
      recordValue(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"))),
      legacyOwner,
    );
  });

  await t.test("corrupt owner is not reclaimed as incomplete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-corrupt-lock-"));
    const store = new WorkerStore(root);
    await store.init();
    const lockDir = path.join(root, "workers", "inbox", "worker-01", "a-corrupt.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), "{not-json", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);
    await assert.rejects(
      () => store._localInboxLockRecoveryCandidate(lockDir, path.join(lockDir, "owner.json")),
      (error: unknown) => recordValue(error).code === "HUB_WORKER_INBOX_LOCK_CONFLICT",
    );
    assert.equal((await lstat(lockDir)).isDirectory(), true);
  });

  for (const kind of ["symlink", "file"] as const) {
    await t.test(`${kind} lock path is rejected without following it`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `cpb-worker-${kind}-lock-`));
      const store = new WorkerStore(root);
      await store.init();
      const workerDir = path.join(root, "workers", "inbox", "worker-01");
      const lockDir = path.join(workerDir, `a-${kind}.lock`);
      await mkdir(workerDir, { recursive: true });
      if (kind === "symlink") {
        const target = path.join(root, "outside-lock-target");
        await mkdir(target);
        await writeFile(path.join(target, "owner.json"), `${JSON.stringify(exactLocalLockOwner(
          "symlink-target-owner",
          testProcessIdentity(99999999, "dead-inbox-symlink-target"),
        ))}\n`, "utf8");
        const old = new Date(Date.now() - 60_000);
        await utimes(target, old, old);
        await symlink(target, lockDir);
      } else {
        await writeFile(lockDir, "not a lock directory", "utf8");
      }
      await assert.rejects(
        () => store._localInboxLockRecoveryCandidate(lockDir, path.join(lockDir, "owner.json")),
        (error: unknown) => recordValue(error).code === "HUB_WORKER_INBOX_LOCK_CONFLICT",
      );
      const preserved = await lstat(lockDir);
      assert.equal(kind === "symlink" ? preserved.isSymbolicLink() : preserved.isFile(), true);
    });
  }
});

test("SWE-bench batch queue exposes explicit local inbox backend contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-inbox-contract-"));
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "sources", "django__django-13128");
  await mkdir(sourcePath, { recursive: true });
  const record = recordFromDatasetRow(sampleRow, 19);
  const input = buildBatchAssignmentInput({
    record,
    row: sampleRow,
    sourcePath,
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
    planMode: "full",
  });

  const result = await queueBatchAssignmentAtomically({
    hubRoot,
    workerId: "worker-01",
    input,
    sourcePath,
    metadata: { productValidation: true },
    skipCodeGraphGate: true,
  });

  assert.equal(result.inboxBackend, "local");
  assert.equal(result.inboxPath, result.inboxRef);
  assert.match(String(result.inboxPath), /a-django-django-13128\.json$/);
  assert.notEqual(result.inboxPath, "");
});

test("SWE-bench batch queue does not weaken CodeGraph readiness", () => {
  assert.doesNotMatch(batchQueueSource, /CPB_CODEGRAPH_INDEX_ONLY_OK/);
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
  assert.equal(assignment.assignmentId, "a-timeout-one");
  assert.equal(assignment.projectId, "swebench-timeout-one");
  const attempt = await store.createAttempt(String(assignment.assignmentId), {
    workerId: "w-timeout",
    orchestratorEpoch: 1,
  });
  assert.equal(attempt.assignmentId, assignment.assignmentId);
  assert.equal(attempt.projectId, assignment.projectId);

  const states = await waitForAssignments(root, [{ assignmentId: assignment.assignmentId }], {
    intervalMs: 1,
    timeoutMs: 1,
    reason: "unit_timeout",
  });

  assert.equal(states[0]?.status, "failed");
  assert.equal((await store.getAssignment(String(assignment.assignmentId)))?.status, "failed");
  const resultPath = path.join(root, "assignments", String(assignment.assignmentId), "attempts", "001", "result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(result.attemptToken, attempt.attemptToken);
  assert.equal(result.orchestratorEpoch, attempt.orchestratorEpoch);
  assert.equal(result.failureKind, "unit_timeout");
});

test("SWE-bench batch wait refuses to terminalize a stale assignment identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-swebench-wait-stale-identity-"));
  const store = new AssignmentStore(root);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: "timeout-stale-identity",
    projectId: "swebench-timeout-stale-identity",
    task: "stale assignment identity",
    sourcePath: root,
  });
  const assignmentId = String(assignment.assignmentId);
  await store.createAttempt(assignmentId, {
    workerId: "w-timeout-stale-identity",
    orchestratorEpoch: 7,
  });
  const statePath = path.join(root, "assignments", assignmentId, "state.json");
  const state = recordValue(JSON.parse(await readFile(statePath, "utf8")));
  state.assignmentId = "a-successor-identity";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await assert.rejects(
    () => waitForAssignments(root, [{ assignmentId }], {
      intervalMs: 1,
      timeoutMs: 1,
      reason: "unit_timeout",
    }),
    (error: unknown) => recordValue(error).code === "BATCH_WAIT_ATTEMPT_IDENTITY_INVALID",
  );
  assert.equal(await fileExists(path.join(
    root,
    "assignments",
    assignmentId,
    "attempts",
    "001",
    "result.json",
  )), false);
  assert.equal(recordValue(JSON.parse(await readFile(statePath, "utf8"))).status, "assigned");
});

test("SWE-bench batch report preserves but rejects synthetic timeout terminal state", async () => {
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
  assert.equal(recordValue(report.validation).valid, false);
  assert.match(String(recordValue(report.validation).violations), /synthetic batch timeout terminal state/);
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

test("SWE-bench command retry aborts during backoff and never starts another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  let observedSignal = false;

  const pending = runRequiredWithRetries("git", ["fetch", "origin"], "/tmp/repo", {
    attempts: 3,
    retryDelayMs: 10_000,
    signal: controller.signal,
    runner: async (_command, _args, _cwd, _timeoutMs, options) => {
      calls += 1;
      observedSignal = options?.signal === controller.signal;
      return { stdout: "", stderr: "transient", code: 128 };
    },
  });
  setTimeout(() => controller.abort(new Error("abort fetch retry")), 0);

  await assert.rejects(pending, /abort fetch retry/);
  assert.equal(observedSignal, true);
  assert.equal(calls, 1);
});

test("SWE-bench command retry does not invoke its runner when pre-aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("pre-aborted fetch"));
  let calls = 0;

  await assert.rejects(
    runRequiredWithRetries("git", ["fetch", "origin"], "/tmp/repo", {
      signal: controller.signal,
      runner: async () => {
        calls += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
    }),
    /pre-aborted fetch/,
  );
  assert.equal(calls, 0);
});
