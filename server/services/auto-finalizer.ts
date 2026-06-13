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
import { getJob } from "./job/job-store.js";
import { openDraftPullRequest } from "./github/github-issues.js";
import { enqueue as enqueueHubQueue, updateEntry as updateHubQueueEntry } from "./hub/hub-queue.js";
import { actualDiffRiskGuard } from "../../core/triage/rules.js";
import { normalizeRoute, scopesContainCritical } from "../../core/triage/schema.js";
import { buildReviewBundle, writeReviewBundle, reviewBundleDir } from "./review/review-session.js";

const execFileAsync = promisify(execFile);

const PHASE_ROLE_MAP = { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", remediate: "remediator" };

async function resolveAgentsFromEvents(cpbRoot: string, projectId: string, jobId: string, { dataRoot }: Record<string, any> = {}) {
  try {
    const events = await readEvents(cpbRoot, projectId, jobId, { dataRoot });
    const agents = {};
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

async function runGit(cwd: string, args: string[], { allowFailure = false, runCommand = execFileAsync }: Record<string, any> = {}) {
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
    return {
      stdout: err?.stdout || "",
      stderr: err?.stderr || err?.message || "",
      exitCode: Number.isInteger(err?.code) ? err.code : 1,
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

async function isGitRepo(repoPath: string, { runCommand }: Record<string, any> = {}) {
  const result = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"], {
    allowFailure: true,
    runCommand,
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function assertClean(repoPath: string, { runCommand }: Record<string, any> = {}) {
  const status = await runGit(repoPath, ["status", "--porcelain"], { runCommand });
  return status.stdout.trim() === "";
}

async function autoStash(repoPath: string, { runCommand }: Record<string, any> = {}) {
  try {
    await runGit(repoPath, ["stash", "push", "--include-untracked", "-m", "cpb-auto-stash"], { runCommand });
    return true;
  } catch {
    return false;
  }
}

async function stashPop(repoPath: string, { runCommand }: Record<string, any> = {}) {
  try {
    await runGit(repoPath, ["stash", "pop"], { runCommand, allowFailure: true });
  } catch { /* ignore */ }
}

async function currentBranch(repoPath: string, { runCommand }: Record<string, any> = {}) {
  return (await runGit(repoPath, ["branch", "--show-current"], { runCommand })).stdout.trim();
}

async function revParse(repoPath: string, ref = "HEAD", { runCommand }: Record<string, any> = {}) {
  return (await runGit(repoPath, ["rev-parse", "--verify", ref], { runCommand })).stdout.trim();
}

async function diffFiles(repoPath: string, fromRef: string, toRef: string, { runCommand }: Record<string, any> = {}) {
  const result = await runGit(repoPath, ["diff", "--name-only", "-z", fromRef, toRef], { runCommand });
  return splitNul(result.stdout);
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string, { runCommand }: Record<string, any> = {}) {
  const result = await runGit(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
    runCommand,
  });
  return result.exitCode === 0;
}

function reject(code: string, details: Record<string, any> = {}) {
  return {
    ok: false,
    status: "rejected",
    code,
    jobId: details.jobId ?? null,
    ...details,
  };
}

function skipped(code: string, details: Record<string, any> = {}) {
  return {
    ok: false,
    status: "skipped",
    code,
    jobId: details.jobId ?? null,
    ...details,
  };
}

function parseIssueUrl(issueUrl: unknown) {
  if (!issueUrl) return null;
  const match = String(issueUrl).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/);
  if (!match) return null;
  return {
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`,
  };
}

function resolveIssue(metadata: Record<string, any> = {}) {
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

function splitNul(value: unknown) {
  return String(value || "").split("\0").filter(Boolean);
}

async function changedWorktreeFiles(worktreePath: string, { runCommand }: Record<string, any> = {}) {
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

function hasUnsafeChanges(summary: any) {
  return (
    summary.counts[MERGE_CLASSIFICATION.SHARED_STATE] > 0
    || summary.counts[MERGE_CLASSIFICATION.NEEDS_HUMAN] > 0
  );
}

function unsafeFiles(summary: any) {
  return summary.entries.filter((entry) => (
    entry.classification === MERGE_CLASSIFICATION.SHARED_STATE
    || entry.classification === MERGE_CLASSIFICATION.NEEDS_HUMAN
  ));
}

function routingEffectiveRoute(entry: Record<string, any> = {}, job: Record<string, any> = {}) {
  const metadata = entry?.metadata || {};
  const routing = metadata.routing || {};
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

function routeAllowsProtectedDiff(route: any, protectedScopes: any[] = []) {
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

function protectedDiffForRoute(files: string[], entry: any, job: any) {
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
}: Record<string, any> = {}) {
  if (!hubRoot || !entry?.id || !projectId) return null;
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
  const metadata = {
    ...(entry.metadata || {}),
    workflow: upgradeRoute.workflow,
    planMode: upgradeRoute.planMode,
    requestedRoute: upgradeRoute,
    routing: {
      ...(entry.metadata?.routing || {}),
      effective: upgradeRoute,
      effectiveRoute: upgradeRoute,
      protectedUpgrade: true,
      protectedScopes: protectedDiff.protectedScopes,
      actualDiffRisk: protectedDiff.actualDiffRisk,
      reasons: [
        ...new Set([
          ...((entry.metadata?.routing || {}).reasons || []),
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
  };

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

function buildRoutingContext(entry: any, job: any, routeGuard: any = null) {
  const metadata = entry?.metadata || {};
  const routing = metadata.routing || {};
  let finalDiffGuard = null;
  if (routeGuard) {
    finalDiffGuard = {
      passed: !routeGuard.blocked,
      protectedScopes: routeGuard.protectedDiff?.protectedScopes || [],
      guardResult: routeGuard.guardResult,
      route: routeGuard.route,
    };
  } else if (metadata.finalDiffGuard) {
    finalDiffGuard = { passed: false, ...metadata.finalDiffGuard };
  }
  return {
    routing,
    planMode: metadata.planMode || job.planMode || null,
    contextPack: metadata.contextPack || null,
    planCache: job?.sourceContext?.parentPlan || metadata.planCache || null,
    finalDiffGuard,
  };
}

function isInsideRoot(root: string, targetPath: string) {
  if (!root || !targetPath || !path.isAbsolute(targetPath)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function displayArtifactPath(artifactPath: any, roots: string[] = []) {
  if (!artifactPath) return null;
  const value = String(artifactPath);
  if (!path.isAbsolute(value)) return value;
  for (const root of roots) {
    if (isInsideRoot(root, value)) return path.relative(path.resolve(root), value);
  }
  return path.basename(value);
}

function artifactIdFromPath(artifactPath: any) {
  const name = path.basename(String(artifactPath || "artifact"));
  return name.replace(/\.(?:md|patch|diff|txt|json)$/i, "") || "artifact";
}

function artifactReferenceFromEntry(entry: any, roots: string[]) {
  if (!entry || entry.broken) return null;
  return {
    id: entry.id || artifactIdFromPath(entry.path),
    path: displayArtifactPath(entry.path, roots),
  };
}

function artifactReferenceForKind(bundle: any, kind: string, roots: string[]) {
  const matches = (bundle?.links?.artifacts || [])
    .filter((entry) => entry?.kind === kind && !entry.broken);
  if (matches.length === 0) return null;
  const entry = kind === "verdict" ? matches[matches.length - 1] : matches[0];
  return artifactReferenceFromEntry(entry, roots);
}

function pushEvidenceLine(lines: string[], value: any) {
  if (Array.isArray(value)) {
    for (const item of value) pushEvidenceLine(lines, item);
    return;
  }
  if (value === null || value === undefined) return;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text) lines.push(text);
}

function testEvidenceFromVerdict(verdict: any) {
  const lines: string[] = [];
  pushEvidenceLine(lines, verdict?.tests);
  pushEvidenceLine(lines, verdict?.basis?.tests);
  if (verdict?.layers && typeof verdict.layers === "object") {
    for (const [name, layer] of Object.entries(verdict.layers) as Array<[string, any]>) {
      if (!layer?.detail) continue;
      pushEvidenceLine(lines, `${name}: ${layer.detail}`);
    }
  }
  return [...new Set(lines)].slice(0, 8);
}

function verdictEvidenceForBody(verdict: any) {
  if (!verdict || typeof verdict !== "object") {
    return { status: "pass", reason: "No structured verdict evidence was found" };
  }
  return {
    ...verdict,
    status: verdict.status || verdict.verdict || "unavailable",
    blockingCount: verdict.blockingCount ?? verdict.blocking?.length ?? verdict.blockingMissingInputs?.length ?? undefined,
  };
}

export function buildPrEvidenceFromReviewBundle(bundle, {
  cpbRoot = null,
  dataRoot = null,
  hubRoot = null,
}: Record<string, any> = {}) {
  const roots = [hubRoot, dataRoot, cpbRoot].filter(Boolean);
  const artifacts = {
    plan: artifactReferenceForKind(bundle, "plan", roots),
    deliverable: artifactReferenceForKind(bundle, "deliverable", roots),
    review: artifactReferenceForKind(bundle, "review", roots),
    verdict: artifactReferenceForKind(bundle, "verdict", roots),
    diff: artifactReferenceForKind(bundle, "diff", roots),
  };
  if (!artifacts.diff && bundle?.evidence?.diffStat) {
    artifacts.diff = {
      id: "worktree-diff",
      path: `${bundle.evidence.changedFiles?.length || 0} changed files`,
    };
  }

  const artifactCount = Array.isArray(bundle?.links?.artifacts) ? bundle.links.artifacts.length : 0;
  return {
    artifacts,
    tests: testEvidenceFromVerdict(bundle?.evidence?.verdict || null),
    audit: {
      eventLog: bundle?.links?.eventLog || null,
      artifactIndex: artifactCount > 0 ? `${artifactCount} artifact references` : null,
    },
    verdictDetail: verdictEvidenceForBody(bundle?.evidence?.verdict || null),
  };
}

function commitMessage({ jobId, issueNumber }: Record<string, any>) {
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
  { runCommand = execFileAsync }: Record<string, any> = {},
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
}: Record<string, any> = {}) {
  try {
    const bundle = await buildReviewBundle(cpbRoot, project, jobId, {
      entry, job, sourcePath,
      worktreePath: job?.worktree || null,
      dataRoot,
    });

    const outputDir = hubRoot ? reviewBundleDir(hubRoot, project, jobId) : (cpbRoot || process.cwd());
    const bundlePath = await writeReviewBundle(outputDir, bundle);

    if (cpbRoot && project) {
      await appendEvent(cpbRoot, project, jobId, {
        type: "review_bundle_created",
        jobId,
        project,
        bundlePath,
        changedFiles: bundle.evidence.changedFiles,
        verdict: bundle.evidence.verdict?.verdict || null,
        ts: new Date().toISOString(),
      }, { dataRoot }).catch(() => {});
    }

    return {
      ok: true,
      status: "review_bundle",
      mode: "review_bundle",
      jobId,
      bundlePath,
      changedFiles: bundle.evidence.changedFiles,
      verdict: bundle.evidence.verdict?.verdict || null,
    };
  } catch (err) {
    return reject("REVIEW_BUNDLE_FAILED", { jobId, error: err.message });
  }
}

export async function finalizeSuccessfulQueueEntry({
  cpbRoot,
  project,
  entry,
  job,
  sourcePath,
  mode = "local",
  remote = "origin",
  issueCloser,
  runCommand = execFileAsync,
  createPullRequest,
  pushToken = null,
  transportMode = null,
  dataRoot,
  hubRoot = null,
}: Record<string, any> = {}) {
  const jobId = job?.jobId || job?.id || entry?.jobId || entry?.id || "unknown";
  const projectId = project || job?.project || entry?.projectId || null;

  if (job?.status !== "completed") {
    return skipped("JOB_NOT_COMPLETED", { jobId });
  }

  const issue = resolveIssue(entry?.metadata);
  if (!issue) {
    return finalizeAsReviewBundle({
      cpbRoot, hubRoot, project: projectId, entry, job, sourcePath,
      jobId, dataRoot,
    });
  }

  if (!job?.worktree || !(await pathExists(job.worktree))) {
    return reject("NO_WORKTREE", { jobId });
  }

  if (!sourcePath || !(await pathExists(sourcePath))) {
    return reject("NO_SOURCE_PATH", { jobId });
  }

  const canonicalSourcePath = await realpath(path.resolve(sourcePath));
  const canonicalWorktreePath = await realpath(path.resolve(job.worktree));

  if (!(await isGitRepo(canonicalSourcePath, { runCommand }))) {
    return reject("SOURCE_NOT_GIT_REPO", { jobId });
  }

  let stashedBeforeFinalize = false;
  if (!(await assertClean(canonicalSourcePath, { runCommand }))) {
    stashedBeforeFinalize = await autoStash(canonicalSourcePath, { runCommand });
    if (!stashedBeforeFinalize) {
      return reject("SOURCE_NOT_CLEAN", { jobId });
    }
  }

  try {

  if (!(await isGitRepo(canonicalWorktreePath, { runCommand }))) {
    return reject("WORKTREE_NOT_GIT_REPO", { jobId });
  }

  const sourceBranch = await currentBranch(canonicalSourcePath, { runCommand });
  if (!sourceBranch) {
    return reject("NO_SOURCE_BRANCH", { issue, jobId });
  }

  const sourceHead = await revParse(canonicalSourcePath, "HEAD", { runCommand });
  const worktreeBranch = await currentBranch(canonicalWorktreePath, { runCommand });
  const worktreeHead = await revParse(canonicalWorktreePath, "HEAD", { runCommand });
  const uncommittedFiles = await changedWorktreeFiles(canonicalWorktreePath, { runCommand });
  let committedFiles = [];
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
          ...(await diffFiles(canonicalWorktreePath, baseCommit, worktreeHead, { runCommand }).catch(() => [])),
        ];
        const conflictInfo = await detectParallelConflict(
          canonicalSourcePath,
          baseCommit,
          worktreeFiles,
          { runCommand },
        ).catch(() => null);

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
          return reject(conflictInfo.conflict ? "PARALLEL_FILE_CONFLICT" : "SOURCE_ADVANCED_NO_CONFLICT", {
            issue,
            jobId,
            originalSourceHead: baseCommit,
            currentSourceHead: conflictInfo.currentHead,
            overlappingFiles: conflictInfo.overlappingFiles,
            interveningFiles: conflictInfo.interveningFiles,
            retryable: true,
          });
        }
      }

      return reject("WORKTREE_NOT_DESCENDANT", {
        issue,
        jobId,
        sourceHead,
        worktreeHead,
      });
    }
    committedFiles = await diffFiles(canonicalWorktreePath, sourceHead, worktreeHead, { runCommand });
  }

  const files = [...new Set([...committedFiles, ...uncommittedFiles])];
  if (files.length === 0) {
    return skipped("NO_CHANGES", { issue, jobId });
  }

  const summary = summarizeMergeFiles(files);
  if (hasUnsafeChanges(summary)) {
    return reject("UNSAFE_WORKTREE_CHANGES", {
      issue,
      jobId,
      files: summary.entries,
      unsafeFiles: unsafeFiles(summary),
    });
  }

  const routeGuard = protectedDiffForRoute(files, entry, job);
  if (routeGuard.blocked) {
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
        action: upgraded ? `requeued_${(routeGuard.guardResult as Record<string, any>).escalation?.workflow || "complex"}_${(routeGuard.guardResult as Record<string, any>).escalation?.planMode || "full"}` : "rejected_no_requeue",
        ts: new Date().toISOString(),
      }, { dataRoot });
    }
    return reject("ROUTE_PROTECTED_DIFF", {
      issue,
      jobId,
      files: summary.entries,
      protectedDiff: routeGuard.protectedDiff,
      originalRoute: routeGuard.route,
      requeuedQueueEntryId: upgraded?.id || null,
      requeuedWorkflow: upgraded?.metadata?.workflow || "complex",
      requeuedPlanMode: upgraded?.metadata?.planMode || "full",
    });
  }

  const planned = {
    commit: uncommittedFiles.length > 0,
    merge: mode === "local" || mode === "remote",
    push: mode === "remote" || mode === "pr",
    closeIssue: mode === "remote",
    pullRequest: mode === "pr",
  };

  if (mode === "dry-run") {
    return {
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
    };
  }

  if (mode !== "local" && mode !== "remote" && mode !== "pr") {
    return reject("UNSUPPORTED_MODE", { mode, jobId });
  }

  if (mode === "pr") {
    if (!cpbRoot || !projectId || !job?.jobId) {
      return reject("PR_FINALIZE_REQUIRES_JOB_STORE", { issue, jobId });
    }
    const prJob = {
      ...job,
      worktree: canonicalWorktreePath,
      worktreeBranch: job.worktreeBranch || worktreeBranch,
      worktreeBaseBranch: job.worktreeBaseBranch || sourceBranch,
      sourceContext: {
        ...(job.sourceContext || {}),
        type: "github_issue",
        repo: issue.repo,
        issueNumber: issue.number,
        issueTitle: job.sourceContext?.issueTitle || entry?.metadata?.issueTitle || job.task || null,
      },
    };
    const agents = await resolveAgentsFromEvents(cpbRoot, projectId, job.jobId, { dataRoot });
    let prEvidence: Record<string, any> = {};
    try {
      const bundle = await buildReviewBundle(cpbRoot, projectId, job.jobId, {
        entry,
        job: prJob,
        sourcePath: canonicalSourcePath,
        worktreePath: canonicalWorktreePath,
        dataRoot,
      });
      prEvidence = buildPrEvidenceFromReviewBundle(bundle, { cpbRoot, dataRoot, hubRoot });
    } catch {
      prEvidence = {};
    }
    const pr = await openDraftPullRequest({
      job: prJob,
      verdict: "PASS",
      branchPushed: false,
      createPullRequest,
      runCommand,
      pushToken,
      agents,
      routingContext: buildRoutingContext(entry, job, routeGuard),
      ...prEvidence,
    });
    if (pr.status !== "pr.opened") {
      return reject("PR_FINALIZE_FAILED", {
        issue,
        jobId,
        pr,
        error: pr.error || null,
      });
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
    return {
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
    };
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
      return reject("REMOTE_FINALIZE_FAILED", {
        issue,
        jobId,
        commit,
        pushed,
        closed,
        message: String(err?.stderr || err?.stdout || err?.message || "").trim(),
      });
    }
  } else {
    try {
      await runGit(canonicalSourcePath, ["merge", "--ff-only", commit], { runCommand });
    } catch (err) {
      return reject("MERGE_FAILED", {
        issue,
        jobId,
        commit,
        message: String(err?.stderr || err?.stdout || err?.message || "").trim(),
      });
    }
  }

  return {
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
  };

  } finally {
    if (stashedBeforeFinalize) {
      await stashPop(canonicalSourcePath, { runCommand });
    }
  }
}

// ── Approval gate (from approval-gate.ts) ──────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

export async function requestApprovalGate(
  cpbRoot: string,
  project: string,
  jobId: string,
  { operation, phase, channels = [], reason = "approval required", timeoutAt = null, ts = nowIso(), dataRoot }: Record<string, any> = {},
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
  { actor = null, action = null, ts = nowIso(), dataRoot }: Record<string, any> = {},
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
  { reason = "approval timed out", ts = nowIso(), dataRoot }: Record<string, any> = {},
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
