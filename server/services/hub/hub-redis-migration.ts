import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { randomUUID } from "node:crypto";
import { openHubRedisStateBackend, type RedisLogicalSnapshot } from "../../../shared/hub-state-redis.js";
import { acquireHubMaintenance, removeDurable, writeJsonDurableAtomic } from "../../../shared/hub-maintenance.js";
import { materializeJob } from "../event/event-store.js";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

type LooseRecord = Record<string, unknown>;

export type LocalRedisMigrationInventory = {
  projects: number;
  queueEntries: number;
  assignments: number;
  attempts: number;
  workers: number;
  inboxEntries: number;
  leases: number;
  jobs: number;
  jobEvents: number;
  runtimeRoots: string[];
  sourcePaths: string[];
};

function migrationError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function record(value: unknown, label: string): LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", `${label} must be an object`);
  }
  return value as LooseRecord;
}

async function exists(target: string) {
  try { await lstat(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJsonFile(target: string, label: string, maxBytes = MAX_JSON_BYTES) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", `${label} must be a real file`);
  }
  if (info.size > maxBytes) throw migrationError("HUB_REDIS_MIGRATION_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function part(value: unknown) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function stateEnvelope(data: unknown, revision = 1) {
  return JSON.stringify({ revision, data });
}

async function realDirectoryEntries(target: string, label: string) {
  if (!await exists(target)) return [];
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", `${label} must be a real directory`);
  }
  return readdir(target, { withFileTypes: true });
}

async function readLocalRegistry(hubRoot: string) {
  const target = path.join(hubRoot, "projects.json");
  if (!await exists(target)) {
    return { target, registry: { version: 1, revision: 0, updatedAt: new Date(0).toISOString(), projects: {} } };
  }
  const registry = record(await readJsonFile(target, "Hub project registry"), "Hub project registry");
  const projects = record(registry.projects || {}, "Hub project registry projects");
  const revision = Number(registry.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Hub project registry revision is invalid");
  }
  return { target, registry: { ...registry, projects, revision } };
}

async function readLocalQueue(hubRoot: string) {
  const target = path.join(hubRoot, "queue", "queue.json");
  if (!await exists(target)) return { target, queue: { version: 1, entries: [] as unknown[] } };
  const queue = record(await readJsonFile(target, "Hub queue"), "Hub queue");
  if (queue.version !== 1 || !Array.isArray(queue.entries)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Hub queue envelope is invalid");
  }
  return { target, queue: { version: 1, entries: queue.entries } };
}

async function captureAssignments(hubRoot: string, fields: Array<[string, string]>, sourcePaths: Set<string>) {
  const root = path.join(hubRoot, "assignments");
  const entries = await realDirectoryEntries(root, "assignment store");
  let assignments = 0;
  let attempts = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("a-")) continue;
    const assignmentRoot = path.join(root, entry.name);
    const statePath = path.join(assignmentRoot, "state.json");
    const state = record(await readJsonFile(statePath, `assignment ${entry.name}`), `assignment ${entry.name}`);
    if (state.assignmentId !== entry.name) {
      throw migrationError("HUB_REDIS_MIGRATION_INVALID", `assignment identity mismatch: ${entry.name}`);
    }
    const attemptRecords: Record<string, LooseRecord> = {};
    const attemptsRoot = path.join(assignmentRoot, "attempts");
    for (const attemptEntry of await realDirectoryEntries(attemptsRoot, `assignment ${entry.name} attempts`)) {
      if (!attemptEntry.isDirectory() || attemptEntry.isSymbolicLink() || !/^\d{3}$/.test(attemptEntry.name)) continue;
      const attempt = record(
        await readJsonFile(path.join(attemptsRoot, attemptEntry.name, "attempt.json"), `assignment ${entry.name} attempt ${attemptEntry.name}`),
        `assignment ${entry.name} attempt ${attemptEntry.name}`,
      );
      const attemptNumber = Number(attempt.attempt);
      if (attempt.assignmentId !== entry.name || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
        throw migrationError("HUB_REDIS_MIGRATION_INVALID", `assignment attempt identity mismatch: ${entry.name}/${attemptEntry.name}`);
      }
      attemptRecords[String(attemptNumber)] = attempt;
      attempts += 1;
    }
    fields.push([
      `assignment:${part(entry.name)}`,
      stateEnvelope({ input: { ...state }, state, attempts: attemptRecords }),
    ]);
    assignments += 1;
  }
  if (assignments > 0) sourcePaths.add(root);
  return { assignments, attempts, root };
}

async function captureWorkers(hubRoot: string, fields: Array<[string, string]>, sourcePaths: Set<string>) {
  const workersRoot = path.join(hubRoot, "workers");
  const registryRoot = path.join(workersRoot, "registry");
  const inboxRoot = path.join(workersRoot, "inbox");
  let workers = 0;
  let inboxEntries = 0;
  for (const entry of await realDirectoryEntries(registryRoot, "worker registry")) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const worker = record(await readJsonFile(path.join(registryRoot, entry.name), `worker ${entry.name}`), `worker ${entry.name}`);
    const workerId = String(worker.workerId || "");
    if (!workerId || !worker.incarnationToken || !worker.status) {
      throw migrationError("HUB_REDIS_MIGRATION_INVALID", `worker record is incomplete: ${entry.name}`);
    }
    fields.push([`worker:${part(workerId)}`, stateEnvelope(worker)]);
    workers += 1;
  }
  for (const workerEntry of await realDirectoryEntries(inboxRoot, "worker inbox")) {
    if (!workerEntry.isDirectory() || workerEntry.isSymbolicLink()) continue;
    const workerId = workerEntry.name;
    const captureDir = async (directory: string) => {
      for (const entry of await realDirectoryEntries(directory, `worker ${workerId} inbox`)) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
        const file = path.join(directory, entry.name);
        const payload = record(await readJsonFile(file, `worker ${workerId} inbox ${entry.name}`), `worker ${workerId} inbox ${entry.name}`);
        const assignmentId = String(payload.assignmentId || entry.name.slice(0, -5));
        const attempt = Number(payload.attempt);
        const attemptToken = typeof payload.attemptToken === "string" ? payload.attemptToken : "";
        const suffix = `${part(workerId)}:${part(assignmentId)}`
          + `${Number.isInteger(attempt) && attempt > 0 ? `:${attempt}` : ""}`
          + `${attemptToken ? `:${part(attemptToken)}` : ""}`;
        const info = await lstat(file);
        fields.push([`workerInbox:${suffix}`, stateEnvelope({
          workerId,
          assignmentId,
          status: "pending",
          payload,
          writtenAt: info.mtime.toISOString(),
          migratedFromProcessing: path.basename(directory) === "processing",
        })]);
        inboxEntries += 1;
      }
    };
    const workerInbox = path.join(inboxRoot, workerId);
    await captureDir(workerInbox);
    await captureDir(path.join(workerInbox, "processing"));
  }
  if (workers > 0 || inboxEntries > 0) sourcePaths.add(workersRoot);
  return { workers, inboxEntries, root: workersRoot };
}

async function captureRuntimeRoot(
  dataRoot: string,
  fields: Array<[string, string]>,
  jobStreams: RedisLogicalSnapshot["jobStreams"],
  seenJobs: Map<string, string>,
  sourcePaths: Set<string>,
) {
  let leases = 0;
  let jobs = 0;
  let jobEvents = 0;
  const leasesRoot = path.join(dataRoot, "leases");
  for (const entry of await realDirectoryEntries(leasesRoot, `leases at ${dataRoot}`)) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const leaseId = entry.name.slice(0, -5);
    const lease = record(await readJsonFile(path.join(leasesRoot, entry.name), `lease ${leaseId}`), `lease ${leaseId}`);
    if (lease.leaseId !== leaseId) throw migrationError("HUB_REDIS_MIGRATION_INVALID", `lease identity mismatch: ${leaseId}`);
    const expiresAtMs = Date.parse(String(lease.expiresAt || ""));
    fields.push([`lease:${part(leaseId)}`, stateEnvelope({ ...lease, expiresAtMs })]);
    leases += 1;
  }
  if (leases > 0) sourcePaths.add(leasesRoot);

  const eventsRoot = path.join(dataRoot, "events");
  for (const projectEntry of await realDirectoryEntries(eventsRoot, `events at ${dataRoot}`)) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink() || !SAFE_COMPONENT.test(projectEntry.name)) continue;
    for (const eventEntry of await realDirectoryEntries(path.join(eventsRoot, projectEntry.name), `events for ${projectEntry.name}`)) {
      if (!eventEntry.isFile() || eventEntry.isSymbolicLink() || !eventEntry.name.endsWith(".jsonl")) continue;
      const jobId = eventEntry.name.slice(0, -".jsonl".length);
      if (!SAFE_COMPONENT.test(jobId)) continue;
      const file = path.join(eventsRoot, projectEntry.name, eventEntry.name);
      const info = await lstat(file);
      if (info.size > 256 * 1024 * 1024) throw migrationError("HUB_REDIS_MIGRATION_TOO_LARGE", `job event log is too large: ${file}`);
      const raw = await readFile(file, "utf8");
      if (raw && !raw.endsWith("\n")) throw migrationError("HUB_REDIS_MIGRATION_INVALID", `job event log has a truncated tail: ${file}`);
      const events = raw.split("\n").filter(Boolean).map((line, index) => {
        try { return record(JSON.parse(line), `job event ${projectEntry.name}/${jobId}#${index + 1}`); }
        catch (error) { throw migrationError("HUB_REDIS_MIGRATION_INVALID", `invalid job event ${projectEntry.name}/${jobId}#${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
      });
      if (events.length === 0) continue;
      const projection = materializeJob(events as never[]);
      if (projection.project !== projectEntry.name || projection.jobId !== jobId || !projection.status) {
        throw migrationError("HUB_REDIS_MIGRATION_INVALID", `job projection identity mismatch: ${projectEntry.name}/${jobId}`);
      }
      const field = `job:${part(projectEntry.name)}:${part(jobId)}`;
      const serializedEvents = events.map((event) => JSON.stringify(event));
      const fingerprint = createHash("sha256").update(JSON.stringify(serializedEvents)).digest("hex");
      const prior = seenJobs.get(field);
      if (prior && prior !== fingerprint) {
        throw migrationError("HUB_REDIS_MIGRATION_CONFLICT", `duplicate job history differs across runtime roots: ${projectEntry.name}/${jobId}`);
      }
      if (prior) continue;
      seenJobs.set(field, fingerprint);
      fields.push([field, stateEnvelope(projection, events.length)]);
      jobStreams.push({ field, events: serializedEvents });
      jobs += 1;
      jobEvents += events.length;
    }
  }
  if (jobs > 0) sourcePaths.add(eventsRoot);
  return { leases, jobs, jobEvents };
}

export async function buildLocalRedisMigrationSnapshot(options: {
  cpbRoot: string;
  hubRoot: string;
  backendIdentityFingerprint: string;
}) {
  const cpbRoot = path.resolve(options.cpbRoot);
  const hubRoot = path.resolve(options.hubRoot);
  if (!/^[a-f0-9]{64}$/.test(options.backendIdentityFingerprint)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis backend identity fingerprint is invalid");
  }
  const fields: Array<[string, string]> = [];
  const jobStreams: RedisLogicalSnapshot["jobStreams"] = [];
  const sourcePaths = new Set<string>();
  const { target: registryTarget, registry } = await readLocalRegistry(hubRoot);
  const projects = record(registry.projects, "Hub project registry projects");
  fields.push(["revision", String(registry.revision)], ["data", JSON.stringify(registry)]);
  if (await exists(registryTarget)) sourcePaths.add(registryTarget);
  const { target: queueTarget, queue } = await readLocalQueue(hubRoot);
  fields.push(["queueRevision", "1"], ["queueData", JSON.stringify(queue)], ["leaderEpoch", "1"]);
  if (await exists(queueTarget)) sourcePaths.add(path.dirname(queueTarget));
  const assignmentCounts = await captureAssignments(hubRoot, fields, sourcePaths);
  const workerCounts = await captureWorkers(hubRoot, fields, sourcePaths);

  const runtimeRoots = new Set<string>();
  for (const project of Object.values(projects)) {
    const projectRecord = record(project, "Hub project");
    if (typeof projectRecord.projectRuntimeRoot === "string" && projectRecord.projectRuntimeRoot) {
      runtimeRoots.add(path.resolve(projectRecord.projectRuntimeRoot));
    }
  }
  const legacyRoot = path.join(cpbRoot, "cpb-task");
  if (await exists(legacyRoot)) runtimeRoots.add(legacyRoot);
  const seenJobs = new Map<string, string>();
  let leases = 0;
  let jobs = 0;
  let jobEvents = 0;
  for (const dataRoot of [...runtimeRoots].sort()) {
    const counts = await captureRuntimeRoot(dataRoot, fields, jobStreams, seenJobs, sourcePaths);
    leases += counts.leases;
    jobs += counts.jobs;
    jobEvents += counts.jobEvents;
  }
  fields.sort(([left], [right]) => left.localeCompare(right));
  jobStreams.sort((left, right) => left.field.localeCompare(right.field));
  const capturedAt = new Date().toISOString();
  const body = {
    format: "cpb-hub-redis-logical-snapshot/v1" as const,
    backendIdentityFingerprint: options.backendIdentityFingerprint,
    capturedAt,
    hashFields: fields,
    jobStreams,
  };
  const snapshot: RedisLogicalSnapshot = {
    ...body,
    sha256: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
  };
  const inventory: LocalRedisMigrationInventory = {
    projects: Object.keys(projects).length,
    queueEntries: queue.entries.length,
    assignments: assignmentCounts.assignments,
    attempts: assignmentCounts.attempts,
    workers: workerCounts.workers,
    inboxEntries: workerCounts.inboxEntries,
    leases,
    jobs,
    jobEvents,
    runtimeRoots: [...runtimeRoots].sort(),
    sourcePaths: [...sourcePaths].sort(),
  };
  return { snapshot, inventory };
}

const MIGRATION_FORMAT = "cpb-hub-redis-migration/v1";
const SNAPSHOT_FILE = "redis-logical-snapshot.json";
const RESULT_FILE = "migration-result.json";

type MigrationJournal = {
  format: typeof MIGRATION_FORMAT;
  migrationId: string;
  phase: "prepared" | "redis_committed";
  cpbRoot: string;
  hubRoot: string;
  output: string;
  backupPath: string;
  auditArchivePath: string | null;
  snapshotPath: string;
  snapshotSha256: string;
  backendIdentityFingerprint: string;
  inventory: LocalRedisMigrationInventory;
  createdAt: string;
  updatedAt: string;
};

export function hubRedisMigrationJournalPath(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.redis-migration.json`);
}

function businessState(value: RedisLogicalSnapshot) {
  return JSON.stringify({
    hashFields: value.hashFields.filter(([field]) => field !== "leaderEpoch"),
    jobStreams: value.jobStreams,
  });
}

function assertRetirementPaths(journal: MigrationJournal) {
  const allowed = new Set([
    path.join(journal.hubRoot, "projects.json"),
    path.join(journal.hubRoot, "queue"),
    path.join(journal.hubRoot, "assignments"),
    path.join(journal.hubRoot, "workers"),
    ...journal.inventory.runtimeRoots.flatMap((root) => [path.join(root, "leases"), path.join(root, "events")]),
  ].map((value) => path.resolve(value)));
  for (const source of journal.inventory.sourcePaths) {
    if (!allowed.has(path.resolve(source))) {
      throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", `migration journal contains an unsafe retirement path: ${source}`);
    }
  }
}

async function retireLocalAuthority(journal: MigrationJournal) {
  assertRetirementPaths(journal);
  for (const source of [...journal.inventory.sourcePaths].sort((left, right) => right.length - left.length)) {
    await rm(source, { recursive: true, force: true });
  }
}

async function withoutRedisEnvironment<T>(callback: () => Promise<T>) {
  const previous = process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
  delete process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
    else process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE = previous;
  }
}

async function commitMigration(
  backend: NonNullable<Awaited<ReturnType<typeof openHubRedisStateBackend>>>,
  snapshot: RedisLogicalSnapshot,
  operation: string,
) {
  const token = `migration-${randomUUID()}`;
  const acquired = await backend.acquireMaintenance(token, operation, 3_600_000);
  if (!acquired.acquired) throw migrationError("HUB_MAINTENANCE_ACTIVE", "another Redis maintenance operation is active");
  try {
    const current = await backend.exportSnapshot(token);
    const currentBusiness = businessState(current);
    const targetBusiness = businessState(snapshot);
    const empty = current.hashFields.every(([field]) => field === "leaderEpoch") && current.jobStreams.length === 0;
    if (currentBusiness !== targetBusiness && !empty) {
      throw migrationError("HUB_REDIS_MIGRATION_TARGET_NOT_EMPTY", "Redis business authority is neither empty nor the prepared migration snapshot");
    }
    const restored = currentBusiness === targetBusiness ? current : await backend.restoreSnapshot(token, snapshot);
    if (businessState(restored) !== targetBusiness) {
      throw migrationError("HUB_REDIS_MIGRATION_VERIFY_FAILED", "Redis business authority does not match the prepared migration snapshot");
    }
    return restored;
  } finally {
    const status = await backend.readMaintenance();
    if (status.active && status.token === token) await backend.releaseMaintenance(token);
  }
}

export async function migrateLocalHubToRedis(options: {
  cpbRoot: string;
  hubRoot: string;
  configFile: string;
  output: string;
  dryRun?: boolean;
  backupSigningKey?: string;
  auditSigningKey?: string;
  afterRedisCommit?: () => Promise<void>;
}) {
  const cpbRoot = path.resolve(options.cpbRoot);
  const hubRoot = path.resolve(options.hubRoot);
  const output = path.resolve(options.output);
  const relative = path.relative(hubRoot, output);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", "migration output must be outside the Hub root");
  }
  const journalPath = hubRedisMigrationJournalPath(hubRoot);
  if (await exists(journalPath)) {
    throw migrationError("HUB_REDIS_MIGRATION_RECOVERY_REQUIRED", `recover the interrupted Redis migration first: ${journalPath}`);
  }
  const backend = await openHubRedisStateBackend({ configFile: options.configFile, hubRoot });
  if (!backend) throw migrationError("HUB_REDIS_MIGRATION_CONFIG_REQUIRED", "Redis migration requires a state backend config file");
  await backend.preflight();
  const preview = await buildLocalRedisMigrationSnapshot({
    cpbRoot, hubRoot, backendIdentityFingerprint: backend.identityFingerprint,
  });
  if (options.dryRun !== false) return { dryRun: true as const, ...preview.inventory };
  if (!options.backupSigningKey) {
    throw migrationError("HUB_REDIS_MIGRATION_SIGNING_KEY_REQUIRED", "CPB_HUB_BACKUP_SIGNING_KEY is required for the migration rollback backup");
  }
  if (await exists(output)) throw migrationError("HUB_REDIS_MIGRATION_OUTPUT_EXISTS", "migration output already exists");
  await mkdir(output, { mode: 0o700 });

  const { inspectHubAccessAuditUsage } = await import("../audit/hub-access-audit.js");
  const { createHubAccessAuditArchive } = await import("../audit/hub-access-audit-archive.js");
  const auditUsage = await inspectHubAccessAuditUsage({ hubRoot });
  let auditArchivePath: string | null = null;
  if (auditUsage.sizeBytes > 0) {
    if (!options.auditSigningKey) {
      throw migrationError("HUB_REDIS_MIGRATION_SIGNING_KEY_REQUIRED", "CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY is required to archive the local audit chain");
    }
    auditArchivePath = path.join(output, "local-access-audit");
    await createHubAccessAuditArchive({
      hubRoot,
      output: auditArchivePath,
      signingKey: options.auditSigningKey,
    });
  }

  const maintenance = await acquireHubMaintenance(hubRoot, "Hub local-to-Redis migration");
  let journal: MigrationJournal | null = null;
  try {
    const { createHubBackupUnlocked } = await import("./hub-backup.js");
    const backupPath = path.join(output, "hub-backup");
    await withoutRedisEnvironment(() => createHubBackupUnlocked({
      cpbRoot,
      hubRoot,
      output: backupPath,
      signingKey: options.backupSigningKey,
    }));
    const prepared = await buildLocalRedisMigrationSnapshot({
      cpbRoot, hubRoot, backendIdentityFingerprint: backend.identityFingerprint,
    });
    const snapshotPath = path.join(output, SNAPSHOT_FILE);
    await writeJsonDurableAtomic(snapshotPath, prepared.snapshot);
    const now = new Date().toISOString();
    journal = {
      format: MIGRATION_FORMAT,
      migrationId: randomUUID(),
      phase: "prepared",
      cpbRoot,
      hubRoot,
      output,
      backupPath,
      auditArchivePath,
      snapshotPath,
      snapshotSha256: prepared.snapshot.sha256,
      backendIdentityFingerprint: backend.identityFingerprint,
      inventory: prepared.inventory,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonDurableAtomic(journalPath, journal);
    await commitMigration(backend, prepared.snapshot, "Hub local-to-Redis migration");
    await options.afterRedisCommit?.();
    journal = { ...journal, phase: "redis_committed", updatedAt: new Date().toISOString() };
    await writeJsonDurableAtomic(journalPath, journal);
    await retireLocalAuthority(journal);
    const result = {
      format: MIGRATION_FORMAT,
      migrationId: journal.migrationId,
      completedAt: new Date().toISOString(),
      backendIdentityFingerprint: backend.identityFingerprint,
      backupPath,
      auditArchivePath,
      snapshotSha256: prepared.snapshot.sha256,
      inventory: prepared.inventory,
    };
    await writeJsonDurableAtomic(path.join(output, RESULT_FILE), result);
    await removeDurable(journalPath);
    return { dryRun: false as const, output, ...result };
  } finally {
    if (!(await maintenance.release())) {
      throw migrationError("HUB_MAINTENANCE_INVALID", `migration lost local maintenance lock ownership: ${maintenance.lockPath}`);
    }
  }
}

function migrationJournal(value: unknown, expectedHubRoot: string): MigrationJournal {
  const raw = record(value, "Redis migration journal");
  const inventory = record(raw.inventory, "Redis migration inventory") as unknown as LocalRedisMigrationInventory;
  if (raw.format !== MIGRATION_FORMAT || typeof raw.migrationId !== "string"
    || !["prepared", "redis_committed"].includes(String(raw.phase))
    || path.resolve(String(raw.hubRoot || "")) !== expectedHubRoot
    || typeof raw.output !== "string" || typeof raw.snapshotPath !== "string"
    || typeof raw.backupPath !== "string" || typeof raw.snapshotSha256 !== "string"
    || typeof raw.backendIdentityFingerprint !== "string" || !Array.isArray(inventory.runtimeRoots)
    || !Array.isArray(inventory.sourcePaths)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration journal is invalid");
  }
  const output = path.resolve(raw.output);
  if (path.resolve(raw.snapshotPath) !== path.join(output, SNAPSHOT_FILE)
    || path.resolve(raw.backupPath) !== path.join(output, "hub-backup")
    || (raw.auditArchivePath !== null && path.resolve(String(raw.auditArchivePath)) !== path.join(output, "local-access-audit"))) {
    throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", "Redis migration journal artifact paths are invalid");
  }
  return {
    ...raw,
    phase: raw.phase as MigrationJournal["phase"],
    cpbRoot: path.resolve(String(raw.cpbRoot)),
    hubRoot: expectedHubRoot,
    output,
    backupPath: path.resolve(raw.backupPath),
    auditArchivePath: raw.auditArchivePath === null ? null : path.resolve(String(raw.auditArchivePath)),
    snapshotPath: path.resolve(raw.snapshotPath),
    inventory,
  } as MigrationJournal;
}

async function readMigrationSnapshot(journal: MigrationJournal) {
  const snapshot = await readJsonFile(journal.snapshotPath, "Redis migration snapshot", 300 * 1024 * 1024) as RedisLogicalSnapshot;
  if (snapshot.format !== "cpb-hub-redis-logical-snapshot/v1"
    || snapshot.backendIdentityFingerprint !== journal.backendIdentityFingerprint
    || snapshot.sha256 !== journal.snapshotSha256) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration snapshot identity is invalid");
  }
  const { sha256: _sha256, ...body } = snapshot;
  const digest = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
  if (digest !== snapshot.sha256) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration snapshot digest is invalid");
  }
  return snapshot;
}

export async function recoverHubRedisMigration(options: {
  hubRoot: string;
  configFile?: string;
  backupSigningKey?: string;
}) {
  const hubRoot = path.resolve(options.hubRoot);
  const journalPath = hubRedisMigrationJournalPath(hubRoot);
  if (!await exists(journalPath)) return { recovered: false as const };
  if (!options.configFile) {
    throw migrationError("HUB_REDIS_MIGRATION_CONFIG_REQUIRED", "interrupted Redis migration recovery requires the original Redis config file");
  }
  if (!options.backupSigningKey) {
    throw migrationError("HUB_REDIS_MIGRATION_SIGNING_KEY_REQUIRED", "migration recovery requires CPB_HUB_BACKUP_SIGNING_KEY");
  }
  const journal = migrationJournal(await readJsonFile(journalPath, "Redis migration journal", 1024 * 1024), hubRoot);
  const snapshot = await readMigrationSnapshot(journal);
  if (!await exists(journal.backupPath)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "verified rollback backup is missing during migration recovery");
  }
  const { verifyHubBackup } = await import("./hub-backup.js");
  await verifyHubBackup(journal.backupPath, {
    signingKey: options.backupSigningKey,
    requireSignature: true,
  });
  const backend = await openHubRedisStateBackend({ configFile: options.configFile, hubRoot });
  if (!backend || backend.identityFingerprint !== journal.backendIdentityFingerprint) {
    throw migrationError("HUB_REDIS_MIGRATION_CONFIG_MISMATCH", "Redis migration recovery backend identity does not match the journal");
  }
  await backend.preflight();
  const maintenance = await acquireHubMaintenance(hubRoot, "Hub Redis migration recovery");
  try {
    await commitMigration(backend, snapshot, "Hub Redis migration recovery");
    const committed: MigrationJournal = {
      ...journal,
      phase: "redis_committed",
      updatedAt: new Date().toISOString(),
    };
    await writeJsonDurableAtomic(journalPath, committed);
    await retireLocalAuthority(committed);
    const result = {
      format: MIGRATION_FORMAT,
      migrationId: committed.migrationId,
      completedAt: new Date().toISOString(),
      backendIdentityFingerprint: backend.identityFingerprint,
      backupPath: committed.backupPath,
      auditArchivePath: committed.auditArchivePath,
      snapshotSha256: snapshot.sha256,
      inventory: committed.inventory,
      recovered: true as const,
    };
    await writeJsonDurableAtomic(path.join(committed.output, RESULT_FILE), result);
    await removeDurable(journalPath);
    return result;
  } finally {
    if (!(await maintenance.release())) {
      throw migrationError("HUB_MAINTENANCE_INVALID", `migration recovery lost local maintenance lock ownership: ${maintenance.lockPath}`);
    }
  }
}
