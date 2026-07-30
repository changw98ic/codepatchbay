import type { LooseRecord } from "../../shared/types.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assertValidSetupAgentCatalog,
  validateDefaultRolesSubset,
  validateSetupAgentManifest,
} from "./manifest-schema.js";

const BUILTIN_MANIFEST_DIR = path.join(import.meta.dirname, "manifests");
// Descriptor catalog (B4 cross-validation source of truth). The manifest and
// descriptor catalogs are intentionally separate (manifests advertise
// install/auth surface; descriptors drive routing/isolation), so the path is
// computed relative to this module rather than imported as a dependency.
const BUILTIN_DESCRIPTOR_DIR = path.join(import.meta.dirname, "..", "agents", "descriptors");
const BUILTIN_ORDER = new Map([
  ["codex", 10],
  ["claude", 20],
  ["opencode", 30],
  ["cursor", 40],
  ["reasonix", 50],
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function orderFor(agent: LooseRecord) {
  return BUILTIN_ORDER.get(agent.id) ?? 1000;
}

function sortCatalog(agents: LooseRecord[]) {
  return [...agents].sort((a: LooseRecord, b: LooseRecord) => {
    const byOrder = orderFor(a) - orderFor(b);
    return byOrder || String(a.id).localeCompare(String(b.id));
  });
}

function failOrSkip(error: Error, strict: boolean) {
  if (strict) throw error;
  return null;
}

/**
 * Sync-read the shipped `core/agents/descriptors/*.json` and return a map of
 * descriptor name → its `defaultRoles` strings (B4). Used only to enforce the
 * `defaultRoles ⊆ roles` invariant against the manifest catalog; malformed
 * descriptors are skipped (they are validated elsewhere by the registry).
 */
function loadBuiltinDescriptorDefaultRoles(): Map<string, string[]> {
  const roles = new Map<string, string[]>();
  let entries;
  try {
    entries = readdirSync(BUILTIN_DESCRIPTOR_DIR, { withFileTypes: true });
  } catch {
    return roles;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = readFileSync(path.join(BUILTIN_DESCRIPTOR_DIR, entry.name), "utf8");
      const d = JSON.parse(raw) as LooseRecord;
      if (typeof d?.name !== "string" || !d.name) continue;
      if (Array.isArray(d.defaultRoles)) {
        const valid = d.defaultRoles.filter(
          (r: unknown) => typeof r === "string" && (r as string).length > 0,
        ) as string[];
        if (valid.length > 0) roles.set(d.name, valid);
      }
    } catch {
      // Skip malformed descriptor — not this module's concern.
    }
  }
  return roles;
}

/**
 * Enforce the B4 cross-catalog invariant `defaultRoles ⊆ roles` for any agent
 * present in both catalogs. Throws a single aggregated error on violation so
 * the strict load path (listSetupAgents / getSetupAgent) fail-closes instead
 * of shipping a catalog where routing defaults outrun advertised competence.
 */
function assertDescriptorRoleSubset(agents: LooseRecord[]) {
  const descriptorRoles = loadBuiltinDescriptorDefaultRoles();
  if (descriptorRoles.size === 0) return; // no descriptors available → nothing to check
  const result = validateDefaultRolesSubset(agents, descriptorRoles);
  if (!result.valid) {
    throw new Error(
      `Setup agent catalog invariant violated (defaultRoles ⊆ roles): ${result.errors.join("; ")}`,
    );
  }
}

function loadManifestDir(dir: string, strict: boolean): LooseRecord[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT" && !strict) return [];
    throw error;
  }

  const agents: LooseRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    let manifest: LooseRecord;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      const err = error as Error;
      failOrSkip(
        new Error(`Invalid setup agent manifest JSON ${entry.name}: ${err.message}`),
        strict,
      );
      continue;
    }

    const validation = validateSetupAgentManifest(manifest);
    if (!validation.valid) {
      failOrSkip(
        new Error(`Invalid setup agent manifest ${entry.name}: ${validation.errors.join("; ")}`),
        strict,
      );
      continue;
    }
    agents.push(manifest);
  }
  return agents;
}

export function loadSetupAgentCatalog({ manifestDir = BUILTIN_MANIFEST_DIR, strict = false } = {}) {
  // Load the base (builtin) dir, then merge user manifests from
  // CPB_SETUP_MANIFESTS_DIR on top — mirroring CPB_AGENTS_CONFIG_DIR for
  // descriptors. User entries override builtin by id (last wins). The env is
  // cleared by the test runner, so explicit `manifestDir` test fixtures are
  // unaffected.
  const base = loadManifestDir(manifestDir, strict);
  const userDir = process.env.CPB_SETUP_MANIFESTS_DIR;
  const user = userDir && userDir.trim() ? loadManifestDir(userDir, strict) : [];

  const byId = new Map<string, LooseRecord>();
  for (const m of base) {
    const id = typeof m.id === "string" ? m.id : "";
    if (id) byId.set(id, m);
  }
  for (const m of user) {
    const id = typeof m.id === "string" ? m.id : "";
    if (id) byId.set(id, m);
  }

  const sorted = clone(sortCatalog([...byId.values()]));
  if (strict) {
    assertDescriptorRoleSubset(sorted);
  }
  return sorted;
}

export function listSetupAgents({ includeOptional = true } = {}) {
  const agents = loadSetupAgentCatalog({ strict: true });
  assertValidSetupAgentCatalog(agents);
  return includeOptional ? agents : agents.filter((agent: LooseRecord) => agent.recommended);
}

export function getSetupAgent(id: string) {
  const agents = loadSetupAgentCatalog({ strict: true });
  assertValidSetupAgentCatalog(agents);
  const agent = agents.find((entry: LooseRecord) => entry.id === id);
  return agent ? clone(agent) : null;
}
