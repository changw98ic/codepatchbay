/**
 * Process-tree command runner.
 *
 * Spawns a command in its own detached process group so the entire tree
 * (the command + any grandchildren it spawns) can be torn down together on
 * timeout or abort. Extracted from bridges/job-runner.ts runChild/killChildProcess
 * Kept in shared/primitives so persistence stores and core execution code consume
 * one process-identity and process-tree authority without reversing layers.
 *
 * Contract:
 *   - detached process group on non-win32 when signal/timeout present
 *   - AbortSignal.aborted  → killTree (SIGTERM group → grace → SIGKILL group)
 *   - timeoutMs elapse     → same, with timedOut flag set
 *   - onSpawn(pid) / onExit(pid, code, signal) hooks for registry injection
 *
 * This module MUST NOT import higher-level implementation modules.
 * Pure node:child_process.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface CommandTreeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Optional stdin payload. The stream is always closed after this payload is written. */
  input?: string;
  /** Per-command timeout (ms). On elapse the process group is killed and timedOut set. */
  timeoutMs?: number;
  /** Abort → killTree. If already aborted at spawn, killed immediately. */
  signal?: AbortSignal;
  /** Grace between SIGTERM and SIGKILL (ms). Default 2000; env CPB_KILL_GRACE_MS overrides. */
  graceMs?: number;
  /** Test seam for cleanup verification polling after SIGKILL. Production callers should not set this. */
  forceVerifyMs?: number;
  /** Maximum captured stdout or stderr bytes before fail-closed tree teardown. Unlimited by default. */
  maxBufferBytes?: number;
  /** Registry injection: called with the child pid and captured incarnation right after spawn. Best-effort. */
  onSpawn?: (pid: number, identity?: ProcessIdentity) => void | Promise<void>;
  /** Registry injection: called with pid/code/signal as the child settles. Best-effort. */
  onExit?: (pid: number, code: number | null, signal: NodeJS.Signals | null) => void | Promise<void>;
  /** Stream callback for stdout chunks (flow-through to caller). */
  onStdout?: (chunk: string) => void;
  /** Stream callback for stderr chunks. */
  onStderr?: (chunk: string) => void;
  /** Test seam for process enumeration/liveness. Production callers should not set this. */
  system?: ProcessTreeSystem;
}

export interface CommandTreeResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  cleanupVerified: boolean;
  rootIdentity?: ProcessIdentity;
  error?: Error;
}

const DEFAULT_GRACE_MS = 2000;
const DEFAULT_FORCE_VERIFY_MS = 1000;
const FORCE_VERIFY_INTERVAL_MS = 50;
const DESCENDANT_SETTLE_INTERVAL_MS = 25;
const DESCENDANT_SETTLE_ATTEMPTS = 3;
const UNOWNED_SPAWN_CLOSE_WAIT_MS = 1000;
const SPAWN_IDENTITY_CAPTURE_ATTEMPTS = 3;

export interface ProcessTreeSystem {
  platform: NodeJS.Platform;
  spawnSync: typeof spawnSync;
  kill: typeof process.kill;
  captureIdentity?: (pid: number) => ProcessIdentity | null;
}

export interface KillTreeOptions {
  requireDescendantScan?: boolean;
  system?: ProcessTreeSystem;
  forceVerifyMs?: number;
  expectedRootIdentity?: ProcessIdentity;
}

const defaultSystem: ProcessTreeSystem = {
  platform: process.platform,
  spawnSync,
  kill: process.kill,
};

function processTreeError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function processTreeCleanupAggregate(primaryError: Error, cleanupError: Error) {
  return Object.assign(
    new AggregateError(
      [primaryError, cleanupError],
      primaryError.message,
      { cause: primaryError },
    ),
    {
      code: "PROCESS_TREE_CLEANUP_FAILED",
      primaryError,
      cleanupError,
    },
  );
}

export function captureSpawnProcessIdentity(
  child: import("node:child_process").ChildProcess,
  system: ProcessTreeSystem = defaultSystem,
) {
  if (!child.pid) return null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < SPAWN_IDENTITY_CAPTURE_ATTEMPTS; attempt += 1) {
    try {
      const identity = captureProcessIdentity(child.pid, { strict: true, system });
      if (identity) return identity;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if ((normalized as NodeJS.ErrnoException).code !== "PROCESS_IDENTITY_UNAVAILABLE") throw normalized;
      lastError = normalized;
    }
    if (child.exitCode !== null || child.signalCode !== null) return null;
  }
  throw lastError || processTreeError(
    "root process identity unavailable after spawn",
    "PROCESS_IDENTITY_UNAVAILABLE",
  );
}

export interface ProcessIdentity {
  pid: number;
  birthId: string;
  incarnation: string;
  capturedAt: string;
  birthIdPrecision?: "exact" | "coarse";
  /** Captured process-group id. Group signals are authorized only when this equals pid. */
  processGroupId?: number;
}

function processIdentity(
  pid: number,
  birthId: string,
  birthIdPrecision: ProcessIdentity["birthIdPrecision"] = "exact",
  processGroupId?: number,
): ProcessIdentity {
  const identity: ProcessIdentity = {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: new Date().toISOString(),
    birthIdPrecision,
  };
  if (Number.isSafeInteger(processGroupId) && Number(processGroupId) > 0) {
    identity.processGroupId = Number(processGroupId);
  }
  return identity;
}

function parseLinuxProcIdentity(content: string) {
  const closeParen = content.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fieldsAfterCommand = content.slice(closeParen + 2).trim().split(/\s+/);
  // /proc/<pid>/stat fields after comm start at field 3 (state), so field 22
  // (starttime) is index 19 in this slice.
  const startTime = fieldsAfterCommand[19];
  const processGroupId = Number.parseInt(fieldsAfterCommand[2] || "", 10);
  if (!startTime) return null;
  return {
    startTime,
    processGroupId: Number.isSafeInteger(processGroupId) && processGroupId > 0
      ? processGroupId
      : undefined,
  };
}

const DARWIN_PROC_PIDINFO_SCRIPT = String.raw`
import ctypes
import os
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

function captureDarwinProcPidInfoIdentity(pid: number, system: ProcessTreeSystem) {
  const result = system.spawnSync("/usr/bin/python3", ["-c", DARWIN_PROC_PIDINFO_SCRIPT, String(pid)], {
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

function isMissingProcessError(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH"
    || (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function sameProcessIdentity(a: ProcessIdentity | null | undefined, b: ProcessIdentity | null | undefined) {
  return Boolean(
    validExactProcessIdentity(a)
      && validExactProcessIdentity(b)
      && a.pid === b.pid
      && a.incarnation === b.incarnation,
  );
}

function validExactProcessIdentity(
  identity: ProcessIdentity | null | undefined,
  expectedPid?: number,
): identity is ProcessIdentity {
  if (!identity) return false;
  const capturedAtMs = Date.parse(identity.capturedAt);
  return Number.isSafeInteger(identity.pid)
    && identity.pid > 0
    && (expectedPid === undefined || identity.pid === expectedPid)
    && typeof identity.birthId === "string"
    && identity.birthId.length > 0
    && identity.incarnation === `${identity.pid}:${identity.birthId}`
    && Number.isFinite(capturedAtMs)
    && new Date(capturedAtMs).toISOString() === identity.capturedAt
    && identity.birthIdPrecision === "exact"
    && (identity.processGroupId === undefined
      || (Number.isSafeInteger(identity.processGroupId) && identity.processGroupId > 0));
}

function assertExactProcessIdentity(identity: ProcessIdentity | null, expectedPid?: number) {
  if (!identity) return null;
  if (!validExactProcessIdentity(identity, expectedPid)) {
    throw processTreeError("process identity is not an exact canonical identity", "PROCESS_IDENTITY_UNAVAILABLE");
  }
  return identity;
}

export function captureProcessIdentity(
  pid: number,
  { strict = false, system = defaultSystem }: { strict?: boolean; system?: ProcessTreeSystem } = {},
): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (system.captureIdentity) {
      const identity = system.captureIdentity(pid);
      return strict ? assertExactProcessIdentity(identity, pid) : identity;
    }
    if (system.platform === "linux") {
      const observed = parseLinuxProcIdentity(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (observed) {
        return processIdentity(
          pid,
          `linux-proc-starttime:${observed.startTime}`,
          "exact",
          observed.processGroupId,
        );
      }
    }
    if (system.platform === "darwin") {
      const identity = captureDarwinProcPidInfoIdentity(pid, system);
      if (identity) return identity;
    }
    if (system.platform === "win32") {
      if (strict) throw processTreeError("process identity unsupported on win32", "PROCESS_IDENTITY_UNAVAILABLE");
      return null;
    }
    const result = system.spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      if (strict) throw processTreeError("process identity unavailable", "PROCESS_IDENTITY_UNAVAILABLE");
      return null;
    }
    const started = result.stdout.trim().replace(/\s+/g, " ");
    if (!started) return null;
    const identity = processIdentity(pid, `ps-lstart:${started}`, "coarse");
    return strict ? assertExactProcessIdentity(identity) : identity;
  } catch (error) {
    if (isMissingProcessError(error)) return null;
    if (strict) {
      if ((error as NodeJS.ErrnoException | undefined)?.code) throw error;
      throw processTreeError("process identity unavailable", "PROCESS_IDENTITY_UNAVAILABLE");
    }
    return null;
  }
}

export function captureCurrentProcessIdentity() {
  return captureProcessIdentity(process.pid, { strict: false });
}

type ProcessIdentityState =
  | { state: "same"; current: ProcessIdentity }
  | { state: "successor"; current: ProcessIdentity }
  | { state: "gone" }
  | { state: "unavailable" };

function observeProcessIdentity(identity: ProcessIdentity, system = defaultSystem): ProcessIdentityState {
  if (!validExactProcessIdentity(identity)) {
    throw processTreeError("process identity is not exact and canonical", "PROCESS_IDENTITY_UNAVAILABLE");
  }
  try {
    system.kill(identity.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ESRCH") return { state: "gone" };
    throw error;
  }
  let current: ProcessIdentity | null;
  try {
    current = captureProcessIdentity(identity.pid, { strict: true, system });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "PROCESS_IDENTITY_UNAVAILABLE") {
      return { state: "unavailable" };
    }
    throw error;
  }
  if (!current) return { state: "unavailable" };
  return sameProcessIdentity(identity, current)
    ? { state: "same", current }
    : { state: "successor", current };
}

async function waitForObservableProcessIdentity(
  identity: ProcessIdentity,
  system: ProcessTreeSystem,
  timeoutMs: number,
) {
  let observed = observeProcessIdentity(identity, system);
  if (observed.state !== "unavailable") return observed;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    await new Promise((resolve) => setTimeout(resolve, FORCE_VERIFY_INTERVAL_MS));
    observed = observeProcessIdentity(identity, system);
    if (observed.state !== "unavailable") return observed;
  } while (Date.now() < deadline);
  throw processTreeError(
    `process ${identity.pid} remained live without an observable exact identity`,
    "PROCESS_IDENTITY_UNAVAILABLE",
  );
}

export function isProcessIdentityAlive(identity: ProcessIdentity, system = defaultSystem) {
  const observed = observeProcessIdentity(identity, system);
  if (observed.state === "unavailable") {
    throw processTreeError("process is live but its exact identity is unavailable", "PROCESS_IDENTITY_UNAVAILABLE");
  }
  return observed.state === "same";
}

function resolveGraceMs(graceMs?: number): number {
  const fromEnv = Number.parseInt(process.env.CPB_KILL_GRACE_MS || "", 10);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return graceMs ?? DEFAULT_GRACE_MS;
}

/**
 * Return every current descendant before the root is signalled. ACP wrappers
 * launch providers in detached process groups, so a root process-group signal
 * alone is not a complete tree teardown.
 */
export function descendantPids(
  rootPid: number,
  { strict = false, system = defaultSystem }: { strict?: boolean; system?: ProcessTreeSystem } = {},
) {
  if (rootPid === 0) return [];
  if (!Number.isSafeInteger(rootPid) || rootPid < 0) {
    if (strict) {
      throw processTreeError("root pid is invalid during descendant cleanup", "PROCESS_ENUMERATION_UNAVAILABLE");
    }
    return [];
  }
  if (system.platform === "win32") {
    if (strict) {
      throw processTreeError("process enumeration unsupported during descendant cleanup", "PROCESS_ENUMERATION_UNAVAILABLE");
    }
    return [];
  }
  const result = system.spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    if (strict) {
      throw processTreeError("process enumeration unavailable during descendant cleanup", "PROCESS_ENUMERATION_UNAVAILABLE");
    }
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(childPid) || !Number.isSafeInteger(parentPid) || childPid <= 0 || parentPid <= 0) continue;
    const entries = children.get(parentPid) || [];
    entries.push(childPid);
    children.set(parentPid, entries);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) || [])];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const childPid = pending.shift();
    if (!childPid || seen.has(childPid)) continue;
    seen.add(childPid);
    descendants.push(childPid);
    pending.push(...(children.get(childPid) || []));
  }
  return descendants;
}

function descendantIdentities(
  rootIdentity: ProcessIdentity,
  {
    strict = false,
    system = defaultSystem,
    onIdentityError,
  }: {
    strict?: boolean;
    system?: ProcessTreeSystem;
    onIdentityError?: (error: Error) => void;
  } = {},
) {
  const identities: ProcessIdentity[] = [];
  for (const pid of descendantPids(rootIdentity.pid, { strict, system })) {
    try {
      const identity = captureProcessIdentity(pid, { strict, system });
      if (identity) identities.push(identity);
      else if (strict) {
        onIdentityError?.(processTreeError(
          `descendant ${pid} identity is unavailable`,
          "PROCESS_IDENTITY_UNAVAILABLE",
        ));
      }
    } catch (error) {
      onIdentityError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (identities.length === 0) return [];

  // PID/PPID enumeration and identity capture are separate operating-system
  // observations. Revalidate both the root incarnation and descendant
  // membership before returning any signal target so a PID recycled between
  // those observations is never adopted as part of the old tree.
  try {
    if (!isProcessIdentityAlive(rootIdentity, system)) return [];
  } catch (error) {
    onIdentityError?.(error instanceof Error ? error : new Error(String(error)));
    return [];
  }
  const confirmedPids = new Set(descendantPids(rootIdentity.pid, { strict, system }));
  try {
    if (!isProcessIdentityAlive(rootIdentity, system)) return [];
  } catch (error) {
    onIdentityError?.(error instanceof Error ? error : new Error(String(error)));
    return [];
  }
  const confirmed: ProcessIdentity[] = [];
  for (const identity of identities) {
    if (!confirmedPids.has(identity.pid)) continue;
    try {
      const current = captureProcessIdentity(identity.pid, { strict, system });
      if (sameProcessIdentity(identity, current)) confirmed.push(identity);
      else if (!current && strict) {
        onIdentityError?.(processTreeError(
          `descendant ${identity.pid} identity became unavailable`,
          "PROCESS_IDENTITY_UNAVAILABLE",
        ));
      }
    } catch (error) {
      onIdentityError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return confirmed;
}

function signalIdentity(identity: ProcessIdentity, signal: NodeJS.Signals, system = defaultSystem) {
  try {
    if (observeProcessIdentity(identity, system).state !== "same") return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "PROCESS_IDENTITY_UNAVAILABLE") return false;
    throw error;
  }
  try {
    system.kill(identity.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalIdentityGroup(identity: ProcessIdentity, signal: NodeJS.Signals, system = defaultSystem) {
  if (identity.processGroupId !== identity.pid) return false;
  try {
    const observed = observeProcessIdentity(identity, system);
    if (observed.state !== "same" || observed.current.processGroupId !== identity.pid) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "PROCESS_IDENTITY_UNAVAILABLE") return false;
    throw error;
  }
  try {
    system.kill(-identity.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalTreeIdentity(
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
  { allowGroup, system }: { allowGroup: boolean; system: ProcessTreeSystem },
) {
  if (allowGroup && signalIdentityGroup(identity, signal, system)) return true;
  return signalIdentity(identity, signal, system);
}

function isPidAlive(pid: number, system = defaultSystem) {
  try {
    system.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ESRCH") return false;
    return true;
  }
}

async function waitForChildClose(
  child: import("node:child_process").ChildProcess,
  timeoutMs: number,
) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<true>((resolve) => child.once("close", () => resolve(true)));
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  const result = await Promise.race([closed, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

async function waitForUnownedSpawnClose(
  child: import("node:child_process").ChildProcess,
  primaryError: Error,
) {
  // Arm the close proof before touching stdio. Destroying or draining a pipe
  // can synchronously advance ChildProcess close bookkeeping; registering the
  // listener afterwards can miss the only authoritative completion event.
  const closeProof = waitForChildClose(child, UNOWNED_SPAWN_CLOSE_WAIT_MS);
  try {
    child.stdin?.end();
  } catch {
    // Best-effort close only. A just-spawned process without exact identity
    // must never be signalled by bare PID.
  }
  try {
    child.stdout?.resume();
    child.stderr?.resume();
    child.unref();
  } catch {
    // Ignore stream/ref cleanup errors; close verification below is the
    // authoritative cleanup result for an unowned child.
  }
  const closed = await closeProof;
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (!closed) {
    throw processTreeCleanupAggregate(
      primaryError,
      processTreeError(
        `unowned spawned process ${child.pid ?? "unknown"} did not close after identity capture failed`,
        "PROCESS_CLEANUP_UNVERIFIED",
      ),
    );
  }
  throw primaryError;
}

async function waitForVerifiedCleanup(
  rootIdentity: ProcessIdentity,
  descendants: ProcessIdentity[],
  { system, forceVerifyMs }: { system: ProcessTreeSystem; forceVerifyMs: number },
) {
  const deadline = Date.now() + forceVerifyMs;
  let alive: string[] = [];
  do {
    alive = [];
    for (const identity of [rootIdentity, ...descendants]) {
      try {
        const observed = observeProcessIdentity(identity, system);
        if (observed.state === "same" || observed.state === "unavailable") {
          alive.push(String(identity.pid));
          continue;
        }
        if (observed.state === "gone" && identity.processGroupId === identity.pid) {
          try {
            system.kill(-identity.pid, 0);
            alive.push(`group:${identity.pid}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
              alive.push(`group:${identity.pid}`);
            } else if ((error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") {
              throw error;
            }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "PROCESS_IDENTITY_UNAVAILABLE") throw error;
        // A just-signalled process may be a zombie: kill(0) still succeeds
        // while proc_pidinfo can no longer return a birth record. Keep polling
        // and fail unverified at the deadline rather than authorizing a signal.
        alive.push(String(identity.pid));
      }
    }
    if (alive.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, FORCE_VERIFY_INTERVAL_MS));
  } while (Date.now() < deadline);
  throw processTreeError(
    `process cleanup could not be verified; still alive: ${alive.join(",")}`,
    "PROCESS_CLEANUP_UNVERIFIED",
  );
}

/**
 * Kill an entire process tree: SIGTERM the root group and every captured
 * detached descendant, then SIGKILL after grace. The returned promise resolves
 * only after the force-kill pass, so short-lived callers cannot exit while an
 * unref'ed cleanup timer still owns the only remaining teardown action.
 */
export async function killTree(
  pid: number,
  graceMs?: number,
  {
    requireDescendantScan = false,
    system = defaultSystem,
    forceVerifyMs = DEFAULT_FORCE_VERIFY_MS,
    expectedRootIdentity,
  }: KillTreeOptions = {},
): Promise<void> {
  if (pid === 0) return;
  if (!Number.isSafeInteger(pid) || pid < 0) {
    throw processTreeError("root pid is invalid; refusing to signal", "PROCESS_IDENTITY_UNAVAILABLE");
  }
  if (!expectedRootIdentity) {
    throw processTreeError("root process identity unavailable; refusing to signal by bare pid", "PROCESS_IDENTITY_UNAVAILABLE");
  }
  const grace = resolveGraceMs(graceMs);
  const useGroup = system.platform !== "win32";
  let scanError: Error | null = null;
  const recordCleanupError = (error: unknown) => {
    scanError = scanError || (error instanceof Error ? error : new Error(String(error)));
  };
  const rootIdentity = assertExactProcessIdentity(expectedRootIdentity, pid);
  if (!rootIdentity) {
    throw processTreeError("root process identity unavailable; refusing to signal by bare pid", "PROCESS_IDENTITY_UNAVAILABLE");
  }
  const initialRootState = await waitForObservableProcessIdentity(rootIdentity, system, forceVerifyMs);
  if (initialRootState.state === "gone") return;
  if (initialRootState.state === "successor") {
    throw processTreeError("root process identity mismatch; refusing to signal possible successor", "PROCESS_IDENTITY_MISMATCH");
  }
  let descendants: ProcessIdentity[] = [];
  const mergeDescendants = (current: ProcessIdentity[]) => {
    const before = new Set(descendants.map((identity) => identity.incarnation));
    const knownPids = new Set([rootIdentity.pid, ...descendants.map((identity) => identity.pid)]);
    descendants = [...descendants, ...current.filter((identity) => !before.has(identity.incarnation) && !knownPids.has(identity.pid))];
    return descendants.filter((identity) => !before.has(identity.incarnation));
  };
  const recaptureDescendants = () => {
    try {
      if (!isProcessIdentityAlive(rootIdentity, system)) return [];
      return mergeDescendants(descendantIdentities(rootIdentity, {
        strict: requireDescendantScan,
        system,
        onIdentityError: recordCleanupError,
      }));
    } catch (error) {
      recordCleanupError(error);
      return [];
    }
  };
  recaptureDescendants();
  if (requireDescendantScan) {
    // A child can publish its PID immediately after spawn while the platform's
    // process table still briefly omits the new PPID edge. Keep the root alive
    // for a short bounded scan window so detached descendants are captured
    // before signalling the root would orphan them under PID 1.
    for (let attempt = 0; attempt < DESCENDANT_SETTLE_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, DESCENDANT_SETTLE_INTERVAL_MS));
      recaptureDescendants();
      if (scanError) break;
    }
  }
  const signalKnownDescendants = (signal: NodeJS.Signals) => {
    for (const childIdentity of [...descendants].reverse()) {
      try {
        signalTreeIdentity(childIdentity, signal, { allowGroup: useGroup, system });
      } catch (error) {
        recordCleanupError(error);
      }
    }
  };
  const rootStillSame = () => {
    try {
      const observed = observeProcessIdentity(rootIdentity, system);
      if (observed.state === "unavailable") {
        recordCleanupError(processTreeError(
          "root process identity unavailable during teardown",
          "PROCESS_IDENTITY_UNAVAILABLE",
        ));
      }
      return observed.state === "same";
    } catch (error) {
      recordCleanupError(error);
      return false;
    }
  };
  const signalRoot = (signal: NodeJS.Signals) => {
    if (!rootStillSame()) return;
    try {
      signalTreeIdentity(rootIdentity, signal, { allowGroup: useGroup, system });
    } catch (error) {
      recordCleanupError(error);
    }
  };
  const term = () => {
    const canRecapture = rootStillSame();
    signalKnownDescendants("SIGTERM");
    if (canRecapture && rootStillSame()) {
      for (const childIdentity of recaptureDescendants().reverse()) {
        try {
          signalTreeIdentity(childIdentity, "SIGTERM", { allowGroup: useGroup, system });
        } catch (error) {
          recordCleanupError(error);
        }
      }
    }
    signalRoot("SIGTERM");
  };
  const force = () => {
    if (rootStillSame()) recaptureDescendants();
    signalKnownDescendants("SIGKILL");
    signalRoot("SIGKILL");
  };
  term();
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        force();
      } catch (error) {
        reject(error);
        return;
      }
      waitForVerifiedCleanup(rootIdentity, descendants, { system, forceVerifyMs })
        .then(() => {
          if (scanError) reject(scanError);
          else resolve();
        }, (verificationError) => {
          if (!scanError) {
            reject(verificationError);
            return;
          }
          const normalizedVerification = verificationError instanceof Error
            ? verificationError
            : new Error(String(verificationError));
          reject(Object.assign(
            new AggregateError(
              [scanError, normalizedVerification],
              "process tree cleanup had both scan and verification failures",
              { cause: scanError },
            ),
            {
              code: "PROCESS_TREE_CLEANUP_FAILED",
              primaryError: scanError,
              verificationError: normalizedVerification,
            },
          ));
        });
    }, grace);
  });
}

/**
 * Spawn a command as its own process group, killable on timeout/abort.
 * Never rejects — failures are reported via exitCode/error in the result.
 */
export async function runCommandTree(
  command: string,
  args: string[],
  opts: CommandTreeOptions,
): Promise<CommandTreeResult> {
  if (opts.signal?.aborted) {
    return {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: true,
      cleanupVerified: true,
    };
  }
  const { cwd, env, input, timeoutMs, signal, onSpawn, onExit, onStdout, onStderr, system = defaultSystem } = opts;
  const graceMs = resolveGraceMs(opts.graceMs);
  const maxBufferBytes = Number.isFinite(opts.maxBufferBytes) && Number(opts.maxBufferBytes) > 0
    ? Math.floor(Number(opts.maxBufferBytes))
    : 0;
  const canTeardown = Boolean(signal || timeoutMs || maxBufferBytes > 0);

  return new Promise((resolve) => {
    let settled = false;
    let child: (import("node:child_process").ChildProcess & { detached?: boolean }) | null = null;
    let timedOut = false;
    let aborted = false;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | null = null;
    let onSpawnDone: Promise<unknown> = Promise.resolve();
    let teardown: Promise<void> | null = null;
    let cleanupError: Error | undefined;
    let rootIdentity: ProcessIdentity | undefined;
    const detached = canTeardown && system.platform !== "win32";

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && child) signal.removeEventListener("abort", onAbort);
    };

    const finish = (exitCode: number | null, signalOut: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const code = error || cleanupError ? 1 : (exitCode ?? 1);
      const onExitStep = onExit && child?.pid != null
        ? Promise.resolve(onExit(child.pid, code, signalOut)).catch(() => undefined)
        : Promise.resolve();
      const done = () => resolve({
        exitCode: code,
        signal: signalOut,
        stdout,
        stderr,
        timedOut,
        aborted,
        cleanupVerified: cleanupError === undefined,
        rootIdentity,
        error: error || cleanupError,
      });
      Promise.all([onSpawnDone, onExitStep, teardown || Promise.resolve()]).then(done, done);
    };

    const startTeardown = () => {
      if (!child?.pid || teardown) return;
      if (!rootIdentity) {
        const primary = cleanupError || processTreeError(
          "root process identity unavailable; refusing command teardown by bare pid",
          "PROCESS_IDENTITY_UNAVAILABLE",
        );
        cleanupError = primary;
        teardown = waitForUnownedSpawnClose(child, primary).catch((error) => {
          cleanupError = error instanceof Error ? error : new Error(String(error));
        });
        void teardown.finally(() => finish(1, null, cleanupError));
        return;
      }
      teardown = killTree(child.pid, graceMs, {
        requireDescendantScan: true,
        system,
        forceVerifyMs: opts.forceVerifyMs,
        expectedRootIdentity: rootIdentity,
      }).catch((error) => {
        cleanupError = cleanupError || (error instanceof Error ? error : new Error(String(error)));
      });
      // A failed signal or an unkillable process may never emit close. Settle
      // from the bounded teardown result as well; finish still waits for the
      // same teardown promise and the settled guard handles the close race.
      void teardown.finally(() => finish(1, null, cleanupError));
    };

    const onAbort = () => {
      if (settled || !child) return;
      aborted = true;
      startTeardown();
    };
    const onTimeout = () => {
      if (settled || !child) return;
      timedOut = true;
      startTeardown();
    };

    try {
      child = spawn(command, args, {
        cwd,
        env: env || process.env,
        detached,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // Narrow unknown catch value to Error; spawn failures are always Error
      // (ENOENT/EPERM/etc.), fallback preserves message for any non-Error throw.
      finish(1, null, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.detached = detached;
    child.stdin?.on("error", () => {
      // The command may exit before consuming all input. Its close/error event
      // remains the authoritative command result.
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (maxBufferBytes > 0 && Buffer.byteLength(stdout, "utf8") + chunk.byteLength > maxBufferBytes) {
        cleanupError = cleanupError || processTreeError(
          `command stdout exceeded ${maxBufferBytes} bytes`,
          "COMMAND_OUTPUT_LIMIT_EXCEEDED",
        );
        startTeardown();
      } else {
        stdout += s;
      }
      onStdout?.(s);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (maxBufferBytes > 0 && Buffer.byteLength(stderr, "utf8") + chunk.byteLength > maxBufferBytes) {
        cleanupError = cleanupError || processTreeError(
          `command stderr exceeded ${maxBufferBytes} bytes`,
          "COMMAND_OUTPUT_LIMIT_EXCEEDED",
        );
        startTeardown();
      } else {
        stderr += s;
      }
      onStderr?.(s);
    });
    child.on("error", (err: Error) => finish(1, null, err));
    child.on("close", (code: number | null, sig: NodeJS.Signals | null) => finish(code, sig));

    // registry injection (best-effort; never blocks settle on failure)
    try {
      const pid = child.pid;
      if (pid != null) {
        if (canTeardown) {
          rootIdentity = captureSpawnProcessIdentity(child, system) || undefined;
          if (!rootIdentity) {
            throw processTreeError(
              "root process identity unavailable after spawn",
              "PROCESS_IDENTITY_UNAVAILABLE",
            );
          }
        } else {
          rootIdentity = captureProcessIdentity(pid, { strict: false, system }) || undefined;
        }
        const maybe = onSpawn?.(pid, rootIdentity);
        if (maybe && typeof maybe.then === "function") {
          onSpawnDone = maybe.catch(() => undefined);
        }
      }
    } catch (error) {
      if (canTeardown) {
        // A very short-lived command can exit while exact birth identity is
        // being captured (notably on Darwin, where proc_pidinfo is queried via
        // a helper). With close/output observers already armed, an exited child
        // needs no teardown authority and may settle from its real close event;
        // exitCode/signalCode can still be stale until Node processes that
        // event. A still-live child remains fail-closed after the bounded close
        // proof and is never signalled by bare PID.
        const identityError = error instanceof Error ? error : new Error(String(error));
        onSpawnDone = waitForChildClose(child, UNOWNED_SPAWN_CLOSE_WAIT_MS).then((closed) => {
          if (closed || settled) return;
          cleanupError = identityError;
          startTeardown();
        });
      }
      /* registry best-effort for non-teardown commands */
    }

    if (settled) return;
    if (!canTeardown || rootIdentity) child.stdin?.end(input || "");

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(onTimeout, timeoutMs);
    }

  });
}
