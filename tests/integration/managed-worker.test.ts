import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { createIsolatedWorktreeWithRetry } from "../../runtime/worker/worktree-manager.js";
import { finalizeAndWriteSuccessfulResult } from "../../runtime/worker/assignment-finalizer.js";
import {
  buildFinalizerMutationFence,
  completeAssignmentStateFromResult,
  executionLeaseRenewalLost,
  finalizerFailureEvidenceFromError,
  redactedWorkerErrorMessage,
  shouldRetainWorkerWorktree,
  shouldCompleteInboxClaimAfterTerminalSync,
  verifyFinalizerRecoveryPriorAttempt,
} from "../../runtime/worker/managed-worker.js";
import { finalizerMutationFenceDigest } from "../../server/services/finalizer-contract.js";
import { registerProject } from "../../server/services/hub/hub-registry.js";
import { getJob } from "../../server/services/job/job-store.js";
import { AssignmentStore } from "../../shared/orchestrator/assignment-store.js";
import type { ProcessIdentity } from "../../core/runtime/process-tree.js";
import { recordValue } from "../../core/contracts/types.js";
import { readJson, tempRoot, writeJson } from "../helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const workerScript = path.join(repoRoot, "runtime", "worker", "managed-worker.js");
const testAgentScript = path.join(repoRoot, "tests", "fixtures", "test-acp-agent.js");
const execFile = promisify(execFileCallback);

test("managed worker stops before inbox ownership can expire", () => {
  assert.equal(executionLeaseRenewalLost({ renewed: true }), false);
  assert.equal(executionLeaseRenewalLost({ renewed: false }), true);
  assert.equal(executionLeaseRenewalLost({ errored: true, errorCode: "STALE_ATTEMPT" }), true);
  assert.equal(executionLeaseRenewalLost({ errored: true, errorCode: "HUB_WORKER_BROKER_OPERATION_DENIED" }), true);
  assert.equal(executionLeaseRenewalLost({ errored: true, elapsedSinceSuccessMs: 49_999 }), false);
  assert.equal(executionLeaseRenewalLost({ errored: true, elapsedSinceSuccessMs: 50_000 }), true);
});

test("managed worker only accepts a journal takeover backed by a durable terminal attempt", async () => {
  const worktreePath = await tempRoot("cpb-finalizer-prior-worktree");
  await execFile("git", ["init", "-b", "main"], { cwd: worktreePath });
  await execFile("git", ["config", "user.email", "cpb@example.test"], { cwd: worktreePath });
  await execFile("git", ["config", "user.name", "CPB Test"], { cwd: worktreePath });
  await writeFile(path.join(worktreePath, "candidate.txt"), "candidate\n", "utf8");
  await execFile("git", ["add", "candidate.txt"], { cwd: worktreePath });
  await execFile("git", ["commit", "-m", "candidate"], { cwd: worktreePath });
  const candidateHead = (await execFile("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
  const candidateTree = (await execFile("git", ["rev-parse", "HEAD^{tree}"], { cwd: worktreePath })).stdout.trim();
  const candidateIdentity = `sha256:${"e".repeat(64)}`;
  const candidateValidation = {
    baseSha: candidateHead,
    headSha: candidateHead,
    treeHash: candidateTree,
    identityHash: candidateIdentity,
    validatedCandidateIdentityHash: candidateIdentity,
    identityMatch: true,
    cleanReplay: {
      cleanApply: true,
      baseSha: candidateHead,
      expectedTreeHash: candidateTree,
      actualTreeHash: candidateTree,
    },
  };
  const canonicalDigest = (value: unknown) => {
    const canonical = (nested: unknown): unknown => {
      if (Array.isArray(nested)) return nested.map(canonical);
      if (!nested || typeof nested !== "object") return nested;
      return Object.fromEntries(Object.entries(nested as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]));
    };
    return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
  };
  const ownerFence = {
    assignmentId: "a-finalizer",
    entryId: "entry-finalizer",
    attemptToken: "attempt-token-2",
    orchestratorEpoch: 7,
    workerId: "worker-2",
    workerIncarnation: "worker-incarnation-2",
    processIdentity: { pid: 1202, startTimeTicks: "9002" },
  };
  const ownerDigest = finalizerMutationFenceDigest(ownerFence);
  const remoteIntent = {
    schema: "cpb.finalizer-mutation-receipt.v1",
    finalizationId: "f".repeat(64),
    generation: 1,
    project: "proj",
    entryId: "entry-finalizer",
    originJobId: "job-finalizer-a2",
    mode: "remote",
    stage: "claimed",
    source: { branch: "main", head: candidateHead },
    targetBranch: "main",
    preRemoteHead: candidateHead,
    commit: candidateHead,
    tree: candidateTree,
    claim: {
      claimId: "d".repeat(64),
      claimGeneration: 1,
      ownerDigest,
    },
    receipts: {},
  };
  const evidence = {
    schema: "cpb.finalizer-handoff-evidence.v1",
    previousAssignmentId: "a-finalizer",
    previousAttempt: 2,
    previousAttemptTokenDigest: createHash("sha256").update("attempt-token-2").digest("hex"),
    previousOrchestratorEpoch: 7,
    previousJobId: "job-finalizer-a2",
    previousResultStatus: "blocked",
    previousCommitted: false,
    finalizationId: "f".repeat(64),
    journalGeneration: 1,
    previousClaimId: "d".repeat(64),
    previousOwnerDigest: ownerDigest,
    journalStage: "claimed",
    journalDigest: canonicalDigest(remoteIntent),
    commit: candidateHead,
    tree: candidateTree,
  };
  const evidenceId = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  const priorAttempt = {
    assignmentId: "a-finalizer",
    attempt: 2,
    attemptToken: "attempt-token-2",
    orchestratorEpoch: 7,
    workerId: "worker-2",
    status: "blocked",
    heartbeat: {
      workerId: "worker-2",
      workerIncarnation: "worker-incarnation-2",
      processIdentity: {
        pid: 1202,
        startTimeTicks: "9002",
        birthIdPrecision: "exact",
      },
      worktreePath,
    },
    result: {
      assignmentId: "a-finalizer",
      attempt: 2,
      attemptToken: "attempt-token-2",
      status: "blocked",
      jobResult: {
        status: "blocked",
        jobId: "job-finalizer-a2",
        completionGate: {
          outcome: "complete",
          completionReport: { candidateValidation },
        },
      },
      finalizeResult: {
        ok: false,
        status: "blocked",
        mode: "remote",
        jobId: "job-finalizer-a2",
        committed: false,
        commit: candidateHead,
        tree: candidateTree,
        remoteIntent,
        reconciliation: {
          journal: {
            stage: "claimed",
            generation: 1,
            claimId: "d".repeat(64),
            remoteMutationStarted: false,
          },
        },
        safeContinuation: {
          schema: "cpb.finalizer-safe-continuation.v1",
          finalizationId: "f".repeat(64),
          journalDigest: canonicalDigest(remoteIntent),
          journalGeneration: 1,
          stage: "claimed",
          operation: "repository.push",
          decision: false,
          readbackKey: "journal",
          readbackDigest: canonicalDigest({
            stage: "claimed",
            generation: 1,
            claimId: "d".repeat(64),
            remoteMutationStarted: false,
          }),
        },
      },
    },
  };
  const observationEvidence = {
    schema: "cpb.finalizer-observation-evidence.v1",
    assignmentId: "a-finalizer",
    attempt: 2,
    attemptTokenDigest: createHash("sha256").update("attempt-token-2").digest("hex"),
    orchestratorEpoch: 7,
    workerId: "worker-2",
    workerIncarnation: "worker-incarnation-2",
    processIdentity: { pid: 1202, startTimeTicks: "9002" },
    jobId: "job-finalizer-a2",
    resultStatus: "blocked",
    committed: false,
    claimId: "d".repeat(64),
    ownerDigest,
    journalDigest: canonicalDigest(remoteIntent),
    finalizeResultDigest: canonicalDigest(recordValue(priorAttempt.result).finalizeResult),
  };
  const common = {
    assignmentId: "a-finalizer",
    entryId: "entry-finalizer",
    attemptToken: "attempt-token-3",
    orchestratorEpoch: 8,
    workerId: "worker-finalizer",
    workerIncarnation: "worker-incarnation-3",
    processIdentity: {
      pid: 1234,
      birthId: "987654",
      incarnation: "1234:987654",
      capturedAt: "2026-07-22T02:01:00.000Z",
      birthIdPrecision: "exact" as const,
    },
  };
  const recovery = {
    schema: "cpb.finalizer-recovery.v1",
    required: true,
    allowMutation: true,
    committed: false,
    mode: "remote",
    safePartialContinuation: true,
    previousAssignmentId: "a-finalizer",
    previousAttempt: 2,
    previousJobId: "job-finalizer-a2",
    originJobId: "job-finalizer-a2",
    previousClaimId: "d".repeat(64),
    priorAttemptProof: {
      schema: "cpb.finalizer-handoff.v1",
      kind: "explicit-handoff",
      previousClaimId: "d".repeat(64),
      evidenceId,
      observedAt: "2026-07-22T02:00:00.000Z",
      acceptedOwnerDigest: ownerDigest,
      journalBinding: {
        source: remoteIntent.source,
        targetBranch: "main",
        preRemoteHead: candidateHead,
      },
      evidence,
    },
    lastObservationProof: {
      schema: "cpb.finalizer-observation-proof.v1",
      evidence: observationEvidence,
      evidenceId: canonicalDigest(observationEvidence),
      observedAt: "2026-07-22T02:00:00.000Z",
    },
    takeover: {
      schema: "cpb.finalizer-handoff.v1",
      kind: "explicit-handoff",
      previousClaimId: "d".repeat(64),
      evidenceId,
      observedAt: "2026-07-22T02:00:00.000Z",
      evidence,
    },
  };
  const verifiedPriorAttempt = await verifyFinalizerRecoveryPriorAttempt({
    assignmentStore: { getAttempt: async () => priorAttempt },
    assignmentId: "a-finalizer",
    entryId: "entry-finalizer",
    recovery,
  });
  assert.ok(verifiedPriorAttempt);
  assert.equal(await verifyFinalizerRecoveryPriorAttempt({
    assignmentStore: { getAttempt: async () => priorAttempt },
    assignmentId: "a-finalizer",
    entryId: "entry-finalizer",
    recovery: { ...recovery, originJobId: "job-forged-origin" },
  }), null);
  const fence = buildFinalizerMutationFence({
    ...common,
    finalizerRecovery: recovery,
    verifiedPriorAttempt,
  });
  assert.deepEqual(fence.takeover, {
    kind: "explicit-handoff",
    previousClaimId: "d".repeat(64),
    evidenceId,
    observedAt: "2026-07-22T02:00:00.000Z",
  });

  assert.throws(
    () => buildFinalizerMutationFence({
      ...common,
      verifiedPriorAttempt,
      finalizerRecovery: {
        ...recovery,
        takeover: { ...recovery.takeover, evidenceId: "0".repeat(64) },
      },
    }),
    (error: unknown) => recordValue(error).code === "MUTATION_FENCE_INVALID",
  );
});

test("managed worker fail-closes inbox claim when terminal assignment sync fails", async () => {
  const attemptDir = await tempRoot("cpb-managed-terminal-sync");
  await writeJson(path.join(attemptDir, "result.json"), {
    assignmentId: "a-terminal-sync",
    attempt: 1,
    attemptToken: "tok-terminal-sync",
    status: "completed",
  });

  const errors = [];
  const failedSync = await completeAssignmentStateFromResult({
    assignmentStore: {
      completeAttemptAndAckInbox: async () => {
        throw Object.assign(new Error("durable assignment store unavailable"), {
          code: "HUB_STATE_UNAVAILABLE",
        });
      },
    } as any,
    assignmentId: "a-terminal-sync",
    attemptNum: 1,
    attemptDir,
    workerId: "w-terminal-sync",
    claimToken: "claim-terminal-sync",
    log: { error: (message) => errors.push(message) } as any,
  });

  assert.equal(failedSync.result, null);
  assert.equal(failedSync.inboxAcked, false);
  assert.equal(failedSync.terminalSyncFailed, true);
  assert.equal(shouldCompleteInboxClaimAfterTerminalSync(failedSync), false);
  assert.match(errors[0], /failed to sync terminal assignment state/);

  const staleSync = await completeAssignmentStateFromResult({
    assignmentStore: {
      completeAttemptAndAckInbox: async () => {
        throw Object.assign(new Error("worker inbox claim is no longer active"), {
          code: "STALE_INBOX_CLAIM",
        });
      },
    } as any,
    assignmentId: "a-terminal-sync",
    attemptNum: 1,
    attemptDir,
    workerId: "w-terminal-sync",
    claimToken: "claim-terminal-sync",
    log: { error: () => {} } as any,
  });
  assert.equal(staleSync.terminalSyncFailed, true);
  assert.equal(staleSync.mutationOwnershipLost, true);
  assert.equal(shouldCompleteInboxClaimAfterTerminalSync(staleSync), false);
});

test("managed worker redacts finalizer errors while retaining partial mutation receipts", () => {
  const evidence = finalizerFailureEvidenceFromError(Object.assign(
    new Error("Bearer leaked-worker-token"),
    {
      finalizeResult: {
        ok: false,
        status: "blocked",
        code: "ASSIGNMENT_CANCELLED",
        mode: "remote",
        jobId: "job-partial",
        committed: null,
        retryable: true,
        reason: "Bearer leaked-worker-token",
        remoteIntent: {
          finalizationId: "f".repeat(64),
          generation: 2,
          stage: "issue.close",
        },
        remoteWrites: {
          push: { attempted: true, committed: true },
          issueClose: { attempted: false, committed: null },
        },
      },
    },
  ));

  assert.equal(evidence?.mode, "remote");
  assert.equal(evidence?.jobId, "job-partial");
  assert.equal(evidence?.committed, null);
  assert.equal(recordValue(recordValue(evidence?.remoteWrites).push).committed, true);
  assert.equal(evidence?.reason, "Bearer [REDACTED]");
  assert.equal(redactedWorkerErrorMessage("token=leaked-worker-token"), "token=[REDACTED]");
});

function jsonEnvelope(data) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

async function waitFor(assertion, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await assertion();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error("condition timed out");
}

function spawnWorker({ workerId, hubRoot, cpbRoot, env = {}, timeoutMs = 30_000, once = true, script = workerScript }) {
  const args = [
    script,
    "--worker-id", workerId,
    "--hub-root", hubRoot,
    "--cpb-root", cpbRoot,
  ];
  if (once) args.push("--once");
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CPB_ACP_USE_MANAGED_POOL: "0",
      CPB_ACP_PERSISTENT_PROCESS: "0",
      CPB_ACP_TIMEOUT_MS: "30000",
      CPB_ACP_PHASE_TIMEOUT_MS: "30000",
      CPB_ACP_POOL_TIMEOUT_MS: "30000",
      CPB_PHASE_RETRY_MAX: "0",
      CPB_PHASE_FEEDBACK_RETRY_MAX: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`managed worker timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });

  return { child, done, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function sandboxTempEnv(root: string) {
  return {
    TMPDIR: root,
    TEMP: root,
    TMP: root,
  };
}

async function listJsonFiles(dir) {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function readJsonl(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function testProcessIdentity(pid: number, birthId = `birth-${pid}`): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: new Date().toISOString(),
    birthIdPrecision: "exact",
    processGroupId: pid,
  };
}

async function readJobAcpAudit(projectRuntimeRoot: string, projectId: string, jobId: string) {
  return readJsonl(path.join(projectRuntimeRoot, "acp-audit", projectId, `${jobId}.jsonl`));
}

async function writeWorkerScenario(root) {
  const scenarioPath = path.join(root, "scenario.json");
  await writeJson(scenarioPath, {
    responses: [
      {
        name: "decompose",
        matchRegex: "decomposing a task into structured acceptance-checklist items",
        output: jsonEnvelope({
          status: "ok",
          decomposedItems: [
            {
              requirement: "README.md is updated by the managed worker fake ACP execution.",
              predicateId: "managed-readme-change",
              verificationMethod: "static",
              allowedFiles: ["README.md"],
              sourceRefs: [{ kind: "task_text", locator: "task:0" }],
              expectedEvidence: "static scope probe confirming README.md was modified",
            },
          ],
        }),
      },
      {
        name: "plan",
        matchRegex: "software planning agent",
        output: jsonEnvelope({
          status: "ok",
          planMarkdown: [
            "## Analysis",
            "- Exercise managed worker with fake ACP.",
            "",
            "## Bounded Handoff",
            "- Real actors: managed worker fake ACP assignment and README.md",
            "- Entrypoints: worker assignment execution path",
            "- Bypass candidates: dry-run PR preview and checklist decomposition paths",
            "- Edit files: README.md",
            "- Verification targets: Worker lifecycle test",
            "- Blockers: none",
            "",
            "## Files to modify",
            "- README.md",
            "",
            "## Implementation Steps",
            "1. Keep the fixture source stable.",
            "",
            "## Testing",
            "- Worker lifecycle test",
            "",
            "## Risks",
            "- Fixture only.",
          ].join("\n"),
        }),
      },
      {
        name: "execute",
        matchRegex: "software execution agent",
        writes: [
          {
            // {{worktree}} resolves to the real task worktree (not {{cwd}},
            // which under the one-shot provider path is CPB_ROOT and gets the
            // write silently dropped). Writing README.md into the worktree makes
            // the deterministic verify probe observe matchCount=1 for AC-001.
            path: "{{worktree}}/README.md",
            content: "# Managed Worker Fixture\n\nFake ACP touched this file.\n",
          },
        ],
        output: jsonEnvelope({
          status: "ok",
          summary: "Fake ACP completed the managed worker fixture and referenced README.md.",
          tests: ["tests/managed-worker.test.js"],
          risks: ["No source edits are expected."],
          // Map the one file we changed (README.md, written into the worktree
          // above) to the single required checklist item AC-001. Without this,
          // execute's execution-map reports README.md as an UNMAPPED changed
          // file and the completion gate returns scope_violation, failing the
          // job even when the verify probe correctly observes the change.
          checklistMapping: [
            { checklistId: "AC-001", changedFiles: ["README.md"] },
          ],
        }),
      },
      {
        name: "verify",
        matchRegex: "software verification agent",
        output: jsonEnvelope({
          status: "ok",
          verdict: "pass",
          reason: "Managed worker fake ACP fixture passed.",
          details: "Plan, execute, and verify completed through the registered fake-acp provider.",
          confidence: 1,
          // Checklist-aware jobs REQUIRE a checklistVerdict; a bare legacy
          // {verdict:"pass"} is synthesized to a failing verdict and fails the
          // verify phase (core/phases/verify.ts fail-closed). The injected
          // checklist has one required static item AC-001 whose probe observes
          // matchCount=1 (README.md was written into the worktree by execute),
          // emitting exactly one ledger entry EV-001 result:"pass". We cite it
          // via the placeholder ledgerId "pending" — verify.ts remapEvidenceRefs
          // rewrites it to evidence-ledger-job-managed-success.
          checklistVerdict: {
            schemaVersion: 1,
            status: "pass",
            items: [
              {
                checklistId: "AC-001",
                result: "pass",
                evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
                actualResult: "README.md was written into the worktree, matching the item's allowedFiles scope.",
                reason: "Deterministic static probe observed matchCount=1 for README.md.",
                fixScope: [],
              },
            ],
            blocking: [],
            fixScope: [],
            reason: "All required acceptance checklist items passed with objective scope evidence.",
          },
        }),
      },
    ],
  });
  return scenarioPath;
}

test("managed worker only retains worktrees for explicit product validation runs", () => {
  assert.equal(shouldRetainWorkerWorktree({}), false);
  assert.equal(shouldRetainWorkerWorktree({ CPB_PRODUCT_VALIDATION_KEEP_WORKTREE: "0" }), false);
  assert.equal(shouldRetainWorkerWorktree({ CPB_PRODUCT_VALIDATION_KEEP_WORKTREE: "1" }), true);
});


test("managed worker stays alive in persistent mode with an empty inbox", async () => {
  const hubRoot = await tempRoot("cpb-managed-empty-inbox");
  const cpbRoot = await tempRoot("cpb-managed-empty-cpb");
  const workerId = "w-empty";
  const worker = spawnWorker({ workerId, hubRoot, cpbRoot, once: false, timeoutMs: 5_000 });

  try {
    const registry = await waitFor(
      async () => readJson(path.join(hubRoot, "workers", "registry", `worker-${workerId}.json`)),
      { timeoutMs: 3_000 },
    );
    assert.equal(registry.status, "ready");
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(worker.child.exitCode, null, worker.stderr);
  } finally {
    worker.child.kill("SIGTERM");
    await worker.done.catch(() => null);
  }
});

test("managed worker exits cleanly in once mode with an empty inbox", async () => {
  const hubRoot = await tempRoot("cpb-managed-empty-once-inbox");
  const cpbRoot = await tempRoot("cpb-managed-empty-once-cpb");
  const workerId = "w-empty-once";
  const worker = spawnWorker({ workerId, hubRoot, cpbRoot, once: true, timeoutMs: 5_000 });

  const result = await worker.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stderr, /fatal|ReferenceError|Cannot access/i);

  const registry = await readJson(path.join(hubRoot, "workers", "registry", `worker-${workerId}.json`));
  assert.equal(registry.status, "exited");
  assert.equal(registry.exitSignal, "once");
});

// A checklist injected via sourceContext.acceptanceChecklist must pass
// validateAcceptanceChecklist + validateChecklistSourceCoverage. Its static
// item's allowedFiles MUST match the files the execute fixture actually writes
// (README.md); otherwise the deterministic probe reports matchCount=0, EV-001
// is emitted with result:"fail", and no valid checklistVerdict can pass.
function buildInjectedAcceptanceChecklist({ jobId = "job-managed-success", project = "proj", task = "managed worker fake ACP success" } = {}) {
  return {
    schemaVersion: 1,
    jobId,
    project,
    source: { task, issue: null, documents: [], requirementClassificationArtifact: null },
    status: "frozen",
    items: [
      {
        id: "AC-001",
        requirement: task,
        source: "task_text",
        sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: null }],
        predicateId: "PRED-001",
        required: true,
        area: "core",
        risk: "medium",
        verificationMethod: "static",
        expectedEvidence: "static scope probe confirming README.md was modified",
        dependsOn: [],
        allowedFiles: ["README.md"],
      },
    ],
    assumptions: [],
  };
}

async function writeValidAssignment({
  hubRoot,
  workerId,
  sourcePath,
  metadata = {},
  assignmentId = "a-managed-success",
  entryId = "managed-success",
  task = "managed worker fake ACP success",
  workflow = "standard",
  planMode = "full",
  attemptToken = "attempt-token-1",
  acceptanceChecklist = null,
}: {
  hubRoot: string;
  workerId: string;
  sourcePath: string;
  metadata?: Record<string, unknown>;
  assignmentId?: string;
  entryId?: string;
  task?: string;
  workflow?: string;
  planMode?: string;
  attemptToken?: string;
  acceptanceChecklist?: Record<string, unknown> | null;
}) {
  const project = await registerProject(hubRoot, { id: "proj", name: "proj", sourcePath, skipLocalCodeIndexGate: true });
  const attemptDir = path.join(hubRoot, "assignments", assignmentId, "attempts", "001");
  await mkdir(path.join(attemptDir, "control"), { recursive: true });
  await writeJson(path.join(hubRoot, "assignments", assignmentId, "state.json"), {
    assignmentId,
    entryId,
    projectId: "proj",
    projectRuntimeRoot: project.projectRuntimeRoot,
    task,
    sourcePath,
    workflow,
    planMode,
    sourceContext: {
      issueNumber: 9,
      ...(acceptanceChecklist ? { acceptanceChecklist } : {}),
    },
    metadata: {
      agents: {
        planner: "fake-acp",
        executor: "fake-acp",
        verifier: "fake-acp",
      },
      ...metadata,
    },
    status: "assigned",
    attempts: 1,
    activeAttempt: 1,
    workerId,
    assignedAt: new Date().toISOString(),
  });
  await writeJson(path.join(attemptDir, "attempt.json"), {
    assignmentId,
    attempt: 1,
    entryId,
    projectId: "proj",
    workerId,
    status: "assigned",
    attemptToken,
    createdAt: new Date().toISOString(),
  });
  await writeJson(path.join(hubRoot, "workers", "inbox", workerId, `${assignmentId}.json`), {
    assignmentId,
    entryId,
    projectId: "proj",
    projectRuntimeRoot: project.projectRuntimeRoot,
    task,
    sourcePath,
    workflow,
    planMode,
    sourceContext: {
      issueNumber: 9,
      ...(acceptanceChecklist ? { acceptanceChecklist } : {}),
    },
    metadata: {
      agents: {
        planner: "fake-acp",
        executor: "fake-acp",
        verifier: "fake-acp",
      },
      ...metadata,
    },
    attempt: 1,
    attemptToken,
    orchestratorEpoch: 7,
  });
  return { assignmentId, attemptDir, project };
}

test("createIsolatedWorktreeWithRetry refuses an unverified source checkout without destructive cleanup", async () => {
  const hubRoot = await tempRoot("cpb-managed-worktree");
  const sourcePath = await tempRoot("cpb-managed-source");
  const gitCalls = [];

  await assert.rejects(
    createIsolatedWorktreeWithRetry({
      projectRuntimeRoot: hubRoot,
      sourcePath,
      entryId: "entry1",
      maxAttempts: 1,
      retryDelayMs: 0,
      create: async () => ({ path: sourcePath, branch: "cpb/job-entry1-pipeline", baseBranch: "main" }),
      runGit: async (command, args, opts) => {
        gitCalls.push({ command, args, cwd: opts.cwd });
        return { stdout: "", stderr: "" };
      },
    }),
    (err: any) => {
      assert.equal(err.code, "WORKTREE_CLEANUP_DEFERRED");
      assert.match(err.message, /independently verified.*Git metadata cleanup is deferred/i);
      return true;
    },
  );

  assert.equal(gitCalls.length, 0, "target cleanup must not run repository-wide Git maintenance");
});

test("finalizeAndWriteSuccessfulResult persists attempt token and job result", async () => {
  const attemptDir = await tempRoot("cpb-managed-result");
  let written = null;

  const finalizeResult = await finalizeAndWriteSuccessfulResult({
    cpbRoot: await tempRoot("cpb-managed-cpb"),
    hubRoot: await tempRoot("cpb-managed-hub"),
    assignment: {
      assignmentId: "a-result",
      entryId: "result",
      projectId: "proj",
      attemptToken: "tok-result",
      metadata: {},
    },
    attemptDir,
    assignmentId: "a-result",
    attemptNum: 2,
    jobId: "job-result",
    result: { status: "completed", jobId: "job-result", phaseResults: [] },
    worktreeInfo: { path: "/tmp/not-used", branch: "cpb/not-used" },
    writeResult: async (file, value) => { written = { file, value }; return true; },
  });

  assert.equal(finalizeResult, null);
  assert.equal(written.file, path.join(attemptDir, "result.json"));
  assert.equal(written.value.assignmentId, "a-result");
  assert.equal(written.value.attempt, 2);
  assert.equal(written.value.attemptToken, "tok-result");
  assert.equal(written.value.status, "completed");
  assert.equal(written.value.jobResult.jobId, "job-result");
});

test("managed worker atomically claims and removes malformed inbox payloads", async () => {
  const hubRoot = await tempRoot("cpb-managed-bad-inbox");
  const cpbRoot = await tempRoot("cpb-managed-bad-cpb");
  const workerId = "w-bad";
  const inboxDir = path.join(hubRoot, "workers", "inbox", workerId);
  await mkdir(inboxDir, { recursive: true });
  await writeFile(path.join(inboxDir, "bad-json.json"), "{bad", "utf8");
  await writeJson(path.join(inboxDir, "bad-attempt.json"), {
    assignmentId: "a-bad-attempt",
    attempt: 0,
    attemptToken: "tok",
  });
  await writeJson(path.join(inboxDir, "missing-token.json"), {
    assignmentId: "a-missing-token",
    attempt: 1,
  });

  const worker = spawnWorker({ workerId, hubRoot, cpbRoot, timeoutMs: 30_000 });
  let stopped = null;
  try {
    await waitFor(async () => {
      const pending = await listJsonFiles(inboxDir);
      const processing = await listJsonFiles(path.join(inboxDir, "processing"));
      return pending.length === 0 && processing.length === 0;
    }, { timeoutMs: 20_000 });
  } finally {
    worker.child.kill("SIGTERM");
    stopped = await worker.done.catch((err) => ({ error: err }));
  }

  assert.ok(stopped.code === 0 || stopped.signal === "SIGTERM", `unexpected exit: ${JSON.stringify(stopped)}`);
  assert.match(worker.stderr, /malformed inbox file/);
  assert.match(worker.stderr, /invalid attempt/);
  assert.match(worker.stderr, /missing attemptToken/);
  const registry = await readJson(path.join(hubRoot, "workers", "registry", `worker-${workerId}.json`));
  assert.match(registry.status, /^(ready|exited)$/);
});

test("managed worker can exit persistent mode after idle drain when requested", async () => {
  const hubRoot = await tempRoot("cpb-managed-empty-drain");
  const cpbRoot = await tempRoot("cpb-managed-empty-drain-cpb");
  const workerId = "w-empty-drain";
  const worker = spawnWorker({
    workerId,
    hubRoot,
    cpbRoot,
    once: false,
    timeoutMs: 8_000,
    env: {
      CPB_WORKER_EXIT_ON_IDLE: "1",
      CPB_WORKER_IDLE_EXIT_MS: "300",
    },
  });

  const stopped = await worker.done;
  assert.equal(stopped.code, 0, stopped.stderr);
  const registry = await readJson(path.join(hubRoot, "workers", "registry", `worker-${workerId}.json`));
  assert.equal(registry.status, "exited");
  assert.equal(registry.exitSignal, "idle");
});

test("managed worker writes accepted, heartbeat, result, and cleans worktree and registry after fake ACP run", async () => {
  const root = await tempRoot("cpb-managed-success");
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  const workerId = "w-success";
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# Managed Worker Fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "managed-worker-fixture", private: true }, null, 2)}\n`, "utf8");
  const scenarioPath = await writeWorkerScenario(root);
  const transcriptPath = path.join(root, "transcript.jsonl");
  // Inject a checklist with a required static item (AC-001, allowedFiles:[README.md])
  // so the verify fixture's checklistVerdict walks the GENUINE checklist path. Without
  // injection the auto-constructed checklist produces AC-001 with allowedFiles:[] -> the
  // probe can never observe a match -> no valid checklistVerdict can pass -> gate fails.
  // (Combined with the {{worktree}} execute write + checklistMapping, EV-001 is emitted
  // result:"pass" matchCount:1, which the checklistVerdict below cites.)
  const injectedChecklist = buildInjectedAcceptanceChecklist();
  const { assignmentId, attemptDir, project } = await writeValidAssignment({
    hubRoot,
    workerId,
    sourcePath,
    acceptanceChecklist: injectedChecklist,
  });

  const worker = spawnWorker({
    workerId,
    hubRoot,
    cpbRoot,
    env: {
      ...sandboxTempEnv(root),
      CPB_ROOT: cpbRoot,
      CPB_HUB_ROOT: hubRoot,
      CPB_EXECUTOR_ROOT: repoRoot,
      CPB_PROJECT_ROOTS: root,
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgentScript,
        "--scenario-file", scenarioPath,
        "--transcript-file", transcriptPath,
      ]),
    },
    timeoutMs: 60_000,
  });

  const finished = await worker.done;
  assert.equal(finished.code, 0, finished.stderr);

  const accepted = await readJson(path.join(attemptDir, "accepted.json"));
  assert.equal(accepted.workerId, workerId);
  assert.equal(accepted.assignmentId, assignmentId);
  assert.equal(accepted.attemptToken, "attempt-token-1");
  assert.equal(accepted.executionBoundary, "worktree");
  assert.equal(accepted.sourcePath, sourcePath);

  const heartbeat = await readJson(path.join(attemptDir, "heartbeat.json"));
  assert.equal(heartbeat.workerId, workerId);
  assert.equal(heartbeat.status, "running");
  assert.equal(heartbeat.executionBoundary, "worktree");
  assert.equal(heartbeat.activeJobId, "job-managed-success");
  assert.ok(heartbeat.progressUpdatedAt);
  assert.ok(heartbeat.lastProgressType);

  const worktree = await readJson(path.join(attemptDir, "worktree.json"));
  assert.equal(worktree.sourcePath, sourcePath);
  assert.equal(worktree.executionBoundary, "worktree");
  assert.notEqual(path.resolve(worktree.worktreePath), path.resolve(sourcePath));
  assert.equal(worktree.managedWorktree.path, worktree.worktreePath);
  assert.equal(worktree.managedWorktree.branch, worktree.worktreeBranch);
  assert.equal(typeof worktree.managedWorktree.baseBranch, "string");
  assert.ok(worktree.managedWorktree.baseBranch.length > 0);
  assert.match(worktree.managedWorktree.baseCommit, /^[0-9a-f]{40,64}$/);
  assert.equal(worktree.managedWorktree.ownership.state, "ready");
  assert.equal(worktree.managedWorktree.ownership.baseBranch, worktree.managedWorktree.baseBranch);
  assert.equal(worktree.managedWorktree.ownership.baseCommit, worktree.managedWorktree.baseCommit);
  assert.equal(worktree.worktreeVerification.sourcePath, await realpath(sourcePath));
  assert.equal(worktree.worktreeVerification.sourceTopLevel, await realpath(sourcePath));
  assert.equal(heartbeat.managedWorktree.baseCommit, worktree.managedWorktree.baseCommit);
  assert.deepEqual(heartbeat.worktreeVerification, worktree.worktreeVerification);
  assert.match(
    path.relative(path.join(await realpath(project.projectRuntimeRoot), "worktrees"), path.resolve(worktree.worktreePath)),
    /^job-managed-success-pipeline/,
  );

  const result = await readJson(path.join(attemptDir, "result.json"));
  assert.equal(result.assignmentId, assignmentId);
  assert.equal(result.attemptToken, "attempt-token-1");
  assert.equal(result.status, "completed");
  assert.equal(result.jobResult.status, "completed");
  assert.equal(result.cleanup.worktree.disposition, "quarantined");
  assert.equal(result.cleanup.worktree.dispositionVerified, true);
  assert.equal(result.cleanup.worktree.canonicalPathRemoved, true);
  assert.equal(result.cleanup.worktree.quarantinePreserved, true);
  assert.deepEqual(result.cleanup.worktree.binding.ownership, worktree.managedWorktree.ownership);
  assert.deepEqual(result.cleanup.worktree.binding.verification, worktree.worktreeVerification);
  assert.deepEqual(result.jobResult.phaseResults.map((phase) => phase.phase), ["plan", "execute", "verify"]);
  const assignmentState = await readJson(path.join(hubRoot, "assignments", assignmentId, "state.json"));
  assert.equal(assignmentState.status, "completed");
  assert.ok(assignmentState.completedAt);
  assert.ok(assignmentState.resultWrittenAt);
  assert.equal(existsSync(path.join(project.projectRuntimeRoot, "events", "proj", "job-managed-success.jsonl")), true);
  assert.equal(existsSync(path.join(project.projectRuntimeRoot, "jobs-index.json")), true);
  assert.equal(existsSync(path.join(project.projectRuntimeRoot, "wiki", "inbox")), true);
  assert.equal(existsSync(path.join(project.projectRuntimeRoot, "wiki", "outputs")), true);
  assert.equal(existsSync(path.join(cpbRoot, "cpb-task")), false);
  const jobEvents = await readJsonl(path.join(project.projectRuntimeRoot, "events", "proj", "job-managed-success.jsonl"));
  const worktreeCreated = jobEvents.find((event) => event.type === "worktree_created");
  assert.ok(worktreeCreated, "core must durably append worktree_created before execution");
  assert.equal(worktreeCreated.worktree, worktree.managedWorktree.path);
  assert.equal(worktreeCreated.branch, worktree.managedWorktree.branch);
  assert.equal(worktreeCreated.baseBranch, worktree.managedWorktree.baseBranch);
  assert.equal(worktreeCreated.baseCommit, worktree.managedWorktree.baseCommit);
  assert.deepEqual(worktreeCreated.worktreeOwnership, worktree.managedWorktree.ownership);

  // ── GENUINE checklist-path assertions ──────────────────────────────────
  // result.status==="completed" must hold because the checklist machinery ran
  // end-to-end on this fixture, NOT because a bare legacy verdict slipped past
  // a permissive gate. Concretely we assert the three artifacts that only the
  // checklist path produces, in the shape only a PASSING run produces:
  //   1. acceptance-checklist: frozen, AC-001 required, allowedFiles=[README.md]
  //   2. evidence-ledger: EV-001 result:"pass" matchCount:1 (the deterministic
  //      probe observed README.md actually changed in the worktree)
  //   3. checklist-verdict: status:"pass", AC-001 result:"pass", citing EV-001
  //      via the real ledger id (remapEvidenceRefs rewrote the "pending" placeholder)
  const outputsDir = path.join(project.projectRuntimeRoot, "wiki", "outputs");
  const readArtifact = async (prefix: string) => {
    const files = (await readdir(outputsDir)).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".md"));
    assert.equal(files.length, 1, `expected exactly one ${prefix} artifact, found ${files.length}`);
    return JSON.parse(await readFile(path.join(outputsDir, files[0]), "utf8"));
  };
  const frozenChecklist = await readArtifact("acceptance-checklist");
  assert.equal(frozenChecklist.status, "frozen");
  assert.equal(frozenChecklist.items.length, 1);
  assert.equal(frozenChecklist.items[0].id, "AC-001");
  assert.equal(frozenChecklist.items[0].required, true);
  assert.deepEqual(frozenChecklist.items[0].allowedFiles, ["README.md"]);
  const evidenceLedger = await readArtifact("evidence-ledger");
  assert.equal(evidenceLedger.evidence.length, 1);
  assert.equal(evidenceLedger.evidence[0].id, "EV-001");
  assert.equal(evidenceLedger.evidence[0].checklistId, "AC-001");
  assert.equal(evidenceLedger.evidence[0].result, "pass", "probe must observe matchCount>0 -> pass (README.md landed in worktree)");
  assert.ok(evidenceLedger.evidence[0].matchCount >= 1, `matchCount must be >=1, got ${evidenceLedger.evidence[0].matchCount}`);
  const checklistVerdict = await readArtifact("checklist-verdict");
  assert.equal(checklistVerdict.status, "pass");
  assert.equal(checklistVerdict.items[0].checklistId, "AC-001");
  assert.equal(checklistVerdict.items[0].result, "pass");
  assert.equal(checklistVerdict.items[0].evidenceRefs[0].ledgerId, "evidence-ledger-job-managed-success", "remapEvidenceRefs must rewrite the placeholder ledgerId");
  assert.equal(checklistVerdict.items[0].evidenceRefs[0].evidenceId, "EV-001");

  const registry = await readJson(path.join(hubRoot, "workers", "registry", `worker-${workerId}.json`));
  assert.equal(registry.status, "exited");
  assert.equal(registry.currentAssignmentId, null);
  assert.deepEqual(await listJsonFiles(path.join(hubRoot, "workers", "inbox", workerId)), []);
  assert.deepEqual(await listJsonFiles(path.join(hubRoot, "workers", "inbox", workerId, "processing")), []);
  assert.equal(existsSync(worktree.worktreePath), false);

  const transcript = await readFile(transcriptPath, "utf8");
  assert.match(transcript, /software execution agent/);
  const launches = (await readJobAcpAudit(project.projectRuntimeRoot, "proj", "job-managed-success"))
    .filter((event) => event.event === "agent_launch");
  assert.deepEqual(launches.map((event) => event.phase), ["plan", "execute", "verify"]);

  await rm(root, { recursive: true, force: true });
});

test("managed worker default checklist decomposition runs inside the worker path", async () => {
  const root = await tempRoot("cpb-managed-decompose");
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  const workerId = "w-decompose";
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# Managed Worker Decompose Fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "managed-worker-decompose", private: true }, null, 2)}\n`, "utf8");
  const scenarioPath = await writeWorkerScenario(root);
  const transcriptPath = path.join(root, "transcript-decompose.jsonl");
  const { assignmentId, attemptDir, project } = await writeValidAssignment({
    hubRoot,
    workerId,
    sourcePath,
    assignmentId: "a-managed-decompose",
    entryId: "managed-decompose",
    task: "managed worker fake ACP success",
    attemptToken: "attempt-token-decompose",
  });

  try {
    const worker = spawnWorker({
      workerId,
      hubRoot,
      cpbRoot,
      env: {
        ...sandboxTempEnv(root),
        CPB_ROOT: cpbRoot,
        CPB_HUB_ROOT: hubRoot,
        CPB_EXECUTOR_ROOT: repoRoot,
        CPB_PROJECT_ROOTS: root,
        CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
        CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
          testAgentScript,
          "--scenario-file", scenarioPath,
          "--transcript-file", transcriptPath,
        ]),
        CPB_CHECKLIST_DECOMPOSE: "1",
      },
      timeoutMs: 60_000,
    });

    const finished = await worker.done;
    assert.equal(finished.code, 0, finished.stderr);

    const result = await readJson(path.join(attemptDir, "result.json"));
    assert.equal(result.assignmentId, assignmentId);
    assert.equal(result.status, "completed");
    assert.equal(result.jobResult.status, "completed");
    const jobId = result.jobResult.jobId;
    assert.equal(
      existsSync(path.join(project.projectRuntimeRoot, "agent-homes", "fake-acp", jobId)),
      true,
      "flagship release gate must run ACP agents with isolated HOME under the project runtime root",
    );

    const outputsDir = path.join(project.projectRuntimeRoot, "wiki", "outputs");
    const readArtifact = async (prefix: string) => {
      const files = (await readdir(outputsDir)).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".md"));
      assert.equal(files.length, 1, `expected exactly one ${prefix} artifact, found ${files.length}`);
      return JSON.parse(await readFile(path.join(outputsDir, files[0]), "utf8"));
    };
    const frozenChecklist = await readArtifact("acceptance-checklist");
    assert.equal(frozenChecklist.status, "frozen");
    assert.equal(frozenChecklist.items.length, 1);
    assert.equal(frozenChecklist.items[0].id, "AC-001");
    assert.equal(frozenChecklist.items[0].predicateId, "managed-readme-change");
    assert.deepEqual(frozenChecklist.items[0].allowedFiles, ["README.md"]);
    const evidenceLedger = await readArtifact("evidence-ledger");
    assert.equal(evidenceLedger.evidence[0].result, "pass");
    assert.ok(evidenceLedger.evidence[0].matchCount >= 1);
    const checklistVerdict = await readArtifact("checklist-verdict");
    assert.equal(checklistVerdict.status, "pass");
    assert.equal(checklistVerdict.items[0].checklistId, "AC-001");
    assert.equal(checklistVerdict.items[0].evidenceRefs[0].ledgerId, `evidence-ledger-${jobId}`);

    const launches = (await readJobAcpAudit(project.projectRuntimeRoot, "proj", jobId))
      .filter((event) => event.event === "agent_launch");
    assert.equal(launches.some((event) => event.agent === "fake-acp"
      && event.phase === "prepare_task"
      && event.role === "checklist_decomposer"), true);
    assert.equal(launches.some((event) => event.agent === "fake-acp"
      && event.phase === "plan"
      && event.role === "planner"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed worker writes dry-run PR preview after evidence-backed fake ACP run", async () => {
  const root = await tempRoot("cpb-managed-finalize-dry-run");
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  const workerId = "w-finalize";
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# Managed Worker Finalizer Fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "managed-worker-finalizer", private: true }, null, 2)}\n`, "utf8");
  const scenarioPath = await writeWorkerScenario(root);
  const transcriptPath = path.join(root, "transcript-finalize.jsonl");
  const injectedChecklist = buildInjectedAcceptanceChecklist({
    jobId: "job-managed-finalize",
    task: "managed worker fake ACP finalizer dry-run",
  });
  const { assignmentId, attemptDir } = await writeValidAssignment({
    hubRoot,
    workerId,
    sourcePath,
    assignmentId: "a-managed-finalize",
    entryId: "managed-finalize",
    task: "managed worker fake ACP finalizer dry-run",
    attemptToken: "attempt-token-finalize",
    acceptanceChecklist: injectedChecklist,
    metadata: {
      autoFinalize: true,
      finalizeMode: "pr",
      repo: "owner/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/owner/repo/issues/42",
      issueTitle: "Managed worker finalizer dry-run",
    },
  });

  try {
    const worker = spawnWorker({
      workerId,
      hubRoot,
      cpbRoot,
      env: {
        ...sandboxTempEnv(root),
        CPB_ROOT: cpbRoot,
        CPB_HUB_ROOT: hubRoot,
        CPB_EXECUTOR_ROOT: repoRoot,
        CPB_PROJECT_ROOTS: root,
        CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
        CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
          testAgentScript,
          "--scenario-file", scenarioPath,
          "--transcript-file", transcriptPath,
        ]),
      },
      timeoutMs: 60_000,
    });

    const finished = await worker.done;
    assert.equal(finished.code, 0, finished.stderr);

    const result = await readJson(path.join(attemptDir, "result.json"));
    assert.equal(result.assignmentId, assignmentId);
    assert.equal(result.status, "completed");
    assert.equal(result.jobResult.status, "completed");
    assert.equal(result.finalizeResult.status, "dry-run");
    assert.equal(result.finalizeResult.mode, "dry-run");
    assert.equal(result.finalizeResult.issue.repo, "owner/repo");
    assert.equal(result.finalizeResult.issue.number, 42);
    assert.equal(result.finalizeResult.planned.pullRequestPreview, true);
    assert.equal(result.finalizeResult.planned.push, false);
    assert.equal(result.finalizeResult.planned.pullRequest, false);
    assert.equal(result.finalizeResult.worktreeHead, result.finalizeResult.sourceHead);
    assert.equal(result.finalizeResult.completionGate.outcome, "complete");
    assert.equal(result.finalizeResult.verdict.status, "pass");
    assert.equal(result.finalizeResult.pr.status, "dry-run");
    assert.equal(result.finalizeResult.pr.request.draft, true);
    assert.equal(result.finalizeResult.pr.request.repo, "owner/repo");
    assert.match(result.finalizeResult.pr.request.head, /^cpb\/job-managed-finalize-pipeline/);
    assert.match(result.finalizeResult.pr.request.body, /Completion Gate/i);
    assert.match(result.finalizeResult.pr.request.body, /Verdict/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed worker flagship issue to draft PR dry-run uses default checklist decomposition and evidence", async () => {
  const root = await tempRoot("cpb-managed-flagship-dry-run");
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  const workerId = "w-flagship";
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# Managed Worker Flagship Fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "managed-worker-flagship", private: true }, null, 2)}\n`, "utf8");
  const scenarioPath = await writeWorkerScenario(root);
  const transcriptPath = path.join(root, "transcript-flagship.jsonl");
  const { assignmentId, attemptDir, project } = await writeValidAssignment({
    hubRoot,
    workerId,
    sourcePath,
    assignmentId: "a-managed-flagship",
    entryId: "managed-flagship",
    task: "GitHub Issue to evidence-backed draft PR dry-run",
    attemptToken: "attempt-token-flagship",
    metadata: {
      autoFinalize: true,
      finalizeMode: "pr",
      repo: "owner/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/owner/repo/issues/42",
      issueTitle: "Managed worker flagship dry-run",
    },
  });

  try {
    const worker = spawnWorker({
      workerId,
      hubRoot,
      cpbRoot,
      env: {
        ...sandboxTempEnv(root),
        CPB_ROOT: cpbRoot,
        CPB_HUB_ROOT: hubRoot,
        CPB_EXECUTOR_ROOT: repoRoot,
        CPB_PROJECT_ROOTS: root,
        CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
        CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
          testAgentScript,
          "--scenario-file", scenarioPath,
          "--transcript-file", transcriptPath,
        ]),
        CPB_CHECKLIST_DECOMPOSE: "1",
      },
      timeoutMs: 60_000,
    });

    const finished = await worker.done;
    assert.equal(finished.code, 0, finished.stderr);

    const result = await readJson(path.join(attemptDir, "result.json"));
    assert.equal(result.assignmentId, assignmentId);
    assert.equal(result.status, "completed");
    assert.equal(result.jobResult.status, "completed");
    const jobId = result.jobResult.jobId;

    const outputsDir = path.join(project.projectRuntimeRoot, "wiki", "outputs");
    const readArtifact = async (prefix: string) => {
      const files = (await readdir(outputsDir)).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".md"));
      assert.equal(files.length, 1, `expected exactly one ${prefix} artifact, found ${files.length}`);
      return JSON.parse(await readFile(path.join(outputsDir, files[0]), "utf8"));
    };
    const frozenChecklist = await readArtifact("acceptance-checklist");
    assert.equal(frozenChecklist.status, "frozen");
    assert.equal(frozenChecklist.items.length, 1);
    assert.equal(frozenChecklist.items[0].id, "AC-001");
    assert.equal(frozenChecklist.items[0].predicateId, "managed-readme-change");
    assert.deepEqual(frozenChecklist.items[0].allowedFiles, ["README.md"]);
    const evidenceLedger = await readArtifact("evidence-ledger");
    assert.equal(evidenceLedger.evidence[0].id, "EV-001");
    assert.equal(evidenceLedger.evidence[0].checklistId, "AC-001");
    assert.equal(evidenceLedger.evidence[0].result, "pass");
    assert.ok(evidenceLedger.evidence[0].matchCount >= 1);
    const checklistVerdict = await readArtifact("checklist-verdict");
    assert.equal(checklistVerdict.status, "pass");
    assert.equal(checklistVerdict.items[0].checklistId, "AC-001");
    assert.equal(checklistVerdict.items[0].result, "pass");
    assert.equal(checklistVerdict.items[0].evidenceRefs[0].ledgerId, `evidence-ledger-${jobId}`);

    assert.equal(result.finalizeResult.status, "dry-run");
    assert.equal(result.finalizeResult.mode, "dry-run");
    assert.equal(result.finalizeResult.issue.repo, "owner/repo");
    assert.equal(result.finalizeResult.issue.number, 42);
    assert.equal(result.finalizeResult.planned.pullRequestPreview, true);
    assert.equal(result.finalizeResult.planned.push, false);
    assert.equal(result.finalizeResult.planned.pullRequest, false);
    assert.equal(result.finalizeResult.completionGate.outcome, "complete");
    assert.equal(result.finalizeResult.verdict.status, "pass");
    assert.equal(result.finalizeResult.pr.status, "dry-run");
    assert.equal(result.finalizeResult.pr.request.repo, "owner/repo");
    assert.equal(result.finalizeResult.pr.request.draft, true);
    assert.match(result.finalizeResult.pr.request.head, /^cpb\/job-managed-flagship-pipeline/);
    assert.match(result.finalizeResult.pr.request.body, /Completion Gate/i);
    assert.match(result.finalizeResult.pr.request.body, /Verdict/i);

    const projectedJob = await getJob(cpbRoot, "proj", jobId, { dataRoot: project.projectRuntimeRoot });
    assert.equal(projectedJob?.finalizer?.ok, true);
    assert.equal(projectedJob?.finalizer?.status, "dry-run");
    assert.equal(projectedJob?.finalizer?.mode, "dry-run");

    const acpAuditFiles = result.jobResult.phaseResults
      .map((phase) => phase.diagnostics?.acpAuditFile)
      .filter(Boolean);
    assert.equal(acpAuditFiles.length, 3);
    for (const auditFile of acpAuditFiles) {
      const launch = (await readJsonl(auditFile)).find((event) => event.event === "agent_launch");
      assert.equal(launch?.agentHome?.isolated, true);
      assert.match(launch?.agentHome?.home || "", new RegExp(`^${project.projectRuntimeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/agent-homes/fake-acp/${jobId}`));
    }

    const launches = (await readJobAcpAudit(project.projectRuntimeRoot, "proj", jobId))
      .filter((event) => event.event === "agent_launch");
    assert.deepEqual(launches.map((event) => event.phase), ["prepare_task", "plan", "execute", "verify"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed worker completes blocked workflow without creating a worktree", async () => {
  const root = await tempRoot("cpb-managed-blocked");
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  const workerId = "w-blocked";
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# Managed Worker Blocked Fixture\n", "utf8");
  const { attemptDir } = await writeValidAssignment({
    hubRoot,
    workerId,
    sourcePath,
    assignmentId: "a-managed-blocked",
    entryId: "managed-blocked",
    task: "blocked workflow should not need a worktree",
    workflow: "blocked",
    planMode: "none",
    attemptToken: "attempt-token-blocked",
  });

  try {
    const worker = spawnWorker({
      workerId,
      hubRoot,
      cpbRoot,
      env: {
        CPB_ROOT: cpbRoot,
        CPB_HUB_ROOT: hubRoot,
        CPB_EXECUTOR_ROOT: repoRoot,
        CPB_PROJECT_ROOTS: root,
      },
      timeoutMs: 20_000,
    });

    const finished = await worker.done;
    assert.equal(finished.code, 0, finished.stderr);

    const result = await readJson(path.join(attemptDir, "result.json"));
    assert.equal(result.status, "blocked");
    assert.equal(result.attemptToken, "attempt-token-blocked");
    assert.equal(result.jobResult.status, "blocked");
    assert.equal(result.jobResult.failure.cause.code, "workflow_blocked");
    assert.equal(existsSync(path.join(attemptDir, "worktree.json")), false);
    assert.equal(existsSync(path.join(hubRoot, "projects", "proj", "worktrees")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed worker stops an active assignment when its cancel control file appears", async () => {
  const root = await tempRoot("cpb-managed-cancel");
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  const workerId = "w-cancel";
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# Managed Worker Cancel Fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "managed-worker-cancel", private: true }, null, 2)}\n`, "utf8");
  const scenarioPath = path.join(root, "cancel-scenario.json");
  await writeJson(scenarioPath, {
    responses: [
      {
        name: "execute",
        matchRegex: "software execution agent",
        delayMs: 30_000,
        output: jsonEnvelope({
          status: "ok",
          summary: "This delayed response should be cancelled before completion.",
          tests: [],
          risks: [],
        }),
      },
    ],
  });
  const transcriptPath = path.join(root, "cancel-transcript.jsonl");
  const { assignmentId, attemptDir } = await writeValidAssignment({
    hubRoot,
    workerId,
    sourcePath,
    assignmentId: "a-managed-cancel",
    entryId: "managed-cancel",
    workflow: "direct",
    planMode: "light",
    attemptToken: "attempt-token-cancel",
    // Inject a prebuilt acceptance checklist so prepare_task skips the LLM
    // decomposition step (which routes to a planner agent that is not wired in
    // this fake-acp harness). Without this the job hangs in prepare_task and
    // never reaches the execute phase the cancel race targets.
    acceptanceChecklist: buildInjectedAcceptanceChecklist({
      jobId: "job-managed-cancel",
      task: "managed worker cancel",
    }),
    metadata: { agents: { executor: "fake-acp" } },
  });

  const worker = spawnWorker({
    workerId,
    hubRoot,
    cpbRoot,
    env: {
      ...sandboxTempEnv(root),
      CPB_ROOT: cpbRoot,
      CPB_HUB_ROOT: hubRoot,
      CPB_EXECUTOR_ROOT: repoRoot,
      CPB_PROJECT_ROOTS: root,
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgentScript,
        "--scenario-file", scenarioPath,
        "--transcript-file", transcriptPath,
      ]),
    },
    timeoutMs: 40_000,
  });

  try {
    await waitFor(async () => {
      const raw = await readFile(transcriptPath, "utf8").catch(() => "");
      return raw.includes("session/prompt");
    }, { timeoutMs: 20_000 });

    const store = new AssignmentStore(hubRoot);
    await store.init();
    await store.writeCancel(assignmentId, 1, "test requested cancellation");

    const result = await waitFor(
      async () => readJson(path.join(attemptDir, "result.json")),
      { timeoutMs: 8_000 },
    );
    assert.equal(result.status, "cancelled");
    assert.equal(result.attemptToken, "attempt-token-cancel");
    assert.equal(result.jobResult.status, "cancelled");
    assert.equal(result.jobResult.jobId, "job-managed-cancel");
    assert.equal(result.jobResult.failure.kind, "runtime_interrupted");
    assert.equal(result.jobResult.failure.phase, "execute");
    assert.equal(result.jobResult.failure.retryable, false);
    assert.match(result.jobResult.failure.reason, /cancel/i);

    const worktree = await readJson(path.join(attemptDir, "worktree.json"));
    const finished = await worker.done;
    assert.equal(finished.code, 0, finished.stderr);
    assert.equal(existsSync(worktree.worktreePath), false);
  } finally {
    worker.child.kill("SIGTERM");
    await worker.done.catch(() => null);
    await rm(root, { recursive: true, force: true });
  }
});

test("managed worker closes attempt sessions between assignments without requiring provider process churn", async () => {
  const root = await tempRoot("cpb-managed-persistent");
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  const workerId = "w-persistent";
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# Managed Worker Persistent Fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "managed-worker-persistent", private: true }, null, 2)}\n`, "utf8");
  const scenarioPath = await writeWorkerScenario(root);
  const transcriptPath = path.join(root, "persistent-transcript.jsonl");
  await writeFile(transcriptPath, "", "utf8");

  const first = await writeValidAssignment({
    hubRoot,
    workerId,
    sourcePath,
    assignmentId: "a-managed-persistent-one",
    entryId: "managed-persistent-one",
    workflow: "direct",
    planMode: "light",
    attemptToken: "attempt-token-one",
    metadata: { agents: { executor: "fake-acp", verifier: "fake-acp" } },
    acceptanceChecklist: buildInjectedAcceptanceChecklist({ jobId: "job-managed-persistent-one" }),
  });
  const second = await writeValidAssignment({
    hubRoot,
    workerId,
    sourcePath,
    assignmentId: "a-managed-persistent-two",
    entryId: "managed-persistent-two",
    workflow: "direct",
    planMode: "light",
    attemptToken: "attempt-token-two",
    metadata: { agents: { executor: "fake-acp", verifier: "fake-acp" } },
    acceptanceChecklist: buildInjectedAcceptanceChecklist({ jobId: "job-managed-persistent-two" }),
  });

  const worker = spawnWorker({
    workerId,
    hubRoot,
    cpbRoot,
    once: false,
    env: {
      ...sandboxTempEnv(root),
      CPB_ROOT: cpbRoot,
      CPB_HUB_ROOT: hubRoot,
      CPB_EXECUTOR_ROOT: repoRoot,
      CPB_PROJECT_ROOTS: root,
      CPB_AGENT_SANDBOX_ALLOW_WRITE: transcriptPath,
      CPB_ACP_PERSISTENT_PROCESS: "1",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgentScript,
        "--scenario-file", scenarioPath,
        "--transcript-file", transcriptPath,
      ]),
    },
    timeoutMs: 80_000,
  });

  try {
    const firstResult = await waitFor(async () => readJson(path.join(first.attemptDir, "result.json")), { timeoutMs: 70_000 });
    const secondResult = await waitFor(async () => readJson(path.join(second.attemptDir, "result.json")), { timeoutMs: 70_000 });

    assert.equal(firstResult.status, "completed");
    assert.equal(secondResult.status, "completed");
    assert.deepEqual(firstResult.jobResult.phaseResults.map((phase) => phase.phase), ["execute", "verify"]);
    assert.deepEqual(secondResult.jobResult.phaseResults.map((phase) => phase.phase), ["execute", "verify"]);
    assert.notEqual(
      firstResult.jobResult.phaseResults[0].diagnostics.conversationKey,
      firstResult.jobResult.phaseResults[1].diagnostics.conversationKey,
      "executor and independent verifier must not share a conversation",
    );
    assert.notEqual(
      firstResult.jobResult.phaseResults[0].diagnostics.conversationKey,
      secondResult.jobResult.phaseResults[0].diagnostics.conversationKey,
      "different assignment attempts must not share a conversation",
    );
    const publishedResultAudits = await Promise.all([
      readJobAcpAudit(first.project.projectRuntimeRoot, "proj", "job-managed-persistent-one"),
      readJobAcpAudit(second.project.projectRuntimeRoot, "proj", "job-managed-persistent-two"),
    ]);
    assert.equal(
      publishedResultAudits.flat().filter((event) => event.event === "session_close").length,
      4,
      `published attempt results must include completed ACP session-close audits\nworker stderr:\n${worker.stderr}`,
    );

    const transcript = (await readFile(transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const expectedSessionCount = firstResult.jobResult.phaseResults.length
      + secondResult.jobResult.phaseResults.length;
    const initializeCount = transcript.filter((event) => event.event === "initialize").length;
    assert.ok(
      initializeCount >= 2 && initializeCount <= expectedSessionCount,
      `unexpected provider process count: ${initializeCount}`,
    );
    assert.equal(transcript.filter((event) => event.event === "session/new").length, expectedSessionCount);
    assert.equal(transcript.filter((event) => event.event === "session/close").length, expectedSessionCount);
    assert.equal(transcript.filter((event) => event.event === "session/prompt").length, expectedSessionCount);

    const firstAuditFile = firstResult.jobResult.phaseResults[0].diagnostics.acpAuditFile;
    const secondAuditFile = secondResult.jobResult.phaseResults[0].diagnostics.acpAuditFile;
    const firstAudit = (await readFile(firstAuditFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const secondAudit = (await readFile(secondAuditFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(firstAudit.some((event) => event.event === "agent_launch"));
    assert.equal(firstAudit.filter((event) => event.event === "session_close").length, 2);
    assert.ok(firstAudit.every((event) => event.jobId === "job-managed-persistent-one"));
    assert.ok(secondAudit.some((event) => event.event === "session_new"));
    assert.equal(secondAudit.filter((event) => event.event === "session_close").length, 2);
    assert.ok(secondAudit.every((event) => event.jobId === "job-managed-persistent-two"));
  } finally {
    worker.child.kill("SIGTERM");
    await worker.done.catch(() => null);
  }
});
