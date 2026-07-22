#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, renameSync, statSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const repoRoot = process.cwd();
const canonicalRepoRoot = await realpath(repoRoot);
const targetName = process.argv[2];
const configs = {
  node: {
    outDir: "dist",
    tsconfig: "tsconfig.node.json",
    sourceDirs: ["cli", "core", "server", "runtime", "bridges", "shared", "scripts"],
    assetDirs: ["cli", "core", "server", "runtime", "bridges", "shared", "scripts"],
    rootAssets: [],
    testAssets: false,
    metadata: true,
    guardFiles: ["tsconfig.node.json", "scripts/write-dist-metadata.ts", "scripts/build-output.mjs"],
    requiredAfterBuild: ["scripts/write-dist-metadata.js", "cli/cpb.js", "server/services/executor-root.js"],
  },
  tests: {
    outDir: "dist-tests",
    tsconfig: "tsconfig.tests.json",
    sourceDirs: ["cli", "core", "server", "runtime", "bridges", "shared", "scripts", "tests"],
    assetDirs: ["cli", "core", "server", "runtime", "bridges", "shared", "scripts"],
    // Compiled modules such as cli/commands/version.js resolve package.json
    // relative to the test artifact. Keep that single root metadata file
    // self-contained without copying the source tree into dist-tests.
    rootAssets: ["package.json"],
    testAssets: true,
    metadata: false,
    guardFiles: ["tsconfig.tests.json", "tsconfig.node.json", "scripts/build-output.mjs"],
    requiredAfterBuild: ["package.json", "scripts/run-node-tests.js", "tests/cli-runtime-contracts.test.js"],
  },
};

const config = configs[targetName];
if (!config) {
  console.error("usage: node scripts/build-output.mjs <node|tests>");
  process.exit(2);
}

const outputPath = path.join(repoRoot, config.outDir);
const outputParent = path.dirname(outputPath);
const outputBase = path.basename(outputPath);
const repoBase = path.basename(repoRoot);
const buildMeta = ".cpb-build.json";
const assetExtensions = new Set([".json", ".sh", ".md", ".txt", ".html", ".mjs"]);
const lockRoot = process.env.CPB_BUILD_LOCK_ROOT
  ? path.resolve(process.env.CPB_BUILD_LOCK_ROOT)
  : path.join(os.tmpdir(), "cpb-build-output-locks");
const lockMarkerPrefix = ".owner-";
const lockOwnerFile = "owner.json";

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

const staleMs = boundedInteger("CPB_BUILD_LOCK_STALE_MS", 5 * 60 * 1000, 250, 24 * 60 * 60 * 1000);
const waitMs = boundedInteger("CPB_BUILD_LOCK_WAIT_MS", 2 * 60 * 1000, 50, 10 * 60 * 1000);
const sourceRetryLimit = boundedInteger("CPB_BUILD_SOURCE_RETRY_LIMIT", 3, 1, 5);
const testFaults = new Set(
  (process.env.CPB_BUILD_TEST_FAULTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const triggeredTestFaults = new Set();
const triggeredTestPauses = new Set();

function injectedFailure(name, code) {
  if (!testFaults.has(name) || triggeredTestFaults.has(name)) return;
  triggeredTestFaults.add(name);
  const error = new Error(`injected ${name} failure (${code})`);
  error.code = code;
  throw error;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle = null;
  let primaryError = null;
  try {
    handle = await open(directory, "r");
    injectedFailure("directory-fsync-unsupported", "ENOTSUP");
    await handle.sync();
  } catch (error) {
    primaryError = error;
  }
  let closeError = null;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw combineErrors(`directory fsync and close failed: ${directory}`, [primaryError, closeError]);
  }
  if (closeError) throw closeError;
}

async function writeFileDurableAtomic(filePath, content) {
  const parent = path.dirname(filePath);
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle = null;
  let renamed = false;
  let primaryError = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    injectedFailure("owner-temp-before-rename", "EIO");
    await rename(temporaryPath, filePath);
    renamed = true;
    injectedFailure("owner-parent-fsync", "EIO");
    await syncDirectory(parent);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!renamed) {
    try {
      await rm(temporaryPath, { force: true });
      injectedFailure("owner-temp-remove-parent-fsync", "EIO");
      await syncDirectory(parent);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!primaryError && cleanupErrors.length === 0) return;
  if (!primaryError) {
    throw combineErrors(`durable build lock owner cleanup failed: ${filePath}`, cleanupErrors, {
      committed: renamed,
      recoveryPaths: [filePath, temporaryPath],
    });
  }
  if (renamed) {
    throw combineErrors(`build lock owner committed with ambiguous durability: ${filePath}`, [primaryError, ...cleanupErrors], {
      committed: true,
      publicationState: "lock_owner_committed_durability_ambiguous",
      recoveryPaths: [filePath],
    });
  }
  if (cleanupErrors.length === 0) throw primaryError;
  throw combineErrors(`durable build lock owner write failed: ${filePath}`, [primaryError, ...cleanupErrors], {
    committed: false,
    recoveryPaths: [temporaryPath],
  });
}

function existsSyncStrict(filePath) {
  try {
    statSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function existsNoFollowSync(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function statOrNull(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameFileGeneration(expected, actual) {
  return Boolean(
    actual
    && actual.isFile()
    && !actual.isSymbolicLink()
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs,
  );
}

async function readBoundedRegularFileNoFollow(filePath, maxBytes = 64 * 1024) {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw Object.assign(new Error(`unsafe build lock owner file: ${filePath}`), { code: "BUILD_LOCK_UNSAFE" });
  }
  await pauseAtTestHook("after-owner-lstat");
  const noFollowFlag = constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollowFlag) || noFollowFlag === 0) {
    throw Object.assign(new Error(`O_NOFOLLOW is unavailable; refusing build lock owner read: ${filePath}`), {
      code: "BUILD_LOCK_UNSAFE",
    });
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error?.code)) {
      throw Object.assign(new Error(`unsafe build lock owner symlink: ${filePath}`, { cause: error }), {
        code: "BUILD_LOCK_UNSAFE",
      });
    }
    throw error;
  }
  let value = "";
  let primaryError = null;
  try {
    const opened = await handle.stat();
    if (!sameFileGeneration(before, opened) || opened.size > maxBytes) {
      throw Object.assign(new Error(`build lock owner changed while opening: ${filePath}`), { code: "BUILD_LOCK_UNSAFE" });
    }
    await pauseAtTestHook("after-owner-open");

    const chunks = [];
    let total = 0;
    for (;;) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) {
        throw Object.assign(new Error(`build lock owner exceeds ${maxBytes} bytes: ${filePath}`), {
          code: "BUILD_LOCK_UNSAFE",
        });
      }
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw Object.assign(new Error(`build lock owner exceeds ${maxBytes} bytes: ${filePath}`), {
          code: "BUILD_LOCK_UNSAFE",
        });
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    await pauseAtTestHook("after-owner-read");

    const afterDescriptor = await handle.stat();
    let afterPath;
    try {
      afterPath = await lstat(filePath);
    } catch (error) {
      throw Object.assign(new Error(`build lock owner path changed while reading: ${filePath}`, { cause: error }), {
        code: "BUILD_LOCK_UNSAFE",
      });
    }
    if (!sameFileGeneration(opened, afterPath)) {
      throw Object.assign(new Error(`build lock owner path changed while reading: ${filePath}`), {
        code: "BUILD_LOCK_UNSAFE",
      });
    }
    if (total !== opened.size || !sameFileGeneration(opened, afterDescriptor)) {
      throw Object.assign(new Error(`build lock owner changed while reading: ${filePath}`), {
        code: "BUILD_LOCK_UNSAFE",
      });
    }
    value = Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    primaryError = error;
  }
  let closeError = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw combineErrors(`build lock owner read and close both failed: ${filePath}`, [primaryError, closeError]);
  }
  if (closeError) throw closeError;
  return value;
}

async function pauseAtTestHook(name) {
  const hookRoot = process.env.CPB_BUILD_TEST_HOOK_ROOT;
  const requested = new Set(
    (process.env.CPB_BUILD_TEST_PAUSE_AT || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!hookRoot || !requested.has(name) || triggeredTestPauses.has(name)) return;
  triggeredTestPauses.add(name);
  await mkdir(hookRoot, { recursive: true });
  const readyPath = path.join(hookRoot, `${name}.ready`);
  const continuePath = path.join(hookRoot, `${name}.continue`);
  await writeFile(readyPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  const deadline = Date.now() + 15_000;
  while (!await exists(continuePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out at build test hook ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function formatError(error) {
  if (!(error instanceof Error)) return String(error);
  const code = typeof error.code === "string" ? ` [${error.code}]` : "";
  const committed = typeof error.committed === "boolean" ? ` committed:${error.committed}` : "";
  const publicationState = typeof error.publicationState === "string"
    ? ` publicationState:${error.publicationState}`
    : "";
  const recoveryPaths = Array.isArray(error.recoveryPaths) && error.recoveryPaths.length > 0
    ? ` recoveryPaths:${error.recoveryPaths.join(",")}`
    : "";
  return `${error.message}${code}${committed}${publicationState}${recoveryPaths}`;
}

function combineErrors(context, errors, state = {}) {
  const presentErrors = errors.filter((error) => error !== null && error !== undefined);
  const primary = presentErrors[0];
  // Preserve nested aggregate context: recovery layers add semantic state such
  // as "successor preserved" that is lost if only their leaf errno values are
  // retained. Each nested message already includes its ordered leaf failures.
  const flattened = presentErrors;
  const aggregate = new AggregateError(
    flattened,
    `${context}: ${flattened.map(formatError).join("; ")}`,
    primary === undefined ? undefined : { cause: primary },
  );
  if (primary !== undefined) aggregate.primary = primary;
  const inheritedCommitted = presentErrors.some((error) => error?.committed === true);
  const inheritedPublished = presentErrors.some((error) => error?.published === true);
  if (typeof state.committed === "boolean" || inheritedCommitted) {
    aggregate.committed = state.committed === true || inheritedCommitted;
  }
  if (typeof state.published === "boolean" || inheritedPublished) {
    aggregate.published = state.published === true || inheritedPublished;
  }
  aggregate.publicationState = state.publicationState
    || presentErrors.find((error) => typeof error?.publicationState === "string")?.publicationState;
  const recoveryPaths = new Set([
    ...(Array.isArray(state.recoveryPaths) ? state.recoveryPaths : []),
    ...presentErrors.flatMap((error) => Array.isArray(error?.recoveryPaths) ? error.recoveryPaths : []),
  ].filter(Boolean));
  if (recoveryPaths.size > 0) aggregate.recoveryPaths = [...recoveryPaths];
  return aggregate;
}

async function assertSourceCheckout() {
  for (const file of config.guardFiles) {
    if (!await exists(path.join(repoRoot, file))) {
      throw new Error(`build:${targetName} must run from the source checkout; refusing to remove ${config.outDir}`);
    }
  }
}

async function listFiles(dir, predicate = () => true) {
  const fullRoot = path.join(repoRoot, dir);
  if (!await exists(fullRoot)) return [];
  const results = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        const relative = path.relative(repoRoot, full).split(path.sep).join("/");
        if (predicate(relative)) results.push(relative);
      }
    }
  }
  await visit(fullRoot);
  return results;
}

async function fingerprintInputs() {
  const files = new Set(["package.json", "scripts/build-output.mjs", config.tsconfig, ...config.guardFiles]);
  if (targetName === "tests") files.add("tsconfig.node.json");

  for (const dir of config.sourceDirs) {
    for (const file of await listFiles(dir, (relative) => relative.endsWith(".ts"))) files.add(file);
  }
  for (const dir of config.assetDirs) {
    for (const file of await listFiles(dir, (relative) => assetExtensions.has(path.extname(relative)))) files.add(file);
  }
  if (config.testAssets) {
    for (const file of await listFiles("tests", (relative) => assetExtensions.has(path.extname(relative)))) files.add(file);
  }
  if (config.metadata) {
    for (const dir of ["profiles", "skills", "templates"]) {
      for (const file of await listFiles(dir)) files.add(file);
    }
    if (await exists(path.join(repoRoot, "wiki/schema.md"))) files.add("wiki/schema.md");
    for (const file of await listFiles("wiki/projects/_template")) files.add(file);
  }

  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    const full = path.join(repoRoot, file);
    if (!await exists(full)) continue;
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(full));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function outputComplete() {
  for (const file of config.requiredAfterBuild) {
    if (!await exists(path.join(outputPath, file))) return false;
  }
  return true;
}

async function readPublishedFingerprint() {
  try {
    injectedFailure("published-fingerprint-read", "EIO");
    const meta = JSON.parse(await readFile(path.join(outputPath, buildMeta), "utf8"));
    return typeof meta.fingerprint === "string" ? meta.fingerprint : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function processIdentity(pid, birthId, birthIdPrecision = "exact", processGroupId = undefined) {
  const identity = {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: new Date().toISOString(),
    birthIdPrecision,
  };
  if (Number.isSafeInteger(processGroupId) && processGroupId > 0) identity.processGroupId = processGroupId;
  return identity;
}

function parseLinuxProcIdentity(content) {
  const closeParen = content.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fieldsAfterCommand = content.slice(closeParen + 2).trim().split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  const processGroupId = Number.parseInt(fieldsAfterCommand[2] || "", 10);
  if (!startTime) return null;
  return {
    startTime,
    processGroupId: Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : undefined,
  };
}

const DARWIN_PROC_PIDINFO_SCRIPT = String.raw`
import ctypes
import sys

MAXCOMLEN = 16
PROC_PIDTBSDINFO = 3

class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * MAXCOMLEN),
        ("pbi_name", ctypes.c_char * (2 * MAXCOMLEN)),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]

pid = int(sys.argv[1])
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
libc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
libc.proc_pidinfo.restype = ctypes.c_int
info = ProcBsdInfo()
size = ctypes.sizeof(info)
ret = libc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), size)
if ret < size or info.pbi_pid != pid:
    sys.exit(2)
print(f"{info.pbi_start_tvsec}:{info.pbi_start_tvusec}:{info.pbi_pgid}")
`.trim();

function processIdentityError(message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: "PROCESS_IDENTITY_UNAVAILABLE",
  });
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function captureDarwinProcPidInfoIdentity(pid) {
  const result = spawnSync("/usr/bin/python3", ["-c", DARWIN_PROC_PIDINFO_SCRIPT, String(pid)], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  const match = result.stdout.trim().match(/^(\d+):(\d+)(?::(\d+))?$/);
  if (!match) return null;
  const seconds = match[1];
  const microseconds = match[2].padStart(6, "0");
  const processGroupId = Number.parseInt(match[3] || "", 10);
  return processIdentity(
    pid,
    `darwin-proc-pidinfo-starttime:${seconds}.${microseconds}`,
    "exact",
    Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : undefined,
  );
}

function captureProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!processIsAlive(pid)) return null;

  try {
    if (process.platform === "linux") {
      const observed = parseLinuxProcIdentity(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (!observed) throw processIdentityError(`Linux process ${pid} has no readable start time`);
      return processIdentity(
        pid,
        `linux-proc-starttime:${observed.startTime}`,
        "exact",
        observed.processGroupId,
      );
    }
    if (process.platform === "darwin") {
      const identity = captureDarwinProcPidInfoIdentity(pid);
      if (identity) return identity;
      throw processIdentityError(`Darwin process ${pid} has no exact proc_pidinfo start time`);
    }
    if (process.platform === "win32") {
      throw processIdentityError("process identity unsupported on win32");
    }
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (!processIsAlive(pid)) return null;
      throw processIdentityError(`process ${pid} identity command exited ${result.status}`);
    }
    const started = String(result.stdout || "").trim().replace(/\s+/g, " ");
    if (!started) {
      if (!processIsAlive(pid)) return null;
      throw processIdentityError(`process ${pid} identity command returned no start time`);
    }
    return processIdentity(pid, `ps-lstart:${started}`, "coarse");
  } catch (error) {
    if (error?.code === "PROCESS_IDENTITY_UNAVAILABLE") throw error;
    if (!processIsAlive(pid)) return null;
    throw processIdentityError(`process ${pid} identity could not be captured`, error);
  }
}

function parseStoredProcessIdentity(value, expectedPid) {
  if (!value || typeof value !== "object") return null;
  const pid = Number(value.pid);
  const birthId = typeof value.birthId === "string" ? value.birthId : "";
  const incarnation = typeof value.incarnation === "string" ? value.incarnation : "";
  const capturedAt = typeof value.capturedAt === "string" ? value.capturedAt : "";
  const capturedAtMs = Date.parse(capturedAt);
  const birthIdPrecision = value.birthIdPrecision;
  const processGroupId = Number(value.processGroupId);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isSafeInteger(expectedPid)
    || pid !== expectedPid
    || !birthId
    || incarnation !== `${pid}:${birthId}`
    || !Number.isFinite(capturedAtMs)
    || new Date(capturedAtMs).toISOString() !== capturedAt
    || birthIdPrecision !== "exact"
    || (value.processGroupId !== undefined
      && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
  ) {
    return null;
  }
  const identity = { pid, birthId, incarnation, capturedAt, birthIdPrecision };
  if (value.processGroupId !== undefined) identity.processGroupId = processGroupId;
  return identity;
}

function sameProcessIdentity(left, right) {
  return Boolean(
    left
      && right
      && left.birthIdPrecision === "exact"
      && right.birthIdPrecision === "exact"
      && left.pid === right.pid
      && left.incarnation === right.incarnation,
  );
}

function lockIdentity(info) {
  return info ? { dev: String(info.dev), ino: String(info.ino) } : null;
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

async function inspectLock(lockDir) {
  injectedFailure("lock-inspect", "EACCES");
  const info = await statOrNull(lockDir);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Object.assign(new Error(`unsafe build lock directory: ${lockDir}`), { code: "BUILD_LOCK_UNSAFE" });
  }
  let entries;
  try {
    entries = await readdir(lockDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const markerTokens = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(lockMarkerPrefix))
    .map((entry) => entry.name.slice(lockMarkerPrefix.length));
  let owner = null;
  try {
    owner = JSON.parse(await readBoundedRegularFileNoFollow(path.join(lockDir, lockOwnerFile)));
  } catch (error) {
    // An owner file is written atomically; a missing file means acquisition is incomplete.
    if (error?.code !== "ENOENT") throw error;
  }
  const after = await lstat(lockDir);
  if (
    !after.isDirectory()
    || after.isSymbolicLink()
    || after.dev !== info.dev
    || after.ino !== info.ino
  ) throw Object.assign(new Error(`build lock directory changed while reading: ${lockDir}`), { code: "BUILD_LOCK_UNSAFE" });
  const markerToken = markerTokens.length === 1 ? markerTokens[0] : null;
  const ownerToken = typeof owner?.token === "string" ? owner.token : null;
  const ownerPid = Number(owner?.pid);
  const ownerProcessIdentity = parseStoredProcessIdentity(owner?.processIdentity, ownerPid);
  return {
    identity: lockIdentity(info),
    markerToken,
    owner,
    validOwner: Boolean(markerToken && ownerToken === markerToken),
    ownerProcessIdentity,
    mtimeMs: info.mtimeMs,
  };
}

function staleLock(snapshot) {
  if (!snapshot) return false;
  if (snapshot.validOwner && snapshot.ownerProcessIdentity) {
    const currentIdentity = captureProcessIdentity(snapshot.ownerProcessIdentity.pid);
    if (!currentIdentity) return true;
    if (currentIdentity.birthIdPrecision !== "exact") return false;
    return !sameProcessIdentity(snapshot.ownerProcessIdentity, currentIdentity);
  }
  // Missing, malformed, or coarse persisted identities are not authoritative
  // enough to prove staleness. Keep them fail-closed instead of authorizing
  // deletion by age or PID liveness.
  if (snapshot.validOwner) return false;
  return Date.now() - snapshot.mtimeMs >= staleMs;
}

async function refuseQuarantinedLockRestore(quarantinePath, lockDir, reason) {
  const successorPresent = existsNoFollowSync(lockDir);
  const preservationErrors = await collectDirectorySyncFailures([
    { directory: quarantinePath },
    { directory: path.dirname(quarantinePath) },
  ]);
  throw combineErrors(
    successorPresent
      ? `${reason}; successor lock preserved and quarantine retained at ${quarantinePath}`
      : `${reason}; automatic canonical reconstruction refused and quarantine retained at ${quarantinePath}`,
    [
      new Error("safe restore requires descriptor-relative no-replace operations unavailable in this runtime"),
      ...preservationErrors,
    ],
    {
      committed: true,
      publicationState: preservationErrors.length > 0
        ? "lock_quarantine_preservation_durability_ambiguous"
        : "lock_quarantined_recovery_required",
      recoveryPaths: [quarantinePath, lockDir],
    },
  );
}

async function quarantineAndRemoveLock(lockDir, expected, reason, removable, { afterRenameHook } = {}) {
  const quarantinePath = `${lockDir}.quarantine-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockDir, quarantinePath);
    await syncDirectory(path.dirname(lockDir));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (await exists(quarantinePath)) {
      try {
        await refuseQuarantinedLockRestore(quarantinePath, lockDir, `${reason}: quarantine rename durability failed`);
      } catch (restoreError) {
        throw combineErrors(
          `${reason}: quarantine rename and restore both failed`,
          [error, restoreError],
          { recoveryPaths: [quarantinePath, lockDir] },
        );
      }
    }
    throw error;
  }

  try {
    if (afterRenameHook) await pauseAtTestHook(afterRenameHook);
    const actual = await inspectLock(quarantinePath);
    const ownershipMatches = Boolean(
      actual
      && sameIdentity(actual.identity, expected.identity)
      && (!expected.markerToken || actual.markerToken === expected.markerToken),
    );
    if (!ownershipMatches || !removable(actual)) {
      await refuseQuarantinedLockRestore(quarantinePath, lockDir, `${reason}: ownership changed during quarantine`);
    }

    await rm(quarantinePath, { recursive: true, force: true });
    try {
      injectedFailure("lock-remove-parent-fsync", "EIO");
      await syncDirectory(path.dirname(lockDir));
    } catch (error) {
      throw combineErrors(`${reason}: quarantine removal committed with ambiguous durability`, [error], {
        committed: true,
        publicationState: "lock_removal_committed_durability_ambiguous",
        recoveryPaths: [lockDir, quarantinePath],
      });
    }
    return true;
  } catch (error) {
    throw combineErrors(
      `${reason}: quarantined owner could not be safely removed`,
      [error],
      { recoveryPaths: [quarantinePath, lockDir] },
    );
  }
}

async function cleanFailedLockInitialization(lockDir, expected, initializationError) {
  const errors = [initializationError];
  try {
    const removed = await quarantineAndRemoveLock(
      lockDir,
      expected,
      "failed build lock initialization",
      (actual) => Boolean(actual && sameIdentity(actual.identity, expected.identity)),
    );
    if (!removed && await exists(lockDir)) {
      errors.push(new Error("failed build lock initialization: lock ownership was lost; successor lock was preserved"));
    }
  } catch (cleanupError) {
    errors.push(cleanupError);
  }
  throw combineErrors("build lock initialization failed", errors);
}

async function initializeOwnedDirectory(directory, { ownerKind, faultName = null } = {}) {
  await mkdir(directory);
  try {
    await syncDirectory(path.dirname(directory));
  } catch (error) {
    throw combineErrors(`${ownerKind} directory creation committed with ambiguous durability`, [error], {
      committed: true,
      publicationState: "lock_directory_committed_durability_ambiguous",
      recoveryPaths: [directory],
    });
  }
  const token = randomUUID();
  let createdInfo;
  try {
    createdInfo = await stat(directory);
  } catch (error) {
    throw combineErrors(
      `${ownerKind} identity could not be captured; created directory was preserved`,
      [error],
      { recoveryPaths: [directory] },
    );
  }
  const expected = { identity: lockIdentity(createdInfo), markerToken: token };
  let markerCreated = false;
  try {
    await mkdir(path.join(directory, `${lockMarkerPrefix}${token}`));
    markerCreated = true;
    await syncDirectory(directory);
    if (faultName) injectedFailure(faultName, "EIO");
    const ownerProcessIdentity = captureProcessIdentity(process.pid);
    if (!ownerProcessIdentity) throw processIdentityError("current build process identity could not be captured");
    if (ownerProcessIdentity.birthIdPrecision !== "exact") {
      throw processIdentityError("current build process identity lacks exact birth precision");
    }
    const owner = {
      version: 1,
      kind: ownerKind,
      token,
      pid: process.pid,
      processIdentity: ownerProcessIdentity,
      target: targetName,
      repoRoot: canonicalRepoRoot,
      createdAt: new Date().toISOString(),
    };
    await writeFileDurableAtomic(
      path.join(directory, lockOwnerFile),
      `${JSON.stringify(owner, null, 2)}\n`,
    );
  } catch (initializationError) {
    if (initializationError?.committed === true) {
      throw combineErrors(`${ownerKind} initialization committed with ambiguous durability`, [initializationError], {
        committed: true,
        recoveryPaths: [directory],
      });
    }
    await cleanFailedLockInitialization(
      directory,
      markerCreated ? expected : { ...expected, markerToken: null },
      initializationError,
    );
  }
  return { expected, token };
}

async function releaseOwnedDirectory(directory, ownership, reason, faultName = null) {
  const current = await inspectLock(directory);
  if (!current) return;
  if (!sameIdentity(current.identity, ownership.expected.identity) || current.markerToken !== ownership.token) {
    throw combineErrors(
      `${reason}: ownership changed; successor owner was preserved`,
      [new Error(`${reason}: owner identity mismatch`)],
      { recoveryPaths: [directory] },
    );
  }
  if (faultName) injectedFailure(faultName, "EACCES");
  const removed = await quarantineAndRemoveLock(
    directory,
    ownership.expected,
    reason,
    (actual) => Boolean(
      actual
      && sameIdentity(actual.identity, ownership.expected.identity)
      && actual.markerToken === ownership.token,
    ),
  );
  if (!removed && await exists(directory)) {
    throw combineErrors(
      `${reason}: ownership changed; successor owner was preserved`,
      [new Error(`${reason}: owner changed during release`)],
      { recoveryPaths: [directory] },
    );
  }
}

const BUILD_FENCE_PROTOCOL = "cpb-build-output-fence/v2 ";

function buildFenceKey() {
  return createHash("sha256")
    .update(`${canonicalRepoRoot}\0${targetName}\0build-output-fence-v2`)
    .digest("hex");
}

function buildFencePorts(fenceKey) {
  const ports = [];
  const seen = new Set();
  for (let counter = 0; ports.length < 32; counter += 1) {
    const digest = createHash("sha256").update(`${fenceKey}\0${counter}`).digest();
    for (let offset = 0; offset + 1 < digest.length && ports.length < 32; offset += 2) {
      const port = 20_000 + (digest.readUInt16BE(offset) % 40_000);
      if (seen.has(port)) continue;
      seen.add(port);
      ports.push(port);
    }
  }
  return ports;
}

async function probeProcessFence(port, expectedKey, deadline) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.unref();
    let settled = false;
    let response = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish("indeterminate"),
      Math.max(1, Math.min(250, deadline - Date.now())),
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline >= 0) {
        finish(response.slice(0, newline) === `${BUILD_FENCE_PROTOCOL}${expectedKey}` ? "same" : "other");
      } else if (response.length > BUILD_FENCE_PROTOCOL.length && !response.startsWith(BUILD_FENCE_PROTOCOL)) {
        finish("other");
      }
    });
    socket.on("end", () => {
      finish(response.trim() === `${BUILD_FENCE_PROTOCOL}${expectedKey}` ? "same" : "other");
    });
    socket.on("error", (error) => {
      if (["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error?.code)) finish("other");
      else finish("indeterminate");
    });
  });
}

// Acquisition invariants:
// 1. A process must own this OS-managed fence before it reads, quarantines,
//    restores, creates, or releases the `.acquire` lease or the main lock.
// 2. The TCP listener is released by the kernel when its process exits, so its
//    recovery never depends on another removable/renameable filesystem lock.
// 3. Therefore a temporarily absent `.acquire` path during quarantine cannot be
//    claimed by a compliant third builder; that builder is still fenced here.
async function acquireProcessFence(deadline) {
  const fenceKey = buildFenceKey();
  const ports = buildFencePorts(fenceKey);
  for (;;) {
    let contention = false;
    for (const port of ports) {
      const server = net.createServer((socket) => {
        socket.on("error", () => undefined);
        socket.end(`${BUILD_FENCE_PROTOCOL}${fenceKey}\n`);
      });
      server.unref();
      const result = await new Promise((resolve) => {
        const onError = (error) => {
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
        let runtimeError = null;
        server.on("error", (error) => {
          runtimeError = error;
        });
        return async () => {
          let closeError = null;
          try {
            await new Promise((resolve, reject) => {
              server.close((error) => error ? reject(error) : resolve());
            });
          } catch (error) {
            closeError = error;
          }
          if (runtimeError || closeError) {
            throw combineErrors(
              "build process fence release failed",
              [runtimeError, closeError],
              { recoveryPaths: [`tcp://127.0.0.1:${port}`] },
            );
          }
        };
      }
      if (result.error?.code !== "EADDRINUSE") throw result.error;
      const probe = await probeProcessFence(port, fenceKey, deadline);
      if (probe === "other") continue;
      contention = true;
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        contention
          ? `timed out waiting for build:${targetName} process fence`
          : `build:${targetName} process fence namespace is occupied by unrelated listeners`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function acquireAcquisitionLease(leaseDir, deadline) {
  for (;;) {
    try {
      const ownership = await initializeOwnedDirectory(leaseDir, { ownerKind: "build-acquisition-lease" });
      return async () => releaseOwnedDirectory(
        leaseDir,
        ownership,
        "build acquisition lease release refused",
      );
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const observed = await inspectLock(leaseDir);
      if (observed && staleLock(observed)) {
        await pauseAtTestHook("before-acquisition-lease-quarantine");
        const removed = await quarantineAndRemoveLock(
          leaseDir,
          observed,
          "stale build acquisition lease recovery refused",
          (actual) => Boolean(
            actual
            && sameIdentity(actual.identity, observed.identity)
            && actual.markerToken === observed.markerToken
            && staleLock(actual),
          ),
          { afterRenameHook: "after-acquisition-lease-quarantine" },
        );
        // Stale-lease recovery never enters the protected section itself. It
        // loops and must win a fresh atomic mkdir before touching the main lock.
        if (removed) continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for build:${targetName} lock`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function releaseBuildLock(lockDir, leaseDir, ownership, releaseFence) {
  const deadline = Date.now() + waitMs;
  const errors = [];
  let releaseLease = null;
  try {
    releaseLease = await acquireAcquisitionLease(leaseDir, deadline);
  } catch (error) {
    errors.push(error);
  }
  try {
    await releaseOwnedDirectory(lockDir, ownership, "build lock release refused", "cleanup-lock");
  } catch (error) {
    errors.push(error);
  }
  if (releaseLease) {
    try {
      await releaseLease();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await releaseFence();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw combineErrors(
      "build lock cleanup failed",
      errors,
      {
        recoveryPaths: [
          lockDir,
          leaseDir,
          ...buildFencePorts(buildFenceKey()).map((port) => `tcp://127.0.0.1:${port}`),
        ],
      },
    );
  }
}

async function acquireLock() {
  await mkdir(lockRoot, { recursive: true });
  const repoHash = createHash("sha256").update(canonicalRepoRoot).digest("hex").slice(0, 20);
  const lockDir = path.join(lockRoot, `${repoHash}-${targetName}.lock`);
  const leaseDir = `${lockDir}.acquire`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const releaseFence = await acquireProcessFence(deadline);
    let releaseLease = null;
    let ownership = null;
    let operationError = null;
    try {
      releaseLease = await acquireAcquisitionLease(leaseDir, deadline);
      const observed = await inspectLock(lockDir);
      if (!observed) {
        ownership = await initializeOwnedDirectory(lockDir, { ownerKind: "build-lock", faultName: "owner-write" });
      } else if (staleLock(observed)) {
        await pauseAtTestHook("before-lock-quarantine");
        const removed = await quarantineAndRemoveLock(
          lockDir,
          observed,
          "stale build lock recovery refused",
          (actual) => Boolean(
            actual
            && sameIdentity(actual.identity, observed.identity)
            && actual.markerToken === observed.markerToken
            && staleLock(actual),
          ),
          { afterRenameHook: "after-lock-quarantine" },
        );
        if (removed) {
          ownership = await initializeOwnedDirectory(lockDir, { ownerKind: "build-lock", faultName: "owner-write" });
        }
      }
    } catch (error) {
      operationError = error;
    }

    let leaseReleaseError = null;
    if (releaseLease) {
      try {
        await releaseLease();
      } catch (error) {
        leaseReleaseError = error;
      }
    }

    const errors = [operationError, leaseReleaseError].filter(Boolean);
    if (errors.length > 0 && ownership) {
      try {
        await releaseOwnedDirectory(lockDir, ownership, "failed lock acquisition cleanup refused");
        ownership = null;
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    if (errors.length > 0) {
      try {
        await releaseFence();
      } catch (fenceReleaseError) {
        errors.push(fenceReleaseError);
      }
      throw combineErrors(
        "build lock acquisition failed",
        errors,
        {
          recoveryPaths: [
            lockDir,
            leaseDir,
            ...buildFencePorts(buildFenceKey()).map((port) => `tcp://127.0.0.1:${port}`),
          ],
        },
      );
    }

    if (ownership) {
      // Keep the kernel-managed fence for the entire build. The main lock is
      // durable crash evidence; the OS fence is the live mutual-exclusion lease.
      return async () => releaseBuildLock(lockDir, leaseDir, ownership, releaseFence);
    }
    try {
      await releaseFence();
    } catch (fenceReleaseError) {
      throw combineErrors(
        "build process fence release failed while waiting for the main lock",
        [fenceReleaseError],
        { recoveryPaths: buildFencePorts(buildFenceKey()).map((port) => `tcp://127.0.0.1:${port}`) },
      );
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for build:${targetName} lock`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed: ${signal || code}`));
    });
  });
}

async function copyPreservingMode(relative, destinationRoot) {
  const source = path.join(repoRoot, relative);
  const dest = path.join(destinationRoot, relative);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(source, dest);
  await chmod(dest, (await stat(source)).mode & 0o777);
}

async function copyAssets(destinationRoot) {
  for (const file of config.rootAssets) {
    await copyPreservingMode(file, destinationRoot);
  }
  for (const dir of config.assetDirs) {
    for (const file of await listFiles(dir, (relative) => assetExtensions.has(path.extname(relative)))) {
      await copyPreservingMode(file, destinationRoot);
    }
  }
  if (config.testAssets) {
    for (const file of await listFiles("tests", (relative) => assetExtensions.has(path.extname(relative)))) {
      await copyPreservingMode(file, destinationRoot);
    }
  }
  if (config.metadata) {
    for (const dir of ["profiles", "skills", "templates"]) {
      for (const file of await listFiles(dir)) await copyPreservingMode(file, destinationRoot);
    }
    if (await exists(path.join(repoRoot, "wiki/schema.md"))) await copyPreservingMode("wiki/schema.md", destinationRoot);
    for (const file of await listFiles("wiki/projects/_template")) await copyPreservingMode(file, destinationRoot);
  }
}

async function writeNodeMetadata(destinationRoot) {
  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const distPackage = {
    name: rootPackage.name,
    version: rootPackage.version,
    license: rootPackage.license,
    type: "module",
    bin: {
      cpb: "cpb",
    },
    files: [
      "cpb",
      "bridges/",
      "cli/",
      "core/",
      "shared/",
      "runtime/",
      "server/",
      "scripts/",
      "profiles/",
      "skills/",
      "templates/",
      "wiki/schema.md",
      "wiki/projects/_template/",
      "!tests/",
      "!server/.omc/",
    ],
    dependencies: rootPackage.dependencies || {},
    engines: rootPackage.engines || {},
    scripts: {
      test: "node scripts/run-node-tests.js",
      "test:node": "node scripts/run-node-tests.js",
      "test:unit": "node scripts/run-node-tests.js --unit",
      "test:integration": "node scripts/run-node-tests.js --integration",
    },
  };
  await writeFile(path.join(destinationRoot, "package.json"), `${JSON.stringify(distPackage, null, 2)}\n`, "utf8");
  const launcher = `#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CPB_EXECUTOR_ROOT = process.env.CPB_EXECUTOR_ROOT || path.resolve(__dirname);
process.env.CPB_ROOT = process.env.CPB_ROOT || path.resolve(__dirname, "..");

const { main } = await import("./cli/cpb.js");
const code = await main();
if (Number.isInteger(code)) process.exitCode = code;
`;
  const launcherPath = path.join(destinationRoot, "cpb");
  await writeFile(launcherPath, launcher, "utf8");
  await chmod(launcherPath, 0o755);
  for (const relative of [
    "cli/cpb.js",
    "bridges/job-runner.js",
    "bridges/project-worker.js",
    "bridges/run-pipeline.js",
    "bridges/run-phase.js",
  ]) {
    await chmod(path.join(destinationRoot, relative), 0o755);
  }
}

async function buildInto(stagingOutput, fingerprint) {
  await mkdir(stagingOutput, { recursive: true });
  const tsc = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  await run(tsc, ["-p", config.tsconfig, "--outDir", stagingOutput]);
  await copyAssets(stagingOutput);
  if (config.metadata) await writeNodeMetadata(stagingOutput);
  await writeFile(path.join(stagingOutput, buildMeta), `${JSON.stringify({
    target: targetName,
    fingerprint,
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

async function transactionParent() {
  const preferred = path.dirname(repoRoot);
  const [preferredInfo, outputInfo] = await Promise.all([stat(preferred), stat(outputParent)]);
  return String(preferredInfo.dev) === String(outputInfo.dev) ? preferred : outputParent;
}

async function collectDirectorySyncFailures(specs) {
  const errors = [];
  for (const { directory, faultName } of specs) {
    try {
      if (faultName) injectedFailure(faultName, "EIO");
      await syncDirectory(directory);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function directoryGeneration(info) {
  return info && info.isDirectory() && !info.isSymbolicLink()
    ? {
        dev: String(info.dev),
        ino: String(info.ino),
        birthtimeMs: String(info.birthtimeMs),
        mode: String(info.mode),
        uid: String(info.uid),
        gid: String(info.gid),
      }
    : null;
}

function sameDirectoryGeneration(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid,
  );
}

function assertDirectoryGeneration(filePath, expected, description) {
  let actual;
  try {
    actual = directoryGeneration(lstatSync(filePath));
  } catch (error) {
    throw Object.assign(new Error(`${description}: ${filePath}`, { cause: error }), {
      code: "BUILD_RESTORE_GENERATION_CHANGED",
    });
  }
  if (!sameDirectoryGeneration(expected, actual)) {
    throw Object.assign(new Error(`${description}: ${filePath}`), {
      code: "BUILD_RESTORE_GENERATION_CHANGED",
    });
  }
}

function existingCleanupRecoveryPaths(paths) {
  return [...new Set(paths.filter((entry) => entry && existsNoFollowSync(entry)))];
}

async function removeDirectoryGenerationNoClobber(
  directory,
  expectedGeneration,
  {
    reason,
    beforeIsolationHook,
    beforeRemovalHook,
  },
) {
  const parent = path.dirname(directory);
  const cleanupContainer = path.join(
    parent,
    `.${repoBase}-${outputBase}.cpb-cleanup-${process.pid}-${randomUUID()}`,
  );
  let cleanupContainerGeneration = null;
  let isolatedPath = null;
  let isolated = false;
  let isolatedRemoved = false;
  let containerRemoved = false;
  try {
    if (beforeIsolationHook) await pauseAtTestHook(beforeIsolationHook);
    assertDirectoryGeneration(directory, expectedGeneration, `${reason}: owned generation changed before cleanup isolation`);
    await mkdir(cleanupContainer, { mode: 0o700 });
    cleanupContainerGeneration = directoryGeneration(await lstat(cleanupContainer));
    if (!cleanupContainerGeneration) {
      throw Object.assign(new Error(`${reason}: cleanup container is unsafe: ${cleanupContainer}`), {
        code: "BUILD_CLEANUP_UNSAFE",
      });
    }
    await syncDirectory(parent);
    isolatedPath = path.join(cleanupContainer, `.cpb-owned-${randomUUID()}`);
    assertDirectoryGeneration(directory, expectedGeneration, `${reason}: owned generation changed before cleanup rename`);
    assertDirectoryGeneration(
      cleanupContainer,
      cleanupContainerGeneration,
      `${reason}: cleanup container generation changed before cleanup rename`,
    );
    await rename(directory, isolatedPath);
    isolated = true;
    await syncDirectory(parent);
    await syncDirectory(cleanupContainer);
    assertDirectoryGeneration(isolatedPath, expectedGeneration, `${reason}: isolated generation changed after cleanup rename`);
    assertDirectoryGeneration(
      cleanupContainer,
      cleanupContainerGeneration,
      `${reason}: cleanup container generation changed after cleanup rename`,
    );
    if (existsNoFollowSync(directory)) {
      throw Object.assign(new Error(`${reason}: canonical successor appeared; preserving isolated generation`), {
        code: "BUILD_CLEANUP_SUCCESSOR_PRESENT",
      });
    }
    if (beforeRemovalHook) await pauseAtTestHook(beforeRemovalHook);
    assertDirectoryGeneration(isolatedPath, expectedGeneration, `${reason}: isolated generation changed before final removal`);
    assertDirectoryGeneration(
      cleanupContainer,
      cleanupContainerGeneration,
      `${reason}: cleanup container generation changed before final removal`,
    );
    if (existsNoFollowSync(directory)) {
      throw Object.assign(new Error(`${reason}: canonical successor appeared before final removal`), {
        code: "BUILD_CLEANUP_SUCCESSOR_PRESENT",
      });
    }
    await rm(isolatedPath, { recursive: true, force: false });
    isolatedRemoved = true;
    await syncDirectory(cleanupContainer);
    if (existsNoFollowSync(isolatedPath)) {
      throw Object.assign(new Error(`${reason}: isolated generation still exists after removal`), {
        code: "BUILD_CLEANUP_INCOMPLETE",
      });
    }
    assertDirectoryGeneration(
      cleanupContainer,
      cleanupContainerGeneration,
      `${reason}: cleanup container generation changed before release`,
    );
    await rmdir(cleanupContainer);
    containerRemoved = true;
    await syncDirectory(parent);
  } catch (error) {
    const recoveryPaths = existingCleanupRecoveryPaths([
      directory,
      isolatedPath,
      cleanupContainer,
    ]);
    throw combineErrors(reason, [error], {
      committed: isolated || isolatedRemoved || containerRemoved,
      publicationState: isolatedRemoved || containerRemoved
        ? "cleanup_removal_committed_durability_ambiguous"
        : (isolated ? "cleanup_isolated_recovery_required" : undefined),
      recoveryPaths,
    });
  }
}

async function syncDirectoryGeneration(filePath, expected, description, faultName = null) {
  assertDirectoryGeneration(filePath, expected, description);
  if (faultName) injectedFailure(faultName, "EIO");
  await syncDirectory(filePath);
  assertDirectoryGeneration(filePath, expected, description);
}

async function publishDirectoryNoClobber(
  sourcePath,
  destinationPath,
  {
    beforeCommitHook,
    afterReservationHook,
    entryFaultName,
    partialDestinationSyncFaultName,
    partialSourceSyncFaultName,
    reason,
  },
) {
  let entries;
  let sourceGeneration;
  try {
    const sourceInfo = await lstat(sourcePath);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw Object.assign(new Error(`unsafe publish source: ${sourcePath}`), { code: "BUILD_PUBLISH_UNSAFE" });
    }
    sourceGeneration = directoryGeneration(sourceInfo);
    entries = (await readdir(sourcePath)).sort((left, right) => {
      if (left === buildMeta) return 1;
      if (right === buildMeta) return -1;
      return left.localeCompare(right);
    });
  } catch (error) {
    throw combineErrors(
      `${reason}; publish source could not be inspected`,
      [error],
      { committed: false, recoveryPaths: [sourcePath, destinationPath] },
    );
  }

  if (existsNoFollowSync(destinationPath)) {
    const successorError = combineErrors(
      `${reason}; successor output preserved and publish source retained at ${sourcePath}`,
      [Object.assign(new Error(`publish destination already exists: ${destinationPath}`), { code: "EEXIST" })],
      { committed: false, recoveryPaths: [sourcePath, destinationPath] },
    );
    successorError.successorPresent = true;
    throw successorError;
  }
  if (beforeCommitHook) await pauseAtTestHook(beforeCommitHook);

  let reservationGeneration;
  let reservationCreated = false;
  try {
    // mkdir is the no-clobber commit primitive. Unlike rename(source, target),
    // it fails with EEXIST even when a racing successor is an empty directory.
    await mkdir(destinationPath);
    reservationCreated = true;
    reservationGeneration = directoryGeneration(lstatSync(destinationPath));
    if (!reservationGeneration) {
      throw Object.assign(new Error(`publish reservation is not a safe directory: ${destinationPath}`), {
        code: "BUILD_PUBLISH_UNSAFE",
      });
    }
  } catch (error) {
    if (error?.code === "EEXIST") {
      const successorError = combineErrors(
        `${reason}; successor output preserved and publish source retained at ${sourcePath}`,
        [error],
        { committed: false, recoveryPaths: [sourcePath, destinationPath] },
      );
      successorError.successorPresent = true;
      throw successorError;
    }
    throw combineErrors(
      `${reason}; canonical publish reservation failed`,
      [error],
      {
        committed: reservationCreated,
        publicationState: reservationCreated ? "publish_reservation_recovery_required" : undefined,
        recoveryPaths: [sourcePath, destinationPath],
      },
    );
  }

  try {
    if (afterReservationHook) await pauseAtTestHook(afterReservationHook);
    let movedEntries = 0;
    for (const entry of entries) {
      assertDirectoryGeneration(sourcePath, sourceGeneration, "publish source generation changed");
      assertDirectoryGeneration(destinationPath, reservationGeneration, "publish reservation generation changed");
      const destinationEntry = path.join(destinationPath, entry);
      if (existsNoFollowSync(destinationEntry)) {
        throw Object.assign(new Error(`publish destination entry already exists: ${destinationEntry}`), { code: "EEXIST" });
      }
      renameSync(path.join(sourcePath, entry), destinationEntry);
      movedEntries += 1;
      assertDirectoryGeneration(sourcePath, sourceGeneration, "publish source generation changed");
      assertDirectoryGeneration(destinationPath, reservationGeneration, "publish reservation generation changed");
      if (movedEntries === 1 && entryFaultName) injectedFailure(entryFaultName, "EIO");
    }
    await syncDirectoryGeneration(
      destinationPath,
      reservationGeneration,
      "publish reservation generation changed before durability commit",
    );
    await syncDirectoryGeneration(
      sourcePath,
      sourceGeneration,
      "publish source generation changed before durability commit",
    );
    await rmdir(sourcePath);
  } catch (error) {
    const recoverySyncErrors = [];
    try {
      await syncDirectoryGeneration(
        destinationPath,
        reservationGeneration,
        "publish reservation generation changed during partial durability recovery",
        partialDestinationSyncFaultName,
      );
    } catch (syncError) {
      recoverySyncErrors.push(syncError);
    }
    try {
      await syncDirectoryGeneration(
        sourcePath,
        sourceGeneration,
        "publish source generation changed during partial durability recovery",
        partialSourceSyncFaultName,
      );
    } catch (syncError) {
      recoverySyncErrors.push(syncError);
    }
    recoverySyncErrors.push(...await collectDirectorySyncFailures([
      { directory: path.dirname(destinationPath) },
      { directory: path.dirname(sourcePath) },
    ]));
    throw combineErrors(
      `${reason}; no-clobber publish did not complete`,
      [error, ...recoverySyncErrors],
      {
        committed: true,
        publicationState: "publish_no_clobber_incomplete",
        recoveryPaths: [sourcePath, destinationPath],
      },
    );
  }
}

async function publish(stagingOutput, parent) {
  const backupPath = path.join(parent, `.${repoBase}-${outputBase}.cpb-backup-${process.pid}-${randomUUID()}`);
  let oldMoved = false;
  let backupGeneration = null;
  if (existsSyncStrict(outputPath)) {
    injectedFailure("publish-old-rename", "EIO");
    renameSync(outputPath, backupPath);
    oldMoved = true;
    backupGeneration = directoryGeneration(lstatSync(backupPath));
    if (!backupGeneration) {
      throw combineErrors(
        `build:${targetName} previous-output backup generation could not be captured`,
        [new Error(`unsafe previous-output backup: ${backupPath}`)],
        {
          committed: true,
          publicationState: "backup_quarantined_recovery_required",
          recoveryPaths: [backupPath, outputPath],
        },
      );
    }
  }

  try {
    injectedFailure("publish-stage-rename", "EXDEV");
    await publishDirectoryNoClobber(stagingOutput, outputPath, {
      beforeCommitHook: "before-publish-stage-commit",
      afterReservationHook: "after-publish-stage-reservation",
      entryFaultName: "publish-stage-entry-after-first",
      partialDestinationSyncFaultName: "publish-partial-destination-fsync",
      partialSourceSyncFaultName: "publish-partial-source-fsync",
      reason: `build:${targetName} staged-output publish`,
    });
  } catch (publishError) {
    const errors = [publishError];
    let backupMoveSyncErrors = [];
    if (oldMoved) {
      backupMoveSyncErrors = await collectDirectorySyncFailures([
        { directory: outputParent, faultName: "failed-publish-output-parent-fsync" },
        { directory: path.dirname(backupPath), faultName: "failed-publish-backup-parent-fsync" },
      ]);
      if (backupMoveSyncErrors.length > 0) {
        errors.push(combineErrors(
          `build:${targetName} old-output backup rename committed with ambiguous durability`,
          backupMoveSyncErrors,
          {
            committed: true,
            publicationState: "backup_rename_committed_durability_ambiguous",
            recoveryPaths: [outputPath, backupPath],
          },
        ));
      }
      errors.push(combineErrors(
        `build:${targetName} automatic backup restore refused; backup quarantine preserved`,
        [new Error("safe restore requires descriptor-relative no-replace operations unavailable in this runtime")],
        {
          committed: true,
          published: false,
          publicationState: backupMoveSyncErrors.length > 0
            ? "backup_quarantine_committed_durability_ambiguous"
            : "backup_quarantined_recovery_required",
          recoveryPaths: [backupPath, outputPath],
        },
      ));
    }
    throw combineErrors(
      `build:${targetName} publish failed`,
      errors,
      {
        committed: oldMoved || publishError?.committed === true,
        published: false,
        publicationState: oldMoved
          ? (backupMoveSyncErrors.length > 0
            ? "backup_quarantine_committed_durability_ambiguous"
            : "backup_quarantined_recovery_required")
          : publishError?.publicationState,
        recoveryPaths: oldMoved
          ? [outputPath, backupPath]
          : (publishError?.committed === true ? [outputPath] : []),
      },
    );
  }

  const publishSyncErrors = await collectDirectorySyncFailures([
    { directory: outputParent, faultName: "publish-output-parent-fsync" },
    ...(oldMoved
      ? [{ directory: path.dirname(backupPath), faultName: "publish-backup-parent-fsync" }]
      : []),
    { directory: path.dirname(stagingOutput), faultName: "publish-staging-parent-fsync" },
  ]);
  if (publishSyncErrors.length > 0) {
    throw combineErrors(
      `build:${targetName} publish renames committed with ambiguous durability`,
      publishSyncErrors,
      {
        committed: true,
        published: true,
        publicationState: "publish_committed_durability_ambiguous",
        recoveryPaths: [outputPath, ...(oldMoved ? [backupPath] : [])],
      },
    );
  }

  let publishedIdentity;
  try {
    injectedFailure("published-identity-stat", "EIO");
    publishedIdentity = lockIdentity(statSync(outputPath));
  } catch (identityError) {
    throw combineErrors(
      `build:${targetName} output was published but its identity could not be verified`,
      [identityError],
      {
        committed: true,
        published: true,
        publicationState: "publish_committed_identity_ambiguous",
        recoveryPaths: [outputPath, ...(oldMoved ? [backupPath] : [])],
      },
    );
  }
  return {
    backupPath: oldMoved ? backupPath : null,
    backupGeneration,
    parent,
    publishedIdentity,
  };
}

async function rollbackPublished(transaction, primaryError = null) {
  const rejectedPath = path.join(
    transaction.parent,
    `.${repoBase}-${outputBase}.cpb-rollback-${process.pid}-${randomUUID()}`,
  );
  const errors = primaryError ? [primaryError] : [];
  let currentIdentity = null;
  try {
    currentIdentity = lockIdentity(statSync(outputPath));
  } catch (identityError) {
    errors.push(identityError);
  }
  if (!sameIdentity(currentIdentity, transaction.publishedIdentity)) {
    errors.push(new Error("rollback refused: public output is no longer the published generation"));
    throw combineErrors(
      `build:${targetName} identity-safe rollback refused before moving public output`,
      errors,
      {
        committed: false,
        published: true,
        publicationState: "published_unverified",
        recoveryPaths: [outputPath, ...(transaction.backupPath ? [transaction.backupPath] : [])],
      },
    );
  }
  try {
    renameSync(outputPath, rejectedPath);
  } catch (moveError) {
    errors.push(moveError);
    throw combineErrors(
      `build:${targetName} published output could not be isolated for rollback`,
      errors,
      {
        committed: false,
        published: true,
        publicationState: "published_unverified",
        recoveryPaths: [outputPath, ...(transaction.backupPath ? [transaction.backupPath] : [])],
      },
    );
  }

  const isolationSyncErrors = await collectDirectorySyncFailures([
    { directory: outputParent, faultName: "rollback-output-parent-fsync" },
    { directory: path.dirname(rejectedPath), faultName: "rollback-rejected-parent-fsync" },
  ]);
  if (isolationSyncErrors.length > 0) {
    errors.push(combineErrors(
      `build:${targetName} rollback isolation rename committed with ambiguous durability`,
      isolationSyncErrors,
      {
        committed: true,
        published: true,
        publicationState: "rollback_isolation_committed_durability_ambiguous",
        recoveryPaths: [outputPath, rejectedPath, ...(transaction.backupPath ? [transaction.backupPath] : [])],
      },
    ));
    throw combineErrors(
      `build:${targetName} rollback isolation durability failed; automatic canonical reconstruction refused`,
      errors,
      {
        committed: true,
        published: true,
        publicationState: "rollback_isolation_committed_durability_ambiguous",
        recoveryPaths: [outputPath, rejectedPath, ...(transaction.backupPath ? [transaction.backupPath] : [])],
      },
    );
  }

  let rejectedIdentity = null;
  try {
    rejectedIdentity = lockIdentity(statSync(rejectedPath));
  } catch (identityError) {
    errors.push(identityError);
  }
  if (!sameIdentity(rejectedIdentity, transaction.publishedIdentity)) {
    errors.push(new Error("rollback refused: quarantined published output identity changed"));
    throw combineErrors(
      `build:${targetName} identity-safe rollback refused; quarantine preserved`,
      errors,
      {
        committed: true,
        published: true,
        publicationState: "rollback_quarantined_recovery_required",
        recoveryPaths: [outputPath, rejectedPath, ...(transaction.backupPath ? [transaction.backupPath] : [])],
      },
    );
  }

  errors.push(new Error(
    "automatic rollback restore refused because descriptor-relative no-replace operations are unavailable",
  ));
  throw combineErrors(
    `build:${targetName} published output quarantined; manual recovery required`,
    errors,
    {
      committed: true,
      published: true,
      publicationState: "rollback_quarantined_recovery_required",
      recoveryPaths: [outputPath, rejectedPath, ...(transaction.backupPath ? [transaction.backupPath] : [])],
    },
  );
}

function assertPublishedGenerationBeforeCommit(transaction) {
  let currentIdentity = null;
  try {
    currentIdentity = lockIdentity(statSync(outputPath));
  } catch (identityError) {
    throw combineErrors(
      `build:${targetName} published output could not be verified before commit`,
      [identityError],
      {
        committed: false,
        published: true,
        publicationState: "published_unverified",
        recoveryPaths: [outputPath, ...(transaction.backupPath ? [transaction.backupPath] : [])],
      },
    );
  }
  if (!sameIdentity(currentIdentity, transaction.publishedIdentity)) {
    throw combineErrors(
      `build:${targetName} commit refused because public output is no longer the published generation`,
      [new Error("published output identity changed before commit")],
      {
        committed: false,
        published: true,
        publicationState: "published_unverified",
        recoveryPaths: [outputPath, ...(transaction.backupPath ? [transaction.backupPath] : [])],
      },
    );
  }
}

async function finalizePublished(transaction) {
  // Source stability alone is not a commit fence: another publisher may have
  // replaced the public directory. Preserve both that successor and our old
  // backup unless the generation we published is still the one being exposed.
  assertPublishedGenerationBeforeCommit(transaction);
  if (transaction.backupPath) {
    let backupCleanupCompleted = false;
    try {
      injectedFailure("cleanup-backup", "EACCES");
      if (!transaction.backupGeneration) {
        throw new Error("previous-output backup generation is unavailable");
      }
      await removeDirectoryGenerationNoClobber(
        transaction.backupPath,
        transaction.backupGeneration,
        {
          reason: `build:${targetName} previous-output backup cleanup failed`,
          beforeIsolationHook: "before-backup-cleanup-isolation",
          beforeRemovalHook: "before-backup-cleanup-final-remove",
        },
      );
      backupCleanupCompleted = true;
      injectedFailure("cleanup-backup-parent-fsync", "EIO");
      await syncDirectory(path.dirname(transaction.backupPath));
    } catch (cleanupError) {
      throw combineErrors(
        backupCleanupCompleted || cleanupError?.committed === true
          ? `build:${targetName} previous-output backup cleanup committed with recovery required`
          : `build:${targetName} published but the previous-output backup could not be cleaned`,
        [cleanupError],
        {
          committed: true,
          published: true,
          publicationState: cleanupError?.publicationState
            || (backupCleanupCompleted || cleanupError?.committed === true
              ? "committed_cleanup_durability_ambiguous"
              : "committed_cleanup_failed"),
          recoveryPaths: existingCleanupRecoveryPaths([outputPath, transaction.backupPath]),
        },
      );
    }
  }
}

async function removeStagingRoot(
  stagingRoot,
  stagingGeneration,
  primaryError = null,
  { committed = false } = {},
) {
  let cleanupError = null;
  let stagingCleanupCompleted = false;
  try {
    injectedFailure("cleanup-staging", "EACCES");
    await removeDirectoryGenerationNoClobber(stagingRoot, stagingGeneration, {
      reason: `build:${targetName} staging cleanup failed`,
      beforeIsolationHook: "before-staging-cleanup-isolation",
      beforeRemovalHook: "before-staging-cleanup-final-remove",
    });
    stagingCleanupCompleted = true;
    injectedFailure("cleanup-staging-parent-fsync", "EIO");
    await syncDirectory(path.dirname(stagingRoot));
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    const effectiveCommitted = committed
      || primaryError?.committed === true
      || stagingCleanupCompleted
      || cleanupError?.committed === true;
    const cleanupState = cleanupError?.publicationState
      || (stagingCleanupCompleted
        ? "committed_cleanup_durability_ambiguous"
        : (effectiveCommitted ? "committed_cleanup_failed" : undefined));
    throw combineErrors(
      stagingCleanupCompleted || cleanupError?.committed === true
        ? "staging cleanup committed with recovery required"
        : "build and staging cleanup failed",
      [primaryError, cleanupError],
      {
        committed: effectiveCommitted,
        publicationState: primaryError?.publicationState || cleanupState,
        recoveryPaths: existingCleanupRecoveryPaths([stagingRoot]),
      },
    );
  }
  if (primaryError) throw primaryError;
}

async function buildCurrentSource() {
  const parent = await transactionParent();
  for (let attempt = 1; attempt <= sourceRetryLimit; attempt += 1) {
    const fingerprint = await fingerprintInputs();
    if (await outputComplete() && await readPublishedFingerprint() === fingerprint) {
      console.log(`build:${targetName} up to date (${config.outDir})`);
      return false;
    }

    const stagingRoot = await mkdtemp(path.join(parent, `.${repoBase}-${outputBase}.cpb-stage-`));
    const stagingGeneration = directoryGeneration(await lstat(stagingRoot));
    if (!stagingGeneration) {
      throw new Error(`build:${targetName} staging root is unsafe: ${stagingRoot}`);
    }
    const stagingOutput = path.join(stagingRoot, "output");
    let attemptError = null;
    let sourceChanged = false;
    let committed = false;
    try {
      await buildInto(stagingOutput, fingerprint);
      await pauseAtTestHook("after-build");
      await pauseAtTestHook("before-publish");
      const publishFingerprint = await fingerprintInputs();
      if (publishFingerprint !== fingerprint) {
        sourceChanged = true;
      } else {
        const transaction = await publish(stagingOutput, parent);
        await pauseAtTestHook("after-publish-before-fingerprint");
        let stableFingerprint;
        try {
          stableFingerprint = await fingerprintInputs();
        } catch (verificationError) {
          await rollbackPublished(transaction, verificationError);
          throw verificationError;
        }
        if (stableFingerprint !== fingerprint) {
          await rollbackPublished(transaction);
          sourceChanged = true;
        } else {
          await finalizePublished(transaction);
          committed = true;
        }
      }
    } catch (error) {
      attemptError = error;
    }

    await removeStagingRoot(stagingRoot, stagingGeneration, attemptError, { committed });

    if (!sourceChanged) return true;
    if (attempt === sourceRetryLimit) {
      throw new Error(`source changed during build:${targetName} on all ${sourceRetryLimit} attempts; no output was published`);
    }
    console.warn(`source changed during build:${targetName}; discarding staging output and retrying (${attempt}/${sourceRetryLimit})`);
  }
  return false;
}

async function runWithRelease(release) {
  let operationError = null;
  let published = false;
  try {
    published = await buildCurrentSource();
  } catch (error) {
    operationError = error;
  }
  try {
    await release();
  } catch (releaseError) {
    const committed = published || operationError?.committed === true;
    operationError = combineErrors(
      operationError ? "build operation and lock release failed" : "build lock release failed",
      [operationError, releaseError],
      {
        committed,
        publicationState: committed ? "committed_cleanup_failed" : undefined,
      },
    );
  }
  if (operationError) throw operationError;
  return published;
}

async function main() {
  try {
    await assertSourceCheckout();
    const release = await acquireLock();
    const published = await runWithRelease(release);
    if (published) console.log(`build:${targetName} published ${config.outDir}`);
  } catch (error) {
    console.error(formatError(error));
    process.exitCode = 1;
  }
}

await main();
