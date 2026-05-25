import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  parentPlanRecordPath,
  readParentPlanRecord,
  writeParentPlanRecord,
} from "./plan-store.js";

function stablePayload({ project, task, sourceContext = {} } = {}) {
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
    },
  };
}

function hashPayload(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function planArtifactPath(cpbRoot, project, planArtifact) {
  const artifact = String(planArtifact || "").replace(/^plan-/, "");
  return path.join(path.resolve(cpbRoot), "wiki", "projects", project, "inbox", `plan-${artifact}.md`);
}

async function artifactExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export function parentPlanCacheIdentity({ project, task, sourceContext = {} } = {}) {
  const payload = stablePayload({ project, task, sourceContext });
  const digest = hashPayload(payload);
  return {
    planGroupId: `plan-group-${digest.slice(0, 12)}`,
    planCacheKey: digest.slice(0, 16),
    payload,
  };
}

export async function resolveParentPlanCache(cpbRoot, { project, task, sourceContext = {} } = {}) {
  const identity = parentPlanCacheIdentity({ project, task, sourceContext });
  const file = parentPlanRecordPath(cpbRoot, project, identity.planCacheKey);
  const cached = await readParentPlanRecord(cpbRoot, project, identity.planCacheKey);

  const planId = cached?.parentPlanId || cached?.planId || null;
  const planArtifact = cached?.planArtifact || (planId ? `plan-${planId}` : null);
  const artifactPath = planArtifact ? planArtifactPath(cpbRoot, project, planArtifact) : null;
  const cacheHit = Boolean(planId && artifactPath && await artifactExists(artifactPath));

  return {
    schemaVersion: 1,
    source: "parent_plan_cache",
    project,
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
  planGroupId = null,
  planCacheKey = null,
  planId,
  planArtifact = null,
  mergedPlanIds = [],
} = {}) {
  if (!project) throw new Error("project is required");
  if (!planId) throw new Error("planId is required");
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
    planArtifactPath: planArtifactPath(cpbRoot, project, artifact),
    mergedPlanIds: [...new Set([String(planId), ...mergedPlanIds.filter(Boolean).map(String)])],
    payload: identity.payload,
    updatedAt: new Date().toISOString(),
  };
  const stored = await writeParentPlanRecord(cpbRoot, project, identity.planCacheKey, record);
  return {
    ...stored,
    cacheHit: true,
    parentPlanId: record.parentPlanId,
    reusedPlanId: record.planId,
    reusedPlanArtifact: record.planArtifact,
  };
}
