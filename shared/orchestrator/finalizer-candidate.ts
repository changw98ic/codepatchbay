import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { isRecord, type LooseRecord } from "../../core/contracts/types.js";

const execFile = promisify(execFileCallback);

export type ValidatedFinalizerCandidate = {
  baseSha: string;
  headSha: string;
  treeHash: string;
  identityHash: string;
  cleanReplay: {
    cleanApply: true;
    baseSha: string;
    expectedTreeHash: string;
    actualTreeHash: string;
  };
};

function objectId(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{40,64}$/.test(normalized) ? normalized : null;
}

function sha256(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^sha256:[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

/**
 * Extract the immutable candidate identity only from a completed, internally
 * consistent completion-gate result. Callers must not reconstruct this binding
 * from a finalizer receipt because that would make the receipt self-authenticating.
 */
export function validatedFinalizerCandidate(jobValue: unknown): ValidatedFinalizerCandidate | null {
  if (!isRecord(jobValue)) return null;
  const job = jobValue as LooseRecord;
  const completionGate = isRecord(job.completionGate)
    ? job.completionGate
    : isRecord(job.completionGateResult)
      ? job.completionGateResult
      : null;
  if (!completionGate) return null;
  const completionReport = isRecord(job.completionReport)
    ? job.completionReport
    : isRecord(completionGate.completionReport)
      ? completionGate.completionReport
      : null;
  const validation = isRecord(completionReport?.candidateValidation)
    ? completionReport.candidateValidation
    : null;
  const replay = isRecord(validation?.cleanReplay) ? validation.cleanReplay : null;
  const baseSha = objectId(validation?.baseSha);
  const headSha = objectId(validation?.headSha);
  const treeHash = objectId(validation?.treeHash);
  const identityHash = sha256(validation?.identityHash);
  const validatedIdentityHash = sha256(validation?.validatedCandidateIdentityHash);
  if (
    completionGate.outcome !== "complete"
    || validation?.identityMatch !== true
    || replay?.cleanApply !== true
    || !baseSha
    || !headSha
    || !treeHash
    || !identityHash
    || validatedIdentityHash !== identityHash
    || objectId(replay?.baseSha) !== baseSha
    || objectId(replay?.expectedTreeHash) !== treeHash
    || objectId(replay?.actualTreeHash) !== treeHash
  ) return null;
  return {
    baseSha,
    headSha,
    treeHash,
    identityHash,
    cleanReplay: {
      cleanApply: true,
      baseSha,
      expectedTreeHash: treeHash,
      actualTreeHash: treeHash,
    },
  };
}

type GitCandidateSnapshot = {
  branch: string;
  head: string;
  tree: string;
  status: string;
};

async function gitText(repositoryPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repositoryPath, ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(stdout || "").trim();
}

async function readGitCandidateSnapshot(repositoryPath: string): Promise<GitCandidateSnapshot> {
  const statusBefore = await gitText(repositoryPath, ["status", "--porcelain"]);
  const branch = await gitText(repositoryPath, ["branch", "--show-current"]);
  const identities = (await gitText(repositoryPath, ["rev-parse", "HEAD^{commit}", "HEAD^{tree}"]))
    .split(/\r?\n/);
  const statusAfter = await gitText(repositoryPath, ["status", "--porcelain"]);
  if (identities.length !== 2 || identities.some((value) => objectId(value) === null) || statusBefore !== statusAfter) {
    throw new Error("candidate repository changed during authoritative readback");
  }
  return {
    branch,
    head: identities[0].toLowerCase(),
    tree: identities[1].toLowerCase(),
    status: statusAfter,
  };
}

/**
 * Independently prove that the checked-out final commit is either the validated
 * clean candidate HEAD or the single-parent commit produced from a dirty frozen
 * candidate tree. The double snapshot rejects concurrent repository changes.
 */
export async function verifyFinalizerCandidateCommit({
  repositoryPath,
  result,
  candidate,
  expectedBranch = null,
}: {
  repositoryPath: string;
  result: LooseRecord;
  candidate: ValidatedFinalizerCandidate | null;
  expectedBranch?: string | null;
}): Promise<boolean> {
  if (!candidate || !path.isAbsolute(repositoryPath) || !finalizerResultMatchesCandidate(result, candidate)) {
    return false;
  }
  const expectedCommit = objectId(result.commit);
  if (!expectedCommit) return false;
  try {
    const first = await readGitCandidateSnapshot(repositoryPath);
    let parentValid = first.head === candidate.headSha;
    if (!parentValid) {
      const parentLine = await gitText(repositoryPath, ["rev-list", "--parents", "-n", "1", first.head]);
      const commitAndParents = parentLine.toLowerCase().split(/\s+/).filter(Boolean);
      parentValid = commitAndParents.length === 2
        && commitAndParents[0] === first.head
        && commitAndParents[1] === candidate.headSha;
    }
    const second = await readGitCandidateSnapshot(repositoryPath);
    return parentValid
      && first.status === ""
      && first.head === expectedCommit
      && first.tree === candidate.treeHash
      && JSON.stringify(first) === JSON.stringify(second)
      && (!expectedBranch || first.branch === expectedBranch);
  } catch {
    return false;
  }
}

export async function verifyFinalizerCandidateObject({
  repositoryPath,
  result,
  candidate,
  expectedRef,
}: {
  repositoryPath: string;
  result: LooseRecord;
  candidate: ValidatedFinalizerCandidate | null;
  expectedRef: string;
}): Promise<boolean> {
  if (!candidate
    || !path.isAbsolute(repositoryPath)
    || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(expectedRef)
    || expectedRef.split("/").includes("..")
    || !finalizerResultMatchesCandidate(result, candidate)) return false;
  const expectedCommit = objectId(result.commit);
  if (!expectedCommit) return false;
  try {
    const readIdentity = async () => {
      const values = (await gitText(repositoryPath, [
        "rev-parse",
        `${expectedRef}^{commit}`,
        `${expectedCommit}^{commit}`,
        `${expectedCommit}^{tree}`,
      ])).split(/\r?\n/).map((entry) => entry.toLowerCase());
      if (values.length !== 3 || values.some((value) => objectId(value) === null)) {
        throw new Error("finalizer object readback is incomplete");
      }
      return values;
    };
    const first = await readIdentity();
    const parentLine = expectedCommit === candidate.headSha
      ? null
      : await gitText(repositoryPath, ["rev-list", "--parents", "-n", "1", expectedCommit]);
    const parentValid = expectedCommit === candidate.headSha || (() => {
      const values = String(parentLine || "").toLowerCase().split(/\s+/).filter(Boolean);
      return values.length === 2 && values[0] === expectedCommit && values[1] === candidate.headSha;
    })();
    const second = await readIdentity();
    return parentValid
      && first[0] === expectedCommit
      && first[1] === expectedCommit
      && first[2] === candidate.treeHash
      && JSON.stringify(first) === JSON.stringify(second);
  } catch {
    return false;
  }
}

export function finalizerResultMatchesCandidate(
  result: LooseRecord,
  candidate: ValidatedFinalizerCandidate | null,
): boolean {
  if (!candidate) return false;
  return objectId(result.commit) !== null
    && objectId(result.tree) === candidate.treeHash;
}

export function sameValidatedFinalizerCandidate(
  left: ValidatedFinalizerCandidate | null,
  right: ValidatedFinalizerCandidate | null,
): boolean {
  return Boolean(left && right
    && left.baseSha === right.baseSha
    && left.headSha === right.headSha
    && left.treeHash === right.treeHash
    && left.identityHash === right.identityHash
    && left.cleanReplay.baseSha === right.cleanReplay.baseSha
    && left.cleanReplay.expectedTreeHash === right.cleanReplay.expectedTreeHash
    && left.cleanReplay.actualTreeHash === right.cleanReplay.actualTreeHash);
}
