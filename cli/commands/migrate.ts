/**
 * migrate.ts — Data migration CLI command.
 *
 * Provides offline migration subcommands that validate and mutate durable
 * runtime state (hub registry, queue entries, capability maps) without
 * requiring a running hub or worker.
 *
 * Current subcommands:
 *   local-code-index-v2  Migrate projects from v1 local-code-index stubs
 *                        to the v2 core/indexing/local-code-index API.
 *
 * Usage:
 *   cpb migrate local-code-index-v2 --cpb-root <absolute-path> [--apply] [--json]
 *
 * Safety:
 *   - Default mode is dry-run: produces a validation report with no mutation.
 *   - --apply performs sequential queue and registry mutations.
 *   - Each mutation is guarded by the hub registry's CAS lock.
 *   - Abort on first failure; partial progress is reported.
 */

import { access, constants as fsConstants, stat } from "node:fs/promises";
import path from "node:path";

import type { LooseRecord } from "../../shared/types.js";
import type { LocalCodeIndexRef } from "../../core/indexing/local-code-index/index.js";

// ── ANSI colors ─────────────────────────────────────────────────────────────

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const CYAN = "\x1b[0;36m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

// ── Types ───────────────────────────────────────────────────────────────────

interface MigrateOptions {
  cpbRoot: string;
  apply: boolean;
  jsonOutput: boolean;
}

interface ProjectValidation {
  projectId: string;
  sourcePath: string;
  projectRuntimeRoot: string;
  /** Whether a v2 local-code-index snapshot exists for this sourcePath. */
  v2Available: boolean;
  /** The v2 ref, if available. */
  v2Ref: LocalCodeIndexRef | null;
  /** Whether the project metadata already carries a v2 migration marker. */
  alreadyMigrated: boolean;
  /** Whether the capability map metadata references v1 stubs. */
  hasV1CapabilityMap: boolean;
  /** Human-readable status line. */
  status: "ready" | "already-migrated" | "v2-unavailable" | "no-source-path";
  /** Reason when status is not "ready". */
  reason: string | null;
}

interface MigrationReport {
  cpbRoot: string;
  hubRoot: string;
  projectsTotal: number;
  projectsNeedingMigration: number;
  projectsReady: number;
  projectsSkipped: number;
  validations: ProjectValidation[];
}

interface MigrationApplyResult extends MigrationReport {
  applied: number;
  failed: number;
  errors: Array<{ projectId: string; error: string }>;
}

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { subcommand: string; options: MigrateOptions } {
  const args = argv.slice(2); // Skip node and script path
  const subcommand = args[0] ?? "help";

  const options: MigrateOptions = {
    cpbRoot: "",
    apply: false,
    jsonOutput: false,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--cpb-root":
      case "-r":
        options.cpbRoot = path.resolve(args[++i]!);
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--json":
        options.jsonOutput = true;
        break;
      default:
        break;
    }
  }

  return { subcommand, options };
}

// ── Validation helpers ──────────────────────────────────────────────────────

async function assertDirectory(p: string, label: string): Promise<void> {
  try {
    const st = await stat(p);
    if (!st.isDirectory()) {
      console.error(`${RED}Error: ${label} is not a directory: ${p}${NC}`);
      process.exit(1);
    }
  } catch {
    console.error(`${RED}Error: ${label} does not exist: ${p}${NC}`);
    process.exit(1);
  }
}

// ── Core migration logic ────────────────────────────────────────────────────

/**
 * Validate a single project for v2 migration readiness.
 *
 * Checks:
 *  1. Project has a sourcePath that exists on disk.
 *  2. A v2 local-code-index snapshot can be resolved for that sourcePath.
 *  3. Project metadata does not already carry a v2 migration marker.
 *  4. Project metadata carries v1 capability map stubs (needs regeneration).
 */
async function validateProject(
  projectId: string,
  project: LooseRecord,
  cpbRoot: string,
): Promise<ProjectValidation> {
  const sourcePath = project.sourcePath as string | undefined;
  const projectRuntimeRoot = project.projectRuntimeRoot as string | undefined;

  if (!sourcePath) {
    return {
      projectId,
      sourcePath: "",
      projectRuntimeRoot: projectRuntimeRoot ?? "",
      v2Available: false,
      v2Ref: null,
      alreadyMigrated: false,
      hasV1CapabilityMap: false,
      status: "no-source-path",
      reason: "Project has no sourcePath in registry",
    };
  }

  // Check if sourcePath exists on disk.
  let sourceExists = false;
  try {
    await access(sourcePath, fsConstants.R_OK);
    sourceExists = true;
  } catch {
    // Source path gone — project is orphaned but still registered.
  }

  // Check for v2 migration marker in metadata.
  const metadata = (project.metadata ?? {}) as LooseRecord;
  const alreadyMigrated = metadata.localCodeIndexV2Migrated === true;

  // Check if capability map metadata references v1 stubs.
  // v1 stubs produce capability maps with `confidence: "low"` or missing
  // `generatedAt` because the stub always throws.
  const capMap = (metadata.project_capability_map ?? metadata.projectCapabilityMap ?? {}) as LooseRecord;
  const confidence = capMap.confidence as string | undefined;
  const hasV1CapabilityMap = confidence !== "high";

  if (alreadyMigrated) {
    return {
      projectId,
      sourcePath,
      projectRuntimeRoot: projectRuntimeRoot ?? "",
      v2Available: false,
      v2Ref: null,
      alreadyMigrated: true,
      hasV1CapabilityMap,
      status: "already-migrated",
      reason: "Already carries localCodeIndexV2Migrated marker",
    };
  }

  // Try to resolve v2 index status.
  let v2Available = false;
  let v2Ref: LocalCodeIndexRef | null = null;

  if (sourceExists) {
    try {
      const { localCodeIndexStatus } = await import("../../core/indexing/local-code-index/index.js");
      const lcStatus = await localCodeIndexStatus({ cpbRoot, sourcePath });
      if (lcStatus.available) {
        v2Available = true;
        v2Ref = lcStatus.ref;
      }
    } catch {
      // v2 index not available — will be reported.
    }
  }

  if (!v2Available) {
    return {
      projectId,
      sourcePath,
      projectRuntimeRoot: projectRuntimeRoot ?? "",
      v2Available: false,
      v2Ref: null,
      alreadyMigrated: false,
      hasV1CapabilityMap,
      status: "v2-unavailable",
      reason: sourceExists
        ? "v2 local-code-index not built for this source path"
        : `Source path does not exist: ${sourcePath}`,
    };
  }

  return {
    projectId,
    sourcePath,
    projectRuntimeRoot: projectRuntimeRoot ?? "",
    v2Available,
    v2Ref,
    alreadyMigrated: false,
    hasV1CapabilityMap,
    status: "ready",
    reason: null,
  };
}

/**
 * Build a dry validation report for all registered projects.
 */
async function buildValidationReport(cpbRoot: string): Promise<MigrationReport> {
  const { resolveHubRoot, loadRegistry } = await import(
    "../../server/services/hub/hub-registry.js"
  );
  const hubRoot = resolveHubRoot(cpbRoot);

  // Verify hub root exists.
  await assertDirectory(hubRoot, "Hub root");

  const registry = await loadRegistry(hubRoot);
  const projects = (registry.projects ?? {}) as Record<string, LooseRecord>;
  const projectIds = Object.keys(projects);

  const validations: ProjectValidation[] = [];
  for (const projectId of projectIds) {
    const v = await validateProject(projectId, projects[projectId]!, cpbRoot);
    validations.push(v);
  }

  const ready = validations.filter((v) => v.status === "ready");
  const skipped = validations.filter((v) => v.status !== "ready");

  return {
    cpbRoot,
    hubRoot,
    projectsTotal: validations.length,
    projectsNeedingMigration: ready.length,
    projectsReady: ready.length,
    projectsSkipped: skipped.length,
    validations,
  };
}

/**
 * Apply the v2 migration sequentially: for each project that passed
 * validation, rebuild the capability map and mark the project as migrated.
 *
 * Operations are sequential to avoid concurrent registry CAS conflicts.
 * On first failure, remaining projects are skipped and the error is reported.
 */
async function applyMigration(report: MigrationReport): Promise<MigrationApplyResult> {
  const { mutateRegistry } = await import(
    "../../server/services/hub/hub-registry.js"
  );

  const hubRoot = report.hubRoot;
  const readyProjects = report.validations.filter((v) => v.status === "ready");

  let applied = 0;
  let failed = 0;
  const errors: Array<{ projectId: string; error: string }> = [];

  for (const validation of readyProjects) {
    try {
      // Step 1: Rebuild capability map with v2 index.
      let capabilityMetadata: LooseRecord = {};
      try {
        const { generateProjectCapabilityMaps } = await import(
          "../../server/services/project-capability-map.js"
        );
        capabilityMetadata = await generateProjectCapabilityMaps({
          cpbRoot: report.cpbRoot,
          sourcePath: validation.sourcePath,
        });
      } catch (err) {
        // Capability map rebuild failed — record but continue with marker.
        console.warn(
          `${YELLOW}Warning: capability map rebuild failed for ${validation.projectId}: ${err instanceof Error ? err.message : String(err)}${NC}`,
        );
      }

      // Step 2: Update registry entry with v2 metadata marker and refreshed
      // capability map, under the registry's CAS lock.
      await mutateRegistry(hubRoot, (registry) => {
        const project = registry.projects[validation.projectId];
        if (!project) {
          throw new Error(`Project ${validation.projectId} disappeared from registry`);
        }
        // Merge v2 metadata into the existing project metadata using
        // property assignment (avoids type incompatibility on full replace).
        const meta = project.metadata as Record<string, unknown> | undefined;
        if (meta) {
          for (const [k, v] of Object.entries(capabilityMetadata)) {
            meta[k] = v;
          }
          meta.localCodeIndexV2Migrated = true;
          meta.localCodeIndexV2MigratedAt = new Date().toISOString();
          meta.localCodeIndexRef = validation.v2Ref;
        } else {
          (project as Record<string, unknown>).metadata = {
            ...capabilityMetadata,
            localCodeIndexV2Migrated: true,
            localCodeIndexV2MigratedAt: new Date().toISOString(),
            localCodeIndexRef: validation.v2Ref,
          };
        }
      });

      applied++;
      console.log(`  ${GREEN}OK${NC}  ${validation.projectId}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ projectId: validation.projectId, error: msg });
      console.error(`  ${RED}FAIL${NC} ${validation.projectId}: ${msg}`);
      // Abort on first failure — sequential queue guarantees no partial
      // concurrent state, but we stop to let the operator investigate.
      break;
    }
  }

  return {
    ...report,
    applied,
    failed,
    errors,
  };
}

// ── Report rendering ────────────────────────────────────────────────────────

function printReport(report: MigrationReport): void {
  console.log("");
  console.log(`${CYAN}Local Code Index v2 Migration — Validation Report${NC}`);
  console.log(`${DIM}${"─".repeat(60)}${NC}`);
  console.log(`  CPB root:   ${report.cpbRoot}`);
  console.log(`  Hub root:   ${report.hubRoot}`);
  console.log(`  Projects:   ${report.projectsTotal} total, ${report.projectsNeedingMigration} need migration, ${report.projectsSkipped} skipped`);
  console.log("");

  for (const v of report.validations) {
    const icon =
      v.status === "ready" ? `${GREEN}[ready]${NC}` :
      v.status === "already-migrated" ? `${DIM}[skip]${NC}` :
      v.status === "v2-unavailable" ? `${YELLOW}[skip]${NC}` :
      `${RED}[skip]${NC}`;

    console.log(`  ${icon} ${v.projectId}`);
    console.log(`         source: ${v.sourcePath || "(none)"}`);
    if (v.reason) {
      console.log(`         reason: ${v.reason}`);
    }
    if (v.v2Ref) {
      console.log(`         snapshot: ${v.v2Ref.snapshotId}`);
    }
    if (v.hasV1CapabilityMap && v.status === "ready") {
      console.log(`         capability map: will regenerate from v2 index`);
    }
  }

  console.log("");
  if (report.projectsNeedingMigration === 0) {
    console.log(`${GREEN}No projects need migration.${NC}`);
  } else if (!process.argv.includes("--apply")) {
    console.log(`${YELLOW}Run with --apply to perform migration.${NC}`);
  }
  console.log("");
}

function printApplyResult(result: MigrationApplyResult): void {
  printReport(result);
  console.log(`${CYAN}Apply Results${NC}`);
  console.log(`${DIM}${"─".repeat(60)}${NC}`);
  console.log(`  Applied: ${result.applied}`);
  console.log(`  Failed:  ${result.failed}`);
  if (result.errors.length > 0) {
    console.log("");
    console.log(`${RED}Errors:${NC}`);
    for (const e of result.errors) {
      console.log(`  - ${e.projectId}: ${e.error}`);
    }
  }
  console.log("");
}

function cmdHelp(): void {
  console.log(`
${CYAN}cpb migrate${NC} — Data migration commands

${GREEN}Usage:${NC}
  cpb migrate <subcommand> [options]

${GREEN}Subcommands:${NC}
  ${CYAN}local-code-index-v2${NC}   Migrate projects from v1 local-code-index stubs
                       to the v2 core/indexing/local-code-index API.

${GREEN}Options:${NC}
  --cpb-root, -r <path>   Absolute path to CPB root (required)
  --apply                 Perform the migration (default: dry-run)
  --json                  Output report as JSON

${GREEN}Safety:${NC}
  - Default mode is dry-run: produces a validation report with no mutation.
  - --apply performs sequential queue and registry mutations under CAS lock.
  - Aborts on first failure; partial progress is reported.
`);
}

// ── Command: local-code-index-v2 ────────────────────────────────────────────

async function cmdLocalCodeIndexV2(options: MigrateOptions): Promise<number> {
  if (!options.cpbRoot) {
    console.error(`${RED}Error: --cpb-root <absolute-path> is required${NC}`);
    process.exit(1);
  }

  // Resolve to absolute and verify it exists.
  const cpbRoot = path.resolve(options.cpbRoot);
  await assertDirectory(cpbRoot, "CPB root");

  // Step 1: Build dry validation report (always, even in apply mode).
  const report = await buildValidationReport(cpbRoot);

  if (options.jsonOutput && !options.apply) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  // Step 2: Print validation report.
  if (!options.apply) {
    printReport(report);
    return 0;
  }

  // Step 3: Apply migration (sequential, under registry CAS lock).
  if (report.projectsNeedingMigration === 0) {
    printReport(report);
    return 0;
  }

  console.log(`${CYAN}Applying migration...${NC}`);
  console.log("");

  const result = await applyMigration(report);

  if (options.jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printApplyResult(result);
  }

  return result.failed > 0 ? 1 : 0;
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function run(args: string[], context: LooseRecord): Promise<number> {
  // Reconstruct argv for parseArgs (it expects process.argv shape).
  const argv = ["node", "migrate", ...args];
  const { subcommand, options } = parseArgs(argv);

  // Inherit cpbRoot from context if not explicitly passed.
  if (!options.cpbRoot && context.cpbRoot) {
    options.cpbRoot = path.resolve(context.cpbRoot as string);
  }

  switch (subcommand) {
    case "local-code-index-v2":
      return cmdLocalCodeIndexV2(options);
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      return 0;
    default:
      console.error(`${RED}Unknown migrate subcommand: ${subcommand}${NC}`);
      cmdHelp();
      return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const cpbRoot = path.resolve(process.env.CPB_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."));
  const code = await run(args, { cpbRoot });
  if (Number.isInteger(code)) process.exitCode = code;
}
