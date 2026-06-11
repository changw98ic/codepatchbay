import { createHash } from "node:crypto";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import {
  parentPlanRecordPath,
  readParentPlanRecord,
  writeParentPlanRecord,
} from "./plan-store.js";
import { listJobsFromIndex } from "./jobs-index.js";
import { resolveProjectDataRoot } from "./runtime-context.js";

const PARENT_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type AnyRecord = Record<string, any>;

function normalizeWords(text = "") {
  return text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
}

function wordOverlap(a, b) {
  const sa = new Set(normalizeWords(a));
  const sb = new Set(normalizeWords(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  return common / Math.min(sa.size, sb.size);
}

async function planFileExists(cpbRoot, project, planId, { dataRoot }: AnyRecord = {}) {
  try {
    if (!dataRoot) throw new Error("project runtime root required for parent plan artifact lookup");
    const wikiDir = path.join(dataRoot, "wiki");
    await access(path.join(wikiDir, "inbox", `plan-${planId}.md`));
    return true;
  } catch {
    return false;
  }
}

function stablePayload({ project, task, sourceContext = {} }: AnyRecord = {}) {
  const planGroupId = sourceContext?.planGroupId || sourceContext?.sddTask?.planGroupId || null;
  if (planGroupId) {
    return {
      project,
      planGroupId,
      source: {
        repo: sourceContext?.repo || null,
        issueNumber: sourceContext?.issueNumber ?? null,
      },
    };
  }
  return {
    project,
    task: String(task || "").trim().replace(/\s+/g, " "),
    source: {
      repo: sourceContext?.repo || null,
      issueNumber: sourceContext?.issueNumber ?? null,
      issueUrl: sourceContext?.issueUrl || null,
      sddTraceId: sourceContext?.sddTrace?.traceId || null,
      sourceFingerprint: sourceContext?.sourceFingerprint || null,
      specHash: sourceContext?.specHash || sourceContext?.sddTrace?.hashes?.spec || null,
      designHash: sourceContext?.designHash || sourceContext?.sddTrace?.hashes?.design || null,
      tasksHash: sourceContext?.tasksHash || sourceContext?.sddTrace?.hashes?.tasks || null,
      taskId: sourceContext?.sddTask?.id || sourceContext?.taskId || null,
      parentPlanId: sourceContext?.parentPlanId || sourceContext?.sddTask?.parentPlanId || null,
    },
  };
}

function explicitParentPlanId(sourceContext: AnyRecord = {}) {
  const value = sourceContext?.parentPlanId || sourceContext?.sddTask?.parentPlanId || null;
  return value ? String(value).replace(/^plan-/, "") : null;
}

function hashPayload(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function planArtifactPath(cpbRoot, project, planArtifact, { dataRoot }: AnyRecord = {}) {
  if (!dataRoot) throw new Error("project runtime root required for parent plan artifact path");
  const artifact = String(planArtifact || "").replace(/^plan-/, "");
  return path.join(path.resolve(dataRoot), "wiki", "inbox", `plan-${artifact}.md`);
}

async function artifactExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export function parentPlanCacheIdentity({ project, task, sourceContext = {} }: AnyRecord = {}) {
  const payload = stablePayload({ project, task, sourceContext });
  const digest = hashPayload(payload);
  return {
    planGroupId: `plan-group-${digest.slice(0, 12)}`,
    planCacheKey: digest.slice(0, 16),
    payload,
  };
}

async function resolvePlanCacheDataRoot(cpbRoot, project, { dataRoot, hubRoot }: AnyRecord = {}) {
  return await resolveProjectDataRoot(cpbRoot, project, { dataRoot, hubRoot });
}

export async function resolveParentPlanCache(cpbRoot, { project, task, sourceContext = {}, dataRoot, hubRoot }: AnyRecord = {}) {
  if (!project) throw new Error("project is required");
  const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, project, { dataRoot, hubRoot });
  const identity = parentPlanCacheIdentity({ project, task, sourceContext });
  const file = parentPlanRecordPath(cpbRoot, project, identity.planCacheKey, { dataRoot: resolvedDataRoot });
  const cached = await readParentPlanRecord(cpbRoot, project, identity.planCacheKey, { dataRoot: resolvedDataRoot });

  const explicitPlanId = explicitParentPlanId(sourceContext);
  const planId = cached?.parentPlanId || cached?.planId || explicitPlanId || null;
  const planArtifact = cached?.planArtifact || (planId ? `plan-${planId}` : null);
  const artifactPath = planArtifact ? planArtifactPath(cpbRoot, project, planArtifact, { dataRoot: resolvedDataRoot }) : null;
  const cacheHit = Boolean(planId && artifactPath && await artifactExists(artifactPath));

  return {
    schemaVersion: 1,
    source: "parent_plan_cache",
    project,
    dataRoot: resolvedDataRoot,
    task,
    ...identity,
    cachePath: file,
    cacheHit,
    parentPlanId: cacheHit ? planId : null,
    reusedPlanId: cacheHit ? planId : null,
    reusedPlanArtifact: cacheHit ? planArtifact : null,
    mergedPlanIds: cacheHit ? [...new Set([planId, ...(cached?.mergedPlanIds || [])])] : [],
    stale: Boolean(cached && !cacheHit),
    cachedAt: cached?.updatedAt || null,
  };
}

export async function writeParentPlanCache(cpbRoot, {
  project,
  task,
  sourceContext = {},
  dataRoot,
  hubRoot,
  planGroupId = null,
  planCacheKey = null,
  planId,
  planArtifact = null,
  mergedPlanIds = [],
}: AnyRecord = {}) {
  if (!project) throw new Error("project is required");
  if (!planId) throw new Error("planId is required");
  const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, project, { dataRoot, hubRoot });
  const identity = planCacheKey && planGroupId
    ? { planGroupId, planCacheKey, payload: stablePayload({ project, task, sourceContext }) }
    : parentPlanCacheIdentity({ project, task, sourceContext });
  const artifact = planArtifact || `plan-${planId}`;
  const record = {
    schemaVersion: 1,
    source: "parent_plan_cache",
    project,
    task,
    planGroupId: identity.planGroupId,
    planCacheKey: identity.planCacheKey,
    parentPlanId: String(planId),
    planId: String(planId),
    planArtifact: artifact,
    planArtifactPath: planArtifactPath(cpbRoot, project, artifact, { dataRoot: resolvedDataRoot }),
    mergedPlanIds: [...new Set([String(planId), ...mergedPlanIds.filter(Boolean).map(String)])],
    payload: identity.payload,
    updatedAt: new Date().toISOString(),
  };
  const stored = await writeParentPlanRecord(cpbRoot, project, identity.planCacheKey, record, { dataRoot: resolvedDataRoot });
  return {
    ...stored,
    dataRoot: resolvedDataRoot,
    cacheHit: true,
    planCacheKey: record.planCacheKey,
    parentPlanId: record.parentPlanId,
    reusedPlanId: record.planId,
    reusedPlanArtifact: record.planArtifact,
  };
}

function hitResult(identity: AnyRecord, { source, planId, artifact, parentJobId = null, cachedAt = null }: AnyRecord) {
  return {
    schemaVersion: 2,
    cacheHit: true,
    source,
    project: identity.payload.project,
    task: identity.payload.task,
    ...identity,
    parentPlanId: planId,
    reusedPlanId: planId,
    reusedPlanArtifact: artifact,
    mergedPlanIds: [planId],
    parentJobId,
    stale: false,
    cachedAt,
  };
}

function missResult(identity: AnyRecord, stale = false, cachedAt = null) {
  return {
    schemaVersion: 2,
    cacheHit: false,
    source: null,
    project: identity.payload.project,
    task: identity.payload.task,
    ...identity,
    parentPlanId: null,
    reusedPlanId: null,
    reusedPlanArtifact: null,
    mergedPlanIds: [],
    parentJobId: null,
    stale,
    cachedAt,
  };
}

async function findJobIndexHit(cpbRoot, project, { sourceContext, task, dataRoot }: AnyRecord = {}) {
  const allJobs = await listJobsFromIndex(cpbRoot, { dataRoot });
  const cutoff = Date.now() - PARENT_PLAN_MAX_AGE_MS;
  const candidates = (allJobs as AnyRecord[])
    .filter((j) => j.project === project)
    .filter((j) => j.completedPhases?.includes("plan"))
    .filter((j) => j.artifacts?.plan)
    .filter((j) => j.status !== "cancelled")
    .filter((j) => {
      const t = new Date(j.updatedAt || j.createdAt).getTime();
      return !Number.isNaN(t) && t >= cutoff;
    })
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  if (candidates.length === 0) return null;

  const issueNumber = sourceContext?.issueNumber;
  if (issueNumber) {
    for (const job of candidates) {
      const jobIssue = job.sourceContext?.issueNumber;
      if (jobIssue && String(jobIssue) === String(issueNumber)) {
        const planId = job.artifacts.plan.replace(/^plan-/, "");
        if (await planFileExists(cpbRoot, project, planId, { dataRoot })) {
          return { planId, parentJobId: job.jobId, source: "same_issue" };
        }
      }
    }
  }

  for (const job of candidates) {
    const overlap = wordOverlap(task || "", job.task || "");
    if (overlap >= 0.5) {
      const planId = job.artifacts.plan.replace(/^plan-/, "");
      if (await planFileExists(cpbRoot, project, planId, { dataRoot })) {
        return { planId, parentJobId: job.jobId, source: "task_overlap" };
      }
    }
  }

  return null;
}

export async function resolveParentPlan(cpbRoot, { project, task, sourceContext = {}, dataRoot, hubRoot }: AnyRecord = {}) {
  if (!project) throw new Error("project is required");
  const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, project, { dataRoot, hubRoot });
  const identity = parentPlanCacheIdentity({ project, task, sourceContext });

  // Priority 1: explicit parentPlanId from sourceContext
  const explicitPlanId = explicitParentPlanId(sourceContext);
  if (explicitPlanId) {
    const artifact = `plan-${explicitPlanId}`;
    if (await planFileExists(cpbRoot, project, explicitPlanId, { dataRoot: resolvedDataRoot })) {
      return hitResult(identity, { source: "explicit", planId: explicitPlanId, artifact });
    }
  }

  // Priority 2: plan cache record
  const cached = await readParentPlanRecord(cpbRoot, project, identity.planCacheKey, { dataRoot: resolvedDataRoot });
  const cachedPlanId = cached?.parentPlanId || cached?.planId || null;
  if (cachedPlanId) {
    const artifact = cached?.planArtifact || `plan-${cachedPlanId}`;
    if (await planFileExists(cpbRoot, project, cachedPlanId, { dataRoot: resolvedDataRoot })) {
      return hitResult(identity, {
        source: "cache",
        planId: cachedPlanId,
        artifact,
        cachedAt: cached?.updatedAt || null,
      });
    }
  }

  // Priority 3 & 4: same issue / task overlap from jobs index
  const indexHit = await findJobIndexHit(cpbRoot, project, { sourceContext, task, dataRoot: resolvedDataRoot });
  if (indexHit) {
    const artifact = `plan-${indexHit.planId}`;
    return hitResult(identity, {
      source: indexHit.source,
      planId: indexHit.planId,
      artifact,
      parentJobId: indexHit.parentJobId,
    });
  }

  return missResult(identity, Boolean(cached), cached?.updatedAt || null);
}
