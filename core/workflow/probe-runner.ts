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
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type AnyRecord = Record<string, any>;

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

/**
 * Run probes for every static checklist item. Returns hardGateCheck-shaped
 * records consumable by buildEvidenceProbePlan's upgrade path.
 *
 * Non-static items are skipped (their probes come from other sources or
 * are not yet supported by the runner).
 */
export async function runChecklistProbes(
  acceptanceChecklist: AnyRecord | null,
  cwd: string,
  { base = null, finalWorktree = null }: { base?: string | null; finalWorktree?: AnyRecord | null } = {},
): Promise<AnyRecord[]> {
  if (!acceptanceChecklist || !Array.isArray(acceptanceChecklist.items)) return [];

  const staticItems = acceptanceChecklist.items.filter(
    (item: AnyRecord) => text(item?.verificationMethod) === "static" && text(item?.id) && text(item?.predicateId),
  );
  if (staticItems.length === 0) return [];

  const changed = await changedFiles(cwd, base);

  const checks: AnyRecord[] = [];
  for (const item of staticItems) {
    const checklistId = text(item.id);
    const predicateId = text(item.predicateId);
    const allowedFiles: string[] = Array.isArray(item.allowedFiles) ? item.allowedFiles.map(text).filter(Boolean) : [];
    const matchCount = scopeMatches(changed, allowedFiles);

    checks.push({
      checklistId,
      predicateId,
      probeId: `probe-${checklistId}`,
      observation: {
        checklistId,
        predicateId,
        probeId: `probe-${checklistId}`,
        verificationMethod: "static",
        queryId: `static-diff-scope:${checklistId}`,
        matchCount,
        allowedFiles,
        changedFilesInScope: changed.filter((f) => allowedFiles.map(posixify).includes(posixify(f))),
        ...(finalWorktree?.head ? { worktreeHead: finalWorktree.head } : {}),
        ...(finalWorktree?.diffHash ? { diffHash: finalWorktree.diffHash } : {}),
      },
      // Emit a claim even on fail so the ledger records the honest result
      // rather than silently dropping the item.
      emitFailedClaim: true,
    });
  }
  return checks;
}
