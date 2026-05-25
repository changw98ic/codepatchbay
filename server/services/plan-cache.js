import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";

function stablePayload({ project, task, sourceContext = {} } = {}) {
  return {
    project,
    task: String(task || "").trim().replace(/\s+/g, " "),
    source: {
      repo: sourceContext?.repo || null,
      issueNumber: sourceContext?.issueNumber ?? null,
      issueUrl: sourceContext?.issueUrl || null,
      sddTraceId: sourceContext?.sddTrace?.traceId || null,
    },
  };
}

function hashPayload(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function cacheDir(cpbRoot, project) {
  return runtimeDataPath(cpbRoot, "plan-cache", project);
}

function cachePath(cpbRoot, project, planCacheKey) {
  return path.join(cacheDir(cpbRoot, project), `${planCacheKey}.json`);
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
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
  const file = cachePath(cpbRoot, project, identity.planCacheKey);
  let cached = null;
  try {
    cached = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const planId = cached?.planId || null;
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
    planId: String(planId),
    planArtifact: artifact,
    planArtifactPath: planArtifactPath(cpbRoot, project, artifact),
    mergedPlanIds: [...new Set([String(planId), ...mergedPlanIds.filter(Boolean).map(String)])],
    payload: identity.payload,
    updatedAt: new Date().toISOString(),
  };
  const file = cachePath(cpbRoot, project, identity.planCacheKey);
  await writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  return {
    ...record,
    cachePath: file,
    cacheHit: true,
    reusedPlanId: record.planId,
    reusedPlanArtifact: record.planArtifact,
  };
}
