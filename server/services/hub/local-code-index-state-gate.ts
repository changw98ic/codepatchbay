/**
 * local-code-index-state-gate.ts -- fail-closed validator for local code index schema state.
 *
 * Three invocation sites:
 *   1. Hub/orchestrator startup  -- gateRegistryState()
 *   2. Scheduler candidate selection -- gateDispatchCandidate() (defense in depth)
 *   3. claimEligible dispatch -- gateDispatchCandidate()
 *
 * When a registered project's local code index carries a v1 schema version
 * (the current runtime requires v2), the gate fails closed with
 * `unsupported_index_schema` and migration instructions rather than allowing
 * a dispatch that would fail mid-flight.
 */

import { LooseRecord } from "../../../core/contracts/types.js";
import {
  localCodeIndexStatus,
} from "../../../core/indexing/local-code-index/index.js";
import { loadRegistry, type ProjectRecord } from "./hub-registry.js";

// ── Constants ────────────────────────────────────────────────────────────────

const REQUIRED_INDEX_SCHEMA_VERSION = 2;
const GATE_ERROR_CODE = "UNSUPPORTED_INDEX_SCHEMA";

const MIGRATION_INSTRUCTIONS =
  "The local code index uses schema v1 which is no longer supported. "
  + "Re-index the project to upgrade to schema v2:\n"
  + "  cpb init <source-path> <project-id>\n"
  + "or delete the existing index and let the next pipeline run re-create it:\n"
  + "  rm -rf <cpb-root>/index/<repository-key>\n"
  + "See docs/architecture/local-code-index-v2-spec.md for details.";

// ── Result types ─────────────────────────────────────────────────────────────

export type LocalCodeIndexStateGatePassed = {
  readonly passed: true;
};

export type LocalCodeIndexStateGateFailed = {
  readonly passed: false;
  readonly code: typeof GATE_ERROR_CODE;
  readonly projectId: string;
  readonly sourcePath: string;
  readonly detectedSchemaVersion: number;
  readonly requiredSchemaVersion: typeof REQUIRED_INDEX_SCHEMA_VERSION;
  readonly migrationInstructions: string;
};

export type LocalCodeIndexStateGateResult =
  | LocalCodeIndexStateGatePassed
  | LocalCodeIndexStateGateFailed;

// ── Helpers ──────────────────────────────────────────────────────────────────

function gateFailed(
  projectId: string,
  sourcePath: string,
  detectedSchemaVersion: number,
): LocalCodeIndexStateGateFailed {
  return {
    passed: false,
    code: GATE_ERROR_CODE,
    projectId,
    sourcePath,
    detectedSchemaVersion,
    requiredSchemaVersion: REQUIRED_INDEX_SCHEMA_VERSION,
    migrationInstructions: MIGRATION_INSTRUCTIONS,
  };
}

/**
 * Probe a single project's local code index schema version.
 *
 * Returns `null` when the index is missing or unreadable (not a schema
 * violation -- the index will be created fresh on demand).  Returns a
 * gate failure only when an index exists but carries an unsupported schema.
 */
async function probeProjectIndexSchema(
  project: ProjectRecord,
  cpbRoot: string | undefined,
): Promise<LocalCodeIndexStateGateResult | null> {
  const sourcePath = project.sourcePath;
  if (!sourcePath) return null;

  let status;
  try {
    status = await localCodeIndexStatus({
      cpbRoot: cpbRoot || (project as LooseRecord).cpbRoot
        || ((project as LooseRecord).metadata as LooseRecord)?.cpbRoot as string
        || sourcePath,
      sourcePath,
    });
  } catch {
    // Index unreadable -- not a schema violation.  The readiness gate
    // downstream will handle the actual error.
    return null;
  }

  if (status.available) {
    // Index is available and passed the v2 check inside localCodeIndexStatus.
    return null;
  }

  if (status.reason === "unsupported_index_schema") {
    // The index exists but carries a schema version the runtime no longer
    // supports.  Fail closed.
    return gateFailed(
      project.id,
      sourcePath,
      // localCodeIndexStatus does not expose the detected version; we know
      // it is < 2 because the only supported version is 2.
      1,
    );
  }

  // Other unavailability reasons (missing, corrupt, etc.) are not schema
  // violations and will be handled by the readiness/freshness gates.
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Startup gate: validate all registered projects in the hub registry.
 *
 * Hub/orchestrator should call this once before entering the dispatch loop.
 * If any project carries an unsupported index schema, the gate fails closed
 * and the caller must block dispatch until the index is migrated.
 *
 * @param hubRoot  Hub root directory path.
 * @param cpbRoot  Optional CPB root override for index resolution.
 * @returns        Gate result -- either passed or the first failure.
 */
export async function gateRegistryState(
  hubRoot: string,
  cpbRoot?: string,
): Promise<LocalCodeIndexStateGateResult> {
  const registry = await loadRegistry(hubRoot);
  const projects = Object.values(registry.projects);

  for (const project of projects) {
    if (project.enabled === false) continue;
    const result = await probeProjectIndexSchema(project, cpbRoot);
    if (result && !result.passed) return result;
  }

  return { passed: true };
}

/**
 * Dispatch gate: validate a single candidate before dispatch.
 *
 * Scheduler candidate selection and claimEligible invoke this as defense
 * in depth.  Even if the startup gate passed, a new index snapshot may
 * have been published between ticks with a downgraded schema.
 *
 * @param hubRoot     Hub root directory path.
 * @param projectId   The project being dispatched.
 * @param sourcePath  The project's source path.
 * @param cpbRoot     Optional CPB root override for index resolution.
 * @returns           Gate result -- either passed or a failure with details.
 */
export async function gateDispatchCandidate(
  hubRoot: string,
  projectId: string,
  sourcePath: string,
  cpbRoot?: string,
): Promise<LocalCodeIndexStateGateResult> {
  const project = { id: projectId, sourcePath } as ProjectRecord;
  const result = await probeProjectIndexSchema(project, cpbRoot);
  if (result && !result.passed) return result;
  return { passed: true };
}
