import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { recordValue, type LooseRecord } from "../../../shared/types.js";
import {
  acquireHubMaintenance,
  fsyncDirectory,
  hubRestoreJournalPath,
  recoverStaleHubMaintenance,
  removeDurable,
  writeJsonDurableAtomic,
} from "../../../shared/hub-maintenance.js";
import { readLeaderStatus } from "../../orchestrator/leader-lock.js";
import { listProjects, readHubLiveness } from "./hub-registry.js";
import {
  openPinnedHubRedisStateBackend,
  type HubRedisStateBackend,
  type RedisLogicalSnapshot,
} from "../../../shared/hub-state-redis.js";

const BACKUP_FORMAT = "cpb-hub-backup/v1";
const MAX_BACKUP_ENTRIES = 500_000;
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_PATH_BYTES = 4096;
const MAX_MANIFEST_PATH_DEPTH = 256;
const MAX_REDIS_SNAPSHOT_BYTES = 300 * 1024 * 1024;
const DEFAULT_MINIMUM_FREE_BYTES = 256 * 1024 * 1024;
const COPY_SPACE_FIXED_OVERHEAD_BYTES = 16 * 1024 * 1024;
const COPY_SPACE_PER_ENTRY_BYTES = 8 * 1024;

type BackupEntryType = "directory" | "file";

export type HubBackupEntry = {
  rootId: string;
  path: string;
  type: BackupEntryType;
  mode: number;
  mtimeMs: number;
  size?: number;
  sha256?: string;
};

export type HubBackupRoot = {
  id: string;
  kind: "hub" | "project-runtime";
  projectId?: string;
  sourcePath: string;
  mode: number;
  entryCount: number;
};

export type HubBackupManifest = {
  format: typeof BACKUP_FORMAT;
  snapshotId: string;
  createdAt: string;
  sourceHubRoot: string;
  roots: HubBackupRoot[];
  entries: HubBackupEntry[];
  fileCount: number;
  totalBytes: number;
  redisSnapshot?: HubBackupRedisSnapshot;
};

export type HubBackupRedisSnapshot = {
  format: "cpb-hub-redis-logical-snapshot/v1";
  rootId: "hub";
  path: string;
  backendIdentityFingerprint: string;
  capturedAt: string;
  logicalSha256: string;
  fileSha256: string;
};

type SourceNode = {
  path: string;
  type: BackupEntryType;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  size: number;
};

type SourceRoot = {
  id: string;
  kind: HubBackupRoot["kind"];
  projectId?: string;
  sourcePath: string;
};

type InspectedSourceRoot = {
  source: SourceRoot;
  rootInfo: Stats;
  nodes: SourceNode[];
};

type BackupStageOwner = {
  format: "cpb-hub-backup-stage/v1";
  hubRoot: string;
  output: string;
  createdAt: string;
};

type VerifiedBackup = {
  backupRoot: string;
  manifest: HubBackupManifest;
};

type BackupVerificationOptions = {
  signingKey?: string;
  requireSignature?: boolean;
  allowUnsignedDev?: boolean;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function normalizeSigningKey(value: unknown) {
  const key = String(value || "");
  if (!key) return "";
  if (key.trim() !== key || /\s/.test(key) || Buffer.byteLength(key, "utf8") < 32) {
    throw new Error("CPB Hub backup signing key must contain at least 32 non-whitespace bytes");
  }
  return key;
}

async function pathExists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertRealDirectory(filePath: string, label: string) {
  const info = await lstat(filePath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${filePath}`);
  }
  return info;
}

async function assertRealFile(filePath: string, label: string) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real file: ${filePath}`);
  }
  return info;
}

function isWithin(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeManifestPath(value: unknown) {
  const text = String(value || "");
  const parts = text.split("/");
  if (
    !text
    || Buffer.byteLength(text, "utf8") > MAX_MANIFEST_PATH_BYTES
    || parts.length > MAX_MANIFEST_PATH_DEPTH
    || text.includes("\\")
    || text.startsWith("/")
    || parts.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255)
  ) {
    throw new Error(`unsafe backup manifest path: ${text || "<empty>"}`);
  }
  return text;
}

function nativePath(root: string, relative: string) {
  return path.join(root, ...safeManifestPath(relative).split("/"));
}

async function sha256File(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fsyncFile(filePath: string) {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizeMinimumFreeBytes(value: unknown) {
  const configured = value === undefined
    ? process.env.CPB_HUB_MIN_FREE_BYTES
    : value;
  if (configured === undefined || configured === "") return DEFAULT_MINIMUM_FREE_BYTES;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("CPB_HUB_MIN_FREE_BYTES must be a non-negative safe integer");
  }
  return parsed;
}

function estimatedCopyBytes(payloadBytes: bigint, entryCount: number) {
  return payloadBytes
    + BigInt(entryCount) * BigInt(COPY_SPACE_PER_ENTRY_BYTES)
    + BigInt(COPY_SPACE_FIXED_OVERHEAD_BYTES);
}

async function assertCopySpaceAvailable({
  directory,
  operation,
  payloadBytes,
  entryCount,
  minimumFreeBytes,
}: {
  directory: string;
  operation: string;
  payloadBytes: bigint;
  entryCount: number;
  minimumFreeBytes: unknown;
}) {
  const reserveBytes = BigInt(normalizeMinimumFreeBytes(minimumFreeBytes));
  const copyBytes = estimatedCopyBytes(payloadBytes, entryCount);
  let availableBytes: bigint;
  try {
    const filesystem = await statfs(directory, { bigint: true });
    availableBytes = filesystem.bavail * filesystem.bsize;
  } catch (error) {
    throw new Error(
      `cannot determine free disk space for ${operation} at ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const requiredBytes = copyBytes + reserveBytes;
  if (availableBytes < requiredBytes) {
    throw Object.assign(
      new Error(
        `insufficient disk space for ${operation} at ${directory}: `
        + `requires ${requiredBytes} available bytes (${copyBytes} copy estimate + ${reserveBytes} reserve), `
        + `found ${availableBytes}`,
      ),
      {
        code: "HUB_BACKUP_INSUFFICIENT_SPACE",
        availableBytes: availableBytes.toString(),
        copyBytes: copyBytes.toString(),
        requiredBytes: requiredBytes.toString(),
        reserveBytes: reserveBytes.toString(),
      },
    );
  }
  return { availableBytes, copyBytes, requiredBytes, reserveBytes };
}

async function walkRoot(root: string) {
  const nodes: SourceNode[] = [];
  async function visit(relativeDir: string) {
    const directory = relativeDir ? nativePath(root, relativeDir) : root;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relative = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`backup refuses symbolic link: ${absolute}`);
      if (info.isDirectory()) {
        nodes.push({
          path: relative,
          type: "directory",
          mode: info.mode & 0o777,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          dev: info.dev,
          ino: info.ino,
          size: 0,
        });
        await visit(relative);
      } else if (info.isFile()) {
        nodes.push({
          path: relative,
          type: "file",
          mode: info.mode & 0o777,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          dev: info.dev,
          ino: info.ino,
          size: info.size,
        });
      } else {
        throw new Error(`backup refuses non-file entry: ${absolute}`);
      }
      if (nodes.length > MAX_BACKUP_ENTRIES) {
        throw new Error(`Hub backup exceeds the ${MAX_BACKUP_ENTRIES} entry safety limit`);
      }
    }
  }
  await visit("");
  return nodes;
}

function fingerprint(nodes: SourceNode[]) {
  return JSON.stringify(nodes.map((node) => [
    node.path,
    node.type,
    node.mode,
    node.mtimeMs,
    node.ctimeMs,
    node.dev,
    node.ino,
    node.size,
  ]));
}

function rootFingerprint(info: Stats) {
  return JSON.stringify([
    info.mode & 0o777,
    info.mtimeMs,
    info.ctimeMs,
    info.dev,
    info.ino,
  ]);
}

async function inspectSourceRoot(source: SourceRoot): Promise<InspectedSourceRoot> {
  const rootInfo = await lstat(source.sourcePath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`backup root must be a real directory: ${source.sourcePath}`);
  }
  const nodes = await walkRoot(source.sourcePath);
  return { source, rootInfo, nodes };
}

async function copySourceRoot(inspected: InspectedSourceRoot, destination: string) {
  const { source, rootInfo, nodes: before } = inspected;
  await mkdir(destination, { recursive: false, mode: 0o700 });
  await chmod(destination, 0o700);
  const entries: HubBackupEntry[] = [];

  for (const node of before) {
    const sourcePath = nativePath(source.sourcePath, node.path);
    const targetPath = nativePath(destination, node.path);
    if (node.type === "directory") {
      await mkdir(targetPath, { recursive: false, mode: 0o700 });
      await chmod(targetPath, 0o700);
    } else {
      await copyFile(sourcePath, targetPath);
      await chmod(targetPath, node.mode);
      await utimes(targetPath, new Date(node.mtimeMs), new Date(node.mtimeMs));
      await fsyncFile(targetPath);
    }
    entries.push({
      rootId: source.id,
      path: node.path,
      type: node.type,
      mode: node.mode,
      mtimeMs: node.mtimeMs,
      ...(node.type === "file" ? {
        size: node.size,
        sha256: await sha256File(targetPath),
      } : {}),
    });
  }
  for (const node of before.filter((item) => item.type === "directory").reverse()) {
    const targetPath = nativePath(destination, node.path);
    await chmod(targetPath, node.mode);
    await utimes(targetPath, new Date(node.mtimeMs), new Date(node.mtimeMs));
    await fsyncDirectory(targetPath);
  }
  await chmod(destination, rootInfo.mode & 0o777);
  await fsyncDirectory(destination);

  return {
    root: {
      id: source.id,
      kind: source.kind,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      sourcePath: source.sourcePath,
      mode: rootInfo.mode & 0o777,
      entryCount: entries.length,
    } satisfies HubBackupRoot,
    entries,
    sourceFingerprint: fingerprint(before),
    sourceRootFingerprint: rootFingerprint(rootInfo),
  };
}

async function assertSourceUnchanged(
  source: SourceRoot,
  expectedFingerprint: string,
  expectedRootFingerprint: string,
  copiedEntries: HubBackupEntry[],
) {
  const currentRootInfo = await lstat(source.sourcePath);
  if (
    !currentRootInfo.isDirectory()
    || currentRootInfo.isSymbolicLink()
    || rootFingerprint(currentRootInfo) !== expectedRootFingerprint
  ) {
    throw new Error(`backup source root changed while snapshotting: ${source.sourcePath}`);
  }
  const currentNodes = await walkRoot(source.sourcePath);
  const current = fingerprint(currentNodes);
  if (current !== expectedFingerprint) {
    throw new Error(`backup source changed while snapshotting: ${source.sourcePath}`);
  }
  const copiedByPath = new Map(copiedEntries.map((entry) => [entry.path, entry]));
  for (const node of currentNodes) {
    if (node.type !== "file") continue;
    const copied = copiedByPath.get(node.path);
    const digest = await sha256File(nativePath(source.sourcePath, node.path));
    if (!copied?.sha256 || digest !== copied.sha256) {
      throw new Error(`backup source content changed while snapshotting: ${source.sourcePath}/${node.path}`);
    }
  }
}

function processAlive(pidValue: unknown) {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

async function readOptionalJsonRecord(filePath: string, label: string) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return recordValue(parsed);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new Error(`invalid ${label} record at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readJsonRegistryStrict(
  directory: string,
  acceptsName: (name: string) => boolean,
  label: string,
) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw new Error(`cannot inspect ${label} directory at ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const records: LooseRecord[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!acceptsName(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} record must be a real file: ${filePath}`);
    }
    const record = await readOptionalJsonRecord(filePath, label);
    if (!record) throw new Error(`${label} record disappeared during offline validation: ${filePath}`);
    records.push(record);
  }
  return records;
}

export async function assertHubBackupOffline(
  _cpbRoot: string,
  hubRoot: string,
  projectRuntimeRoots: string[],
  redisBackend: HubRedisStateBackend | null = null,
) {
  const reasons: string[] = [];
  const liveness = await readHubLiveness(hubRoot);
  if (liveness.alive) reasons.push(`Hub server pid ${liveness.pid} is alive`);
  if (!liveness.alive && liveness.reason === "read-error") {
    throw new Error(`cannot prove Hub is offline because its liveness state is unreadable: ${String(liveness.error || "unknown error")}`);
  }
  const leader = await readLeaderStatus(hubRoot);
  if (leader.status === "running") reasons.push(`orchestrator leader ${leader.hubId || leader.pid || "unknown"} is active`);

  const orchestrator = await readOptionalJsonRecord(path.join(hubRoot, "state", "orchestrator.json"), "orchestrator state");
  if (processAlive(orchestrator?.pid)) reasons.push(`orchestrator pid ${orchestrator?.pid} is alive`);
  const delegate = await readOptionalJsonRecord(path.join(hubRoot, "providers", "delegate", "delegate.lock"), "quota delegate lock");
  if (processAlive(delegate?.pid)) reasons.push(`quota delegate pid ${delegate?.pid} is alive`);

  const workers = await readJsonRegistryStrict(
    path.join(hubRoot, "workers", "registry"),
    (name) => name.startsWith("worker-") && name.endsWith(".json"),
    "worker registry",
  );
  for (const worker of workers) {
    if (processAlive(worker.pid)) reasons.push(`worker ${worker.workerId} pid ${worker.pid} is alive`);
  }

  if (redisBackend) {
    for (const { field, record } of await redisBackend.scanStateRecords("worker:")) {
      const worker = record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? record.data as LooseRecord
        : null;
      if (!worker || typeof worker.workerId !== "string" || !worker.workerId || typeof worker.status !== "string") {
        throw Object.assign(new Error(`cannot prove Hub is offline because Redis worker state is malformed: ${field}`), {
          code: "HUB_STATE_RECORD_INVALID",
        });
      }
      if (!["exited", "exhausted"].includes(worker.status)) {
        reasons.push(`Redis worker ${worker.workerId} is ${worker.status}`);
      }
    }
  }

  for (const dataRoot of projectRuntimeRoots) {
    const entries = await readJsonRegistryStrict(
      path.join(dataRoot, "processes"),
      (name) => name.endsWith(".json"),
      "project process registry",
    );
    for (const entry of entries) {
      const pids = [entry.pid, entry.runnerPid, ...(Array.isArray(entry.childPids) ? entry.childPids : [])];
      for (const pid of new Set(pids)) {
        if (processAlive(pid)) reasons.push(`project runtime process ${pid} is alive under ${dataRoot}`);
      }
    }
  }

  if (reasons.length > 0) {
    throw new Error(`Hub backup/restore requires an offline control plane:\n- ${reasons.join("\n- ")}`);
  }
}

async function sourceRootsForBackup(hubRoot: string) {
  const resolvedHubRoot = path.resolve(hubRoot);
  const roots: SourceRoot[] = [{ id: "hub", kind: "hub", sourcePath: resolvedHubRoot }];
  const projectRuntimeRoots: string[] = [];
  const projectIds = new Set<string>();
  for (const project of await listProjects(hubRoot)) {
    const record = recordValue(project);
    const projectId = String(record.id || "").trim();
    const runtimeRoot = typeof record.projectRuntimeRoot === "string" ? path.resolve(record.projectRuntimeRoot) : "";
    if (!projectId || !runtimeRoot) throw new Error(`registered project is missing id or projectRuntimeRoot: ${JSON.stringify(record)}`);
    if (projectIds.has(projectId)) throw new Error(`duplicate project id in Hub registry: ${projectId}`);
    if (!isWithin(resolvedHubRoot, runtimeRoot)) {
      throw new Error(`project runtime root escapes Hub backup boundary: ${projectId} (${runtimeRoot})`);
    }
    let runtimeInfo;
    try {
      runtimeInfo = await lstat(runtimeRoot);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        throw new Error(`registered project runtime root is missing: ${projectId} (${runtimeRoot})`);
      }
      throw error;
    }
    if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) {
      throw new Error(`registered project runtime root must be a real directory: ${projectId} (${runtimeRoot})`);
    }
    projectIds.add(projectId);
    projectRuntimeRoots.push(runtimeRoot);
  }
  return { roots, projectRuntimeRoots };
}

function manifestJson(manifest: HubBackupManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function cleanRedisLogicalSnapshotArtifacts(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  let removed = false;
  for (const name of await readdir(resolved).catch((): string[] => [])) {
    if (!/^\.cpb-redis-logical-snapshot-[a-f0-9-]{36}\.json$/.test(name)) continue;
    const filePath = path.join(resolved, name);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Hub refuses unsafe Redis logical snapshot artifact: ${filePath}`);
    }
    await rm(filePath, { force: true });
    removed = true;
  }
  if (removed) await fsyncDirectory(resolved);
}

function parseRedisLogicalSnapshot(raw: string, metadata: HubBackupRedisSnapshot): RedisLogicalSnapshot {
  if (Buffer.byteLength(raw, "utf8") > MAX_REDIS_SNAPSHOT_BYTES) throw new Error("Hub Redis logical snapshot exceeds its size limit");
  const value = recordValue(JSON.parse(raw));
  if (
    value.format !== "cpb-hub-redis-logical-snapshot/v1"
    || value.backendIdentityFingerprint !== metadata.backendIdentityFingerprint
    || value.capturedAt !== metadata.capturedAt
    || !Array.isArray(value.hashFields)
    || !Array.isArray(value.jobStreams)
    || typeof value.sha256 !== "string"
    || value.sha256 !== metadata.logicalSha256
  ) {
    throw new Error("Hub Redis logical snapshot metadata mismatch");
  }
  const hashFields: Array<[string, string]> = [];
  const fieldNames = new Set<string>();
  for (const tuple of value.hashFields) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== "string" || typeof tuple[1] !== "string"
      || fieldNames.has(tuple[0]) || tuple[0].startsWith("maintenance") || tuple[0] === "leaderToken") {
      throw new Error("Hub Redis logical snapshot contains an invalid hash field");
    }
    fieldNames.add(tuple[0]);
    hashFields.push([tuple[0], tuple[1]]);
  }
  if (hashFields.length > MAX_BACKUP_ENTRIES
    || JSON.stringify(hashFields.map(([field]) => field)) !== JSON.stringify([...fieldNames].sort())) {
    throw new Error("Hub Redis logical snapshot hash fields are not canonical");
  }
  const jobStreams: RedisLogicalSnapshot["jobStreams"] = [];
  const streamFields = new Set<string>();
  let eventCount = 0;
  for (const item of value.jobStreams) {
    const stream = recordValue(item);
    const field = String(stream.field || "");
    if (!field.startsWith("job:") || !fieldNames.has(field) || streamFields.has(field) || !Array.isArray(stream.events)
      || !stream.events.every((event) => typeof event === "string")) {
      throw new Error("Hub Redis logical snapshot contains an invalid job stream");
    }
    streamFields.add(field);
    eventCount += stream.events.length;
    if (eventCount > MAX_BACKUP_ENTRIES) throw new Error("Hub Redis logical snapshot contains too many events");
    jobStreams.push({ field, events: [...stream.events] as string[] });
  }
  const expectedJobFields = hashFields.filter(([field]) => field.startsWith("job:")).map(([field]) => field);
  if (JSON.stringify([...streamFields]) !== JSON.stringify(expectedJobFields)) {
    throw new Error("Hub Redis logical snapshot job stream set is incomplete");
  }
  const snapshotBody = {
    format: "cpb-hub-redis-logical-snapshot/v1" as const,
    backendIdentityFingerprint: metadata.backendIdentityFingerprint,
    capturedAt: metadata.capturedAt,
    hashFields,
    jobStreams,
  };
  const logicalSha256 = createHash("sha256").update(JSON.stringify(snapshotBody), "utf8").digest("hex");
  if (logicalSha256 !== metadata.logicalSha256) throw new Error("Hub Redis logical snapshot digest mismatch");
  return { ...snapshotBody, sha256: logicalSha256 };
}

type CreateHubBackupOptions = {
  cpbRoot: string;
  hubRoot: string;
  output: string;
  signingKey?: string;
  allowUnsignedDev?: boolean;
  minimumFreeBytes?: number;
  redisSnapshot?: HubBackupRedisSnapshot;
  redisBackend?: HubRedisStateBackend | null;
  beforeCommit?: () => Promise<void>;
};

function backupStagePaths(hubRoot: string, outputRoot: string) {
  const resolvedHubRoot = path.resolve(hubRoot);
  const resolvedOutput = path.resolve(outputRoot);
  const digest = createHash("sha256")
    .update(`${resolvedHubRoot}\0${resolvedOutput}`)
    .digest("hex")
    .slice(0, 16);
  const stage = path.join(path.dirname(resolvedOutput), `.${path.basename(resolvedOutput)}.cpb-stage-${digest}`);
  return { stage, owner: `${stage}.owner.json` };
}

async function readBackupStageOwner(ownerPath: string, hubRoot: string, outputRoot: string) {
  await assertRealFile(ownerPath, "Hub backup stage owner");
  let value: LooseRecord;
  try {
    value = recordValue(JSON.parse(await readFile(ownerPath, "utf8")));
  } catch (error) {
    throw new Error(`invalid Hub backup stage owner at ${ownerPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const expectedHubRoot = path.resolve(hubRoot);
  const expectedOutput = path.resolve(outputRoot);
  if (
    value.format !== "cpb-hub-backup-stage/v1"
    || value.hubRoot !== expectedHubRoot
    || value.output !== expectedOutput
    || !Number.isFinite(Date.parse(String(value.createdAt || "")))
  ) {
    throw new Error(`Hub backup refuses unowned or mismatched stage cleanup: ${ownerPath}`);
  }
  return value as BackupStageOwner;
}

async function cleanOwnedBackupStage(hubRoot: string, outputRoot: string) {
  const paths = backupStagePaths(hubRoot, outputRoot);
  const stageExists = await pathExists(paths.stage);
  const ownerExists = await pathExists(paths.owner);
  if (!stageExists && !ownerExists) return paths;
  if (!ownerExists) {
    throw new Error(`Hub backup refuses to remove an unowned stage directory: ${paths.stage}`);
  }
  await readBackupStageOwner(paths.owner, hubRoot, outputRoot);
  if (stageExists) {
    await assertRealDirectory(paths.stage, "Hub backup stage");
    await makeDirectoryTreeWritable(paths.stage);
    await rm(paths.stage, { recursive: true, force: true });
    await fsyncDirectory(path.dirname(paths.stage));
  }
  await removeDurable(paths.owner);
  return paths;
}

export async function createHubBackupUnlocked({
  cpbRoot,
  hubRoot,
  output,
  signingKey: signingKeyInput,
  allowUnsignedDev = false,
  minimumFreeBytes,
  redisSnapshot,
  redisBackend = null,
  beforeCommit,
}: CreateHubBackupOptions) {
  const resolvedHubRoot = path.resolve(hubRoot);
  const outputRoot = path.resolve(output);
  const { roots, projectRuntimeRoots } = await sourceRootsForBackup(resolvedHubRoot);
  if (roots.some((root) => isWithin(root.sourcePath, outputRoot))) {
    throw new Error("backup output must be outside every backed-up root");
  }
  if (await pathExists(outputRoot)) {
    const completedStage = backupStagePaths(resolvedHubRoot, outputRoot);
    if (!await pathExists(completedStage.stage) && await pathExists(completedStage.owner)) {
      await readBackupStageOwner(completedStage.owner, resolvedHubRoot, outputRoot);
      await removeDurable(completedStage.owner);
    }
    throw new Error(`backup output already exists: ${outputRoot}`);
  }
  await assertHubBackupOffline(cpbRoot, resolvedHubRoot, projectRuntimeRoots, redisBackend);

  const parent = path.dirname(outputRoot);
  const signingKey = normalizeSigningKey(signingKeyInput);
  if (!signingKey && !allowUnsignedDev) {
    throw new Error("CPB_HUB_BACKUP_SIGNING_KEY is required; unsigned backups need explicit development opt-in");
  }
  await mkdir(parent, { recursive: true });
  const inspectedRoots: InspectedSourceRoot[] = [];
  let payloadBytes = 0n;
  let entryCount = 0;
  for (const root of roots) {
    const inspected = await inspectSourceRoot(root);
    inspectedRoots.push(inspected);
    entryCount += inspected.nodes.length;
    payloadBytes += inspected.nodes.reduce(
      (sum, node) => sum + (node.type === "file" ? BigInt(node.size) : 0n),
      0n,
    );
  }
  if (payloadBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Hub backup payload exceeds the safe manifest byte limit");
  }
  const stagePaths = await cleanOwnedBackupStage(resolvedHubRoot, outputRoot);
  await assertCopySpaceAvailable({
    directory: parent,
    operation: "Hub backup",
    payloadBytes,
    entryCount,
    minimumFreeBytes,
  });
  const stageOwner: BackupStageOwner = {
    format: "cpb-hub-backup-stage/v1",
    hubRoot: resolvedHubRoot,
    output: outputRoot,
    createdAt: new Date().toISOString(),
  };
  await writeJsonDurableAtomic(stagePaths.owner, stageOwner);
  const stage = stagePaths.stage;
  const copied: Array<Awaited<ReturnType<typeof copySourceRoot>>> = [];
  try {
    await mkdir(path.join(stage, "data", "roots"), { recursive: true, mode: 0o700 });
    for (const inspected of inspectedRoots) {
      copied.push(await copySourceRoot(inspected, path.join(stage, "data", "roots", inspected.source.id)));
    }
    for (let index = 0; index < roots.length; index += 1) {
      await assertSourceUnchanged(
        roots[index],
        copied[index].sourceFingerprint,
        copied[index].sourceRootFingerprint,
        copied[index].entries,
      );
    }

    const entries = copied.flatMap((item) => item.entries)
      .sort((a, b) => `${a.rootId}/${a.path}`.localeCompare(`${b.rootId}/${b.path}`));
    const manifest: HubBackupManifest = {
      format: BACKUP_FORMAT,
      snapshotId: randomUUID(),
      createdAt: new Date().toISOString(),
      sourceHubRoot: resolvedHubRoot,
      roots: copied.map((item) => item.root),
      entries,
      fileCount: entries.filter((entry) => entry.type === "file").length,
      totalBytes: entries.reduce((sum, entry) => sum + (entry.size || 0), 0),
      ...(redisSnapshot ? { redisSnapshot } : {}),
    };
    const rawManifest = manifestJson(manifest);
    if (Buffer.byteLength(rawManifest, "utf8") > MAX_MANIFEST_BYTES) {
      throw new Error(`Hub backup manifest exceeds the ${MAX_MANIFEST_BYTES} byte safety limit`);
    }
    const manifestDigest = createHash("sha256").update(rawManifest).digest("hex");
    await writeFile(path.join(stage, "manifest.json"), rawManifest, { encoding: "utf8", mode: 0o600 });
    await writeFile(path.join(stage, "manifest.sha256"), `${manifestDigest}  manifest.json\n`, { encoding: "utf8", mode: 0o600 });
    if (signingKey) {
      const signature = createHmac("sha256", signingKey).update(rawManifest).digest("hex");
      await writeFile(path.join(stage, "manifest.hmac-sha256"), `${signature}  manifest.json\n`, { encoding: "utf8", mode: 0o600 });
    }
    await fsyncFile(path.join(stage, "manifest.json"));
    await fsyncFile(path.join(stage, "manifest.sha256"));
    if (signingKey) await fsyncFile(path.join(stage, "manifest.hmac-sha256"));
    await fsyncDirectory(path.join(stage, "data", "roots"));
    await fsyncDirectory(path.join(stage, "data"));
    await fsyncDirectory(stage);
    await verifyHubBackup(stage, { signingKey, requireSignature: Boolean(signingKey), allowUnsignedDev });
    await assertHubBackupOffline(cpbRoot, resolvedHubRoot, projectRuntimeRoots, redisBackend);
    if (beforeCommit) await beforeCommit();
    await rename(stage, outputRoot);
    await fsyncDirectory(parent);
    await removeDurable(stagePaths.owner);
    return { output: outputRoot, manifest };
  } catch (error) {
    try {
      await cleanOwnedBackupStage(resolvedHubRoot, outputRoot);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Hub backup failed and its owned stage could not be cleaned: ${stage}`,
      );
    }
    throw error;
  }
}

export async function createHubBackup(options: CreateHubBackupOptions) {
  const redis = await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot: options.hubRoot,
  });
  const maintenance = await acquireHubMaintenance(options.hubRoot, "Hub backup");
  const redisToken = redis ? `backup-${randomUUID()}` : null;
  const redisTtlMs = 3_600_000;
  let redisSnapshotPath: string | null = null;
  let renewTimer: NodeJS.Timeout | null = null;
  let renewInFlight = false;
  let renewalError: unknown = null;
  try {
    if (!redis || !redisToken) return await createHubBackupUnlocked(options);
    const acquired = await redis.acquireMaintenance(redisToken, "Hub backup", redisTtlMs);
    if (!acquired.acquired) {
      throw Object.assign(new Error("another Hub Redis maintenance operation is active"), { code: "HUB_MAINTENANCE_ACTIVE" });
    }
    renewTimer = setInterval(() => {
      if (renewInFlight || renewalError) return;
      renewInFlight = true;
      void redis.renewMaintenance(redisToken, redisTtlMs)
        .then((result) => {
          if (!result.acquired) renewalError = Object.assign(new Error("Hub Redis maintenance lease was lost"), { code: "HUB_MAINTENANCE_ACTIVE" });
        })
        .catch((error) => { renewalError = error; })
        .finally(() => { renewInFlight = false; });
    }, 60_000);
    renewTimer.unref();

    await cleanRedisLogicalSnapshotArtifacts(options.hubRoot);

    const snapshot: RedisLogicalSnapshot = await redis.exportSnapshot(redisToken);
    const relativePath = `.cpb-redis-logical-snapshot-${randomUUID()}.json`;
    redisSnapshotPath = path.join(path.resolve(options.hubRoot), relativePath);
    const serialized = `${JSON.stringify(snapshot)}\n`;
    await writeFile(redisSnapshotPath, serialized, { encoding: "utf8", mode: 0o600 });
    await fsyncFile(redisSnapshotPath);
    await fsyncDirectory(path.resolve(options.hubRoot));
    const redisSnapshot: HubBackupRedisSnapshot = {
      format: snapshot.format,
      rootId: "hub",
      path: relativePath,
      backendIdentityFingerprint: snapshot.backendIdentityFingerprint,
      capturedAt: snapshot.capturedAt,
      logicalSha256: snapshot.sha256,
      fileSha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
    };
    return await createHubBackupUnlocked({
      ...options,
      redisSnapshot,
      redisBackend: redis,
      beforeCommit: async () => {
        if (renewalError) throw renewalError;
        const status = await redis.readMaintenance();
        if (!status.active || status.token !== redisToken) {
          throw Object.assign(new Error("Hub Redis maintenance lease was lost before backup commit"), { code: "HUB_MAINTENANCE_ACTIVE" });
        }
      },
    });
  } finally {
    try {
      if (renewTimer) clearInterval(renewTimer);
      if (redisSnapshotPath) {
        await rm(redisSnapshotPath, { force: true });
        await fsyncDirectory(path.resolve(options.hubRoot));
      }
      if (redis && redisToken) {
        const status = await redis.readMaintenance();
        if (status.active && status.token === redisToken && !(await redis.releaseMaintenance(redisToken))) {
          throw new Error("Hub backup lost Redis maintenance lock ownership");
        }
      }
    } finally {
      if (!(await maintenance.release())) {
        throw new Error(`Hub backup lost maintenance lock ownership: ${maintenance.lockPath}`);
      }
    }
  }
}

function parseManifest(raw: string): HubBackupManifest {
  const value = recordValue(JSON.parse(raw));
  if (value.format !== BACKUP_FORMAT) throw new Error(`unsupported Hub backup format: ${String(value.format || "missing")}`);
  if (!Array.isArray(value.roots) || !Array.isArray(value.entries)) throw new Error("invalid Hub backup manifest collections");
  const snapshotId = String(value.snapshotId || "");
  const createdAt = String(value.createdAt || "");
  const sourceHubRoot = String(value.sourceHubRoot || "");
  if (!snapshotId || !Number.isFinite(Date.parse(createdAt)) || !path.isAbsolute(sourceHubRoot)) {
    throw new Error("invalid Hub backup manifest identity");
  }
  const rawRoots = value.roots.map((item) => recordValue(item));
  if (value.entries.length > MAX_BACKUP_ENTRIES) {
    throw new Error(`Hub backup exceeds the ${MAX_BACKUP_ENTRIES} entry safety limit`);
  }
  const rawEntries = value.entries.map((item) => recordValue(item));
  const roots: HubBackupRoot[] = [];
  const rootIds = new Set<string>();
  for (const rawRoot of rawRoots) {
    const id = String(rawRoot.id || "");
    const kind = rawRoot.kind === "hub" ? "hub" : rawRoot.kind === "project-runtime" ? "project-runtime" : null;
    const projectId = typeof rawRoot.projectId === "string" ? rawRoot.projectId : undefined;
    const sourcePath = String(rawRoot.sourcePath || "");
    const mode = Number(rawRoot.mode);
    const entryCount = Number(rawRoot.entryCount);
    if (!/^(hub|project-[a-f0-9]{20})$/.test(id) || rootIds.has(id)) {
      throw new Error(`invalid or duplicate Hub backup root id: ${id}`);
    }
    rootIds.add(id);
    if (!kind || !path.isAbsolute(sourcePath)) throw new Error(`invalid backup root metadata: ${id}`);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error(`invalid root mode: ${id}`);
    if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > MAX_BACKUP_ENTRIES) throw new Error(`invalid root entry count: ${id}`);
    if (kind === "project-runtime" && !projectId) throw new Error(`project runtime root lacks projectId: ${id}`);
    roots.push({ id, kind, ...(projectId ? { projectId } : {}), sourcePath, mode, entryCount });
  }
  if (roots.length !== 1 || roots[0].id !== "hub" || roots[0].kind !== "hub") {
    throw new Error("Hub backup v1 must contain exactly one Hub root");
  }
  const entries: HubBackupEntry[] = [];
  const entryKeys = new Set<string>();
  for (const rawEntry of rawEntries) {
    const rootId = String(rawEntry.rootId || "");
    const entryPath = safeManifestPath(rawEntry.path);
    const type = rawEntry.type === "directory" ? "directory" : rawEntry.type === "file" ? "file" : null;
    const mode = Number(rawEntry.mode);
    const mtimeMs = Number(rawEntry.mtimeMs);
    const size = rawEntry.size === undefined ? undefined : Number(rawEntry.size);
    const sha256 = rawEntry.sha256 === undefined ? undefined : String(rawEntry.sha256);
    if (!rootIds.has(rootId)) throw new Error(`backup entry references unknown root: ${rootId}`);
    const key = `${rootId}/${entryPath}`;
    if (entryKeys.has(key)) throw new Error(`duplicate backup entry: ${key}`);
    entryKeys.add(key);
    if (!type) throw new Error(`invalid backup entry type: ${key}`);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777 || !Number.isFinite(mtimeMs)) throw new Error(`invalid backup entry metadata: ${key}`);
    if (type === "file" && (!Number.isSafeInteger(size) || Number(size) < 0 || !/^[a-f0-9]{64}$/.test(String(sha256 || "")))) {
      throw new Error(`invalid backup file metadata: ${key}`);
    }
    entries.push({
      rootId,
      path: entryPath,
      type,
      mode,
      mtimeMs,
      ...(type === "file" ? { size, sha256 } : {}),
    });
  }
  for (const root of roots) {
    if (entries.filter((entry) => entry.rootId === root.id).length !== Number(root.entryCount)) {
      throw new Error(`backup root entry count mismatch: ${root.id}`);
    }
  }
  const fileCount = Number(value.fileCount);
  const totalBytes = Number(value.totalBytes);
  if (!Number.isSafeInteger(fileCount) || fileCount < 0 || !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error("invalid Hub backup manifest totals");
  }
  let redisSnapshot: HubBackupRedisSnapshot | undefined;
  if (value.redisSnapshot !== undefined) {
    const rawSnapshot = recordValue(value.redisSnapshot);
    const snapshotPath = safeManifestPath(rawSnapshot.path);
    const backendIdentityFingerprint = String(rawSnapshot.backendIdentityFingerprint || "");
    const capturedAt = String(rawSnapshot.capturedAt || "");
    const logicalSha256 = String(rawSnapshot.logicalSha256 || "");
    const fileSha256 = String(rawSnapshot.fileSha256 || "");
    const snapshotEntry = entries.find((entry) => entry.rootId === "hub" && entry.path === snapshotPath && entry.type === "file");
    if (
      rawSnapshot.format !== "cpb-hub-redis-logical-snapshot/v1"
      || rawSnapshot.rootId !== "hub"
      || !/^[a-f0-9]{64}$/.test(backendIdentityFingerprint)
      || !Number.isFinite(Date.parse(capturedAt))
      || !/^[a-f0-9]{64}$/.test(logicalSha256)
      || !/^[a-f0-9]{64}$/.test(fileSha256)
      || !snapshotEntry
      || snapshotEntry.sha256 !== fileSha256
    ) {
      throw new Error("invalid Hub Redis snapshot manifest metadata");
    }
    redisSnapshot = {
      format: "cpb-hub-redis-logical-snapshot/v1",
      rootId: "hub",
      path: snapshotPath,
      backendIdentityFingerprint,
      capturedAt,
      logicalSha256,
      fileSha256,
    };
  }
  return {
    format: BACKUP_FORMAT,
    snapshotId,
    createdAt,
    sourceHubRoot,
    roots,
    entries,
    fileCount,
    totalBytes,
    ...(redisSnapshot ? { redisSnapshot } : {}),
  };
}

async function verifySnapshotRoot(rootPath: string, root: HubBackupRoot, expected: HubBackupEntry[]) {
  const info = await lstat(rootPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`backup data root is not a real directory: ${root.id}`);
  if ((info.mode & 0o777) !== root.mode) throw new Error(`backup data root mode mismatch: ${root.id}`);
  const actual = await walkRoot(rootPath);
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  if (actualByPath.size !== expectedByPath.size) throw new Error(`backup data entry count mismatch: ${root.id}`);
  for (const [relative, entry] of expectedByPath) {
    const found = actualByPath.get(relative);
    if (!found || found.type !== entry.type) throw new Error(`backup data entry missing or changed: ${root.id}/${relative}`);
    if (found.mode !== entry.mode) throw new Error(`backup data entry mode mismatch: ${root.id}/${relative}`);
    if (entry.type === "file") {
      if (found.size !== entry.size) throw new Error(`backup file size mismatch: ${root.id}/${relative}`);
      const digest = await sha256File(nativePath(rootPath, relative));
      if (digest !== entry.sha256) throw new Error(`backup file checksum mismatch: ${root.id}/${relative}`);
    }
  }
}

export async function verifyHubBackup(input: string, options: BackupVerificationOptions = {}): Promise<VerifiedBackup> {
  const backupRoot = path.resolve(input);
  await assertRealDirectory(backupRoot, "Hub backup");
  const signingKey = normalizeSigningKey(options.signingKey);
  const topLevel = (await readdir(backupRoot)).sort();
  const hasSignature = topLevel.includes("manifest.hmac-sha256");
  if ((options.requireSignature || Boolean(signingKey) || options.allowUnsignedDev !== true) && !hasSignature) {
    throw new Error("Hub backup signature is required but missing");
  }
  const expectedTopLevel = ["data", ...(hasSignature ? ["manifest.hmac-sha256"] : []), "manifest.json", "manifest.sha256"].sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(expectedTopLevel)) throw new Error("Hub backup top-level file set mismatch");
  const dataRoot = path.join(backupRoot, "data");
  const dataRoots = path.join(dataRoot, "roots");
  const manifestPath = path.join(backupRoot, "manifest.json");
  const checksumPath = path.join(backupRoot, "manifest.sha256");
  await assertRealDirectory(dataRoot, "Hub backup data directory");
  await assertRealDirectory(dataRoots, "Hub backup roots directory");
  const manifestInfo = await assertRealFile(manifestPath, "Hub backup manifest");
  if (manifestInfo.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Hub backup manifest exceeds the ${MAX_MANIFEST_BYTES} byte safety limit`);
  }
  await assertRealFile(checksumPath, "Hub backup manifest checksum");
  if (hasSignature) await assertRealFile(path.join(backupRoot, "manifest.hmac-sha256"), "Hub backup signature");
  const dataEntries = (await readdir(dataRoot)).sort();
  if (JSON.stringify(dataEntries) !== JSON.stringify(["roots"])) throw new Error("Hub backup data directory set mismatch");
  const rawManifest = await readFile(manifestPath, "utf8");
  const checksumText = (await readFile(checksumPath, "utf8")).trim();
  const expectedManifestDigest = checksumText.match(/^([a-f0-9]{64})  manifest\.json$/)?.[1];
  if (!expectedManifestDigest) throw new Error("invalid Hub backup manifest checksum file");
  const actualManifestDigest = createHash("sha256").update(rawManifest).digest("hex");
  if (actualManifestDigest !== expectedManifestDigest) throw new Error("Hub backup manifest checksum mismatch");
  if (hasSignature) {
    if (!signingKey) throw new Error("signed Hub backup requires CPB_HUB_BACKUP_SIGNING_KEY for verification");
    const signatureText = (await readFile(path.join(backupRoot, "manifest.hmac-sha256"), "utf8")).trim();
    const expectedSignature = signatureText.match(/^([a-f0-9]{64})  manifest\.json$/)?.[1];
    if (!expectedSignature) throw new Error("invalid Hub backup signature file");
    const actualSignature = createHmac("sha256", signingKey).update(rawManifest).digest("hex");
    if (!timingSafeEqual(Buffer.from(actualSignature, "hex"), Buffer.from(expectedSignature, "hex"))) {
      throw new Error("Hub backup signature mismatch");
    }
  }
  const manifest = parseManifest(rawManifest);

  const actualRootIds = (await readdir(dataRoots)).sort();
  const expectedRootIds = manifest.roots.map((root) => root.id).sort();
  if (JSON.stringify(actualRootIds) !== JSON.stringify(expectedRootIds)) throw new Error("Hub backup root set mismatch");
  for (const root of manifest.roots) {
    await verifySnapshotRoot(
      path.join(dataRoots, root.id),
      root,
      manifest.entries.filter((entry) => entry.rootId === root.id),
    );
  }
  if (manifest.redisSnapshot) {
    const snapshotPath = nativePath(path.join(dataRoots, "hub"), manifest.redisSnapshot.path);
    const snapshotInfo = await assertRealFile(snapshotPath, "Hub Redis logical snapshot");
    if (snapshotInfo.size > MAX_REDIS_SNAPSHOT_BYTES) throw new Error("Hub Redis logical snapshot exceeds its size limit");
    parseRedisLogicalSnapshot(await readFile(snapshotPath, "utf8"), manifest.redisSnapshot);
  }
  const fileCount = manifest.entries.filter((entry) => entry.type === "file").length;
  const totalBytes = manifest.entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
  if (fileCount !== manifest.fileCount || totalBytes !== manifest.totalBytes) throw new Error("Hub backup manifest totals mismatch");
  return { backupRoot, manifest };
}

async function redisSnapshotFromVerifiedBackup(verified: VerifiedBackup) {
  const metadata = verified.manifest.redisSnapshot;
  if (!metadata) return null;
  const snapshotPath = nativePath(path.join(verified.backupRoot, "data", "roots", "hub"), metadata.path);
  return parseRedisLogicalSnapshot(await readFile(snapshotPath, "utf8"), metadata);
}

async function readRedisRollbackSnapshot(journal: HubRestoreJournal) {
  if (!journal.redis) return null;
  const info = await assertRealFile(journal.redis.rollbackSnapshotPath, "Hub Redis rollback snapshot");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("Hub Redis rollback snapshot must be private");
  }
  if (info.size > MAX_REDIS_SNAPSHOT_BYTES) throw new Error("Hub Redis rollback snapshot exceeds its size limit");
  const parsed = JSON.parse(await readFile(journal.redis.rollbackSnapshotPath, "utf8")) as RedisLogicalSnapshot;
  if (parsed.sha256 !== journal.redis.rollbackLogicalSha256) throw new Error("Hub Redis rollback snapshot digest mismatch");
  return parsed;
}

type RedisRestoreRecoverySession = {
  backend: HubRedisStateBackend;
  token: string;
  rollback: RedisLogicalSnapshot;
  target: RedisLogicalSnapshot;
};

async function openRedisRestoreRecoverySession(journal: HubRestoreJournal, signingKey?: string): Promise<RedisRestoreRecoverySession | null> {
  if (!journal.redis) return null;
  const backend = await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot: journal.hubRoot,
  });
  if (!backend || backend.identityFingerprint !== journal.redis.backendIdentityFingerprint) {
    throw Object.assign(new Error("Hub Redis restore recovery backend identity is unavailable or changed"), {
      code: "HUB_STATE_BACKEND_IDENTITY_CHANGED",
    });
  }
  const acquired = await backend.acquireMaintenance(journal.redis.maintenanceToken, "Hub restore recovery", 3_600_000);
  if (!acquired.acquired) throw Object.assign(new Error("another Hub Redis maintenance operation is active"), { code: "HUB_MAINTENANCE_ACTIVE" });
  const rollback = await readRedisRollbackSnapshot(journal);
  if (!rollback) throw new Error("Hub Redis restore recovery rollback snapshot is missing");
  const verified = await verifyHubBackup(journal.input, {
    signingKey,
    requireSignature: journal.signatureRequired,
    allowUnsignedDev: !journal.signatureRequired,
  });
  const target = await redisSnapshotFromVerifiedBackup(verified);
  if (!target || target.sha256 !== journal.redis.targetLogicalSha256) {
    throw new Error("Hub Redis restore recovery target snapshot is missing or changed");
  }
  return { backend, token: journal.redis.maintenanceToken, rollback, target };
}

async function finishRedisRestoreRecovery(journal: HubRestoreJournal, session: RedisRestoreRecoverySession | null) {
  if (!session || !journal.redis) return;
  await removeDurable(journal.redis.rollbackSnapshotPath);
  const status = await session.backend.readMaintenance();
  if (status.active && status.token === session.token && !(await session.backend.releaseMaintenance(session.token))) {
    throw new Error("Hub Redis restore recovery lost maintenance lock ownership");
  }
}

async function copyBackupRoot(source: string, destination: string, root: HubBackupRoot, entries: HubBackupEntry[]) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  await chmod(destination, 0o700);
  for (const entry of entries) {
    const sourcePath = nativePath(source, entry.path);
    const targetPath = nativePath(destination, entry.path);
    if (entry.type === "directory") {
      await mkdir(targetPath, { recursive: false, mode: 0o700 });
      await chmod(targetPath, 0o700);
    } else {
      await copyFile(sourcePath, targetPath);
      await chmod(targetPath, entry.mode);
      await utimes(targetPath, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
      await fsyncFile(targetPath);
    }
  }
  for (const entry of entries.filter((item) => item.type === "directory").reverse()) {
    const targetPath = nativePath(destination, entry.path);
    await chmod(targetPath, entry.mode);
    await utimes(targetPath, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
    await fsyncDirectory(targetPath);
  }
  await chmod(destination, root.mode);
  await fsyncDirectory(destination);
  await verifySnapshotRoot(destination, root, entries);
}

type RestoreHubBackupOptions = {
  cpbRoot: string;
  hubRoot: string;
  input: string;
  force?: boolean;
  signingKey?: string;
  requireSignature?: boolean;
  allowUnsignedDev?: boolean;
  minimumFreeBytes?: number;
  redisBackend?: HubRedisStateBackend | null;
  redisToken?: string | null;
  faultInjector?: (phase: "redis_before_commit" | "redis_after_commit" | "filesystem_after_target_rename") => void | Promise<void>;
};

type RestoreJournalPhase = "staged" | "redis_restoring" | "redis_restored" | "target_moved" | "committed";

type RedisRestoreJournal = {
  backendIdentityFingerprint: string;
  maintenanceToken: string;
  rollbackSnapshotPath: string;
  rollbackLogicalSha256: string;
  targetLogicalSha256: string;
};

type HubRestoreJournal = {
  format: "cpb-hub-restore/v1";
  snapshotId: string;
  input: string;
  hubRoot: string;
  targetPath: string;
  stagePath: string;
  rollbackPath: string | null;
  targetExisted: boolean;
  signatureRequired: boolean;
  redis: RedisRestoreJournal | null;
  phase: RestoreJournalPhase;
  createdAt: string;
  updatedAt: string;
};

function restoreStagePrefix(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.restore-stage-`);
}

function restoreRollbackPrefix(hubRoot: string) {
  return `${path.resolve(hubRoot)}.pre-restore-`;
}

function failedRestorePrefix(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.failed-restore-`);
}

function redisRestoreRollbackPrefix(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.redis-rollback-`);
}

function parseRestoreJournal(raw: string, expectedHubRoot: string): HubRestoreJournal {
  const value = recordValue(JSON.parse(raw));
  const hubRoot = path.resolve(expectedHubRoot);
  const input = String(value.input || "");
  const targetPath = String(value.targetPath || "");
  const stagePath = String(value.stagePath || "");
  const rollbackPath = value.rollbackPath === null ? null : String(value.rollbackPath || "");
  const phase = value.phase === "staged" || value.phase === "redis_restoring" || value.phase === "redis_restored"
    || value.phase === "target_moved" || value.phase === "committed"
    ? value.phase
    : null;
  const rawRedis = value.redis === null || value.redis === undefined ? null : recordValue(value.redis);
  let redis: RedisRestoreJournal | null = null;
  if (rawRedis) {
    const rollbackSnapshotPath = String(rawRedis.rollbackSnapshotPath || "");
    if (!/^[a-f0-9]{64}$/.test(String(rawRedis.backendIdentityFingerprint || ""))
      || typeof rawRedis.maintenanceToken !== "string" || rawRedis.maintenanceToken.length < 16
      || !rollbackSnapshotPath.startsWith(redisRestoreRollbackPrefix(hubRoot))
      || path.dirname(rollbackSnapshotPath) !== path.dirname(hubRoot)
      || !/^[a-f0-9]{64}$/.test(String(rawRedis.rollbackLogicalSha256 || ""))
      || !/^[a-f0-9]{64}$/.test(String(rawRedis.targetLogicalSha256 || ""))) {
      throw new Error(`invalid Hub Redis restore journal: ${hubRestoreJournalPath(hubRoot)}`);
    }
    redis = {
      backendIdentityFingerprint: String(rawRedis.backendIdentityFingerprint),
      maintenanceToken: String(rawRedis.maintenanceToken),
      rollbackSnapshotPath,
      rollbackLogicalSha256: String(rawRedis.rollbackLogicalSha256),
      targetLogicalSha256: String(rawRedis.targetLogicalSha256),
    };
  }
  if (
    value.format !== "cpb-hub-restore/v1"
    || String(value.hubRoot || "") !== hubRoot
    || targetPath !== hubRoot
    || !path.isAbsolute(input)
    || isWithin(hubRoot, input)
    || isWithin(input, hubRoot)
    || !stagePath.startsWith(restoreStagePrefix(hubRoot))
    || path.dirname(stagePath) !== path.dirname(hubRoot)
    || (rollbackPath !== null && (!rollbackPath.startsWith(restoreRollbackPrefix(hubRoot)) || path.dirname(rollbackPath) !== path.dirname(hubRoot)))
    || (value.targetExisted === true && rollbackPath === null)
    || (value.targetExisted !== true && rollbackPath !== null)
    || typeof value.signatureRequired !== "boolean"
    || !phase
    || ((phase === "redis_restoring" || phase === "redis_restored") && !redis)
    || !String(value.snapshotId || "")
    || !Number.isFinite(Date.parse(String(value.createdAt || "")))
    || !Number.isFinite(Date.parse(String(value.updatedAt || "")))
  ) {
    throw new Error(`invalid Hub restore journal: ${hubRestoreJournalPath(hubRoot)}`);
  }
  return {
    format: "cpb-hub-restore/v1",
    snapshotId: String(value.snapshotId),
    input: path.resolve(input),
    hubRoot,
    targetPath,
    stagePath,
    rollbackPath,
    targetExisted: value.targetExisted === true,
    signatureRequired: value.signatureRequired,
    redis,
    phase,
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
  };
}

async function readRestoreJournal(hubRoot: string) {
  const journalPath = hubRestoreJournalPath(hubRoot);
  try {
    await assertRealFile(journalPath, "Hub restore journal");
    return parseRestoreJournal(await readFile(journalPath, "utf8"), hubRoot);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function writeRestoreJournal(journal: HubRestoreJournal, phase: RestoreJournalPhase) {
  const next = { ...journal, phase, updatedAt: new Date().toISOString() };
  await writeJsonDurableAtomic(hubRestoreJournalPath(journal.hubRoot), next);
  return next;
}

async function makeDirectoryTreeWritable(root: string) {
  if (!(await pathExists(root))) return;
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`restore stage must be a real directory: ${root}`);
  }
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`restore stage contains a symbolic link: ${path.join(root, entry.name)}`);
    if (entry.isDirectory()) await makeDirectoryTreeWritable(path.join(root, entry.name));
  }
}

async function removeRestoreStage(stagePath: string) {
  if (!(await pathExists(stagePath))) return;
  await makeDirectoryTreeWritable(stagePath);
  await rm(stagePath, { recursive: true, force: true });
  await fsyncDirectory(path.dirname(stagePath));
}

async function verifyRestoredTarget(journal: HubRestoreJournal, signingKey?: string) {
  const verified = await verifyHubBackup(journal.input, {
    signingKey,
    requireSignature: journal.signatureRequired,
    allowUnsignedDev: !journal.signatureRequired,
  });
  if (verified.manifest.snapshotId !== journal.snapshotId) {
    throw new Error(`restore journal snapshot mismatch: expected ${journal.snapshotId}`);
  }
  const root = verified.manifest.roots[0];
  await verifySnapshotRoot(
    journal.targetPath,
    root,
    verified.manifest.entries.filter((entry) => entry.rootId === root.id),
  );
}

async function rollBackInvalidReplacement(journal: HubRestoreJournal, reason: unknown) {
  const parent = path.dirname(journal.targetPath);
  const failedReplacementPath = `${failedRestorePrefix(journal.hubRoot)}${Date.now()}-${randomUUID()}`;
  await rename(journal.targetPath, failedReplacementPath);
  await fsyncDirectory(parent);
  if (journal.targetExisted) {
    if (!journal.rollbackPath || !(await pathExists(journal.rollbackPath))) {
      throw new Error("cannot roll back an invalid replacement because its previous root is missing");
    }
    await assertRealDirectory(journal.rollbackPath, "interrupted restore rollback");
    await rename(journal.rollbackPath, journal.targetPath);
    await fsyncDirectory(parent);
  }
  await removeDurable(hubRestoreJournalPath(journal.hubRoot));
  return {
    recovered: true,
    outcome: "rolled_back" as const,
    snapshotId: journal.snapshotId,
    failedReplacementPath,
    reason: reason instanceof Error ? reason.message : String(reason),
  };
}

async function recoverRestoreJournalCore(
  journal: HubRestoreJournal,
  signingKey: string | undefined,
  redisSession: RedisRestoreRecoverySession | null,
) {
  const targetExists = await pathExists(journal.targetPath);
  const stageExists = await pathExists(journal.stagePath);
  const rollbackExists = journal.rollbackPath ? await pathExists(journal.rollbackPath) : false;
  const parent = path.dirname(journal.targetPath);

  if (journal.phase === "staged" || journal.phase === "redis_restoring" || journal.phase === "redis_restored") {
    if (journal.phase !== "staged" && redisSession) {
      await redisSession.backend.restoreSnapshot(redisSession.token, redisSession.rollback);
    }
    if (journal.targetExisted && !targetExists) {
      if (!journal.rollbackPath || !rollbackExists) {
        throw new Error("interrupted restore lost both the target and rollback root");
      }
      await rename(journal.rollbackPath, journal.targetPath);
      await fsyncDirectory(parent);
    } else if (journal.targetExisted && targetExists) {
      await assertRealDirectory(journal.targetPath, "interrupted restore target");
    } else if (!journal.targetExisted && targetExists) {
      throw new Error("interrupted restore journal says the target was absent but a target now exists");
    } else if (journal.targetExisted && rollbackExists) {
      throw new Error("interrupted restore staged state has both target and rollback roots");
    }
    if (stageExists) await removeRestoreStage(journal.stagePath);
    await removeDurable(hubRestoreJournalPath(journal.hubRoot));
    return { recovered: true, outcome: "rolled_back" as const, snapshotId: journal.snapshotId };
  }

  if (journal.phase === "target_moved") {
    if (targetExists && !stageExists) {
      if (journal.targetExisted && !rollbackExists) {
        throw new Error("committed replacement exists but its required rollback root is missing");
      }
      try {
        await verifyRestoredTarget(journal, signingKey);
        if (redisSession) await redisSession.backend.restoreSnapshot(redisSession.token, redisSession.target);
      } catch (error) {
        if (redisSession) await redisSession.backend.restoreSnapshot(redisSession.token, redisSession.rollback);
        return rollBackInvalidReplacement(journal, error);
      }
      const committed = await writeRestoreJournal(journal, "committed");
      await removeDurable(hubRestoreJournalPath(committed.hubRoot));
      return { recovered: true, outcome: "committed" as const, snapshotId: journal.snapshotId };
    }
    if (targetExists && stageExists) {
      throw new Error("interrupted restore has both a target and an uncommitted stage");
    }
    if (journal.targetExisted) {
      if (!journal.rollbackPath || !rollbackExists) {
        throw new Error("interrupted restore cannot reapply the missing rollback root");
      }
      await assertRealDirectory(journal.rollbackPath, "interrupted restore rollback");
      await rename(journal.rollbackPath, journal.targetPath);
      await fsyncDirectory(parent);
    }
    if (redisSession) await redisSession.backend.restoreSnapshot(redisSession.token, redisSession.rollback);
    if (stageExists) await removeRestoreStage(journal.stagePath);
    await removeDurable(hubRestoreJournalPath(journal.hubRoot));
    return { recovered: true, outcome: "rolled_back" as const, snapshotId: journal.snapshotId };
  }

  if (!targetExists || stageExists) {
    throw new Error("committed restore journal does not match the filesystem state");
  }
  if (journal.targetExisted && !rollbackExists) {
    throw new Error("committed restore journal is missing its required rollback root");
  }
  try {
    await verifyRestoredTarget(journal, signingKey);
    if (redisSession) await redisSession.backend.restoreSnapshot(redisSession.token, redisSession.target);
  } catch (error) {
    if (redisSession) await redisSession.backend.restoreSnapshot(redisSession.token, redisSession.rollback);
    return rollBackInvalidReplacement(journal, error);
  }
  await removeDurable(hubRestoreJournalPath(journal.hubRoot));
  return { recovered: true, outcome: "committed" as const, snapshotId: journal.snapshotId };
}

async function recoverRestoreJournalUnlocked(journal: HubRestoreJournal, signingKey?: string) {
  const redisSession = await openRedisRestoreRecoverySession(journal, signingKey);
  let completed = false;
  try {
    const result = await recoverRestoreJournalCore(journal, signingKey, redisSession);
    completed = true;
    await finishRedisRestoreRecovery(journal, redisSession);
    return result;
  } finally {
    // Keep the Redis maintenance lease and rollback snapshot intact when
    // recovery is incomplete; the next recovery attempt resumes safely.
    if (!completed) void 0;
  }
}

async function restoreHubBackupUnlocked({
  cpbRoot,
  hubRoot,
  input,
  force = false,
  signingKey,
  requireSignature = false,
  allowUnsignedDev = false,
  minimumFreeBytes,
  redisBackend = null,
  redisToken = null,
  faultInjector,
}: RestoreHubBackupOptions) {
  const verified = await verifyHubBackup(input, { signingKey, requireSignature, allowUnsignedDev });
  const targetRedisSnapshot = await redisSnapshotFromVerifiedBackup(verified);
  if (redisBackend && (!targetRedisSnapshot || !redisToken)) {
    throw Object.assign(new Error("Redis-aware Hub restore requires an embedded logical snapshot and maintenance token"), {
      code: "HUB_RESTORE_REDIS_SNAPSHOT_REQUIRED",
    });
  }
  if (!redisBackend && targetRedisSnapshot) {
    throw Object.assign(new Error("Redis-backed Hub backup requires Redis configuration during restore"), {
      code: "HUB_RESTORE_REDIS_CONFIGURATION_REQUIRED",
    });
  }
  if (redisBackend && targetRedisSnapshot
    && targetRedisSnapshot.backendIdentityFingerprint !== redisBackend.identityFingerprint) {
    throw Object.assign(new Error("Redis restore target identity does not match the backup"), {
      code: "HUB_STATE_BACKEND_IDENTITY_CHANGED",
    });
  }
  const resolvedHubRoot = path.resolve(hubRoot);
  if (isWithin(resolvedHubRoot, verified.backupRoot) || isWithin(verified.backupRoot, resolvedHubRoot)) {
    throw new Error(`backup input and restore target must not overlap: ${resolvedHubRoot}`);
  }
  const root = verified.manifest.roots[0];
  const currentRuntimeRoots = (await listProjects(resolvedHubRoot))
    .map((project) => recordValue(project).projectRuntimeRoot)
    .filter((value): value is string => typeof value === "string")
    .map((value) => path.resolve(value));
  await assertHubBackupOffline(
    cpbRoot,
    resolvedHubRoot,
    currentRuntimeRoots,
    redisBackend,
  );

  const targetExisted = await pathExists(resolvedHubRoot);
  if (targetExisted) await assertRealDirectory(resolvedHubRoot, "restore target");
  if (targetExisted && !force) throw new Error("restore would replace 1 existing root(s); rerun with --force");

  const parent = path.dirname(resolvedHubRoot);
  await mkdir(parent, { recursive: true });
  await assertCopySpaceAvailable({
    directory: parent,
    operation: "Hub restore",
    payloadBytes: BigInt(verified.manifest.totalBytes),
    entryCount: verified.manifest.entries.length,
    minimumFreeBytes,
  });
  const stagePath = `${restoreStagePrefix(resolvedHubRoot)}${randomUUID()}`;
  const rollbackPath = targetExisted ? `${restoreRollbackPrefix(resolvedHubRoot)}${Date.now()}-${randomUUID()}` : null;
  const dataRoots = path.join(verified.backupRoot, "data", "roots");
  let rollbackRedisSnapshot: RedisLogicalSnapshot | null = null;
  let redisRollbackPath: string | null = null;
  if (redisBackend && redisToken && targetRedisSnapshot) {
    rollbackRedisSnapshot = await redisBackend.exportSnapshot(redisToken);
    redisRollbackPath = `${redisRestoreRollbackPrefix(resolvedHubRoot)}${verified.manifest.snapshotId}-${randomUUID()}.json`;
    await writeJsonDurableAtomic(redisRollbackPath, rollbackRedisSnapshot);
  }
  let journal: HubRestoreJournal = {
    format: "cpb-hub-restore/v1",
    snapshotId: verified.manifest.snapshotId,
    input: verified.backupRoot,
    hubRoot: resolvedHubRoot,
    targetPath: resolvedHubRoot,
    stagePath,
    rollbackPath,
    targetExisted,
    signatureRequired: !allowUnsignedDev || requireSignature || Boolean(normalizeSigningKey(signingKey)),
    redis: redisBackend && redisToken && targetRedisSnapshot && rollbackRedisSnapshot && redisRollbackPath ? {
      backendIdentityFingerprint: redisBackend.identityFingerprint,
      maintenanceToken: redisToken,
      rollbackSnapshotPath: redisRollbackPath,
      rollbackLogicalSha256: rollbackRedisSnapshot.sha256,
      targetLogicalSha256: targetRedisSnapshot.sha256,
    } : null,
    phase: "staged",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let journalCreated = false;
  const result = () => ({
    input: verified.backupRoot,
    snapshotId: verified.manifest.snapshotId,
    restoredRoots: [{
      id: root.id,
      projectId: root.projectId || null,
      targetPath: resolvedHubRoot,
      rollbackPath,
    }],
  });
  try {
    journal = await writeRestoreJournal(journal, "staged");
    journalCreated = true;
    await copyBackupRoot(
      path.join(dataRoots, root.id),
      stagePath,
      root,
      verified.manifest.entries.filter((entry) => entry.rootId === root.id),
    );

    if (redisBackend && redisToken && targetRedisSnapshot) {
      journal = await writeRestoreJournal(journal, "redis_restoring");
      await faultInjector?.("redis_before_commit");
      await redisBackend.restoreSnapshot(redisToken, targetRedisSnapshot);
      await faultInjector?.("redis_after_commit");
      journal = await writeRestoreJournal(journal, "redis_restored");
    }

    if (targetExisted && rollbackPath) {
      await rename(resolvedHubRoot, rollbackPath);
      await fsyncDirectory(parent);
    }
    journal = await writeRestoreJournal(journal, "target_moved");

    await rename(stagePath, resolvedHubRoot);
    await fsyncDirectory(parent);
    await faultInjector?.("filesystem_after_target_rename");
    journal = await writeRestoreJournal(journal, "committed");
    await removeDurable(hubRestoreJournalPath(resolvedHubRoot));
    if (redisRollbackPath) await removeDurable(redisRollbackPath);
    return result();
  } catch (error) {
    if (journalCreated) {
      try {
        const authoritative = await readRestoreJournal(resolvedHubRoot);
        if (!authoritative) throw new Error("restore journal disappeared during recovery");
        const recovery = await recoverRestoreJournalUnlocked(authoritative, signingKey);
        if (recovery.outcome === "committed") return result();
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `Hub restore failed and automatic recovery is incomplete; inspect ${hubRestoreJournalPath(resolvedHubRoot)}`,
        );
      }
    } else {
      await removeRestoreStage(stagePath).catch(() => undefined);
      if (redisRollbackPath) await removeDurable(redisRollbackPath).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!(await pathExists(hubRestoreJournalPath(resolvedHubRoot)))) {
      await removeRestoreStage(stagePath).catch(() => undefined);
    }
  }
}

export async function recoverInterruptedHubRestore({
  hubRoot,
  signingKey,
}: {
  hubRoot: string;
  signingKey?: string;
}) {
  const resolvedHubRoot = path.resolve(hubRoot);
  const pending = await readRestoreJournal(resolvedHubRoot);
  if (!pending) {
    await recoverStaleHubMaintenance(resolvedHubRoot);
    await cleanRedisLogicalSnapshotArtifacts(resolvedHubRoot);
    return { recovered: false as const };
  }
  const maintenance = await acquireHubMaintenance(resolvedHubRoot, "Hub restore recovery", {
    allowRestoreJournal: true,
  });
  try {
    const authoritative = await readRestoreJournal(resolvedHubRoot);
    if (!authoritative) return { recovered: false as const };
    return await recoverRestoreJournalUnlocked(authoritative, signingKey);
  } finally {
    if (!(await maintenance.release())) {
      throw new Error(`Hub restore recovery lost maintenance lock ownership: ${maintenance.lockPath}`);
    }
  }
}

export async function restoreHubBackup(options: RestoreHubBackupOptions) {
  const redis = await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot: options.hubRoot,
  });
  const resolvedHubRoot = path.resolve(options.hubRoot);
  const resolvedInput = path.resolve(options.input);
  if (isWithin(resolvedHubRoot, resolvedInput) || isWithin(resolvedInput, resolvedHubRoot)) {
    throw new Error(`backup input and restore target must not overlap: ${resolvedHubRoot}`);
  }
  await recoverInterruptedHubRestore({ hubRoot: resolvedHubRoot, signingKey: options.signingKey });
  const maintenance = await acquireHubMaintenance(options.hubRoot, "Hub restore");
  const redisToken = redis ? `restore-${randomUUID()}` : null;
  let redisOwned = false;
  try {
    if (redis && redisToken) {
      const acquired = await redis.acquireMaintenance(redisToken, "Hub restore", 3_600_000);
      if (!acquired.acquired) {
        throw Object.assign(new Error("another Hub Redis maintenance operation is active"), { code: "HUB_MAINTENANCE_ACTIVE" });
      }
      redisOwned = true;
    }
    return await restoreHubBackupUnlocked({ ...options, redisBackend: redis, redisToken });
  } finally {
    try {
      if (redis && redisToken && redisOwned && !(await pathExists(hubRestoreJournalPath(resolvedHubRoot)))) {
        const status = await redis.readMaintenance();
        if (status.active && status.token === redisToken && !(await redis.releaseMaintenance(redisToken))) {
          throw new Error("Hub restore lost Redis maintenance lock ownership");
        }
      }
    } finally {
      if (!(await maintenance.release())) {
        throw new Error(`Hub restore lost maintenance lock ownership: ${maintenance.lockPath}`);
      }
    }
  }
}
