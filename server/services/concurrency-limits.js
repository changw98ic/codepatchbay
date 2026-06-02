import { readHubConfig, readProjectJsonFromRoots } from "./agent-config.js";

export const DEFAULT_MAX_ACTIVE_PER_PROJECT = Number(process.env.CPB_HUB_MAX_ACTIVE_PER_PROJECT || 2);
export const DEFAULT_MAX_ACTIVE_TOTAL = Number(process.env.CPB_HUB_MAX_ACTIVE_TOTAL ?? 0);
export const DEFAULT_ACP_POOL_TOTAL = Number(process.env.CPB_ACP_POOL_TOTAL || 0);
export const DEFAULT_ACP_PROVIDER_MAX = Number(process.env.CPB_ACP_POOL_PROVIDER_MAX || 3);

export function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function maxActiveForProject(project, fallback = DEFAULT_MAX_ACTIVE_PER_PROJECT) {
  return positiveInt(
    project?.concurrency?.maxActivePerProject
      ?? project?.concurrency?.maxActive
      ?? project?.metadata?.maxActivePerProject
      ?? project?.metadata?.maxActive,
    fallback,
  );
}

function hasConfig(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function mergeProjectConfig(registryProject, projectJson) {
  if (!hasConfig(registryProject) && !hasConfig(projectJson)) return null;
  return {
    ...(registryProject || {}),
    ...(projectJson || {}),
    metadata: {
      ...(registryProject?.metadata || {}),
      ...(projectJson?.metadata || {}),
    },
    concurrency: {
      ...(registryProject?.concurrency || {}),
      ...(projectJson?.concurrency || {}),
    },
  };
}

async function defaultGetProject(hubRoot, projectId) {
  const { getProject } = await import("./hub-registry.js");
  return getProject(hubRoot, projectId);
}

export async function readProjectConcurrencyConfig(hubRoot, projectId, getProjectFn = null) {
  if (!projectId) return null;
  const registryProject = await (getProjectFn || defaultGetProject)(hubRoot, projectId).catch(() => null);
  const projectJson = await readProjectJsonFromRoots([hubRoot], projectId).catch(() => ({}));
  return mergeProjectConfig(registryProject, projectJson);
}

export async function resolveProjectConcurrencyLimits(hubRoot, projectIds, {
  maxActivePerProject = DEFAULT_MAX_ACTIVE_PER_PROJECT,
  getProjectFn = null,
} = {}) {
  const fallback = positiveInt(maxActivePerProject, DEFAULT_MAX_ACTIVE_PER_PROJECT);
  const limits = new Map();
  for (const projectId of [...new Set((projectIds || []).filter(Boolean))]) {
    const project = await readProjectConcurrencyConfig(hubRoot, projectId, getProjectFn);
    limits.set(projectId, maxActiveForProject(project, fallback));
  }
  return limits;
}

export async function resolveHubConcurrencyLimits(hubRoot, fallback = {}) {
  const config = await readHubConfig(hubRoot).catch(() => ({}));
  const concurrency = config.concurrency || {};
  const acpPool = config.acpPool || {};
  return {
    maxActivePerProject: positiveInt(
      concurrency.maxActivePerProject ?? fallback.maxActivePerProject,
      DEFAULT_MAX_ACTIVE_PER_PROJECT,
    ),
    maxActiveTotal: nonNegativeInt(
      concurrency.maxActiveTotal ?? fallback.maxActiveTotal,
      DEFAULT_MAX_ACTIVE_TOTAL,
    ),
    acpPoolTotal: nonNegativeInt(
      acpPool.total ?? fallback.acpPoolTotal,
      DEFAULT_ACP_POOL_TOTAL,
    ),
    acpProviderMax: positiveInt(
      acpPool.providerMax ?? fallback.acpProviderMax,
      DEFAULT_ACP_PROVIDER_MAX,
    ),
  };
}

export function hubConcurrencyEnv(limits = {}) {
  const env = {};
  if (limits.maxActivePerProject) env.CPB_HUB_MAX_ACTIVE_PER_PROJECT = String(limits.maxActivePerProject);
  if (limits.maxActiveTotal !== undefined && limits.maxActiveTotal !== null) {
    env.CPB_HUB_MAX_ACTIVE_TOTAL = String(limits.maxActiveTotal);
  }
  if (limits.acpPoolTotal !== undefined && limits.acpPoolTotal !== null) {
    env.CPB_ACP_POOL_TOTAL = String(limits.acpPoolTotal);
  }
  if (limits.acpProviderMax) env.CPB_ACP_POOL_PROVIDER_MAX = String(limits.acpProviderMax);
  return env;
}
