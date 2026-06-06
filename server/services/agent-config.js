import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Agent config service — reads hub-level and project-level agent/variant config.
 *
 * Merge priority: queue metadata > project config > hub config > hardcoded fallback
 */

const HUB_CONFIG_FILE = "config.json";

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeHubConfig(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const removedHubTotalKey = ["maxActive", "Total"].join("");
  const next = { ...data };
  if (next.concurrency && typeof next.concurrency === "object" && !Array.isArray(next.concurrency)) {
    next.concurrency = { ...next.concurrency };
    delete next.concurrency[removedHubTotalKey];
    if (Object.keys(next.concurrency).length === 0) delete next.concurrency;
  }
  if (next.acpPool && typeof next.acpPool === "object" && !Array.isArray(next.acpPool)) {
    next.acpPool = { ...next.acpPool };
    delete next.acpPool.total;
    if (Object.keys(next.acpPool).length === 0) delete next.acpPool;
  }
  if (next.scheduler && typeof next.scheduler === "object" && !Array.isArray(next.scheduler)) {
    next.scheduler = { ...next.scheduler };
  } else {
    delete next.scheduler;
  }
  return next;
}

const VALID_SCHEDULER_MODES = new Set(["default", "smart"]);

export function isValidSchedulerMode(mode) {
  return VALID_SCHEDULER_MODES.has(mode);
}

export function readSchedulerConfig(hubConfig) {
  const scheduler = hubConfig?.scheduler;
  if (!scheduler || typeof scheduler !== "object") return { mode: "default" };
  const mode = VALID_SCHEDULER_MODES.has(scheduler.mode) ? scheduler.mode : "default";
  return { mode };
}

// ── Hub config (~/.cpb/config.json) ──

export async function readHubConfig(hubRoot) {
  return normalizeHubConfig(await readJson(path.join(hubRoot, HUB_CONFIG_FILE)));
}

export async function writeHubConfig(hubRoot, data) {
  await writeJson(path.join(hubRoot, HUB_CONFIG_FILE), normalizeHubConfig(data));
}

// ── Project config (wiki/projects/{id}/project.json → agents) ──

function projectConfigPath(root, project) {
  return path.join(root, "wiki", "projects", project, "project.json");
}

function uniqueRoots(roots) {
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    if (!root) continue;
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

export async function readProjectJson(cpbRoot, project) {
  return readJson(projectConfigPath(cpbRoot, project));
}

export async function readProjectJsonFromRoots(roots, project) {
  for (const root of uniqueRoots(roots)) {
    const data = await readProjectJson(root, project);
    if (data && Object.keys(data).length > 0) return data;
  }
  return {};
}

export async function writeProjectJson(cpbRoot, project, data) {
  await writeJson(projectConfigPath(cpbRoot, project), data);
}

export async function readProjectConfig(cpbRoot, project) {
  const data = await readProjectJson(cpbRoot, project);
  return data.agents || null;
}

export async function readProjectConfigFromRoots(roots, project) {
  for (const root of uniqueRoots(roots)) {
    const agents = await readProjectConfig(root, project);
    if (agents && Object.keys(agents).length > 0) return agents;
  }
  return null;
}

export async function writeProjectAgents(cpbRoot, project, agents) {
  const data = await readProjectJson(cpbRoot, project);
  if (agents && Object.keys(agents).length > 0) {
    data.agents = agents;
  } else {
    delete data.agents;
  }
  await writeProjectJson(cpbRoot, project, data);
}

// ── Merge: resolve effective agents config ──

export function normalizeAgentSpec(raw) {
  if (!raw) return null;
  if (typeof raw === "object" && raw !== null) {
    // Explicit variant-only: { agent: null, variant: "chatgpt" }
    if (raw.agent === null && raw.variant) {
      return { agent: null, variant: raw.variant };
    }
    const agentStr = raw.agent || "";
    if (agentStr.includes(":")) {
      const [agent, variant] = agentStr.split(":", 2);
      return { agent, variant: variant || raw.variant || null };
    }
    return { agent: agentStr || "claude", variant: raw.variant || null };
  }
  // String: "claude", "claude:mimo", "codex"
  const colonIdx = String(raw).indexOf(":");
  if (colonIdx >= 0) {
    return { agent: String(raw).slice(0, colonIdx), variant: String(raw).slice(colonIdx + 1) || null };
  }
  return { agent: String(raw), variant: null };
}

function resolveFromConfig(config) {
  if (!config) return {};
  const result = {};
  const defaultSpec = normalizeAgentSpec(config.default);
  if (defaultSpec) result.default = defaultSpec;

  if (config.phases) {
    for (const [phase, raw] of Object.entries(config.phases)) {
      const spec = normalizeAgentSpec(raw);
      if (spec) {
        if (config.variants?.[phase] && !spec.variant) {
          spec.variant = config.variants[phase];
        }
        result[phase] = spec;
      }
    }
  }

  // Standalone variants (no matching phase entry) — create variant-only entries
  if (config.variants) {
    for (const [phase, variant] of Object.entries(config.variants)) {
      if (variant && !result[phase]) {
        result[phase] = { agent: null, variant };
      }
    }
  }

  // Also check phaseProfiles for variant info (legacy compat)
  if (config.phaseProfiles) {
    for (const [phase, profile] of Object.entries(config.phaseProfiles)) {
      if (result[phase] && profile) {
        result[phase].profile = profile;
      }
    }
  }

  return result;
}

const PHASE_TO_ROLE = {
  plan: "planner",
  execute: "executor",
  verify: "verifier",
  review: "reviewer",
  remediate: "remediator",
};

/**
 * Merge agents config from hub config, project config, and metadata.
 * Returns { planner, executor, verifier, reviewer } objects with { agent, variant }.
 * Later sources override earlier ones.
 */
export function mergeAgentConfig(hubAgents, projectAgents, metadataAgents) {
  const merged = {};

  function applyResolved(resolved, overrideDefault) {
    if (resolved.default) {
      for (const role of ["planner", "executor", "verifier", "reviewer"]) {
        if (overrideDefault || !merged[role]) merged[role] = { ...resolved.default };
      }
    }
    for (const [phase, spec] of Object.entries(resolved)) {
      if (phase === "default") continue;
      const role = PHASE_TO_ROLE[phase] || phase;
      if (spec.agent === null && merged[role]) {
        // Standalone variant — only override variant, keep existing agent
        merged[role] = { ...merged[role], variant: spec.variant };
      } else {
        merged[role] = { ...spec };
      }
    }
  }

  // 1. Hub config defaults
  applyResolved(resolveFromConfig(hubAgents), true);

  // 2. Project config overrides
  applyResolved(resolveFromConfig(projectAgents), false);

  // 3. Queue metadata overrides (highest priority)
  if (metadataAgents) {
    if (typeof metadataAgents === "object" && !metadataAgents.agent) {
      // Per-role object: { planner: { agent: "...", variant: "..." }, ... }
      for (const [key, raw] of Object.entries(metadataAgents)) {
        if (key === "default") continue;
        const spec = normalizeAgentSpec(raw);
        if (spec) {
          const role = PHASE_TO_ROLE[key] || key;
          if (spec.agent === null && merged[role]) {
            // Variant-only metadata — preserve existing agent, override variant
            merged[role] = { ...merged[role], variant: spec.variant };
          } else {
            merged[role] = spec;
          }
        }
      }
    } else {
      // Single spec (string or object with .agent)
      const metaSpec = normalizeAgentSpec(metadataAgents);
      if (metaSpec) {
        for (const role of ["planner", "executor", "verifier", "reviewer"]) {
          merged[role] = { ...metaSpec };
        }
      }
    }
  }

  return merged;
}

/**
 * Build the `agents` object for queue entry metadata from config.
 * Called at enqueue time.
 */
export async function resolveAgentsForEntry(hubRoot, cpbRoot, project, metadata = {}) {
  const hubConfig = await readHubConfig(hubRoot);
  const projectAgents = await readProjectConfigFromRoots(
    [hubRoot, process.env.CPB_ROOT, cpbRoot],
    project,
  );

  const merged = mergeAgentConfig(
    hubConfig.agents,
    projectAgents,
    metadata.agents || null,
  );

  // If metadata.agent is a string, it's a global override already handled by mergeAgentConfig
  // Otherwise, use the merged result
  if (Object.keys(merged).length === 0 && !metadata.agent) return metadata;

  return {
    ...metadata,
    agents: Object.keys(merged).length > 0 ? merged : undefined,
    agent: metadata.agent || undefined,
  };
}
