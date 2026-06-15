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
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type AnyRecord = Record<string, any>;

/** Command probe wall-clock timeout. Treats timeout as an honest fail. */
const COMMAND_PROBE_TIMEOUT_MS = 30_000;

function text(value: any): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Collect changed files in the working tree relative to base.
 * Returns repo-relative posix paths. Stable regardless of commit order.
 */
async function changedFiles(cwd: string, base: string | null): Promise<string[]> {
  const rev = base || "HEAD";
  try {
    const result = await execFileAsync("git", ["diff", "--name-only", rev], { cwd, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    // No usable base ref (e.g. empty repo). No diff means no objective
    // scope evidence — probes will honestly report matchCount=0.
    return [];
  }
}

function posixify(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Count diff hunks within a set of files. Each file with at least one
 * changed hunk contributes 1 to matchCount — a coarse but objective
 * "the declared file was actually modified" signal.
 */
function scopeMatches(changed: string[], allowedFiles: string[]): number {
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) return 0;
  const changedSet = new Set(changed.map(posixify));
  let count = 0;
  for (const f of allowedFiles) {
    if (changedSet.has(posixify(text(f)))) count += 1;
  }
  return count;
}

function sha256Hex(input: string): string {
  return "sha256:" + createHash("sha256").update(input, "utf8").digest("hex");
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
 * Resolve the command a command/test checklist item declares it should be
 * verified by. Codebase convention (core/workflow/checklist-decomposer.ts):
 * the LLM places the shell command in `expectedEvidence`. We also accept an
 * explicit `probeCommand` field as an override. SECURITY: only a command the
 * checklist explicitly declares is ever run — the runner never runs free
 * text it invented.
 */
function resolveDeclaredCommand(item: AnyRecord): string {
  const explicit = text(item?.probeCommand);
  if (explicit) return explicit;
  const fromEvidence = text(item?.expectedEvidence);
  return fromEvidence;
}

/**
 * Run a declared shell command deterministically. Returns the exit code and a
 * sha256 digest of stdout. Timeouts and missing binaries (ENOENT) are treated
 * as honest fails (exitCode recorded as -1 with a note), never thrown.
 */
async function runDeclaredCommand(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; stdoutSha256: string; stderrSha256: string; note?: string }> {
  try {
    // shell: true so a free-form command string ("npm test", "tsc --noEmit")
    // parses the way the checklist author intended. SECURITY: `command` comes
    // ONLY from the frozen checklist item's declared expectedEvidence /
    // probeCommand — never from untrusted verifier free text.
    const result = await execFileAsync(command, [], {
      cwd,
      shell: true,
      timeout: COMMAND_PROBE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdoutSha256: sha256Hex(result.stdout ?? ""),
      stderrSha256: sha256Hex(result.stderr ?? ""),
      // Note: digests are always emitted, even for empty output, so the
      // observation clears validateCommandObservation's record-gate (which
      // requires a non-empty digest) for both pass and fail paths.
    };
  } catch (err: any) {
    // Non-zero exit: Node attaches .code === number on a spawned process that
    // exited non-zero. Record the real exit code honestly. Output digests are
    // ALWAYS produced (even for empty output) — an empty stdout is itself an
    // objective, recordable result, and validateCommandObservation requires a
    // non-empty digest for the record-gate.
    if (typeof err?.code === "number") {
      const stdout = typeof err.stdout === "string" ? err.stdout : "";
      const stderr = typeof err.stderr === "string" ? err.stderr : "";
      return {
        exitCode: err.code,
        stdoutSha256: sha256Hex(stdout),
        stderrSha256: sha256Hex(stderr),
      };
    }
    // Timeout or ENOENT (binary not found) — honest fail, no fabricated code.
    const reason = err?.signal === "SIGTERM" || /TIMEDOUT/i.test(String(err?.message || ""))
      ? `command probe timed out after ${COMMAND_PROBE_TIMEOUT_MS}ms`
      : `command probe failed to execute: ${text(err?.code) || text(err?.message) || "unknown error"}`;
    return { exitCode: -1, stdoutSha256: "", stderrSha256: "", note: reason };
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
  acceptanceChecklist: AnyRecord | null,
  cwd: string,
  { base = null, finalWorktree = null, attemptId = null }: { base?: string | null; finalWorktree?: AnyRecord | null; attemptId?: string | null } = {},
): Promise<AnyRecord[]> {
  if (!acceptanceChecklist || !Array.isArray(acceptanceChecklist.items)) return [];

  const candidateItems = acceptanceChecklist.items.filter(
    (item: AnyRecord) => text(item?.id) && text(item?.predicateId),
  );
  if (candidateItems.length === 0) return [];

  const worktreeHead = text(finalWorktree?.head) || null;
  const diffHash = text(finalWorktree?.diffHash) || null;
  const attempt = text(attemptId) || null;

  const changed = await changedFiles(cwd, base);

  const checks: AnyRecord[] = [];
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
          changedFilesInScope: changed.filter((f) => allowedFiles.map(posixify).includes(posixify(f))),
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
      const declaredCommand = resolveDeclaredCommand(item);
      if (!declaredCommand) {
        // command/test item with no runnable command declared — honest fail,
        // not a silent skip. The item must declare what proves it.
        checks.push({
          checklistId,
          predicateId,
          probeId,
          observation: {
            checklistId,
            predicateId,
            probeId,
            verificationMethod: method,
            note: `${method} checklist item declares no runnable command (probeCommand / expectedEvidence empty); no deterministic probe possible`,
            ...(worktreeHead ? { worktreeHead } : {}),
            ...(attempt ? { attemptId: attempt } : {}),
          },
          emitFailedClaim: true,
        });
        continue;
      }

      const run = await runDeclaredCommand(declaredCommand, cwd);
      checks.push({
        checklistId,
        predicateId,
        probeId,
        observation: {
          checklistId,
          predicateId,
          probeId,
          verificationMethod: method,
          command: declaredCommand,
          cwd,
          exitCode: run.exitCode,
          stdoutSha256: run.stdoutSha256,
          stderrSha256: run.stderrSha256,
          ...(run.note ? { note: run.note } : {}),
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
