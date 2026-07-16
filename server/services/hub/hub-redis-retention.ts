import { randomBytes } from "node:crypto";

import {
  openPinnedHubRedisStateBackend,
  type HubRedisStateBackend,
  type RedisStateRecord,
} from "../../../shared/hub-state-redis.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_JOB_RETENTION_MS = 30 * DAY_MS;
const DEFAULT_TOMBSTONE_RETENTION_MS = 90 * DAY_MS;
const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 10_000;
const MAINTENANCE_TTL_MS = 60 * 60 * 1_000;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "superseded"]);
const TOMBSTONE_PREFIXES = ["assignment:", "worker:", "workerInbox:", "lease:", "job:"];

type RetentionCandidate = {
  field: string;
  revision: number;
  status?: string;
  retainedAt?: string;
  deletedAt?: string | null;
};

export type HubRedisRetentionOptions = {
  hubRoot: string;
  before?: string | number | Date;
  tombstonesBefore?: string | number | Date;
  limit?: number;
  dryRun?: boolean;
};

export type HubRedisRetentionReport = {
  dryRun: boolean;
  serverTime: string;
  before: string;
  tombstonesBefore: string;
  limit: number;
  terminalJobs: RetentionCandidate[];
  tombstones: RetentionCandidate[];
  unstampedTombstones: RetentionCandidate[];
  skipped: Array<{ field: string; reason: string }>;
  result: {
    jobsPurged: number;
    tombstonesDeleted: number;
    tombstonesStamped: number;
    conflicts: number;
  };
};

function retentionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function cutoffMs(value: HubRedisRetentionOptions["before"], fallback: number, serverTimeMs: number, label: string) {
  const parsed = value === undefined
    ? fallback
    : value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > serverTimeMs) {
    throw retentionError("HUB_RETENTION_INVALID", `${label} must be a valid time no later than Redis server time`);
  }
  return parsed;
}

function retentionLimit(value: number | undefined) {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw retentionError("HUB_RETENTION_INVALID", `retention limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function latestRetentionTime(data: Record<string, unknown>) {
  const values = [
    data.updatedAt,
    data.lastActivityAt,
    data.completedAt,
    data.failedAt,
    data.blockedAt,
    data.cancelledAt,
    data.supersededAt,
  ].flatMap((value) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1_000_000_000_000) return [value];
    if (typeof value !== "string") return [];
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? [parsed] : [];
  });
  return values.length > 0 ? Math.max(...values) : null;
}

async function retentionBackend(hubRoot: string) {
  const backend = await openPinnedHubRedisStateBackend({ hubRoot });
  if (!backend) {
    throw retentionError("HUB_RETENTION_REDIS_REQUIRED", "Hub Redis retention requires a configured Redis state backend");
  }
  return backend;
}

async function scanTombstones(backend: HubRedisStateBackend) {
  const records = await Promise.all(TOMBSTONE_PREFIXES.map((prefix) => backend.scanStateRecords(prefix, true)));
  return records.flat().filter(({ record }) => record.data === null && record.revision > 0);
}

function tombstoneCandidate(field: string, record: RedisStateRecord): RetentionCandidate {
  return {
    field,
    revision: record.revision,
    deletedAt: Number.isSafeInteger(record.deletedAtMs)
      ? new Date(Number(record.deletedAtMs)).toISOString()
      : null,
  };
}

export async function runHubRedisRetention(options: HubRedisRetentionOptions): Promise<HubRedisRetentionReport> {
  if (!options?.hubRoot) throw retentionError("HUB_RETENTION_INVALID", "hubRoot is required");
  const backend = await retentionBackend(options.hubRoot);
  const serverTimeMs = await backend.serverTimeMs();
  const beforeMs = cutoffMs(options.before, serverTimeMs - DEFAULT_JOB_RETENTION_MS, serverTimeMs, "before");
  const tombstonesBeforeMs = cutoffMs(
    options.tombstonesBefore,
    serverTimeMs - DEFAULT_TOMBSTONE_RETENTION_MS,
    serverTimeMs,
    "tombstonesBefore",
  );
  const limit = retentionLimit(options.limit);
  const skipped: Array<{ field: string; reason: string }> = [];
  const terminalJobs: RetentionCandidate[] = [];
  const jobRecords = await backend.scanStateRecords("job:");
  for (const { field, record } of jobRecords) {
    const data = recordObject(record.data);
    const status = typeof data?.status === "string" ? data.status : "";
    if (!TERMINAL_JOB_STATUSES.has(status)) continue;
    const retainedAt = data ? latestRetentionTime(data) : null;
    if (retainedAt === null) {
      skipped.push({ field, reason: "terminal job has no valid retention timestamp" });
      continue;
    }
    if (retainedAt <= beforeMs) {
      terminalJobs.push({ field, revision: record.revision, status, retainedAt: new Date(retainedAt).toISOString() });
    }
  }
  terminalJobs.sort((left, right) => String(left.retainedAt).localeCompare(String(right.retainedAt))
    || left.field.localeCompare(right.field));
  terminalJobs.splice(limit);

  const tombstones: RetentionCandidate[] = [];
  const unstampedTombstones: RetentionCandidate[] = [];
  for (const { field, record } of await scanTombstones(backend)) {
    const candidate = tombstoneCandidate(field, record);
    if (candidate.deletedAt === null) unstampedTombstones.push(candidate);
    else if (Number(record.deletedAtMs) <= tombstonesBeforeMs) tombstones.push(candidate);
  }
  tombstones.sort((left, right) => String(left.deletedAt).localeCompare(String(right.deletedAt))
    || left.field.localeCompare(right.field));
  tombstones.splice(limit);
  unstampedTombstones.sort((left, right) => left.field.localeCompare(right.field));
  skipped.sort((left, right) => left.field.localeCompare(right.field));

  const report: HubRedisRetentionReport = {
    dryRun: options.dryRun !== false,
    serverTime: new Date(serverTimeMs).toISOString(),
    before: new Date(beforeMs).toISOString(),
    tombstonesBefore: new Date(tombstonesBeforeMs).toISOString(),
    limit,
    terminalJobs,
    tombstones,
    unstampedTombstones: unstampedTombstones.slice(0, limit),
    skipped,
    result: { jobsPurged: 0, tombstonesDeleted: 0, tombstonesStamped: 0, conflicts: 0 },
  };
  if (report.dryRun) return report;

  const token = `retention-${randomBytes(32).toString("base64url")}`;
  const acquired = await backend.acquireMaintenance(token, "Hub Redis retention", MAINTENANCE_TTL_MS);
  if (!acquired.acquired) {
    throw retentionError("HUB_MAINTENANCE_ACTIVE", "another Hub Redis maintenance operation is active");
  }
  try {
    for (const candidate of terminalJobs) {
      const result = await backend.purgeTerminalJob(token, candidate.field, candidate.revision);
      if (result.purged) report.result.jobsPurged += 1;
      else report.result.conflicts += 1;
    }
    for (const candidate of tombstones) {
      const result = await backend.deleteExpiredTombstone(
        token, candidate.field, candidate.revision, tombstonesBeforeMs,
      );
      if (result.deleted) report.result.tombstonesDeleted += 1;
      else report.result.conflicts += 1;
    }
    for (const candidate of report.unstampedTombstones) {
      const result = await backend.deleteExpiredTombstone(
        token, candidate.field, candidate.revision, tombstonesBeforeMs,
      );
      if (!result.deleted && !result.eligible && result.revision === candidate.revision) {
        report.result.tombstonesStamped += 1;
      } else {
        report.result.conflicts += 1;
      }
    }
    return report;
  } finally {
    await backend.releaseMaintenance(token).catch(() => false);
  }
}
