import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  MERGE_CLASSIFICATION,
  normalizeMergePath,
  summarizeMergeFiles,
} from "./evolve/evolve.js";
import { appendEvent, readEvents } from "./event/event-store.js";
import { getJob, recordFinalizerResult } from "./job/job-store.js";
import { openDraftPullRequest } from "./github/github-issues.js";
import { enqueue as enqueueHubQueue, updateEntry as updateHubQueueEntry } from "./hub/hub-queue.js";
import { actualDiffRiskGuard } from "../../core/triage/rules.js";
import { normalizeRoute, scopesContainCritical } from "../../core/triage/schema.js";
import { buildReviewBundle, writeReviewBundle, reviewBundleDir } from "./review/review-session.js";
import type { LooseRecord } from "../../core/contracts/types.js";

const execFileAsync = promisify(execFile);

const PHASE_ROLE_MAP: Record<string, string> = { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", remediate: "remediator" };

type FinalizerRecord = LooseRecord & {
  id?: string;
  jobId?: string;
  project?: string;
  projectId?: string;
  status?: string | FinalizerRecord;
  code?: string | number;
  type?: string;
  phase?: string;
  agent?: string;
  mode?: string;
  reason?: string;
  reasons?: unknown[];
  description?: string;
  task?: string;
  source?: string;
  sourcePath?: string | null;
  worktree?: string;
  worktreeBranch?: string;
  worktreeBaseBranch?: string;
  cwd?: string | null;
  sessionId?: string | null;
  workerId?: string | null;
  executionBoundary?: string | null;
  priority?: string;
  metadata?: FinalizerRecord;
  sourceContext?: FinalizerRecord;
  routing?: FinalizerRecord;
  effectiveRoute?: FinalizerRecord;
  effective?: FinalizerRecord;
  requestedRoute?: FinalizerRecord;
  requested?: FinalizerRecord;
  ruleRoute?: FinalizerRecord;
  acpRoute?: FinalizerRecord;
  workflow?: string;
  planMode?: string;
  reviewer?: boolean;
  repo?: string;
  repository?: string;
  repositoryFullName?: string;
  issueNumber?: number | string;
  issueUrl?: string;
  issueTitle?: string;
  url?: string;
  entries?: FinalizerRecord[];
  counts?: Record<string, number>;
  classification?: string;
  protectedScopes?: string[];
  actualDiffRisk?: FinalizerRecord & { protected?: boolean; files?: string[] };
  protectedDiff?: FinalizerRecord;
  guardResult?: FinalizerRecord;
  escalation?: FinalizerRecord;
  finalDiffGuard?: FinalizerRecord;
  broken?: boolean;
  kind?: string;
  path?: string;
  links?: FinalizerRecord & { artifacts?: FinalizerRecord[]; eventLog?: string | null };
  evidence?: FinalizerRecord;
  verdict?: FinalizerRecord | string | null;
  verdictDetail?: LooseRecord | null;
  dw?: FinalizerRecord;
  completionGate?: FinalizerRecord;
  outcome?: string;
  layers?: Record<string, FinalizerRecord>;
  detail?: string;
  tests?: unknown;
  basis?: FinalizerRecord;
  blocking?: unknown[];
  blockingMissingInputs?: unknown[];
  blockingCount?: number;
  ok?: boolean;
  stdout?: string;
  stderr?: string;
  result?: FinalizerRecord;
  request?: FinalizerRecord & { body?: string; head?: string };
  branchPreparation?: FinalizerRecord & { commit?: string };
  commit?: string;
  prUrl?: string;
  prNumber?: number;
  error?: unknown;
  changedFiles?: unknown[];
};

type RuntimePathOptions = FinalizerRecord & {
  dataRoot?: string;
};

type RunCommandResult = {
  stdout?: string;
  stderr?: string;
};

type RunCommandError = Error & {
  stdout?: string;
  stderr?: string;
  code?: number;
};

type RunCommand = (command: string, args: string[], options?: LooseRecord) => Promise<RunCommandResult>;
type RecordFinalizerResultFn = typeof recordFinalizerResult;
type QueueMetadataForEnqueue = NonNullable<NonNullable<Parameters<typeof enqueueHubQueue>[1]>["metadata"]>;
type DraftPullRequestOptions = NonNullable<Parameters<typeof openDraftPullRequest>[0]>;

type RunCommandOptions = {
  runCommand?: RunCommand;
};

type GitOptions = RunCommandOptions & {
  allowFailure?: boolean;
};

type IssueReference = {
  repo: string;
  number: number;
  url: string;
};

type RouteGuard = FinalizerRecord & {
  blocked: boolean;
  route: FinalizerRecord;
  protectedDiff: FinalizerRecord & {
    protectedScopes?: string[];
    actualDiffRisk: FinalizerRecord & { protected?: boolean; files?: string[] };
  };
  guardResult: FinalizerRecord & {
    allowed?: boolean;
    escalation?: FinalizerRecord | null;
    reviewer?: boolean;
  };
};

type RequeueProtectedDiffUpgradeOptions = {
  hubRoot?: string | null;
  entry?: FinalizerRecord;
  job?: FinalizerRecord;
  projectId?: string | null;
  sourcePath?: string | null;
  issue?: IssueReference | null;
  jobId?: string;
  route?: FinalizerRecord;
  protectedDiff?: RouteGuard["protectedDiff"];
  guardResult?: RouteGuard["guardResult"];
};

type ReviewEvidenceOptions = {
  cpbRoot?: string | null;
  dataRoot?: string | null;
  hubRoot?: string | null;
};

type FinalizeReviewBundleOptions = RuntimePathOptions & {
  cpbRoot?: string;
  hubRoot?: string | null;
  project?: string | null;
  entry?: FinalizerRecord;
  job?: FinalizerRecord;
  sourcePath?: string | null;
  jobId?: string;
};

type FinalizeQueueEntryOptions = RuntimePathOptions & {
  cpbRoot?: string;
  hubRoot?: string | null;
  project?: string | null;
  entry?: FinalizerRecord;
  job?: FinalizerRecord;
  sourcePath?: string | null;
  mode?: "dry-run" | "local" | "remote" | "pr" | string;
  remote?: string;
  issueCloser?: ((issue: FinalizerRecord) => Promise<void> | void) | null;
  runCommand?: RunCommand;
  createPullRequest?: DraftPullRequestOptions["createPullRequest"] | null;
  pushToken?: string | null;
  transportMode?: string | null;
  allowLiveFinalize?: boolean;
  allowLive?: boolean;
  recordFinalizerResult?: RecordFinalizerResultFn;
};

type ApprovalGateOptions = RuntimePathOptions & {
  operation?: string | null;
  phase?: string | null;
  channels?: unknown[];
  reason?: string;
  timeoutAt?: string | null;
  ts?: string;
  actor?: string | null;
  action?: string | null;
};

function commandErrorDetails(err: unknown): RunCommandError {
  return err instanceof Error ? err as RunCommandError : Object.assign(new Error(String(err)), { stderr: String(err) });
}

function isFinalizerRecord(value: unknown): value is FinalizerRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finalizerRecord(value: unknown): FinalizerRecord {
  return isFinalizerRecord(value) ? value : {};
}

function commandErrorMessage(err: unknown): string {
  const details = commandErrorDetails(err);
  return String(details.stderr || details.stdout || details.message || "").trim();
}

async function resolveAgentsFromEvents(cpbRoot: string, projectId: string, jobId: string, { dataRoot }: RuntimePathOptions = {}) {
  try {
    const events = await readEvents(cpbRoot, projectId, jobId, { dataRoot });
    const agents: FinalizerRecord = {};
    for (const ev of events) {
      if (ev.type === "phase_result" && ev.phase && ev.agent) {
        const role = PHASE_ROLE_MAP[ev.phase] || ev.phase;
        if (!agents[role]) agents[role] = ev.agent;
      }
    }
    return agents;
  } catch {
    return {};
  }
}

async function runGit(cwd: string, args: string[], { allowFailure = false, runCommand = execFileAsync }: GitOptions = {}) {
  try {
    const result = await runCommand("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: 0,
    };
  } catch (err) {
    if (!allowFailure) throw err;
    const details = commandErrorDetails(err);
    return {
      stdout: details.stdout || "",
      stderr: details.stderr || details.message || "",
      exitCode: Number.isInteger(details.code) ? details.code : 1,
    };
  }
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(repoPath: string, { runCommand }: RunCommandOptions = {}) {
  const result = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"], {
    allowFailure: true,
    runCommand,
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function assertClean(repoPath: string, { runCommand }: RunCommandOptions = {}) {
  const status = await runGit(repoPath, ["status", "--porcelain"], { runCommand });
  return status.stdout.trim() === "";
}

async function currentBranch(repoPath: string, { runCommand }: RunCommandOptions = {}) {
  return (await runGit(repoPath, ["branch", "--show-current"], { runCommand })).stdout.trim();
}

async function revParse(repoPath: string, ref = "HEAD", { runCommand }: RunCommandOptions = {}) {
  return (await runGit(repoPath, ["rev-parse", "--verify", ref], { runCommand })).stdout.trim();
}

async function diffFiles(repoPath: string, fromRef: string, toRef: string, { runCommand }: RunCommandOptions = {}) {
  const result = await runGit(repoPath, ["diff", "--name-only", "-z", fromRef, toRef], { runCommand });
  return splitNul(result.stdout);
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string, { runCommand }: RunCommandOptions = {}) {
  const result = await runGit(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
    runCommand,
  });
  return result.exitCode === 0;
}

function reject(code: string, details: FinalizerRecord = {}): FinalizerRecord {
  return {
    ok: false,
    status: "rejected",
    code,
    jobId: details.jobId ?? null,
    ...details,
  };
}

function blocked(code: string, details: FinalizerRecord = {}): FinalizerRecord {
  return {
    ok: false,
    status: "blocked",
    code,
    jobId: details.jobId ?? null,
    ...details,
  };
}

function skipped(code: string, details: FinalizerRecord = {}): FinalizerRecord {
  return {
    ok: false,
    status: "skipped",
    code,
    jobId: details.jobId ?? null,
    ...details,
  };
}

function parseIssueUrl(issueUrl: unknown): { repo: string; number: number; url: string } | null {
  if (!issueUrl) return null;
  const match = String(issueUrl).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/);
  if (!match) return null;
  return {
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`,
  };
}

function resolveIssue(metadata: FinalizerRecord = {}): IssueReference | null {
  const number = Number(metadata.issueNumber);
  const repo = metadata.repo || metadata.repository || metadata.repositoryFullName;
  if (Number.isInteger(number) && number > 0 && typeof repo === "string" && repo.includes("/")) {
    return {
      repo,
      number,
      url: metadata.issueUrl || `https://github.com/${repo}/issues/${number}`,
    };
  }

  return parseIssueUrl(metadata.issueUrl);
}

function splitNul(value: unknown): string[] {
  return String(value || "").split("\0").filter(Boolean);
}

async function changedWorktreeFiles(worktreePath: string, { runCommand }: RunCommandOptions = {}) {
  const [unstaged, staged, untracked] = await Promise.all([
    runGit(worktreePath, ["diff", "--name-only", "-z"], { runCommand }),
    runGit(worktreePath, ["diff", "--cached", "--name-only", "-z"], { runCommand }),
    runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], { runCommand }),
  ]);
  return [...new Set([
    ...splitNul(unstaged.stdout),
    ...splitNul(staged.stdout),
    ...splitNul(untracked.stdout),
  ])];
}

function hasUnsafeChanges(summary: FinalizerRecord): boolean {
  return (
    summary.counts[MERGE_CLASSIFICATION.SHARED_STATE] > 0
    || summary.counts[MERGE_CLASSIFICATION.NEEDS_HUMAN] > 0
  );
}

function unsafeFiles(summary: FinalizerRecord): FinalizerRecord[] {
  return (summary.entries || []).filter((entry: FinalizerRecord) => (
    entry.classification === MERGE_CLASSIFICATION.SHARED_STATE
    || entry.classification === MERGE_CLASSIFICATION.NEEDS_HUMAN
  ));
}

function routingEffectiveRoute(entry: FinalizerRecord = {}, job: FinalizerRecord = {}): FinalizerRecord {
  const metadata = finalizerRecord(entry?.metadata);
  const routing = finalizerRecord(metadata.routing);
  return normalizeRoute(
    routing.effectiveRoute || routing.effective || {
      workflow: metadata.workflow || job.workflow || "standard",
      planMode: metadata.planMode || job.planMode || "full",
      reviewer: Boolean(routing.effectiveRoute?.reviewer || routing.effective?.reviewer),
      source: "queue_metadata",
      reason: "queue routing metadata",
    },
  );
}

function routeAllowsProtectedDiff(route: FinalizerRecord, protectedScopes: string[] = []): { allowed: boolean; escalation: FinalizerRecord | null; reviewer: boolean } {
  if (route?.workflow === "complex" && route?.planMode === "full") {
    return { allowed: true, escalation: null, reviewer: false };
  }

  const hasCritical = scopesContainCritical(protectedScopes);
  const wf = route?.workflow;
  const pm = route?.planMode;

  if (wf === "standard" && pm === "parent") {
    if (!hasCritical) {
      return { allowed: true, escalation: null, reviewer: true };
    }
    return {
      allowed: false,
      escalation: { workflow: "standard", planMode: "full", reviewer: true },
      reviewer: true,
    };
  }

  if (wf === "standard" && pm === "light") {
    // Keep standard workflow, upgrade to full plan + reviewer
    return {
      allowed: false,
      escalation: { workflow: "standard", planMode: "full", reviewer: true },
      reviewer: true,
    };
  }

  if (wf === "direct" && pm === "none") {
    return {
      allowed: false,
      escalation: { workflow: "complex", planMode: "full", reviewer: false },
      reviewer: false,
    };
  }

  return {
    allowed: false,
    escalation: { workflow: "complex", planMode: "full", reviewer: true },
    reviewer: true,
  };
}

function protectedDiffForRoute(files: string[], entry: FinalizerRecord, job: FinalizerRecord): RouteGuard {
  const route = routingEffectiveRoute(entry, job);
  const protectedDiff = actualDiffRiskGuard({ files });
  if (!protectedDiff.actualDiffRisk.protected) {
    return { blocked: false, route, protectedDiff, guardResult: { allowed: true } };
  }
  const guardResult = routeAllowsProtectedDiff(route, protectedDiff.protectedScopes);
  if (guardResult.allowed) {
    return { blocked: false, route, protectedDiff, guardResult };
  }
  return { blocked: true, route, protectedDiff, guardResult };
}

async function requeueProtectedDiffUpgrade({
  hubRoot,
  entry,
  job,
  projectId,
  sourcePath,
  issue,
  jobId,
  route,
  protectedDiff,
  guardResult,
}: RequeueProtectedDiffUpgradeOptions = {}) {
  if (!hubRoot || !entry?.id || !projectId || !route || !protectedDiff || !guardResult) return null;
  const escalation = guardResult?.escalation || { workflow: "complex", planMode: "full", reviewer: true };
  const scopeLevel = scopesContainCritical(protectedDiff.protectedScopes) ? "critical" : "non-critical";
  const upgradeRoute = normalizeRoute({
    category: "protected",
    workflow: escalation.workflow,
    planMode: escalation.planMode,
    reviewer: escalation.reviewer,
    source: "final_diff_guard",
    reason: `final diff touched ${scopeLevel} protected scopes; escalated from ${route.workflow}/${route.planMode}`,
  });
  const guardMetadata = {
    protected: true,
    originalRoute: route,
    effectiveRoute: upgradeRoute,
    protectedScopes: protectedDiff.protectedScopes,
    actualDiffRisk: protectedDiff.actualDiffRisk,
    files: protectedDiff.actualDiffRisk.files,
    sourceJobId: jobId,
    checkedAt: new Date().toISOString(),
  };
  const previousRoutingReasons = Array.isArray(entry.metadata?.routing?.reasons)
    ? entry.metadata.routing.reasons
    : [];
  const entryMetadata = finalizerRecord(entry.metadata);
  const entryRouting = finalizerRecord(entryMetadata.routing);
  const sourceContext = finalizerRecord(entryMetadata.sourceContext);
  const metadata: QueueMetadataForEnqueue = {};
  Object.assign(metadata, entryMetadata);
  if (entryMetadata.sourceContext !== undefined) Object.assign(metadata, { sourceContext });
  Object.assign(metadata, {
    workflow: upgradeRoute.workflow,
    planMode: upgradeRoute.planMode,
    requestedRoute: upgradeRoute,
    routing: {
      ...entryRouting,
      effective: upgradeRoute,
      effectiveRoute: upgradeRoute,
      protectedUpgrade: true,
      protectedScopes: protectedDiff.protectedScopes,
      actualDiffRisk: protectedDiff.actualDiffRisk,
      reasons: [
        ...new Set([
          ...previousRoutingReasons,
          `final diff guard forced ${escalation.workflow}/${escalation.planMode}`,
        ]),
      ],
    },
    finalDiffGuard: guardMetadata,
    originQueueId: entry.id,
    originJobId: jobId,
    supersedesQueueEntryId: entry.id,
    queueDedupeKey: `${entry.metadata?.queueDedupeKey || entry.id}:final-diff-guard:${jobId}`,
    autoFinalize: entry.metadata?.autoFinalize ?? true,
  });

  const upgraded = await enqueueHubQueue(hubRoot, {
    projectId,
    sourcePath: entry.sourcePath || sourcePath || null,
    sessionId: entry.sessionId || null,
    workerId: null,
    cwd: entry.cwd || null,
    executionBoundary: entry.executionBoundary || null,
    type: "routing_upgrade",
    priority: entry.priority || "P1",
    description: entry.description || job?.task || issue?.url || "protected diff routing upgrade",
    metadata,
  });

  await updateHubQueueEntry(hubRoot, entry.id, {
    metadata: {
      finalDisposition: "rejected.final_diff_guard",
      supersededByQueueEntryId: upgraded.id,
      supersededByJobId: jobId,
      finalDiffGuard: guardMetadata,
    },
  }).catch(() => {});

  return upgraded;
}

function buildRoutingContext(entry: FinalizerRecord, job: FinalizerRecord, routeGuard: RouteGuard | null = null): FinalizerRecord {
  const metadata = finalizerRecord(entry?.metadata);
  const routing = finalizerRecord(metadata.routing);
  const sourceContext = finalizerRecord(job?.sourceContext);
  let finalDiffGuard = null;
  if (routeGuard) {
    finalDiffGuard = {
      passed: !routeGuard.blocked,
      protectedScopes: routeGuard.protectedDiff?.protectedScopes || [],
      guardResult: routeGuard.guardResult,
      route: routeGuard.route,
    };
  } else if (metadata.finalDiffGuard) {
    finalDiffGuard = { passed: false, ...finalizerRecord(metadata.finalDiffGuard) };
  }
  const planCache = isFinalizerRecord(sourceContext.parentPlan)
    ? sourceContext.parentPlan
    : (isFinalizerRecord(metadata.planCache) ? metadata.planCache : null);
  return {
    routing,
    planMode: metadata.planMode || job.planMode || null,
    contextPack: metadata.contextPack || null,
    planCache,
    finalDiffGuard,
  };
}

function isInsideRoot(root: string, targetPath: string): boolean {
  if (!root || !targetPath || !path.isAbsolute(targetPath)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function displayArtifactPath(artifactPath: unknown, roots: string[] = []): string | null {
  if (!artifactPath) return null;
  const value = String(artifactPath);
  if (!path.isAbsolute(value)) return value;
  for (const root of roots) {
    if (isInsideRoot(root, value)) return path.relative(path.resolve(root), value);
  }
  return path.basename(value);
}

function artifactIdFromPath(artifactPath: unknown): string {
  const name = path.basename(String(artifactPath || "artifact"));
  return name.replace(/\.(?:md|patch|diff|txt|json)$/i, "") || "artifact";
}

function artifactReferenceFromEntry(entry: FinalizerRecord, roots: string[]): { id: string; path: string | null } | null {
  if (!entry || entry.broken) return null;
  return {
    id: entry.id || artifactIdFromPath(entry.path),
    path: displayArtifactPath(entry.path, roots),
  };
}

function artifactReferenceForKind(bundle: FinalizerRecord, kind: string, roots: string[]): { id: string; path: string | null } | null {
  const matches = (bundle?.links?.artifacts || [])
    .filter((entry: FinalizerRecord) => entry?.kind === kind && !entry.broken);
  if (matches.length === 0) return null;
  const entry = kind === "verdict" ? matches[matches.length - 1] : matches[0];
  return artifactReferenceFromEntry(entry, roots);
}

function pushEvidenceLine(lines: string[], value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) pushEvidenceLine(lines, item);
    return;
  }
  if (value === null || value === undefined) return;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text) lines.push(text);
}

function testEvidenceFromVerdict(verdict: FinalizerRecord): string[] {
  const lines: string[] = [];
  pushEvidenceLine(lines, verdict?.tests);
  pushEvidenceLine(lines, verdict?.basis?.tests);
  if (verdict?.layers && typeof verdict.layers === "object") {
    for (const [name, layer] of Object.entries(verdict.layers) as Array<[string, FinalizerRecord]>) {
      if (!layer?.detail) continue;
      pushEvidenceLine(lines, `${name}: ${layer.detail}`);
    }
  }
  return [...new Set(lines)].slice(0, 8);
}

function verdictEvidenceForBody(verdict: LooseRecord | null): FinalizerRecord {
  if (!verdict || typeof verdict !== "object") {
    return { status: "pass", reason: "No structured verdict evidence was found" };
  }
  const blocking = Array.isArray(verdict.blocking) ? verdict.blocking : undefined;
  const blockingMissing = Array.isArray(verdict.blockingMissingInputs) ? verdict.blockingMissingInputs : undefined;
  const blockingCount = typeof verdict.blockingCount === "number"
    ? verdict.blockingCount
    : blocking?.length ?? blockingMissing?.length ?? undefined;
  const out: FinalizerRecord = {};
  Object.assign(out, verdict);
  out.status = String(verdict.status || verdict.verdict || "unavailable");
  out.blockingCount = blockingCount;
  return out;
}

function derivePrVerdictFromBundle(bundle: FinalizerRecord): FinalizerRecord {
  const evidence = finalizerRecord(bundle.evidence);
  const dw = finalizerRecord(bundle.dw);
  const completionGate = isFinalizerRecord(dw.completionGate) ? dw.completionGate : null;
  if (completionGate?.outcome !== "complete") {
    return {
      ok: false,
      code: "COMPLETION_GATE_NOT_COMPLETE",
      completionGate,
    };
  }

  const verdict = isFinalizerRecord(evidence.verdict) ? evidence.verdict : null;
  const status = String(verdict?.status || verdict?.verdict || "").trim().toLowerCase();
  if (status !== "pass") {
    return {
      ok: false,
      code: "VERDICT_NOT_PASS",
      completionGate,
      verdict: verdictEvidenceForBody(verdict),
    };
  }

  return {
    ok: true,
    verdict: "PASS",
    completionGate,
    verdictDetail: verdictEvidenceForBody(verdict),
  };
}

export function buildPrEvidenceFromReviewBundle(bundle: FinalizerRecord, {
  cpbRoot = null,
  dataRoot = null,
  hubRoot = null,
}: ReviewEvidenceOptions = {}): FinalizerRecord {
  const evidence = finalizerRecord(bundle.evidence);
  const roots = [hubRoot, dataRoot, cpbRoot].filter((root): root is string => Boolean(root));
  const artifacts = {
    plan: artifactReferenceForKind(bundle, "plan", roots),
    deliverable: artifactReferenceForKind(bundle, "deliverable", roots),
    review: artifactReferenceForKind(bundle, "review", roots),
    verdict: artifactReferenceForKind(bundle, "verdict", roots),
    diff: artifactReferenceForKind(bundle, "diff", roots),
  };
  if (!artifacts.diff && evidence.diffStat) {
    artifacts.diff = {
      id: "worktree-diff",
      path: `${Array.isArray(evidence.changedFiles) ? evidence.changedFiles.length : 0} changed files`,
    };
  }

  const artifactCount = Array.isArray(bundle?.links?.artifacts) ? bundle.links.artifacts.length : 0;
  return {
    artifacts,
    tests: testEvidenceFromVerdict(isFinalizerRecord(evidence.verdict) ? evidence.verdict : {}),
    audit: {
      eventLog: bundle?.links?.eventLog || null,
      artifactIndex: artifactCount > 0 ? `${artifactCount} artifact references` : null,
    },
    verdictDetail: verdictEvidenceForBody(isFinalizerRecord(evidence.verdict) ? evidence.verdict : null),
  };
}

function commitMessage({ jobId, issueNumber }: { jobId?: string; issueNumber?: number | string }): string {
  return [
    `Finalize CPB job ${jobId} for issue #${issueNumber}`,
    "",
    `CPB-Job: ${jobId}`,
    `Issue: #${issueNumber}`,
  ].join("\n");
}

/**
 * Detect file-level conflicts when parallel finalizes race on the same source.
 * Re-reads the source HEAD; if it advanced since `originalSourceHead`, computes
 * the intersection of intervening changes with the worktree's changed files.
 */
export async function detectParallelConflict(
  sourcePath: string,
  originalSourceHead: string,
  worktreeChangedFiles: string[],
  { runCommand = execFileAsync }: RunCommandOptions = {},
) {
  const currentHead = await revParse(sourcePath, "HEAD", { runCommand });
  if (currentHead === originalSourceHead) {
    return { conflict: false, sourceAdvanced: false };
  }

  const interveningRaw = await diffFiles(sourcePath, originalSourceHead, currentHead, { runCommand });
  const intervening = new Set(interveningRaw.map(normalizeMergePath));
  const worktree = new Set(worktreeChangedFiles.map(normalizeMergePath));

  const overlapping = [...worktree].filter((f) => intervening.has(f)).sort();

  return {
    conflict: overlapping.length > 0,
    sourceAdvanced: true,
    currentHead,
    originalSourceHead,
    interveningFiles: interveningRaw,
    worktreeFiles: worktreeChangedFiles,
    overlappingFiles: overlapping,
  };
}

async function finalizeAsReviewBundle({
  cpbRoot, hubRoot, project, entry, job, sourcePath,
  jobId, dataRoot,
}: FinalizeReviewBundleOptions = {}) {
  try {
    const bundle = finalizerRecord(await buildReviewBundle(cpbRoot, project, jobId, {
      entry, job, sourcePath,
      worktreePath: job?.worktree || null,
      dataRoot,
    }));
    const evidence = finalizerRecord(bundle.evidence);
    const verdict = finalizerRecord(evidence.verdict);

    const outputDir = hubRoot ? reviewBundleDir(hubRoot, project, jobId) : (cpbRoot || process.cwd());
    const bundlePath = await writeReviewBundle(outputDir, bundle);

    if (cpbRoot && project) {
      await appendEvent(cpbRoot, project, jobId, {
        type: "review_bundle_created",
        jobId,
        project,
        bundlePath,
        changedFiles: evidence.changedFiles,
        verdict: verdict.verdict || null,
        ts: new Date().toISOString(),
      }, { dataRoot }).catch(() => {});
    }

    return {
      ok: true,
      status: "review_bundle",
      mode: "review_bundle",
      jobId,
      bundlePath,
      changedFiles: evidence.changedFiles,
      verdict: verdict.verdict || null,
    };
  } catch (err) {
    return reject("REVIEW_BUNDLE_FAILED", { jobId, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function finalizeSuccessfulQueueEntry({
  cpbRoot,
  project,
  entry,
  job,
  sourcePath,
  mode = "dry-run",
  remote = "origin",
  issueCloser,
  runCommand = execFileAsync,
  createPullRequest,
  pushToken = null,
  transportMode = null,
  dataRoot,
  hubRoot = null,
  allowLiveFinalize = false,
  allowLive = false,
  recordFinalizerResult: recordFinalizerResultFn = recordFinalizerResult,
}: FinalizeQueueEntryOptions = {}) {
  const jobId = job?.jobId || job?.id || entry?.jobId || entry?.id || "unknown";
  const projectId = project || job?.project || entry?.projectId || null;
  const dryRun = mode === "dry-run";
  const liveAllowed = Boolean(allowLiveFinalize || allowLive);
  const recordAndReturn = async (result: FinalizerRecord) => {
    if (cpbRoot && projectId && jobId && jobId !== "unknown") {
      try {
        await recordFinalizerResultFn(cpbRoot, projectId, jobId, { result, dataRoot });
      } catch (err) {
        return blocked("FINALIZER_AUDIT_RECORD_FAILED", {
          jobId,
          mode,
          error: err instanceof Error ? err.message : String(err),
          finalizerResult: result,
        });
      }
    }
    return result;
  };

  if (job?.status !== "completed") {
    return recordAndReturn(skipped("JOB_NOT_COMPLETED", { jobId }));
  }

  const issue = resolveIssue(entry?.metadata);
  if (!issue) {
    return recordAndReturn(await finalizeAsReviewBundle({
      cpbRoot, hubRoot, project: projectId, entry, job, sourcePath,
      jobId, dataRoot,
    }));
  }

  if (mode !== "local" && mode !== "remote" && mode !== "pr" && mode !== "dry-run") {
    return recordAndReturn(reject("UNSUPPORTED_MODE", { mode, jobId }));
  }

  if (!dryRun && !liveAllowed) {
    return recordAndReturn(reject("LIVE_FINALIZE_NOT_ALLOWED", { mode, jobId }));
  }

  if (!job?.worktree || !(await pathExists(job.worktree))) {
    return recordAndReturn(reject("NO_WORKTREE", { jobId }));
  }

  if (!sourcePath || !(await pathExists(sourcePath))) {
    return recordAndReturn(reject("NO_SOURCE_PATH", { jobId }));
  }

  const canonicalSourcePath = await realpath(path.resolve(sourcePath));
  const canonicalWorktreePath = await realpath(path.resolve(job.worktree));

  if (!(await isGitRepo(canonicalSourcePath, { runCommand }))) {
    return recordAndReturn(reject("SOURCE_NOT_GIT_REPO", { jobId }));
  }

  if (!(await assertClean(canonicalSourcePath, { runCommand }))) {
    return recordAndReturn(reject("SOURCE_NOT_CLEAN", { jobId, mode, dryRun }));
  }

  if (!(await isGitRepo(canonicalWorktreePath, { runCommand }))) {
    return recordAndReturn(reject("WORKTREE_NOT_GIT_REPO", { jobId }));
  }

  const sourceBranch = await currentBranch(canonicalSourcePath, { runCommand });
  if (!sourceBranch) {
    return recordAndReturn(reject("NO_SOURCE_BRANCH", { issue, jobId }));
  }

  const sourceHead = await revParse(canonicalSourcePath, "HEAD", { runCommand });
  const worktreeBranch = await currentBranch(canonicalWorktreePath, { runCommand });
  const worktreeHead = await revParse(canonicalWorktreePath, "HEAD", { runCommand });
  const uncommittedFiles = await changedWorktreeFiles(canonicalWorktreePath, { runCommand });
  if (!dryRun && mode === "pr" && uncommittedFiles.length > 0) {
    return recordAndReturn(reject("WORKTREE_NOT_CLEAN_FOR_LIVE_PR", {
      issue,
      jobId,
      mode,
      uncommittedFiles,
    }));
  }
  let committedFiles: string[] = [];
  if (worktreeHead !== sourceHead) {
    if (!(await isAncestor(canonicalWorktreePath, sourceHead, worktreeHead, { runCommand }))) {
      // Source HEAD advanced since the worktree branched — likely a parallel finalize.
      // Find the merge-base (= the commit the worktree was branched from) and
      // run file-level conflict detection for actionable diagnostics.
      const mbResult = await runGit(canonicalSourcePath, ["merge-base", sourceHead, worktreeHead], { allowFailure: true, runCommand });
      if (mbResult.exitCode === 0) {
        const baseCommit = mbResult.stdout.trim();
        const worktreeFiles = [
          ...uncommittedFiles,
          ...(await diffFiles(canonicalWorktreePath, baseCommit, worktreeHead, { runCommand }).catch((): string[] => [])),
        ];
        const conflictInfo = await detectParallelConflict(
          canonicalSourcePath,
          baseCommit,
          worktreeFiles,
          { runCommand },
        ).catch((): null => null);

        if (conflictInfo?.sourceAdvanced) {
          if (cpbRoot && projectId) {
            await appendEvent(cpbRoot, projectId, jobId, {
              type: "parallel_finalize_conflict",
              jobId,
              project: projectId,
              conflict: conflictInfo.conflict,
              originalSourceHead: baseCommit,
              currentSourceHead: conflictInfo.currentHead,
              overlappingFiles: conflictInfo.overlappingFiles,
              interveningFiles: conflictInfo.interveningFiles,
              ts: new Date().toISOString(),
            }, { dataRoot }).catch(() => {});
          }
          return recordAndReturn(reject(conflictInfo.conflict ? "PARALLEL_FILE_CONFLICT" : "SOURCE_ADVANCED_NO_CONFLICT", {
            issue,
            jobId,
            originalSourceHead: baseCommit,
            currentSourceHead: conflictInfo.currentHead,
            overlappingFiles: conflictInfo.overlappingFiles,
            interveningFiles: conflictInfo.interveningFiles,
            retryable: true,
          }));
        }
      }

      return recordAndReturn(reject("WORKTREE_NOT_DESCENDANT", {
        issue,
        jobId,
        sourceHead,
        worktreeHead,
      }));
    }
    committedFiles = await diffFiles(canonicalWorktreePath, sourceHead, worktreeHead, { runCommand });
  }

  const files = [...new Set([...committedFiles, ...uncommittedFiles])];
  if (files.length === 0) {
    return recordAndReturn(skipped("NO_CHANGES", { issue, jobId }));
  }

  const summary = summarizeMergeFiles(files);
  if (hasUnsafeChanges(summary)) {
    return recordAndReturn(reject("UNSAFE_WORKTREE_CHANGES", {
      issue,
      jobId,
      files: summary.entries,
      unsafeFiles: unsafeFiles(summary),
    }));
  }

  const routeGuard = protectedDiffForRoute(files, entry, job);
  if (routeGuard.blocked) {
    if (dryRun) {
      return recordAndReturn(reject("ROUTE_PROTECTED_DIFF", {
        issue,
        jobId,
        mode,
        dryRun: true,
        files: summary.entries,
        protectedDiff: routeGuard.protectedDiff,
        originalRoute: routeGuard.route,
        requeuedQueueEntryId: null,
        requeuedWorkflow: routeGuard.guardResult?.escalation?.workflow || "complex",
        requeuedPlanMode: routeGuard.guardResult?.escalation?.planMode || "full",
      }));
    }
    const upgraded = await requeueProtectedDiffUpgrade({
      hubRoot,
      entry,
      job,
      projectId,
      sourcePath: canonicalSourcePath,
      issue,
      jobId,
      route: routeGuard.route,
      protectedDiff: routeGuard.protectedDiff,
      guardResult: routeGuard.guardResult,
    });
    if (cpbRoot && projectId) {
      await appendEvent(cpbRoot, projectId, jobId, {
        type: "finalizer_route_guard",
        jobId,
        project: projectId,
        issue,
        originalRoute: routeGuard.route,
        protectedDiff: routeGuard.protectedDiff,
        guardResult: routeGuard.guardResult,
        requeuedQueueEntryId: upgraded?.id || null,
        action: upgraded ? `requeued_${routeGuard.guardResult.escalation?.workflow || "complex"}_${routeGuard.guardResult.escalation?.planMode || "full"}` : "rejected_no_requeue",
        ts: new Date().toISOString(),
      }, { dataRoot });
    }
    return recordAndReturn(reject("ROUTE_PROTECTED_DIFF", {
      issue,
      jobId,
      files: summary.entries,
      protectedDiff: routeGuard.protectedDiff,
      originalRoute: routeGuard.route,
      requeuedQueueEntryId: upgraded?.id || null,
      requeuedWorkflow: upgraded?.metadata?.workflow || "complex",
      requeuedPlanMode: upgraded?.metadata?.planMode || "full",
    }));
  }

  const planned = {
    commit: !dryRun && uncommittedFiles.length > 0,
    merge: !dryRun && (mode === "local" || mode === "remote"),
    push: !dryRun && (mode === "remote" || mode === "pr"),
    closeIssue: !dryRun && mode === "remote",
    pullRequest: !dryRun && mode === "pr",
    pullRequestPreview: dryRun,
  };

  if (mode === "pr" || mode === "dry-run") {
    const jobRecord = finalizerRecord(job);
    if (!cpbRoot || !projectId || !jobRecord.jobId) {
      return recordAndReturn(reject("PR_FINALIZE_REQUIRES_JOB_STORE", { issue, jobId }));
    }
    const jobSourceContext = finalizerRecord(jobRecord.sourceContext);
    const prJob = {
      ...jobRecord,
      worktree: canonicalWorktreePath,
      worktreeBranch: jobRecord.worktreeBranch || worktreeBranch,
      worktreeBaseBranch: jobRecord.worktreeBaseBranch || sourceBranch,
      sourceContext: {
        ...jobSourceContext,
        type: "github_issue",
        repo: issue.repo,
        issueNumber: issue.number,
        issueTitle: jobSourceContext.issueTitle || entry?.metadata?.issueTitle || job.task || null,
      },
    };
    const agents = await resolveAgentsFromEvents(cpbRoot, projectId, job.jobId, { dataRoot });
    let prEvidence: FinalizerRecord = {};
    let prVerdict: FinalizerRecord = {};
    try {
      const bundle = finalizerRecord(await buildReviewBundle(cpbRoot, projectId, job.jobId, {
        entry,
        job: prJob,
        sourcePath: canonicalSourcePath,
        worktreePath: canonicalWorktreePath,
        dataRoot,
      }));
      prVerdict = derivePrVerdictFromBundle(bundle);
      if (!prVerdict.ok) {
        return recordAndReturn(blocked(String(prVerdict.code || "PR_EVIDENCE_BLOCKED"), {
          issue,
          jobId,
          mode,
          completionGate: prVerdict.completionGate || null,
          verdict: prVerdict.verdict || null,
        }));
      }
      prEvidence = buildPrEvidenceFromReviewBundle(bundle, { cpbRoot, dataRoot, hubRoot });
    } catch {
      return recordAndReturn(blocked("PR_EVIDENCE_UNAVAILABLE", {
        issue,
        jobId,
        mode,
      }));
    }
    const prVerdictDetail = isFinalizerRecord(prVerdict.verdictDetail) ? prVerdict.verdictDetail : null;
    const evidenceVerdictDetail = isFinalizerRecord(prEvidence.verdictDetail) ? prEvidence.verdictDetail : null;
    const prOptions: DraftPullRequestOptions = {};
    Object.assign(prOptions, prEvidence);
    Object.assign(prOptions, {
      job: prJob,
      verdict: prVerdict.verdict,
      branchPushed: false,
      dryRun,
      allowLive: liveAllowed,
      createPullRequest,
      runCommand,
      pushToken,
      agents,
      routingContext: buildRoutingContext(entry, job, routeGuard),
      verdictDetail: prVerdictDetail || evidenceVerdictDetail,
      completionGate: prVerdict.completionGate || null,
    });
    const pr = await openDraftPullRequest(prOptions);
    if (dryRun) {
      if (pr.status !== "dry-run") {
        return recordAndReturn(blocked("PR_DRY_RUN_FAILED", {
          issue,
          jobId,
          mode,
          pr,
          error: pr.error || null,
        }));
      }
      return recordAndReturn({
        ok: true,
        status: "dry-run",
        issue,
        mode,
        sourcePath: canonicalSourcePath,
        worktreePath: canonicalWorktreePath,
        sourceBranch,
        worktreeBranch,
        sourceHead,
        worktreeHead,
        files: summary.entries,
        planned,
        completionGate: prVerdict.completionGate || null,
        verdict: prVerdictDetail,
        pr,
      });
    }
    if (pr.status !== "pr.opened") {
      return recordAndReturn(reject("PR_FINALIZE_FAILED", {
        issue,
        jobId,
        pr,
        error: pr.error || null,
      }));
    }

    await appendEvent(cpbRoot, projectId, job.jobId, {
      type: "pr_opened",
      jobId: job.jobId,
      project: projectId,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      artifact: pr.request?.body ? { type: "github_pr", url: pr.prUrl, number: pr.prNumber } : null,
      transportMode: transportMode || null,
      transportFallback: transportMode === "gh",
      ts: new Date().toISOString(),
    }, { dataRoot });

    const commit = pr.branchPreparation?.commit || await revParse(canonicalWorktreePath, "HEAD", { runCommand });
    return recordAndReturn({
      ok: true,
      status: "pr.opened",
      mode,
      issue,
      jobId,
      commit,
      sourcePath: canonicalSourcePath,
      worktreePath: canonicalWorktreePath,
      sourceBranch,
      worktreeBranch: pr.request?.head || prJob.worktreeBranch,
      sourceHead,
      files: summary.entries,
      pushed: true,
      closed: false,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      pr,
    });
  }

  let commit = worktreeHead;
  if (uncommittedFiles.length > 0) {
    await runGit(canonicalWorktreePath, ["add", "--all"], { runCommand });
    await runGit(canonicalWorktreePath, [
      "commit",
      "-m",
      commitMessage({ jobId, issueNumber: issue.number }),
    ], { runCommand });
    commit = await revParse(canonicalWorktreePath, "HEAD", { runCommand });
  }

  let pushed = false;
  let closed = false;
  if (mode === "remote") {
    try {
      await runGit(canonicalWorktreePath, ["push", remote, `${commit}:refs/heads/${sourceBranch}`], { runCommand });
      pushed = true;
      if (issueCloser) {
        await issueCloser({
          repo: issue.repo,
          number: issue.number,
          url: issue.url,
          jobId,
          commit,
        });
        closed = true;
      }
      await runGit(canonicalSourcePath, ["merge", "--ff-only", commit], { runCommand });
    } catch (err) {
      return recordAndReturn(reject("REMOTE_FINALIZE_FAILED", {
        issue,
        jobId,
        commit,
        pushed,
        closed,
        message: commandErrorMessage(err),
      }));
    }
  } else {
    try {
      await runGit(canonicalSourcePath, ["merge", "--ff-only", commit], { runCommand });
    } catch (err) {
      return recordAndReturn(reject("MERGE_FAILED", {
        issue,
        jobId,
        commit,
        message: commandErrorMessage(err),
      }));
    }
  }

  return recordAndReturn({
    ok: true,
    status: "finalized",
    mode,
    issue,
    jobId,
    commit,
    sourcePath: canonicalSourcePath,
    worktreePath: canonicalWorktreePath,
    sourceBranch,
    worktreeBranch,
    sourceHead,
    files: summary.entries,
    pushed,
    closed,
  });

}

// ── Approval gate (from approval-gate.ts) ──────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

export async function requestApprovalGate(
  cpbRoot: string,
  project: string,
  jobId: string,
  { operation, phase, channels = [], reason = "approval required", timeoutAt = null, ts = nowIso(), dataRoot }: ApprovalGateOptions = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "approval_required",
    jobId,
    project,
    operation,
    phase,
    channels,
    reason,
    timeoutAt,
    ts,
  }, { dataRoot });
  return getJob(cpbRoot, project, jobId, { dataRoot });
}

export async function approveGate(
  cpbRoot: string,
  project: string,
  jobId: string,
  { actor = null, action = null, ts = nowIso(), dataRoot }: ApprovalGateOptions = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_approved",
    jobId,
    project,
    actor,
    action,
    ts,
  }, { dataRoot });
  return getJob(cpbRoot, project, jobId, { dataRoot });
}

export async function timeoutApprovalGate(
  cpbRoot: string,
  project: string,
  jobId: string,
  { reason = "approval timed out", ts = nowIso(), dataRoot }: ApprovalGateOptions = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "approval_timed_out",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });

  const { extractExperienceFromTerminalState } = await import("./event/event-source.js");
  const state = await getJob(cpbRoot, project, jobId, { dataRoot });
  await extractExperienceFromTerminalState(cpbRoot, project, jobId, state, "approval_timed_out").catch(() => {});

  return state;
}
