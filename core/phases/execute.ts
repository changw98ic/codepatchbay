import type { LooseRecord } from "../../shared/types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile as execFileCb } from "node:child_process";
import { constants, fstatSync, lstatSync, renameSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { mkdir, open, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseExecutorJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { writePromptArtifact, withPromptArtifactDiagnostics } from "../artifacts/prompt-artifact.js";
import { validateDeliverable } from "../artifacts/validators.js";
import { phaseExecutionContract } from "./prompt-contract.js";
import { normalizeRepoRelativePaths } from "../workflow/acceptance-checklist.js";
import { buildPhaseAcpEnv } from "./phase-env.js";
import { captureCandidateArtifact } from "../engine/candidate-artifact.js";
import { createCandidateReplayBundle } from "../engine/candidate-replay.js";
import { resolveHighAssurancePolicy } from "../policy/high-assurance.js";
import { createTemporaryWorkspace } from "../runtime/temporary-workspace.js";
import { fsyncDirectory } from "../../shared/hub-maintenance.js";

const execFile = promisify(execFileCb);
const PROMPT_PLAN_CHARS = 12_000;

export type ExecuteCleanupTestHooks = {
  beforeQuarantineRename?: (context: {
    sourcePath: string;
    quarantinePath: string;
    relativePath: string;
  }) => void | Promise<void>;
};

const executeCleanupTestHookStorage = new AsyncLocalStorage<ExecuteCleanupTestHooks>();

export function withExecuteCleanupTestHooksForTests<T>(
  hooks: ExecuteCleanupTestHooks,
  operation: () => T,
): T {
  const inherited = executeCleanupTestHookStorage.getStore();
  return executeCleanupTestHookStorage.run(inherited ? { ...inherited, ...hooks } : hooks, operation);
}

function executeCleanupTestHooks() {
  return executeCleanupTestHookStorage.getStore() || {};
}

function executeGitInspectionEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SHELL",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

type ExecuteCleanupGeneration = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
};

function executeCleanupGeneration(info: BigIntStats): ExecuteCleanupGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    birthtimeNs: info.birthtimeNs,
  };
}

function sameExecuteCleanupGeneration(left: ExecuteCleanupGeneration, right: BigIntStats) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function sameExecuteCleanupGenerationAcrossRename(left: ExecuteCleanupGeneration, right: BigIntStats) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function executeCleanupSourcePath(cwd: string, relativePath: string) {
  if (!relativePath || relativePath.includes("\0") || path.posix.isAbsolute(relativePath)) {
    throw Object.assign(new Error(`unsafe untracked cleanup path: ${relativePath}`), {
      code: "EXECUTE_UNTRACKED_PATH_UNSAFE",
      committed: false,
    });
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw Object.assign(new Error(`unsafe untracked cleanup path: ${relativePath}`), {
      code: "EXECUTE_UNTRACKED_PATH_UNSAFE",
      committed: false,
    });
  }
  const root = path.resolve(cwd);
  const sourcePath = path.resolve(root, ...parts);
  const relative = path.relative(root, sourcePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`untracked cleanup path escapes the candidate root: ${relativePath}`), {
      code: "EXECUTE_UNTRACKED_PATH_UNSAFE",
      committed: false,
    });
  }
  return sourcePath;
}

async function quarantineOwnedUntrackedFiles({
  cwd,
  files,
  signal,
}: {
  cwd: string;
  files: string[];
  signal?: AbortSignal;
}) {
  const workspace = await createTemporaryWorkspace({ prefix: "cpb-execute-residue-" });
  const entries: Array<{ file: string; quarantineName: string }> = [];
  let primaryError: unknown = null;

  try {
    if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
      throw Object.assign(new Error("O_NOFOLLOW is unavailable for untracked cleanup"), {
        code: "EXECUTE_UNTRACKED_CLEANUP_UNSAFE",
        committed: false,
      });
    }
    for (const [index, file] of files.entries()) {
      throwIfPhaseAborted(signal);
      const sourcePath = executeCleanupSourcePath(cwd, file);
      const quarantineName = `${String(index).padStart(6, "0")}.residue`;
      const quarantinePath = path.join(workspace.rootPath, quarantineName);
      let authority: Awaited<ReturnType<typeof open>> | null = null;
      let operationError: unknown = null;
      try {
        authority = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const descriptor = await authority.stat({ bigint: true });
        if (!descriptor.isFile()) {
          throw Object.assign(new Error(`untracked cleanup requires an owned regular file: ${file}`), {
            code: "EXECUTE_UNTRACKED_CLEANUP_UNSAFE",
            committed: false,
            recoveryPaths: { canonical: sourcePath },
          });
        }
        const expected = executeCleanupGeneration(descriptor);
        await executeCleanupTestHooks().beforeQuarantineRename?.({
          sourcePath,
          quarantinePath,
          relativePath: file,
        });

        const pinned = fstatSync(authority.fd, { bigint: true });
        const current = lstatSync(sourcePath, { bigint: true });
        if (
          !pinned.isFile()
          || !current.isFile()
          || current.isSymbolicLink()
          || !sameExecuteCleanupGeneration(expected, pinned)
          || !sameExecuteCleanupGeneration(expected, current)
        ) {
          throw Object.assign(new Error(`untracked cleanup ownership changed before isolation: ${file}`), {
            code: "EXECUTE_UNTRACKED_CLEANUP_RACE",
            committed: false,
            successorPreserved: true,
            recoveryPaths: { canonical: sourcePath },
          });
        }
        try {
          lstatSync(quarantinePath);
          throw Object.assign(new Error(`untracked cleanup quarantine already exists: ${quarantinePath}`), {
            code: "EXECUTE_UNTRACKED_QUARANTINE_CONFLICT",
            committed: false,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }

        renameSync(sourcePath, quarantinePath);
        const movedDescriptor = fstatSync(authority.fd, { bigint: true });
        const movedPath = lstatSync(quarantinePath, { bigint: true });
        if (
          !movedDescriptor.isFile()
          || !movedPath.isFile()
          || movedPath.isSymbolicLink()
          || !sameExecuteCleanupGenerationAcrossRename(expected, movedDescriptor)
          || !sameExecuteCleanupGenerationAcrossRename(expected, movedPath)
        ) {
          throw Object.assign(new Error(`untracked cleanup generation changed during isolation: ${file}`), {
            code: "EXECUTE_UNTRACKED_CLEANUP_RACE",
            committed: true,
            quarantinePreserved: true,
            recoveryPaths: { canonical: sourcePath, quarantine: quarantinePath },
          });
        }
        try {
          lstatSync(sourcePath);
          throw Object.assign(new Error(`untracked cleanup source remained reachable: ${file}`), {
            code: "EXECUTE_UNTRACKED_CLEANUP_RACE",
            committed: true,
            quarantinePreserved: true,
            recoveryPaths: { canonical: sourcePath, quarantine: quarantinePath },
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
        await fsyncDirectory(path.dirname(sourcePath));
        await fsyncDirectory(workspace.rootPath);
        entries.push({ file, quarantineName });
      } catch (error) {
        operationError = error;
      }

      let closeError: unknown = null;
      if (authority) {
        try {
          await authority.close();
        } catch (error) {
          closeError = error;
        }
      }
      if (operationError) {
        if (!closeError) throw operationError;
        throw Object.assign(new AggregateError(
          [operationError, closeError],
          `untracked cleanup operation and authority close failed: ${file}`,
          { cause: operationError },
        ), {
          code: String((operationError as NodeJS.ErrnoException | undefined)?.code || "EXECUTE_UNTRACKED_CLEANUP_FAILED"),
          primaryError: operationError,
          closeError,
        });
      }
      if (closeError) throw closeError;
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupDisposition: unknown = null;
  let cleanupError: unknown = null;
  try {
    cleanupDisposition = await workspace.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError) {
    const primaryRecord = primaryError && typeof primaryError === "object"
      ? primaryError as Record<string, unknown>
      : {};
    const dispositionRecord = cleanupDisposition && typeof cleanupDisposition === "object"
      ? cleanupDisposition as Record<string, unknown>
      : {};
    const metadata = {
      code: String(primaryRecord.code || "EXECUTE_UNTRACKED_CLEANUP_FAILED"),
      committed: primaryRecord.committed ?? entries.length > 0,
      successorPreserved: primaryRecord.successorPreserved ?? false,
      quarantinePreserved: dispositionRecord.quarantinePreserved ?? entries.length > 0,
      recoveryPaths: primaryRecord.recoveryPaths || dispositionRecord.recoveryPaths || null,
      primaryError,
      cleanupDisposition,
      cleanupError,
    };
    if (!cleanupError) {
      throw Object.assign(new Error("untracked cleanup failed; owned residue disposition was preserved", {
        cause: primaryError,
      }), metadata);
    }
    throw Object.assign(new AggregateError(
      [primaryError, cleanupError],
      "untracked cleanup and temporary workspace disposition both failed",
      { cause: primaryError },
    ), metadata);
  }
  if (cleanupError) throw cleanupError;
  return { entries, cleanupDisposition };
}

const JSON_INSTRUCTION = `

You MUST respond with ONLY a JSON envelope inside a code block. No text before or after.

Example response:
\`\`\`json
{
  "status": "ok",
  "summary": "Added GET /users endpoint with pagination support and input validation",
  "tests": ["src/routes/api.test.js: returns paginated users", "src/models/user.test.js: findAll respects limit param"],
  "risks": ["No rate limiting on the new endpoint", "Default page size may be too large for big datasets"]
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- The top-level "status" field MUST be exactly "ok"; do not use "resolved", "success", or other aliases.
- Keep the JSON compact. Do not embed full diffs, long command output, or large artifacts; summarize them instead.
- Do NOT include any text outside the code block
- Do NOT write any artifact files yourself except the mandatory structured execution file named above. The system will persist the deliverable.`;

const CHAT_JSON_INSTRUCTION = `

Return one compact raw JSON object and nothing else:
{"status":"ok","summary":"what changed and the real path covered","tests":["validation run"],"risks":[],"checklistMapping":[]}
Use status exactly "ok". Keep test evidence and risks concise. Do not write CPB metadata or artifact files; CPB captures this response directly.`;

export function executorOutputTransportForAgent(
  agent: string,
  env: Record<string, unknown> = {},
): "chat" | "file" {
  const configured = typeof env.CPB_EXECUTOR_OUTPUT_TRANSPORT === "string"
    ? env.CPB_EXECUTOR_OUTPUT_TRANSPORT.trim().toLowerCase()
    : "";
  if (configured === "file") return "file";
  if (configured === "chat") return "chat";
  return agent === "codex" ? "chat" : "file";
}

export function executorWriteAllowPaths({
  cwd,
  outputFilePath,
  configured,
}: {
  cwd: string;
  outputFilePath?: string | null;
  configured?: unknown;
}) {
  const entries = typeof configured === "string"
    ? configured.split(",").map((entry) => entry.trim()).filter(Boolean)
    : [];
  entries.push(`${cwd}${path.sep}*`);
  if (outputFilePath) entries.push(`${path.dirname(outputFilePath)}${path.sep}*`);
  return [...new Set(entries)].join(",");
}

function safePathPart(value: unknown, fallback = "unknown") {
  const raw = stringValue(value, fallback);
  return raw.replace(/[^A-Za-z0-9._-]/g, "-") || fallback;
}

function executorJsonOutputFilePath({ cpbRoot, dataRoot, project, jobId, retry }: {
  cpbRoot: string;
  dataRoot?: string;
  project: string;
  jobId: string;
  retry?: LooseRecord;
}) {
  const root = dataRoot || path.join(cpbRoot, "runtime", "projects", safePathPart(project));
  const retryAttempt = Number(retry?.attempt);
  const retrySuffix = Number.isInteger(retryAttempt) && retryAttempt > 0
    ? `-retry-${retryAttempt}-${safePathPart(retry?.failureKind, "feedback")}`
    : "";
  return path.join(root, "phase-io", "execute", `${safePathPart(jobId)}-execution${retrySuffix}.json`);
}

function executorJsonOutputFileInstruction(filePath: string) {
  return `

## STRUCTURED EXECUTION FILE (MANDATORY)
Before your final response, write the final CPB JSON envelope to this exact file:
EXECUTOR_JSON_OUTPUT_FILE=${filePath}

The file content MUST be raw JSON only: no markdown code fences, no prose, no command output.
The top-level "status" field MUST be exactly "ok"; do not use "resolved", "success", or other aliases.
Keep this file compact. Do not embed full diffs, long command output, or large artifacts; summarize them instead.
The JSON object in the file MUST use the same envelope required below, including summary, tests, risks, and checklistMapping when applicable.
Your final chat response should also contain the JSON envelope, but CPB will read this file first to avoid ACP transport truncation or formatting noise.`;
}

async function readExecutorJsonOutputFile(filePath: string) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function phaseAbortError(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new Error("execute phase aborted");
  err.name = "AbortError";
  return err;
}

function throwIfPhaseAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw phaseAbortError(signal);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function recordArray(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.map(recordValue) : [];
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

async function planArtifactPromptSection(ctx: LooseRecord, planArtifact: LooseRecord | null) {
  if (!planArtifact) return "\nPlan reference: unavailable\n";
  const artifact = recordValue(planArtifact);
  const name = stringValue(artifact.name, "unnamed-plan");
  const artifactPath = stringValue(artifact.path);
  let content = stringValue(artifact.excerpt) || stringValue(artifact.content);
  let readError = "";
  if (!content && artifactPath) {
    try {
      content = await readFile(artifactPath, "utf8");
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }
  }

  const excerpt = limitText(content, PROMPT_PLAN_CHARS);
  const truncated = content.length > PROMPT_PLAN_CHARS;
  const contentSection = excerpt.trim()
    ? `Plan content${truncated ? " (truncated)" : ""}:\n${excerpt}`
    : `Plan content unavailable${readError ? `: ${readError}` : "."}`;

  return `

## Execute-Only Plan Excerpt
Plan reference: ${name}
${artifactPath ? `Plan path: ${artifactPath}\n` : ""}${contentSection}`;
}

function executionTraceContract() {
  return `

## Real-path execution trace contract
- Implement against the original task path, not only the smallest reproduction you can invent.
- In your JSON "summary", include the real entrypoint/caller path your patch covers and any bypass candidates you checked or intentionally ruled out.
- In your JSON "tests", distinguish agent-written regression tests from independent, canonical, or real-path validation evidence.
- Do not claim completion from an agent-authored regression test alone; it is supporting evidence, not proof that the real failing path is fixed.
- Treat tests and exact assertions already present at frozen HEAD as compatibility contracts. Add focused coverage when useful, but do not delete or rewrite existing expectations merely to make the implementation pass.
- Change an existing expectation only when the original task explicitly supersedes that exact scenario. State the old scenario and why it is intentionally incompatible; otherwise preserve it and narrow the production change.
- For misleading diagnostics, first decide whether the wrong guard fired or the existing formatter discarded context it already had. If the guard is correct and rendering is lossy, widen the existing expected/observed formatter instead of adding a semantic branch or new wording taxonomy.
- When a diagnostic expands from one value to multiple values, preserve unambiguous collection structure and element escaping with the repository's native representation, render the same semantically compared slice on both sides, and keep established single-item wording byte-for-byte. Do not flatten collections with an ad hoc delimiter when element contents or trailing unrelated values could make the message ambiguous.`;
}

function pathMatchesChecklistScope(filePath: string, scopePath: string) {
  const file = filePath.split("\\").join("/");
  const scope = scopePath.split("\\").join("/");
  if (!file || !scope) return false;
  if (scope.startsWith("**/")) {
    const suffix = scope.slice(3);
    return file.startsWith(suffix) || file.includes(`/${suffix}`);
  }
  if (scope.endsWith("/")) return file.startsWith(scope);
  return file === scope || file.startsWith(`${scope}/`);
}

function isCompanionTestFile(filePath: string) {
  const normalized = filePath.split("\\").join("/");
  return /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)/i.test(normalized)
    || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(normalized);
}

function acceptanceChecklistItems(ctx: LooseRecord): LooseRecord[] {
  const sourceContext = recordValue(ctx.sourceContext);
  const checklist = recordValue(sourceContext.acceptanceChecklist || ctx.acceptanceChecklist);
  return recordArray(checklist.items);
}

function observableContractPromptSection(ctx: LooseRecord) {
  const contracts = acceptanceChecklistItems(ctx)
    .map((item) => ({
      checklistId: stringValue(item.id),
      requirement: stringValue(item.requirement),
      observableContract: recordValue(item.observableContract),
    }))
    .filter((entry) => Object.keys(entry.observableContract).length > 0);
  if (contracts.length === 0) return "";
  return `

## Frozen Pre-Execution Observable Contracts (MANDATORY)
These contracts were derived and hashed before this candidate existed. Implement and test against them exactly; neither your implementation nor an agent-authored test may redefine the expected observation.
${JSON.stringify(contracts, null, 2)}

- For exact_text and contains_text, exercise the stated probe input and compare the actual observation with expectedObservation while also rejecting every forbiddenObservations entry.
- Do not copy the candidate's output into a new assertion and call it expected. Agent-authored tests are supporting evidence only.
- Preserve quote, escaping, separator, collection-boundary, slice, and pluralization semantics. In particular, do not leave scalar quote delimiters around a native collection representation such as [...], {...}, or (...), unless the frozen contract explicitly includes them.
- If a frozen contract conflicts with repository evidence, stop with a concrete risk instead of silently changing the oracle.`;
}

function mergeChecklistScopeMappings({
  ctx,
  normalizedChangedFiles,
  checklistMapping,
}: {
  ctx: LooseRecord;
  normalizedChangedFiles: string[];
  checklistMapping: LooseRecord[];
}) {
  const items = acceptanceChecklistItems(ctx);
  const itemsById = new Map<string, LooseRecord>();
  for (const item of items) {
    const itemId = stringValue(item.id);
    if (itemId) itemsById.set(itemId, item);
  }
  const changedFileSet = new Set(normalizedChangedFiles);
  const mappings: LooseRecord[] = [];
  const rejectedExecutorMappings: LooseRecord[] = [];

  // Executor output is a claim, not scope authority. Only retain the subset
  // already authorized by the frozen checklist. Files discovered during
  // implementation must go through the independent scope-amendment review.
  for (const entry of checklistMapping) {
    const checklistId = stringValue(entry.checklistId);
    const item = itemsById.get(checklistId);
    const allowedFiles = stringArray(item?.allowedFiles);
    let claimedFiles: string[] = [];
    let unsafeClaimedPath = false;
    try {
      claimedFiles = normalizeRepoRelativePaths(stringArray(entry.changedFiles))
        .filter((file) => changedFileSet.has(file));
    } catch {
      unsafeClaimedPath = true;
    }
    const acceptedFiles = item && allowedFiles.length > 0
      ? claimedFiles.filter((file) => allowedFiles.some((allowedFile) => pathMatchesChecklistScope(file, allowedFile)))
      : [];
    const rejectedFiles = claimedFiles.filter((file) => !acceptedFiles.includes(file));
    if (acceptedFiles.length > 0) {
      mappings.push({
        ...entry,
        checklistId,
        changedFiles: acceptedFiles,
        source: "executor_claim_with_frozen_scope",
      });
    }
    if (!item || rejectedFiles.length > 0 || unsafeClaimedPath) {
      rejectedExecutorMappings.push({
        checklistId: checklistId || null,
        changedFiles: unsafeClaimedPath ? stringArray(entry.changedFiles) : rejectedFiles,
        reason: unsafeClaimedPath
          ? "executor supplied an unsafe repository path"
          : !item
          ? "unknown checklist id"
          : "executor cannot expand frozen checklist allowedFiles",
      });
    }
  }
  const mappedFiles = new Set(mappings.flatMap((entry) => stringArray(entry.changedFiles)));
  const autoByChecklist = new Map<string, Set<string>>();

  for (const file of normalizedChangedFiles) {
    if (mappedFiles.has(file)) continue;
    for (const item of items) {
      const checklistId = stringValue(item.id);
      const allowedFiles = stringArray(item.allowedFiles);
      if (!checklistId || allowedFiles.length === 0) continue;
      if (!allowedFiles.some((allowedFile) => pathMatchesChecklistScope(file, allowedFile))) continue;
      if (!autoByChecklist.has(checklistId)) autoByChecklist.set(checklistId, new Set());
      autoByChecklist.get(checklistId)?.add(file);
      mappedFiles.add(file);
      break;
    }
  }

  for (const [checklistId, files] of autoByChecklist.entries()) {
    mappings.push({
      checklistId,
      changedFiles: [...files].sort(),
      executorClaim: "auto-mapped by frozen checklist allowedFiles",
      notes: "Executor did not provide checklistMapping for this changed file.",
      source: "checklist.allowedFiles",
    });
  }

  const changedNonTestFiles = normalizedChangedFiles.filter((file) => !isCompanionTestFile(file));
  const allNonTestFilesMapped = changedNonTestFiles.length > 0
    && changedNonTestFiles.every((file) => mappedFiles.has(file));
  if (allNonTestFilesMapped) {
    const relevantChecklistIds = [...new Set(
      mappings
        .filter((entry) => stringArray(entry.changedFiles).some((file) => changedNonTestFiles.includes(file)))
        .map((entry) => stringValue(entry.checklistId))
        .filter(Boolean),
    )].sort();
    const companionTestFiles = normalizedChangedFiles.filter(
      (file) => isCompanionTestFile(file) && !mappedFiles.has(file),
    );
    const checklistId = relevantChecklistIds[0];
    if (checklistId && companionTestFiles.length > 0) {
      mappings.push({
        checklistId,
        changedFiles: companionTestFiles,
        executorClaim: "auto-mapped as companion regression tests for scoped production changes",
        notes: "Scope association only; agent-written tests are not independent completion evidence.",
        source: "companion_regression_test",
        derivedFromChecklistIds: relevantChecklistIds,
      });
      for (const file of companionTestFiles) mappedFiles.add(file);
    }
  }

  return {
    mappings,
    mappedFiles: [...mappedFiles].sort(),
    rejectedExecutorMappings,
  };
}

export async function runExecute(ctx: LooseRecord) {
  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const { dataRoot } = ctx;
  const role = stringValue(ctx.role, "executor");
  const planArtifact = getRequiredArtifact(recordArray(ctx.previousResults), "plan");
  const cwd = sourcePath || cpbRoot;
  const retry = recordValue(recordValue(ctx.sourceContext).retry);
  const assurancePolicy = resolveHighAssurancePolicy(ctx);
  const hasFrozenChecklistScope = acceptanceChecklistItems(ctx).length > 0;

  // Capture the immutable candidate base before the agent run. Final changed
  // files are derived from HEAD after execution so untracked directories are
  // expanded to concrete files and pre-existing candidate changes cannot hide.
  const gitInspectionEnv = executeGitInspectionEnv();
  let candidateBaseSha = "";
  try {
    const { stdout: baseSha } = await execFile("git", ["rev-parse", "HEAD"], { cwd, env: gitInspectionEnv });
    candidateBaseSha = baseSha.trim();
  } catch { /* not a git repo — skip */ }

  const resolvedAgent = resolveAgent(ctx, "claude");
  const outputTransport = executorOutputTransportForAgent(resolvedAgent.agent, recordValue(ctx.env));
  const executorOutputFilePath = outputTransport === "file"
    ? executorJsonOutputFilePath({ cpbRoot, dataRoot, project, jobId, retry })
    : null;
  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  if (executorOutputFilePath) await mkdir(path.dirname(executorOutputFilePath), { recursive: true });
  const phaseEnv = { ...buildPhaseAcpEnv(ctx, "execute") };
  phaseEnv.CPB_ACP_WRITE_ALLOW = executorWriteAllowPaths({
    cwd,
    outputFilePath: executorOutputFilePath,
    configured: phaseEnv.CPB_ACP_WRITE_ALLOW,
  });
  const prompt = await buildExecutePrompt(ctx, planArtifact, { agent: resolvedAgent.agent })
    + (executorOutputFilePath ? executorJsonOutputFileInstruction(executorOutputFilePath) : "")
    + (executorOutputFilePath ? JSON_INSTRUCTION : CHAT_JSON_INSTRUCTION);
  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  const promptArtifact = await writePromptArtifact(cpbRoot, {
    project,
    jobId,
    phase: "execute",
    role,
    agent: resolvedAgent.agent,
    prompt,
    dataRoot,
    signal: ctx.signal as AbortSignal | undefined,
  });

  let preExecutionUntrackedFiles: Set<string> | null = null;
  if (assurancePolicy.enabled && hasFrozenChecklistScope && candidateBaseSha) {
    try {
      const baseline = await computeChangedFileState(cwd, gitInspectionEnv);
      preExecutionUntrackedFiles = new Set(normalizeRepoRelativePaths(baseline.untrackedFiles));
    } catch (error) {
      return phaseFailed({
        phase: "execute",
        failure: failure({
          kind: FailureKind.ARTIFACT_INVALID,
          phase: "execute",
          reason: `failed to establish the pre-execution untracked-file ownership baseline: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
          cause: {
            code: String((error as NodeJS.ErrnoException | undefined)?.code || "EXECUTE_UNTRACKED_BASELINE_FAILED"),
          },
        }),
        diagnostics: withPromptArtifactDiagnostics({}, promptArtifact),
      });
    }
  }

  const agentResult: LooseRecord = await runAgent({
    phase: "execute",
    role,
    ...resolvedAgent,
    project,
    jobId,
    prompt,
    cwd,
    pool,
    timeoutMs: typeof recordValue(ctx.timeouts).execute === "number" ? recordValue(ctx.timeouts).execute : 0,
    scope: ctx.scope,
    env: phaseEnv,
    dataRoot,
    onProgress: ctx.onProgress,
    attemptId: ctx.attemptId,
    conversationKey: ctx.conversationKey,
    signal: ctx.signal as AbortSignal | undefined,
  });

  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  if (!agentResult.ok) {
    const failureKind = typeof agentResult.kind === "string" ? agentResult.kind : FailureKind.UNKNOWN;
    return phaseFailed({
      phase: "execute",
      failure: failure({
        kind: failureKind,
        phase: "execute",
        reason: agentResult.reason,
        retryable: agentResult.retryable === true,
        exitCode: typeof agentResult.exitCode === "number" ? agentResult.exitCode : null,
        signal: stringValue(agentResult.signal) || null,
        cause: recordValue(agentResult.cause),
      }),
      diagnostics: withPromptArtifactDiagnostics(recordValue(agentResult.diagnostics), promptArtifact),
    });
  }

  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  const executorFileOutput = executorOutputFilePath
    ? await readExecutorJsonOutputFile(executorOutputFilePath)
    : null;
  const executorOutputSource = executorFileOutput ? "file" : "agent-output";
  const executorOutput = executorFileOutput || agentResult.output;
  const executorOutputDiagnostics = {
    ...recordValue(agentResult.diagnostics),
    executorOutputFile: {
      path: executorOutputFilePath,
      used: executorOutputSource === "file",
      source: executorOutputSource,
      transport: outputTransport,
    },
  };

  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  const parsed = recordValue(parseExecutorJson(stringValue(executorOutput)));
  if (!parsed.ok) {
    return phaseFailed({
      phase: "execute",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "execute",
        reason: parsed.reason,
        retryable: false,
        stderrSnippet: stringValue(executorOutput).slice(-500),
        cause: {
          rawOutput: stringValue(executorOutput).slice(0, 2000),
          source: executorOutputSource,
          executorOutputFile: executorOutputFilePath,
        },
      }),
      diagnostics: withPromptArtifactDiagnostics(executorOutputDiagnostics, promptArtifact),
    });
  }

  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  let changedFileState;
  if (!candidateBaseSha) {
    // Preserve the long-standing non-Git execution contract. Without a frozen
    // Git base there is no deletion authority, so the phase reports no file
    // cleanup candidates and never mutates an observed pathname.
    changedFileState = { changedFiles: [], trackedFiles: [], untrackedFiles: [] };
  } else {
    try {
      changedFileState = await computeChangedFileState(cwd, gitInspectionEnv);
    } catch (error) {
      return phaseFailed({
        phase: "execute",
        failure: failure({
          kind: FailureKind.ARTIFACT_INVALID,
          phase: "execute",
          reason: `failed to inspect the candidate tree before freezing it: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
          cause: {
            code: String((error as NodeJS.ErrnoException | undefined)?.code || "EXECUTE_CHANGED_FILE_INSPECTION_FAILED"),
          },
        }),
        diagnostics: withPromptArtifactDiagnostics(executorOutputDiagnostics, promptArtifact),
      });
    }
  }
  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  let normalizedChangedFiles = normalizeRepoRelativePaths(changedFileState.changedFiles);
  const checklistMapping = recordArray(parsed.checklistMapping);
  let { mappings, mappedFiles, rejectedExecutorMappings } = mergeChecklistScopeMappings({
    ctx,
    normalizedChangedFiles,
    checklistMapping,
  });
  const initialUnmappedChangedFiles = normalizedChangedFiles.filter(
    (file: string) => !mappedFiles.includes(file),
  );
  const discardedUntrackedFiles = assurancePolicy.enabled && hasFrozenChecklistScope
    ? changedFileState.untrackedFiles.filter((file) => initialUnmappedChangedFiles.includes(file))
    : [];
  const unownedUntrackedFiles = discardedUntrackedFiles.filter(
    (file) => preExecutionUntrackedFiles === null || preExecutionUntrackedFiles.has(file),
  );
  if (unownedUntrackedFiles.length > 0) {
    return phaseFailed({
      phase: "execute",
      failure: failure({
        kind: FailureKind.ARTIFACT_INVALID,
        phase: "execute",
        reason: `refusing to delete untracked paths without exact current-execution ownership: ${unownedUntrackedFiles.join(", ")}`,
        retryable: false,
        cause: {
          code: "EXECUTE_UNTRACKED_OWNERSHIP_UNAVAILABLE",
          preservedPaths: unownedUntrackedFiles,
        },
      }),
      diagnostics: withPromptArtifactDiagnostics(executorOutputDiagnostics, promptArtifact),
    });
  }
  let discardedUntrackedDisposition: unknown = null;
  if (discardedUntrackedFiles.length > 0) {
    try {
      discardedUntrackedDisposition = await quarantineOwnedUntrackedFiles({
        cwd,
        files: discardedUntrackedFiles,
        signal: ctx.signal as AbortSignal | undefined,
      });
    } catch (error) {
      const errorRecord = error && typeof error === "object" ? error as Record<string, unknown> : {};
      return phaseFailed({
        phase: "execute",
        failure: failure({
          kind: FailureKind.ARTIFACT_INVALID,
          phase: "execute",
          reason: `failed to isolate current-execution untracked residue: ${error instanceof Error ? error.message : String(error)}`,
          retryable: false,
          cause: {
            code: String(errorRecord.code || "EXECUTE_UNTRACKED_CLEANUP_FAILED"),
            committed: errorRecord.committed ?? false,
            recoveryPaths: errorRecord.recoveryPaths || null,
            cleanupDisposition: errorRecord.cleanupDisposition || null,
            cleanupError: errorRecord.cleanupError || null,
          },
        }),
        diagnostics: withPromptArtifactDiagnostics(executorOutputDiagnostics, promptArtifact),
      });
    }
    throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
    try {
      changedFileState = await computeChangedFileState(cwd, gitInspectionEnv);
    } catch (error) {
      return phaseFailed({
        phase: "execute",
        failure: failure({
          kind: FailureKind.ARTIFACT_INVALID,
          phase: "execute",
          reason: `untracked residue was isolated but candidate reinspection failed: ${error instanceof Error ? error.message : String(error)}`,
          retryable: false,
          cause: {
            code: String((error as NodeJS.ErrnoException | undefined)?.code || "EXECUTE_CHANGED_FILE_REINSPECTION_FAILED"),
            discardedUntrackedDisposition,
          },
        }),
        diagnostics: withPromptArtifactDiagnostics(executorOutputDiagnostics, promptArtifact),
      });
    }
    throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
    normalizedChangedFiles = normalizeRepoRelativePaths(changedFileState.changedFiles);
    ({ mappings, mappedFiles, rejectedExecutorMappings } = mergeChecklistScopeMappings({
      ctx,
      normalizedChangedFiles,
      checklistMapping,
    }));
  }

  // Build execution map connecting the frozen candidate files to checklist
  // items. High-assurance cleanup is auditable and never removes tracked
  // changes or untracked files that fall inside the frozen scope.
  const executionMap = {
    schemaVersion: 1,
    jobId,
    project,
    mappings,
    rejectedExecutorMappings,
    changedFiles: normalizedChangedFiles,
    unmappedChangedFiles: normalizedChangedFiles.filter(
      (file: string) => !mappedFiles.includes(file),
    ),
    discardedUntrackedFiles,
    discardedUntrackedDisposition,
  };
  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  const executionMapArtifact = await writeArtifact(cpbRoot, {
    signal: ctx.signal as AbortSignal | undefined,
    project,
    jobId,
    kind: "execution-map",
    content: JSON.stringify(executionMap, null, 2),
    dataRoot,
    metadata: executionMap,
  });

  const deliverable = renderDeliverableMarkdown(ctx, planArtifact, parsed, normalizedChangedFiles);

  const validation = recordValue(validateDeliverable(deliverable, { ...ctx, changedFiles: normalizedChangedFiles }));
  if (!validation.ok) {
    return phaseFailed({
      phase: "execute",
      failure: failure({
        kind: (validation.kind || FailureKind.ARTIFACT_INVALID) as string,
        phase: "execute",
        reason: validation.reason ?? "deliverable validation failed",
        retryable: validation.retryable === true,
        cause: { rawOutput: deliverable.slice(0, 2000) },
      }),
      diagnostics: withPromptArtifactDiagnostics({ ...executorOutputDiagnostics, executionMapArtifact }, promptArtifact),
    });
  }

  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  const artifact = await writeArtifact(cpbRoot, {
    signal: ctx.signal as AbortSignal | undefined,
    project,
    jobId,
    kind: "deliverable",
    content: deliverable,
    dataRoot,
    metadata: { agent: agentResult.agent, changedFiles: normalizedChangedFiles, discardedUntrackedFiles },
  });

  let candidateArtifact = null;
  let candidateArtifactRecord = null;
  let candidateReplayBundle = null;
  let candidateReplayBundleRecord = null;
  if (candidateBaseSha) {
    try {
      throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
      candidateArtifact = await captureCandidateArtifact({ cwd, base: candidateBaseSha, env: gitInspectionEnv });
      throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
      candidateArtifactRecord = await writeArtifact(cpbRoot, {
        signal: ctx.signal as AbortSignal | undefined,
        project,
        jobId,
        kind: "candidate-artifact",
        content: JSON.stringify(candidateArtifact, null, 2),
        dataRoot,
        metadata: {
          schemaVersion: candidateArtifact.schemaVersion,
          baseSha: candidateArtifact.baseSha,
          identityHash: candidateArtifact.identityHash,
          patchHash: candidateArtifact.patchHash,
          treeHash: candidateArtifact.treeHash,
          changedFiles: candidateArtifact.changedFiles,
          attemptId: ctx.attemptId || null,
        },
      });
      throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
      candidateReplayBundle = await createCandidateReplayBundle({ cwd, candidate: candidateArtifact, env: gitInspectionEnv });
      throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
      candidateReplayBundleRecord = await writeArtifact(cpbRoot, {
        signal: ctx.signal as AbortSignal | undefined,
        project,
        jobId,
        kind: "candidate-replay-bundle",
        content: JSON.stringify(candidateReplayBundle, null, 2),
        dataRoot,
        metadata: {
          schemaVersion: candidateReplayBundle.schemaVersion,
          baseSha: candidateReplayBundle.baseSha,
          expectedTreeHash: candidateReplayBundle.expectedTreeHash,
          candidateIdentityHash: candidateReplayBundle.candidateIdentityHash,
          patchSha256: candidateReplayBundle.patchSha256,
          patchBytes: candidateReplayBundle.patchBytes,
          bundleHash: candidateReplayBundle.bundleHash,
          attemptId: ctx.attemptId || null,
        },
      });
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError") throw err;
      return phaseFailed({
        phase: "execute",
        failure: failure({
          kind: FailureKind.ARTIFACT_INVALID,
          phase: "execute",
          reason: `failed to freeze candidate artifact: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        }),
        diagnostics: withPromptArtifactDiagnostics({ ...executorOutputDiagnostics, executionMapArtifact, artifact }, promptArtifact),
      });
    }
  }

  return phasePassed({
    phase: "execute",
    artifact,
    diagnostics: withPromptArtifactDiagnostics({
      ...executorOutputDiagnostics,
      executionMapArtifact,
      candidateArtifact,
      candidateArtifactRecord,
      candidateReplayBundle,
      candidateReplayBundleRecord,
    }, promptArtifact),
  });
}

function nulSeparatedPaths(value: string) {
  return value.split("\0").filter(Boolean);
}

async function computeChangedFileState(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
    execFile("git", ["diff", "HEAD", "--name-only", "-z", "--"], { cwd, env }),
    execFile("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd, env }),
  ]);
  const trackedFiles = nulSeparatedPaths(tracked).sort();
  const untrackedFiles = nulSeparatedPaths(untracked).sort();
  return {
    changedFiles: [...new Set([...trackedFiles, ...untrackedFiles])].sort(),
    trackedFiles,
    untrackedFiles,
  };
}

function getRequiredArtifact(previousResults: LooseRecord[], kind: string) {
  for (let i = previousResults.length - 1; i >= 0; i--) {
    const artifact = recordValue(previousResults[i].artifact);
    if (artifact.kind === kind) {
      return artifact;
    }
  }
  return null;
}

function renderDeliverableMarkdown(ctx: LooseRecord, planArtifact: LooseRecord | null, parsed: LooseRecord, changedFiles: string[]) {
  const changedSection = changedFiles.length > 0
    ? changedFiles.map((f) => `- ${f}`).join("\n")
    : "- No file changes detected";
  return `# Deliverable

## Task
${ctx.task}

## Plan
${planArtifact ? `See ${planArtifact.name}` : "No plan artifact"}

## Summary
${parsed.summary}

## Changed Files
${changedSection}

## Tests
${stringArray(parsed.tests).map((t) => `- ${t}`).join("\n") || "- No test descriptions provided"}

## Risks
${stringArray(parsed.risks).map((r) => `- ${r}`).join("\n") || "- None identified"}
`;
}

export async function buildExecutePrompt(
  ctx: LooseRecord,
  planArtifact: LooseRecord | null,
  options: { agent?: string } = {},
) {
  const planSection = await planArtifactPromptSection(ctx, planArtifact);
  const observableSection = observableContractPromptSection(ctx);
  const retrySection = buildRetrySection(recordValue(ctx.sourceContext));
  if (typeof ctx.buildPrompt === "function") {
    return await ctx.buildPrompt("execute", ctx, { planArtifact }) + planSection + executionTraceContract() + observableSection + retrySection;
  }
  return `You are a software execution agent. Implement the following task:

${phaseExecutionContract("execute", { flexibleToolChoice: options.agent === "codex" })}
${executionTraceContract()}

Task: ${ctx.task}
Project: ${ctx.project}
${planSection}
${observableSection}
Execute the implementation. Make code changes as needed.
Before declaring completion, map every explicit numbered/bulleted task obligation to a concrete production change or prove from repository-native evidence why its stated condition does not apply. Do not silently treat a later phase, migration step, or target-version bullet as out of scope.
For versioned, future/current, migration, or deprecation tasks, determine the checkout's applicable phase from repository version metadata, whatsnew/changelog files, release configuration, or branch-owned tests. Do not use commit dates alone. Test the resulting default behavior plus wrappers, masked/subclass inputs, and compatibility bypasses that exercise the same conversion path.${retrySection}`;
}

function buildRetrySection(sourceContext: LooseRecord) {
  const retry = recordValue(sourceContext.retry);
  if (Object.keys(retry).length === 0) return "";
  return `

## Previous Attempt Failed
Your previous execution was rejected. Fix the issue and provide a corrected response.

The latest verifier evidence is the current source of truth for this repair turn. Reproduce and fix its exact counterexample before doing broader investigation. Do not replace a concrete verifier finding with assumptions about an upstream/reference implementation, and do not rewrite frozen-HEAD assertions to make a broader change pass. Prefer the smallest production condition that resolves the reported failure while preserving every stated compatibility case.

Error type: ${retry.failureKind}
Error: ${retry.failureReason}
Failure class: ${retry.failureClass || "unknown"}
Failure fingerprint: ${retry.failureFingerprint || "unavailable"}
Recovery strategy: ${retry.retryStrategy || "unavailable"}
Strategy changed: ${retry.strategyChanged === true ? "yes" : "no"}
${retry.retryClass ? `Repair class: ${retry.retryClass}` : ""}
${Array.isArray(retry.fixScope) && retry.fixScope.length > 0 ? `Fix scope: ${retry.fixScope.join(", ")}` : ""}
${retry.failureEvidence ? `Failure evidence:\n\`\`\`json\n${JSON.stringify(retry.failureEvidence, null, 2)}\n\`\`\`` : ""}
${retry.instruction ? `Repair instruction: ${retry.instruction}` : ""}
${retry.previousOutput ? `\nPrevious output for reference:\n\`\`\`\n${retry.previousOutput}\n\`\`\`` : ""}`;
}

function resolveAgent(ctx: LooseRecord, fallback: string) {
  const role = stringValue(ctx.role, "executor");
  const agents = recordValue(ctx.agents);
  const raw = agents[role] || agents.executor || ctx.agent || fallback;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = recordValue(raw);
    return { agent: stringValue(record.agent, fallback), variant: stringValue(record.variant) || null };
  }
  return { agent: stringValue(raw, fallback), variant: null };
}

export { getRequiredArtifact };
