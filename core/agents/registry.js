import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DESCRIPTORS_DIR = path.join(import.meta.dirname, "descriptors");

const _registry = new Map();
let _loaded = false;

function validateDescriptor(d) {
  if (!d || typeof d !== "object") return false;
  if (typeof d.name !== "string" || !d.name) return false;
  if (typeof d.command !== "string" || !d.command) return false;
  return true;
}

async function loadBuiltinDescriptors() {
  let files;
  try {
    files = await readdir(DESCRIPTORS_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(DESCRIPTORS_DIR, f), "utf8");
      const d = JSON.parse(raw);
      if (validateDescriptor(d)) {
        _registry.set(d.name, d);
      }
    } catch {
      // Skip invalid descriptors
    }
  }
}

async function loadUserDescriptors(configDir) {
  const dir = configDir || process.env.CPB_AGENTS_CONFIG_DIR;
  if (!dir) return;
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(dir, f), "utf8");
      const d = JSON.parse(raw);
      if (validateDescriptor(d)) {
        _registry.set(d.name, d);
      }
    } catch {
      // Skip invalid descriptors
    }
  }
}

export async function loadRegistry(configDir) {
  if (_loaded && !configDir) return;
  _registry.clear();
  await loadBuiltinDescriptors();
  await loadUserDescriptors(configDir);
  _loaded = true;
}

function ensureLoaded() {
  if (!_loaded) {
    throw new Error("Agent registry not loaded. Call loadRegistry() first.");
  }
}

export function listAgents() {
  ensureLoaded();
  return [..._registry.values()];
}

export function listAgentNames() {
  ensureLoaded();
  return [..._registry.keys()];
}

export function hasAgent(name) {
  ensureLoaded();
  return _registry.has(name);
}

export function getDescriptor(name) {
  ensureLoaded();
  return _registry.get(name) || null;
}

/**
 * Resolve the command and args for a given agent name.
 * Checks env overrides first (CPB_ACP_{PREFIX}_COMMAND / _ARGS),
 * then tries the descriptor's primary command, then falls back.
 */
export function resolveAgentCommand(name) {
  const d = getDescriptor(name);
  if (!d) return null;

  const prefix = d.envPrefix;

  // Env override: full command
  const envCommand = process.env[`${prefix}_COMMAND`];
  if (envCommand) {
    const envArgs = process.env[`${prefix}_ARGS`];
    return {
      command: envCommand,
      args: envArgs ? envArgs.split(" ") : [],
      source: "env",
    };
  }

  return {
    command: d.command,
    args: d.args || [],
    fallbackCommand: d.fallbackCommand || null,
    fallbackArgs: d.fallbackArgs || [],
    source: "descriptor",
  };
}

/**
 * Default agent for a given role, based on descriptor defaultRoles.
 * Falls back to legacy mapping: planner/verifier/reviewer -> codex, executor/repairer -> claude.
 */
export function defaultAgentForRole(role) {
  ensureLoaded();
  for (const d of _registry.values()) {
    if (d.defaultRoles && d.defaultRoles.includes(role)) {
      return d.name;
    }
  }
  // Legacy fallback
  const CODEX_ROLES = new Set(["planner", "verifier", "reviewer"]);
  if (CODEX_ROLES.has(role)) return "codex";
  return "claude";
}

/**
 * Get all agents that support a given capability (plan, execute, verify, review).
 */
export function agentsWithCapability(capability) {
  ensureLoaded();
  return [..._registry.values()].filter(
    (d) => d.capabilities && d.capabilities.includes(capability),
  );
}

/**
 * Check if an agent is considered stable.
 */
export function isAgentStable(name) {
  const d = getDescriptor(name);
  return d ? d.stability === "stable" : false;
}

/**
 * Get pool limit for a given agent from env or descriptor.
 */
export function poolLimitForAgent(name) {
  const d = getDescriptor(name);
  if (!d) return 0;
  const envKey = `CPB_ACP_POOL_${name.toUpperCase()}`;
  return Number(process.env[envKey]) || d.poolLimit || 2;
}

/**
 * Legacy default mapping: phase -> agent.
 * Used when no explicit --agent is specified.
 */
export function legacyAgentForPhase(phase) {
  switch (phase) {
    case "plan":
    case "verify":
    case "review":
      return "codex";
    case "execute":
    case "repair":
      return "claude";
    default:
      return "codex";
  }
}
