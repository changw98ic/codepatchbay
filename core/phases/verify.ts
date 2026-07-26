import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { runCommandTree } from "../runtime/process-tree.js";
import { promisify } from "node:util";
import path from "node:path";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseVerifierJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { writePromptArtifact, withPromptArtifactDiagnostics } from "../artifacts/prompt-artifact.js";
import { phaseExecutionContract } from "./prompt-contract.js";
import { validateChecklistVerdict } from "../workflow/acceptance-checklist.js";
import { buildEvidenceProbePlan, validateEvidenceObservation } from "../workflow/evidence-probes.js";
import { runChecklistProbes } from "../workflow/probe-runner.js";
import { observableContractExecutionCoverage } from "../workflow/observable-contract.js";
import type { LooseRecord } from "../contracts/types.js";
import { recordValue } from "../contracts/types.js";
import { buildPhaseAcpEnv } from "./phase-env.js";
import { resolveHighAssurancePolicy } from "../policy/high-assurance.js";
import {
  captureCandidateArtifact,
  verifyCandidateArtifactIdentity,
  type CandidateArtifact,
  type CandidateArtifactVerificationRecord,
} from "../engine/candidate-artifact.js";
import type { RunJobProcessHooks } from "../engine/run-job-ports.js";
import { buildRuntimeEnv } from "../policy/child-env.js";
import { parseAgentFilesystemBoundary } from "../policy/filesystem-boundary.js";
import {
  createTemporaryGitWorktree,
  type TemporaryGitWorktree,
} from "../runtime/temporary-workspace.js";
import { applyFrozenGitTreeDelta } from "../runtime/frozen-git-tree.js";
import {
  buildScopeReviewRequest,
  executionMapFromPhaseResults,
  validateScopeReview,
  type ScopeReviewRequest,
} from "../workflow/scope-amendment.js";

type ExecFileOptions = LooseRecord & {
  cwd?: string;
  maxBuffer?: number;
  encoding?: BufferEncoding | string;
};

type CommandOutput = {
  stdout: string;
  stderr: string;
};

type ExecFileAsync = (cmd: string, args: string[], opts?: ExecFileOptions) => Promise<CommandOutput>;

type CommandFailure = LooseRecord & {
  code?: string | number | null;
  signal?: string | null;
  stdout?: unknown;
  stderr?: unknown;
  timedOut?: boolean;
  message?: unknown;
};

type CommandTreeLike = {
  exitCode?: string | number | null;
  signal?: string | null;
  stdout?: unknown;
  stderr?: unknown;
  timedOut?: boolean;
  error?: { message?: string };
};

type ChecklistItem = LooseRecord & {
  id: string;
  required?: boolean;
  verificationMethod?: string;
  predicateId?: string;
};

type AcceptanceChecklist = LooseRecord & {
  items: ChecklistItem[];
};

type EvidenceProbe = LooseRecord & {
  checklistId?: string;
  probeId?: string;
  observation?: LooseRecord;
  emitFailedClaim?: boolean;
  poisonedSession?: boolean;
  poisonedReasons?: unknown[];
};

type EvidenceProbePlan = LooseRecord & {
  probes?: EvidenceProbe[];
};

type ChecklistVerdict = LooseRecord & {
  status?: string | null;
  reason?: string | null;
  items?: LooseRecord[];
  blocking?: unknown[];
  fixScope?: unknown[];
};

type VerificationEvidence = LooseRecord & {
  git?: LooseRecord;
  hardGate?: LooseRecord & { checks?: unknown[] };
};

type PlanArtifact = LooseRecord & {
  kind?: string;
  name?: string;
  path?: string;
  sha256?: string;
  bytes?: number;
};

type PhaseResultRecord = LooseRecord & {
  artifact?: PlanArtifact;
};

type VerifyContext = LooseRecord & {
  project: string;
  cpbRoot: string;
  pool?: unknown;
  sourcePath?: string;
  jobId: string;
  dataRoot?: string;
  role?: string;
  workflow?: string;
  sourceContext?: LooseRecord & {
    acceptanceChecklistArtifact?: LooseRecord & { name?: string };
    acceptanceChecklist?: AcceptanceChecklist;
  };
  previousResults: PhaseResultRecord[];
  signal?: AbortSignal;
  processHooks?: RunJobProcessHooks;
  timeouts?: LooseRecord & { verify?: number };
  scope?: unknown;
  env?: NodeJS.ProcessEnv;
  agents?: LooseRecord;
  agent?: string | LooseRecord;
  planMode?: string;
  task?: string;
  buildPrompt?: (phase: string, ctx: VerifyContext, artifacts: LooseRecord) => string | Promise<string>;
};

type AgentRunResult = LooseRecord & {
  ok: boolean;
  output: string;
  diagnostics?: LooseRecord;
  kind?: string;
  reason?: string;
  retryable?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  cause?: unknown;
};

function acceptanceChecklistValue(value: unknown): AcceptanceChecklist | null {
  const checklist = recordValue(value);
  if (!Array.isArray(checklist.items)) return null;
  return {
    ...checklist,
    items: checklist.items.map((item) => recordValue(item) as ChecklistItem),
  };
}

function phaseAbortError(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new Error("verify phase aborted");
  err.name = "AbortError";
  return err;
}

function throwIfPhaseAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw phaseAbortError(signal);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function buildRetrySection(sourceContext: LooseRecord) {
  const retry = recordValue(sourceContext.retry);
  if (Object.keys(retry).length === 0) return "";
  return `

## Previous Attempt Failed
Your previous verification pass was rejected. Rerun this same verification phase with the corrected behavior below.

Error type: ${stringValue(retry.failureKind)}
Error: ${stringValue(retry.failureReason)}
Failure class: ${stringValue(retry.failureClass, "unknown")}
Failure fingerprint: ${stringValue(retry.failureFingerprint, "unavailable")}
Recovery strategy: ${stringValue(retry.retryStrategy, "unavailable")}
Strategy changed: ${retry.strategyChanged === true ? "yes" : "no"}
${retry.retryClass ? `Repair class: ${retry.retryClass}` : ""}
${Array.isArray(retry.fixScope) && retry.fixScope.length > 0 ? `Fix scope: ${retry.fixScope.join(", ")}` : ""}
${retry.failureEvidence ? `Failure evidence:\n\`\`\`json\n${JSON.stringify(retry.failureEvidence, null, 2)}\n\`\`\`` : ""}
${retry.instruction ? `Repair instruction: ${retry.instruction}` : ""}
${retry.previousOutput ? `\nPrevious output for reference:\n\`\`\`\n${retry.previousOutput}\n\`\`\`` : ""}`;
}

function safePathPart(value: unknown, fallback = "unknown") {
  const raw = stringValue(value, fallback);
  return raw.replace(/[^A-Za-z0-9._-]/g, "-") || fallback;
}

function verifierJsonOutputFilePath({ cpbRoot, dataRoot, project, jobId }: {
  cpbRoot: string;
  dataRoot?: string;
  project: string;
  jobId: string;
}) {
  const root = dataRoot || path.join(cpbRoot, "runtime", "projects", safePathPart(project));
  return path.join(
    root,
    "phase-io",
    "verify",
    `${safePathPart(jobId)}-verdict-${randomUUID()}.json`,
  );
}

function verifierJsonOutputFileInstruction(filePath: string) {
  return `

## STRUCTURED VERDICT FILE (MANDATORY)
Before your final response, write the final CPB JSON envelope to this exact file:
VERIFIER_JSON_OUTPUT_FILE=${filePath}

The file content MUST be raw JSON only: no markdown code fences, no prose, no command output.
The JSON object in the file MUST use the same envelope required below, including checklistVerdict for checklist-aware jobs.
Your final chat response should also contain the JSON envelope, but CPB will read this file first to avoid ACP transport truncation or formatting noise.`;
}

export async function readVerifierJsonOutputFile(filePath: string) {
  let before: BigIntStats;
  try {
    before = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (recordValue(error).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw Object.assign(new Error("verifier output is not a single-link regular nofollow file"), {
      code: "VERIFIER_OUTPUT_UNSAFE",
    });
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  return await runWithTemporaryReplayCleanup({
    cleanup: async () => {
      await handle?.close();
    },
    description: "verifier output descriptor",
    operation: async () => {
      try {
        handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
        const [descriptor, current] = await Promise.all([
          handle.stat({ bigint: true }),
          lstat(filePath, { bigint: true }),
        ]);
        if (
          !descriptor.isFile()
          || !current.isFile()
          || current.isSymbolicLink()
          || descriptor.nlink !== 1n
          || current.nlink !== 1n
          || descriptor.dev !== current.dev
          || descriptor.ino !== current.ino
          || before.dev !== current.dev
          || before.ino !== current.ino
          || before.mode !== current.mode
          || before.size !== current.size
          || before.ctimeNs !== current.ctimeNs
          || before.mtimeNs !== current.mtimeNs
        ) {
          throw Object.assign(new Error("verifier output changed identity while opening"), {
            code: "VERIFIER_OUTPUT_IDENTITY_CHANGED",
          });
        }
        const size = Number(descriptor.size);
        if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024) {
          throw Object.assign(new Error("verifier output exceeds the 1 MiB transport limit"), {
            code: "VERIFIER_OUTPUT_TOO_LARGE",
          });
        }
        const buffer = Buffer.alloc(size);
        let bytesRead = 0;
        while (bytesRead < size) {
          const chunk = await handle.read(buffer, bytesRead, size - bytesRead, bytesRead);
          if (chunk.bytesRead === 0) break;
          bytesRead += chunk.bytesRead;
        }
        const [after, finalPath] = await Promise.all([
          handle.stat({ bigint: true }),
          lstat(filePath, { bigint: true }),
        ]);
        if (
          bytesRead !== size
          || after.nlink !== 1n
          || finalPath.nlink !== 1n
          || after.dev !== descriptor.dev
          || after.ino !== descriptor.ino
          || finalPath.dev !== descriptor.dev
          || finalPath.ino !== descriptor.ino
          || after.mode !== descriptor.mode
          || after.size !== descriptor.size
          || after.ctimeNs !== descriptor.ctimeNs
          || after.mtimeNs !== descriptor.mtimeNs
          || finalPath.mode !== descriptor.mode
          || finalPath.size !== descriptor.size
          || finalPath.ctimeNs !== descriptor.ctimeNs
          || finalPath.mtimeNs !== descriptor.mtimeNs
        ) {
          throw Object.assign(new Error("verifier output changed while reading"), {
            code: "VERIFIER_OUTPUT_CHANGED_DURING_READ",
          });
        }
        const content = buffer.toString("utf8");
        return content.trim() ? content : null;
      } catch (error) {
        if (recordValue(error).code === "ENOENT") {
          throw Object.assign(new Error("verifier output disappeared after its initial identity was observed", {
            cause: error,
          }), {
            code: "VERIFIER_OUTPUT_IDENTITY_CHANGED",
          });
        }
        throw error;
      }
    },
  });
}

interface VerifierVerdict {
  ok: boolean;
  status: string;
  reason: string;
  details?: string;
  confidence?: number;
  checklistVerdict?: LooseRecord | null;
  [key: string]: unknown;
}

export function checklistInfrastructureFailure(
  checklistVerdict: ChecklistVerdict,
  evidenceLedger: LooseRecord,
  verdict: VerifierVerdict,
) {
  const verdictItems = Array.isArray(checklistVerdict.items) ? checklistVerdict.items : [];
  const failedIds = new Set(
    verdictItems
      .filter((item) => item.result === "fail" || item.result === "unchecked")
      .map((item) => stringValue(item.checklistId))
      .filter(Boolean),
  );
  if (failedIds.size === 0) return null;
  const failedEvidence = (Array.isArray(evidenceLedger.evidence) ? evidenceLedger.evidence : [])
    .map(recordValue)
    .filter((entry) => failedIds.has(stringValue(entry.checklistId)) && entry.result === "fail");
  if (failedEvidence.length === 0 || failedEvidence.some((entry) => entry.infrastructureFailure !== true)) return null;

  const explanation = [
    stringValue(verdict.reason),
    stringValue(verdict.details),
    ...verdictItems.map((item) => `${stringValue(item.actualResult)} ${stringValue(item.reason)}`),
  ].join(" ");
  const explicitlyUnavailable = /(?:\b(?:no|without|lacks?)\b[^.]{0,100}\bpassing\b[^.]{0,80}\bevidence\b|predeclared (?:deterministic )?(?:ledger|test evidence)[^.]{0,100}\b(?:fail|failing|marked fail)\b|could not rerun[^.]{0,120}\b(?:missing|unavailable|network|environment)\b|no trusted structured probe|environment (?:is |was )?(?:read-only|unavailable)|could not create (?:a )?(?:usable )?temporary directory|extension modules? (?:are|is) not built|blocked by .*environment)/i.test(explanation);
  if (!explicitlyUnavailable) return null;

  return {
    failureClass: "verification_infrastructure",
    retryPhase: "verify",
    candidateMutationAllowed: false,
    failedChecklistIds: [...failedIds].sort(),
    evidenceFailureClasses: [...new Set(failedEvidence.map((entry) => stringValue(entry.failureClass)).filter(Boolean))],
    reason: "verification could not obtain runnable independent evidence; the candidate must remain frozen",
  };
}

export function executableVerificationEvidenceSummary(
  evidenceLedger: LooseRecord,
  hardGate: LooseRecord,
  independentVerifierExecutions: LooseRecord | null = null,
  acceptanceChecklist: AcceptanceChecklist | null = null,
) {
  const ledgerEvidence = (Array.isArray(evidenceLedger.evidence) ? evidenceLedger.evidence : [])
    .map(recordValue);
  const ledgerPasses = ledgerEvidence.filter((entry) =>
    entry.result === "pass"
    && (entry.verificationMethod === "test" || entry.verificationMethod === "command")
    && Number(entry.exitCode) === 0
  );
  const hardGatePasses = (Array.isArray(hardGate.checks) ? hardGate.checks : [])
    .map(recordValue)
    .filter((entry) =>
      entry.ok === true
      && entry.skipped !== true
      && /(?:test|pytest|vitest|jest|go test|cargo test)/i.test(stringValue(entry.gate || entry.command))
    );
  const genericExecutionPassed = ledgerPasses.length > 0
    || hardGatePasses.length > 0
    || independentVerifierExecutions?.ok === true;
  const observableCoverage = observableContractExecutionCoverage(
    acceptanceChecklist,
    independentVerifierExecutions,
  );
  return {
    ok: genericExecutionPassed && observableCoverage.ok,
    genericExecutionPassed,
    observableCoverage,
    ledgerEvidenceIds: ledgerPasses.map((entry) => stringValue(entry.id)).filter(Boolean),
    hardGateCommands: hardGatePasses.map((entry) => stringValue(entry.gate || entry.command)).filter(Boolean),
    independentVerifierExecutions: independentVerifierExecutions || {
      ok: false,
      reason: "no verifier ACP execution audit was available",
      observations: [],
    },
  };
}

const VERIFIER_TEST_COMMAND = /(?:^|[\s/])(?:pytest|py\.test|tox|nox)(?:\s|$)|\bpython(?:\d+(?:\.\d+)*)?\s+-m\s+(?:pytest|unittest)\b|\bnode\s+--test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:npx|pnpm\s+exec|yarn\s+exec)\s+(?:vitest|jest|mocha)\b|\bgo\s+test\b|\bcargo\s+test\b|\b(?:mvn|mvnw)\b[^\n]*\btest\b|\b(?:gradle|gradlew)\b[^\n]*\btest\b|\bdotnet\s+test\b|\bmake\s+(?:[\w.-]*test[\w.-]*)\b/i;
const VERIFIER_INLINE_RUNTIME_PROBE = /^(?:(?:\S*\/)?env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s]+|"[^"]*"|'[^']*')\s+)*(?:\S*\/)?(?:python(?:\d+(?:\.\d+)*)?|node|ruby|php)\s+(?:-(?:c|e|r)\b|-\s*<<|<<)/i;

function verifierExecutionClass(command: string) {
  const normalized = command.trim();
  if (!normalized) return null;
  if (VERIFIER_TEST_COMMAND.test(normalized)) return "test";
  if (VERIFIER_INLINE_RUNTIME_PROBE.test(normalized)) return "runtime_probe";
  return null;
}

/**
 * Extract successful dynamic checks from the fresh verifier's own ACP session.
 * The verifier runs in a read-only candidate workspace, and ACP — not the
 * verifier's prose — supplies the tool id and terminal completion status.
 * Read/search/build commands do not qualify; only test commands and inline
 * runtime behavior probes do.
 */
export function summarizeIndependentVerifierExecutions(
  auditText: string,
  {
    sessionId,
    startedAt,
    completedAt,
  }: {
    sessionId?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  } = {},
) {
  const parsedEvents: LooseRecord[] = [];
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const endMs = completedAt ? Date.parse(completedAt) : Number.NaN;
  const hasWindow = Number.isFinite(startMs) && Number.isFinite(endMs);
  const sessionLastSeen = new Map<string, number>();
  for (const line of auditText.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = recordValue(JSON.parse(line));
      if (event.phase !== "verify" || event.role !== "verifier") continue;
      const timestamp = Date.parse(stringValue(event.ts));
      if (hasWindow && (!Number.isFinite(timestamp) || timestamp < startMs - 2_000 || timestamp > endMs)) continue;
      parsedEvents.push(event);
      const eventSessionId = stringValue(event.sessionId);
      if (eventSessionId) sessionLastSeen.set(eventSessionId, Number.isFinite(timestamp) ? timestamp : 0);
    } catch {
      continue;
    }
  }
  const resolvedSessionId = sessionId || (hasWindow
    ? [...sessionLastSeen.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
    : null) || null;
  if (!resolvedSessionId) {
    return {
      ok: false,
      reason: hasWindow
        ? "verifier ACP session could not be resolved inside the execution window"
        : "verifier ACP session id and execution window are unavailable",
      sessionId: null,
      observations: [],
    };
  }

  const calls = new Map<string, LooseRecord>();
  for (const event of parsedEvents) {
    if (event.event !== "tool_call") continue;
    if (stringValue(event.sessionId) !== resolvedSessionId) continue;
    const toolCallId = stringValue(event.toolCallId);
    if (!toolCallId) continue;
    const previous = calls.get(toolCallId) || {};
    calls.set(toolCallId, {
      ...previous,
      toolCallId,
      sessionId: resolvedSessionId,
      ...(stringValue(event.title) ? { command: stringValue(event.title) } : {}),
      ...(stringValue(event.kind) ? { kind: stringValue(event.kind) } : {}),
      ...(stringValue(event.status) ? { status: stringValue(event.status) } : {}),
      ...(stringValue(event.ts) ? { observedAt: stringValue(event.ts) } : {}),
    });
  }

  const attempts = [...calls.values()]
    .filter((entry) => stringValue(entry.kind).toLowerCase() === "execute")
    .map((entry) => ({ ...entry, executionClass: verifierExecutionClass(stringValue(entry.command)) }))
    .filter((entry) => Boolean(entry.executionClass))
    .map((entry) => ({
      ...entry,
      command: stringValue(entry.command).slice(0, 4_000),
      auditEventSha256: `sha256:${createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`,
    }));
  const observations = attempts
    .filter((entry) => stringValue(entry.status).toLowerCase() === "completed");

  return {
    ok: observations.length > 0,
    reason: observations.length > 0
      ? "fresh read-only verifier completed a dynamic test or runtime behavior probe"
      : "fresh verifier ACP session had no completed test or runtime behavior probe",
    sessionId: resolvedSessionId,
    attempts,
    observations,
  };
}

async function readIndependentVerifierExecutions(diagnostics: LooseRecord) {
  const auditFile = stringValue(diagnostics.acpAuditFile);
  const sessionId = stringValue(diagnostics.sessionId);
  if (!auditFile) {
    return { ok: false, reason: "verifier ACP audit file is unavailable", sessionId: sessionId || null, observations: [] };
  }
  try {
    return summarizeIndependentVerifierExecutions(await readFile(auditFile, "utf8"), {
      sessionId,
      startedAt: stringValue(diagnostics.startedAt),
      completedAt: stringValue(diagnostics.completedAt),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `verifier ACP audit could not be read: ${err instanceof Error ? err.message : String(err)}`,
      sessionId: sessionId || null,
      observations: [],
    };
  }
}

export function isRepositoryTestPath(file: string) {
  const normalized = file.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  return /(?:^|\/)(?:tests?|testing|specs?|__tests__)(?:\/|$)/i.test(normalized)
    || /^test_.+\.[^.]+$/i.test(basename)
    || /(?:_test|\.test|\.spec)\.[^.]+$/i.test(basename);
}

function safeRepositoryPath(file: string) {
  return Boolean(file)
    && !path.posix.isAbsolute(file)
    && !file.includes("\\")
    && !file.split("/").includes("..");
}

async function failAfterTemporaryReplaySetup(workspace: TemporaryGitWorktree, primaryError: unknown): Promise<never> {
  try {
    await workspace.cleanup();
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "temporary verification replay setup and cleanup failed",
      { cause: cleanupError },
    );
  }
  throw primaryError;
}

export async function runWithTemporaryReplayCleanup<T>({
  cleanup,
  operation,
  description = "temporary verification replay",
}: {
  cleanup: (() => Promise<unknown>) | null | undefined;
  operation: () => Promise<T>;
  description?: string;
}): Promise<T> {
  let operationFailed = false;
  let primaryError: unknown;
  try {
    return await operation();
  } catch (err) {
    operationFailed = true;
    primaryError = err;
    throw err;
  } finally {
    if (cleanup) {
      try {
        await cleanup();
      } catch (cleanupError) {
        if (operationFailed) {
          throw new AggregateError(
            [primaryError, cleanupError],
            `${description} operation and cleanup failed`,
            { cause: cleanupError },
          );
        }
        throw cleanupError;
      }
    }
  }
}

export async function materializeCandidateVerificationReplay({
  cwd,
  candidate,
  env = process.env,
}: {
  cwd: string;
  candidate: CandidateArtifact;
  env?: NodeJS.ProcessEnv;
}) {
  const workspace = await createTemporaryGitWorktree({
    sourcePath: cwd,
    revision: candidate.headSha,
    prefix: "cpb-candidate-verification-",
    env,
  });
  const replayPath = workspace.worktreePath;
  try {
    await applyFrozenGitTreeDelta({
      sourceRoot: cwd,
      replayRoot: replayPath,
      fromTree: candidate.headSha,
      candidateTree: candidate.treeHash,
      files: candidate.changedFiles,
      env: workspace.gitEnv,
    });
    const replayCandidate = await captureCandidateArtifact({
      cwd: replayPath,
      base: candidate.baseSha,
      env: workspace.gitEnv,
    });
    const candidateVerification = verifyCandidateArtifactIdentity(candidate, replayCandidate);
    if (!candidateVerification.matches) {
      throw new Error(`candidate verification replay identity mismatch: ${candidateVerification.mismatches.map((entry) => entry.field).join(", ")}`);
    }
    return {
      replayPath,
      candidateVerification,
      cleanup: workspace.cleanup,
    };
  } catch (err) {
    return await failAfterTemporaryReplaySetup(workspace, err);
  }
}

export async function materializeBaselineTestContractReplay({
  cwd,
  baseSha,
  changedFiles,
  contractTestFiles = [],
  candidateTree,
  env = process.env,
}: {
  cwd: string;
  baseSha: string;
  changedFiles: string[];
  contractTestFiles?: string[];
  candidateTree?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const candidateTestFiles = changedFiles.filter(isRepositoryTestPath).sort();
  const requestedTestFiles = [...new Set([
    ...candidateTestFiles,
    ...contractTestFiles.filter(isRepositoryTestPath),
  ])].filter(safeRepositoryPath).sort();
  if (requestedTestFiles.length === 0) return null;

  const testFiles: string[] = [];
  for (const file of requestedTestFiles) {
    try {
      await execFile("git", ["cat-file", "-e", `${baseSha}:${file}`], { cwd, env, maxBuffer: 1024 * 1024 });
      testFiles.push(file);
    } catch {
      // Candidate-authored new tests are intentionally absent from the replay.
    }
  }

  const workspace = await createTemporaryGitWorktree({
    sourcePath: cwd,
    revision: baseSha,
    prefix: "cpb-baseline-test-contract-",
    env,
  });
  const replayPath = workspace.worktreePath;
  try {
    const productionFiles = changedFiles.filter((entry) => !isRepositoryTestPath(entry)).sort();
    const frozenCandidateTree = candidateTree || (await captureCandidateArtifact({
      cwd,
      base: baseSha,
      env: workspace.gitEnv,
    })).treeHash;
    await applyFrozenGitTreeDelta({
      sourceRoot: cwd,
      replayRoot: replayPath,
      fromTree: baseSha,
      candidateTree: frozenCandidateTree,
      files: productionFiles,
      env: workspace.gitEnv,
    });
    return {
      replayPath,
      testFiles,
      candidateTestFiles,
      omittedCandidateTestFiles: candidateTestFiles.filter((file) => !testFiles.includes(file)),
      productionFiles,
      cleanup: workspace.cleanup,
    };
  } catch (err) {
    return await failAfterTemporaryReplaySetup(workspace, err);
  }
}

export function buildDisposableVerificationReplayEnv(ctx: LooseRecord): NodeJS.ProcessEnv {
  return {
    ...buildPhaseAcpEnv(ctx, "verify"),
    CPB_VERIFIER_REPLAY_WORKSPACE_WRITE: "1",
    CPB_CODEX_VERIFIER_WORKSPACE_WRITE: "1",
  };
}

async function runBaselineTestContractVerification({
  ctx,
  cwd,
  changedFiles,
  contractTestFiles,
  baseSha,
  expectedCandidate,
  resolvedAgent,
  verificationRound,
}: {
  ctx: VerifyContext;
  cwd: string;
  changedFiles: string[];
  contractTestFiles: string[];
  baseSha: string;
  expectedCandidate: CandidateArtifact | null;
  resolvedAgent: { agent: string; variant: unknown };
  verificationRound: number;
}) {
  const phaseEnv = ctx.env ?? process.env;
  const replay = await materializeBaselineTestContractReplay({
    cwd,
    baseSha,
    changedFiles,
    contractTestFiles,
    candidateTree: expectedCandidate?.treeHash,
    env: phaseEnv,
  });
  if (!replay) {
    return { required: false, ok: true, reason: "candidate did not modify repository test paths" };
  }

  return await runWithTemporaryReplayCleanup({
    cleanup: replay.cleanup,
    description: "baseline test-contract replay",
    operation: async () => {
    const [productionDiff, candidateTestDiff] = await Promise.all([
      git(replay.replayPath, ["diff", baseSha], phaseEnv),
      replay.candidateTestFiles.length > 0
        ? git(cwd, ["--literal-pathspecs", "diff", baseSha, "--", ...replay.candidateTestFiles], phaseEnv)
        : Promise.resolve({ stdout: "", stderr: "" }),
    ]);
    const prompt = `You are the independent backward-compatibility verifier for a software change.

The candidate touches behavior covered by repository tests (and may also modify tests), so CPB materialized an isolated replay containing:
- the candidate's production changes;
- every repository test file restored exactly to the frozen base revision;
- no candidate-authored test edits.

Task:
${ctx.task || ""}

Restored repository test paths:
${JSON.stringify(replay.testFiles, null, 2)}

Candidate-authored test paths omitted because they do not exist at frozen HEAD:
${JSON.stringify(replay.omittedCandidateTestFiles, null, 2)}

Candidate production files in this replay:
${JSON.stringify(replay.productionFiles, null, 2)}

Candidate's withheld test-file diff (audit only; these edits are NOT present in the replay):
\`\`\`diff
${limitText(candidateTestDiff.stdout, 12_000)}
\`\`\`

Production-only replay diff:
\`\`\`diff
${limitText(productionDiff.stdout, 16_000)}
\`\`\`

Your job is adversarial:
1. Inspect the restored HEAD tests as compatibility contracts.
2. Run repository-appropriate focused tests in this replay when possible.
3. Check whether the production change makes an existing restored assertion fail merely because the candidate rewrote that assertion in its own test diff.
4. PASS only when existing contracts remain valid, or the original task explicitly requires superseding the exact old behavior and the production change is narrowly scoped to that requirement.
5. If tests cannot run, use static comparison between restored assertions and the production diff. Do not accept candidate-authored test changes as proof.
6. Return FAIL or PARTIAL on an unproven compatibility change; explain the exact old contract at risk.

Return the standard verifier JSON envelope.` + JSON_INSTRUCTION;
    throwIfPhaseAborted(ctx.signal);
    const promptArtifact = await writePromptArtifact(ctx.cpbRoot, {
      project: ctx.project,
      jobId: ctx.jobId,
      phase: "verify-baseline-contract",
      role: "verifier",
      agent: resolvedAgent.agent,
      prompt,
      dataRoot: ctx.dataRoot,
      signal: ctx.signal as AbortSignal | undefined,
    });
    const agentResult = await runAgent({
      phase: "verify",
      role: "verifier",
      ...resolvedAgent,
      project: ctx.project,
      jobId: ctx.jobId,
      prompt,
      cwd: replay.replayPath,
      pool: ctx.pool,
      timeoutMs: ctx.timeouts?.verify ?? 0,
      scope: ctx.scope,
      // This checkout is disposable and removed in finally. Tests may create
      // bytecode, generated version modules, compiler outputs, or caches here
      // without mutating the frozen candidate that this replay protects.
      env: buildDisposableVerificationReplayEnv(ctx),
      dataRoot: ctx.dataRoot,
      onProgress: ctx.onProgress,
      attemptId: ctx.attemptId,
      conversationKey: `${ctx.conversationKey || `cpb:${ctx.project}:${ctx.jobId}:verifier`}:baseline-test-contract:candidate:${expectedCandidate?.identityHash || "unknown"}:round:${verificationRound}`,
      signal: ctx.signal as AbortSignal | undefined,
    }) as AgentRunResult;
    throwIfPhaseAborted(ctx.signal);
    if (!agentResult.ok) {
      return {
        required: true,
        ok: false,
        reason: agentResult.reason || "baseline test contract verifier failed to run",
        retryable: agentResult.retryable === true,
        replay: {
          testFiles: replay.testFiles,
          candidateTestFiles: replay.candidateTestFiles,
          omittedCandidateTestFiles: replay.omittedCandidateTestFiles,
          productionFiles: replay.productionFiles,
        },
        promptArtifact,
        diagnostics: agentResult.diagnostics,
      };
    }
    const verdict = parseVerifierJson(agentResult.output) as VerifierVerdict;
    const independentExecutions = await readIndependentVerifierExecutions(recordValue(agentResult.diagnostics));
    throwIfPhaseAborted(ctx.signal);
    return {
      required: true,
      ok: verdict.ok === true && verdict.status === "pass",
      reason: verdict.reason || "baseline test contract verifier did not pass",
      retryable: false,
      verdict,
      independentExecutions,
      replay: {
        testFiles: replay.testFiles,
        candidateTestFiles: replay.candidateTestFiles,
        omittedCandidateTestFiles: replay.omittedCandidateTestFiles,
        productionFiles: replay.productionFiles,
      },
      promptArtifact,
      diagnostics: agentResult.diagnostics,
    };
    },
  });
}

const execFile = promisify(execFileCb) as ExecFileAsync;
const OUTPUT_TAIL_CHARS = 4000;
const PROMPT_PLAN_CHARS = 12_000;
const PROMPT_DIFF_CHARS = 16_000;
const PROMPT_DIFF_STAT_CHARS = 40_000;
const VERDICT_LINE_PREFIX = "VERDICT:";

const JSON_INSTRUCTION = `

You MUST respond with ONLY a JSON envelope inside a code block. No text before or after.

Example response (passing):
\`\`\`json
{
  "status": "ok",
  "verdict": "pass",
  "reason": "Implementation matches all acceptance criteria",
  "details": "GET /users endpoint returns correct JSON structure. Pagination works with limit/offset params. Input validation rejects invalid params with 400.",
  "confidence": 0.9
}
\`\`\`

Example response (failing):
\`\`\`json
{
  "status": "ok",
  "verdict": "fail",
  "reason": "Missing input validation for negative page numbers",
  "details": "The endpoint accepts page=-1 without error. Expected 400 Bad Request.",
  "confidence": 0.95
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- verdict MUST be exactly "pass", "fail", or "partial"
- confidence MUST be a number between 0.0 and 1.0
- For checklist-aware jobs, checklistVerdict MUST be a top-level sibling of details; never nest it inside details
- Do NOT write any artifact files yourself. The system will persist the verdict.`;

async function getChangedJsFiles(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const files = new Set<string>();
  try {
    // Tracked: staged or modified vs HEAD
    const { stdout: diffOut } = await execFile("git", ["diff", "--name-only", "--diff-filter=AM", "HEAD"], { cwd, env });
    for (const f of diffOut.trim().split("\n")) {
      if (f && /\.(js|mjs)$/.test(f)) files.add(f);
    }
  } catch { /* not a git repo */ }
  try {
    // Untracked: new files not yet staged
    const { stdout: statOut } = await execFile("git", ["ls-files", "--others", "--exclude-standard"], { cwd, env });
    for (const f of statOut.trim().split("\n")) {
      if (f && /\.(js|mjs)$/.test(f)) files.add(f);
    }
  } catch { /* ignore */ }
  return [...files];
}

async function hasTestScript(cwd: string) {
  try {
    const raw = await readFile(`${cwd}/package.json`, "utf8");
    const pkg = JSON.parse(raw);
    return typeof pkg.scripts?.test === "string";
  } catch {
    return false;
  }
}

async function focusedNodeTestFiles(cwd: string, jsFiles: string[], env: NodeJS.ProcessEnv = process.env) {
  const tests = new Set<string>();
  for (const file of jsFiles) {
    if (file.endsWith(".test.js")) tests.add(file);
    const base = file.replace(/\.(js|mjs)$/, "");
    for (const candidate of [
      `${base}.test.js`,
      `test/${base.split("/").pop()}.test.js`,
      `tests/${base.split("/").pop()}.test.js`,
    ]) {
      try {
        await execFile("test", ["-f", candidate], { cwd, env });
        tests.add(candidate);
      } catch {}
    }
  }
  return [...tests];
}

async function runHardGates(cwd: string, opts: {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  registerChild?: (pid: number) => void | Promise<void>;
} = {}) {
  throwIfPhaseAborted(opts.signal);
  const errors = [];
  const checks = [];
  const phaseEnv = opts.env ?? process.env;

  const gateTimeout = (key: string, def: number) => {
    const n = Number.parseInt(phaseEnv[key] || "", 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const checkMs = gateTimeout("CPB_GATE_TIMEOUT_CHECK", 30_000);
  const testMs = gateTimeout("CPB_GATE_TIMEOUT_TEST", 120_000);
  const fullMs = gateTimeout("CPB_GATE_TIMEOUT_FULL", 600_000);
  const childEnv = buildRuntimeEnv(phaseEnv, { CI: "1" }) as Record<string, string>;

  // Adapt a runCommandTree result into the err-shape formatCommandFailure expects
  // (execFile used to throw an Error with code/signal/stdout/stderr).
  const toErr = (r: CommandTreeLike, timeoutMs: number): CommandFailure => ({
    code: r.exitCode === null || r.exitCode === undefined ? undefined : String(r.exitCode),
    signal: typeof r.signal === "string" ? r.signal : null,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
    timedOut: r.timedOut === true,
    message: r.timedOut ? `timed out after ${timeoutMs}ms` : (r.error?.message || `exit code ${r.exitCode}`),
  });
  const run = (command: string, args: string[], timeoutMs: number, env?: Record<string, string>) =>
    runCommandTree(command, args, {
      cwd,
      env,
      signal: opts.signal,
      timeoutMs,
      onSpawn: (() => {
        const registerChild = opts.registerChild;
        return registerChild ? (pid: number) => { void registerChild(pid); } : undefined;
      })(),
    });

  // Gate 1: node --check on relevant compiled .js files
  const jsFiles = await getChangedJsFiles(cwd, phaseEnv);
  throwIfPhaseAborted(opts.signal);
  for (const file of jsFiles) {
    throwIfPhaseAborted(opts.signal);
    const r = await run("node", ["--check", file], checkMs, childEnv);
    if (r.aborted || opts.signal?.aborted) throw phaseAbortError(opts.signal);
    if (r.exitCode === 0) {
      checks.push({ gate: "node --check", file, ok: true });
    } else {
      const formatted = formatCommandFailure(`node --check ${file}`, toErr(r, checkMs));
      checks.push({ gate: "node --check", file, ok: false, ...formatted });
      errors.push(formatted.reason);
    }
  }

  const focusedTests = await focusedNodeTestFiles(cwd, jsFiles, phaseEnv);
  throwIfPhaseAborted(opts.signal);
  if (focusedTests.length > 0) {
    const r = await run("node", ["--test", ...focusedTests], testMs, childEnv);
    if (r.aborted || opts.signal?.aborted) throw phaseAbortError(opts.signal);
    if (r.exitCode === 0) {
      checks.push({ gate: "focused node --test", files: focusedTests, ok: true });
    } else {
      const formatted = formatCommandFailure(`node --test ${focusedTests.join(" ")}`, toErr(r, testMs));
      checks.push({ gate: "focused node --test", files: focusedTests, ok: false, ...formatted });
      errors.push(formatted.reason);
    }
  } else {
    checks.push({ gate: "focused node --test", ok: true, skipped: true, reason: "no matching focused node tests" });
  }

  // Gate 2: full npm test only when explicitly requested. The verifier agent still
  // checks acceptance criteria after these hard gates.
  throwIfPhaseAborted(opts.signal);
  if (phaseEnv.CPB_VERIFY_FULL === "1" && await hasTestScript(cwd)) {
    const r = await run("npm", ["test"], fullMs, childEnv);
    if (r.aborted || opts.signal?.aborted) throw phaseAbortError(opts.signal);
    if (r.exitCode === 0) {
      checks.push({ gate: "npm test", ok: true });
    } else {
      const formatted = formatCommandFailure("npm test", toErr(r, fullMs));
      checks.push({ gate: "npm test", ok: false, ...formatted });
      errors.push(formatted.reason);
    }
  }

  if (errors.length > 0) {
    return { ok: false, reason: errors.join("\n"), checks };
  }
  return { ok: true, checks };
}

function tail(text: unknown, maxChars = OUTPUT_TAIL_CHARS): string {
  const value = String(text || "");
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function formatCommandFailure(command: string, err: CommandFailure) {
  const exitCode = err?.code ?? null;
  const signal = err?.signal ?? null;
  const stdoutTail = tail(err?.stdout || "");
  const stderrTail = tail(err?.stderr || "");
  const parts = [`${command} failed`];
  if (exitCode !== null) parts.push(`exitCode=${exitCode}`);
  if (signal) parts.push(`signal=${signal}`);
  if (stdoutTail.trim()) parts.push(`stdout tail:\n${stdoutTail.trim()}`);
  if (stderrTail.trim()) parts.push(`stderr tail:\n${stderrTail.trim()}`);
  if (!stdoutTail.trim() && !stderrTail.trim() && err?.message) parts.push(`message: ${err.message}`);
  return {
    command,
    exitCode,
    signal,
    stdoutTail,
    stderrTail,
    message: err?.message || "",
    reason: parts.join("\n"),
  };
}

/**
 * Build the evidence ledger before the verifier prompt.
 * The ledger is deterministic: the verifier may only cite ids already present here.
 */
export function buildEvidenceLedger({
  jobId,
  project,
  attemptId,
  acceptanceChecklist,
  verificationEvidence,
  evidenceProbePlan,
  ledgerId,
}: {
  jobId?: string;
  project?: string;
  attemptId?: string;
  acceptanceChecklist?: LooseRecord | null;
  verificationEvidence: VerificationEvidence;
  evidenceProbePlan: EvidenceProbePlan;
  ledgerId?: string;
}): LooseRecord {
  const gitEvidence = recordValue(verificationEvidence.git);
  const finalWorktree: LooseRecord = {
    head: typeof gitEvidence.head === "string" ? gitEvidence.head : null,
    diffHash: typeof gitEvidence.diffHash === "string" ? gitEvidence.diffHash : null,
  };

  const checklist = acceptanceChecklistValue(acceptanceChecklist);
  if (!checklist) {
    return { schemaVersion: 1, jobId, project, attemptId, ledgerId, finalWorktree, evidence: [] };
  }

  const evidence: LooseRecord[] = [];
  let index = 1;
  for (const probe of evidenceProbePlan.probes || []) {
    const checklistItem = checklist.items.find((item) => item.id === probe.checklistId);
    if (!checklistItem) continue;
    const validation = validateEvidenceObservation(recordValue(probe.observation), checklistItem, { attemptId, finalWorktree });
    // `valid` = the record-gate: whether to emit a ledger entry at all.
    // `satisfied` = the result: pass vs fail. A valid-but-not-satisfied entry
    // (e.g. static matchCount:0) must be emitted with result:"fail" so the
    // honest fail flows to retry/remediate — never silently completed.
    if (!validation.valid && !probe.emitFailedClaim) continue;
    const evidenceMetadata = evidenceMetadataForLedgerEntry(probe, checklistItem);
    evidence.push({
      id: `EV-${String(index++).padStart(3, "0")}`,
      type: "evidence_claim",
      observationType: checklistItem.verificationMethod,
      checklistId: probe.checklistId,
      attemptId,
      verificationMethod: checklistItem.verificationMethod,
      predicateId: checklistItem.predicateId,
      probeId: probe.probeId,
      result: validation.satisfied ? "pass" : "fail",
      ...evidenceMetadata,
      ...probe.observation,
      worktreeHead: finalWorktree.head,
      diffHash: finalWorktree.diffHash,
      ...(probe.poisonedSession === true ? { poisonedSession: true, poisonedReasons: probe.poisonedReasons || [] } : {}),
    });
  }
  return { schemaVersion: 1, jobId, project, attemptId, ledgerId, finalWorktree, evidence };
}

function evidenceMetadataForLedgerEntry(probe: LooseRecord, checklistItem: LooseRecord) {
  const observation = recordValue(probe.observation);
  const metadata: LooseRecord = {
    evidenceClass: stringValue(observation.evidenceClass || checklistItem.evidenceClass || checklistItem.verificationMethod),
    evidenceOrigin: stringValue(observation.evidenceOrigin || observation.origin || checklistItem.evidenceOrigin || "deterministic_probe"),
  };
  if (typeof observation.coversRealPath === "boolean") metadata.coversRealPath = observation.coversRealPath;
  if (typeof observation.coversOnlyMinimalRepro === "boolean") metadata.coversOnlyMinimalRepro = observation.coversOnlyMinimalRepro;
  return metadata;
}

/**
 * Synthesize a failing checklist verdict with every required item marked unchecked.
 */
function synthesizeUncheckedChecklistVerdict({
  jobId,
  acceptanceChecklist,
  reason,
}: {
  jobId?: string;
  acceptanceChecklist: AcceptanceChecklist;
  reason: string;
}) {
  return {
    schemaVersion: 1,
    jobId,
    status: "fail",
    items: acceptanceChecklist.items
      .filter((item) => item.required)
      .map((item) => ({
        checklistId: item.id,
        result: "unchecked",
        evidenceRefs: [],
        actualResult: "",
        reason,
        fixScope: [],
      })),
    blocking: [],
    fixScope: [],
    reason,
  };
}

function evidenceRefsForChecklistItem({
  evidenceLedger,
  checklistItem,
  attemptId,
}: {
  evidenceLedger: LooseRecord;
  checklistItem: ChecklistItem;
  attemptId: string;
}) {
  const ledgerId = stringValue(evidenceLedger.ledgerId);
  const finalWorktree = recordValue(evidenceLedger.finalWorktree);
  const evidence = Array.isArray(evidenceLedger.evidence) ? evidenceLedger.evidence : [];

  return evidence
    .map((entry) => recordValue(entry))
    .filter((entry) => entry.type === "evidence_claim")
    .filter((entry) => entry.result === "pass")
    .filter((entry) => stringValue(entry.checklistId) === checklistItem.id)
    .filter((entry) => stringValue(entry.verificationMethod) === stringValue(checklistItem.verificationMethod))
    .filter((entry) => stringValue(entry.predicateId) === stringValue(checklistItem.predicateId))
    .filter((entry) => validateEvidenceObservation(entry, checklistItem, { attemptId, finalWorktree }).satisfied)
    .map((entry) => ({ ledgerId, evidenceId: stringValue(entry.id) }))
    .filter((ref) => ref.ledgerId && ref.evidenceId);
}

function synthesizePassingChecklistVerdictFromEvidence({
  jobId,
  acceptanceChecklist,
  evidenceLedger,
  attemptId,
}: {
  jobId?: string;
  acceptanceChecklist: AcceptanceChecklist;
  evidenceLedger: LooseRecord;
  attemptId: string;
}): ChecklistVerdict | null {
  const requiredItems: ChecklistItem[] = acceptanceChecklist.items
    .map((item) => recordValue(item) as ChecklistItem)
    .filter((item) => item.required === true);
  const verdictItems = [];

  for (const item of requiredItems) {
    const evidenceRefs = evidenceRefsForChecklistItem({ evidenceLedger, checklistItem: item, attemptId });
    if (evidenceRefs.length === 0) return null;
    verdictItems.push({
      checklistId: item.id,
      result: "pass",
      evidenceRefs,
      actualResult: "Objective evidence ledger contains a passing claim for this checklist item.",
      reason: "Recovered from deterministic evidence ledger after verifier omitted checklistVerdict.",
      fixScope: [],
    });
  }

  return {
    schemaVersion: 1,
    jobId,
    status: "pass",
    items: verdictItems,
    blocking: [],
    fixScope: [],
    reason: "Recovered from deterministic evidence ledger after verifier omitted checklistVerdict.",
  };
}

/**
 * Re-map evidenceRefs in the checklistVerdict from the placeholder ledgerId
 * the verifier used to the actual ledgerId assigned by the evidence ledger.
 */
function remapEvidenceRefs(checklistVerdict: LooseRecord & { items?: LooseRecord[] }, actualLedgerId: string) {
  if (!Array.isArray(checklistVerdict?.items)) return checklistVerdict;
  return {
    ...checklistVerdict,
    items: checklistVerdict.items.map((item) => ({
      ...item,
      evidenceRefs: (Array.isArray(item.evidenceRefs) ? item.evidenceRefs : []).map(
        (ref: unknown) => {
          const refRecord = recordValue(ref);
          return {
            ...refRecord,
            ledgerId: refRecord.ledgerId === "pending" || !refRecord.ledgerId ? actualLedgerId : refRecord.ledgerId,
          };
        },
      ),
    })),
  };
}

function normalizeChecklistVerdictReasons(checklistVerdict: LooseRecord & { items?: LooseRecord[] }): ChecklistVerdict {
  if (!Array.isArray(checklistVerdict?.items)) return checklistVerdict;
  const verdictReason = stringValue(checklistVerdict.reason, "Verifier checklist verdict did not provide an item reason.");
  return {
    ...checklistVerdict,
    // The transport-level verifier contract permits "partial", while the
    // frozen checklist contract intentionally has only pass/fail terminal
    // states. A partial checklist is a semantic failure, not malformed JSON.
    status: checklistVerdict.status === "partial" ? "fail" : checklistVerdict.status,
    items: checklistVerdict.items.map((item) => ({
      ...item,
      reason: stringValue(item.reason)
        || stringValue(item.actualResult)
        || verdictReason,
    })),
  };
}

export async function runVerify(ctx: VerifyContext) {
  throwIfPhaseAborted(ctx.signal);
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const { dataRoot } = ctx;
  const role = ctx.role || "verifier";
  const cwd = stringValue(sourcePath) || cpbRoot;
  const runtimeEnv = ctx.env ?? process.env;
  const attemptId = String(ctx.attemptId || jobId);

  // Resolve active acceptance checklist.
  // The authoritative source is the event-indexed artifact store, but for
  // performance we use the sourceContext fast path when run-job has already
  // validated and event-indexed the checklist.
  // sourceContext.acceptanceChecklist WITHOUT an event-indexed artifact
  // handle is ignored for checklist authority -- it cannot make the verifier
  // mint checklist artifacts.
  let acceptanceChecklist: AcceptanceChecklist | null = null;
  if (ctx.sourceContext?.acceptanceChecklistArtifact?.name && ctx.sourceContext?.acceptanceChecklist) {
    // Fast path: run-job already validated and event-indexed the checklist
    acceptanceChecklist = ctx.sourceContext.acceptanceChecklist;
  }
  // Do NOT fall through to readActiveChecklistArtifacts in the hot path.
  // The artifact store lookup is available for completion-gate and audit
  // which run after the phase returns.

  const planArtifact: PlanArtifact | null = getRequiredArtifact(ctx.previousResults, "plan") ?? null;
  const expectedCandidate = candidateFromPreviousResults(ctx.previousResults);
  const scopeReviewRequest = buildScopeReviewRequest({
    executionMap: executionMapFromPhaseResults(ctx.previousResults as LooseRecord[]),
    checklist: acceptanceChecklist,
    candidateId: expectedCandidate?.identityHash || null,
  });
  const assurancePolicy = resolveHighAssurancePolicy(ctx as LooseRecord);
  const blindVerification = assurancePolicy.enabled && assurancePolicy.verification.blind;
  const planRequired = shouldRequirePlanArtifact(ctx);
  const planEvidence = await collectPlanEvidence(planArtifact, {
    required: planRequired,
    workflow: ctx.workflow,
    planMode: stringValue(ctx.planMode) || null,
  });
  if (planRequired && !isUsablePlanEvidence(planEvidence)) {
    const reason = planEvidence.reason || "verify requires a readable plan artifact before judging current diff";
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason,
        retryable: false,
        cause: {
          planRequired: true,
          plan: planEvidence,
        },
      }),
      diagnostics: { planRequired: planEvidence },
    });
  }

  let candidateVerification: CandidateArtifactVerificationRecord | null = null;
  if (expectedCandidate) {
    try {
      const actualCandidate = await captureCandidateArtifact({ cwd, base: expectedCandidate.baseSha, env: runtimeEnv });
      candidateVerification = verifyCandidateArtifactIdentity(expectedCandidate, actualCandidate);
      if (!candidateVerification.matches) {
        return candidateIdentityFailure(candidateVerification, "before verification");
      }
    } catch (err) {
      return phaseFailed({
        phase: "verify",
        failure: failure({
          kind: FailureKind.VERIFICATION_FAILED,
          phase: "verify",
          reason: `unable to bind verification to the executor candidate: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        }),
      });
    }
  }

  // Hard gates run BEFORE agent — non-bypassable syntax + test checks
  const gate = await runHardGates(cwd, { env: runtimeEnv, signal: ctx?.signal, registerChild: ctx?.processHooks?.registerChild });
  throwIfPhaseAborted(ctx.signal);
  if (!gate.ok) {
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: gate.reason,
        retryable: false,
        cause: {
          hardGate: true,
          checks: gate.checks,
        },
      }),
      diagnostics: { hardGate: gate },
    });
  }

  const promptPlanEvidence: LooseRecord = blindVerification
    ? {
        available: false,
        withheld: true,
        reason: "winning plan withheld from fresh blind verifier",
        name: recordValue(planEvidence).name || null,
        sha256: recordValue(planEvidence).sha256 || null,
      }
    : recordValue(planEvidence);
  const verificationEvidence = await collectVerificationEvidence(cwd, planArtifact, gate, promptPlanEvidence, runtimeEnv);
  throwIfPhaseAborted(ctx.signal);

  // Build evidence ledger BEFORE verifier prompt.
  // The ledger is deterministic: the verifier sees the exact claim ids it may cite.
  const ledgerId = `evidence-ledger-${jobId}`;
  // Deterministic probes provide objective scope evidence (the change landed
  // in the item's declared files), independent of the verifier agent's claim.
  const probeChecks = acceptanceChecklist
    ? await runChecklistProbes(acceptanceChecklist, cwd, { finalWorktree: verificationEvidence.git, attemptId, env: runtimeEnv })
    : [];
  throwIfPhaseAborted(ctx.signal);
  const hardGateChecks = [
    ...(Array.isArray(verificationEvidence.hardGate?.checks) ? verificationEvidence.hardGate.checks : []),
    ...probeChecks,
  ];
  const evidenceProbePlan = acceptanceChecklist
    ? buildEvidenceProbePlan({
        acceptanceChecklist,
        hardGateChecks,
        attemptId,
        finalWorktree: verificationEvidence.git,
      })
    : { probes: [] };
  const evidenceLedger = buildEvidenceLedger({
    jobId,
    project,
    attemptId,
    acceptanceChecklist,
    verificationEvidence,
    evidenceProbePlan,
    ledgerId,
  });

  const deterministicChecklistVerdict = acceptanceChecklist
    ? deterministicLightChecklistVerdict({
        ctx,
        acceptanceChecklist,
        evidenceLedger,
        hardGate: gate,
        attemptId,
      })
    : null;
  // High-assurance mode reserves a fresh Codex judgment for every candidate.
  // Deterministic evidence remains part of that judgment, but must not replace
  // the verifier model turn.
  if (deterministicChecklistVerdict && !assurancePolicy.enabled) {
    throwIfPhaseAborted(ctx.signal);
    const evidenceLedgerArtifact = await writeArtifact(cpbRoot, {
      signal: ctx.signal as AbortSignal | undefined,
      project,
      jobId,
      kind: "evidence-ledger",
      content: JSON.stringify(evidenceLedger, null, 2),
      dataRoot,
      metadata: evidenceLedger,
    });
    throwIfPhaseAborted(ctx.signal);
    const checklistVerdictArtifact = await writeArtifact(cpbRoot, {
      signal: ctx.signal as AbortSignal | undefined,
      project,
      jobId,
      kind: "checklist-verdict",
      content: JSON.stringify(deterministicChecklistVerdict, null, 2),
      dataRoot,
      metadata: deterministicChecklistVerdict,
    });
    const verdict: VerifierVerdict = {
      ok: true,
      status: "pass",
      reason: "Deterministic light verification passed scoped evidence and focused tests.",
      details: "Candidate identity, hard gates, focused tests, and every required static checklist claim passed without a redundant verifier model turn.",
      confidence: 1,
      checklistVerdict: deterministicChecklistVerdict,
    };
    throwIfPhaseAborted(ctx.signal);
    const artifact = await writeArtifact(cpbRoot, {
      signal: ctx.signal as AbortSignal | undefined,
      project,
      jobId,
      kind: "verdict",
      content: renderVerdictMarkdown(verdict),
      dataRoot,
      metadata: verdict,
    });
    let finalCandidateVerification;
    try {
      finalCandidateVerification = await verifyCandidateAfterValidation(cwd, expectedCandidate, candidateVerification, runtimeEnv);
      throwIfPhaseAborted(ctx.signal);
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError") throw err;
      return candidateCaptureFailure(err, "after deterministic light verification");
    }
    if (finalCandidateVerification && !finalCandidateVerification.matches) {
      return candidateIdentityFailure(finalCandidateVerification, "during deterministic light verification");
    }
    return phasePassed({
      phase: "verify",
      artifact,
      diagnostics: {
        verificationMode: "deterministic_light",
        verdict,
        verificationEvidence,
        evidenceLedgerArtifact,
        checklistVerdictArtifact,
        candidateVerification: finalCandidateVerification,
        validatedCandidateIdentityHash: expectedCandidate?.identityHash || null,
      },
    });
  }

  const resolvedAgent = resolveAgent(ctx, "codex");
  const usesDisposableVerificationReplay = assurancePolicy.enabled && Boolean(expectedCandidate);
  const verifierEnv = { ...buildPhaseAcpEnv(ctx, "verify") };
  const claudeCompatibleAgent = /^(?:claude|claude-.+)$/.test(resolvedAgent.agent);
  const verifierFileTransportAvailable = resolvedAgent.agent !== "codex"
    && !usesDisposableVerificationReplay
    && (!claudeCompatibleAgent || Boolean(parseAgentFilesystemBoundary(verifierEnv.CPB_AGENT_FS_BOUNDARY_JSON)));
  const verifierOutputFilePath = verifierJsonOutputFilePath({ cpbRoot, dataRoot, project, jobId });
  throwIfPhaseAborted(ctx.signal);
  if (verifierFileTransportAvailable) {
    await mkdir(path.dirname(verifierOutputFilePath), { recursive: true });
  }
  const prompt = await buildVerifyPrompt(ctx, blindVerification ? null : planArtifact, verificationEvidence, {
    acceptanceChecklist,
    evidenceLedger,
    blindVerification,
    scopeReviewRequest,
  })
    // Codex verification is a hard read-only lane. Its final ACP response is
    // the verdict transport; requiring a file would force workspace-write and
    // let the verifier alter the candidate it is supposed to judge.
    + (verifierFileTransportAvailable ? verifierJsonOutputFileInstruction(verifierOutputFilePath) : "")
    + JSON_INSTRUCTION;
  throwIfPhaseAborted(ctx.signal);
  const promptArtifact = await writePromptArtifact(cpbRoot, {
    project,
    jobId,
    phase: "verify",
    role,
    agent: resolvedAgent.agent,
    prompt,
    dataRoot,
    signal: ctx.signal as AbortSignal | undefined,
  });
  throwIfPhaseAborted(ctx.signal);

  const verificationRound = ctx.previousResults.filter((result) => result.phase === "verify").length + 1;
  const verificationConversationKey = blindVerification
    ? `${ctx.conversationKey || `cpb:${project}:${jobId}:verifier`}:candidate:${expectedCandidate?.identityHash || "unknown"}:round:${verificationRound}`
    : ctx.conversationKey;
  let verificationReplay: Awaited<ReturnType<typeof materializeCandidateVerificationReplay>> | null = null;
  let verifierCwd = cwd;
  if (usesDisposableVerificationReplay && expectedCandidate) {
    try {
      verificationReplay = await materializeCandidateVerificationReplay({ cwd, candidate: expectedCandidate, env: runtimeEnv });
      throwIfPhaseAborted(ctx.signal);
      verifierCwd = verificationReplay.replayPath;
      Object.assign(verifierEnv, buildDisposableVerificationReplayEnv(ctx));
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError") throw err;
      const reason = `unable to materialize disposable verification replay: ${err instanceof Error ? err.message : String(err)}`;
      return phaseFailed({
        phase: "verify",
        failure: failure({
          kind: FailureKind.VERIFICATION_FAILED,
          phase: "verify",
          reason,
          retryable: true,
          cause: {
            verificationInfrastructure: {
              failureClass: "verification_infrastructure",
              retryPhase: "verify",
              candidateMutationAllowed: false,
              reason,
            },
          },
        }),
        diagnostics: withPromptArtifactDiagnostics({ candidateVerification }, promptArtifact),
      });
    }
  }

  let agentResult: AgentRunResult | null = null;
  let replayCandidateVerification: CandidateArtifactVerificationRecord | null = null;
  let replayCaptureError: unknown = null;
  await runWithTemporaryReplayCleanup({
    cleanup: verificationReplay?.cleanup,
    description: "candidate verification replay",
    operation: async () => {
      agentResult = await runAgent({
      phase: "verify",
      role,
      ...resolvedAgent,
      project,
      jobId,
      prompt,
      cwd: verifierCwd,
      pool,
      timeoutMs: ctx.timeouts?.verify ?? 0,
      scope: ctx.scope,
      env: verifierEnv,
      dataRoot,
      onProgress: ctx.onProgress,
      attemptId: ctx.attemptId,
      conversationKey: verificationConversationKey,
      signal: ctx.signal as AbortSignal | undefined,
      }) as AgentRunResult;
      if (verificationReplay && agentResult.ok) {
        try {
          const replayCandidate = await captureCandidateArtifact({
            cwd: verificationReplay.replayPath,
            base: expectedCandidate?.baseSha || "HEAD",
            env: runtimeEnv,
          });
          replayCandidateVerification = verifyCandidateArtifactIdentity(expectedCandidate as CandidateArtifact, replayCandidate);
        } catch (err) {
          replayCaptureError = err;
        }
      }
    },
  });

  if (!agentResult) throw new Error("verifier agent returned no result");
  throwIfPhaseAborted(ctx.signal);
  if (replayCaptureError) {
    const reason = `unable to recapture disposable verification replay: ${replayCaptureError instanceof Error ? replayCaptureError.message : String(replayCaptureError)}`;
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason,
        retryable: true,
        cause: {
          verificationInfrastructure: {
            failureClass: "verification_infrastructure",
            retryPhase: "verify",
            candidateMutationAllowed: false,
            reason,
          },
        },
      }),
      diagnostics: withPromptArtifactDiagnostics({ candidateVerification }, promptArtifact),
    });
  }
  if (replayCandidateVerification && !replayCandidateVerification.matches) {
    const reason = `disposable verifier changed candidate source state: ${replayCandidateVerification.mismatches.map((item) => item.field).join(", ")}`;
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason,
        retryable: true,
        cause: {
          candidateVerification: replayCandidateVerification,
          verificationInfrastructure: {
            failureClass: "verification_infrastructure",
            retryPhase: "verify",
            candidateMutationAllowed: false,
            reason,
          },
        },
      }),
      diagnostics: withPromptArtifactDiagnostics({ candidateVerification: replayCandidateVerification }, promptArtifact),
    });
  }

  if (!agentResult.ok) {
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: stringValue(agentResult.kind, FailureKind.UNKNOWN),
        phase: "verify",
        reason: agentResult.reason,
        retryable: agentResult.retryable,
        exitCode: agentResult.exitCode,
        signal: agentResult.signal,
        cause: agentResult.cause || {},
      }),
      diagnostics: withPromptArtifactDiagnostics(recordValue(agentResult.diagnostics), promptArtifact),
    });
  }

  throwIfPhaseAborted(ctx.signal);
  // retain: dynamic JSON boundary — parseVerifierJson returns an inferred shape
  // with `any` fields from JSON.parse; the assertion narrows agent JSON to the
  // typed VerifierVerdict contract at the external-input boundary.
  const verifierFileOutput = verifierFileTransportAvailable
    ? await readVerifierJsonOutputFile(verifierOutputFilePath)
    : null;
  const verifierOutputSource = verifierFileOutput ? "file" : "agent-output";
  const verifierOutput = verifierFileOutput || agentResult.output;
  const verifierOutputDiagnostics = {
    ...agentResult.diagnostics,
    verificationReplay: verificationReplay
      ? {
          used: true,
          disposed: true,
          workspaceWriteForBuilds: true,
          initialCandidateVerification: verificationReplay.candidateVerification,
          finalCandidateVerification: replayCandidateVerification,
        }
      : { used: false },
    verifierOutputFile: {
      path: verifierOutputFilePath,
      used: verifierOutputSource === "file",
      source: verifierOutputSource,
    },
  };
  const verdict = parseVerifierJson(verifierOutput) as VerifierVerdict;
  if (!verdict.ok) {
    const rawOutput = stringValue(verifierOutput);
    throwIfPhaseAborted(ctx.signal);
    const rawAgentOutputArtifact = await writeArtifact(cpbRoot, {
      signal: ctx.signal as AbortSignal | undefined,
      project,
      jobId,
      kind: "agent-output",
      content: rawOutput,
      dataRoot,
      metadata: {
        phase: "verify",
        role,
        agent: resolvedAgent.agent,
        reason: verdict.reason,
        source: verifierOutputSource,
        verifierOutputFile: verifierOutputFilePath,
      },
    });
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERDICT_INVALID,
        phase: "verify",
        reason: verdict.reason,
        retryable: true,
        stderrSnippet: rawOutput.slice(-500),
      }),
      diagnostics: withPromptArtifactDiagnostics({ ...verifierOutputDiagnostics, rawAgentOutputArtifact }, promptArtifact),
    });
  }

  const scopeReviewValidation = validateScopeReview(verdict.scopeReview, scopeReviewRequest);
  Object.assign(verifierOutputDiagnostics, {
    scopeReviewRequest,
    scopeReviewValidation,
  });
  if (
    scopeReviewRequest
    && (
      !scopeReviewValidation.ok
      || (verdict.status === "pass" && scopeReviewValidation.decision !== "approve")
    )
  ) {
    const reason = !scopeReviewValidation.ok
      ? scopeReviewValidation.reason
      : "a passing verifier verdict must approve the required scope expansion";
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERDICT_INVALID,
        phase: "verify",
        reason,
        retryable: true,
        cause: {
          candidateId: expectedCandidate?.identityHash || null,
          scopeReviewRequest,
          scopeReview: verdict.scopeReview || null,
          scopeReviewValidation,
        },
      }),
      diagnostics: withPromptArtifactDiagnostics({
        ...verifierOutputDiagnostics,
        verdict,
      }, promptArtifact),
    });
  }

  // Persist evidence ledger only for checklist-aware jobs.
  // Legacy jobs don't need the evidence-ledger artifact.
  let evidenceLedgerArtifact: LooseRecord | null = null;
  if (acceptanceChecklist) {
    throwIfPhaseAborted(ctx.signal);
    evidenceLedgerArtifact = await writeArtifact(cpbRoot, {
      signal: ctx.signal as AbortSignal | undefined,
      project,
      jobId,
      kind: "evidence-ledger",
      content: JSON.stringify(evidenceLedger, null, 2),
      dataRoot,
      metadata: evidenceLedger,
    });
  }

  // ── Checklist-aware verdict validation ──────────────────────────────
  // When a readable event-indexed acceptance-checklist artifact exists,
  // require a valid checklistVerdict. sourceContext.acceptanceChecklist
  // does not authorize checklist artifacts.
  if (acceptanceChecklist) {
    const rawChecklistVerdict = verdict.checklistVerdict || null;
    const recoveredChecklistVerdict = !rawChecklistVerdict && verdict.status === "pass"
      ? synthesizePassingChecklistVerdictFromEvidence({
          jobId,
          acceptanceChecklist,
          evidenceLedger,
          attemptId,
        })
      : null;
    const checklistVerdict = rawChecklistVerdict
      ? normalizeChecklistVerdictReasons(remapEvidenceRefs(rawChecklistVerdict, stringValue(evidenceLedger.ledgerId, ledgerId)))
      : recoveredChecklistVerdict;

    // Try to validate the verifier-provided checklist verdict
    let verdictValidation: LooseRecord | null = null;
    if (checklistVerdict) {
      verdictValidation = validateChecklistVerdict(checklistVerdict, acceptanceChecklist);
    }

    const usedFailingSynthesis = !checklistVerdict || !verdictValidation?.ok;
    const finalChecklistVerdict: ChecklistVerdict = usedFailingSynthesis
      ? synthesizeUncheckedChecklistVerdict({
          jobId,
          acceptanceChecklist,
          reason: checklistVerdict
            ? `checklist verdict validation failed${verdictValidation?.reason ? `: ${verdictValidation.reason}` : ""}`
            : "checklist-aware job requires checklistVerdict",
        })
      : checklistVerdict as ChecklistVerdict;

    throwIfPhaseAborted(ctx.signal);
    const checklistVerdictArtifact = await writeArtifact(cpbRoot, {
      signal: ctx.signal as AbortSignal | undefined,
      project,
      jobId,
      kind: "checklist-verdict",
      content: JSON.stringify(finalChecklistVerdict, null, 2),
      dataRoot,
      metadata: finalChecklistVerdict,
    });

    // If we had to synthesize the verdict, the verify phase FAILS.
    if (usedFailingSynthesis) {
      return phaseFailed({
        phase: "verify",
        failure: failure({
          kind: FailureKind.VERDICT_INVALID,
          phase: "verify",
          reason: finalChecklistVerdict.reason,
          retryable: false,
          cause: { checklistVerdict: finalChecklistVerdict },
        }),
        diagnostics: withPromptArtifactDiagnostics(
          { ...verifierOutputDiagnostics, evidenceLedgerArtifact, checklistVerdictArtifact },
          promptArtifact,
        ),
      });
    }

    // Checklist verdict is valid; still write legacy verdict for compatibility
    const verdictMarkdown = renderVerdictMarkdown(verdict);
    throwIfPhaseAborted(ctx.signal);
    const artifact = await writeArtifact(cpbRoot, {
      signal: ctx.signal as AbortSignal | undefined,
      project,
      jobId,
      kind: "verdict",
      content: verdictMarkdown,
      dataRoot,
      metadata: verdict,
    });

    // A valid checklist verdict with status "fail" must fail the verify phase,
    // mirroring the legacy path (verdict.status !== "pass" -> VERIFICATION_FAILED).
    // Otherwise a verifier that returns a failing checklist would be recorded as
    // passing just because its verdict shape validated.
    if (finalChecklistVerdict.status === "fail") {
      const verificationInfrastructure = checklistInfrastructureFailure(
        finalChecklistVerdict,
        evidenceLedger,
        verdict,
      );
      return phaseFailed({
        phase: "verify",
        failure: failure({
          kind: FailureKind.VERIFICATION_FAILED,
          phase: "verify",
          reason: finalChecklistVerdict.reason || verdict.reason || "verification failed",
          retryable: true,
          cause: {
            verdict,
            artifact,
            checklistVerdict: finalChecklistVerdict,
            checklistVerdictArtifact,
            ...(verificationInfrastructure ? { verificationInfrastructure } : {}),
          },
        }),
        diagnostics: withPromptArtifactDiagnostics(
          { ...verifierOutputDiagnostics, artifact, verdict, evidenceLedgerArtifact, checklistVerdictArtifact },
          promptArtifact,
        ),
      });
    }

    let finalCandidateVerification;
    try {
      finalCandidateVerification = await verifyCandidateAfterValidation(cwd, expectedCandidate, candidateVerification, runtimeEnv);
      throwIfPhaseAborted(ctx.signal);
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError") throw err;
      return candidateCaptureFailure(err, "after checklist verification");
    }
    if (finalCandidateVerification && !finalCandidateVerification.matches) {
      return candidateIdentityFailure(finalCandidateVerification, "during verification");
    }

    let baselineTestContract: LooseRecord = {
      required: false,
      ok: true,
      reason: "high-assurance baseline test contract replay was not required",
    };
    if (assurancePolicy.enabled) {
      try {
        baselineTestContract = await runBaselineTestContractVerification({
          ctx,
          cwd,
          changedFiles: Array.isArray(verificationEvidence.git?.changedFiles)
            ? verificationEvidence.git.changedFiles.map((file) => stringValue(file)).filter(Boolean)
            : [],
          contractTestFiles: acceptanceChecklist.items
            .flatMap((item) => Array.isArray(item.allowedFiles) ? item.allowedFiles : [])
            .map((file) => stringValue(file))
            .filter((file) => file && isRepositoryTestPath(file)),
          baseSha: expectedCandidate?.baseSha || stringValue(verificationEvidence.git?.head, "HEAD"),
          expectedCandidate,
          resolvedAgent,
          verificationRound,
        });
        throwIfPhaseAborted(ctx.signal);
      } catch (err) {
        if ((err as Error | undefined)?.name === "AbortError") throw err;
        baselineTestContract = {
          required: true,
          ok: false,
          retryable: true,
          reason: `unable to materialize baseline test contract replay: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    let baselineTestContractArtifact: LooseRecord | null = null;
    if (assurancePolicy.enabled && baselineTestContract.required === true) {
      throwIfPhaseAborted(ctx.signal);
      baselineTestContractArtifact = await writeArtifact(cpbRoot, {
        signal: ctx.signal as AbortSignal | undefined,
        project,
        jobId,
        kind: "baseline-test-contract-verdict",
        content: JSON.stringify(baselineTestContract, null, 2),
        dataRoot,
        metadata: baselineTestContract,
      });
    }
    if (baselineTestContract.ok !== true) {
      return phaseFailed({
        phase: "verify",
        failure: failure({
          kind: FailureKind.VERIFICATION_FAILED,
          phase: "verify",
          reason: `baseline repository test contract was not preserved: ${stringValue(baselineTestContract.reason, "verification did not pass")}`,
          retryable: true,
          cause: {
            verdict,
            checklistVerdict: finalChecklistVerdict,
            baselineTestContract,
            baselineTestContractArtifact,
            fixScope: Array.isArray(recordValue(baselineTestContract.replay).productionFiles)
              ? recordValue(baselineTestContract.replay).productionFiles
              : [],
          },
        }),
        diagnostics: withPromptArtifactDiagnostics({
          ...verifierOutputDiagnostics,
          artifact,
          verdict,
          verificationEvidence,
          evidenceLedgerArtifact,
          checklistVerdictArtifact,
          baselineTestContract,
          baselineTestContractArtifact,
          candidateVerification: finalCandidateVerification,
        }, promptArtifact),
      });
    }

    const independentVerifierExecutions = await readIndependentVerifierExecutions(verifierOutputDiagnostics);
    throwIfPhaseAborted(ctx.signal);
    const observableExecutionCoverage = observableContractExecutionCoverage(
      acceptanceChecklist,
      independentVerifierExecutions,
    );
    let independentVerifierExecutionArtifact: LooseRecord | null = null;
    if (assurancePolicy.enabled) {
      throwIfPhaseAborted(ctx.signal);
      independentVerifierExecutionArtifact = await writeArtifact(cpbRoot, {
        signal: ctx.signal as AbortSignal | undefined,
        project,
        jobId,
        kind: "verification-execution-evidence",
        content: JSON.stringify({
          ...independentVerifierExecutions,
          observableContractCoverage: observableExecutionCoverage,
          candidateIdentityHash: expectedCandidate?.identityHash || null,
          candidateVerification: finalCandidateVerification,
        }, null, 2),
        dataRoot,
        metadata: {
          ...independentVerifierExecutions,
          observableContractCoverage: observableExecutionCoverage,
          candidateIdentityHash: expectedCandidate?.identityHash || null,
        },
      });
    }
    const executableEvidence = executableVerificationEvidenceSummary(
      evidenceLedger,
      gate,
      independentVerifierExecutions,
      acceptanceChecklist,
    );
    if (assurancePolicy.enabled && !executableEvidence.ok) {
      const observableCoverage = recordValue(executableEvidence.observableCoverage);
      const failedObservableContracts = Array.isArray(observableCoverage.failedContractIds)
        ? observableCoverage.failedContractIds.map(String).filter(Boolean)
        : [];
      const observableMismatch = failedObservableContracts.length > 0;
      const verificationInfrastructure = observableMismatch ? null : {
        failureClass: "verification_infrastructure",
        retryPhase: "verify",
        candidateMutationAllowed: false,
        reason: observableCoverage.required === true
          ? "high-assurance verification requires a successful independent runtime assertion bound to every frozen text observable contract"
          : "high-assurance verification requires at least one successful independent test or command observation",
        executableEvidence,
      };
      const failureReason = observableMismatch
        ? `candidate failed frozen pre-execution observable contract(s): ${failedObservableContracts.join(", ")}`
        : stringValue(verificationInfrastructure?.reason, "high-assurance executable evidence is incomplete");
      return phaseFailed({
        phase: "verify",
        failure: failure({
          kind: FailureKind.VERIFICATION_FAILED,
          phase: "verify",
          reason: failureReason,
          retryable: true,
          cause: {
            verdict,
            artifact,
            checklistVerdict: finalChecklistVerdict,
            checklistVerdictArtifact,
            executableEvidence,
            ...(verificationInfrastructure ? { verificationInfrastructure } : {}),
            ...(observableMismatch ? {
              fixScope: Array.isArray(observableCoverage.fixScope) ? observableCoverage.fixScope : [],
              targetChecklistIds: Array.isArray(observableCoverage.targetChecklistIds)
                ? observableCoverage.targetChecklistIds
                : [],
              failedObservableContracts,
            } : {}),
          },
        }),
        diagnostics: withPromptArtifactDiagnostics(
          {
            ...verifierOutputDiagnostics,
            artifact,
            verdict,
            verificationEvidence,
            evidenceLedgerArtifact,
            checklistVerdictArtifact,
            executableEvidence,
            independentVerifierExecutionArtifact,
            baselineTestContract,
            baselineTestContractArtifact,
          },
          promptArtifact,
        ),
      });
    }
    return phasePassed({
      phase: "verify",
      artifact,
      diagnostics: withPromptArtifactDiagnostics(
        {
          ...verifierOutputDiagnostics,
          verdict,
          verificationEvidence,
          evidenceLedgerArtifact,
          checklistVerdictArtifact,
          executableEvidence,
          independentVerifierExecutionArtifact,
          baselineTestContract,
          baselineTestContractArtifact,
          candidateVerification: finalCandidateVerification,
          validatedCandidateIdentityHash: expectedCandidate?.identityHash || null,
        },
        promptArtifact,
      ),
    });
  }

  // ── Legacy (non-checklist-aware) path ───────────────────────────────
  const verdictMarkdown = renderVerdictMarkdown(verdict);
  throwIfPhaseAborted(ctx.signal);
  const artifact = await writeArtifact(cpbRoot, {
    signal: ctx.signal as AbortSignal | undefined,
    project,
    jobId,
    kind: "verdict",
    content: verdictMarkdown,
    dataRoot,
    metadata: verdict,
  });

  if (verdict.status !== "pass") {
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: verdict.reason || "verification failed",
        retryable: true,
        cause: { verdict, artifact },
      }),
      diagnostics: withPromptArtifactDiagnostics({ ...verifierOutputDiagnostics, artifact, verdict }, promptArtifact),
    });
  }

  let finalCandidateVerification;
  try {
    finalCandidateVerification = await verifyCandidateAfterValidation(cwd, expectedCandidate, candidateVerification, runtimeEnv);
    throwIfPhaseAborted(ctx.signal);
  } catch (err) {
    if ((err as Error | undefined)?.name === "AbortError") throw err;
    return candidateCaptureFailure(err, "after verification");
  }
  if (finalCandidateVerification && !finalCandidateVerification.matches) {
    return candidateIdentityFailure(finalCandidateVerification, "during verification");
  }
  return phasePassed({
    phase: "verify",
    artifact,
    diagnostics: withPromptArtifactDiagnostics({
      ...verifierOutputDiagnostics,
      verdict,
      verificationEvidence,
      candidateVerification: finalCandidateVerification,
      validatedCandidateIdentityHash: expectedCandidate?.identityHash || null,
    }, promptArtifact),
  });
}

function deterministicLightChecklistVerdict({
  ctx,
  acceptanceChecklist,
  evidenceLedger,
  hardGate,
  attemptId,
}: {
  ctx: VerifyContext;
  acceptanceChecklist: AcceptanceChecklist;
  evidenceLedger: LooseRecord;
  hardGate: LooseRecord;
  attemptId: string;
}) {
  if (ctx.planMode !== "light") return null;
  const riskMap = recordValue(ctx.sourceContext?.riskMap);
  const riskLevel = stringValue(riskMap.riskLevel).toLowerCase();
  if (riskLevel !== "low" && riskLevel !== "medium") return null;
  if (riskMap.adversarialRequired === true) return null;

  const requiredItems = acceptanceChecklist.items
    .map((item) => recordValue(item))
    .filter((item) => item.required === true);
  if (requiredItems.length === 0) return null;
  if (requiredItems.some((item) => (
    stringValue(item.verificationMethod) !== "static"
    || item.requiresRealPathEvidence === true
  ))) return null;

  const checks = Array.isArray(hardGate.checks)
    ? hardGate.checks.map((check) => recordValue(check))
    : [];
  const focusedTestPassed = checks.some((check) => (
    check.ok === true
    && check.skipped !== true
    && /(?:^|\s)(?:node --test|npm test)(?:\s|$)/i.test(stringValue(check.gate))
  ));
  if (!focusedTestPassed) return null;

  const verdict = synthesizePassingChecklistVerdictFromEvidence({
    jobId: ctx.jobId,
    acceptanceChecklist,
    evidenceLedger,
    attemptId,
  });
  if (!verdict) return null;
  return {
    ...verdict,
    reason: "All required static checklist items passed deterministic probes and focused tests.",
    items: Array.isArray(verdict.items)
      ? verdict.items.map((item) => ({
          ...item,
          reason: "Deterministic scope evidence and a focused test passed for this light-mode candidate.",
        }))
      : [],
  };
}

function candidateFromPreviousResults(previousResults: PhaseResultRecord[] = []): CandidateArtifact | null {
  for (let index = previousResults.length - 1; index >= 0; index -= 1) {
    if (previousResults[index].phase !== "execute") continue;
    const candidate = recordValue(recordValue(previousResults[index].diagnostics).candidateArtifact);
    if (candidate.schemaVersion === 1 && typeof candidate.identityHash === "string") {
      return candidate as CandidateArtifact;
    }
  }
  return null;
}

async function verifyCandidateAfterValidation(
  cwd: string,
  expectedCandidate: CandidateArtifact | null,
  initialVerification: CandidateArtifactVerificationRecord | null,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!expectedCandidate) return initialVerification;
  const actualCandidate = await captureCandidateArtifact({ cwd, base: expectedCandidate.baseSha, env });
  return verifyCandidateArtifactIdentity(expectedCandidate, actualCandidate);
}

function candidateIdentityFailure(
  candidateVerification: CandidateArtifactVerificationRecord,
  stage: string,
) {
  return phaseFailed({
    phase: "verify",
    failure: failure({
      kind: FailureKind.VERIFICATION_FAILED,
      phase: "verify",
      reason: `candidate identity changed ${stage}: ${candidateVerification.mismatches.map((item) => item.field).join(", ")}`,
      retryable: true,
      cause: { candidateVerification },
    }),
    diagnostics: { candidateVerification },
  });
}

function candidateCaptureFailure(err: unknown, stage: string) {
  return phaseFailed({
    phase: "verify",
    failure: failure({
      kind: FailureKind.VERIFICATION_FAILED,
      phase: "verify",
      reason: `unable to recapture candidate identity ${stage}: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    }),
  });
}

async function collectVerificationEvidence(
  cwd: string,
  planArtifact: PlanArtifact | null,
  hardGate: LooseRecord,
  planEvidence: LooseRecord | null = null,
  env: NodeJS.ProcessEnv = process.env,
) {
  const [plan, gitEvidence] = await Promise.all([
    planEvidence ? Promise.resolve(planEvidence) : collectPlanEvidence(planArtifact),
    collectGitEvidence(cwd, env),
  ]);
  const sourceOfTruth = ["task", "current_diff", "changed_files", "hard_gates"];
  if (plan.available) sourceOfTruth.splice(1, 0, "plan");
  return {
    sourceOfTruth,
    executorDeliverablePolicy: "self_report_only_not_verification_evidence",
    plan,
    git: gitEvidence,
    hardGate,
  };
}

function shouldRequirePlanArtifact(ctx: VerifyContext) {
  if (ctx?.workflow === "direct") return false;
  return ctx?.planMode !== "light" && ctx?.planMode !== "none";
}

async function collectPlanEvidence(planArtifact: PlanArtifact | null, {
  required = true,
  workflow = null,
  planMode = null,
}: {
  required?: boolean;
  workflow?: string | null;
  planMode?: string | null;
} = {}) {
  if (!planArtifact) {
    if (!required) {
      const noPlanReason = planMode === "light" || planMode === "none"
        ? `planMode "${planMode}" has no plan phase`
        : `${workflow || "direct"} workflow has no plan phase`;
      return {
        available: false,
        optional: true,
        workflow,
        planMode,
        reason: `${noPlanReason}; verify must use task, current diff, changed files, hard gates, and tests`,
      };
    }
    return { available: false, reason: "verify requires a plan artifact in previous phase results" };
  }
  const plan: LooseRecord & {
    available: boolean;
    reason?: string;
    excerpt?: string;
    truncated?: boolean;
  } = {
    available: true,
    name: planArtifact.name || null,
    path: planArtifact.path || null,
    sha256: planArtifact.sha256 || null,
    bytes: planArtifact.bytes || null,
  };
  if (!planArtifact.path) {
    plan.available = false;
    plan.reason = "verify requires a readable plan artifact path";
    return plan;
  }
  try {
    const content = await readFile(planArtifact.path, "utf8");
    plan.excerpt = limitText(content, PROMPT_PLAN_CHARS);
    plan.truncated = content.length > PROMPT_PLAN_CHARS;
    if (!content.trim()) {
      plan.available = false;
      plan.reason = "verify requires non-empty plan artifact content";
    }
  } catch (err) {
    plan.available = false;
    plan.reason = `plan artifact unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }
  return plan;
}

function isUsablePlanEvidence(plan: LooseRecord) {
  return Boolean(plan?.available && plan.path && String(plan.excerpt || "").trim());
}

async function collectGitEvidence(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const evidence: LooseRecord = {
    available: false,
    cwd,
    statusShort: "",
    changedFiles: [],
    diffStat: "",
    diffExcerpt: "",
    diffTruncated: false,
    head: null,
    diffHash: null,
    reason: null,
  };

  try {
    const [status, trackedFiles, untrackedFiles, diffStat, diff] = await Promise.all([
      git(cwd, ["status", "--short"], env),
      git(cwd, ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"], env),
      git(cwd, ["ls-files", "--others", "--exclude-standard"], env),
      git(cwd, ["diff", "--stat", "HEAD"], env),
      git(cwd, ["diff", "HEAD"], env),
    ]);

    const changedFiles = uniqueLines(`${trackedFiles.stdout}\n${untrackedFiles.stdout}`);
    const diffExcerpt = limitText(diff.stdout, PROMPT_DIFF_CHARS);
    evidence.available = true;
    evidence.statusShort = status.stdout.trim();
    evidence.changedFiles = changedFiles;
    evidence.diffStat = limitText(diffStat.stdout, PROMPT_DIFF_STAT_CHARS).trim();
    evidence.diffExcerpt = diffExcerpt;
    evidence.diffTruncated = diff.stdout.length > PROMPT_DIFF_CHARS;

    // Collect HEAD commit and diff hash for evidence freshness
    const head = await git(cwd, ["rev-parse", "HEAD"], env).catch(() => ({ stdout: "" }));
    evidence.head = head.stdout.trim() || null;
    evidence.diffHash = diff.stdout ? `sha256:${createHash("sha256").update(diff.stdout).digest("hex")}` : "sha256:empty";
  } catch (err) {
    evidence.reason = err instanceof Error ? err.message : String(err);
  }

  return evidence;
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return execFile("git", args, { cwd, env, maxBuffer: 20 * 1024 * 1024 })
    .then(({ stdout = "", stderr = "" }: { stdout?: string; stderr?: string }) => ({ stdout, stderr }));
}

function uniqueLines(text: unknown): string[] {
  return [...new Set(String(text || "").split("\n").map((line) => line.trim()).filter(Boolean))];
}

function limitText(text: unknown, maxChars: number): string {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}

function getRequiredArtifact(previousResults: PhaseResultRecord[] = [], kind: string) {
  for (let i = previousResults.length - 1; i >= 0; i--) {
    if (previousResults[i].artifact?.kind === kind) {
      return previousResults[i].artifact;
    }
  }
  return null;
}

function renderVerdictMarkdown(verdict: VerifierVerdict) {
  const statusUpper = verdict.status.toUpperCase();
  return `# Verdict

${VERDICT_LINE_PREFIX} ${statusUpper}

## Status
${statusUpper}

## Reason
${verdict.reason}

## Details
${verdict.details || "N/A"}

## Confidence
${verdict.confidence || "N/A"}
`;
}

export function verifyPhaseOutputContract() {
  return {
    verdictLinePrefix: VERDICT_LINE_PREFIX,
  };
}

export async function buildVerifyPrompt(ctx: VerifyContext, planArtifact: PlanArtifact | null, verificationEvidence: VerificationEvidence, checklistContext: {
  acceptanceChecklist?: AcceptanceChecklist | null;
  evidenceLedger?: LooseRecord;
  blindVerification?: boolean;
  scopeReviewRequest?: ScopeReviewRequest | null;
} = {}) {
  const promptVerificationEvidence = verificationEvidence;
  const promptAcceptanceChecklist = checklistContext.acceptanceChecklist;
  const blindVerification = checklistContext.blindVerification === true;
  const scopeReviewRequest = checklistContext.scopeReviewRequest || null;
  const retrySection = buildRetrySection(recordValue(ctx.sourceContext));

  let checklistSection = "";
  if (promptAcceptanceChecklist) {
    const ledger = checklistContext.evidenceLedger;
    const evidenceSummary = (Array.isArray(ledger?.evidence) ? ledger.evidence : []).map((entry: unknown) => {
      const evidenceEntry = recordValue(entry);
      return {
      evidenceId: evidenceEntry.id,
      checklistId: evidenceEntry.checklistId,
      verificationMethod: evidenceEntry.verificationMethod,
      predicateId: evidenceEntry.predicateId,
      probeId: evidenceEntry.probeId,
      result: evidenceEntry.result,
      evidenceClass: evidenceEntry.evidenceClass,
      evidenceOrigin: evidenceEntry.evidenceOrigin || evidenceEntry.origin,
      coversRealPath: evidenceEntry.coversRealPath,
      coversOnlyMinimalRepro: evidenceEntry.coversOnlyMinimalRepro,
      summary: evidenceEntry.summary || evidenceEntry.command || evidenceEntry.queryId || "",
      };
    });

    checklistSection = `

## CHECKLIST-AWARE VERIFICATION (MANDATORY)
This is a checklist-aware job. You MUST return checklistVerdict as a TOP-LEVEL field in your JSON envelope, alongside status, verdict, reason, details, and confidence. Never place checklistVerdict inside details. Cover every required checklist id. A pass item must cite evidenceRefs from the provided evidence ledger. You may only cite existing evidence ids whose checklistId, verificationMethod, and predicateId match the item. Do not invent evidence ids. Do not use executor summary or generic hard-gate output as pass evidence.

Required envelope placement and checklistVerdict shape:
{
  "status": "ok",
  "verdict": "pass",
  "reason": "Implementation matches all acceptance criteria",
  "details": "Concise verification summary",
  "confidence": 0.9,
  "checklistVerdict": {
    "schemaVersion": 1,
    "jobId": "${ctx.jobId}",
    "status": "pass",
    "items": [
      {
        "checklistId": "AC-001",
        "result": "pass",
        "evidenceRefs": [{ "ledgerId": "${ledger?.ledgerId || "evidence-ledger"}", "evidenceId": "EV-001" }],
        "actualResult": "What the cited evidence proves",
        "reason": "Why this item passes",
        "fixScope": []
      }
    ],
    "blocking": [],
    "fixScope": [],
    "reason": "All required checklist items passed with cited ledger evidence"
  }
}

### Frozen Acceptance Checklist
${JSON.stringify(promptAcceptanceChecklist, null, 2)}

### Predeclared Evidence Ledger (ledgerId: ${ledger?.ledgerId || "none"})
You may only cite evidence ids from this table:
${JSON.stringify(evidenceSummary, null, 2)}

If an item needs a probe that is not present, return unchecked with reason "probe_definition_missing" or fail. Do not invent EV-* ids.
For behavior-changing items, do a real-path audit before marking pass: identify the named real actors and entrypoints from the task/plan/diff, then decide whether the cited evidence proves that path or only an agent-authored minimal reproduction. If the cited evidence only proves a minimal repro, return fail/unchecked unless another cited evidence entry covers the real path.

### Frozen observable-oracle rule
Any observableContract in the checklist was created, hashed, and frozen before the candidate existed. It outranks candidate-authored tests, executor summaries, and values copied from the current implementation.
- For every exact_text or contains_text contract, run an independent inline runtime assertion against the real changed entrypoint. The command itself must contain expectedObservation and every forbiddenObservations literal, assert the expected match, and assert every forbidden observation is absent. A command that merely prints output does not count.
- Do not first observe the candidate and then paste that value into the expected assertion. If candidate output disagrees with the frozen contract, return FAIL and cite the counterexample.
- Preserve exact quote, escape, separator, collection-boundary, slice, and pluralization semantics. A native collection representation such as [...], {...}, or (...) wrapped in leftover scalar quotes is a representation defect unless the frozen expectedObservation explicitly contains those wrapper quotes.
- Agent-authored regression tests and candidate-derived inline assertions are supporting evidence only and cannot redefine or satisfy the frozen oracle.
`;
  }

  const scopeReviewSection = scopeReviewRequest ? `

## FROZEN SCOPE AMENDMENT REVIEW (MANDATORY)
The implementation changed files outside the plan-time checklist scope. This is not automatically a defect and the executor cannot authorize it. Inspect the exact candidate diff and independently decide whether every listed file is necessary to satisfy an existing frozen checklist requirement.

Return a top-level scopeReview field. Copy candidateId, requestHash, and unmappedFiles exactly. Use only checklist ids present in this request. PASS is invalid unless decision is "approve" and every file is mapped exactly once. Deny the expansion and return FAIL/PARTIAL if a file is unnecessary, unsafe, unrelated, or cannot be tied to an existing requirement.

Required shape:
{
  "candidateId": "${scopeReviewRequest.candidateId}",
  "requestHash": "${scopeReviewRequest.requestHash}",
  "decision": "approve",
  "unmappedFiles": ${JSON.stringify(scopeReviewRequest.unmappedFiles)},
  "mappings": [
    {
      "file": "${scopeReviewRequest.unmappedFiles[0]}",
      "checklistIds": ["${String(scopeReviewRequest.checklistItems[0]?.id || "AC-001")}"],
      "necessity": "Why this file is required for the existing requirement",
      "risk": "What compatibility or configuration risk was checked",
      "evidence": ["Exact diff/test/config evidence inspected independently"]
    }
  ]
}

Frozen review request:
${JSON.stringify(scopeReviewRequest, null, 2)}
` : "";

  if (typeof ctx.buildPrompt === "function") {
    return await ctx.buildPrompt("verify", ctx, {
      planArtifact: blindVerification ? null : planArtifact,
      verificationEvidence: promptVerificationEvidence,
      blindVerification,
      scopeReviewRequest,
    }) + checklistSection + scopeReviewSection + retrySection;
  }

  return `You are a software verification agent. Verify the following implementation:

${phaseExecutionContract("verify")}

Task: ${ctx.task}
Project: ${ctx.project}
${blindVerification
    ? "\nPlan reference: deliberately withheld for independent blind verification\n"
    : planArtifact
      ? `\nPlan reference: ${planArtifact.name}\n`
      : "\nPlan reference: unavailable\n"}
${retrySection}
${checklistSection}
${scopeReviewSection}
## Verification Source Of Truth
Use the original task, frozen acceptance checklist when present, predeclared evidence ledger, current worktree diff, hard-gate results, and tests you actually run as proof.
Executor deliverables and summaries are self-reports for audit only; do not treat them as proof of correctness.
${blindVerification
    ? "The winning implementation plan is deliberately withheld. Derive your judgment independently from the task, checklist, diff, repository behavior, and tests."
    : "The plan artifact is guidance for where to look, not an independent acceptance criterion. Do not fail or partial solely because the implementation differs from the plan's suggested code path when the task/checklist requirements are satisfied by concrete evidence."}
Codegraph/project indexes are optional accelerators. If unavailable, record the reason and continue with git diff, focused file inspection, and real tests.

## Current Evidence Snapshot
${JSON.stringify(promptVerificationEvidence, null, 2)}

## MANDATORY checks
1. Inspect the exact current diff and candidate identity before judging behavior.
2. Run repository-appropriate focused tests and static checks when deterministic evidence is absent, stale, or insufficient.
3. Verify request-level acceptance behavior and relevant regression paths, not only syntax or file presence.
4. Audit the real actors and entrypoints from the task and diff. An agent-authored narrow reproduction alone is not enough for PASS on behavior-changing work.
5. Enumerate every explicit numbered or bulleted task obligation and map it to the diff plus independent evidence. PASS is invalid if an obligation was silently deferred, collapsed into another item, or called out of scope without a task condition and repository evidence.
6. For versioned, future/current, migration, release, or deprecation work, independently establish the checkout's applicable phase from repository-native version metadata, whatsnew/changelog files, release configuration, or branch-owned tests. A commit date or executor chronology claim is not evidence. Test the behavior required for the applicable phase, including default, wrapper/bypass, masked/subclass, and unexpected-warning paths where relevant.
7. If the change widens a diagnostic from one value to multiple values, verify that it preserves native collection boundaries, element escaping, and the actual comparison slice while keeping established single-value messages compatible. A delimiter-joined string is insufficient when it can confuse element boundaries or include unrelated trailing values.
8. Expand the actual formatting template with representative values. Reject scalar quote delimiters left around a native list/map/tuple representation (for example a scalar template of '{}' receiving a value whose native representation is [...]) unless the frozen observable contract explicitly requires that literal output.
9. Return FAIL or PARTIAL only for a concrete unsatisfied requirement, missing evidence, failed check, candidate drift, or unsafe worktree state. Never infer PASS from the executor summary.`;
}

function resolveAgent(ctx: VerifyContext, fallback: string) {
  const role = ctx.role || "verifier";
  const raw = ctx.agents?.[role] || ctx.agents?.verifier || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) {
    const config = recordValue(raw);
    return { agent: String(config.agent || fallback), variant: config.variant || null };
  }
  return { agent: String(raw), variant: null };
}
