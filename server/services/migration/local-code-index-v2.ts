/**
 * local-code-index-v2.ts — Hub data migration for local-code-index v2 format.
 *
 * Migrates stale local-code-index metadata in hub queue entries and registry
 * project records from v1 shape to v2 shape.  Each entry point acquires the
 * relevant store lock, rereads the canonical data, revalidates, writes a
 * timestamped backup, applies the transform, and commits.
 *
 * Invariants:
 *   - Dry-run mode inspects everything without mutation.
 *   - Active work (in_progress / scheduled queue entries) blocks queue migration.
 *   - Registry migration refuses if any queue entry is actively running.
 *   - Rerunning an already-migrated store is a no-op (idempotent).
 *
 * Architecture:
 *   - This module owns inspection, validation, and transform logic.
 *   - Locked entry points live in hub-queue.ts (`withQueueLockForMigration`)
 *     and hub-registry.ts (`mutateRegistryForMigration`).
 *   - The high-level `runLocalCodeIndexV2Migration` orchestrates the full
 *     pipeline, calling into those locked entry points via dynamic import
 *     to avoid circular dependency.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveHubRoot, loadRegistry } from "../hub/hub-registry.js";
import type { RegistryRecord } from "../hub/hub-registry.js";
import {
  loadQueue,
  isActiveEntry,
  isMutatingEntry,
} from "../hub/hub-queue.js";

// ─── Public types ───────────────────────────────────────────────────────────

export type MigrationTarget = "queue" | "registry" | "all";

export type DryRunReport = {
  target: MigrationTarget;
  hubRoot: string;
  eligible: number;
  skipped: number;
  alreadyMigrated: number;
  activeBlocked: number;
  details: DryRunEntryDetail[];
};

export type DryRunEntryDetail = {
  id: string;
  projectId: string;
  action: "migrate" | "skip-active" | "skip-migrated" | "skip-clean";
  reason?: string;
};

export type MigrationResult = {
  target: MigrationTarget;
  hubRoot: string;
  migrated: number;
  skipped: number;
  alreadyMigrated: number;
  activeBlocked: number;
  backupPath: string | null;
  timestamp: string;
};

export type MigrateOptions = {
  hubRoot?: string;
  dryRun?: boolean;
  target?: MigrationTarget;
  forceActiveBypass?: boolean;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const MIGRATION_VERSION = 2;
const MIGRATION_SENTINEL_KEY = "__localCodeIndexMigrationVersion";

// ─── Helpers ────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Queue entry classification ─────────────────────────────────────────────

/**
 * Check whether a queue entry's local-code-index metadata is in v2 shape.
 * An entry is considered migrated if it carries the sentinel key, OR if
 * it has no stale v1 metadata to begin with.
 */
function isQueueEntryMigrated(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return true;
  return metadata[MIGRATION_SENTINEL_KEY] === MIGRATION_VERSION;
}

/**
 * Check whether a queue entry has stale v1 local-code-index metadata worth migrating.
 * v1 signals: indexFreshness / localCodeIndexReadiness / indexSnapshot objects
 * exist without the migration sentinel.
 */
function hasStaleV1QueueMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  if (metadata[MIGRATION_SENTINEL_KEY] === MIGRATION_VERSION) return false;

  const readiness = isRecord(metadata.localCodeIndexReadiness) ? metadata.localCodeIndexReadiness : null;
  const freshness = isRecord(metadata.indexFreshness) ? metadata.indexFreshness : null;
  const snapshot = isRecord(metadata.indexSnapshot) ? metadata.indexSnapshot : null;

  return Boolean(readiness || freshness || snapshot);
}

/**
 * Transform a single queue entry's metadata from v1 to v2 shape.
 * - Strips stale `indexFreshness` (recalculated at claim time by the v2 gate).
 * - Strips stale `localCodeIndexReadiness` (recalculated at claim time).
 * - Strips stale `indexSnapshot` (re-earned at claim time).
 * - Removes `indexSnapshotId` (snapshot IDs are v2-computed).
 * - Writes migration sentinel into metadata.
 */
function transformQueueMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const next = { ...metadata };

  delete next.indexFreshness;
  delete next.localCodeIndexReadiness;
  delete next.indexSnapshot;
  delete next.indexSnapshotId;

  next[MIGRATION_SENTINEL_KEY] = MIGRATION_VERSION;
  next[MIGRATION_SENTINEL_KEY + "_at"] = nowIso();

  return next;
}

// ─── Registry project classification ───────────────────────────────────────

/**
 * Check whether a registry project's metadata is in v2 shape.
 */
function isRegistryProjectMigrated(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return true;
  return metadata[MIGRATION_SENTINEL_KEY] === MIGRATION_VERSION;
}

/**
 * Check whether a registry project has stale v1 fields worth migrating.
 */
function hasStaleV1RegistryMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  if (metadata[MIGRATION_SENTINEL_KEY] === MIGRATION_VERSION) return false;
  return typeof metadata.capabilityMapConfidence === "string"
    || isRecord(metadata.project_capability_map);
}

/**
 * Transform a single registry project's metadata from v1 to v2 shape.
 * - Removes stale `capabilityMapConfidence` if it references v1 heuristics.
 * - Strips stale `project_capability_map` v1 sub-tree (regenerated by
 *   `generateProjectCapabilityMaps` on next registration).
 * - Writes migration sentinel.
 */
function transformRegistryProjectMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...metadata };

  if (typeof next.capabilityMapConfidence === "string") {
    delete next.capabilityMapConfidence;
  }
  if (isRecord(next.project_capability_map)) {
    delete next.project_capability_map;
  }

  next[MIGRATION_SENTINEL_KEY] = MIGRATION_VERSION;
  next[MIGRATION_SENTINEL_KEY + "_at"] = nowIso();

  return next;
}

// ─── Backup helpers ─────────────────────────────────────────────────────────

async function writeBackup(hubRoot: string, target: string, content: string): Promise<string> {
  const backupDir = path.join(path.resolve(hubRoot), "backups", "migration");
  await mkdir(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${target}-pre-v2-migration-${ts}-${randomUUID().slice(0, 8)}.json`;
  const backupPath = path.join(backupDir, filename);
  await writeFile(backupPath, content, "utf8");
  return backupPath;
}

// ─── Active work detection ──────────────────────────────────────────────────

/**
 * Count active mutating queue entries.  Used by both queue and registry
 * migration to refuse mutation when work is running.
 */
async function countActiveMutatingEntries(hubRoot: string): Promise<number> {
  const queue = await loadQueue(path.resolve(hubRoot));
  return queue.entries.filter((e) => isActiveEntry(e) && isMutatingEntry(e)).length;
}

// ─── Queue dry-run inspection ───────────────────────────────────────────────

export async function inspectQueueForMigration(
  hubRoot: string,
  opts: { forceActiveBypass?: boolean } = {},
): Promise<DryRunReport> {
  const resolvedHub = path.resolve(hubRoot);
  const queue = await loadQueue(resolvedHub);

  let eligible = 0;
  let skipped = 0;
  let alreadyMigrated = 0;
  let activeBlocked = 0;
  const details: DryRunEntryDetail[] = [];

  for (const entry of queue.entries) {
    const id = entry.id || "unknown";
    const projectId = entry.projectId || "unknown";
    const metadata = isRecord(entry.metadata) ? entry.metadata as Record<string, unknown> : undefined;

    if (isActiveEntry(entry)) {
      if (!opts.forceActiveBypass) {
        activeBlocked++;
        details.push({ id, projectId, action: "skip-active", reason: `status=${entry.status}` });
        continue;
      }
    }

    if (isQueueEntryMigrated(metadata)) {
      if (!hasStaleV1QueueMetadata(metadata)) {
        alreadyMigrated++;
        details.push({ id, projectId, action: "skip-migrated" });
        continue;
      }
    }

    if (!hasStaleV1QueueMetadata(metadata)) {
      skipped++;
      details.push({ id, projectId, action: "skip-clean" });
      continue;
    }

    eligible++;
    details.push({ id, projectId, action: "migrate" });
  }

  return {
    target: "queue",
    hubRoot: resolvedHub,
    eligible,
    skipped,
    alreadyMigrated,
    activeBlocked,
    details,
  };
}

// ─── Registry dry-run inspection ────────────────────────────────────────────

export async function inspectRegistryForMigration(
  hubRoot: string,
): Promise<DryRunReport> {
  const resolvedHub = path.resolve(hubRoot);
  const registry = await loadRegistry(resolvedHub);

  let eligible = 0;
  let skipped = 0;
  let alreadyMigrated = 0;
  const details: DryRunEntryDetail[] = [];

  for (const [id, project] of Object.entries(registry.projects)) {
    const metadata = isRecord((project as Record<string, unknown>).metadata)
      ? (project as Record<string, unknown>).metadata as Record<string, unknown>
      : undefined;

    if (isRegistryProjectMigrated(metadata)) {
      alreadyMigrated++;
      details.push({ id, projectId: id, action: "skip-migrated" });
      continue;
    }

    if (!hasStaleV1RegistryMetadata(metadata)) {
      skipped++;
      details.push({ id, projectId: id, action: "skip-clean" });
      continue;
    }

    eligible++;
    details.push({ id, projectId: id, action: "migrate" });
  }

  return {
    target: "registry",
    hubRoot: resolvedHub,
    eligible,
    skipped,
    alreadyMigrated,
    activeBlocked: 0,
    details,
  };
}

// ─── Full dry-run ───────────────────────────────────────────────────────────

export async function dryRunMigration(
  hubRoot?: string,
  target: MigrationTarget = "all",
): Promise<DryRunReport[]> {
  const resolved = path.resolve(hubRoot || resolveHubRoot());
  const reports: DryRunReport[] = [];

  if (target === "queue" || target === "all") {
    reports.push(await inspectQueueForMigration(resolved));
  }
  if (target === "registry" || target === "all") {
    reports.push(await inspectRegistryForMigration(resolved));
  }

  return reports;
}

// ─── Locked queue transform ─────────────────────────────────────────────────

/**
 * Transform queue entries in-place under the queue lock.  Called from
 * `withQueueLockForMigration` in hub-queue.ts.
 *
 * The callback receives the mutable queue snapshot.  The lock owner handles
 * persistence.
 */
export function applyQueueMigration(
  queue: { entries: Array<Record<string, unknown>> },
  opts: { forceActiveBypass?: boolean } = {},
): { migrated: number; skipped: number; alreadyMigrated: number; activeBlocked: number } {
  let migrated = 0;
  let skipped = 0;
  let alreadyMigrated = 0;
  let activeBlocked = 0;

  for (const entry of queue.entries) {
    const metadata = isRecord(entry.metadata) ? entry.metadata as Record<string, unknown> : undefined;

    if (isActiveEntry(entry as Parameters<typeof isActiveEntry>[0])) {
      if (!opts.forceActiveBypass) {
        activeBlocked++;
        continue;
      }
    }

    if (isQueueEntryMigrated(metadata) && !hasStaleV1QueueMetadata(metadata)) {
      alreadyMigrated++;
      continue;
    }

    if (!hasStaleV1QueueMetadata(metadata)) {
      skipped++;
      continue;
    }

    entry.metadata = transformQueueMetadata(metadata!);
    migrated++;
  }

  return { migrated, skipped, alreadyMigrated, activeBlocked };
}

// ─── Locked registry transform ──────────────────────────────────────────────

/**
 * Transform registry projects in-place under the registry lock.  Called from
 * `mutateRegistryForMigration` in hub-registry.ts.
 *
 * The callback receives the mutable registry snapshot.  The lock owner handles
 * persistence.
 */
export function applyRegistryMigration(
  registry: { projects: Record<string, Record<string, unknown>> },
): { migrated: number; skipped: number; alreadyMigrated: number } {
  let migrated = 0;
  let skipped = 0;
  let alreadyMigrated = 0;

  for (const [, project] of Object.entries(registry.projects)) {
    const metadata = isRecord(project.metadata) ? project.metadata as Record<string, unknown> : undefined;

    if (isRegistryProjectMigrated(metadata)) {
      alreadyMigrated++;
      continue;
    }

    if (!hasStaleV1RegistryMetadata(metadata)) {
      skipped++;
      continue;
    }

    project.metadata = transformRegistryProjectMetadata(metadata!);
    migrated++;
  }

  return { migrated, skipped, alreadyMigrated };
}

// ─── High-level orchestrator ────────────────────────────────────────────────

/**
 * Run the full migration pipeline.  In dry-run mode (default), returns
 * inspection reports without acquiring locks or mutating data.  In live
 * mode, acquires the appropriate lock for each target, writes a backup,
 * applies the transform, and commits.
 */
export async function runLocalCodeIndexV2Migration(
  opts: MigrateOptions = {},
): Promise<{ dryRun?: DryRunReport[]; results?: MigrationResult[] }> {
  const hubRoot = path.resolve(opts.hubRoot || resolveHubRoot());
  const target = opts.target || "all";
  const dryRun = opts.dryRun !== false;

  if (dryRun) {
    return { dryRun: await dryRunMigration(hubRoot, target) };
  }

  const results: MigrationResult[] = [];

  if (target === "queue" || target === "all") {
    results.push(await migrateQueueWithLock(hubRoot, {
      forceActiveBypass: opts.forceActiveBypass,
    }));
  }

  if (target === "registry" || target === "all") {
    results.push(await migrateRegistryWithLock(hubRoot));
  }

  return { results };
}

// ─── Queue lock wrapper ─────────────────────────────────────────────────────

/**
 * Queue migration entry point.  Acquires the queue lock, rereads, writes a
 * backup, applies the transform, and lets the lock commit.
 */
export async function migrateQueueWithLock(
  hubRoot: string,
  opts: { forceActiveBypass?: boolean } = {},
): Promise<MigrationResult> {
  const resolvedHub = path.resolve(hubRoot);

  // Pre-lock: refuse early if active mutating work exists
  if (!opts.forceActiveBypass) {
    const activeCount = await countActiveMutatingEntries(resolvedHub);
    if (activeCount > 0) {
      return {
        target: "queue",
        hubRoot: resolvedHub,
        migrated: 0,
        skipped: 0,
        alreadyMigrated: 0,
        activeBlocked: activeCount,
        backupPath: null,
        timestamp: nowIso(),
      };
    }
  }

  // Pre-lock backup of current state
  const preLockQueue = await loadQueue(resolvedHub);
  const hasV1 = preLockQueue.entries.some((e) => {
    const meta = isRecord(e.metadata) ? e.metadata as Record<string, unknown> : undefined;
    return hasStaleV1QueueMetadata(meta);
  });

  let backupPath: string | null = null;
  if (hasV1) {
    backupPath = await writeBackup(
      resolvedHub,
      "queue",
      JSON.stringify({ version: 1, entries: preLockQueue.entries }, null, 2),
    );
  }

  // Delegate to the locked entry point in hub-queue.ts
  const { withQueueLockForMigration } = await import("../hub/hub-queue.js");
  const transformResult = await withQueueLockForMigration(resolvedHub, async (queue) => {
    return applyQueueMigration(queue as unknown as { entries: Array<Record<string, unknown>> }, opts);
  });

  return {
    target: "queue" as const,
    hubRoot: resolvedHub,
    migrated: transformResult.migrated,
    skipped: transformResult.skipped,
    alreadyMigrated: transformResult.alreadyMigrated,
    activeBlocked: transformResult.activeBlocked,
    backupPath,
    timestamp: nowIso(),
  };
}

// ─── Registry lock wrapper ──────────────────────────────────────────────────

/**
 * Registry migration entry point.  Acquires the registry lock, rereads,
 * checks for active work, writes a backup, applies the transform, and commits.
 */
export async function migrateRegistryWithLock(
  hubRoot: string,
): Promise<MigrationResult> {
  const resolvedHub = path.resolve(hubRoot);

  // Pre-lock: refuse if active queue work exists
  const activeCount = await countActiveMutatingEntries(resolvedHub);
  if (activeCount > 0) {
    return {
      target: "registry",
      hubRoot: resolvedHub,
      migrated: 0,
      skipped: 0,
      alreadyMigrated: 0,
      activeBlocked: activeCount,
      backupPath: null,
      timestamp: nowIso(),
    };
  }

  // Pre-lock backup
  const preLockRegistry = await loadRegistry(resolvedHub);
  const hasV1 = Object.values(preLockRegistry.projects).some((p) => {
    const meta = isRecord((p as Record<string, unknown>).metadata)
      ? (p as Record<string, unknown>).metadata as Record<string, unknown>
      : undefined;
    return hasStaleV1RegistryMetadata(meta);
  });

  let backupPath: string | null = null;
  if (hasV1) {
    backupPath = await writeBackup(
      resolvedHub,
      "registry",
      JSON.stringify(preLockRegistry, null, 2),
    );
  }

  // Delegate to the locked entry point in hub-registry.ts
  const { mutateRegistryForMigration } = await import("../hub/hub-registry.js");
  const transformResult = await mutateRegistryForMigration(resolvedHub, (registry) => {
    return applyRegistryMigration(registry as unknown as { projects: Record<string, Record<string, unknown>> });
  });

  return {
    target: "registry" as const,
    hubRoot: resolvedHub,
    migrated: transformResult.migrated,
    skipped: transformResult.skipped,
    alreadyMigrated: transformResult.alreadyMigrated,
    activeBlocked: 0,
    backupPath,
    timestamp: nowIso(),
  };
}
