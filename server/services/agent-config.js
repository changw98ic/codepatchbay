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

// ── Hub config (~/.cpb/config.json) ──

export async function readHubConfig(hubRoot) {
  return readJson(path.join(hubRoot, HUB_CONFIG_FILE));
}

export async function writeHubConfig(hubRoot, data) {
  await writeJson(path.join(hubRoot, HUB_CONFIG_FILE), data);
}

// ── Project config (wiki/projects/{id}/project.json → agents) ──

export async function readProjectConfig(cpbRoot, project) {
  const filePath = path.join(cpbRoot, "wiki", "projects", project, "project.json");
  const data = await readJson(filePath);
  return data.agents || null;
}

export async function writeProjectAgents(cpbRoot, project, agents) {
  const filePath = path.join(cpbRoot, "wiki", "projects", project, "project.json");
  const data = await readJson(filePath);
  if (agents && Object.keys(agents).length > 0) {
    data.agents = agents;
  } else {
    delete data.agents;
  }
  await writeJson(filePath, data);
}

// ── Merge: resolve effective agents config ──

export function normalizeAgentSpec(raw) {
  if (!raw) return null;
  if (typeof raw === "object" && raw !== null) {
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
  repair: "repairer",
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
          merged[role] = spec;
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
  const projectAgents = await readProjectConfig(cpbRoot, project);

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
