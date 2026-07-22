import { createHash, randomUUID } from "node:crypto";
import { constants, fstatSync, lstatSync, realpathSync, renameSync, type Stats } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  sameProcessIdentity,
  type ProcessIdentity,
} from "./primitives/process-tree.js";
import { readBoundedRegularFileNoFollow } from "./primitives/durable-directory-lock.js";

const INCOMPLETE_LOCK_TTL_MS = 30_000;
const HUB_MAINTENANCE_OWNER_MAX_BYTES = 64 * 1024;

export type HubMaintenanceOwner = {
  format: "cpb-hub-maintenance/v1" | "cpb-hub-maintenance/v2";
  ownerToken: string;
  operation: string;
  hubRoot: string;
  pid: number;
  host: string;
  acquiredAt: string;
  processIdentity?: ProcessIdentity;
};

export type HubMaintenanceLease = {
  lockPath: string;
  owner: HubMaintenanceOwner;
  release: () => Promise<boolean>;
};

export type HubMaintenanceHooks = {
  afterRecoveryStateObserved?: (state: Awaited<ReturnType<typeof readHubMaintenance>>) => void | Promise<void>;
  beforeQuarantineRename?: (context: { lockPath: string; quarantinePath: string }) => void | Promise<void>;
  afterQuarantineRename?: (context: { lockPath: string; quarantinePath: string }) => void | Promise<void>;
  beforeQuarantineParentSync?: (context: {
    lockPath: string;
    quarantinePath: string;
    parent: string;
  }) => void | Promise<void>;
  beforeLockParentSync?: (context: { lockPath: string; ownerPath: string; parent: string }) => void | Promise<void>;
  captureProcessIdentity?: () => ProcessIdentity | null;
  isProcessIdentityAlive?: (identity: ProcessIdentity) => boolean;
};

type HubMaintenanceLockGeneration = {
  dev: number | bigint;
  ino: number | bigint;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type HubMaintenanceOptions = {
  allowRestoreJournal?: boolean;
  hooks?: HubMaintenanceHooks;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function canonicalHubRootPath(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  let cursor = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonicalPrefix = realpathSync.native(cursor);
      return path.join(canonicalPrefix, ...suffix.reverse());
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function namespacePath(hubRoot: string) {
  const resolved = canonicalHubRootPath(hubRoot);
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  const name = path.basename(resolved) || "root";
  return path.join(path.dirname(resolved), `.${name}.cpb-${digest}`);
}

export function hubMaintenanceLockPath(hubRoot: string) {
  return `${namespacePath(hubRoot)}.maintenance.lock`;
}

export function hubRestoreJournalPath(hubRoot: string) {
  return `${namespacePath(hubRoot)}.restore.json`;
}

const MAINTENANCE_FENCE_PROTOCOL = "cpb-hub-maintenance-fence/v2 ";
const MAINTENANCE_FENCE_MAX_RESPONSE_CHARS = 256;

function maintenanceFenceKey(hubRoot: string) {
  return createHash("sha256")
    .update(`${canonicalHubRootPath(hubRoot)}\0hub-maintenance-fence-v2`)
    .digest("hex");
}

function maintenanceFencePorts(hubRoot: string) {
  const key = maintenanceFenceKey(hubRoot);
  const ports: number[] = [];
  const seen = new Set<number>();
  for (let counter = 0; ports.length < 32; counter += 1) {
    const digest = createHash("sha256").update(`${key}\0${counter}`).digest();
    for (let offset = 0; offset + 1 < digest.length && ports.length < 32; offset += 2) {
      const port = 20_000 + (digest.readUInt16BE(offset) % 40_000);
      if (seen.has(port)) continue;
      seen.add(port);
      ports.push(port);
    }
  }
  return ports;
}

export function _internalHubMaintenanceFenceForTests(hubRoot: string) {
  const resolvedHubRoot = canonicalHubRootPath(hubRoot);
  return {
    protocol: MAINTENANCE_FENCE_PROTOCOL,
    key: maintenanceFenceKey(resolvedHubRoot),
    ports: maintenanceFencePorts(resolvedHubRoot),
  };
}

async function probeMaintenanceProcessFence(
  port: number,
  expectedKey: string,
): Promise<"same" | "other" | "indeterminate"> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.unref();
    let settled = false;
    let response = "";
    const finish = (result: "same" | "other" | "indeterminate") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("indeterminate"), 250);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > MAINTENANCE_FENCE_MAX_RESPONSE_CHARS) {
        finish("other");
        return;
      }
      const newline = response.indexOf("\n");
      if (newline >= 0) {
        finish(response.slice(0, newline) === `${MAINTENANCE_FENCE_PROTOCOL}${expectedKey}` ? "same" : "other");
      } else if (response.length > MAINTENANCE_FENCE_PROTOCOL.length && !response.startsWith(MAINTENANCE_FENCE_PROTOCOL)) {
        finish("other");
      }
    });
    socket.on("end", () => {
      finish(response.trim() === `${MAINTENANCE_FENCE_PROTOCOL}${expectedKey}` ? "same" : "other");
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error.code || "")) finish("other");
      else finish("indeterminate");
    });
  });
}

async function acquireMaintenanceProcessFence(hubRoot: string) {
  const fenceKey = maintenanceFenceKey(hubRoot);
  const ports = maintenanceFencePorts(hubRoot);
  let exhaustedByUnrelated = true;
  for (const port of ports) {
    const existing = await probeMaintenanceProcessFence(port, fenceKey);
    if (existing !== "other") {
      exhaustedByUnrelated = false;
      throw Object.assign(
        new Error(existing === "same"
          ? "Hub maintenance process fence is already held by another local owner"
          : "Hub maintenance process fence owner could not be verified"),
        { code: "HUB_MAINTENANCE_FENCE_BUSY", port },
      );
    }
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end(`${MAINTENANCE_FENCE_PROTOCOL}${fenceKey}\n`);
    });
    server.unref();
    const result = await new Promise<{ error: NodeJS.ErrnoException | null }>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        resolve({ error });
      };
      const onListening = () => {
        server.off("error", onError);
        resolve({ error: null });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port, exclusive: true });
    });
    if (!result.error) {
      let runtimeError: Error | null = null;
      server.on("error", (error) => {
        runtimeError = error;
      });
      return async () => {
        let closeError: Error | null = null;
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          });
        } catch (error) {
          closeError = error instanceof Error ? error : new Error(String(error));
        }
        if (runtimeError || closeError) {
          throw Object.assign(
            new AggregateError(
              [runtimeError, closeError].filter((error): error is Error => Boolean(error)),
              `Hub maintenance process fence release failed on 127.0.0.1:${port}`,
            ),
            { code: "HUB_MAINTENANCE_FENCE_RELEASE_FAILED", port },
          );
        }
      };
    }
    if (result.error.code !== "EADDRINUSE") throw result.error;
    const probe = await probeMaintenanceProcessFence(port, fenceKey);
    if (probe === "other") continue;
    exhaustedByUnrelated = false;
    throw Object.assign(
      new Error(probe === "same"
        ? "Hub maintenance process fence is already held by another local owner"
        : "Hub maintenance process fence owner could not be verified"),
      { code: "HUB_MAINTENANCE_FENCE_BUSY", port },
    );
  }
  throw Object.assign(
    new Error(exhaustedByUnrelated
      ? "Hub maintenance process fence namespace is occupied by unrelated listeners"
      : "Hub maintenance process fence is already held by another local owner"),
    { code: exhaustedByUnrelated ? "HUB_MAINTENANCE_FENCE_UNAVAILABLE" : "HUB_MAINTENANCE_FENCE_BUSY" },
  );
}

async function withMaintenanceProcessFence<T>(hubRoot: string, operation: () => Promise<T>) {
  const canonicalHubRoot = canonicalHubRootPath(hubRoot);
  const authorityChain = await openDirectoryAuthorityChain(path.dirname(canonicalHubRoot));
  let releaseFence: (() => Promise<void>) | null = null;
  try {
    releaseFence = await acquireMaintenanceProcessFence(canonicalHubRoot);
  } catch (error) {
    try {
      await closeDirectoryAuthorityChain(authorityChain);
    } catch (closeError) {
      throw Object.assign(
        new AggregateError([error, closeError], "Hub maintenance fence acquisition and authority close failed", {
          cause: error,
        }),
        { code: errnoCode(error) || "HUB_MAINTENANCE_FENCE_BUSY", primaryError: error, closeError },
      );
    }
    throw error;
  }
  let value: T | undefined;
  let primaryError: unknown = null;
  try {
    value = await operation();
  } catch (error) {
    primaryError = error;
  }
  const finalizationErrors: unknown[] = [];
  try {
    await validateDirectoryAuthorityChain(authorityChain);
  } catch (error) {
    finalizationErrors.push(error);
  }
  try {
    await releaseFence();
  } catch (error) {
    finalizationErrors.push(error);
  }
  try {
    await closeDirectoryAuthorityChain(authorityChain);
  } catch (error) {
    finalizationErrors.push(error);
  }
  if (primaryError) {
    if (finalizationErrors.length === 0) throw primaryError;
    const primaryMetadata = primaryError && typeof primaryError === "object"
      ? Object.fromEntries([
        "committed",
        "committedPath",
        "recoveryPaths",
        "successorPreserved",
        "quarantinePreserved",
        "cleanupCommitted",
        "phase",
        "filePath",
      ].filter((key) => key in primaryError).map((key) => [key, (primaryError as Record<string, unknown>)[key]]))
      : {};
    throw Object.assign(
      new AggregateError([primaryError, ...finalizationErrors], "Hub maintenance operation and fence finalization both failed", {
        cause: primaryError,
      }),
      primaryMetadata,
      { code: errnoCode(primaryError) || "HUB_MAINTENANCE_OPERATION_FAILED", primaryError, finalizationErrors },
    );
  }
  if (finalizationErrors.length > 0) {
    if (finalizationErrors.length === 1) throw finalizationErrors[0];
    throw Object.assign(new AggregateError(finalizationErrors, "Hub maintenance fence finalization failed", {
      cause: finalizationErrors[0],
    }), { code: errnoCode(finalizationErrors[0]) || "HUB_MAINTENANCE_FENCE_RELEASE_FAILED", finalizationErrors });
  }
  return value as T;
}

type DirectoryAuthorityHandle = {
  fd?: number;
  stat: () => Promise<Stats>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

type FsyncDirectoryOptions = {
  openDirectory?: (directory: string, flags: number) => Promise<{
    stat: () => Promise<Stats>;
    sync: () => Promise<void>;
    close: () => Promise<void>;
  }>;
};

function directoryAuthorityError(directory: string, cause?: unknown) {
  return Object.assign(
    new Error(`directory authority must be a stable real directory: ${directory}`, cause === undefined ? undefined : { cause }),
    { code: "DIRECTORY_AUTHORITY_UNSAFE", directory },
  );
}

function directoryAuthorityOpenFlags() {
  if (
    typeof constants.O_RDONLY !== "number"
    || typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw directoryAuthorityError("<unsupported-platform>");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
}

async function openDirectoryAuthority(
  directory: string,
  openDirectory: NonNullable<FsyncDirectoryOptions["openDirectory"]> = open,
) {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(directory);
  } catch (error) {
    if (["ELOOP", "EMLINK", "ENOTDIR"].includes(errnoCode(error))) {
      throw directoryAuthorityError(directory, error);
    }
    throw error;
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw directoryAuthorityError(directory);
  }

  let handle: DirectoryAuthorityHandle;
  try {
    handle = await openDirectory(directory, directoryAuthorityOpenFlags());
  } catch (error) {
    if (["ELOOP", "EMLINK", "ENOTDIR"].includes(errnoCode(error))) {
      throw directoryAuthorityError(directory, error);
    }
    throw error;
  }

  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || !sameMaintenanceLockGeneration(maintenanceLockGeneration(before), opened)
    ) {
      throw directoryAuthorityError(directory);
    }
    return { handle, generation: maintenanceLockGeneration(opened) };
  } catch (error) {
    let closeError: unknown = null;
    try {
      await handle.close();
    } catch (closeFailure) {
      closeError = closeFailure;
    }
    if (!closeError) throw error;
    throw Object.assign(
      new AggregateError([error, closeError], `directory authority open verification and close failed: ${directory}`, {
        cause: error,
      }),
      { code: errnoCode(error) || "DIRECTORY_AUTHORITY_UNSAFE", primaryError: error, closeError },
    );
  }
}

async function validateOpenDirectoryAuthority(
  directory: string,
  handle: DirectoryAuthorityHandle,
  expected: HubMaintenanceLockGeneration,
) {
  const descriptor = await handle.stat();
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(directory);
  } catch (error) {
    throw directoryAuthorityError(directory, error);
  }
  if (
    !descriptor.isDirectory()
    || !current.isDirectory()
    || current.isSymbolicLink()
    || !sameMaintenanceLockGeneration(expected, descriptor)
    || !sameMaintenanceLockGeneration(expected, current)
  ) {
    throw directoryAuthorityError(directory);
  }
}

async function validateAndCloseDirectoryAuthority(
  directory: string,
  authority: Awaited<ReturnType<typeof openDirectoryAuthority>>,
) {
  let primaryError: unknown = null;
  try {
    await validateOpenDirectoryAuthority(directory, authority.handle, authority.generation);
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await authority.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw Object.assign(
      new AggregateError([primaryError, closeError], `directory authority validation and close failed: ${directory}`, {
        cause: primaryError,
      }),
      { code: errnoCode(primaryError) || "DIRECTORY_AUTHORITY_UNSAFE", primaryError, closeError },
    );
  }
  if (closeError) throw closeError;
}

async function assertDirectoryAuthority(directory: string) {
  const authority = await openDirectoryAuthority(directory);
  await validateAndCloseDirectoryAuthority(directory, authority);
}

type DirectoryAuthorityChainEntry = Awaited<ReturnType<typeof openDirectoryAuthority>> & {
  directory: string;
};

function ancestorDirectories(directory: string) {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  const entries = relative ? relative.split(path.sep) : [];
  const result = [root];
  for (const entry of entries) result.push(path.join(result[result.length - 1], entry));
  return result;
}

async function openDirectoryAuthorityChain(directory: string) {
  const chain: DirectoryAuthorityChainEntry[] = [];
  try {
    for (const current of ancestorDirectories(directory)) {
      chain.push({ directory: current, ...await openDirectoryAuthority(current) });
    }
    return chain;
  } catch (error) {
    const closeErrors: unknown[] = [];
    for (const entry of [...chain].reverse()) {
      try {
        await entry.handle.close();
      } catch (closeError) {
        closeErrors.push(closeError);
      }
    }
    if (closeErrors.length === 0) throw error;
    throw Object.assign(
      new AggregateError([error, ...closeErrors], `directory authority chain open and close failed: ${directory}`, {
        cause: error,
      }),
      { code: errnoCode(error) || "DIRECTORY_AUTHORITY_UNSAFE", primaryError: error, closeErrors },
    );
  }
}

async function validateDirectoryAuthorityChain(chain: DirectoryAuthorityChainEntry[]) {
  for (const entry of chain) {
    const descriptor = await entry.handle.stat();
    const current = await lstat(entry.directory);
    if (
      !descriptor.isDirectory()
      || !current.isDirectory()
      || current.isSymbolicLink()
      || !sameMaintenanceLockLineage(entry.generation, descriptor)
      || !sameMaintenanceLockLineage(entry.generation, current)
      || !sameMaintenanceLockGeneration(maintenanceLockGeneration(descriptor), current)
    ) {
      throw directoryAuthorityError(entry.directory);
    }
  }
}

async function closeDirectoryAuthorityChain(chain: DirectoryAuthorityChainEntry[]) {
  const closeErrors: unknown[] = [];
  for (const entry of [...chain].reverse()) {
    try {
      await entry.handle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (closeErrors.length > 0) {
    throw Object.assign(new AggregateError(closeErrors, "directory authority chain close failed", {
      cause: closeErrors[0],
    }), { code: "DIRECTORY_AUTHORITY_CLOSE_FAILED", closeErrors });
  }
}

async function assertMaintenanceNamespaceAuthority(lockPath: string) {
  const parent = path.dirname(lockPath);
  let chain: DirectoryAuthorityChainEntry[] | null = null;
  try {
    chain = await openDirectoryAuthorityChain(parent);
    await validateDirectoryAuthorityChain(chain);
    await closeDirectoryAuthorityChain(chain);
    chain = null;
  } catch (cause) {
    if (chain) {
      try {
        await closeDirectoryAuthorityChain(chain);
      } catch (closeError) {
        cause = new AggregateError([cause, closeError], "Hub maintenance namespace validation and close failed", {
          cause,
        });
      }
    }
    throw Object.assign(new Error(`Hub maintenance namespace authority is unsafe: ${parent}`, { cause }), {
      code: "HUB_MAINTENANCE_NAMESPACE_UNSAFE",
      committed: false,
      recoveryPaths: { lockPath, parent },
    });
  }
}

export async function fsyncDirectory(
  directory: string,
  { openDirectory = open }: FsyncDirectoryOptions = {},
) {
  let authority: Awaited<ReturnType<typeof openDirectoryAuthority>> | null = null;
  let primaryError: unknown = null;
  try {
    authority = await openDirectoryAuthority(directory, openDirectory);
    await authority.handle.sync();
    await validateOpenDirectoryAuthority(directory, authority.handle, authority.generation);
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  if (authority) {
    try {
      await authority.handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw new AggregateError([primaryError, closeError], `directory fsync and close failed: ${directory}`, {
      cause: primaryError,
    });
  }
  if (closeError) throw closeError;
}

type WriteJsonDurableAtomicOptions = {
  syncParentDirectory?: (directory: string) => Promise<void>;
  beforePublishRename?: (context: { filePath: string; tempPath: string }) => void | Promise<void>;
  afterPublishRename?: (context: { filePath: string; tempPath: string }) => void | Promise<void>;
  beforeTempIsolation?: (context: { filePath: string; tempPath: string }) => void | Promise<void>;
};

type FailedTempIsolation = {
  quarantinePath: string | null;
  cleanupCommitted: boolean;
};

async function isolateFailedTemp(
  filePath: string,
  tempPath: string,
  expected: HubMaintenanceLockGeneration,
  options: WriteJsonDurableAtomicOptions,
): Promise<FailedTempIsolation> {
  await options.beforeTempIsolation?.({ filePath, tempPath });
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(tempPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { quarantinePath: null, cleanupCommitted: false };
    throw error;
  }
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || !sameMaintenanceLockGeneration(expected, current)
  ) {
    throw Object.assign(new Error(`durable JSON temp successor preserved: ${tempPath}`), {
      code: "DURABLE_JSON_TEMP_SUCCESSOR_PRESERVED",
      committed: false,
      successorPreserved: true,
      recoveryPaths: { filePath, tempPath },
    });
  }

  const quarantinePath = `${tempPath}.failed-${Date.now()}-${randomUUID()}`;
  try {
    await lstat(quarantinePath);
    throw Object.assign(new Error(`durable JSON temp quarantine already exists: ${quarantinePath}`), {
      code: "DURABLE_JSON_TEMP_QUARANTINE_CONFLICT",
    });
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }

  await rename(tempPath, quarantinePath);
  let quarantined: Awaited<ReturnType<typeof lstat>>;
  try {
    quarantined = await lstat(quarantinePath);
    if (
      !quarantined.isFile()
      || quarantined.isSymbolicLink()
      || !sameMaintenanceLockAcrossRename(expected, quarantined)
    ) {
      throw Object.assign(new Error(`durable JSON temp changed during isolation: ${quarantinePath}`), {
        code: "DURABLE_JSON_TEMP_RACE",
      });
    }
  } catch (error) {
    throw Object.assign(new Error(`durable JSON temp quarantine preserved after verification failure: ${quarantinePath}`, {
      cause: error,
    }), {
      code: "DURABLE_JSON_TEMP_QUARANTINE_PRESERVED",
      committed: false,
      cleanupCommitted: true,
      quarantinePreserved: true,
      recoveryPaths: { filePath, tempPath, quarantinePath },
    });
  }

  try {
    await (options.syncParentDirectory || fsyncDirectory)(path.dirname(filePath));
  } catch (error) {
    throw Object.assign(new Error(`durable JSON temp isolation has ambiguous durability: ${quarantinePath}`, {
      cause: error,
    }), {
      code: "DURABLE_JSON_TEMP_ISOLATION_DURABILITY_AMBIGUOUS",
      committed: false,
      cleanupCommitted: true,
      quarantinePreserved: true,
      recoveryPaths: { filePath, tempPath, quarantinePath },
    });
  }

  const final = await lstat(quarantinePath);
  if (
    !final.isFile()
    || final.isSymbolicLink()
    || !sameMaintenanceLockGeneration(maintenanceLockGeneration(quarantined), final)
  ) {
    throw Object.assign(new Error(`durable JSON temp quarantine changed after isolation: ${quarantinePath}`), {
      code: "DURABLE_JSON_TEMP_QUARANTINE_PRESERVED",
      committed: false,
      cleanupCommitted: true,
      quarantinePreserved: true,
      recoveryPaths: { filePath, tempPath, quarantinePath },
    });
  }
  return { quarantinePath, cleanupCommitted: true };
}

export async function writeJsonDurableAtomic(
  filePath: string,
  value: unknown,
  options: WriteJsonDurableAtomicOptions = {},
) {
  const parent = path.dirname(filePath);
  const syncParentDirectory = options.syncParentDirectory || fsyncDirectory;
  await mkdir(parent, { recursive: true });
  try {
    await assertDirectoryAuthority(parent);
  } catch (cause) {
    throw Object.assign(new Error(`durable JSON parent authority is unsafe: ${parent}`, { cause }), {
      code: "DURABLE_JSON_PARENT_UNSAFE",
      committed: false,
      recoveryPaths: { filePath, parent },
    });
  }
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw Object.assign(new Error(`no-follow temp publication is unavailable: ${tempPath}`), {
      code: "DURABLE_JSON_TEMP_UNSAFE",
      committed: false,
    });
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (cause) {
    throw Object.assign(new Error(`durable JSON temp could not be opened exclusively: ${tempPath}`, { cause }), {
      code: errnoCode(cause) || "DURABLE_JSON_TEMP_OPEN_FAILED",
      committed: false,
      recoveryPaths: { filePath, tempPath },
    });
  }
  let closed = false;
  let renamed = false;
  let primaryError: unknown = null;
  let tempGeneration: HubMaintenanceLockGeneration | null = null;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    const tempInfo = await handle.stat();
    if (!tempInfo.isFile()) {
      throw Object.assign(new Error(`durable JSON temp is not a regular file: ${tempPath}`), {
        code: "DURABLE_JSON_TEMP_UNSAFE",
      });
    }
    tempGeneration = maintenanceLockGeneration(tempInfo);
    await handle.close();
    closed = true;
    await options.beforePublishRename?.({ filePath, tempPath });
    await rename(tempPath, filePath);
    renamed = true;
    await options.afterPublishRename?.({ filePath, tempPath });
    let published: Awaited<ReturnType<typeof lstat>>;
    try {
      published = await lstat(filePath);
    } catch (cause) {
      throw Object.assign(new Error(`durable JSON publication path disappeared after rename: ${filePath}`, { cause }), {
        code: "DURABLE_JSON_COMMITTED_PUBLICATION_RACE",
      });
    }
    if (
      !tempGeneration
      || !published.isFile()
      || published.isSymbolicLink()
      || !sameMaintenanceLockAcrossRename(tempGeneration, published)
    ) {
      throw Object.assign(new Error(`durable JSON publication changed after rename: ${filePath}`), {
        code: "DURABLE_JSON_COMMITTED_PUBLICATION_RACE",
      });
    }
    const publishedGeneration = maintenanceLockGeneration(published);
    await syncParentDirectory(parent);
    let final: Awaited<ReturnType<typeof lstat>>;
    try {
      final = await lstat(filePath);
    } catch (cause) {
      throw Object.assign(new Error(`durable JSON publication path disappeared after directory sync: ${filePath}`, { cause }), {
        code: "DURABLE_JSON_COMMITTED_PUBLICATION_RACE",
      });
    }
    if (
      !final.isFile()
      || final.isSymbolicLink()
      || !sameMaintenanceLockGeneration(publishedGeneration, final)
    ) {
      throw Object.assign(new Error(`durable JSON publication changed after directory sync: ${filePath}`), {
        code: "DURABLE_JSON_COMMITTED_PUBLICATION_RACE",
      });
    }
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (!renamed && !tempGeneration) {
    try {
      const tempInfo = await handle.stat();
      if (tempInfo.isFile()) tempGeneration = maintenanceLockGeneration(tempInfo);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!closed) {
    try {
      await handle.close();
      closed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  let isolation: FailedTempIsolation | null = null;
  if (!renamed && closed && tempGeneration) {
    try {
      isolation = await isolateFailedTemp(filePath, tempPath, tempGeneration, options);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError) {
    if (renamed) {
      const errors = [primaryError, ...cleanupErrors];
      const publicationRace = errnoCode(primaryError) === "DURABLE_JSON_COMMITTED_PUBLICATION_RACE";
      throw Object.assign(
        new AggregateError(errors, publicationRace
          ? `durable JSON publication committed but its pathname authority changed: ${filePath}`
          : `durable JSON publication committed but directory durability is ambiguous: ${filePath}`, {
          cause: primaryError,
        }),
        {
          code: publicationRace
            ? "DURABLE_JSON_COMMITTED_PUBLICATION_RACE"
            : "DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS",
          primaryError,
          cleanupErrors,
          committed: true,
          filePath,
          committedPath: filePath,
          successorPreserved: publicationRace,
          recoveryPaths: publicationRace ? { filePath, parent } : [filePath, parent],
        },
      );
    }
    if (cleanupErrors.length === 0) {
      throw Object.assign(new Error(`durable JSON publication failed: ${filePath}`, { cause: primaryError }), {
        code: errnoCode(primaryError) || "DURABLE_JSON_PUBLICATION_FAILED",
        primaryError,
        cleanupErrors,
        committed: false,
        cleanupCommitted: isolation?.cleanupCommitted || false,
        quarantinePreserved: Boolean(isolation?.quarantinePath),
        recoveryPaths: {
          filePath,
          tempPath,
          ...(isolation?.quarantinePath ? { quarantinePath: isolation.quarantinePath } : {}),
        },
      });
    }
    const successorError = cleanupErrors.find((error) => errnoCode(error) === "DURABLE_JSON_TEMP_SUCCESSOR_PRESERVED");
    throw Object.assign(
      new AggregateError([primaryError, ...cleanupErrors], `durable JSON publication failed: ${filePath}`, {
        cause: primaryError,
      }),
      {
        code: successorError ? "DURABLE_JSON_TEMP_SUCCESSOR_PRESERVED" : "DURABLE_JSON_CLEANUP_FAILED",
        primaryError,
        cleanupErrors,
        committed: false,
        successorPreserved: Boolean(successorError),
        recoveryPaths: successorError && typeof successorError === "object" && "recoveryPaths" in successorError
          ? (successorError as { recoveryPaths: unknown }).recoveryPaths
          : { filePath, tempPath },
      },
    );
  }
  if (cleanupErrors.length > 0) {
    throw Object.assign(new AggregateError(cleanupErrors, `durable JSON cleanup failed: ${filePath}`), {
      code: "DURABLE_JSON_CLEANUP_FAILED",
      cleanupErrors,
      committed: renamed,
    });
  }
}

type RemoveDurableOptions = {
  syncParentDirectory?: (directory: string) => Promise<void>;
  beforeRename?: (context: { filePath: string; quarantinePath: string }) => void | Promise<void>;
  beforeFinalRename?: (context: { filePath: string; quarantinePath: string }) => void | Promise<void>;
  afterRename?: (context: { filePath: string; quarantinePath: string }) => void | Promise<void>;
};

export type DurableRemovalEvidence = {
  quarantinePath: string;
  generation: HubMaintenanceLockGeneration;
};

export async function removeDurable(
  filePath: string,
  {
    syncParentDirectory = fsyncDirectory,
    beforeRename,
    beforeFinalRename,
    afterRename,
  }: RemoveDurableOptions = {},
) {
  const parent = path.dirname(filePath);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw Object.assign(new Error(`durable removal source could not be inspected: ${filePath}`, { cause: error }), {
      code: errnoCode(error) || "DURABLE_REMOVE_INSPECTION_FAILED",
      committed: false,
      recoveryPaths: { canonical: filePath },
    });
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw Object.assign(new Error(`durable removal requires a real regular file: ${filePath}`), {
      code: "DURABLE_REMOVE_UNSAFE",
      committed: false,
      recoveryPaths: { canonical: filePath },
    });
  }
  let parentAuthority: Awaited<ReturnType<typeof openDirectoryAuthority>>;
  try {
    parentAuthority = await openDirectoryAuthority(parent);
  } catch (cause) {
    throw Object.assign(new Error(`durable removal parent authority is unsafe: ${parent}`, { cause }), {
      code: "DURABLE_REMOVE_PARENT_UNSAFE",
      committed: false,
      recoveryPaths: { canonical: filePath, parent },
    });
  }
  const expected = maintenanceLockGeneration(before);
  let sourceHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    sourceHandle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || !sameMaintenanceLockGeneration(expected, opened)) {
      throw Object.assign(new Error(`durable removal source changed while pinning: ${filePath}`), {
        code: "DURABLE_REMOVE_RACE",
      });
    }
  } catch (cause) {
    const closeErrors: unknown[] = [];
    for (const handle of [sourceHandle, parentAuthority.handle].filter(Boolean) as DirectoryAuthorityHandle[]) {
      try {
        await handle.close();
      } catch (closeError) {
        closeErrors.push(closeError);
      }
    }
    if (closeErrors.length > 0) {
      throw Object.assign(
        new AggregateError([cause, ...closeErrors], `durable removal pin and parent close failed: ${filePath}`, { cause }),
        { code: errnoCode(cause) || "DURABLE_REMOVE_RACE", primaryError: cause, closeErrors },
      );
    }
    throw cause;
  }
  if (!sourceHandle) throw new Error(`durable removal source authority was not captured: ${filePath}`);
  const quarantinePath = path.join(parent, `.removed-${randomUUID()}-${path.basename(filePath)}`);
  let renamed = false;
  let movedGeneration: HubMaintenanceLockGeneration | null = null;

  const validateParentLineageSync = () => {
    if (typeof parentAuthority.handle.fd !== "number") throw directoryAuthorityError(parent);
    let descriptor: Stats;
    let current: Stats;
    try {
      descriptor = fstatSync(parentAuthority.handle.fd);
      current = lstatSync(parent);
    } catch (cause) {
      throw directoryAuthorityError(parent, cause);
    }
    if (
      !descriptor.isDirectory()
      || !current.isDirectory()
      || current.isSymbolicLink()
      || !sameMaintenanceLockLineage(parentAuthority.generation, descriptor)
      || !sameMaintenanceLockLineage(parentAuthority.generation, current)
    ) {
      throw directoryAuthorityError(parent);
    }
  };

  const performRemoval = async () => {
    try {
      await beforeRename?.({ filePath, quarantinePath });
      if (beforeFinalRename) await beforeFinalRename({ filePath, quarantinePath });
    } catch (cause) {
      throw Object.assign(new Error(`durable removal hook failed before isolation: ${filePath}`, { cause }), {
        code: errnoCode(cause) || "DURABLE_REMOVE_PREPARE_FAILED",
        committed: false,
        recoveryPaths: { canonical: filePath, quarantine: quarantinePath },
      });
    }

    let preRename: Stats;
    try {
      // Keep these checks and the rename in one synchronous turn. The parent
      // descriptor remains open across every caller hook and the mutation.
      validateParentLineageSync();
      preRename = lstatSync(filePath);
      if (
        !preRename.isFile()
        || preRename.isSymbolicLink()
        || !sameMaintenanceLockGeneration(expected, preRename)
      ) {
        throw Object.assign(new Error(`durable removal source changed before isolation: ${filePath}`), {
          code: "DURABLE_REMOVE_RACE",
          committed: false,
          successorPreserved: true,
          recoveryPaths: { canonical: filePath },
        });
      }
      try {
        lstatSync(quarantinePath);
        throw Object.assign(new Error(`durable removal quarantine target already exists: ${quarantinePath}`), {
          code: "DURABLE_REMOVE_QUARANTINE_CONFLICT",
          committed: false,
          successorPreserved: true,
          recoveryPaths: { canonical: filePath, quarantine: quarantinePath },
        });
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error;
      }
      renameSync(filePath, quarantinePath);
      renamed = true;
      const movedDescriptor = fstatSync(sourceHandle.fd);
      const movedPath = lstatSync(quarantinePath);
      if (
        !movedDescriptor.isFile()
        || !movedPath.isFile()
        || movedPath.isSymbolicLink()
        || !sameMaintenanceLockAcrossRename(expected, movedDescriptor)
        || !sameMaintenanceLockAcrossRename(expected, movedPath)
        || !sameMaintenanceLockGeneration(movedDescriptor, movedPath)
      ) {
        throw Object.assign(new Error(`durable removal generation changed during isolation: ${filePath}`), {
          code: "DURABLE_REMOVE_RACE",
        });
      }
      movedGeneration = maintenanceLockGeneration(movedDescriptor);
      validateParentLineageSync();
    } catch (error) {
      if (errnoCode(error) === "ENOENT" && !renamed) return;
      if (error && typeof error === "object" && "committed" in error) throw error;
      if (errnoCode(error) === "DIRECTORY_AUTHORITY_UNSAFE") {
        throw Object.assign(new Error(`durable removal parent authority is unsafe: ${parent}`, { cause: error }), {
          code: "DURABLE_REMOVE_PARENT_UNSAFE",
          committed: renamed,
          ...(renamed ? { committedPath: quarantinePath, quarantinePreserved: true } : {}),
          recoveryPaths: { canonical: filePath, parent, ...(renamed ? { quarantine: quarantinePath } : {}) },
        });
      }
      throw Object.assign(new Error(`durable removal isolation rename failed: ${filePath}`, { cause: error }), {
        code: errnoCode(error) || "DURABLE_REMOVE_RENAME_FAILED",
        committed: renamed,
        ...(renamed ? { committedPath: quarantinePath, quarantinePreserved: true } : {}),
        recoveryPaths: { canonical: filePath, quarantine: quarantinePath },
      });
    }

    await afterRename?.({ filePath, quarantinePath });

    let quarantined: Stats;
    try {
      quarantined = lstatSync(quarantinePath);
      if (
        !quarantined.isFile()
        || quarantined.isSymbolicLink()
        || !sameMaintenanceLockAcrossRename(expected, quarantined)
      ) {
        throw Object.assign(new Error(`durable removal source changed during isolation: ${filePath}`), {
          code: "DURABLE_REMOVE_RACE",
        });
      }
      try {
        const canonical = lstatSync(filePath);
        if (sameMaintenanceLockLineage(expected, canonical)) {
          throw Object.assign(new Error(`durable removal source remained reachable after isolation: ${filePath}`), {
            code: "DURABLE_REMOVE_RACE",
          });
        }
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error;
      }
    } catch (error) {
      throw Object.assign(new Error(`durable removal quarantine preserved after verification failure: ${quarantinePath}`, {
        cause: error,
      }), {
        code: "DURABLE_REMOVE_QUARANTINE_PRESERVED",
        committed: true,
        committedPath: quarantinePath,
        quarantinePreserved: true,
        recoveryPaths: { canonical: filePath, quarantine: quarantinePath },
      });
    }
    try {
      await syncParentDirectory(parent);
      validateParentLineageSync();
    } catch (error) {
      throw Object.assign(
        new Error(`durable removal committed but directory durability is ambiguous: ${filePath}`, { cause: error }),
        {
          code: "DURABLE_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS",
          committed: true,
          committedPath: quarantinePath,
          quarantinePreserved: true,
          recoveryPaths: { canonical: filePath, quarantine: quarantinePath },
        },
      );
    }
    let final: Awaited<ReturnType<typeof lstat>>;
    try {
      final = await lstat(quarantinePath);
      validateParentLineageSync();
    } catch (cause) {
      throw Object.assign(new Error(`durable removal quarantine became unavailable: ${quarantinePath}`, { cause }), {
        code: "DURABLE_REMOVE_QUARANTINE_PRESERVED",
        committed: true,
        committedPath: quarantinePath,
        quarantinePreserved: true,
        recoveryPaths: { canonical: filePath, quarantine: quarantinePath },
      });
    }
    if (
      !final.isFile()
      || final.isSymbolicLink()
      || !sameMaintenanceLockGeneration(maintenanceLockGeneration(quarantined), final)
    ) {
      throw Object.assign(new Error(`durable removal quarantine changed after isolation: ${quarantinePath}`), {
        code: "DURABLE_REMOVE_QUARANTINE_PRESERVED",
        committed: true,
        committedPath: quarantinePath,
        quarantinePreserved: true,
        recoveryPaths: { canonical: filePath, quarantine: quarantinePath },
      });
    }
    // Preserve the verified quarantine: pathname unlink after validation would
    // reopen the same ABA window this isolation step closes.
  };

  let operationError: unknown = null;
  try {
    await performRemoval();
  } catch (error) {
    operationError = error;
  }

  const evidenceMetadata = () => {
    const recoveryPaths: Record<string, string> = {};
    const attemptedPaths: Record<string, string> = {};
    let quarantineVerified = false;
    if (renamed && movedGeneration) {
      try {
        const descriptor = fstatSync(sourceHandle.fd);
        const quarantine = lstatSync(quarantinePath);
        quarantineVerified = descriptor.isFile()
          && quarantine.isFile()
          && !quarantine.isSymbolicLink()
          && sameMaintenanceLockGeneration(movedGeneration, descriptor)
          && sameMaintenanceLockGeneration(movedGeneration, quarantine);
      } catch {
        quarantineVerified = false;
      }
      attemptedPaths.canonical = filePath;
      if (quarantineVerified) recoveryPaths.quarantine = quarantinePath;
      else attemptedPaths.quarantine = quarantinePath;
    } else {
      try {
        const canonical = lstatSync(filePath);
        if (canonical.isFile() && !canonical.isSymbolicLink() && sameMaintenanceLockGeneration(expected, canonical)) {
          recoveryPaths.canonical = filePath;
        } else attemptedPaths.canonical = filePath;
      } catch {
        attemptedPaths.canonical = filePath;
      }
      attemptedPaths.quarantine = quarantinePath;
    }
    try {
      const descriptor = fstatSync(parentAuthority.handle.fd);
      const current = lstatSync(parent);
      if (
        descriptor.isDirectory()
        && current.isDirectory()
        && !current.isSymbolicLink()
        && sameMaintenanceLockLineage(parentAuthority.generation, descriptor)
        && sameMaintenanceLockLineage(parentAuthority.generation, current)
      ) recoveryPaths.parent = parent;
      else attemptedPaths.parent = parent;
    } catch {
      attemptedPaths.parent = parent;
    }
    return { recoveryPaths, attemptedPaths, quarantineVerified };
  };

  if (operationError && typeof operationError === "object") {
    const record = operationError as Record<string, unknown>;
    const evidence = evidenceMetadata();
    delete record.quarantinePreserved;
    record.recoveryPaths = evidence.recoveryPaths;
    record.attemptedPaths = evidence.attemptedPaths;
    if (renamed) {
      record.committed = true;
      record.committedPath = quarantinePath;
      if (evidence.quarantineVerified) record.quarantinePreserved = true;
      else record.successorPreserved = true;
    }
    if (movedGeneration) record.predecessorGeneration = movedGeneration;
  }

  const closeErrors: unknown[] = [];
  for (const handle of [sourceHandle, parentAuthority.handle]) {
    try {
      await handle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (operationError) {
    if (closeErrors.length === 0) throw operationError;
    const metadata = operationError && typeof operationError === "object"
      ? Object.fromEntries(Object.entries(operationError))
      : {};
    throw Object.assign(
      new AggregateError([operationError, ...closeErrors], `durable removal and authority close failed: ${filePath}`, {
        cause: operationError,
      }),
      metadata,
      { code: errnoCode(operationError) || "DURABLE_REMOVE_FAILED", primaryError: operationError, closeErrors },
    );
  }
  if (closeErrors.length > 0) {
    const evidence = evidenceMetadata();
    throw Object.assign(new AggregateError(closeErrors, `durable removal authority close failed: ${parent}`, {
      cause: closeErrors[0],
    }), {
      code: errnoCode(closeErrors[0]) || "DURABLE_REMOVE_PARENT_CLOSE_FAILED",
      committed: renamed,
      ...(renamed ? { committedPath: quarantinePath } : {}),
      ...(evidence.quarantineVerified ? { quarantinePreserved: true } : { successorPreserved: renamed }),
      recoveryPaths: evidence.recoveryPaths,
      attemptedPaths: evidence.attemptedPaths,
    });
  }
  if (!movedGeneration) return;
  return { quarantinePath, generation: movedGeneration } satisfies DurableRemovalEvidence;
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

function parseProcessIdentity(value: unknown, expectedPid: number) {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identityRecord = value as Record<string, unknown>;
  const record = identityRecord as Partial<ProcessIdentity>;
  const expectedKeys = record.processGroupId === undefined
    ? ["pid", "birthId", "incarnation", "capturedAt", "birthIdPrecision"]
    : ["pid", "birthId", "incarnation", "capturedAt", "birthIdPrecision", "processGroupId"];
  if (
    !hasExactKeys(identityRecord, expectedKeys)
    ||
    !Number.isSafeInteger(record.pid)
    || Number(record.pid) <= 0
    || record.pid !== expectedPid
    || typeof record.birthId !== "string"
    || !record.birthId
    || record.incarnation !== `${record.pid}:${record.birthId}`
    || typeof record.capturedAt !== "string"
    || Number.isNaN(new Date(record.capturedAt).getTime())
    || new Date(Date.parse(record.capturedAt)).toISOString() !== record.capturedAt
    || record.birthIdPrecision !== "exact"
    || (record.processGroupId !== undefined && (!Number.isSafeInteger(record.processGroupId) || Number(record.processGroupId) <= 0))
  ) return null;
  return {
    pid: record.pid,
    birthId: record.birthId,
    incarnation: record.incarnation,
    capturedAt: record.capturedAt,
    birthIdPrecision: record.birthIdPrecision,
    ...(record.processGroupId ? { processGroupId: record.processGroupId } : {}),
  } satisfies ProcessIdentity;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

async function readRegularFileNoFollow(filePath: string) {
  try {
    return await readBoundedRegularFileNoFollow(filePath, {
      maxBytes: HUB_MAINTENANCE_OWNER_MAX_BYTES,
    });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw error;
    throw Object.assign(new Error(`Hub maintenance owner must be a regular file: ${filePath}`), {
      code: "HUB_MAINTENANCE_OWNER_INVALID",
      cause: error,
    });
  }
}

async function readOwner(lockPath: string, expectedCanonicalLockPath = lockPath) {
  try {
    const parsed = JSON.parse(await readRegularFileNoFollow(path.join(lockPath, "owner.json")));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new Error(`Hub maintenance owner is invalid: ${lockPath}`), {
        code: "HUB_MAINTENANCE_OWNER_INVALID",
      });
    }
    const ownerRecord = parsed as Record<string, unknown>;
    const owner = ownerRecord as Partial<HubMaintenanceOwner>;
    const expectedOwnerKeys = owner.format === "cpb-hub-maintenance/v2"
      ? ["format", "ownerToken", "operation", "hubRoot", "pid", "host", "acquiredAt", "processIdentity"]
      : ["format", "ownerToken", "operation", "hubRoot", "pid", "host", "acquiredAt"];
    if (
      (owner.format !== "cpb-hub-maintenance/v1" && owner.format !== "cpb-hub-maintenance/v2")
      || !hasExactKeys(ownerRecord, expectedOwnerKeys)
      || typeof owner.ownerToken !== "string"
      || !owner.ownerToken
      || typeof owner.operation !== "string"
      || !owner.operation
      || typeof owner.hubRoot !== "string"
      || path.resolve(owner.hubRoot) !== owner.hubRoot
      || !Number.isSafeInteger(owner.pid)
      || Number(owner.pid) <= 0
      || typeof owner.host !== "string"
      || !owner.host
      || typeof owner.acquiredAt !== "string"
      || !Number.isFinite(Date.parse(owner.acquiredAt))
      || new Date(Date.parse(owner.acquiredAt)).toISOString() !== owner.acquiredAt
      || hubMaintenanceLockPath(owner.hubRoot) !== expectedCanonicalLockPath
    ) {
      throw Object.assign(new Error(`Hub maintenance owner is invalid: ${lockPath}`), {
        code: "HUB_MAINTENANCE_OWNER_INVALID",
      });
    }
    const identity = parseProcessIdentity(owner.processIdentity, Number(owner.pid));
    if (owner.processIdentity !== undefined && !identity) {
      throw Object.assign(new Error(`Hub maintenance owner has no valid process identity: ${lockPath}`), {
        code: "HUB_MAINTENANCE_OWNER_INVALID",
      });
    }
    if (owner.format === "cpb-hub-maintenance/v2" && !identity) {
      throw Object.assign(new Error(`Hub maintenance owner has no valid process identity: ${lockPath}`), {
        code: "HUB_MAINTENANCE_OWNER_INVALID",
      });
    }
    if (owner.format === "cpb-hub-maintenance/v1" && owner.processIdentity !== undefined) {
      throw Object.assign(new Error(`Hub maintenance v1 owner must not contain process identity: ${lockPath}`), {
        code: "HUB_MAINTENANCE_OWNER_INVALID",
      });
    }
    return { ...owner, ...(identity ? { processIdentity: identity } : {}) } as HubMaintenanceOwner;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error(`Hub maintenance owner contains invalid JSON: ${lockPath}`, { cause: error }), {
        code: "HUB_MAINTENANCE_OWNER_INVALID",
      });
    }
    throw error;
  }
}

type HubMaintenanceSnapshot = {
  owner: HubMaintenanceOwner | null;
  lockGeneration: HubMaintenanceLockGeneration;
};

async function readHubMaintenanceSnapshot(
  lockPath: string,
  expectedCanonicalLockPath = lockPath,
): Promise<HubMaintenanceSnapshot> {
  let authority: Awaited<ReturnType<typeof openDirectoryAuthority>>;
  try {
    authority = await openDirectoryAuthority(lockPath);
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") throw cause;
    throw Object.assign(new Error(`Hub maintenance lock is not a stable real directory: ${lockPath}`, { cause }), {
      code: "HUB_MAINTENANCE_LOCK_INVALID",
    });
  }

  let owner: HubMaintenanceOwner | null = null;
  let primaryError: unknown = null;
  try {
    owner = await readOwner(lockPath, expectedCanonicalLockPath);
    await validateOpenDirectoryAuthority(lockPath, authority.handle, authority.generation);
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await authority.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw Object.assign(
      new AggregateError([primaryError, closeError], `Hub maintenance snapshot read and close failed: ${lockPath}`, {
        cause: primaryError,
      }),
      { code: errnoCode(primaryError) || "HUB_MAINTENANCE_LOCK_READ_FAILED", primaryError, closeError },
    );
  }
  if (closeError) {
    throw Object.assign(new Error(`Hub maintenance snapshot close failed: ${lockPath}`, { cause: closeError }), {
      code: "HUB_MAINTENANCE_LOCK_READ_FAILED",
    });
  }
  return { owner, lockGeneration: authority.generation };
}

function maintenanceOwnerAlive(owner: HubMaintenanceOwner, hooks?: HubMaintenanceHooks) {
  if (owner.host !== os.hostname() || owner.format !== "cpb-hub-maintenance/v2" || !owner.processIdentity) {
    return true;
  }
  try {
    return (hooks?.isProcessIdentityAlive || isProcessIdentityAlive)(owner.processIdentity);
  } catch (cause) {
    throw Object.assign(new Error(`Hub maintenance owner identity could not be observed exactly: ${owner.pid}`, { cause }), {
      code: "HUB_MAINTENANCE_IDENTITY_CHECK_FAILED",
      owner,
    });
  }
}

export async function readHubMaintenance(
  hubRoot: string,
  { hooks }: Pick<HubMaintenanceOptions, "hooks"> = {},
) {
  const resolvedHubRoot = canonicalHubRootPath(hubRoot);
  const lockPath = hubMaintenanceLockPath(resolvedHubRoot);
  try {
    await lstat(lockPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { active: false as const, lockPath, owner: null };
    throw error;
  }
  await assertMaintenanceNamespaceAuthority(lockPath);
  let snapshot: HubMaintenanceSnapshot;
  try {
    snapshot = await readHubMaintenanceSnapshot(lockPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { active: false as const, lockPath, owner: null };
    throw error;
  }
  const owner = snapshot.owner;
  return {
    active: true as const,
    lockPath,
    owner,
    incomplete: !owner,
    ageMs: Math.max(0, Date.now() - snapshot.lockGeneration.mtimeMs),
    ownerAlive: owner ? maintenanceOwnerAlive(owner, hooks) : false,
    lockGeneration: snapshot.lockGeneration,
  };
}

export async function assertHubWritable(hubRoot: string) {
  const journalPath = hubRestoreJournalPath(hubRoot);
  if (await pathExists(journalPath)) {
    throw Object.assign(
      new Error(`Hub is unavailable for writes until interrupted restore recovery completes (${journalPath})`),
      { code: "HUB_RESTORE_RECOVERY_REQUIRED" },
    );
  }
  const state = await readHubMaintenance(hubRoot);
  if (!state.active) return;
  const operation = state.owner?.operation || "unknown maintenance";
  throw Object.assign(
    new Error(`Hub is unavailable for writes while ${operation} is active (${state.lockPath})`),
    { code: "HUB_MAINTENANCE_ACTIVE" },
  );
}

function sameOwner(expected: HubMaintenanceOwner | null, actual: HubMaintenanceOwner | null) {
  if (!expected || !actual) return expected === actual;
  if (
    expected.format !== actual.format
    || expected.ownerToken !== actual.ownerToken
    || expected.operation !== actual.operation
    || expected.hubRoot !== actual.hubRoot
    || expected.pid !== actual.pid
    || expected.host !== actual.host
    || expected.acquiredAt !== actual.acquiredAt
  ) {
    return false;
  }
  if (expected.processIdentity || actual.processIdentity) {
    return sameProcessIdentity(expected.processIdentity, actual.processIdentity)
      && expected.processIdentity?.pid === actual.processIdentity?.pid
      && expected.processIdentity?.birthId === actual.processIdentity?.birthId
      && expected.processIdentity?.incarnation === actual.processIdentity?.incarnation
      && expected.processIdentity?.capturedAt === actual.processIdentity?.capturedAt
      && expected.processIdentity?.birthIdPrecision === actual.processIdentity?.birthIdPrecision
      && expected.processIdentity?.processGroupId === actual.processIdentity?.processGroupId;
  }
  return true;
}

function isCommittedPublication(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "committed" in error
    && (error as { committed?: unknown }).committed === true,
  );
}

function maintenanceLockGeneration(info: HubMaintenanceLockGeneration): HubMaintenanceLockGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function sameMaintenanceLockGeneration(
  left: HubMaintenanceLockGeneration,
  right: HubMaintenanceLockGeneration,
) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameMaintenanceLockAcrossRename(
  left: HubMaintenanceLockGeneration,
  right: HubMaintenanceLockGeneration,
) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameMaintenanceLockLineage(
  left: HubMaintenanceLockGeneration,
  right: HubMaintenanceLockGeneration,
) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.birthtimeMs === right.birthtimeMs;
}

async function quarantineLock(
  lockPath: string,
  expectedOwner: HubMaintenanceOwner | null,
  expectedGeneration: HubMaintenanceLockGeneration,
  hooks?: HubMaintenanceHooks,
) {
  await assertMaintenanceNamespaceAuthority(lockPath);
  let initial: HubMaintenanceSnapshot;
  try {
    initial = await readHubMaintenanceSnapshot(lockPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw Object.assign(new Error(`Hub maintenance lock could not be inspected before quarantine: ${lockPath}`, {
      cause: error,
    }), {
      code: errnoCode(error) || "HUB_MAINTENANCE_LOCK_READ_FAILED",
      committed: false,
      successorPreserved: true,
      recoveryPaths: { lockPath },
    });
  }
  if (
    !sameMaintenanceLockGeneration(expectedGeneration, initial.lockGeneration)
    || !sameOwner(expectedOwner, initial.owner)
  ) return false;
  const quarantinePath = `${lockPath}.stale-${Date.now()}-${randomUUID()}`;
  try {
    await hooks?.beforeQuarantineRename?.({ lockPath, quarantinePath });
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      committed: false,
      recoveryPaths: { lockPath },
    });
  }
  let preRename: HubMaintenanceSnapshot;
  try {
    preRename = await readHubMaintenanceSnapshot(lockPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw Object.assign(new Error(`Hub maintenance lock could not be revalidated before quarantine: ${lockPath}`, {
      cause: error,
    }), {
      code: errnoCode(error) || "HUB_MAINTENANCE_LOCK_RACE",
      committed: false,
      successorPreserved: true,
      recoveryPaths: { lockPath, quarantinePath },
    });
  }
  if (
    !sameMaintenanceLockGeneration(expectedGeneration, preRename.lockGeneration)
    || !sameMaintenanceLockGeneration(initial.lockGeneration, preRename.lockGeneration)
    || !sameOwner(expectedOwner, preRename.owner)
  ) {
    throw Object.assign(new Error(`Hub maintenance lock changed before quarantine: ${lockPath}`), {
      code: "HUB_MAINTENANCE_LOCK_RACE",
      committed: false,
      successorPreserved: true,
      recoveryPaths: { lockPath },
    });
  }
  try {
    await lstat(quarantinePath);
    throw Object.assign(new Error(`Hub maintenance quarantine target already exists: ${quarantinePath}`), {
      code: "HUB_MAINTENANCE_QUARANTINE_CONFLICT",
      committed: false,
      successorPreserved: true,
      recoveryPaths: { lockPath, quarantinePath },
    });
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw Object.assign(new Error(`Hub maintenance quarantine rename failed: ${lockPath}`, { cause: error }), {
      code: errnoCode(error) || "HUB_MAINTENANCE_QUARANTINE_RENAME_FAILED",
      committed: false,
      recoveryPaths: { lockPath, quarantinePath },
    });
  }
  let renamedGeneration: HubMaintenanceLockGeneration;
  try {
    const renamed = await readHubMaintenanceSnapshot(quarantinePath, lockPath);
    if (
      !sameMaintenanceLockAcrossRename(preRename.lockGeneration, renamed.lockGeneration)
      || !sameOwner(expectedOwner, renamed.owner)
    ) {
      throw Object.assign(new Error("Hub maintenance lock generation changed during quarantine rename"), {
        code: "HUB_MAINTENANCE_LOCK_RACE",
      });
    }
    renamedGeneration = renamed.lockGeneration;
  } catch (error) {
    throw Object.assign(new Error(`Hub maintenance quarantine preserved after rename verification failure: ${quarantinePath}`, {
      cause: error,
    }), {
      code: "HUB_MAINTENANCE_QUARANTINE_PRESERVED",
      committed: true,
      committedPath: quarantinePath,
      quarantinePreserved: true,
      recoveryPaths: { lockPath, quarantinePath },
    });
  }
  try {
    const parent = path.dirname(lockPath);
    await hooks?.beforeQuarantineParentSync?.({ lockPath, quarantinePath, parent });
    await fsyncDirectory(parent);
  } catch (error) {
    throw Object.assign(
      new Error("Hub maintenance quarantine rename committed with ambiguous durability", { cause: error }),
      {
        code: "HUB_MAINTENANCE_QUARANTINE_COMMITTED_DURABILITY_AMBIGUOUS",
        committed: true,
        committedPath: quarantinePath,
        quarantinePreserved: true,
        recoveryPaths: { lockPath, quarantinePath },
      },
    );
  }

  let hookError: unknown = null;
  try {
    await hooks?.afterQuarantineRename?.({ lockPath, quarantinePath });
  } catch (error) {
    hookError = error;
  }

  if (await pathExists(lockPath)) {
    const successorError = Object.assign(
      new Error(`Hub maintenance successor preserved; quarantine retained: ${quarantinePath}`),
      {
        code: "HUB_MAINTENANCE_SUCCESSOR_PRESERVED",
        successorPreserved: true,
        committed: true,
        committedPath: quarantinePath,
        quarantinePreserved: true,
        recoveryPaths: { lockPath, quarantinePath },
      },
    );
    if (!hookError) throw successorError;
    throw Object.assign(
      new AggregateError(
        [hookError, successorError],
        "Hub maintenance quarantine hook failed after a successor appeared",
        { cause: hookError },
      ),
      {
        code: "HUB_MAINTENANCE_SUCCESSOR_PRESERVED",
        successorPreserved: true,
        committed: true,
        committedPath: quarantinePath,
        quarantinePreserved: true,
        recoveryPaths: { lockPath, quarantinePath },
      },
    );
  }

  let validationError: unknown = null;
  try {
    const quarantined = await readHubMaintenanceSnapshot(quarantinePath, lockPath);
    if (
      !sameMaintenanceLockGeneration(renamedGeneration, quarantined.lockGeneration)
      || !sameOwner(expectedOwner, quarantined.owner)
    ) {
      throw Object.assign(new Error("Hub maintenance lock ownership changed during quarantine"), {
        code: "HUB_MAINTENANCE_LOCK_RACE",
      });
    }
  } catch (error) {
    validationError = error;
  }
  if (hookError || validationError) {
    const errors = [hookError, validationError].filter((error) => error !== null);
    const cause = errors.length === 1
      ? errors[0]
      : new AggregateError(errors, "Hub maintenance quarantine hook and validation failed", {
        cause: hookError ?? validationError,
      });
    throw Object.assign(
      new Error(`Hub maintenance quarantine preserved after validation failure: ${quarantinePath}`, {
        cause,
      }),
      {
        code: "HUB_MAINTENANCE_QUARANTINE_PRESERVED",
        committed: true,
        committedPath: quarantinePath,
        quarantinePreserved: true,
        recoveryPaths: { lockPath, quarantinePath },
      },
    );
  }

  // Keep the verified quarantine as recovery evidence. Node does not expose a
  // directory-descriptor-bound recursive remove, so deleting it by pathname
  // would reopen a check-then-remove successor race.
  return true;
}

async function recoverStaleHubMaintenanceUnderFence(
  hubRoot: string,
  { allowRestoreJournal = false, hooks }: HubMaintenanceOptions = {},
) {
  if (!allowRestoreJournal && await pathExists(hubRestoreJournalPath(hubRoot))) return false;
  const state = await readHubMaintenance(hubRoot, { hooks });
  if (!state.active) return false;
  await hooks?.afterRecoveryStateObserved?.(state);
  if (state.owner) {
    if (state.ownerAlive) return false;
    return quarantineLock(state.lockPath, state.owner, state.lockGeneration, hooks);
  }
  if (state.ageMs < INCOMPLETE_LOCK_TTL_MS) return false;
  return quarantineLock(state.lockPath, null, state.lockGeneration, hooks);
}

export async function recoverStaleHubMaintenance(
  hubRoot: string,
  options: HubMaintenanceOptions = {},
) {
  const resolvedHubRoot = canonicalHubRootPath(hubRoot);
  return withMaintenanceProcessFence(
    resolvedHubRoot,
    () => recoverStaleHubMaintenanceUnderFence(resolvedHubRoot, options),
  );
}

export async function acquireHubMaintenance(
  hubRoot: string,
  operation: string,
  { allowRestoreJournal = false, hooks }: HubMaintenanceOptions = {},
): Promise<HubMaintenanceLease> {
  const resolvedHubRoot = canonicalHubRootPath(hubRoot);
  const lockPath = hubMaintenanceLockPath(resolvedHubRoot);
  await assertMaintenanceNamespaceAuthority(lockPath);
  if (!allowRestoreJournal && await pathExists(hubRestoreJournalPath(resolvedHubRoot))) {
    throw Object.assign(
      new Error(`interrupted Hub restore requires recovery before maintenance can start (${hubRestoreJournalPath(resolvedHubRoot)})`),
      { code: "HUB_RESTORE_RECOVERY_REQUIRED" },
    );
  }
  let processIdentity: ProcessIdentity | null = null;
  try {
    processIdentity = hooks?.captureProcessIdentity
      ? hooks.captureProcessIdentity()
      : captureProcessIdentity(process.pid, { strict: true });
  } catch (error) {
    throw Object.assign(new Error("Hub maintenance process identity is unavailable", { cause: error }), {
      code: "HUB_MAINTENANCE_IDENTITY_UNAVAILABLE",
    });
  }
  const exactProcessIdentity = parseProcessIdentity(processIdentity, process.pid);
  if (!exactProcessIdentity) {
    throw Object.assign(new Error("Hub maintenance process identity is unavailable"), {
      code: "HUB_MAINTENANCE_IDENTITY_UNAVAILABLE",
    });
  }
  const owner: HubMaintenanceOwner = {
    format: "cpb-hub-maintenance/v2",
    ownerToken: randomUUID(),
    operation: String(operation || "maintenance"),
    hubRoot: resolvedHubRoot,
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    processIdentity: exactProcessIdentity,
  };

  return withMaintenanceProcessFence(resolvedHubRoot, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let created = false;
      let createdGeneration: HubMaintenanceLockGeneration | null = null;
      try {
        await mkdir(lockPath, { mode: 0o700 });
        created = true;
        const createdSnapshot = await readHubMaintenanceSnapshot(lockPath);
        if (createdSnapshot.owner !== null) {
          throw Object.assign(new Error(`new Hub maintenance lock unexpectedly has an owner: ${lockPath}`), {
            code: "HUB_MAINTENANCE_LOCK_RACE",
          });
        }
        createdGeneration = createdSnapshot.lockGeneration;
        const ownerPath = path.join(lockPath, "owner.json");
        await writeJsonDurableAtomic(ownerPath, owner);
        const published = await readHubMaintenanceSnapshot(lockPath);
        if (
          !createdGeneration
          || !sameMaintenanceLockLineage(createdGeneration, published.lockGeneration)
          || !sameOwner(owner, published.owner)
        ) {
          throw Object.assign(new Error(`Hub maintenance lock changed during owner publication: ${lockPath}`), {
            code: "HUB_MAINTENANCE_LOCK_RACE",
            committed: false,
            successorPreserved: true,
            recoveryPaths: { lockPath, ownerPath },
          });
        }
        try {
          const parent = path.dirname(lockPath);
          await hooks?.beforeLockParentSync?.({ lockPath, ownerPath, parent });
          const beforeParentSync = await readHubMaintenanceSnapshot(lockPath);
          if (
            !sameMaintenanceLockGeneration(published.lockGeneration, beforeParentSync.lockGeneration)
            || !sameOwner(owner, beforeParentSync.owner)
          ) {
            throw Object.assign(new Error(`Hub maintenance lock changed before parent sync: ${lockPath}`), {
              code: "HUB_MAINTENANCE_LOCK_RACE",
            });
          }
          await fsyncDirectory(parent);
          const final = await readHubMaintenanceSnapshot(lockPath);
          if (
            !sameMaintenanceLockGeneration(published.lockGeneration, final.lockGeneration)
            || !sameOwner(owner, final.owner)
          ) {
            throw Object.assign(new Error(`Hub maintenance lock changed after parent sync: ${lockPath}`), {
              code: "HUB_MAINTENANCE_LOCK_RACE",
            });
          }
          return {
            lockPath,
            owner,
            release: () => releaseHubMaintenance(lockPath, owner, final.lockGeneration, hooks),
          };
        } catch (cause) {
          let stillCanonical = false;
          let validationFailure: unknown = null;
          try {
            const observed = await readHubMaintenanceSnapshot(lockPath);
            stillCanonical = sameMaintenanceLockGeneration(published.lockGeneration, observed.lockGeneration)
              && sameOwner(owner, observed.owner);
          } catch (error) {
            validationFailure = error;
            stillCanonical = false;
          }
          if (!stillCanonical) {
            const raceCause = validationFailure
              ? new AggregateError([cause, validationFailure], "Hub maintenance publication and validation failed", {
                cause,
              })
              : cause;
            throw Object.assign(
              new Error(`Hub maintenance successor preserved after publication race: ${lockPath}`, { cause: raceCause }),
              {
                code: "HUB_MAINTENANCE_LOCK_RACE",
                committed: false,
                successorPreserved: true,
                recoveryPaths: { lockPath, ownerPath },
              },
            );
          }
          throw Object.assign(
            new Error(`Hub maintenance lock committed with ambiguous parent durability: ${lockPath}`, { cause }),
            {
              code: "HUB_MAINTENANCE_ACQUIRE_COMMITTED_DURABILITY_AMBIGUOUS",
              committed: true,
              phase: "lock-directory-publish",
              committedPath: ownerPath,
              recoveryPaths: { lockPath, ownerPath },
            },
          );
        }
      } catch (error) {
        if (isCommittedPublication(error)) throw error;
        if (created) {
          let cleanupError: unknown = null;
          let cleanupSkippedForSuccessor = false;
          try {
            const current = await readHubMaintenanceSnapshot(lockPath);
            if (
              createdGeneration
              && sameMaintenanceLockLineage(createdGeneration, current.lockGeneration)
              && (sameOwner(owner, current.owner) || current.owner === null)
            ) {
              cleanupSkippedForSuccessor = !(await quarantineLock(lockPath, current.owner, current.lockGeneration));
            } else cleanupSkippedForSuccessor = true;
          } catch (rollbackError) {
            if (errnoCode(rollbackError) !== "ENOENT") cleanupError = rollbackError;
          }
          if (cleanupError) {
            const cleanupRecord = cleanupError && typeof cleanupError === "object"
              ? cleanupError as Record<string, unknown>
              : {};
            throw Object.assign(
              new AggregateError([error, cleanupError], "Hub maintenance acquisition and rollback both failed", {
                cause: error,
              }),
              {
                code: errnoCode(error) || "HUB_MAINTENANCE_ACQUIRE_FAILED",
                primaryError: error,
                cleanupError,
                committed: false,
                cleanupCommitted: cleanupRecord.committed === true,
                cleanupCommittedPath: cleanupRecord.committedPath,
                recoveryPaths: cleanupRecord.recoveryPaths || { lockPath },
              },
            );
          }
          if (cleanupSkippedForSuccessor) {
            throw Object.assign(
              new Error(`Hub maintenance acquisition successor preserved: ${lockPath}`, { cause: error }),
              {
                code: "HUB_MAINTENANCE_ACQUIRE_SUCCESSOR_PRESERVED",
                committed: false,
                successorPreserved: true,
                recoveryPaths: { lockPath },
              },
            );
          }
        }
        if (errnoCode(error) !== "EEXIST") throw error;
        if (await recoverStaleHubMaintenanceUnderFence(resolvedHubRoot, { allowRestoreJournal, hooks })) continue;
        const state = await readHubMaintenance(resolvedHubRoot, { hooks });
        const heldBy = state.active && state.owner
          ? `${state.owner.operation} pid ${state.owner.pid} on ${state.owner.host}`
          : "an incomplete maintenance owner";
        throw Object.assign(new Error(`Hub maintenance lock is already held by ${heldBy}`), {
          code: "HUB_MAINTENANCE_ACTIVE",
        });
      }
    }
    throw new Error(`could not acquire Hub maintenance lock: ${lockPath}`);
  });
}

async function releaseHubMaintenance(
  lockPath: string,
  expectedOwner: HubMaintenanceOwner,
  expectedGeneration: HubMaintenanceLockGeneration,
  hooks?: HubMaintenanceHooks,
) {
  return withMaintenanceProcessFence(expectedOwner.hubRoot, async () => {
    let current: HubMaintenanceSnapshot;
    try {
      current = await readHubMaintenanceSnapshot(lockPath);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
    if (
      !sameMaintenanceLockGeneration(expectedGeneration, current.lockGeneration)
      || !sameOwner(expectedOwner, current.owner)
    ) return false;
    return quarantineLock(lockPath, expectedOwner, expectedGeneration, hooks);
  });
}
