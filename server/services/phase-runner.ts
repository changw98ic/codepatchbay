import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildChildEnv, providerCredentialKeysForAgent } from "../../core/policy/child-env.js";
import { pinnedHubRedisConfigFile } from "../../shared/hub-state-redis.js";
import type { LooseRecord } from "../../shared/types.js";
import { buildLocator, locatorEnvelope, projectExists } from "./phase-locator.js";
import { getJob, listJobsFromIndex } from "./job/job-store.js";
import { getWorkflow, bridgeForPhase as workflowBridgeForPhase, roleForPhase as workflowRoleForPhase } from "./workflow-definition.js";
import { checkPermission } from "./permission-matrix.js";
import { resolveProjectDataRoot } from "./runtime.js";
import { BoundedOutput, subprocessOutputMaxBytes } from "../../shared/bounded-output.js";

type RunChildResult = { exitCode: number; stdout: string; outputTruncated?: boolean; error?: Error | null };
type RunChildOptions = {
  env?: NodeJS.ProcessEnv;
  onOutput?: (chunk: string) => void;
  afterSpawn?: (child: ReturnType<typeof spawn>) => Promise<void> | void;
  capsulePipes?: boolean;
};
type LaunchAuthorityKind = "directory" | "file";
type LaunchGeneration = {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};
type LaunchAuthority = {
  label: string;
  path: string;
  kind: LaunchAuthorityKind;
  generation: LaunchGeneration;
  handle: FileHandle;
};
type CapsuleFileEntry = {
  kind: "file";
  path: string;
  generation: LaunchGeneration;
  digest: string;
  parent: CapsuleDirectoryEntry;
};
type CapsuleDirectoryEntry = {
  kind: "directory";
  path: string;
  generation: LaunchGeneration;
  parent: CapsuleDirectoryEntry | null;
  children: CapsuleEntry[];
};
type CapsuleEntry = CapsuleFileEntry | CapsuleDirectoryEntry;
type SourceSnapshotEntry = {
  kind: LaunchAuthorityKind;
  path: string;
  generation: LaunchGeneration;
};
type LaunchCapsule = {
  root: CapsuleDirectoryEntry;
  executorRoot: string;
  executable: string;
  jobRunner: string;
  bridgeScript: string;
  acpClient: string;
  providerEnv: NodeJS.ProcessEnv;
  manifest: CapsuleFileEntry;
  buildDurationMs: number;
};
type CapsuleBudget = {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  maxDepth: number;
  deadlineMs: number;
};
type ProviderBinding = {
  env: NodeJS.ProcessEnv;
};
type PhaseRunnerTestHooks = {
  beforeSpawn?: (context: LooseRecord) => Promise<void> | void;
  afterSpawn?: (context: LooseRecord) => Promise<void> | void;
  spawnChild?: typeof spawn;
  executablePath?: string;
  providerCommandPaths?: Record<string, string>;
  capsuleLimits?: Partial<Pick<CapsuleBudget, "maxEntries" | "maxBytes" | "maxDepth">> & {
    timeoutMs?: number;
  };
  capsuleFault?: (point: string, context: LooseRecord) => Promise<void> | void;
  afterAuthorityClose?: (authority: { label: string; path: string }) => Promise<void> | void;
};
const PARENT_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SAFE_CACHE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const EXECUTOR_CAPSULE_ENTRIES = [
  ".cpb-build.json",
  "assets",
  "bridges",
  "cli",
  "core",
  "cpb",
  "node_modules",
  "package.json",
  "profiles",
  "providers",
  "release",
  "runtime",
  "scripts",
  "server",
  "shared",
  "skills",
  "templates",
  "wiki",
] as const;
const CAPSULE_COPY_BUFFER_BYTES = 1024 * 1024;
const CAPSULE_MAX_ENTRIES = 10_000;
const CAPSULE_MAX_BYTES = 512 * 1024 * 1024;
const CAPSULE_MAX_DEPTH = 48;
const CAPSULE_BUILD_TIMEOUT_MS = 120_000;
const CAPSULE_VERIFY_TIMEOUT_MS = 120_000;
const CAPSULE_MANIFEST_FILE = "launch-manifest.json";
const ACP_CLIENT_RELATIVE_PATH = "server/services/acp/acp-client.js";
const CAPSULE_CREDENTIAL_MAX_BYTES = 64 * 1024;
const CAPSULE_BOOTSTRAP_TIMEOUT_MS = 15_000;
const PHASE_LAUNCH_BOOTSTRAP = String.raw`
import { createHash as capsuleHash } from "node:crypto";
import { constants as capsuleConstants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import capsulePath from "node:path";
import { pathToFileURL as capsulePathToFileURL } from "node:url";

const fail = (message) => { throw Object.assign(new Error(message), { code: "PHASE_RUNNER_BOOTSTRAP_FAILED" }); };
const generation = (info) => ({ dev: info.dev, ino: info.ino, mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
const sameGeneration = (expected, actual) => expected && expected.dev === actual.dev && expected.ino === actual.ino && expected.mode === actual.mode && expected.size === actual.size && expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
const withinRoot = (root, relative) => {
  if (typeof relative !== "string" || !relative || capsulePath.isAbsolute(relative)) fail("invalid capsule manifest path");
  const candidate = capsulePath.resolve(root, relative);
  const delta = capsulePath.relative(root, candidate);
  if (!delta || delta === ".." || delta.startsWith(".." + capsulePath.sep) || capsulePath.isAbsolute(delta)) fail("capsule manifest path escapes root");
  return candidate;
};
const verifyDirectory = (target, expected) => {
  const before = lstatSync(target);
  if (before.isSymbolicLink() || !before.isDirectory() || !sameGeneration(expected, generation(before))) fail("capsule directory generation changed: " + target);
  let fd;
  try {
    fd = openSync(target, capsuleConstants.O_RDONLY | capsuleConstants.O_NOFOLLOW | capsuleConstants.O_DIRECTORY);
    const opened = fstatSync(fd);
    const current = lstatSync(target);
    if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory() || !sameGeneration(expected, generation(opened)) || !sameGeneration(expected, generation(current))) fail("capsule directory authority changed: " + target);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
const verifyFile = (target, expected, digest, maxBytes, captureBody = false) => {
  const before = lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile() || !sameGeneration(expected, generation(before))) fail("capsule file generation changed: " + target);
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) fail("capsule file size exceeds bootstrap bound: " + target);
  let fd;
  try {
    fd = openSync(target, capsuleConstants.O_RDONLY | capsuleConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameGeneration(expected, generation(opened))) fail("capsule file descriptor changed: " + target);
    const hasher = capsuleHash("sha256");
    const chunks = captureBody ? [] : null;
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.size)));
    let offset = 0;
    while (offset < opened.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (count <= 0) fail("capsule file digest ended early: " + target);
      const chunk = buffer.subarray(0, count);
      hasher.update(chunk);
      if (chunks) chunks.push(Buffer.from(chunk));
      offset += count;
    }
    if (hasher.digest("hex") !== digest) fail("capsule file digest changed: " + target);
    const current = lstatSync(target);
    if (current.isSymbolicLink() || !current.isFile() || !sameGeneration(expected, generation(current))) fail("capsule file changed while hashing: " + target);
    return chunks ? Buffer.concat(chunks) : null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
const decodeSpec = () => {
  if (typeof process.argv[1] !== "string" || process.argv[1].length > 256 * 1024) fail("missing or oversized capsule bootstrap spec");
  const parsed = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
  if (!parsed || parsed.schema !== "cpb.phase-launch-bootstrap.v1") fail("invalid capsule bootstrap spec");
  return parsed;
};
const spec = decodeSpec();
const verifyCapsule = () => {
  if (realpathSync(spec.root.path) !== spec.root.path) fail("capsule root is no longer canonical");
  verifyDirectory(spec.root.path, spec.root.generation);
  const manifestBody = verifyFile(spec.manifest.path, spec.manifest.generation, spec.manifest.digest, spec.maxManifestBytes, true);
  const manifest = JSON.parse(manifestBody.toString("utf8"));
  if (!manifest || manifest.schema !== "cpb.phase-launch-manifest.v1" || !Array.isArray(manifest.entries) || manifest.entries.length > spec.maxEntries) fail("invalid capsule manifest");
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    const target = withinRoot(spec.root.path, entry.path);
    if (entry.kind === "directory") {
      verifyDirectory(target, entry.generation);
    } else if (entry.kind === "file") {
      totalBytes += Number(entry.generation && entry.generation.size);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > spec.maxBytes) fail("capsule manifest exceeds byte bound");
      verifyFile(target, entry.generation, entry.digest, spec.maxBytes);
    } else {
      fail("invalid capsule manifest entry kind");
    }
  }
  verifyFile(spec.manifest.path, spec.manifest.generation, spec.manifest.digest, spec.maxManifestBytes);
  verifyDirectory(spec.root.path, spec.root.generation);
};
const readCredentialFrame = () => {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(4096);
  try {
    while (true) {
      const count = readSync(4, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > spec.maxCredentialBytes) fail("credential frame exceeds bound");
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } finally {
    closeSync(4);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n")) fail("credential frame has replay or extra bytes");
  const frame = JSON.parse(raw.slice(0, -1));
  if (!frame || frame.schema !== "cpb.phase-launch-credentials.v1" || frame.nonce !== spec.nonce || !frame.env || typeof frame.env !== "object" || Array.isArray(frame.env)) fail("invalid credential frame");
  const keys = Object.keys(frame.env).sort();
  if (JSON.stringify(keys) !== JSON.stringify(spec.credentialKeys)) fail("credential frame scope mismatch");
  for (const key of keys) if (typeof frame.env[key] !== "string" || key.includes("=") || key.includes("\0")) fail("invalid credential frame entry");
  return frame.env;
};

try {
  verifyCapsule();
  writeSync(3, "READY " + spec.nonce + "\n");
  closeSync(3);
  const credentials = readCredentialFrame();
  verifyCapsule();
  for (const [key, value] of Object.entries(credentials)) process.env[key] = value;
  process.argv = [process.execPath, spec.jobRunner, ...spec.jobRunnerArgs];
  await import(capsulePathToFileURL(spec.jobRunner).href);
} catch (error) {
  try { closeSync(3); } catch {}
  try { closeSync(4); } catch {}
  process.stderr.write("phase launch bootstrap failed: " + (error && error.message ? error.message : String(error)) + "\n");
  process.exitCode = 126;
}
`;
const launchTestHooks = new AsyncLocalStorage<PhaseRunnerTestHooks>();

export function withPhaseRunnerTestHooksForTests<T>(hooks: PhaseRunnerTestHooks, operation: () => T): T {
  return launchTestHooks.run(hooks, operation);
}

function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): LooseRecord {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

export function normalizePhaseEnv(
  value: unknown,
  fallback: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const input = value === undefined ? fallback : value;
  if (!isRecord(input)) {
    throw new TypeError("phase environment must be an object");
  }

  const entries: [string, string][] = [];
  for (const [key, envValue] of Object.entries(input)) {
    if (!key || key.includes("=") || key.includes("\0")) {
      throw new TypeError(`phase environment key ${JSON.stringify(key)} is invalid`);
    }
    if (envValue === undefined) continue;
    if (typeof envValue !== "string") {
      throw new TypeError(`phase environment value ${key} must be a string`);
    }
    entries.push([key, envValue]);
  }
  return Object.fromEntries(entries);
}

function launchError(message: string, code = "PHASE_RUNNER_AUTHORITY_INVALID", cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function assertStrictLaunchPlatform() {
  if (process.platform === "win32") {
    throw launchError(
      "phase launch capsules require POSIX O_NOFOLLOW and O_DIRECTORY semantics",
      "PHASE_RUNNER_PLATFORM_UNSUPPORTED",
    );
  }
  if (typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0) {
    throw launchError(
      "phase launch capsules require O_NOFOLLOW and O_DIRECTORY",
      "PHASE_RUNNER_PLATFORM_UNSUPPORTED",
    );
  }
}

function createCapsuleBudget(): CapsuleBudget {
  const limits = launchTestHooks.getStore()?.capsuleLimits;
  const bounded = (value: unknown, fallback: number) => Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
  return {
    entries: 0,
    bytes: 0,
    maxEntries: bounded(limits?.maxEntries, CAPSULE_MAX_ENTRIES),
    maxBytes: bounded(limits?.maxBytes, CAPSULE_MAX_BYTES),
    maxDepth: bounded(limits?.maxDepth, CAPSULE_MAX_DEPTH),
    deadlineMs: Date.now() + bounded(limits?.timeoutMs, CAPSULE_BUILD_TIMEOUT_MS),
  };
}

function chargeCapsuleBudget(budget: CapsuleBudget, { bytes = 0, depth = 0, label = "entry" } = {}) {
  if (Date.now() > budget.deadlineMs) {
    throw launchError(`phase launch capsule build timed out while copying ${label}`, "PHASE_RUNNER_CAPSULE_LIMIT");
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw launchError(`phase launch capsule ${label} has an unsupported size`, "PHASE_RUNNER_CAPSULE_LIMIT");
  }
  budget.entries += 1;
  budget.bytes += bytes;
  if (budget.entries > budget.maxEntries) {
    throw launchError(
      `phase launch capsule exceeds ${budget.maxEntries} entries`,
      "PHASE_RUNNER_CAPSULE_LIMIT",
    );
  }
  if (budget.bytes > budget.maxBytes) {
    throw launchError(
      `phase launch capsule exceeds ${budget.maxBytes} bytes`,
      "PHASE_RUNNER_CAPSULE_LIMIT",
    );
  }
  if (depth > budget.maxDepth) {
    throw launchError(
      `phase launch capsule exceeds depth ${budget.maxDepth} at ${label}`,
      "PHASE_RUNNER_CAPSULE_LIMIT",
    );
  }
}

function assertCapsuleBudgetTime(budget: CapsuleBudget, label: string) {
  if (Date.now() > budget.deadlineMs) {
    throw launchError(`phase launch capsule build timed out while copying ${label}`, "PHASE_RUNNER_CAPSULE_LIMIT");
  }
}

async function capsuleFault(point: string, context: LooseRecord) {
  await launchTestHooks.getStore()?.capsuleFault?.(point, context);
}

function generationOf(info: {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): LaunchGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameLaunchGeneration(expected: LaunchGeneration, actual: LaunchGeneration) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.mode === actual.mode
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs;
}

function strictAuthorityFlags(kind: LaunchAuthorityKind) {
  assertStrictLaunchPlatform();
  if (kind === "directory") {
    return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
}

function isExpectedAuthorityKind(info: Awaited<ReturnType<typeof lstat>>, kind: LaunchAuthorityKind) {
  return kind === "directory" ? info.isDirectory() : info.isFile();
}

async function openLaunchAuthority(filePath: string, label: string, kind: LaunchAuthorityKind): Promise<LaunchAuthority> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !isExpectedAuthorityKind(before, kind)) {
    throw launchError(`${label} must be a non-symlink ${kind}: ${filePath}`);
  }
  const canonical = await realpath(filePath);
  if (path.resolve(canonical) !== path.resolve(filePath)) {
    throw launchError(`${label} escaped its canonical path: ${filePath}`);
  }

  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, strictAuthorityFlags(kind));
    const opened = await handle.stat();
    if (!isExpectedAuthorityKind(opened, kind)
      || !sameLaunchGeneration(generationOf(before), generationOf(opened))) {
      throw launchError(`${label} changed while its authority was opened: ${filePath}`);
    }
    return {
      label,
      path: filePath,
      kind,
      generation: generationOf(opened),
      handle,
    };
  } catch (error) {
    const closeErrors: unknown[] = [];
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        closeErrors.push(closeError);
      }
    }
    if (closeErrors.length > 0) {
      throw new AggregateError([error, ...closeErrors], `${label} authority open and close failed`, { cause: error });
    }
    throw error;
  }
}

async function openLaunchIdentityAuthority(
  filePath: string,
  label: string,
  kind: LaunchAuthorityKind,
): Promise<LaunchAuthority> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !isExpectedAuthorityKind(before, kind)) {
    throw launchError(`${label} must be a non-symlink ${kind}: ${filePath}`);
  }
  const canonical = await realpath(filePath);
  if (path.resolve(canonical) !== path.resolve(filePath)) {
    throw launchError(`${label} escaped its canonical path: ${filePath}`);
  }
  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, strictAuthorityFlags(kind));
    const [opened, current] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (!isExpectedAuthorityKind(opened, kind)
      || current.isSymbolicLink()
      || !isExpectedAuthorityKind(current, kind)
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || current.dev !== before.dev
      || current.ino !== before.ino) {
      throw launchError(`${label} identity changed while its authority was opened: ${filePath}`);
    }
    return { label, path: filePath, kind, generation: generationOf(opened), handle };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], `${label} identity authority open and close failed`, {
          cause: error,
        });
      }
    }
    throw error;
  }
}

async function assertLaunchAuthority(authority: LaunchAuthority) {
  const [descriptor, current] = await Promise.all([
    authority.handle.stat(),
    lstat(authority.path),
  ]);
  if (current.isSymbolicLink()
    || !isExpectedAuthorityKind(descriptor, authority.kind)
    || !isExpectedAuthorityKind(current, authority.kind)
    || !sameLaunchGeneration(authority.generation, generationOf(descriptor))
    || !sameLaunchGeneration(authority.generation, generationOf(current))) {
    throw launchError(`${authority.label} changed after its authority was bound: ${authority.path}`);
  }
  const canonical = await realpath(authority.path);
  if (path.resolve(canonical) !== path.resolve(authority.path)) {
    throw launchError(`${authority.label} no longer resolves to its canonical path: ${authority.path}`);
  }
}

async function assertLaunchAuthorityIdentity(authority: LaunchAuthority) {
  const [descriptor, current] = await Promise.all([
    authority.handle.stat(),
    lstat(authority.path),
  ]);
  if (current.isSymbolicLink()
    || !isExpectedAuthorityKind(descriptor, authority.kind)
    || !isExpectedAuthorityKind(current, authority.kind)
    || descriptor.dev !== authority.generation.dev
    || descriptor.ino !== authority.generation.ino
    || current.dev !== authority.generation.dev
    || current.ino !== authority.generation.ino) {
    throw launchError(`${authority.label} identity changed after its authority was bound: ${authority.path}`);
  }
  const canonical = await realpath(authority.path);
  if (path.resolve(canonical) !== path.resolve(authority.path)) {
    throw launchError(`${authority.label} no longer resolves to its canonical path: ${authority.path}`);
  }
}

async function assertLaunchAuthorities(authorities: LaunchAuthority[]) {
  for (const authority of authorities) await assertLaunchAuthority(authority);
}

async function closeLaunchAuthorities(authorities: LaunchAuthority[]) {
  const errors: unknown[] = [];
  for (const authority of [...authorities].reverse()) {
    try {
      await authority.handle.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await launchTestHooks.getStore()?.afterAuthorityClose?.({
        label: authority.label,
        path: authority.path,
      });
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function isMissingPathError(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function assertCapsuleKind(
  info: Awaited<ReturnType<typeof lstat>>,
  kind: LaunchAuthorityKind,
  filePath: string,
) {
  if (info.isSymbolicLink() || !isExpectedAuthorityKind(info, kind)) {
    throw launchError(`launch capsule ${kind} changed kind: ${filePath}`, "PHASE_RUNNER_CAPSULE_CHANGED");
  }
}

async function assertCapsuleEntryGeneration(entry: CapsuleEntry) {
  const current = await lstat(entry.path);
  assertCapsuleKind(current, entry.kind, entry.path);
  if (!sameLaunchGeneration(entry.generation, generationOf(current))) {
    throw launchError(`launch capsule ${entry.kind} changed generation: ${entry.path}`, "PHASE_RUNNER_CAPSULE_CHANGED");
  }
}

async function refreshCapsuleDirectoryGeneration(entry: CapsuleDirectoryEntry) {
  const current = await lstat(entry.path);
  assertCapsuleKind(current, "directory", entry.path);
  if (current.dev !== entry.generation.dev || current.ino !== entry.generation.ino) {
    throw launchError(`launch capsule directory was replaced: ${entry.path}`, "PHASE_RUNNER_CAPSULE_CHANGED");
  }
  entry.generation = generationOf(current);
}

function rootCapsuleEntry(entry: CapsuleEntry): CapsuleDirectoryEntry {
  let current: CapsuleEntry = entry;
  while (current.parent) current = current.parent;
  return current as CapsuleDirectoryEntry;
}

async function createCapsuleDirectory(
  directoryPath: string,
  parent: CapsuleDirectoryEntry,
  budget: CapsuleBudget,
  depth: number,
): Promise<CapsuleDirectoryEntry> {
  chargeCapsuleBudget(budget, { depth, label: directoryPath });
  await assertCapsuleEntryGeneration(parent);
  await mkdir(directoryPath, { mode: 0o700 });
  const info = await lstat(directoryPath);
  assertCapsuleKind(info, "directory", directoryPath);
  const entry: CapsuleDirectoryEntry = {
    kind: "directory",
    path: directoryPath,
    generation: generationOf(info),
    parent,
    children: [],
  };
  parent.children.push(entry);
  await refreshCapsuleDirectoryGeneration(parent);
  await capsuleFault("after-directory-registered", { path: directoryPath, root: rootCapsuleEntry(parent).path });
  return entry;
}

async function setCapsuleDirectoryMode(entry: CapsuleDirectoryEntry, mode: number) {
  await assertCapsuleEntryGeneration(entry);
  let handle: FileHandle | null = null;
  let primaryError: unknown = null;
  try {
    handle = await open(entry.path, strictAuthorityFlags("directory"));
    const opened = await handle.stat();
    if (!sameLaunchGeneration(entry.generation, generationOf(opened))) {
      throw launchError(`launch capsule directory changed while sealing: ${entry.path}`, "PHASE_RUNNER_CAPSULE_CHANGED");
    }
    await handle.chmod(mode);
    const sealed = await handle.stat();
    const current = await lstat(entry.path);
    assertCapsuleKind(current, "directory", entry.path);
    if (sealed.dev !== entry.generation.dev
      || sealed.ino !== entry.generation.ino
      || sealed.dev !== current.dev
      || sealed.ino !== current.ino) {
      throw launchError(`launch capsule directory was replaced while sealing: ${entry.path}`, "PHASE_RUNNER_CAPSULE_CHANGED");
    }
    entry.generation = generationOf(sealed);
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError && closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      `launch capsule directory seal and close failed: ${entry.path}`,
      { cause: primaryError },
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
}

async function writeCapsuleFile(
  destinationPath: string,
  destinationParent: CapsuleDirectoryEntry,
  content: string | Buffer,
  budget: CapsuleBudget,
  depth: number,
  label: string,
): Promise<CapsuleFileEntry> {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  chargeCapsuleBudget(budget, { bytes: body.byteLength, depth, label });
  await assertCapsuleEntryGeneration(destinationParent);
  let handle: FileHandle | null = null;
  let entry: CapsuleFileEntry | null = null;
  let primaryError: unknown = null;
  try {
    handle = await open(
      destinationPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const created = await handle.stat();
    entry = {
      kind: "file",
      path: destinationPath,
      generation: generationOf(created),
      digest: "",
      parent: destinationParent,
    };
    destinationParent.children.push(entry);
    await refreshCapsuleDirectoryGeneration(destinationParent);
    await capsuleFault("after-file-registered", {
      path: destinationPath,
      root: rootCapsuleEntry(destinationParent).path,
      label,
    });
    await handle.writeFile(body);
    assertCapsuleBudgetTime(budget, label);
    await handle.chmod(0o400);
    await handle.sync();
    const completed = await handle.stat();
    if (completed.size !== body.byteLength) {
      throw launchError(`launch capsule generated file size mismatch for ${label}: ${destinationPath}`);
    }
    entry.generation = generationOf(completed);
    entry.digest = createHash("sha256").update(body).digest("hex");
    await capsuleFault("after-file-copied", {
      path: destinationPath,
      root: rootCapsuleEntry(destinationParent).path,
      label,
    });
  } catch (error) {
    primaryError = error;
    if (handle && entry) {
      try {
        entry.generation = generationOf(await handle.stat());
      } catch {}
    }
  }
  let closeError: unknown = null;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError && closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      `launch capsule generated file write and close failed: ${destinationPath}`,
      { cause: primaryError },
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return entry as CapsuleFileEntry;
}

async function openStableSourceFile(sourcePath: string, label: string) {
  const before = await lstat(sourcePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw launchError(`${label} must be a non-symlink file: ${sourcePath}`);
  }
  const handle = await open(sourcePath, strictAuthorityFlags("file"));
  try {
    const opened = await handle.stat();
    if (!sameLaunchGeneration(generationOf(before), generationOf(opened))) {
      throw launchError(`${label} changed while opening: ${sourcePath}`);
    }
    return { handle, generation: generationOf(opened), mode: opened.mode, size: opened.size };
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        `${label} open validation and close failed: ${sourcePath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function copyStableSourceFile(
  sourcePath: string,
  destinationPath: string,
  destinationParent: CapsuleDirectoryEntry,
  sourceSnapshot: SourceSnapshotEntry[],
  label: string,
  budget: CapsuleBudget,
  depth: number,
): Promise<CapsuleFileEntry> {
  const source = await openStableSourceFile(sourcePath, label);
  let destination: FileHandle | null = null;
  let destinationEntry: CapsuleFileEntry | null = null;
  let primaryError: unknown = null;

  try {
    if (!Number.isSafeInteger(source.size) || source.size < 0) {
      throw launchError(`${label} has an unsupported size: ${sourcePath}`);
    }
    chargeCapsuleBudget(budget, { bytes: source.size, depth, label });
    await assertCapsuleEntryGeneration(destinationParent);
    destination = await open(
      destinationPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const created = await destination.stat();
    destinationEntry = {
      kind: "file",
      path: destinationPath,
      generation: generationOf(created),
      digest: "",
      parent: destinationParent,
    };
    destinationParent.children.push(destinationEntry);
    await refreshCapsuleDirectoryGeneration(destinationParent);
    await capsuleFault("after-file-registered", {
      path: destinationPath,
      root: rootCapsuleEntry(destinationParent).path,
      label,
    });

    const buffer = Buffer.allocUnsafe(Math.min(CAPSULE_COPY_BUFFER_BYTES, Math.max(1, source.size)));
    let copiedWithClone = false;
    try {
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_FICLONE);
      copiedWithClone = true;
      assertCapsuleBudgetTime(budget, label);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL"].includes(String(code || ""))) throw error;
      await destination.truncate(0);
    }
    if (!copiedWithClone) {
      let offset = 0;
      while (offset < source.size) {
        const requested = Math.min(buffer.length, source.size - offset);
        if (Date.now() > budget.deadlineMs) {
          throw launchError(`phase launch capsule build timed out while copying ${label}`, "PHASE_RUNNER_CAPSULE_LIMIT");
        }
        const { bytesRead } = await source.handle.read(buffer, 0, requested, offset);
        if (bytesRead <= 0) {
          throw launchError(`${label} ended before its validated size: ${sourcePath}`);
        }
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(buffer, written, bytesRead - written, offset + written);
          if (result.bytesWritten <= 0) {
            throw launchError(`launch capsule write made no progress: ${destinationPath}`);
          }
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
    }

    const sourceAfter = await source.handle.stat();
    const sourcePathAfter = await lstat(sourcePath);
    if (!sameLaunchGeneration(source.generation, generationOf(sourceAfter))
      || sourcePathAfter.isSymbolicLink()
      || !sameLaunchGeneration(source.generation, generationOf(sourcePathAfter))) {
      throw launchError(`${label} changed while its launch capsule copy was created: ${sourcePath}`);
    }

    const destinationPathAfterCopy = await lstat(destinationPath);
    if (destinationPathAfterCopy.isSymbolicLink()
      || destinationPathAfterCopy.dev !== destinationEntry.generation.dev
      || destinationPathAfterCopy.ino !== destinationEntry.generation.ino) {
      throw launchError(`launch capsule destination was replaced while copying ${label}: ${destinationPath}`);
    }
    await destination.chmod((source.mode & 0o111) === 0 ? 0o400 : 0o500);
    await destination.sync();
    const copied = await destination.stat();
    if (copied.size !== source.size) {
      throw launchError(`launch capsule copy size mismatch for ${label}: ${destinationPath}`);
    }
    const sourceDigestHash = createHash("sha256");
    let sourceVerifyOffset = 0;
    while (sourceVerifyOffset < source.size) {
      assertCapsuleBudgetTime(budget, label);
      const requested = Math.min(buffer.length, source.size - sourceVerifyOffset);
      const { bytesRead } = await source.handle.read(buffer, 0, requested, sourceVerifyOffset);
      if (bytesRead <= 0) {
        throw launchError(`${label} digest verification ended early: ${sourcePath}`);
      }
      sourceDigestHash.update(buffer.subarray(0, bytesRead));
      sourceVerifyOffset += bytesRead;
    }
    const sourceDigest = sourceDigestHash.digest("hex");
    const copiedDigest = createHash("sha256");
    let verifyOffset = 0;
    while (verifyOffset < copied.size) {
      assertCapsuleBudgetTime(budget, label);
      const requested = Math.min(buffer.length, copied.size - verifyOffset);
      const { bytesRead } = await destination.read(buffer, 0, requested, verifyOffset);
      if (bytesRead <= 0) {
        throw launchError(`launch capsule verification ended early for ${label}: ${destinationPath}`);
      }
      copiedDigest.update(buffer.subarray(0, bytesRead));
      verifyOffset += bytesRead;
    }
    const verifiedDigest = copiedDigest.digest("hex");
    if (verifiedDigest !== sourceDigest) {
      throw launchError(`launch capsule digest mismatch for ${label}: ${destinationPath}`);
    }
    destinationEntry.generation = generationOf(copied);
    destinationEntry.digest = verifiedDigest;
    sourceSnapshot.push({
      kind: "file",
      path: sourcePath,
      generation: source.generation,
    });
    await capsuleFault("after-file-copied", {
      path: destinationPath,
      root: rootCapsuleEntry(destinationParent).path,
      label,
    });
  } catch (error) {
    primaryError = error;
    if (destination && destinationEntry) {
      try {
        destinationEntry.generation = generationOf(await destination.stat());
      } catch {}
    }
  }

  const closeErrors: unknown[] = [];
  for (const handle of [destination, source.handle]) {
    if (!handle) continue;
    try {
      await handle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (primaryError || closeErrors.length > 0) {
    const errors = [primaryError, ...closeErrors].filter((error) => error !== null && error !== undefined);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(
      errors,
      `launch capsule copy and close failed for ${label}: ${sourcePath}`,
      { cause: errors[0] },
    );
  }
  return destinationEntry as CapsuleFileEntry;
}

async function copyStableSourceDirectory(
  sourcePath: string,
  destinationPath: string,
  destinationParent: CapsuleDirectoryEntry,
  sourceSnapshot: SourceSnapshotEntry[],
  label: string,
  budget: CapsuleBudget,
  depth: number,
): Promise<CapsuleDirectoryEntry> {
  const authority = await openLaunchAuthority(sourcePath, label, "directory");
  let destination: CapsuleDirectoryEntry | null = null;
  let primaryError: unknown = null;
  try {
    destination = await createCapsuleDirectory(destinationPath, destinationParent, budget, depth);
    assertCapsuleBudgetTime(budget, label);
    const entries = (await readdir(sourcePath, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertCapsuleBudgetTime(budget, label);
      if (entry.name === ".bin" && path.basename(sourcePath) === "node_modules") continue;
      const childSource = path.join(sourcePath, entry.name);
      const childDestination = path.join(destinationPath, entry.name);
      if (entry.isDirectory()) {
        await copyStableSourceDirectory(
          childSource,
          childDestination,
          destination,
          sourceSnapshot,
          `${label}/${entry.name}`,
          budget,
          depth + 1,
        );
      } else if (entry.isFile()) {
        await copyStableSourceFile(
          childSource,
          childDestination,
          destination,
          sourceSnapshot,
          `${label}/${entry.name}`,
          budget,
          depth + 1,
        );
      } else {
        throw launchError(`executor launch closure contains a symlink or special entry: ${childSource}`);
      }
    }
    await assertLaunchAuthority(authority);
    sourceSnapshot.push({
      kind: "directory",
      path: sourcePath,
      generation: authority.generation,
    });
    await setCapsuleDirectoryMode(destination, 0o500);
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown = null;
  try {
    await authority.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      `executor launch closure copy and authority close failed: ${sourcePath}`,
      { cause: primaryError },
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return destination as CapsuleDirectoryEntry;
}

async function assertSourceSnapshot(snapshot: SourceSnapshotEntry[], budget?: CapsuleBudget) {
  for (const entry of snapshot) {
    if (budget) assertCapsuleBudgetTime(budget, entry.path);
    const current = await lstat(entry.path);
    if (current.isSymbolicLink()
      || !isExpectedAuthorityKind(current, entry.kind)
      || !sameLaunchGeneration(entry.generation, generationOf(current))) {
      throw launchError(`executor launch closure changed during capsule creation: ${entry.path}`);
    }
  }
}

function providerEnvPrefix(agent: string) {
  const normalized = agent.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(normalized)) {
    throw launchError(`invalid selected provider name: ${agent}`, "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
  }
  return `CPB_ACP_${normalized.toUpperCase().replace(/[-.]/g, "_")}`;
}

function providerDefaultCommand(agent: string) {
  const normalized = agent.trim().toLowerCase();
  if (["codex", "openai", "openai-codex"].includes(normalized)) return "codex-acp";
  if (normalized === "claude" || normalized.startsWith("claude-")
    || ["anthropic", "bedrock", "aws-bedrock", "glm", "glm-compatible", "zhipu", "mimo", "mimo-v2.5pro", "xiaomi"].includes(normalized)) {
    return "claude-agent-acp";
  }
  if (["gemini", "google"].includes(normalized)) return "gemini-acp";
  return normalized;
}

function parseProviderArgs(value: string | undefined, key: string) {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw launchError(
      `${key} must be a JSON array so the provider launch is unambiguous`,
      "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE",
      error,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.includes("\0"))) {
    throw launchError(`${key} must be a JSON array of strings`, "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
  }
  return parsed as string[];
}

async function resolveFixedProviderCommand(
  agent: string,
  canonicalExecutable: string,
  inputEnv: NodeJS.ProcessEnv,
) {
  const prefix = providerEnvPrefix(agent);
  const override = String(inputEnv[`${prefix}_COMMAND`] || "").trim();
  const hookPath = launchTestHooks.getStore()?.providerCommandPaths?.[agent];
  let requested = override || hookPath || "";
  let isDefault = false;
  if (requested && !path.isAbsolute(requested)) {
    throw launchError(
      `${prefix}_COMMAND must be an absolute path; PATH-based provider overrides are not trusted`,
      "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE",
    );
  }
  if (!requested) {
    isDefault = true;
    const commandName = providerDefaultCommand(agent);
    const candidateDirectories = [...new Set([
      path.dirname(canonicalExecutable),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ])];
    for (const directory of candidateDirectories) {
      const candidate = path.join(directory, commandName);
      try {
        const info = await lstat(candidate);
        if (info.isFile() || info.isSymbolicLink()) {
          requested = candidate;
          break;
        }
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
  }
  if (!requested) {
    throw launchError(
      `selected provider adapter is unavailable outside ambient PATH: ${providerDefaultCommand(agent)}`,
      "PHASE_RUNNER_PROVIDER_UNAVAILABLE",
    );
  }
  const canonical = await realpath(requested);
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw launchError(`selected provider adapter must resolve to a regular file: ${requested}`, "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
  }
  const args = parseProviderArgs(inputEnv[`${prefix}_ARGS`], `${prefix}_ARGS`);
  return { prefix, requested, canonical, args, isDefault };
}

async function nearestPackageRoot(entryPath: string) {
  let current = path.dirname(entryPath);
  const filesystemRoot = path.parse(current).root;
  while (current !== filesystemRoot) {
    const manifest = path.join(current, "package.json");
    try {
      const info = await lstat(manifest);
      if (info.isFile() && !info.isSymbolicLink()) return current;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    current = path.dirname(current);
  }
  return null;
}

async function assertStandaloneProviderScript(scriptPath: string) {
  const info = await lstat(scriptPath);
  if (info.size > 8 * 1024 * 1024) {
    throw launchError(`standalone provider script is too large: ${scriptPath}`, "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
  }
  const source = await readFile(scriptPath, "utf8");
  const mutableImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire(?:\.resolve)?\s*\()\s*["'](?:\.{1,2}\/|\/)/;
  if (mutableImport.test(source)) {
    throw launchError(
      `standalone provider script has an uncaptured path import: ${scriptPath}`,
      "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE",
    );
  }
}

async function providerArtifactKind(filePath: string): Promise<"node" | "native"> {
  const source = await openStableSourceFile(filePath, "provider executable");
  let body = Buffer.alloc(0);
  let primaryError: unknown = null;
  try {
    const buffer = Buffer.allocUnsafe(Math.min(4096, Math.max(1, source.size)));
    const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, 0);
    body = Buffer.from(buffer.subarray(0, bytesRead));
    const after = await source.handle.stat();
    const current = await lstat(filePath);
    if (current.isSymbolicLink()
      || !sameLaunchGeneration(source.generation, generationOf(after))
      || !sameLaunchGeneration(source.generation, generationOf(current))) {
      throw launchError(`provider executable changed while classifying: ${filePath}`, "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
    }
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await source.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    throw new AggregateError([primaryError, closeError], `provider executable classification failed: ${filePath}`, {
      cause: primaryError,
    });
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;

  const firstLine = body.toString("utf8", 0, Math.min(body.length, 256)).split(/\r?\n/, 1)[0];
  if ([".js", ".mjs", ".cjs"].includes(path.extname(filePath).toLowerCase())) return "node";
  if (/^#!.*(?:\/node|\benv\s+(?:-[A-Za-z]+\s+)*node)(?:\s|$)/.test(firstLine)) return "node";
  const magic = body.subarray(0, 4).toString("hex");
  if (["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca"].includes(magic)) {
    return "native";
  }
  throw launchError(
    `provider executable is neither a Node script nor a supported native binary: ${filePath}`,
    "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE",
  );
}

function findCapsuleFile(
  entry: CapsuleEntry,
  predicate: (candidate: CapsuleFileEntry) => boolean,
): CapsuleFileEntry | null {
  if (entry.kind === "file") return predicate(entry) ? entry : null;
  for (const child of entry.children) {
    const match = findCapsuleFile(child, predicate);
    if (match) return match;
  }
  return null;
}

async function bindProviderIntoCapsule(
  agent: string | null,
  canonicalExecutable: string,
  capsuleExecutable: string,
  inputEnv: NodeJS.ProcessEnv,
  root: CapsuleDirectoryEntry,
  budget: CapsuleBudget,
): Promise<ProviderBinding> {
  if (!agent) return { env: {} };
  for (const key of ["CPB_ACP_CLIENT", "CPB_AGENT_SANDBOX_COMMAND", "CPB_AGENT_SANDBOX_ARGS", "CPB_CLAUDE_CLI_COMMAND"]) {
    if (inputEnv[key]) {
      throw launchError(`${key} cannot select a mutable command at the phase credential boundary`, "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
    }
  }
  const resolved = await resolveFixedProviderCommand(agent, canonicalExecutable, inputEnv);
  for (const arg of resolved.args) {
    if (path.isAbsolute(arg)
      || arg === "."
      || arg === ".."
      || arg.includes("/")
      || arg.includes("\\")) {
      throw launchError(
        `provider argument refers to an uncaptured filesystem path: ${arg}`,
        "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE",
      );
    }
  }

  const providerDirectory = await createCapsuleDirectory(path.join(root.path, "provider"), root, budget, 1);
  const artifactKind = await providerArtifactKind(resolved.canonical);
  let command: string;
  let args: string[];
  let packageEntry: CapsuleEntry | null = null;
  if (artifactKind === "node") {
    const packageRoot = await nearestPackageRoot(resolved.canonical);
    if (packageRoot && (resolved.isDefault || resolved.canonical.startsWith(`${packageRoot}${path.sep}`))) {
      const destination = path.join(providerDirectory.path, "package");
      const snapshot: SourceSnapshotEntry[] = [];
      packageEntry = await copyStableSourceDirectory(
        packageRoot,
        destination,
        providerDirectory,
        snapshot,
        `provider/${agent}`,
        budget,
        2,
      );
      await assertSourceSnapshot(snapshot, budget);
      command = capsuleExecutable;
      args = [path.join(destination, path.relative(packageRoot, resolved.canonical)), ...resolved.args];
    } else {
      await assertStandaloneProviderScript(resolved.canonical);
      const destination = path.join(providerDirectory.path, "adapter.js");
      await copyStableSourceFile(
        resolved.canonical,
        destination,
        providerDirectory,
        [],
        `provider/${agent}`,
        budget,
        2,
      );
      command = capsuleExecutable;
      args = [destination, ...resolved.args];
    }
  } else {
    const destination = path.join(providerDirectory.path, "adapter");
    const entry = await copyStableSourceFile(
      resolved.canonical,
      destination,
      providerDirectory,
      [],
      `provider/${agent}`,
      budget,
      2,
    );
    if ((entry.generation.mode & 0o111) === 0) {
      throw launchError(`selected provider adapter is not executable: ${resolved.canonical}`, "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
    }
    command = destination;
    args = resolved.args;
  }

  const env: NodeJS.ProcessEnv = {
    [`${resolved.prefix}_COMMAND`]: command,
    [`${resolved.prefix}_ARGS`]: JSON.stringify(args),
  };
  const normalized = agent.toLowerCase();
  if (packageEntry && ["codex", "openai", "openai-codex"].includes(normalized)) {
    const native = findCapsuleFile(packageEntry, (candidate) => path.basename(candidate.path) === "codex"
      && path.basename(path.dirname(candidate.path)) === "bin"
      && candidate.path.includes(`${path.sep}@openai${path.sep}codex-`));
    if (!native) {
      throw launchError("copied Codex ACP package does not contain its native Codex executable", "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
    }
    if (await providerArtifactKind(native.path) !== "native") {
      throw launchError("copied Codex executable is not a native binary", "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
    }
    env.CPB_CAPSULE_CODEX_PATH = native.path;
  }
  if (packageEntry && (normalized === "claude" || normalized.startsWith("claude-")
    || ["anthropic", "bedrock", "aws-bedrock", "glm", "glm-compatible", "zhipu", "mimo", "mimo-v2.5pro", "xiaomi"].includes(normalized))) {
    const native = findCapsuleFile(packageEntry, (candidate) => path.basename(candidate.path) === "claude"
      && candidate.path.includes(`${path.sep}@anthropic-ai${path.sep}claude-agent-sdk-`));
    if (!native) {
      throw launchError("copied Claude ACP package does not contain its native Claude executable", "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
    }
    if (await providerArtifactKind(native.path) !== "native") {
      throw launchError("copied Claude executable is not a native binary", "PHASE_RUNNER_PROVIDER_COMMAND_UNSAFE");
    }
    env.CPB_CAPSULE_CLAUDE_CODE_EXECUTABLE = native.path;
  }
  await setCapsuleDirectoryMode(providerDirectory, 0o500);
  return { env };
}

async function bindExecutableIntoCapsule(
  sourcePath: string,
  destinationPath: string,
  destinationParent: CapsuleDirectoryEntry,
  budget: CapsuleBudget,
): Promise<CapsuleFileEntry> {
  const executable = await copyStableSourceFile(
    sourcePath,
    destinationPath,
    destinationParent,
    [],
    "Node executable",
    budget,
    2,
  );
  if ((executable.generation.mode & 0o111) === 0) {
    throw launchError(`capsule Node executable has no execute bit: ${destinationPath}`);
  }
  const sourceInfo = await lstat(sourcePath);
  if (sourceInfo.dev === executable.generation.dev && sourceInfo.ino === executable.generation.ino) {
    throw launchError(`capsule Node executable must use a distinct inode: ${destinationPath}`);
  }
  return executable;
}

async function assertCapsuleFileDigest(entry: CapsuleFileEntry, deadlineMs: number) {
  let handle: FileHandle | null = null;
  let primaryError: unknown = null;
  try {
    handle = await open(entry.path, strictAuthorityFlags("file"));
    const opened = await handle.stat();
    if (!sameLaunchGeneration(entry.generation, generationOf(opened))) {
      throw launchError(`launch capsule file changed generation: ${entry.path}`, "PHASE_RUNNER_CAPSULE_CHANGED");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CAPSULE_COPY_BUFFER_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      if (Date.now() > deadlineMs) {
        throw launchError("phase launch capsule verification timed out", "PHASE_RUNNER_CAPSULE_LIMIT");
      }
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (bytesRead <= 0) {
        throw launchError(`launch capsule digest ended early: ${entry.path}`, "PHASE_RUNNER_CAPSULE_CHANGED");
      }
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (digest.digest("hex") !== entry.digest) {
      throw launchError(`launch capsule file digest changed: ${entry.path}`, "PHASE_RUNNER_CAPSULE_CHANGED");
    }
    const current = await lstat(entry.path);
    assertCapsuleKind(current, "file", entry.path);
    if (!sameLaunchGeneration(entry.generation, generationOf(current))) {
      throw launchError(`launch capsule file changed during digest verification: ${entry.path}`, "PHASE_RUNNER_CAPSULE_CHANGED");
    }
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError && closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      `launch capsule digest verification and close failed: ${entry.path}`,
      { cause: primaryError },
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
}

async function assertCapsuleTree(
  entry: CapsuleEntry,
  verifyDigests = true,
  deadlineMs = Date.now() + CAPSULE_VERIFY_TIMEOUT_MS,
): Promise<void> {
  if (Date.now() > deadlineMs) {
    throw launchError("phase launch capsule verification timed out", "PHASE_RUNNER_CAPSULE_LIMIT");
  }
  await assertCapsuleEntryGeneration(entry);
  if (entry.kind === "file" && verifyDigests) await assertCapsuleFileDigest(entry, deadlineMs);
  if (entry.kind === "directory") {
    for (const child of entry.children) await assertCapsuleTree(child, verifyDigests, deadlineMs);
  }
}

function manifestEntries(root: CapsuleDirectoryEntry, excluded: Set<string>) {
  const result: Array<{ kind: LaunchAuthorityKind; path: string; generation: LaunchGeneration; digest?: string }> = [];
  const visit = (entry: CapsuleEntry) => {
    if (entry !== root && !excluded.has(entry.path)) {
      const relative = path.relative(root.path, entry.path);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw launchError(`launch capsule manifest entry escapes root: ${entry.path}`);
      }
      result.push({
        kind: entry.kind,
        path: relative.split(path.sep).join("/"),
        generation: entry.generation,
        ...(entry.kind === "file" ? { digest: entry.digest } : {}),
      });
    }
    if (entry.kind === "directory") {
      for (const child of entry.children) visit(child);
    }
  };
  visit(root);
  return result;
}

async function cleanupCapsuleDirectory(entry: CapsuleDirectoryEntry, errors: unknown[]) {
  try {
    await setCapsuleDirectoryMode(entry, 0o700);
  } catch (error) {
    errors.push(error);
    return;
  }

  for (const child of [...entry.children].reverse()) {
    if (child.kind === "directory") {
      await cleanupCapsuleDirectory(child, errors);
      try {
        await refreshCapsuleDirectoryGeneration(entry);
      } catch (error) {
        errors.push(error);
        return;
      }
      continue;
    }
    try {
      await assertCapsuleEntryGeneration(child);
      await unlink(child.path);
      await refreshCapsuleDirectoryGeneration(entry);
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    await assertCapsuleEntryGeneration(entry);
    await rmdir(entry.path);
  } catch (error) {
    errors.push(error);
  }
}

async function cleanupLaunchCapsule(root: CapsuleDirectoryEntry) {
  const errors: unknown[] = [];
  await cleanupCapsuleDirectory(root, errors);
  return errors;
}

async function createLaunchCapsule(
  canonicalExecutorRoot: string,
  canonicalExecutable: string,
  sourceJobRunner: string,
  sourceBridgeScript: string,
  selectedAgent: string | null,
  inputEnv: NodeJS.ProcessEnv,
): Promise<LaunchCapsule> {
  const buildStartedAt = Date.now();
  let root: CapsuleDirectoryEntry | null = null;
  let primaryError: unknown = null;
  let temporaryRootAuthority: LaunchAuthority | null = null;
  try {
    const budget = createCapsuleBudget();
    const canonicalTemporaryRoot = await realpath(tmpdir());
    temporaryRootAuthority = await openLaunchIdentityAuthority(canonicalTemporaryRoot, "temporary root", "directory");
    const rootPath = await mkdtemp(path.join(canonicalTemporaryRoot, "cpb-phase-launch-"));
    const rootInfo = await lstat(rootPath);
    assertCapsuleKind(rootInfo, "directory", rootPath);
    root = {
      kind: "directory",
      path: rootPath,
      generation: generationOf(rootInfo),
      parent: null,
      children: [],
    };
    chargeCapsuleBudget(budget, { depth: 0, label: rootPath });
    await capsuleFault("after-root-registered", { path: rootPath, root: rootPath });
    await setCapsuleDirectoryMode(root, 0o700);
    await assertLaunchAuthorityIdentity(temporaryRootAuthority);

    const binDirectory = await createCapsuleDirectory(path.join(rootPath, "bin"), root, budget, 1);
    const capsuleExecutable = path.join(binDirectory.path, process.platform === "win32" ? "node.exe" : "node");
    await bindExecutableIntoCapsule(canonicalExecutable, capsuleExecutable, binDirectory, budget);
    await setCapsuleDirectoryMode(binDirectory, 0o500);

    const capsuleExecutor = await createCapsuleDirectory(path.join(rootPath, "executor"), root, budget, 1);
    const sourceSnapshot: SourceSnapshotEntry[] = [];
    const executorAuthorities: LaunchAuthority[] = [];
    let executorCopyError: unknown = null;
    try {
      executorAuthorities.push(await openLaunchIdentityAuthority(
        path.dirname(canonicalExecutorRoot),
        "executor root parent",
        "directory",
      ));
      executorAuthorities.push(await openLaunchAuthority(canonicalExecutorRoot, "executor root", "directory"));
      const executorParentAuthority = executorAuthorities[0];
      const executorAuthority = executorAuthorities[1];
      for (const entryName of EXECUTOR_CAPSULE_ENTRIES) {
        const sourcePath = path.join(canonicalExecutorRoot, entryName);
        let info;
        try {
          info = await lstat(sourcePath);
        } catch (error) {
          if (isMissingPathError(error)) continue;
          throw error;
        }
        const destinationPath = path.join(capsuleExecutor.path, entryName);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          await copyStableSourceDirectory(
            sourcePath,
            destinationPath,
            capsuleExecutor,
            sourceSnapshot,
            `executor/${entryName}`,
            budget,
            2,
          );
        } else if (info.isFile() && !info.isSymbolicLink()) {
          await copyStableSourceFile(
            sourcePath,
            destinationPath,
            capsuleExecutor,
            sourceSnapshot,
            `executor/${entryName}`,
            budget,
            2,
          );
        } else {
          throw launchError(`executor launch closure contains a symlink or special entry: ${sourcePath}`);
        }
      }
      await assertLaunchAuthorityIdentity(executorParentAuthority);
      await assertLaunchAuthority(executorAuthority);
      sourceSnapshot.push({
        kind: "directory",
        path: canonicalExecutorRoot,
        generation: executorAuthority.generation,
      });
      await assertSourceSnapshot(sourceSnapshot, budget);
    } catch (error) {
      executorCopyError = error;
    }
    const executorCloseErrors: unknown[] = [];
    for (const authority of [...executorAuthorities].reverse()) {
      try {
        await authority.handle.close();
      } catch (error) {
        executorCloseErrors.push(error);
      }
    }
    if (executorCopyError && executorCloseErrors.length > 0) {
      throw new AggregateError(
        [executorCopyError, ...executorCloseErrors],
        "executor launch capsule copy and authority close failed",
        { cause: executorCopyError },
      );
    }
    if (executorCopyError) throw executorCopyError;
    if (executorCloseErrors.length === 1) throw executorCloseErrors[0];
    if (executorCloseErrors.length > 1) {
      throw new AggregateError(
        executorCloseErrors,
        "executor launch capsule authority closes failed",
        { cause: executorCloseErrors[0] },
      );
    }

    await setCapsuleDirectoryMode(capsuleExecutor, 0o500);

    const jobRunnerRelative = path.relative(canonicalExecutorRoot, sourceJobRunner);
    const bridgeRelative = path.relative(canonicalExecutorRoot, sourceBridgeScript);
    const capsuleJobRunner = path.join(capsuleExecutor.path, jobRunnerRelative);
    const capsuleBridgeScript = path.join(capsuleExecutor.path, bridgeRelative);
    const capsuleAcpClient = path.join(capsuleExecutor.path, ACP_CLIENT_RELATIVE_PATH);
    const [jobRunnerInfo, bridgeInfo, acpClientInfo] = await Promise.all([
      lstat(capsuleJobRunner),
      lstat(capsuleBridgeScript),
      lstat(capsuleAcpClient),
    ]);
    assertCapsuleKind(jobRunnerInfo, "file", capsuleJobRunner);
    assertCapsuleKind(bridgeInfo, "file", capsuleBridgeScript);
    assertCapsuleKind(acpClientInfo, "file", capsuleAcpClient);

    const provider = await bindProviderIntoCapsule(
      selectedAgent,
      canonicalExecutable,
      capsuleExecutable,
      inputEnv,
      root,
      budget,
    );
    const manifestPath = path.join(root.path, CAPSULE_MANIFEST_FILE);
    const manifestContent = `${JSON.stringify({
      schema: "cpb.phase-launch-manifest.v1",
      entries: manifestEntries(root, new Set([manifestPath])),
    })}\n`;
    const manifest = await writeCapsuleFile(
      manifestPath,
      root,
      manifestContent,
      budget,
      1,
      "launch manifest",
    );
    await setCapsuleDirectoryMode(root, 0o500);
    await assertCapsuleTree(root, true, budget.deadlineMs);
    await assertLaunchAuthorityIdentity(temporaryRootAuthority);
    await temporaryRootAuthority.handle.close();
    temporaryRootAuthority = null;

    return {
      root,
      executorRoot: capsuleExecutor.path,
      executable: capsuleExecutable,
      jobRunner: capsuleJobRunner,
      bridgeScript: capsuleBridgeScript,
      acpClient: capsuleAcpClient,
      providerEnv: {
        ...provider.env,
        CPB_ACP_CLIENT: capsuleAcpClient,
      },
      manifest,
      buildDurationMs: Date.now() - buildStartedAt,
    };
  } catch (error) {
    primaryError = error;
  }

  const closeErrors: unknown[] = [];
  if (temporaryRootAuthority) {
    try {
      await temporaryRootAuthority.handle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  const cleanupErrors = root ? await cleanupLaunchCapsule(root) : [];
  if (closeErrors.length > 0 || cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...closeErrors, ...cleanupErrors].filter((error) => error !== null && error !== undefined),
      "phase runner launch capsule creation and cleanup failed",
      primaryError === null ? undefined : { cause: primaryError },
    );
  }
  throw primaryError;
}

function requirePathWithin(root: string, candidate: string, label: string) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw launchError(`${label} escapes canonical executor root: ${candidate}`);
  }
  return candidate;
}

function selectedAgentForPhase(phase: string, scriptPath: string, env: NodeJS.ProcessEnv) {
  const override = String(env.CPB_OVERRIDE_AGENT || "").trim().toLowerCase();
  const variant = String(
    env.CPB_CLAUDE_VARIANT
      || env.CPB_BUILDER_VARIANT
      || env.CPB_ACP_CLAUDE_VARIANT
      || "",
  ).trim().toLowerCase();
  const scopedClaudeAgent = (agent: string) => {
    if (agent !== "claude") return agent;
    if (["glm", "glm-compatible", "zhipu"].includes(variant)) return "claude-glm";
    if (["mimo", "mimo-v2.5pro", "xiaomi"].includes(variant)) return "claude-mimo";
    return agent;
  };
  if (override) return scopedClaudeAgent(override);
  const bridgeRole = roleForBridge(scriptPath);
  if (bridgeRole === "executor" || bridgeRole === "repairer") return scopedClaudeAgent("claude");
  if (bridgeRole) return "codex";
  const normalized = phase.toLowerCase();
  if (normalized.startsWith("execute") || normalized.startsWith("repair") || normalized.startsWith("review-fix")) {
    return scopedClaudeAgent("claude");
  }
  if (normalized.startsWith("plan") || normalized.startsWith("review") || normalized.startsWith("verify")) {
    return "codex";
  }
  return null;
}

function trustedExecutablePathEnv(canonicalExecutable: string) {
  const trusted = [path.dirname(canonicalExecutable)];
  if (process.platform !== "win32") trusted.push("/usr/bin", "/bin");
  return [...new Set(trusted)].join(path.delimiter);
}

function minimalRunnerEnv(
  input: NodeJS.ProcessEnv,
  capsuleExecutable: string,
  capsuleExecutorRoot: string,
  selectedAgent: string | null,
  providerEnv: NodeJS.ProcessEnv,
) {
  const sanitized = { ...input };
  for (const key of Object.keys(sanitized)) {
    if (/^CPB_ACP_[A-Z0-9_]+_(?:COMMAND|ARGS)$/.test(key)
      || [
        "CPB_ACP_CLIENT",
        "CPB_AGENT_SANDBOX_COMMAND",
        "CPB_AGENT_SANDBOX_ARGS",
        "CPB_CLAUDE_CLI_COMMAND",
        "CODEX_PATH",
        "CLAUDE_CODE_EXECUTABLE",
        "CPB_CAPSULE_CODEX_PATH",
        "CPB_CAPSULE_CLAUDE_CODE_EXECUTABLE",
      ].includes(key)) {
      delete sanitized[key];
    }
  }
  const extra: NodeJS.ProcessEnv = {
    CPB_EXECUTOR_ROOT: capsuleExecutorRoot,
    ...providerEnv,
  };
  for (const key of ["CPB_PROJECT_RUNTIME_ROOT", "CPB_HUB_STATE_REDIS_CONFIG_FILE"]) {
    if (input[key] !== undefined) extra[key] = input[key];
  }
  const options: LooseRecord = {
    includeProviderCredentials: false,
    allowKeys: [
      "CPB_HUB_STATE_REDIS_CONFIG_FILE",
      "CPB_CAPSULE_CODEX_PATH",
      "CPB_CAPSULE_CLAUDE_CODE_EXECUTABLE",
    ],
  };
  const result = buildChildEnv(sanitized, extra, options);
  result.PATH = trustedExecutablePathEnv(capsuleExecutable);
  const credentials: NodeJS.ProcessEnv = {};
  if (selectedAgent) {
    for (const key of providerCredentialKeysForAgent(selectedAgent)) {
      if (input[key] !== undefined) credentials[key] = input[key];
    }
  }
  return { initialEnv: result, credentials };
}

export function roleForBridge(scriptPath: string) {
  const base = path.basename(scriptPath);
  if (base === "planner.sh") return "planner";
  if (base === "executor.sh") return "executor";
  if (base === "repairer.sh") return "repairer";
  if (base === "verifier.sh") return "verifier";
  if (base === "reviewer.sh") return "reviewer";
  return null;
}

export function phaseRole(phase: string) {
  switch (phase) {
    case "plan": return "planner";
    case "execute": return "executor";
    case "verify": return "verifier";
    case "review": return "reviewer";
    case "repair": return "repairer";
    default: return null;
  }
}

export async function validatePhaseInputs(cpbRoot: string, project: string, jobId: string, phase: string) {
  const errors = [];

  if (!project || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(project)) {
    errors.push(`invalid project name: ${project}`);
  }

  if (!jobId || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(jobId)) {
    errors.push(`invalid job ID: ${jobId}`);
  }

  if (!phase || typeof phase !== "string") {
    errors.push(`invalid phase: ${phase}`);
  }

  if (errors.length > 0) return { valid: false, errors };

  const exists = await projectExists(cpbRoot, project);
  if (!exists) {
    errors.push(`project not found: ${project}`);
  }

  let dataRoot = null;
  try {
    dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot: process.env.CPB_HUB_ROOT });
  } catch (err) {
    errors.push(err?.message || `project runtime root required for project: ${project}`);
  }

  const job = dataRoot ? await getJob(cpbRoot, project, jobId, { dataRoot }) : null;
  if (!job?.jobId) {
    errors.push(`job not found: ${jobId}`);
  }

  return { valid: errors.length === 0, errors };
}

export async function checkPhasePermissions(cpbRoot: string, project: string, jobId: string, phase: string, targetPath: string, action: string) {
  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot: process.env.CPB_HUB_ROOT });
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  const workflow = getWorkflow(job?.workflow || "standard");
  const role = workflowRoleForPhase(workflow, phase) || phaseRole(phase);
  if (!role) return { allowed: true };

  const sourcePath = job?.worktree || process.env.CPB_PROJECT_PATH_OVERRIDE || null;

  return checkPermission(role, action, targetPath, cpbRoot, project, { sourcePath, jobId, dataRoot });
}

async function fileExists(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function requireParentPlanDataRoot(dataRoot?: string | null) {
  if (!dataRoot) {
    throw new Error("project runtime root required for parent plan cache");
  }
  return path.resolve(dataRoot);
}

function invalidParentPlanRecord(message: string): never {
  throw new TypeError(`invalid parent plan cache record: ${message}`);
}

function requireRecordString(record: LooseRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    invalidParentPlanRecord(`${field} must be a non-empty string`);
  }
  return value;
}

function requireSafeCacheIdentifier(value: string, field: string): string {
  if (value.length > 128 || !SAFE_CACHE_IDENTIFIER.test(value)) {
    invalidParentPlanRecord(`${field} must be a safe identifier`);
  }
  return value;
}

export function validateParentPlanRecord(
  value: unknown,
  { project, planCacheKey }: { project?: string; planCacheKey?: string } = {},
): LooseRecord {
  if (!isRecord(value)) invalidParentPlanRecord("value must be an object");
  const record = value as LooseRecord;

  if (record.schemaVersion !== 1) invalidParentPlanRecord("schemaVersion must equal 1");
  if (record.source !== "parent_plan_cache") invalidParentPlanRecord("source must equal parent_plan_cache");

  const recordProject = requireRecordString(record, "project");
  const recordCacheKey = requireSafeCacheIdentifier(requireRecordString(record, "planCacheKey"), "planCacheKey");
  requireRecordString(record, "planGroupId");
  const parentPlanId = requireSafeCacheIdentifier(requireRecordString(record, "parentPlanId"), "parentPlanId");
  const planId = requireSafeCacheIdentifier(requireRecordString(record, "planId"), "planId");
  const planArtifact = requireRecordString(record, "planArtifact");
  if (planArtifact !== `plan-${planId}` && planArtifact !== `plan-${parentPlanId}`) {
    invalidParentPlanRecord("planArtifact must identify the cached planId");
  }
  requireRecordString(record, "planArtifactPath");

  if (project !== undefined && recordProject !== project) {
    invalidParentPlanRecord(`project does not match requested project ${project}`);
  }
  if (planCacheKey !== undefined && recordCacheKey !== planCacheKey) {
    invalidParentPlanRecord("planCacheKey does not match the requested cache key");
  }
  if (!Array.isArray(record.mergedPlanIds) || record.mergedPlanIds.some((id) => {
    return typeof id !== "string" || id.length > 128 || !SAFE_CACHE_IDENTIFIER.test(id);
  })) {
    invalidParentPlanRecord("mergedPlanIds must be an array of safe identifiers");
  }
  if (!isRecord(record.payload)) invalidParentPlanRecord("payload must be an object");

  const updatedAt = requireRecordString(record, "updatedAt");
  if (Number.isNaN(Date.parse(updatedAt))) invalidParentPlanRecord("updatedAt must be a valid timestamp");
  if (record.task !== undefined && typeof record.task !== "string") {
    invalidParentPlanRecord("task must be a string when present");
  }

  return record;
}

export function parentPlanStoreDir(_cpbRoot: string, project: string, { dataRoot }: { dataRoot?: string | null } = {}) {
  const safeProject = requireSafeCacheIdentifier(project, "project");
  return path.join(requireParentPlanDataRoot(dataRoot), "plan-cache", safeProject);
}

export function parentPlanRecordPath(cpbRoot: string, project: string, planCacheKey: string, opts: { dataRoot?: string | null } = {}) {
  const safeCacheKey = requireSafeCacheIdentifier(planCacheKey, "planCacheKey");
  return path.join(parentPlanStoreDir(cpbRoot, project, opts), `${safeCacheKey}.json`);
}

async function writeAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

export async function readParentPlanRecord(cpbRoot: string, project: string, planCacheKey?: string | null, opts: { dataRoot?: string | null } = {}) {
  if (!planCacheKey) return null;
  const file = parentPlanRecordPath(cpbRoot, project, planCacheKey, opts);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return validateParentPlanRecord(parsed, { project, planCacheKey });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeParentPlanRecord(cpbRoot: string, project: string, planCacheKey: string, record: LooseRecord, opts: { dataRoot?: string | null } = {}) {
  if (!planCacheKey) throw new Error("planCacheKey is required");
  const file = parentPlanRecordPath(cpbRoot, project, planCacheKey, opts);
  const validated = validateParentPlanRecord(record, { project, planCacheKey });
  await writeAtomic(file, `${JSON.stringify(validated, null, 2)}\n`);
  return { ...validated, cachePath: file };
}

function normalizeWords(text: string = "") {
  return text.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
}

function wordOverlap(a: string, b: string) {
  const sa = new Set(normalizeWords(a));
  const sb = new Set(normalizeWords(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const word of sa) if (sb.has(word)) common++;
  return common / Math.min(sa.size, sb.size);
}

async function planFileExists(cpbRoot: string, project: string, planId: string, { dataRoot }: LooseRecord = {}) {
  try {
    if (!dataRoot) throw new Error("project runtime root required for parent plan artifact lookup");
    await access(path.join(path.resolve(dataRoot), "wiki", "inbox", `plan-${planId}.md`));
    return true;
  } catch {
    return false;
  }
}

function stableParentPlanPayload({ project, task, sourceContext = {} }: LooseRecord = {}): LooseRecord {
  const context = recordValue(sourceContext);
  const planGroupId = context.planGroupId || null;
  if (planGroupId) {
    return {
      project,
      planGroupId,
      source: {
        repo: context.repo || null,
        issueNumber: context.issueNumber ?? null,
      },
    };
  }
  return {
    project,
    task: String(task || "").trim().replace(/\s+/g, " "),
    source: {
      repo: context.repo || null,
      issueNumber: context.issueNumber ?? null,
      issueUrl: context.issueUrl || null,
      sourceFingerprint: context.sourceFingerprint || null,
      specHash: context.specHash || null,
      designHash: context.designHash || null,
      tasksHash: context.tasksHash || null,
      taskId: context.taskId || null,
      parentPlanId: context.parentPlanId || null,
    },
  };
}

function explicitParentPlanId(sourceContext: LooseRecord = {}) {
  const value = recordValue(sourceContext).parentPlanId || null;
  return value ? String(value).replace(/^plan-/, "") : null;
}

function hashPayload(payload: LooseRecord) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function planArtifactPath(_cpbRoot: string, _project: string, planArtifact: string, { dataRoot }: LooseRecord = {}) {
  if (!dataRoot) throw new Error("project runtime root required for parent plan artifact path");
  const artifact = String(planArtifact || "").replace(/^plan-/, "");
  return path.join(path.resolve(dataRoot), "wiki", "inbox", `plan-${artifact}.md`);
}

async function artifactExists(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export function parentPlanCacheIdentity({ project, task, sourceContext = {} }: LooseRecord = {}) {
  const payload = stableParentPlanPayload({ project, task, sourceContext });
  const digest = hashPayload(payload);
  return {
    planGroupId: `plan-group-${digest.slice(0, 12)}`,
    planCacheKey: digest.slice(0, 16),
    payload,
  };
}

async function resolvePlanCacheDataRoot(cpbRoot: string, project: string, { dataRoot, hubRoot }: LooseRecord = {}) {
  return await resolveProjectDataRoot(cpbRoot, project, { dataRoot, hubRoot });
}

export async function resolveParentPlanCache(cpbRoot: string, { project, task, sourceContext = {}, dataRoot, hubRoot }: LooseRecord = {}) {
  if (!project) throw new Error("project is required");
  const projectId = stringValue(project);
  const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, projectId, { dataRoot, hubRoot });
  const sourceContextRecord = recordValue(sourceContext);
  const identity = parentPlanCacheIdentity({ project, task, sourceContext: sourceContextRecord });
  const file = parentPlanRecordPath(cpbRoot, projectId, identity.planCacheKey, { dataRoot: resolvedDataRoot });
  const cached = recordValue(await readParentPlanRecord(cpbRoot, projectId, identity.planCacheKey, { dataRoot: resolvedDataRoot }));

  const explicitPlanId = explicitParentPlanId(sourceContextRecord);
  const planId = cached?.parentPlanId || cached?.planId || explicitPlanId || null;
  const planArtifact = cached?.planArtifact || (planId ? `plan-${planId}` : null);
  const artifactPath = planArtifact ? planArtifactPath(cpbRoot, projectId, String(planArtifact), { dataRoot: resolvedDataRoot }) : null;
  const cacheHit = Boolean(planId && artifactPath && await artifactExists(artifactPath));

  return {
    schemaVersion: 1,
    source: "parent_plan_cache",
    project: projectId,
    dataRoot: resolvedDataRoot,
    task,
    ...identity,
    cachePath: file,
    cacheHit,
    parentPlanId: cacheHit ? planId : null,
    reusedPlanId: cacheHit ? planId : null,
    reusedPlanArtifact: cacheHit ? planArtifact : null,
    mergedPlanIds: cacheHit ? [...new Set([String(planId), ...stringArray(cached.mergedPlanIds)])] : [],
    stale: Boolean(cached && !cacheHit),
    cachedAt: cached?.updatedAt || null,
  };
}

export async function writeParentPlanCache(cpbRoot: string, {
  project,
  task,
  sourceContext = {},
  dataRoot,
  hubRoot,
  planGroupId = null,
  planCacheKey = null,
  planId,
  planArtifact = null,
  mergedPlanIds = [],
}: LooseRecord = {}) {
  if (!project) throw new Error("project is required");
  if (!planId) throw new Error("planId is required");
  const projectId = stringValue(project);
  const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, projectId, { dataRoot, hubRoot });
  const identity = planCacheKey && planGroupId
    ? { planGroupId, planCacheKey, payload: stableParentPlanPayload({ project, task, sourceContext }) }
    : parentPlanCacheIdentity({ project, task, sourceContext });
  const artifact = planArtifact || `plan-${planId}`;
  const record = {
    schemaVersion: 1,
    source: "parent_plan_cache",
    project: projectId,
    task,
    planGroupId: identity.planGroupId,
    planCacheKey: identity.planCacheKey,
    parentPlanId: String(planId),
    planId: String(planId),
    planArtifact: artifact,
    planArtifactPath: planArtifactPath(cpbRoot, projectId, String(artifact), { dataRoot: resolvedDataRoot }),
    mergedPlanIds: [...new Set([String(planId), ...stringArray(mergedPlanIds)])],
    payload: identity.payload,
    updatedAt: new Date().toISOString(),
  };
  const stored = await writeParentPlanRecord(cpbRoot, projectId, String(identity.planCacheKey), record, { dataRoot: resolvedDataRoot });
  return {
    ...stored,
    dataRoot: resolvedDataRoot,
    cacheHit: true,
    planCacheKey: record.planCacheKey,
    parentPlanId: record.parentPlanId,
    reusedPlanId: record.planId,
    reusedPlanArtifact: record.planArtifact,
  };
}

function parentPlanHitResult(identity: LooseRecord, { source, planId, artifact, parentJobId = null, cachedAt = null }: LooseRecord) {
  const payload = recordValue(identity.payload);
  return {
    schemaVersion: 2,
    cacheHit: true,
    source,
    project: payload.project,
    task: payload.task,
    ...identity,
    parentPlanId: planId,
    reusedPlanId: planId,
    reusedPlanArtifact: artifact,
    mergedPlanIds: [planId],
    parentJobId,
    stale: false,
    cachedAt,
  };
}

function parentPlanMissResult(identity: LooseRecord, stale = false, cachedAt: string | null = null): LooseRecord {
  const payload = recordValue(identity.payload);
  return {
    schemaVersion: 2,
    cacheHit: false,
    source: null,
    project: payload.project,
    task: payload.task,
    ...identity,
    parentPlanId: null,
    reusedPlanId: null,
    reusedPlanArtifact: null,
    mergedPlanIds: [],
    parentJobId: null,
    stale,
    cachedAt,
  };
}

async function findParentPlanJobIndexHit(cpbRoot: string, project: string, { sourceContext, task, dataRoot }: LooseRecord = {}) {
  const allJobs = await listJobsFromIndex(cpbRoot, { dataRoot });
  const cutoff = Date.now() - PARENT_PLAN_MAX_AGE_MS;
  const context = recordValue(sourceContext);
  const jobs = Array.isArray(allJobs) ? allJobs.map(recordValue) : [];
  const candidates = jobs
    .filter((job) => job.project === project)
    .filter((job) => stringArray(job.completedPhases).includes("plan"))
    .filter((job) => recordValue(job.artifacts).plan)
    .filter((job) => job.status !== "cancelled")
    .filter((job) => {
      const updatedAt = new Date(job.updatedAt || job.createdAt).getTime();
      return !Number.isNaN(updatedAt) && updatedAt >= cutoff;
    })
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

  if (candidates.length === 0) return null;

  const issueNumber = context.issueNumber;
  if (issueNumber) {
    for (const job of candidates) {
      const jobIssue = recordValue(job.sourceContext).issueNumber;
      if (jobIssue && String(jobIssue) === String(issueNumber)) {
        const planId = String(recordValue(job.artifacts).plan).replace(/^plan-/, "");
        if (await planFileExists(cpbRoot, project, planId, { dataRoot })) {
          return { planId, parentJobId: job.jobId, source: "same_issue" };
        }
      }
    }
  }

  for (const job of candidates) {
    const overlap = wordOverlap(String(task || ""), String(job.task || ""));
    if (overlap >= 0.5) {
      const planId = String(recordValue(job.artifacts).plan).replace(/^plan-/, "");
      if (await planFileExists(cpbRoot, project, planId, { dataRoot })) {
        return { planId, parentJobId: job.jobId, source: "task_overlap" };
      }
    }
  }

  return null;
}

export async function resolveParentPlan(cpbRoot: string, { project, task, sourceContext = {}, dataRoot, hubRoot }: LooseRecord = {}) {
  if (!project) throw new Error("project is required");
  const projectId = stringValue(project);
  const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, projectId, { dataRoot, hubRoot });
  const sourceContextRecord = recordValue(sourceContext);
  const identity = parentPlanCacheIdentity({ project, task, sourceContext: sourceContextRecord });

  const explicitPlanId = explicitParentPlanId(sourceContextRecord);
  if (explicitPlanId) {
    const artifact = `plan-${explicitPlanId}`;
    if (await planFileExists(cpbRoot, projectId, explicitPlanId, { dataRoot: resolvedDataRoot })) {
      return parentPlanHitResult(identity, { source: "explicit", planId: explicitPlanId, artifact });
    }
  }

  const cached = recordValue(await readParentPlanRecord(cpbRoot, projectId, identity.planCacheKey, { dataRoot: resolvedDataRoot }));
  const cachedPlanId = cached?.parentPlanId || cached?.planId || null;
  if (cachedPlanId) {
    const artifact = cached?.planArtifact || `plan-${cachedPlanId}`;
    if (await planFileExists(cpbRoot, projectId, String(cachedPlanId), { dataRoot: resolvedDataRoot })) {
      return parentPlanHitResult(identity, {
        source: "cache",
        planId: String(cachedPlanId),
        artifact: String(artifact),
        cachedAt: cached?.updatedAt ? String(cached.updatedAt) : null,
      });
    }
  }

  const indexHit = await findParentPlanJobIndexHit(cpbRoot, projectId, { sourceContext, task, dataRoot: resolvedDataRoot });
  if (indexHit) {
    const artifact = `plan-${indexHit.planId}`;
    return parentPlanHitResult(identity, {
      source: indexHit.source,
      planId: indexHit.planId,
      artifact,
      parentJobId: indexHit.parentJobId,
    });
  }

  return parentPlanMissResult(identity, Boolean(cached), cached?.updatedAt ? String(cached.updatedAt) : null);
}

function runChild(command: string, args: string[], cwd: string, options: RunChildOptions = {}): Promise<RunChildResult> {
  return new Promise((resolve) => {
    let settled = false;
    let spawnCheck: Promise<Error | null> | null = null;
    const stdout = new BoundedOutput(subprocessOutputMaxBytes(process.env.CPB_SUBPROCESS_OUTPUT_MAX_BYTES));

    function finish(result: RunChildResult) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    let child;
    try {
      const spawnChild = launchTestHooks.getStore()?.spawnChild || spawn;
      child = spawnChild(command, args, {
        cwd,
        env: options.env || process.env,
        stdio: options.capsulePipes
          ? ["ignore", "pipe", "pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, stdout: "", error: err });
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout.append(chunk);
      if (options.onOutput) options.onOutput(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.once("spawn", () => {
      spawnCheck = Promise.resolve(options.afterSpawn?.(child)).then(
        () => null,
        (error) => {
          try {
            child.kill("SIGKILL");
          } catch {}
          return error instanceof Error ? error : new Error(String(error));
        },
      );
    });
    child.on("error", (err) => {
      const pending = spawnCheck || Promise.resolve(null);
      void pending.then((authorityError) => {
        finish(authorityError ? {
          exitCode: 1,
          stdout: stdout.toString(),
          outputTruncated: stdout.truncated,
          error: authorityError,
        } : { exitCode: 1, stdout: stdout.toString(), outputTruncated: stdout.truncated, error: err });
      });
    });
    child.on("close", (code) => {
      const pending = spawnCheck || Promise.resolve(null);
      void pending.then((authorityError) => {
        finish(authorityError ? {
          exitCode: 1,
          stdout: stdout.toString(),
          outputTruncated: stdout.truncated,
          error: authorityError,
        } : { exitCode: code ?? 1, stdout: stdout.toString(), outputTruncated: stdout.truncated });
      });
    });
  });
}

function waitForBootstrapReady(child: ReturnType<typeof spawn>, nonce: string) {
  return new Promise<void>((resolve, reject) => {
    const ready = child.stdio[3];
    if (!ready || typeof (ready as NodeJS.ReadableStream).on !== "function") {
      reject(launchError("phase launch bootstrap ready pipe is unavailable", "PHASE_RUNNER_BOOTSTRAP_FAILED"));
      return;
    }
    let settled = false;
    let body = "";
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = (code: number | null) => finish(launchError(
      `phase launch bootstrap exited before credential readiness (${code ?? "unknown"})`,
      "PHASE_RUNNER_BOOTSTRAP_FAILED",
    ));
    const timer = setTimeout(() => finish(launchError(
      "phase launch bootstrap readiness timed out",
      "PHASE_RUNNER_BOOTSTRAP_FAILED",
    )), CAPSULE_BOOTSTRAP_TIMEOUT_MS);
    timer.unref?.();
    child.once("close", onClose);
    (ready as NodeJS.ReadableStream).on("data", (chunk) => {
      body += String(chunk);
      if (Buffer.byteLength(body) > 256) {
        finish(launchError("phase launch bootstrap readiness exceeded bound", "PHASE_RUNNER_BOOTSTRAP_FAILED"));
      }
    });
    (ready as NodeJS.ReadableStream).once("error", (error) => finish(launchError(
      "phase launch bootstrap readiness pipe failed",
      "PHASE_RUNNER_BOOTSTRAP_FAILED",
      error,
    )));
    (ready as NodeJS.ReadableStream).once("end", () => {
      if (body !== `READY ${nonce}\n`) {
        finish(launchError("phase launch bootstrap readiness nonce/replay check failed", "PHASE_RUNNER_BOOTSTRAP_FAILED"));
        return;
      }
      finish();
    });
  });
}

async function deliverCapsuleCredentials(
  child: ReturnType<typeof spawn>,
  nonce: string,
  credentials: NodeJS.ProcessEnv,
  capsule: LaunchCapsule,
  authorities: LaunchAuthority[],
) {
  await waitForBootstrapReady(child, nonce);
  await assertCapsuleTree(capsule.root);
  await assertLaunchAuthorities(authorities);
  const env = Object.fromEntries(Object.entries(credentials).sort(([left], [right]) => left.localeCompare(right)));
  const frame = `${JSON.stringify({
    schema: "cpb.phase-launch-credentials.v1",
    nonce,
    env,
  })}\n`;
  if (Buffer.byteLength(frame) > CAPSULE_CREDENTIAL_MAX_BYTES) {
    throw launchError("phase launch credential frame exceeds bound", "PHASE_RUNNER_BOOTSTRAP_FAILED");
  }
  const credentialPipe = child.stdio[4];
  if (!credentialPipe || typeof (credentialPipe as NodeJS.WritableStream).write !== "function") {
    throw launchError("phase launch bootstrap credential pipe is unavailable", "PHASE_RUNNER_BOOTSTRAP_FAILED");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(launchError(
      "phase launch credential delivery timed out",
      "PHASE_RUNNER_BOOTSTRAP_FAILED",
    )), CAPSULE_BOOTSTRAP_TIMEOUT_MS);
    timer.unref?.();
    (credentialPipe as NodeJS.WritableStream).once("error", (error) => finish(launchError(
      "phase launch credential delivery failed",
      "PHASE_RUNNER_BOOTSTRAP_FAILED",
      error,
    )));
    (credentialPipe as NodeJS.WritableStream).end(frame, () => finish());
  });
}

async function preflightCapsuleNode(capsule: LaunchCapsule) {
  const nonce = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex");
  const source = [
    'import { realpathSync } from "node:fs";',
    'process.stdout.write(JSON.stringify({ nonce: process.argv[1], executable: realpathSync(process.execPath) }));',
  ].join("\n");
  const outcome = await new Promise<{ code: number; stdout: string; stderr: string; error?: Error }>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (value: { code: number; stdout: string; stderr: string; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(capsule.executable, ["--input-type=module", "--eval", source, nonce], {
        env: { PATH: trustedExecutablePathEnv(capsule.executable) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: 1, stdout, stderr, error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ code: 1, stdout, stderr, error: new Error("capsule Node preflight timed out") });
    }, 10_000);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 8192) stdout += String(chunk).slice(0, 8192 - stdout.length);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk).slice(0, 8192 - stderr.length);
    });
    child.once("error", (error) => finish({ code: 1, stdout, stderr, error }));
    child.once("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
  let parsed: LooseRecord = {};
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {}
  const expectedExecutable = await realpath(capsule.executable);
  if (outcome.code !== 0
    || outcome.error
    || parsed.nonce !== nonce
    || path.resolve(String(parsed.executable || "")) !== path.resolve(expectedExecutable)) {
    throw launchError(
      `copied Node executable failed launch/RPATH preflight${outcome.stderr ? `: ${outcome.stderr.trim()}` : ""}`,
      "PHASE_RUNNER_NODE_PREFLIGHT_FAILED",
      outcome.error,
    );
  }
  await assertCapsuleTree(capsule.root);
}

async function runTrustedJobRunner(
  executorRoot: string,
  runnerArgs: string[],
  cwd: string,
  inputEnv: NodeJS.ProcessEnv,
  phase: string,
  requestedBridgeScript: string,
): Promise<RunChildResult> {
  const authorities: LaunchAuthority[] = [];
  let capsule: LaunchCapsule | null = null;
  let result: RunChildResult | null = null;
  let primaryError: unknown = null;

  try {
    const canonicalExecutorRoot = await realpath(path.resolve(executorRoot));
    const bridgesDir = requirePathWithin(
      canonicalExecutorRoot,
      path.resolve(canonicalExecutorRoot, "bridges"),
      "phase runner bridges directory",
    );
    const jobRunner = requirePathWithin(
      canonicalExecutorRoot,
      path.resolve(bridgesDir, "job-runner.js"),
      "job-runner",
    );
    const bridgeCandidate = path.isAbsolute(requestedBridgeScript)
      ? path.resolve(requestedBridgeScript)
      : path.resolve(canonicalExecutorRoot, requestedBridgeScript);
    requirePathWithin(bridgesDir, bridgeCandidate, "phase bridge script");
    if (path.dirname(bridgeCandidate) !== bridgesDir) {
      throw launchError(`phase bridge script must be an immediate child of the trusted bridges directory: ${bridgeCandidate}`);
    }
    const canonicalBridgeScript = await realpath(bridgeCandidate);
    if (path.resolve(canonicalBridgeScript) !== bridgeCandidate) {
      throw launchError(`phase bridge script must use its canonical non-symlink path: ${bridgeCandidate}`);
    }
    requirePathWithin(bridgesDir, canonicalBridgeScript, "phase bridge script");
    const requestedExecutable = launchTestHooks.getStore()?.executablePath || process.execPath;
    const canonicalExecutable = await realpath(path.resolve(requestedExecutable));
    const selectedAgent = selectedAgentForPhase(phase, canonicalBridgeScript, inputEnv);

    // Build and seal every byte the child can import before provider credentials
    // are selected. Source-tree paths are deliberately not used after this point:
    // a rename/replacement at the launch boundary cannot alter the executable
    // image, job runner, bridge, or relative module closure that the child sees.
    capsule = await createLaunchCapsule(
      canonicalExecutorRoot,
      canonicalExecutable,
      jobRunner,
      canonicalBridgeScript,
      selectedAgent,
      inputEnv,
    );
    await preflightCapsuleNode(capsule);
    const capsuleBridgesDir = path.dirname(capsule.jobRunner);
    const capsuleExecutableParent = path.dirname(capsule.executable);
    authorities.push(await openLaunchAuthority(capsule.root.path, "launch capsule root", "directory"));
    authorities.push(await openLaunchAuthority(capsule.executorRoot, "executor root", "directory"));
    authorities.push(await openLaunchAuthority(capsuleBridgesDir, "job-runner parent", "directory"));
    authorities.push(await openLaunchAuthority(capsule.jobRunner, "job-runner", "file"));
    authorities.push(await openLaunchAuthority(path.dirname(capsule.bridgeScript), "phase bridge parent", "directory"));
    authorities.push(await openLaunchAuthority(capsule.bridgeScript, "phase bridge", "file"));
    authorities.push(await openLaunchAuthority(capsuleExecutableParent, "Node executable parent", "directory"));
    authorities.push(await openLaunchAuthority(capsule.executable, "Node executable", "file"));
    authorities.push(await openLaunchAuthority(capsule.manifest.path, "launch capsule manifest", "file"));

    const jobRunnerArgs = [...runnerArgs.slice(1)];
    const scriptIndex = jobRunnerArgs.indexOf("--script");
    if (scriptIndex < 0 || !jobRunnerArgs[scriptIndex + 1]) {
      throw launchError("job-runner arguments are missing the phase bridge script");
    }
    jobRunnerArgs[scriptIndex + 1] = capsule.bridgeScript;
    const { initialEnv, credentials } = minimalRunnerEnv(
      inputEnv,
      capsule.executable,
      capsule.executorRoot,
      selectedAgent,
      capsule.providerEnv,
    );
    for (const key of Object.keys(credentials)) {
      if (initialEnv[key] !== undefined) {
        throw launchError(`provider credential leaked into initial bootstrap environment: ${key}`, "PHASE_RUNNER_BOOTSTRAP_FAILED");
      }
    }
    const nonce = randomBytes(32).toString("hex");
    const bootstrapSpec = Buffer.from(JSON.stringify({
      schema: "cpb.phase-launch-bootstrap.v1",
      nonce,
      root: { path: capsule.root.path, generation: capsule.root.generation },
      manifest: {
        path: capsule.manifest.path,
        generation: capsule.manifest.generation,
        digest: capsule.manifest.digest,
      },
      jobRunner: capsule.jobRunner,
      jobRunnerArgs,
      credentialKeys: Object.keys(credentials).sort(),
      maxEntries: CAPSULE_MAX_ENTRIES,
      maxBytes: CAPSULE_MAX_BYTES,
      maxManifestBytes: 8 * 1024 * 1024,
      maxCredentialBytes: CAPSULE_CREDENTIAL_MAX_BYTES,
    }), "utf8").toString("base64url");
    const bootstrapArgs = ["--input-type=module", "--eval", PHASE_LAUNCH_BOOTSTRAP, bootstrapSpec];
    const context = {
      executable: capsule.executable,
      executorRoot: capsule.executorRoot,
      jobRunner: capsule.jobRunner,
      bridgeScript: capsule.bridgeScript,
      sourceExecutable: canonicalExecutable,
      sourceExecutorRoot: canonicalExecutorRoot,
      sourceJobRunner: jobRunner,
      sourceBridgeScript: canonicalBridgeScript,
      env: initialEnv,
      authorities,
      capsuleBuildDurationMs: capsule.buildDurationMs,
    };

    await launchTestHooks.getStore()?.beforeSpawn?.(context);
    await assertCapsuleTree(capsule.root);
    await assertLaunchAuthorities(authorities);
    result = await runChild(capsule.executable, bootstrapArgs, cwd, {
      env: initialEnv,
      capsulePipes: true,
      afterSpawn: async (child) => {
        await launchTestHooks.getStore()?.afterSpawn?.({ ...context, child });
        await deliverCapsuleCredentials(child, nonce, credentials, capsule as LaunchCapsule, authorities);
      },
    });
    if (result.error) primaryError = result.error;
  } catch (error) {
    primaryError = error;
  }

  const closeErrors = await closeLaunchAuthorities(authorities);
  const capsuleCleanupErrors = capsule ? await cleanupLaunchCapsule(capsule.root) : [];
  const lifecycleErrors = [primaryError, ...closeErrors, ...capsuleCleanupErrors]
    .filter((error) => error !== null && error !== undefined);
  if (lifecycleErrors.length > 0) {
    const error = lifecycleErrors.length === 1
      ? lifecycleErrors[0]
      : new AggregateError(
        lifecycleErrors,
        "phase runner launch, authority close, and capsule cleanup failed",
        { cause: lifecycleErrors[0] },
      );
    return {
      exitCode: 1,
      stdout: result?.stdout || "",
      outputTruncated: result?.outputTruncated,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  return result || { exitCode: 1, stdout: "", error: new Error("phase runner produced no result") };
}

export async function dispatchPhase(cpbRoot: string, { project, jobId, phase, script, scriptArgs, executorRoot, env }: LooseRecord = {}) {
  const projectId = stringValue(project);
  const job = stringValue(jobId);
  const phaseName = stringValue(phase);
  const scriptPath = stringValue(script);
  const validation = await validatePhaseInputs(cpbRoot, projectId, job, phaseName);
  if (!validation.valid) {
    return { exitCode: 1, error: new Error(validation.errors.join("; ")), envelope: null };
  }

  const locator = await buildLocator(cpbRoot, projectId, job, { phase: phaseName, executorRoot });
  const envelope = locatorEnvelope(locator);

  const resolvedExecutorRoot = executorRoot ? path.resolve(stringValue(executorRoot)) : path.resolve(cpbRoot);
  const bridgeScript = scriptPath;

  const jobRunner = path.resolve(resolvedExecutorRoot, "bridges", "job-runner.js");
  if (!await fileExists(jobRunner)) {
    return {
      exitCode: 1,
      error: new Error(`job-runner not found: ${jobRunner}`),
      envelope,
    };
  }

  const runnerArgs = [
    jobRunner,
    "--cpb-root", cpbRoot,
    "--project", projectId,
    "--job-id", job,
    "--phase", phaseName,
    "--script", bridgeScript,
    "--",
    ...stringArray(scriptArgs),
  ];

  let runnerEnv: NodeJS.ProcessEnv;
  try {
    runnerEnv = normalizePhaseEnv(env);
  } catch (error) {
    return {
      exitCode: 1,
      error: error instanceof Error ? error : new Error(String(error)),
      envelope,
    };
  }
  const hubRoot = runnerEnv.CPB_HUB_ROOT;
  if (hubRoot && !runnerEnv.CPB_HUB_STATE_REDIS_CONFIG_FILE) {
    const pinnedConfig = await pinnedHubRedisConfigFile(hubRoot);
    if (pinnedConfig) runnerEnv.CPB_HUB_STATE_REDIS_CONFIG_FILE = pinnedConfig;
  }
  const result = await runTrustedJobRunner(
    resolvedExecutorRoot,
    runnerArgs,
    path.resolve(cpbRoot),
    runnerEnv,
    phaseName,
    bridgeScript,
  );

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    error: result.error || null,
    envelope,
  };
}

export async function runPhase(cpbRoot: string, options: LooseRecord) {
  return dispatchPhase(cpbRoot, options);
}

export async function runPhaseFromLocator(locator: LooseRecord, script: string, scriptArgs: string[]) {
  const result = await dispatchPhase(stringValue(locator.cpbRoot), {
    project: stringValue(locator.project),
    jobId: stringValue(locator.jobId),
    phase: stringValue(locator.phase),
    script,
    scriptArgs,
    executorRoot: stringValue(locator.executorRoot),
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    error: result.error,
    locator,
  };
}

export function extractArtifactId(stdout: string, prefix: string) {
  const lower = prefix.toLowerCase().replace(/s$/, "");
  const pattern = new RegExp(`^${prefix}: .*${lower}-(\\d+)\\.md$`, "mi");
  const match = stdout.match(pattern);
  if (match) return match[1];

  const genericPattern = new RegExp(`^${prefix}: .*/(?:${lower}|${prefix})-(\\d+)\\.md$`, "mi");
  const genericMatch = stdout.match(genericPattern);
  return genericMatch ? genericMatch[1] : null;
}

export function extractPlanId(stdout: string) {
  return extractArtifactId(stdout, "Plan");
}

export function extractDeliverableId(stdout: string) {
  return extractArtifactId(stdout, "Deliverable");
}
