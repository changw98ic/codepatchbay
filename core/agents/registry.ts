import { recordValue, type LooseRecord } from "../../shared/types.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { autoDiscoverAgents } from "./auto-discover.js";

const DESCRIPTORS_DIR = path.join(import.meta.dirname, "descriptors");
const SQUADS_FILE = path.join(import.meta.dirname, "squads.json");

const _registry = new Map<string, any>();
const _discovered = new Map<string, any>();
const _squads = new Map<string, any>();
const _rrCounters = new Map<string, number>(); // round-robin counters per squad
// Names loaded from the shipped core/agents/descriptors/*.json directory. These
// are the only descriptors whose `inheritFiles`/`quarantineFiles` are trusted to
// override the §6.2 source-allowlist/containment gates (B2b): anything coming
// from CPB_AGENTS_CONFIG_DIR or auto-discovery is treated as untrusted data.
const _builtinNames = new Set<string>();
let _loaded = false;

const ACP_AGENT_ENV_NAME = /^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/;
const ACP_AGENT_ENV_PREFIX = /^CPB_ACP_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/**
 * Map a legal agent id to its one canonical environment namespace.
 *
 * Environment variable names use underscores even when the public agent id
 * uses hyphens or dots. Reject path/control punctuation instead of probing
 * multiple dynamically constructed keys with ambiguous precedence.
 */
export function resolveAgentEnvPrefix(name: string, configuredPrefix?: unknown) {
  if (typeof name !== "string" || !ACP_AGENT_ENV_NAME.test(name)) {
    throw new TypeError(`invalid ACP agent name for environment lookup: ${String(name)}`);
  }
  const canonical = `CPB_ACP_${name.toUpperCase().replace(/[-.]/g, "_")}`;
  if (configuredPrefix === undefined || configuredPrefix === null || configuredPrefix === "") {
    return canonical;
  }
  if (typeof configuredPrefix !== "string" || !ACP_AGENT_ENV_PREFIX.test(configuredPrefix)) {
    throw new TypeError(`invalid ACP agent environment prefix for ${name}: ${String(configuredPrefix)}`);
  }
  return configuredPrefix;
}

function validateDescriptor(d: LooseRecord) {
  if (!d || typeof d !== "object") return false;
  if (typeof d.name !== "string" || !d.name) return false;
  if (typeof d.command !== "string" || !d.command) return false;
  try {
    resolveAgentEnvPrefix(d.name, d.envPrefix);
  } catch {
    return false;
  }
  // Provider-capability fields (B1) are optional and type-tolerant: when
  // present they must match the declared shape, but absence is fine so legacy
  // descriptors and auto-discovered agents keep loading unchanged. This is
  // purely additive — no previously-accepted descriptor is rejected unless it
  // carries a new field with a fundamentally wrong type.
  if (!isValidCapabilityShape(d)) return false;
  return true;
}

/**
 * Lenient shape check for the optional B1 provider-capability fields.
 * Returns false only when a field is present with a fundamentally wrong type.
 */
function isValidCapabilityShape(d: LooseRecord): boolean {
  if (d.providerFamily !== undefined && typeof d.providerFamily !== "string") return false;
  if (d.sandboxPolicy !== undefined && typeof d.sandboxPolicy !== "string") return false;
  const priority = d.tieBreakPriority;
  if (
    priority !== undefined &&
    (typeof priority !== "number" || !Number.isFinite(priority) || priority < 0)
  ) {
    return false;
  }
  if (d.inheritFiles !== undefined && !Array.isArray(d.inheritFiles)) return false;
  if (d.quarantineFiles !== undefined && !Array.isArray(d.quarantineFiles)) return false;
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
        _builtinNames.add(d.name);
      }
    } catch {
      // Skip invalid descriptors
    }
  }
}

async function loadUserDescriptors(configDir: string) {
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

export async function loadRegistry(configDir: string) {
  if (_loaded && !configDir) return;
  _registry.clear();
  _discovered.clear();
  _squads.clear();
  _rrCounters.clear();
  _builtinNames.clear();
  await loadBuiltinDescriptors();
  await loadUserDescriptors(configDir);

  // Auto-discover installed agents (supplement, don't override)
  try {
    const found = await autoDiscoverAgents();
    for (const d of found) {
      if (typeof d.name === "string" && d.name && !_registry.has(d.name)) {
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
        for (const [name, squad] of Object.entries(data.squads as LooseRecord)) {
        const squadRecord = recordValue(squad);
        if (squadRecord.leader && Array.isArray(squadRecord.members)) {
          _squads.set(name, { ...squadRecord, name });
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

export function hasAgent(name: string) {
  ensureLoaded();
  return _registry.has(name) || _discovered.has(name);
}

export function getDescriptor(name: string) {
  ensureLoaded();
  return _registry.get(name) || _discovered.get(name) || null;
}

/**
 * Whether `name` was loaded from the shipped `core/agents/descriptors/*.json`
 * directory (B2b). Builtin descriptors are authored by CPB and trusted to
 * override the §6.2 inherit-source allowlist; user-registered
 * (`CPB_AGENTS_CONFIG_DIR`) and auto-discovered agents are untrusted data.
 */
export function isBuiltinDescriptor(name: string) {
  ensureLoaded();
  return _builtinNames.has(name);
}

/**
 * Provider-capability projection of a descriptor (B1).
 *
 * Always returns a fully-populated object (never partial) by defensively
 * normalizing missing/malformed fields, so callers can read it without
 * re-checking each property. Returns null for unknown agents. This is purely
 * additive — it reads fields that older descriptors simply don't carry.
 */
export type AgentCapability = {
  providerFamily: string | null;
  tieBreakPriority: number;
  sandboxPolicy: "native" | "cpb-required" | "none";
  inheritFiles: Array<{ from: string; to: string; maxBytes?: number }>;
  quarantineFiles: string[];
};

export function getCapability(name: string): AgentCapability | null {
  ensureLoaded();
  const d = _registry.get(name) || _discovered.get(name);
  if (!d) return null;
  return {
    providerFamily: typeof d.providerFamily === "string" ? d.providerFamily : null,
    tieBreakPriority:
      typeof d.tieBreakPriority === "number" && Number.isFinite(d.tieBreakPriority)
        ? d.tieBreakPriority
        : 1000,
    sandboxPolicy: ["native", "cpb-required", "none"].includes(d.sandboxPolicy)
      ? d.sandboxPolicy
      : "cpb-required",
    inheritFiles: Array.isArray(d.inheritFiles) ? d.inheritFiles : [],
    quarantineFiles: Array.isArray(d.quarantineFiles) ? d.quarantineFiles : [],
  };
}


/**
 * Resolve the command and args for a given agent name.
 * Checks env overrides first (CPB_ACP_{PREFIX}_COMMAND / _ARGS),
 * then tries the descriptor's primary command, then falls back.
 */
export function resolveAgentCommand(name: string) {
  const d = getDescriptor(name);
  if (!d) return null;

  const prefix = resolveAgentEnvPrefix(name, d.envPrefix);

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
export function listAgentsByProtocol(protocol: string) {
  ensureLoaded();
  return [..._registry.values(), ..._discovered.values()]
    .filter((d) => (d.protocol || "unknown") === protocol);
}

/**
 * Whether the provider-capability registry drives routing decisions (B2+).
 *
 * Default is ON: every B2 call site reads `getCapability()` / descriptor
 * fields instead of branching on `==="codex"` / `==="claude"` literals. Set
 * `CPB_PROVIDER_REGISTRY=0` to fall back to the pre-B2 literal/regex path —
 * the per-task kill switch required by the RFC §4 rollback safety.
 */
export function providerRegistryEnabled(): boolean {
  return process.env.CPB_PROVIDER_REGISTRY !== "0";
}

/**
 * Pick the lowest-priority candidate from a list, using the registry-declared
 * `tieBreakPriority` (smaller wins). Ties break by ascending agent name so the
 * result is deterministic regardless of map iteration order.
 */
function pickRoleCandidate(candidates: LooseRecord[]): string | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestName = String(best.name);
  let bestPriority = getCapability(bestName)?.tieBreakPriority ?? 1000;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const cName = String(c.name);
    const priority = getCapability(cName)?.tieBreakPriority ?? 1000;
    if (priority < bestPriority || (priority === bestPriority && cName < bestName)) {
      best = c;
      bestName = cName;
      bestPriority = priority;
    }
  }
  return bestName;
}

/**
 * Default agent for a given role.
 *
 * With the provider-capability registry active (default), candidates are
 * agents whose `defaultRoles` include `role`, ranked by lowest
 * `tieBreakPriority` (codex still wins the roles it declares because it
 * carries priority 10) — but codex no longer pre-empts roles it does not own.
 * Set `CPB_PROVIDER_REGISTRY=0` to restore the legacy codex short-circuit.
 */
export function defaultAgentForRole(role: string) {
  ensureLoaded();
  if (!providerRegistryEnabled()) {
    // Legacy path: codex is the unconditional baseline for ACP roles.
    const codex = _registry.get("codex") || _discovered.get("codex");
    if (codex && (codex.protocol || "unknown") === "acp") return "codex";
    for (const d of _registry.values()) {
      if (d.defaultRoles && d.defaultRoles.includes(role) && (d.protocol || "unknown") === "acp") {
        return d.name;
      }
    }
    for (const d of _registry.values()) {
      if (d.defaultRoles && d.defaultRoles.includes(role)) {
        return d.name;
      }
    }
    throw new Error(`no registered ACP agent is configured for role: ${role}`);
  }
  // Registry-driven path: rank role-owners by ACP-first then lowest priority.
  const acpCandidates: LooseRecord[] = [];
  const otherCandidates: LooseRecord[] = [];
  for (const d of _registry.values()) {
    if (!Array.isArray(d.defaultRoles) || !d.defaultRoles.includes(role)) continue;
    if ((d.protocol || "unknown") === "acp") acpCandidates.push(d);
    else otherCandidates.push(d);
  }
  const pick = pickRoleCandidate(acpCandidates) ?? pickRoleCandidate(otherCandidates);
  if (pick) return pick;
  throw new Error(`no registered ACP agent is configured for role: ${role}`);
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
export function getSquad(name: string) {
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
export function resolveSquadAgent(squadName: string, { strategy, poolStatus }: LooseRecord = {}) {
  ensureLoaded();
  const squad = _squads.get(squadName);
  if (!squad) return null;

  const strat = strategy || squad.strategy || "leader-first";
  const available = squad.members.filter((m: string) => hasAgent(m));
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
      const pools = recordValue(poolStatus);
      for (const name of available) {
        const status = recordValue(pools[name]);
        const active = typeof status.active === "number" ? status.active : 0;
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
