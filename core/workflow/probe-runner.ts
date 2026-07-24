/**
 * Deterministic probe runner for checklist-first verification.
 *
 * For each acceptance-checklist item, the runner executes a deterministic,
 * replayable probe whose result is expressed as a method-specific
 * observation. These observations feed buildEvidenceProbePlan (via the
 * hardGateChecks upgrade path), producing evidence-ledger entries whose
 * result ("pass"|"fail") is decided by objective data — not by the
 * verifier agent's claim.
 *
 * Division of labor:
 *   - probe runner  -> objective "did the change land in scope" evidence (deterministic)
 *   - verifier agent -> semantic "does the change satisfy the requirement" judgment (LLM)
 *
 * Strictness contract: a probe never fabricates a match. If an item has no
 * machine-checkable scope (e.g. static item with empty allowedFiles), the
 * probe reports matchCount=0 — an honest fail that signals the item needs
 * structural refinement (LLM decomposition), not a rubber-stamped pass.
 *
 * NO SILENT DROPS: every checklist item with an id + predicateId + a known
 * verificationMethod yields a probe record. Methods the runner cannot yet
 * produce objective evidence for (event-based, absence_check, manual) get
 * an honest failed claim (emitFailedClaim: true) with an observation.note
 * explaining why, so the ledger records the item instead of silently
 * dropping it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { LooseRecord } from "../../shared/types.js";
import { captureCandidateArtifact } from "../engine/candidate-artifact.js";
import { applyFrozenGitTreeDelta } from "../runtime/frozen-git-tree.js";
import {
  createTemporaryGitWorktree,
  temporaryWorkspaceErrorDetails,
} from "../runtime/temporary-workspace.js";
import {
  parseTrustedProbePolicy,
  TRUSTED_PROBE_POLICY_PATH,
  type TrustedProbeSpec,
} from "./trusted-probe-policy.js";

const execFileAsync = promisify(execFile);


/** Command probe wall-clock timeout. Treats timeout as an honest fail. */
const COMMAND_PROBE_TIMEOUT_MS = 30_000;
const COMMAND_PROBE_MAX_RETRIES = 1;
const COMMAND_PROBE_TAIL_CHARS = 2000;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Narrow an unknown caught value to an object whose properties may be safely
 * read. Used only for defensive reads on the shape Node attaches to a failed
 * execFileAsync (an external/dynamic runtime object), never to fabricate types.
 */
function isRecordLike(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Collect changed files in the working tree relative to base.
 * Returns repo-relative posix paths. Stable regardless of commit order.
 */
async function changedFiles(cwd: string, base: string | null, env: NodeJS.ProcessEnv): Promise<string[]> {
  const rev = base || "HEAD";
  try {
    const diff = await execFileAsync("git", ["diff", "--name-only", rev], { cwd, env, maxBuffer: 8 * 1024 * 1024 });
    const untracked = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, env, maxBuffer: 8 * 1024 * 1024 });
    return uniqueStrings([
      ...diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
      ...untracked.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    ]);
  } catch {
    // No usable base ref (e.g. empty repo). No diff means no objective
    // scope evidence — probes will honestly report matchCount=0.
    return [];
  }
}

function posixify(p: string): string {
  return p.split("\\").join("/");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

/**
 * Count diff hunks within a set of files. Each file with at least one
 * changed hunk contributes 1 to matchCount — a coarse but objective
 * "the declared file was actually modified" signal.
 */
function scopeMatches(changed: string[], allowedFiles: string[]): number {
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) return 0;
  let count = 0;
  for (const f of allowedFiles) {
    if (changed.some((changedFile) => scopePathMatches(changedFile, text(f)))) count += 1;
  }
  return count;
}

function scopePathMatches(changedFile: string, allowedFile: string): boolean {
  const changed = posixify(changedFile);
  const allowed = posixify(allowedFile);
  if (!allowed) return false;
  if (allowed.startsWith("**/")) {
    const suffix = allowed.slice(3);
    return changed.startsWith(suffix) || changed.includes(`/${suffix}`);
  }
  if (allowed.endsWith("/")) return changed.startsWith(allowed);
  return changed === allowed || changed.startsWith(`${allowed}/`);
}

const ORACLE_PROTECTED_ORIGINS = new Set([
  "benchmark_required",
  "user_required",
  "external_oracle",
  "user_acceptance",
  "user_provided",
  "ci_required",
  "ci_owned",
  "ci",
]);

const ORACLE_PATH_FIELDS = [
  "oracleFiles",
  "protectedFiles",
  "acceptanceFiles",
  "externalOracleFiles",
  "userAcceptanceFiles",
  "ciFiles",
  "commandFiles",
];

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

async function loadTrustedProbePolicy(cwd: string, env: NodeJS.ProcessEnv): Promise<Map<string, TrustedProbeSpec>> {
  try {
    // HEAD is the trust boundary: an agent may edit the worktree, but cannot
    // make a newly generated command executable merely by editing this file.
    const result = await execFileAsync("git", ["show", `HEAD:${TRUSTED_PROBE_POLICY_PATH}`], {
      cwd,
      env,
      maxBuffer: 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(result.stdout);
    return parseTrustedProbePolicy(parsed);
  } catch {
    return new Map();
  }
}

function renderProbeCommand(spec: TrustedProbeSpec) {
  return [spec.executable, ...spec.args].map((part) => JSON.stringify(part)).join(" ");
}

function isRepoRelativePosixPath(value: unknown) {
  const file = text(value);
  return Boolean(file) && !file.startsWith("/") && !file.includes("\\") && !file.split("/").includes("..");
}

function cleanPathToken(value: unknown) {
  let candidate = text(value)
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^[([{]+|[)\]},;]+$/g, "");
  if (!candidate) return "";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate)) return "";
  if (/^[A-Za-z_][\w.-]*:\d+$/.test(candidate) && !candidate.includes("/")) return "";
  if (candidate.includes("=")) candidate = candidate.slice(candidate.lastIndexOf("=") + 1);
  candidate = candidate.replace(/^\.\/+/, "");
  candidate = candidate.replace(/:\d+(?::\d+)?$/, "");
  if (!candidate || !isRepoRelativePosixPath(candidate)) return "";
  return candidate;
}

function collectPathField(value: unknown, paths: Set<string>) {
  if (Array.isArray(value)) {
    for (const entry of value) collectPathField(entry, paths);
    return;
  }
  const file = cleanPathToken(value);
  if (file) paths.add(file);
}

function collectPathTokens(value: unknown, paths: Set<string>) {
  const raw = text(value);
  if (!raw) return;
  for (const token of raw.split(/[\s'"`]+/)) {
    const file = cleanPathToken(token);
    if (!file) continue;
    if (file.includes("/") || /\.[A-Za-z0-9]+$/.test(file)) paths.add(file);
  }
}

function collectSourceRefPaths(value: unknown, paths: Set<string>) {
  if (!Array.isArray(value)) return;
  for (const ref of value.filter(isRecordLike)) {
    const kind = text(ref.kind);
    const locator = text(ref.locator);
    if (kind === "task_text" || locator.startsWith("task:")) continue;
    collectPathField(ref.path || ref.file || ref.locator, paths);
  }
}

function oracleProtectedPaths(item: LooseRecord, declaredCommand: string) {
  const paths = new Set<string>();
  for (const field of ORACLE_PATH_FIELDS) collectPathField(item[field], paths);
  collectSourceRefPaths(item.sourceRefs, paths);
  collectPathTokens(item.expectedEvidence, paths);
  collectPathTokens(item.probeCommand, paths);
  collectPathTokens(declaredCommand, paths);
  return [...paths].sort();
}

function requiresCleanOracleProvenance(item: LooseRecord) {
  const origins = [
    ...stringList(item.requiredEvidenceOrigin),
    text(item.evidenceOrigin),
  ].filter(Boolean);
  return origins.some((origin) => ORACLE_PROTECTED_ORIGINS.has(origin));
}

function changedOracleFiles(item: LooseRecord, declaredCommand: string, changed: string[]) {
  if (!requiresCleanOracleProvenance(item)) return [];
  const protectedPaths = oracleProtectedPaths(item, declaredCommand);
  if (protectedPaths.length === 0 || changed.length === 0) return [];
  return changed
    .filter((file) => protectedPaths.some((scope) => scopePathMatches(file, scope)))
    .sort();
}

async function gitPathExistsAtHead(cwd: string, file: string, env: NodeJS.ProcessEnv) {
  try {
    await execFileAsync("git", ["cat-file", "-e", `HEAD:${file}`], { cwd, env });
    return true;
  } catch {
    return false;
  }
}

async function validateHeadOracleFiles(cwd: string, files: string[], env: NodeJS.ProcessEnv) {
  for (const file of files) {
    if (!isRepoRelativePosixPath(file)) return { ok: false, reason: `unsafe oracle path: ${file}` };
    if (!await gitPathExistsAtHead(cwd, file, env)) return { ok: false, reason: `oracle path is not present at HEAD: ${file}` };
  }
  return { ok: true, reason: "" };
}

function pathMatchesAnyScope(file: string, scopes: string[]) {
  return scopes.some((scope) => scopePathMatches(file, scope));
}

async function frozenOverlayFileRecords(
  sourceCwd: string,
  candidateTree: string,
  files: string[],
  env: NodeJS.ProcessEnv,
) {
  if (files.length === 0) return [];
  const { stdout } = await execFileAsync("git", [
    "--literal-pathspecs",
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    candidateTree,
    "--",
    ...files,
  ], { cwd: sourceCwd, env, maxBuffer: 8 * 1024 * 1024 });
  const present = new Set(stdout.split("\0").filter(Boolean));
  return files.map((file) => ({
    ok: true,
    file,
    action: present.has(file) ? "copy" : "delete",
  }));
}

async function runIsolatedCleanOracleReplay(command: TrustedProbeSpec, cwd: string, files: string[], env: NodeJS.ProcessEnv) {
  const validation = await validateHeadOracleFiles(cwd, files, env);
  if (!validation.ok) {
    return {
      cleanOracleReplayPassed: false,
      cleanOracleReplayFiles: files,
      cleanOracleReplayMode: "isolated_worktree",
      cleanOracleReplayReason: validation.reason,
    };
  }

  let workspace;
  try {
    workspace = await createTemporaryGitWorktree({
      sourcePath: cwd,
      revision: "HEAD",
      prefix: "cpb-clean-oracle-replay-",
      env,
    });
  } catch (err) {
    const cleanup = temporaryWorkspaceErrorDetails(err);
    const message = isRecordLike(err) && typeof err.message === "string" ? err.message : String(err || "unknown error");
    return {
      cleanOracleReplayPassed: false,
      cleanOracleReplayFiles: files,
      cleanOracleReplayMode: "isolated_worktree",
      cleanOracleReplayIsolated: true,
      cleanOracleReplayReason: `isolated clean oracle replay setup failed: ${message}`,
      ...(cleanup ? { cleanOracleReplayCleanup: cleanup } : {}),
    };
  }
  const replayPath = workspace.worktreePath;
  let result: LooseRecord;
  try {
    const candidate = await captureCandidateArtifact({ cwd, base: "HEAD", env: workspace.gitEnv });
    const overlayFiles = candidate.changedFiles
      .filter((file) => !pathMatchesAnyScope(file, files))
      .sort();
    await applyFrozenGitTreeDelta({
      sourceRoot: cwd,
      replayRoot: replayPath,
      fromTree: candidate.headSha,
      candidateTree: candidate.treeHash,
      files: overlayFiles,
      env: workspace.gitEnv,
    });
    const overlay = await frozenOverlayFileRecords(cwd, candidate.treeHash, overlayFiles, workspace.gitEnv);
    const replay = await runDeclaredCommand(command, replayPath, env);
    result = {
      cleanOracleReplayPassed: replay.exitCode === 0,
      cleanOracleReplayFiles: files,
      cleanOracleReplayMode: "isolated_worktree",
      cleanOracleReplayIsolated: true,
      cleanOracleReplayOverlayFiles: overlay,
      cleanOracleReplayExitCode: replay.exitCode,
      cleanOracleReplayStdoutSha256: replay.stdoutSha256,
      cleanOracleReplayStderrSha256: replay.stderrSha256,
      cleanOracleReplayStdoutTail: replay.stdoutTail,
      cleanOracleReplayStderrTail: replay.stderrTail,
      cleanOracleReplayRetryCount: replay.retryCount,
      cleanOracleReplayProbeAttempts: replay.probeAttempts,
      ...(replay.note ? { cleanOracleReplayReason: replay.note } : {}),
    };
  } catch (err) {
    const message = isRecordLike(err) && typeof err.message === "string" ? err.message : String(err || "unknown error");
    result = {
      cleanOracleReplayPassed: false,
      cleanOracleReplayFiles: files,
      cleanOracleReplayMode: "isolated_worktree",
      cleanOracleReplayIsolated: true,
      cleanOracleReplayReason: `isolated clean oracle replay failed: ${message}`,
    };
  }
  try {
    return { ...result, cleanOracleReplayCleanup: await workspace.cleanup() };
  } catch (error) {
    const cleanup = temporaryWorkspaceErrorDetails(error);
    if (!cleanup) throw error;
    return {
      ...result,
      cleanOracleReplayPassed: false,
      cleanOracleReplayReason: [
        text(result.cleanOracleReplayReason),
        `isolated replay cleanup failed: ${cleanup.message}`,
      ].filter(Boolean).join("; "),
      cleanOracleReplayCleanup: cleanup,
    };
  }
}

async function runCleanOracleReplay(command: TrustedProbeSpec, cwd: string, files: string[], env: NodeJS.ProcessEnv) {
  return await runIsolatedCleanOracleReplay(command, cwd, files, env);
}

function sha256Hex(input: string): string {
  return "sha256:" + createHash("sha256").update(input, "utf8").digest("hex");
}

function outputTail(input: string): string {
  return input.length > COMMAND_PROBE_TAIL_CHARS ? input.slice(-COMMAND_PROBE_TAIL_CHARS) : input;
}

function commandProbeEnv(cwd: string, parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Never expose Hub/Redis/provider credentials to a verification child.
  // Keep only process-discovery and locale values needed by common toolchains.
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "USER", "LOGNAME", "SYSTEMROOT", "COMSPEC", "PATHEXT"];
  const env: NodeJS.ProcessEnv = { CI: "1", PYTHONPATH: cwd };
  for (const key of allowed) {
    if (parentEnv[key]) env[key] = parentEnv[key];
  }
  return env;
}

// Verification methods the runner knows about. Anything outside this set is
// an honest-fail (recorded, not dropped) so malformed checklist items cannot
// silently pass.
const KNOWN_METHODS = new Set([
  "static",
  "command",
  "test",
  "runtime_event",
  "artifact_event",
  "audit_export",
  "dag_event",
  "worker_lifecycle",
  "manual",
  "absence_check",
]);

// Methods whose objective evidence requires event-log querying / approval
// artifacts the runner does not yet have access to. V1 records them as an
// honest fail; V2 will produce real observations once the runner can query
// the event log / approval artifact index.
const EVENT_BASED_METHODS = new Set([
  "runtime_event",
  "artifact_event",
  "audit_export",
  "dag_event",
  "worker_lifecycle",
  "absence_check",
  "manual",
]);

/**
 * Resolve a command/test probe exclusively from the maintainer-owned policy
 * committed at HEAD. Checklist prose is evidence description, never code.
 */
function resolveDeclaredCommand(item: LooseRecord, policy: Map<string, TrustedProbeSpec>): TrustedProbeSpec | null {
  return policy.get(text(item.predicateId)) || null;
}

/**
 * Run a declared shell command deterministically. Returns the exit code and a
 * sha256 digest of stdout. Timeouts and missing binaries (ENOENT) are treated
 * as honest fails (exitCode recorded as -1 with a note), never thrown.
 */
async function runDeclaredCommand(
  command: TrustedProbeSpec,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutTail: string;
  stderrTail: string;
  note?: string;
  retryCount: number;
  probeAttempts: LooseRecord[];
}> {
  const attempts: LooseRecord[] = [];
  let last: {
    exitCode: number;
    stdoutSha256: string;
    stderrSha256: string;
    stdoutTail: string;
    stderrTail: string;
    note?: string;
    retryable: boolean;
  } | null = null;

  for (let attempt = 1; attempt <= COMMAND_PROBE_MAX_RETRIES + 1; attempt += 1) {
    last = await runDeclaredCommandOnce(command, cwd, env);
    attempts.push({
      attempt,
      exitCode: last.exitCode,
      stdoutSha256: last.stdoutSha256,
      stderrSha256: last.stderrSha256,
      ...(last.stdoutTail ? { stdoutTail: last.stdoutTail } : {}),
      ...(last.stderrTail ? { stderrTail: last.stderrTail } : {}),
      ...(last.note ? { note: last.note } : {}),
    });

    if (last.exitCode === 0 || !last.retryable || attempt > COMMAND_PROBE_MAX_RETRIES) break;
  }

  if (!last) {
    return {
      exitCode: -1,
      stdoutSha256: "",
      stderrSha256: "",
      stdoutTail: "",
      stderrTail: "",
      note: "command probe did not run",
      retryCount: 0,
      probeAttempts: attempts,
    };
  }

  const retryCount = attempts.length - 1;
  const note = last.note || (retryCount > 0 && last.exitCode === 0
    ? `command probe passed after ${retryCount} retry${retryCount === 1 ? "" : "ies"}`
    : undefined);
  return {
    exitCode: last.exitCode,
    stdoutSha256: last.stdoutSha256,
    stderrSha256: last.stderrSha256,
    stdoutTail: last.stdoutTail,
    stderrTail: last.stderrTail,
    ...(note ? { note } : {}),
    retryCount,
    probeAttempts: attempts,
  };
}

async function runDeclaredCommandOnce(
  command: TrustedProbeSpec,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutTail: string;
  stderrTail: string;
  note?: string;
  retryable: boolean;
}> {
  try {
    const result = await execFileAsync(command.executable, command.args, {
      cwd,
      env: commandProbeEnv(cwd, env),
      shell: false,
      timeout: COMMAND_PROBE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdoutSha256: sha256Hex(result.stdout ?? ""),
      stderrSha256: sha256Hex(result.stderr ?? ""),
      stdoutTail: outputTail(result.stdout ?? ""),
      stderrTail: outputTail(result.stderr ?? ""),
      retryable: false,
      // Note: digests are always emitted, even for empty output, so the
      // observation clears validateCommandObservation's record-gate (which
      // requires a non-empty digest) for both pass and fail paths.
    };
  } catch (err: unknown) {
    // Non-zero exit: Node attaches .code === number on a spawned process that
    // exited non-zero. Record the real exit code honestly. Output digests are
    // ALWAYS produced (even for empty output) — an empty stdout is itself an
    // objective, recordable result, and validateCommandObservation requires a
    // non-empty digest for the record-gate.
    const e = isRecordLike(err) ? err : null;
    if (typeof e?.code === "number") {
      const stdout = typeof e.stdout === "string" ? e.stdout : "";
      const stderr = typeof e.stderr === "string" ? e.stderr : "";
      return {
        exitCode: e.code,
        stdoutSha256: sha256Hex(stdout),
        stderrSha256: sha256Hex(stderr),
        stdoutTail: outputTail(stdout),
        stderrTail: outputTail(stderr),
        retryable: true,
      };
    }
    // Timeout or ENOENT (binary not found) — honest fail, no fabricated code.
    const reason = e?.signal === "SIGTERM" || /TIMEDOUT/i.test(String(e?.message || ""))
      ? `command probe timed out after ${COMMAND_PROBE_TIMEOUT_MS}ms`
      : `command probe failed to execute: ${text(e?.code) || text(e?.message) || "unknown error"}`;
    return { exitCode: -1, stdoutSha256: "", stderrSha256: "", stdoutTail: "", stderrTail: "", note: reason, retryable: false };
  }
}

/**
 * Run probes for every checklist item with a known verificationMethod.
 * Returns hardGateCheck-shaped records consumable by buildEvidenceProbePlan's
 * upgrade path.
 *
 * Static items get a scope probe (unchanged). Command/test items get a real
 * deterministic command probe. Every other known method (event-based,
 * absence_check, manual) and any unknown method gets an honest failed claim
 * so the ledger records the item rather than silently dropping it.
 */
export async function runChecklistProbes(
  acceptanceChecklist: LooseRecord | null,
  cwd: string,
  { base = null, finalWorktree = null, attemptId = null, env = process.env }: {
    base?: string | null;
    finalWorktree?: LooseRecord | null;
    attemptId?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LooseRecord[]> {
  if (!acceptanceChecklist || !Array.isArray(acceptanceChecklist.items)) return [];

  const candidateItems = acceptanceChecklist.items.filter(
    (item: LooseRecord) => text(item?.id) && text(item?.predicateId),
  );
  if (candidateItems.length === 0) return [];

  const worktreeHead = text(finalWorktree?.head) || null;
  const diffHash = text(finalWorktree?.diffHash) || null;
  const attempt = text(attemptId) || null;

  const changed = await changedFiles(cwd, base, env);
  const trustedProbePolicy = await loadTrustedProbePolicy(cwd, env);

  const checks: LooseRecord[] = [];
  for (const item of candidateItems) {
    const checklistId = text(item.id);
    const predicateId = text(item.predicateId);
    const probeId = `probe-${checklistId}`;
    const method = text(item.verificationMethod);

    if (method === "static") {
      const allowedFiles: string[] = Array.isArray(item.allowedFiles) ? item.allowedFiles.map(text).filter(Boolean) : [];
      const matchCount = scopeMatches(changed, allowedFiles);

      checks.push({
        checklistId,
        predicateId,
        probeId,
        observation: {
          checklistId,
          predicateId,
          probeId,
          verificationMethod: "static",
          queryId: `static-diff-scope:${checklistId}`,
          matchCount,
          allowedFiles,
          changedFilesInScope: changed.filter((f) => allowedFiles.some((allowedFile) => scopePathMatches(f, allowedFile))),
          ...(worktreeHead ? { worktreeHead } : {}),
          ...(diffHash ? { diffHash } : {}),
          ...(attempt ? { attemptId: attempt } : {}),
        },
        // Emit a claim even on fail so the ledger records the honest result
        // rather than silently dropping the item.
        emitFailedClaim: true,
      });
      continue;
    }

    if (method === "command" || method === "test") {
      const declaredCommand = resolveDeclaredCommand(item, trustedProbePolicy);
      if (!declaredCommand) {
        // Model/free-text commands are never executable. A command/test item
        // must match a maintainer-owned structured probe committed at HEAD.
        checks.push({
          checklistId,
          predicateId,
          probeId,
          observation: {
            checklistId,
            predicateId,
            probeId,
            verificationMethod: method,
            failureClass: "verification_evidence_unavailable",
            infrastructureFailure: true,
            note: `${method} checklist item has no trusted structured probe in ${TRUSTED_PROBE_POLICY_PATH} at HEAD; free-text evidence was not executed`,
            ...(worktreeHead ? { worktreeHead } : {}),
            ...(attempt ? { attemptId: attempt } : {}),
          },
          emitFailedClaim: true,
        });
        continue;
      }

      const renderedCommand = renderProbeCommand(declaredCommand);
      const run = await runDeclaredCommand(declaredCommand, cwd, env);
      const oracleFiles = run.exitCode === 0 ? changedOracleFiles(item, renderedCommand, changed) : [];
      const cleanReplay = oracleFiles.length > 0
        ? await runCleanOracleReplay(declaredCommand, cwd, oracleFiles, env)
        : null;
      checks.push({
        checklistId,
        predicateId,
        probeId,
        observation: {
          checklistId,
          predicateId,
          probeId,
          verificationMethod: method,
          command: renderedCommand,
          cwd,
          exitCode: run.exitCode,
          stdoutSha256: run.stdoutSha256,
          stderrSha256: run.stderrSha256,
          stdoutTail: run.stdoutTail,
          stderrTail: run.stderrTail,
          retryCount: run.retryCount,
          probeAttempts: run.probeAttempts,
          ...(cleanReplay || {}),
          ...(run.note ? { note: run.note } : {}),
          ...(run.exitCode === -1 ? {
            failureClass: "verification_environment_unavailable",
            infrastructureFailure: true,
          } : {}),
          ...(worktreeHead ? { worktreeHead } : {}),
          ...(diffHash ? { diffHash } : {}),
          ...(attempt ? { attemptId: attempt } : {}),
        },
        // exitCode !== 0 (or a missing stdout digest) is an honest fail that
        // must still be recorded. emitFailedClaim keeps it ledger-visible.
        emitFailedClaim: true,
      });
      continue;
    }

    if (EVENT_BASED_METHODS.has(method)) {
      // V2: event-based / absence_check / manual methods require event-log
      // querying or approval-artifact resolution the runner does not yet own.
      // Record the item honestly so it is not silently dropped.
      checks.push({
        checklistId,
        predicateId,
        probeId,
        observation: {
          checklistId,
          predicateId,
          probeId,
          verificationMethod: method,
          note: `non-static method ${method} has no deterministic probe yet (V2: requires event-log query / approval-artifact resolution)`,
          ...(worktreeHead ? { worktreeHead } : {}),
          ...(attempt ? { attemptId: attempt } : {}),
        },
        emitFailedClaim: true,
      });
      continue;
    }

    // Unknown method — record an honest fail so a malformed/unsupported item
    // cannot silently slip through verification.
    checks.push({
      checklistId,
      predicateId,
      probeId,
      observation: {
        checklistId,
        predicateId,
        probeId,
        verificationMethod: method || "unknown",
        note: `unsupported verificationMethod ${JSON.stringify(method)}; no deterministic probe`,
        ...(worktreeHead ? { worktreeHead } : {}),
        ...(attempt ? { attemptId: attempt } : {}),
      },
      emitFailedClaim: true,
    });
  }
  return checks;
}
