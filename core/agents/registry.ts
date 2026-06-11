import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { autoDiscoverAgents } from "./auto-discover.js";

const DESCRIPTORS_DIR = path.join(import.meta.dirname, "descriptors");
const SQUADS_FILE = path.join(import.meta.dirname, "squads.json");

const _registry = new Map<string, any>();
const _discovered = new Map<string, any>();
const _squads = new Map<string, any>();
const _rrCounters = new Map<string, number>(); // round-robin counters per squad
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
  _discovered.clear();
  _squads.clear();
  _rrCounters.clear();
  await loadBuiltinDescriptors();
  await loadUserDescriptors(configDir);

  // Auto-discover installed agents (supplement, don't override)
  try {
    const found = await autoDiscoverAgents();
    for (const d of found) {
      if (!_registry.has(d.name)) {
        _discovered.set(d.name, d);
      }
    }
  } catch {
    // Auto-discovery failure is non-fatal
  }

  // Load squad definitions
  try {
    const raw = await readFile(SQUADS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data.squads && typeof data.squads === "object") {
      for (const [name, squad] of Object.entries(data.squads as Record<string, any>)) {
        if (squad.leader && Array.isArray(squad.members)) {
          _squads.set(name, { ...squad, name });
        }
      }
    }
  } catch {
    // No squads file is fine
  }

  _loaded = true;
}

function ensureLoaded() {
  if (!_loaded) {
    throw new Error("Agent registry not loaded. Call loadRegistry() first.");
  }
}

export function listAgents() {
  ensureLoaded();
  return [..._registry.values(), ..._discovered.values()];
}

export function listAgentNames() {
  ensureLoaded();
  return [..._registry.keys(), ..._discovered.keys()];
}

export function hasAgent(name) {
  ensureLoaded();
  return _registry.has(name) || _discovered.has(name);
}

export function getDescriptor(name) {
  ensureLoaded();
  return _registry.get(name) || _discovered.get(name) || null;
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
 * List only agents with a specific protocol.
 * Useful for pipeline routing: only ACP agents can participate in ACP spawn.
 */
export function listAgentsByProtocol(protocol) {
  ensureLoaded();
  return [..._registry.values(), ..._discovered.values()]
    .filter((d) => (d.protocol || "unknown") === protocol);
}

/**
 * Default agent for a given role, based on descriptor defaultRoles.
 * Prefers ACP-protocol agents for pipeline routing.
 * Falls back to default mapping: planner/verifier/reviewer -> codex, executor/remediator -> claude.
 */
export function defaultAgentForRole(role) {
  ensureLoaded();
  // Prefer registered ACP agents with matching role
  for (const d of _registry.values()) {
    if (d.defaultRoles && d.defaultRoles.includes(role) && (d.protocol || "unknown") === "acp") {
      return d.name;
    }
  }
  // Try any registered agent with matching role
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
    case "remediate":
      return "claude";
    default:
      return "codex";
  }
}

// --- Squad support ---

/**
 * List all defined squads.
 */
export function listSquads() {
  ensureLoaded();
  return [..._squads.values()];
}

/**
 * Get a squad definition by name.
 */
export function getSquad(name) {
  ensureLoaded();
  return _squads.get(name) || null;
}

/**
 * Resolve a squad to a specific agent name based on strategy.
 *
 * Strategies:
 * - "leader-first" (default): return leader if available in registry, else first available member
 * - "round-robin": rotate through members on each call
 * - "least-busy": pick member with lowest active count (requires poolStatus)
 *
 * poolStatus: optional object from AcpPool.status().pools — keyed by agent name,
 * each with { active } field.
 */
export function resolveSquadAgent(squadName, { strategy, poolStatus }: Record<string, any> = {}) {
  ensureLoaded();
  const squad = _squads.get(squadName);
  if (!squad) return null;

  const strat = strategy || squad.strategy || "leader-first";
  const available = squad.members.filter((m) => hasAgent(m));
  if (available.length === 0) return null;

  switch (strat) {
    case "leader-first":
      if (available.includes(squad.leader)) return squad.leader;
      return available[0];

    case "round-robin": {
      const counter = _rrCounters.get(squadName) || 0;
      const agent = available[counter % available.length];
      _rrCounters.set(squadName, counter + 1);
      return agent;
    }

    case "least-busy": {
      if (!poolStatus) {
        // Fallback to leader-first if no pool status
        if (available.includes(squad.leader)) return squad.leader;
        return available[0];
      }
      let best = available[0];
      let bestActive = Infinity;
      for (const name of available) {
        const active = poolStatus[name]?.active || 0;
        if (active < bestActive) {
          bestActive = active;
          best = name;
        }
      }
      return best;
    }

    default:
      return available[0];
  }
}
