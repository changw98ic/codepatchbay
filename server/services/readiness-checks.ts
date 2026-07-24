import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  access,
  constants as fsConstants,
  lstat,
  readdir,
  readFile,
  mkdir,
  open,
  realpath,
  stat as statFs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { redactSecrets } from "./observability/observability.js";
import { inspectHubAccessAuditUsage } from "./audit/hub-access-audit.js";
import { listJobs } from "./job/job-store.js";
import { hubStatus, loadRegistry, resolveHubRoot } from "./hub/hub-registry.js";
import { readHubLiveness } from "./hub/hub-registry.js";
import { readLease, isLeaseStale } from "./infra.js";
import { runtimeDataPath } from "./runtime.js";
import { WorkerStore } from "../../shared/orchestrator/worker-store.js";
import { loadHubAuthConfig } from "../../shared/hub-auth.js";
import { openHubOidcProvider } from "../../shared/hub-oidc.js";
import { openHubRedisStateBackend } from "../../shared/hub-state-redis.js";
import { isLoopbackHost } from "../../shared/network.js";

import { sanitizeProviderReason } from "./acp/acp-pool.js";
import { scanHubPollution } from "./project/project-index.js";
import {
  buildAgentSandboxLaunch,
  resolveAgentSandboxPolicy,
} from "../../core/policy/agent-sandbox.js";
import {
  resolveReleaseStoreRoot,
  listReleases,
  inspectCurrentRelease,
  supportedStateFormatVersions,
} from "./release/release-store.js";
import { executorMetadata } from "./executor-root.js";
import * as agentRegistry from "../../core/agents/registry.js";
import { listSetupAgents } from "../../core/setup/agent-catalog.js";
import { detectSetupEnvironment } from "../../core/setup/detect.js";
import { recordValue, type LooseRecord } from "../../core/contracts/types.js";
import { captureProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "../../core/runtime/process-tree.js";
import {
  createTemporaryWorkspace,
  temporaryWorkspaceErrorDetails,
  type TemporaryWorkspace,
  type TemporaryWorkspaceCleanupProof,
} from "../../core/runtime/temporary-workspace.js";
import {
  readBoundedRegularFileNoFollow,
  type BoundedRegularFileReadHooks,
} from "../../core/runtime/durable-directory-lock.js";

const execFileAsync = promisify(execFile);
const SUBPROCESS_TIMEOUT_MS = 5_000;
const MIN_NODE_MAJOR = 18;
const DISK_WARN_BYTES = 100 * 1024 * 1024;
const HUB_WORKER_TTL = 120_000;

// --- Result model ---

type Check = LooseRecord & {
  id: string;
  category: string;
  status: string;
  severity: string;
  message: string;
  details?: unknown;
  remediation?: unknown;
  guidance?: unknown;
  evidence?: unknown;
  recommendedAction?: unknown;
};

type CheckOptions = {
  details?: unknown;
  remediation?: unknown;
};

type ReadinessRecord = LooseRecord & {
  id?: string;
  name?: string;
  displayName?: string;
  binary?: string;
  installed?: boolean;
  recommended?: boolean;
  status?: string;
  error?: unknown;
  version?: string;
  install?: LooseRecord;
  tools?: Record<string, ReadinessRecord>;
  agents?: Record<string, ReadinessRecord>;
  projects?: Record<string, ReadinessRecord>;
  sourcePath?: string;
  projectRuntimeRoot?: string;
  cpbRoot?: string;
  hubRoot?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  probe?: unknown;
  timeout?: number;
  env?: ReadinessEnv;
  adapterOverrides?: Record<string, ReadinessRecord>;
  checks?: Check[];
  summary?: ReadinessRecord;
  command?: string;
  args?: string[];
  fallbackCommand?: string;
  fallbackArgs?: string[];
  stability?: string;
  message?: string;
  guidance?: unknown;
  details?: unknown;
  remediation?: unknown;
  leaseId?: string;
  jobId?: string;
  project?: string;
  currentPhase?: string;
  executor?: ReadinessRecord;
  lineage?: ReadinessRecord;
  executorSelection?: ReadinessRecord;
  selectedReleaseId?: string;
  parentReleaseId?: string;
  severity?: string;
  metadata?: ReadinessRecord;
  selector?: ReadinessRecord;
  releaseId?: string;
  installedPath?: string;
  codeVersion?: string;
  stateFormatVersions?: LooseRecord;
  pid?: number;
  codebaseRoot?: string;
  socketPath?: string | null;
  source?: string;
  type?: string;
  failureType?: string;
  attemptId?: string;
  phase?: string;
  nodeId?: string;
  reason?: string;
  reasons?: unknown[];
  untilTs?: string;
  ts?: string;
  prUrl?: string;
  pullRequestUrl?: string;
  url?: string;
  prNumber?: number;
  number?: number;
  artifact?: unknown;
  path?: string;
  kind?: string;
  broken?: boolean;
  entries?: ReadinessRecord[];
  brokenReferences?: ReadinessRecord[];
  runtimeFailures?: unknown[];
  runtimeContext?: unknown;
  completionGate?: ReadinessRecord;
  attemptIdForChecklist?: string;
  ok?: number;
  warn?: number;
  fail?: number;
  success?: boolean;
};

type ReadinessEnv = NodeJS.ProcessEnv & ReadinessRecord;

function readinessRecord(value: unknown): ReadinessRecord {
  return recordValue(value) as ReadinessRecord;
}

function readinessArray(value: unknown): ReadinessRecord[] {
  return Array.isArray(value) ? value.map(readinessRecord) : [];
}

function sandboxProbe(value: unknown): ((command: string) => boolean) | undefined {
  return typeof value === "function" ? value as (command: string) => boolean : undefined;
}

function makeCheck(id: string, category: string, status: string, severity: string, message: string, { details, remediation }: CheckOptions = {}) {
  const check: Check = { id, category, status, severity, message };
  if (details !== undefined) check.details = details;
  if (remediation !== undefined) check.remediation = remediation;
  return check;
}

function ok(id: string, category: string, message: string, opts?: CheckOptions) {
  return makeCheck(id, category, "ok", "info", message, opts);
}

function warn(id: string, category: string, message: string, opts?: CheckOptions) {
  return makeCheck(id, category, "warn", "important", message, opts);
}

function error(id: string, category: string, message: string, opts?: CheckOptions) {
  return makeCheck(id, category, "error", "critical", message, opts);
}

function skipped(id: string, category: string, message: string, opts?: CheckOptions) {
  return makeCheck(id, category, "skipped", "info", message, opts);
}

export function deriveSummary(checks: Check[]) {
  const counts: Record<string, number> = { ok: 0, warn: 0, error: 0, skipped: 0 };
  for (const check of checks) counts[check.status]++;
  return { ...counts, success: counts.error === 0 };
}

function statusForCategories(checks: Check[], categories: string[]) {
  const selected = checks.filter((check) => categories.includes(check.category));
  if (selected.length === 0) return "skipped";
  if (selected.some((check) => check.status === "error")) return "fail";
  if (selected.some((check) => check.status === "warn")) return "warn";
  if (selected.every((check) => check.status === "skipped")) return "skipped";
  return "pass";
}

function evidenceForCategories(checks: Check[], categories: string[]) {
  const selected = checks.filter((check) => categories.includes(check.category));
  return {
    checks: selected.map((check) => ({
      id: check.id,
      category: check.category,
      status: check.status,
      severity: check.severity,
    })),
  };
}

export function deriveReadinessLevels(checks: Check[] = []) {
  const normalizedChecks = Array.isArray(checks) ? checks : [];
  const levels = [
    {
      level: 0,
      id: "repo-package",
      name: "Repo/package usable",
      status: statusForCategories(normalizedChecks, ["toolchain", "disk"]),
      evidence: evidenceForCategories(normalizedChecks, ["toolchain", "disk"]),
      recommendedAction: null,
    },
    {
      level: 1,
      id: "tests-build",
      name: "Node tests, web tests, and web build",
      status: "skipped",
      evidence: { reason: "doctor does not run long test/build gates" },
      recommendedAction: "Run: cpb health-check or npm test && npm --workspace codepatchbay-web test -- --run && npm run build:web",
    },
    {
      level: 2,
      id: "hub-runtime",
      name: "Hub runtime, registry, jobs, workers, and leases",
      status: statusForCategories(normalizedChecks, ["hub", "registry", "jobs", "workers", "leases"]),
      evidence: evidenceForCategories(normalizedChecks, ["hub", "registry", "jobs", "workers", "leases"]),
      recommendedAction: null,
    },
    {
      level: 3,
      id: "fake-acp-smoke",
      name: "Fake ACP pipeline smoke",
      status: "skipped",
      evidence: { reason: "doctor does not launch pipeline smoke" },
      recommendedAction: "Run: cpb health-check --skip-http --skip-tests --skip-build --fake-acp-smoke",
    },
    {
      level: 4,
      id: "real-provider-smoke",
      name: "Optional real ACP provider smoke",
      status: "skipped",
      optional: true,
      evidence: { reason: "real provider smoke is opt-in to avoid accidental provider spend or rate limits" },
      recommendedAction: "Run the live provider smoke explicitly when provider credentials and budget are available.",
    },
  ];

  let currentLevel = -1;
  for (const level of levels) {
    if (level.optional) continue;
    if (level.status !== "pass") break;
    currentLevel = level.level;
  }

  return {
    currentLevel,
    targetLevel: 3,
    levels,
  };
}

// --- Individual checks ---

async function checkNode() {
  const ver = process.version;
  const major = parseInt(ver.slice(1).split(".")[0], 10);
  if (major < MIN_NODE_MAJOR) {
    return error("node-version", "toolchain", `Node.js ${ver} is below minimum v${MIN_NODE_MAJOR}`, {
      remediation: `Install Node.js v${MIN_NODE_MAJOR} or later.`,
    });
  }
  return ok("node-version", "toolchain", `Node.js ${ver}`);
}

async function checkNpm() {
  try {
    const { stdout } = await execFileAsync("npm", ["--version"], { timeout: SUBPROCESS_TIMEOUT_MS });
    return ok("npm-version", "toolchain", `npm ${stdout.trim()}`);
  } catch {
    return warn("npm-version", "toolchain", "npm not found", {
      remediation: "Install npm (usually bundled with Node.js).",
    });
  }
}

async function checkGit() {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { timeout: SUBPROCESS_TIMEOUT_MS });
    const ver = stdout.trim().replace("git version ", "");
    return ok("git-version", "toolchain", `Git ${ver}`);
  } catch {
    return error("git-version", "toolchain", "Git not found", {
      remediation: "Install Git.",
    });
  }
}

async function findExistingDiskProbePath(targetPath: string, statFn: (path: string) => Promise<import("node:fs").Stats> = statFs) {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      const info = await statFn(current);
      return typeof info.isDirectory === "function" && !info.isDirectory()
        ? path.dirname(current)
        : current;
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

export async function checkDiskSpace(dirPath: string, label: string, { execFileFn = execFileAsync, statFn = statFs }: { execFileFn?: typeof execFileAsync; statFn?: (path: string) => Promise<import("node:fs").Stats> } = {}) {
  const id = `disk-${label}`;
  try {
    const resolved = path.resolve(dirPath);
    const probePath = await findExistingDiskProbePath(resolved, statFn);
    const { stdout } = await execFileFn("df", ["-k", probePath], { timeout: SUBPROCESS_TIMEOUT_MS });
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return skipped(id, "disk", `Cannot parse df output for ${label}`);
    const parts = lines[lines.length - 1].split(/\s+/);
    const freeKb = parseInt(parts[3], 10);
    if (Number.isNaN(freeKb)) return skipped(id, "disk", `Cannot parse free space for ${label}`);
    const freeBytes = freeKb * 1024;
    if (freeBytes < DISK_WARN_BYTES) {
      return warn(id, "disk", `Low disk space (${label}): ${(freeBytes / 1024 / 1024).toFixed(0)} MB free`, {
        details: { path: resolved, freeBytes },
        remediation: `Free at least ${DISK_WARN_BYTES / 1024 / 1024} MB on the ${label} volume.`,
      });
    }
    return ok(id, "disk", `${label}: ${(freeBytes / 1024 / 1024).toFixed(0)} MB free`);
  } catch {
    return skipped(id, "disk", `Cannot check disk space for ${label}`);
  }
}

async function checkAcpAdapter(adapterName: string, command: string, args: string[], { npxPkg, stability }: { npxPkg?: string; stability?: string } = {}) {
  const id = `acp-adapter-${adapterName}`;

  let stdout;
  try {
    const result = await execFileAsync(command, [...args], { timeout: SUBPROCESS_TIMEOUT_MS });
    stdout = result.stdout || "";
  } catch (e) {
    // Discovered agents: info only (non-blocking)
    if (stability === "discovered") {
      return skipped(id, "acp", `${adapterName} not available (auto-discovered)`, {
        details: { command, error: e.message },
      });
    }
    // Experimental agents degrade to warning, stable agents are errors
    if (stability === "experimental") {
      return warn(id, "acp", `${adapterName} adapter not found (experimental)`, {
        details: { command, fallback: npxPkg ? `npx -y ${npxPkg}` : undefined, error: e.message },
        remediation: npxPkg ? `Install adapter: npx -y ${npxPkg}` : undefined,
      });
    }
    return error(id, "acp", `${adapterName} adapter not found`, {
      details: { command, fallback: npxPkg ? `npx -y ${npxPkg}` : undefined, error: e.message },
      remediation: npxPkg ? `Install adapter: npx -y ${npxPkg}` : undefined,
    });
  }

  // Try to extract version from --help output or run --version
  let version;
  try {
    const verResult = await execFileAsync(command, ["--version"], { timeout: SUBPROCESS_TIMEOUT_MS });
    version = (verResult.stdout || "").trim();
  } catch {}
  if (!version) {
    const verMatch = stdout.match(/version[:\s]+([0-9]+\.[0-9]+\.[0-9]+)/i);
    version = verMatch ? verMatch[1] : undefined;
  }

  const msg = version
    ? `${adapterName} adapter available (v${version})`
    : `${adapterName} adapter available`;
  return ok(id, "acp", msg, { details: version ? { version } : undefined });
}

function preferredInstallMethod(agent: ReadinessRecord, setupSnapshot: ReadinessRecord) {
  const methods = Object.keys(agent.install || {});
  if (methods.includes("brew") && setupSnapshot?.tools?.brew?.installed) return "brew";
  if (methods.includes("npm") && setupSnapshot?.tools?.npm?.installed) return "npm";
  return methods[0] || "manual";
}

export function buildSetupReadinessChecks(setupSnapshot: ReadinessRecord = {}, catalog: ReadinessRecord[] = []) {
  const checks = [];
  for (const agent of catalog) {
    const probe = setupSnapshot.agents?.[agent.id] || { installed: false, status: "missing" };
    if (probe.installed) {
      checks.push(ok(`setup-agent-${agent.id}`, "setup", `${agent.displayName} installed`, {
        details: {
          agentId: agent.id,
          binary: agent.binary,
          version: probe.version || null,
          status: probe.status || "installed",
        },
      }));
      continue;
    }

    const method = preferredInstallMethod(agent, setupSnapshot);
    checks.push(warn(`setup-agent-${agent.id}`, "setup", `${agent.displayName} not installed`, {
      details: {
        agentId: agent.id,
        binary: agent.binary,
        recommended: Boolean(agent.recommended),
        status: probe.status || "missing",
        error: probe.error || null,
      },
      remediation: `Run: cpb agents install ${agent.id} --method ${method}`,
    }));
  }
  return checks;
}

async function checkHubLiveness(hubRoot: string) {
  try {
    const liveness = await readHubLiveness(hubRoot);
    if (liveness.alive) {
      return ok("hub-liveness", "hub", `Hub alive (pid: ${liveness.pid})`, {
        details: { pid: liveness.pid, startedAt: liveness.startedAt, version: liveness.version },
      });
    }
    const reason = liveness.reason || "unknown";
    const messages = {
      "no-hub-json": "Hub not started (no hub.json found)",
      "process-gone": `Hub process gone (pid: ${liveness.pid})`,
      "shutdown": `Hub shut down (pid: ${liveness.pid})`,
    };
    return warn("hub-liveness", "hub", messages[reason] || `Hub not alive: ${reason}`, {
      details: liveness,
      remediation: "Run: cpb hub start",
    });
  } catch (e) {
    return error("hub-liveness", "hub", `Hub liveness check failed: ${e.message}`);
  }
}

type HubWritabilityProbeStage = "state-directory" | "probe-directory" | "probe-file";
type HubWritabilityProbeHandle = Awaited<ReturnType<typeof open>>;
const HUB_WRITABILITY_PROBE_SLOT_BYTES = 128;
const HUB_WRITABILITY_PROBE_SLOT_COUNT = 256;
const HUB_WRITABILITY_PROBE_FILE_BYTES = HUB_WRITABILITY_PROBE_SLOT_BYTES * HUB_WRITABILITY_PROBE_SLOT_COUNT;
const HUB_WRITABILITY_PROBE_FILE_NAME = "writability-slots-v1.bin";

export type HubWritabilityProbeTestHooks = {
  afterProbeWritten?: (context: {
    stateDir: string;
    probeDir: string;
    probeFile: string;
    probeId: string;
    slot: number;
  }) => void | Promise<void>;
  closeHandle?: (context: {
    stage: HubWritabilityProbeStage;
    path: string;
    close: () => Promise<void>;
  }) => void | Promise<void>;
};

const hubWritabilityProbeTestHookStorage = new AsyncLocalStorage<HubWritabilityProbeTestHooks>();

export function withHubWritabilityProbeTestHooksForTests<T>(
  hooks: HubWritabilityProbeTestHooks,
  operation: () => T,
): T {
  const parent = hubWritabilityProbeTestHookStorage.getStore();
  return hubWritabilityProbeTestHookStorage.run(parent ? { ...parent, ...hooks } : hooks, operation);
}

type HubWritabilityDirectoryAuthority = {
  stage: Exclude<HubWritabilityProbeStage, "probe-file">;
  path: string;
  handle: HubWritabilityProbeHandle;
  identity: BigIntStats;
  exactMode: number | null;
};

type HubWritabilityOpenHandle = {
  stage: HubWritabilityProbeStage;
  path: string;
  handle: HubWritabilityProbeHandle;
};

function hubWritabilityError(code: string, message: string, cause?: unknown) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code },
  );
}

function hubWritabilityErrorCode(value: unknown) {
  return value && typeof value === "object" && "code" in value
    ? String((value as NodeJS.ErrnoException).code || "")
    : "";
}

function sameHubWritabilityGeneration(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function assertHubWritabilityOwnership(info: BigIntStats, label: string, exactMode: number | null) {
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid())) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_UNSAFE_OWNER",
      `${label} is not owned by the current user`,
    );
  }
  const mode = Number(info.mode & 0o777n);
  if (exactMode === null ? (mode & 0o022) !== 0 : mode !== exactMode) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_UNSAFE_PERMISSIONS",
      exactMode === null
        ? `${label} is group- or world-writable`
        : `${label} permissions are ${mode.toString(8)} instead of ${exactMode.toString(8)}`,
    );
  }
}

function strictHubWritabilityDirectoryFlags() {
  if (
    typeof fsConstants.O_NOFOLLOW !== "number"
    || fsConstants.O_NOFOLLOW === 0
    || typeof fsConstants.O_DIRECTORY !== "number"
    || fsConstants.O_DIRECTORY === 0
  ) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_AUTHORITY_UNAVAILABLE",
      "strict no-follow directory authority is unavailable",
    );
  }
  return fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY;
}

function strictHubWritabilityFileFlags() {
  if (typeof fsConstants.O_NOFOLLOW !== "number" || fsConstants.O_NOFOLLOW === 0) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_AUTHORITY_UNAVAILABLE",
      "strict no-follow file authority is unavailable",
    );
  }
  return fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | fsConstants.O_RDWR
    | fsConstants.O_NOFOLLOW;
}

function strictHubWritabilityExistingFileFlags() {
  if (typeof fsConstants.O_NOFOLLOW !== "number" || fsConstants.O_NOFOLLOW === 0) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_AUTHORITY_UNAVAILABLE",
      "strict no-follow file authority is unavailable",
    );
  }
  return fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
}

async function openHubWritabilityDirectory(
  directoryInput: string,
  stage: HubWritabilityDirectoryAuthority["stage"],
  exactMode: number | null,
): Promise<HubWritabilityDirectoryAuthority> {
  const directory = path.resolve(directoryInput);
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_UNSAFE_PATH",
      `${stage} is not a no-follow directory: ${directory}`,
    );
  }
  if (await realpath(directory) !== directory) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_UNSAFE_PATH",
      `${stage} is not canonical: ${directory}`,
    );
  }
  assertHubWritabilityOwnership(before, stage, exactMode);
  const handle = await open(directory, strictHubWritabilityDirectoryFlags());
  try {
    const descriptor = await handle.stat({ bigint: true });
    const after = await lstat(directory, { bigint: true });
    if (
      !descriptor.isDirectory()
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !sameHubWritabilityGeneration(before, descriptor)
      || !sameHubWritabilityGeneration(before, after)
    ) {
      throw hubWritabilityError(
        "HUB_WRITABILITY_PROBE_IDENTITY_CHANGED",
        `${stage} changed while its authority was opened`,
      );
    }
    assertHubWritabilityOwnership(descriptor, stage, exactMode);
    assertHubWritabilityOwnership(after, stage, exactMode);
    return { stage, path: directory, handle, identity: before, exactMode };
  } catch (primaryError) {
    try {
      await handle.close();
    } catch (closeError) {
      throw Object.assign(new AggregateError(
        [primaryError, closeError],
        `${stage} authority setup and close both failed`,
        { cause: primaryError },
      ), {
        code: "HUB_WRITABILITY_PROBE_AND_CLOSE_FAILED",
        primaryError,
        closeErrors: [closeError],
      });
    }
    throw primaryError;
  }
}

async function assertHubWritabilityDirectory(authority: HubWritabilityDirectoryAuthority) {
  const descriptor = await authority.handle.stat({ bigint: true });
  const observed = await lstat(authority.path, { bigint: true });
  if (
    !descriptor.isDirectory()
    || !observed.isDirectory()
    || observed.isSymbolicLink()
    || !sameHubWritabilityGeneration(authority.identity, descriptor)
    || !sameHubWritabilityGeneration(authority.identity, observed)
  ) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_IDENTITY_CHANGED",
      `${authority.stage} changed during the writability probe`,
    );
  }
  assertHubWritabilityOwnership(descriptor, authority.stage, authority.exactMode);
  assertHubWritabilityOwnership(observed, authority.stage, authority.exactMode);
}

async function assertHubWritabilityFile(
  filePath: string,
  handle: HubWritabilityProbeHandle,
  identity: BigIntStats,
  expectedBytes: number | readonly number[],
) {
  const descriptor = await handle.stat({ bigint: true });
  const observed = await lstat(filePath, { bigint: true });
  if (!descriptor.isFile() || !observed.isFile() || observed.isSymbolicLink()) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_UNSAFE_PATH",
      `probe file is not a no-follow regular file: ${filePath}`,
    );
  }
  if (
    !sameHubWritabilityGeneration(identity, descriptor)
    || !sameHubWritabilityGeneration(identity, observed)
  ) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_IDENTITY_CHANGED",
      `probe file changed during the writability check: ${filePath}`,
    );
  }
  if (descriptor.nlink !== 1n || observed.nlink !== 1n) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_HARDLINKED",
      `probe file has an unsafe hard-link count: ${filePath}`,
    );
  }
  assertHubWritabilityOwnership(descriptor, "probe file", 0o600);
  assertHubWritabilityOwnership(observed, "probe file", 0o600);
  const expectedSizes = typeof expectedBytes === "number" ? [expectedBytes] : expectedBytes;
  if (
    !expectedSizes.some((bytes) => descriptor.size === BigInt(bytes))
    || !expectedSizes.some((bytes) => observed.size === BigInt(bytes))
  ) {
    throw hubWritabilityError(
      "HUB_WRITABILITY_PROBE_SIZE_CHANGED",
      `probe file size changed during the writability check: ${filePath}`,
    );
  }
}

async function closeHubWritabilityHandle(authority: HubWritabilityOpenHandle) {
  const hooks = hubWritabilityProbeTestHookStorage.getStore() || {};
  let closeCalled = false;
  const close = async () => {
    if (closeCalled) return;
    closeCalled = true;
    await authority.handle.close();
  };
  let hookError: unknown;
  try {
    if (hooks.closeHandle) await hooks.closeHandle({
      stage: authority.stage,
      path: authority.path,
      close,
    });
    else await close();
  } catch (error) {
    hookError = error;
  }
  let fallbackCloseError: unknown;
  if (!closeCalled) {
    try {
      await close();
    } catch (error) {
      fallbackCloseError = error;
    }
  }
  if (hookError && fallbackCloseError) {
    throw new AggregateError(
      [hookError, fallbackCloseError],
      `${authority.stage} hook and fallback close both failed`,
      { cause: hookError },
    );
  }
  if (hookError) throw hookError;
  if (fallbackCloseError) throw fallbackCloseError;
}

function wrappedHubWritabilityCloseError(authority: HubWritabilityOpenHandle, cause: unknown) {
  return Object.assign(
    new Error(`${authority.stage} close failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }),
    {
      code: "HUB_WRITABILITY_PROBE_CLOSE_FAILED",
      stage: authority.stage,
      path: authority.path,
    },
  );
}

async function runHubWritabilityProbe(
  stateDir: string,
  probeDir: string,
  probeFile: string,
  probeId: string,
  expectedStateIdentity: BigIntStats,
) {
  const handles: HubWritabilityOpenHandle[] = [];
  let primaryError: unknown;
  let completed = false;
  let verifiedSlot: number | null = null;
  try {
    await mkdir(stateDir, { recursive: true });
    const stateAuthority = await openHubWritabilityDirectory(stateDir, "state-directory", null);
    handles.push(stateAuthority);
    if (!sameHubWritabilityGeneration(expectedStateIdentity, stateAuthority.identity)) {
      throw hubWritabilityError(
        "HUB_WRITABILITY_PROBE_IDENTITY_CHANGED",
        `Hub state directory changed before the writability probe acquired authority: ${stateDir}`,
      );
    }
    try {
      await mkdir(probeDir, { mode: 0o700 });
    } catch (error) {
      if (hubWritabilityErrorCode(error) !== "EEXIST") throw error;
    }
    const probeDirectoryAuthority = await openHubWritabilityDirectory(probeDir, "probe-directory", 0o700);
    handles.push(probeDirectoryAuthority);
    await assertHubWritabilityDirectory(stateAuthority);

    let created = false;
    let probeHandle: HubWritabilityProbeHandle;
    try {
      probeHandle = await open(probeFile, strictHubWritabilityFileFlags(), 0o600);
      created = true;
    } catch (error) {
      if (hubWritabilityErrorCode(error) !== "EEXIST") throw error;
      try {
        probeHandle = await open(probeFile, strictHubWritabilityExistingFileFlags());
      } catch (openError) {
        if (["ELOOP", "EMLINK"].includes(hubWritabilityErrorCode(openError))) {
          throw hubWritabilityError(
            "HUB_WRITABILITY_PROBE_UNSAFE_PATH",
            `persistent probe file is not safe to open without following links: ${probeFile}`,
            openError,
          );
        }
        throw openError;
      }
    }
    handles.push({ stage: "probe-file", path: probeFile, handle: probeHandle });
    const fileIdentity = await probeHandle.stat({ bigint: true });
    if (!fileIdentity.isFile() || fileIdentity.isSymbolicLink()) {
      throw hubWritabilityError(
        "HUB_WRITABILITY_PROBE_UNSAFE_PATH",
        `created probe is not a regular file: ${probeFile}`,
      );
    }
    assertHubWritabilityOwnership(fileIdentity, "probe file", 0o600);
    if (fileIdentity.nlink !== 1n) {
      throw hubWritabilityError(
        "HUB_WRITABILITY_PROBE_HARDLINKED",
        `created probe has an unsafe hard-link count: ${probeFile}`,
      );
    }
    const boundedSize = BigInt(HUB_WRITABILITY_PROBE_FILE_BYTES);
    if (fileIdentity.size !== 0n && fileIdentity.size !== boundedSize) {
      throw hubWritabilityError(
        "HUB_WRITABILITY_PROBE_SIZE_CHANGED",
        `persistent probe file has an invalid bounded size: ${probeFile}`,
      );
    }
    await assertHubWritabilityDirectory(stateAuthority);
    await assertHubWritabilityDirectory(probeDirectoryAuthority);
    await assertHubWritabilityFile(
      probeFile,
      probeHandle,
      fileIdentity,
      [0, HUB_WRITABILITY_PROBE_FILE_BYTES],
    );
    if (created || fileIdentity.size === 0n) {
      await probeHandle.truncate(HUB_WRITABILITY_PROBE_FILE_BYTES);
      await probeHandle.sync();
      await probeDirectoryAuthority.handle.sync();
      await stateAuthority.handle.sync();
    }
    await assertHubWritabilityFile(
      probeFile,
      probeHandle,
      fileIdentity,
      HUB_WRITABILITY_PROBE_FILE_BYTES,
    );

    const payload = Buffer.alloc(HUB_WRITABILITY_PROBE_SLOT_BYTES, 0);
    const marker = Buffer.from(`cpb-hub-writability-probe/v1 ${probeId}\n`, "utf8");
    if (marker.byteLength > payload.byteLength) {
      throw hubWritabilityError("HUB_WRITABILITY_PROBE_PAYLOAD_INVALID", "probe marker exceeds its bounded slot");
    }
    marker.copy(payload);
    const initialSlot = Number.parseInt(probeId.replaceAll("-", "").slice(0, 8), 16)
      % HUB_WRITABILITY_PROBE_SLOT_COUNT;
    for (let attempt = 0; attempt < HUB_WRITABILITY_PROBE_SLOT_COUNT; attempt += 1) {
      const slot = (initialSlot + attempt) % HUB_WRITABILITY_PROBE_SLOT_COUNT;
      const position = slot * HUB_WRITABILITY_PROBE_SLOT_BYTES;
      const result = await probeHandle.write(payload, 0, payload.byteLength, position);
      if (result.bytesWritten !== payload.byteLength) {
        throw hubWritabilityError(
          "HUB_WRITABILITY_PROBE_SHORT_WRITE",
          `probe slot write was short at slot ${slot}`,
        );
      }
      await probeHandle.sync();
      if (attempt === 0) {
        await hubWritabilityProbeTestHookStorage.getStore()?.afterProbeWritten?.({
          stateDir,
          probeDir,
          probeFile,
          probeId,
          slot,
        });
      }

      await assertHubWritabilityDirectory(stateAuthority);
      await assertHubWritabilityDirectory(probeDirectoryAuthority);
      await assertHubWritabilityFile(
        probeFile,
        probeHandle,
        fileIdentity,
        HUB_WRITABILITY_PROBE_FILE_BYTES,
      );

      const readback = Buffer.alloc(payload.byteLength);
      const readResult = await probeHandle.read(readback, 0, readback.byteLength, position);
      if (readResult.bytesRead === payload.byteLength && readback.equals(payload)) {
        verifiedSlot = slot;
        break;
      }
    }
    if (verifiedSlot === null) {
      throw hubWritabilityError(
        "HUB_WRITABILITY_PROBE_CONCURRENT_CONFLICT",
        `no bounded probe slot preserved an exact readback: ${probeFile}`,
      );
    }
    await assertHubWritabilityFile(
      probeFile,
      probeHandle,
      fileIdentity,
      HUB_WRITABILITY_PROBE_FILE_BYTES,
    );
    await assertHubWritabilityDirectory(probeDirectoryAuthority);
    await assertHubWritabilityDirectory(stateAuthority);
    completed = true;
  } catch (error) {
    primaryError = error;
  }

  const closeErrors: unknown[] = [];
  for (const authority of handles.reverse()) {
    try {
      await closeHubWritabilityHandle(authority);
    } catch (error) {
      closeErrors.push(wrappedHubWritabilityCloseError(authority, error));
    }
  }
  if (primaryError && closeErrors.length > 0) {
    throw Object.assign(new AggregateError(
      [primaryError, ...closeErrors],
      "Hub writability probe and handle close both failed",
      { cause: primaryError },
    ), {
      code: "HUB_WRITABILITY_PROBE_AND_CLOSE_FAILED",
      primaryError,
      closeErrors,
    });
  }
  if (primaryError) throw primaryError;
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) {
    throw Object.assign(new AggregateError(
      closeErrors,
      "multiple Hub writability probe handles failed to close",
      { cause: closeErrors[0] },
    ), {
      code: "HUB_WRITABILITY_PROBE_CLOSE_FAILED",
      closeErrors,
    });
  }
  if (!completed) {
    throw hubWritabilityError("HUB_WRITABILITY_PROBE_INCOMPLETE", "Hub writability probe did not complete");
  }
  return verifiedSlot as number;
}

function hubWritabilityErrorDetails(value: unknown) {
  const errors = value instanceof AggregateError ? value.errors : [value];
  return errors.map((entry) => ({
    code: hubWritabilityErrorCode(entry) || null,
    message: entry instanceof Error ? entry.message : String(entry),
  }));
}

export async function checkHubWritability(hubRoot: string) {
  const requestedStateDir = path.join(path.resolve(hubRoot), "state");
  let stateDir = requestedStateDir;
  let probeDir = path.join(stateDir, ".readiness-probes");
  const probeId = randomUUID();
  let probeFile = path.join(probeDir, HUB_WRITABILITY_PROBE_FILE_NAME);
  try {
    await mkdir(requestedStateDir, { recursive: true });
    const requestedState = await lstat(requestedStateDir, { bigint: true });
    if (!requestedState.isDirectory() || requestedState.isSymbolicLink()) {
      throw hubWritabilityError(
        "HUB_WRITABILITY_PROBE_UNSAFE_PATH",
        `Hub state path is not a no-follow directory: ${requestedStateDir}`,
      );
    }
    stateDir = await realpath(requestedStateDir);
    const canonicalState = await lstat(stateDir, { bigint: true });
    if (
      !canonicalState.isDirectory()
      || canonicalState.isSymbolicLink()
      || !sameHubWritabilityGeneration(requestedState, canonicalState)
    ) {
      throw hubWritabilityError(
        "HUB_WRITABILITY_PROBE_IDENTITY_CHANGED",
        `Hub state directory changed while its canonical path was resolved: ${requestedStateDir}`,
      );
    }
    probeDir = path.join(stateDir, ".readiness-probes");
    probeFile = path.join(probeDir, HUB_WRITABILITY_PROBE_FILE_NAME);
    const slot = await runHubWritabilityProbe(stateDir, probeDir, probeFile, probeId, canonicalState);
    return ok("hub-writability", "hub", "Hub state directory writable", {
      details: {
        path: stateDir,
        probeDir,
        probeFile,
        persistent: true,
        slot,
        slotCount: HUB_WRITABILITY_PROBE_SLOT_COUNT,
        fileBytes: HUB_WRITABILITY_PROBE_FILE_BYTES,
      },
    });
  } catch (cause) {
    return error("hub-writability", "hub", "Hub state directory not safely writable", {
      details: {
        path: stateDir,
        probeDir,
        probeFile,
        persistent: true,
        code: hubWritabilityErrorCode(cause) || null,
        error: cause instanceof Error ? cause.message : String(cause),
        errors: hubWritabilityErrorDetails(cause),
      },
      remediation: `Ensure ${stateDir} is owner-controlled and writable without symlinks, hard links, or unsafe permissions`,
    });
  }
}

async function checkHubAccessAudit(hubRoot: string, env: ReadinessEnv) {
  try {
    const redisBackend = await openHubRedisStateBackend({
      hubRoot,
      configFile: env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    });
    const usage = await inspectHubAccessAuditUsage({
      hubRoot,
      maxBytes: env.CPB_HUB_ACCESS_AUDIT_MAX_BYTES,
      redisBackend,
    });
    const percent = Math.round(usage.usagePercent * 10) / 10;
    const details = {
      filePath: usage.filePath,
      pending: usage.pending,
      archiveJournalPath: usage.archiveJournalPath,
      archivePending: usage.archivePending,
      sizeBytes: usage.sizeBytes,
      maxBytes: usage.maxBytes,
      usagePercent: percent,
      remainingBytes: usage.remainingBytes,
    };
    if (usage.pending) {
      return error("hub-access-audit", "hub", "Hub access audit has an interrupted pending append", {
        details,
        remediation: "Restart the Hub to recover the pending append before accepting requests.",
      });
    }
    if (usage.archivePending) {
      return error("hub-access-audit", "hub", "Hub access audit has an interrupted archive transaction", {
        details,
        remediation: "Run: cpb hub recover-access-audit-archive, or restart the offline Hub to recover it automatically.",
      });
    }
    if (usage.usagePercent >= 95) {
      return error("hub-access-audit", "hub", `Hub access audit is ${percent}% full`, {
        details,
        remediation: redisBackend
          ? "Export the Redis audit Stream to the configured SIEM/WORM sink, then apply the approved retention workflow or raise CPB_HUB_ACCESS_AUDIT_MAX_BYTES."
          : "Schedule an offline audit archive or raise CPB_HUB_ACCESS_AUDIT_MAX_BYTES after capacity review.",
      });
    }
    if (usage.usagePercent >= 75) {
      return warn("hub-access-audit", "hub", `Hub access audit is ${percent}% full`, {
        details,
        remediation: "Plan an offline audit archive before the fail-closed capacity limit is reached.",
      });
    }
    return ok("hub-access-audit", "hub", `Hub access audit capacity healthy (${percent}% used)`, { details });
  } catch (e) {
    return error("hub-access-audit", "hub", `Hub access-audit check failed: ${e.message}`, {
      remediation: "Inspect Hub audit file permissions, pending recovery state, and CPB_HUB_ACCESS_AUDIT_MAX_BYTES.",
    });
  }
}

export async function checkHubAuthentication(
  hubRoot: string,
  env: ReadinessEnv,
  options: { fetcher?: typeof fetch; now?: () => number } = {},
) {
  try {
    const oidc = await openHubOidcProvider({
      configFile: env.CPB_HUB_OIDC_CONFIG_FILE,
      hubRoot,
      fetcher: options.fetcher,
      now: options.now,
    });
    const local = await loadHubAuthConfig({
      bearerToken: env.CPB_HUB_BEARER_TOKEN,
      serviceTokensFile: env.CPB_HUB_SERVICE_TOKENS_FILE,
      hubRoot,
      requireAuthentication: oidc.configured || env.CPB_HUB_ALLOW_ANONYMOUS_DEV !== "1",
    });
    const modes = [
      local.credentials.some((credential) => credential.principal.source === "legacy-env") ? "legacy-token" : null,
      local.sourceFile ? "service-token-file" : null,
      oidc.configured ? "oidc-rfc9068" : null,
    ].filter(Boolean);
    const hasAuthentication = local.credentialCount > 0 || oidc.configured;
    if (!hasAuthentication) {
      const host = String(env.CPB_HOST || "127.0.0.1");
      const anonymousDev = env.CPB_HUB_ALLOW_ANONYMOUS_DEV === "1";
      if (anonymousDev && isLoopbackHost(host)) {
        return warn("hub-authentication", "hub", "Loopback Hub uses explicit anonymous development mode", {
          details: { modes: ["local-anonymous-dev"], host },
          remediation: "Remove CPB_HUB_ALLOW_ANONYMOUS_DEV and configure scoped service tokens or OIDC before enterprise use.",
        });
      }
      return error("hub-authentication", "hub", "Hub has no authentication mechanism configured", {
        details: { modes: [], host, anonymousDevRequested: anonymousDev },
        remediation: "Configure CPB_HUB_SERVICE_TOKENS_FILE or CPB_HUB_OIDC_CONFIG_FILE; anonymous development mode is loopback-only and not enterprise-ready.",
      });
    }
    let oidcKeys: { keyCount: number; freshUntil: string | null } | null = null;
    if (oidc.configured) oidcKeys = await oidc.preflight();
    return ok("hub-authentication", "hub", `Hub authentication configured (${modes.join(", ")})`, {
      details: {
        modes,
        localCredentialCount: local.credentialCount,
        oidcKeyCount: oidcKeys?.keyCount || 0,
        oidcJwksFreshUntil: oidcKeys?.freshUntil || null,
      },
    });
  } catch (e) {
    return error("hub-authentication", "hub", "Hub authentication configuration or identity provider is unavailable", {
      details: { code: e && typeof e === "object" && "code" in e ? String(e.code) : null },
      remediation: "Validate private auth-policy files and verify the configured OIDC JWKS endpoint before accepting traffic.",
    });
  }
}

export function checkHubBackupSigning(env: ReadinessEnv) {
  const key = String(env.CPB_HUB_BACKUP_SIGNING_KEY || "");
  if (!key) {
    return error("hub-backup-signing", "hub", "Hub backup signing key is not configured", {
      remediation: "Set CPB_HUB_BACKUP_SIGNING_KEY to a dedicated secret containing at least 32 non-whitespace bytes.",
    });
  }
  if (key.trim() !== key || /\s/.test(key) || Buffer.byteLength(key, "utf8") < 32) {
    return error("hub-backup-signing", "hub", "Hub backup signing key is invalid", {
      remediation: "Replace CPB_HUB_BACKUP_SIGNING_KEY with a dedicated secret containing at least 32 non-whitespace bytes.",
    });
  }
  return ok("hub-backup-signing", "hub", "Hub backup signing is configured");
}

export async function checkHubStateBackend(hubRoot: string, env: ReadinessEnv) {
  try {
    const backend = await openHubRedisStateBackend({
      configFile: env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
      hubRoot,
    });
    if (!backend) {
      return warn("hub-state-backend", "hub", "Hub control-plane state uses single-node local-file transactions", {
        details: { mode: "local-file", multiNodeSafe: false, activeActiveSafe: false },
        remediation: "Configure a private CPB_HUB_STATE_REDIS_CONFIG_FILE before running multiple Hub nodes.",
      });
    }
    await backend.preflight();
    const [assignmentRecords, workerRecords, inboxRecords, jobRecords, auditHead] = await Promise.all([
      backend.scanStateRecords("assignment:"),
      backend.scanStateRecords("worker:"),
      backend.scanStateRecords("workerInbox:"),
      backend.scanStateRecords("job:"),
      backend.readAccessAuditHead(),
    ]);
    for (const { record } of assignmentRecords) {
      const document = readinessRecord(record.data);
      const state = readinessRecord(document.state);
      if (!state.assignmentId || !state.status || !document.attempts
        || typeof document.attempts !== "object" || Array.isArray(document.attempts)) {
        throw Object.assign(new Error("Redis assignment record is malformed"), { code: "HUB_STATE_RECORD_INVALID" });
      }
    }
    for (const { record } of workerRecords) {
      const worker = readinessRecord(record.data);
      if (!worker.workerId || !worker.status || !worker.incarnationToken) {
        throw Object.assign(new Error("Redis worker record is malformed"), { code: "HUB_STATE_RECORD_INVALID" });
      }
    }
    for (const { record } of inboxRecords) {
      const inbox = readinessRecord(record.data);
      if (!inbox.workerId || !inbox.assignmentId || !inbox.payload
        || typeof inbox.payload !== "object" || Array.isArray(inbox.payload)
        || !["pending", "processing"].includes(String(inbox.status || ""))) {
        throw Object.assign(new Error("Redis worker inbox record is malformed"), { code: "HUB_STATE_RECORD_INVALID" });
      }
    }
    for (const { record } of jobRecords) {
      const job = readinessRecord(record.data);
      if (!job.project || !job.jobId || !job.status) {
        throw Object.assign(new Error("Redis job projection is malformed"), { code: "HUB_STATE_RECORD_INVALID" });
      }
    }
    const brokerUrl = typeof env.CPB_HUB_WORKER_BROKER_URL === "string" ? env.CPB_HUB_WORKER_BROKER_URL : "";
    let brokerEndpoint: URL | null = null;
    try {
      brokerEndpoint = brokerUrl ? new URL(brokerUrl) : null;
    } catch { /* reported below */ }
    if (!brokerEndpoint || (brokerEndpoint.protocol !== "https:"
      && !(brokerEndpoint.protocol === "http:" && isLoopbackHost(brokerEndpoint.hostname)))) {
      return error("hub-state-backend", "hub", "Redis shared state requires a secure managed-worker broker endpoint", {
        details: { code: "HUB_WORKER_BROKER_REQUIRED", mode: "redis-cas" },
        remediation: "Configure CPB_HUB_WORKER_BROKER_URL with HTTPS, or loopback HTTP when the worker runs on the Hub host.",
      });
    }
    return warn("hub-state-backend", "hub", "Redis protects shared runtime and access-audit authority; target-topology failover and load validation remain incomplete", {
      details: {
        mode: "redis-cas",
        topology: backend.topology,
        multiNodeSafe: true,
        activeActiveSafe: false,
        sharedStores: ["registry", "leader", "queue", "assignments", "workers", "workerInbox", "leases", "jobs", "jobEvents", "accessAudit"],
        remainingLocalStores: [],
        accessAudit: { sequence: auditHead.sequence, sizeBytes: auditHead.sizeBytes },
        workerCredentialIsolation: "worker/incarnation-scoped broker; Redis credential retained by Hub only",
      },
      remediation: "Keep one elected scheduler and validate Redis failover, rolling restart, sustained load, and recovery objectives in the target topology before production promotion.",
    });
  } catch (e) {
    return error("hub-state-backend", "hub", "Hub Redis state backend is unavailable", {
      details: { code: e && typeof e === "object" && "code" in e ? String(e.code) : null },
      remediation: "Validate the private Redis state config, TLS/auth settings, and Redis availability before starting the Hub.",
    });
  }
}

async function checkRegistryConsistency(hubRoot: string) {
  try {
    const registry = await loadRegistry(hubRoot);
    const projects = Object.values(registry.projects || {}).map(readinessRecord);
    const issues = [];
    for (const project of projects) {
      if (!project.id) {
        issues.push({ project: "unknown", issue: "missing id" });
      } else if (!project.sourcePath) {
        issues.push({ project: project.id, issue: "missing sourcePath" });
      }
    }
    if (issues.length > 0) {
      return warn("registry-consistency", "registry", `${issues.length} registry issue(s)`, {
        details: issues,
        remediation: "Run: cpb hub projects to inspect, or restart workers.",
      });
    }
    return ok("registry-consistency", "registry", `${projects.length} project(s) registered`);
  } catch (e) {
    return error("registry-consistency", "registry", `Registry read failed: ${e.message}`);
  }
}

async function checkStaleJobs(cpbRoot: string) {
  try {
    const allJobs = (await listJobs(cpbRoot)).map(readinessRecord);
    const terminalStates = ["completed", "failed", "blocked", "cancelled"];
    const running = allJobs.filter((j) => !terminalStates.includes(j.status));
    if (running.length === 0) return ok("stale-jobs", "jobs", "No running jobs");

    const stale = [];
    const missingLeases = [];
    for (const job of running) {
      if (!job.leaseId) {
        stale.push({ jobId: job.jobId, project: job.project, phase: job.currentPhase, issue: "no lease" });
        continue;
      }
      try {
        const lease = await readLease(cpbRoot, job.leaseId);
        if (lease === null) {
          missingLeases.push({ jobId: job.jobId, project: job.project, leaseId: job.leaseId, issue: "lease file missing" });
        } else if (isLeaseStale(lease)) {
          stale.push({ jobId: job.jobId, project: job.project, phase: job.currentPhase, issue: "expired lease" });
        }
      } catch {
        stale.push({ jobId: job.jobId, project: job.project, phase: job.currentPhase, issue: "lease read error" });
      }
    }
    const allIssues = [...stale, ...missingLeases];
    if (allIssues.length > 0) {
      return warn("stale-jobs", "jobs", `${allIssues.length} stale job(s) (${stale.length} stale, ${missingLeases.length} missing lease)`, {
        details: allIssues,
        remediation: "Run: cpb recover <project> <jobId> or cpb jobs reconcile",
      });
    }
    return ok("stale-jobs", "jobs", `${running.length} running job(s), all leases active`);
  } catch (e) {
    return warn("stale-jobs", "jobs", `Cannot check stale jobs: ${e.message}`);
  }
}

async function checkOrphanLeases(cpbRoot: string) {
  try {
    const leasesDir = runtimeDataPath(cpbRoot, "leases");
    let files;
    try {
      files = await readdir(leasesDir);
    } catch {
      return ok("orphan-leases", "leases", "No leases directory");
    }
    const leaseFiles = files.filter((f) => f.endsWith(".json"));
    if (leaseFiles.length === 0) return ok("orphan-leases", "leases", "No lease files");

    const allJobs = (await listJobs(cpbRoot)).map(readinessRecord);
    const jobLeaseIds = new Set(allJobs.map((j) => j.leaseId).filter(Boolean));
    const orphans = [];
    for (const f of leaseFiles) {
      const leaseId = f.replace(".json", "");
      if (!jobLeaseIds.has(leaseId)) {
        orphans.push({ leaseId });
      }
    }
    if (orphans.length > 0) {
      return warn("orphan-leases", "leases", `${orphans.length} orphan lease(s) not tied to any job`, {
        details: orphans,
        remediation: "Run: cpb gc to clean up orphan leases from completed jobs.",
      });
    }
    return ok("orphan-leases", "leases", `${leaseFiles.length} lease(s), all tied to jobs`);
  } catch (e) {
    return warn("orphan-leases", "leases", `Cannot check orphan leases: ${e.message}`);
  }
}

async function checkStaleWorkers(hubRoot: string) {
  try {
    const workerStore = new WorkerStore(hubRoot);
    const workers = await workerStore.listWorkers();
    const stale = [];
    const now = Date.now();
    for (const worker of workers) {
      if (worker.status === "exited") continue;
      const lastSeenAt = worker.lastHeartbeatAt || worker.startedAt;
      const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
      if (!Number.isFinite(lastSeenMs) || now - lastSeenMs > HUB_WORKER_TTL) {
        stale.push({ workerId: worker.workerId, status: worker.status, lastSeenAt: lastSeenAt || null });
      }
    }
    if (stale.length > 0) {
      return warn("stale-workers", "workers", `${stale.length} stale worker(s)`, {
        details: stale,
        remediation: "Stale workers self-recover on next heartbeat. Check worker process health.",
      });
    }
    return ok("stale-workers", "workers", "No stale workers");
  } catch (e) {
    return warn("stale-workers", "workers", `Cannot check stale workers: ${e.message}`);
  }
}

async function checkProviderBackoff(hubRoot: string) {
  try {
    const rateLimitsPath = path.join(path.resolve(hubRoot), "providers", "rate-limits.json");
    let limits;
    try {
      const raw = await readFile(rateLimitsPath, "utf8");
      limits = JSON.parse(raw);
    } catch {
      return ok("provider-backoff", "provider", "No active provider backoff");
    }

    const active = [];
    const now = Date.now();
    for (const [agent, info] of Object.entries(limits)) {
      if (!info || typeof info !== "object") continue;
      const backoff = info as ReadinessRecord;
      const untilTs = Date.parse(String(backoff.untilTs || ""));
      if (Number.isFinite(untilTs) && untilTs > now) {
        active.push({
          agent,
          untilTs: backoff.untilTs,
          reason: sanitizeProviderReason(backoff.reason || ""),
        });
      }
    }
    if (active.length > 0) {
      return warn("provider-backoff", "provider", `${active.length} provider(s) in rate-limit backoff`, {
        details: active,
        remediation: "Wait for rate limit to expire, or reduce request frequency.",
      });
    }
    return ok("provider-backoff", "provider", "No active provider backoff");
  } catch (e) {
    return warn("provider-backoff", "provider", `Cannot check provider backoff: ${e.message}`);
  }
}

async function checkHubProjectPollution(hubRoot: string) {
  try {
    const { candidates, orphanRuntimeDirs } = await scanHubPollution(hubRoot);
    const all = [...candidates, ...orphanRuntimeDirs];
    if (all.length === 0) {
      return ok("hub-project-pollution", "registry", "No test/fixture pollution detected");
    }
    const details = all.map((entry) => ({
      projectId: entry.projectId,
      sourcePath: entry.sourcePath,
      projectRuntimeRoot: entry.projectRuntimeRoot,
      runtimeDir: entry.runtimeDir,
      reasons: entry.reasons,
    }));
    return warn("hub-project-pollution", "registry", `${all.length} test/fixture/orphan pollution candidate(s) detected`, {
      details,
      remediation: "Run: cpb jobs cleanup --dry-run to review, then cpb jobs cleanup to remove.",
    });
  } catch (e) {
    return warn("hub-project-pollution", "registry", `Cannot check project pollution: ${e.message}`);
  }
}

export function buildAgentSandboxReadinessChecks({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  probe,
}: { env?: ReadinessEnv; cwd?: string; platform?: NodeJS.Platform; probe?: unknown } = {}) {
  let policy;
  try {
    policy = resolveAgentSandboxPolicy(env, { cwd, platform, ...(sandboxProbe(probe) ? { probe: sandboxProbe(probe) } : {}) });
  } catch (e) {
    return [error("agent-sandbox-posture", "sandbox", `Agent sandbox policy invalid: ${e.message}`, {
      details: { error: e.message },
      remediation: "Fix CPB_AGENT_SANDBOX_* environment variables.",
    })];
  }

  const details = {
    mode: policy.mode,
    enabled: policy.enabled,
    provider: policy.provider,
    network: policy.network,
    subprocess: policy.subprocess,
    reason: policy.reason || null,
  };

  if (policy.enabled && (policy.mode === "required" || policy.mode === "strict")) {
    return [ok("agent-sandbox-posture", "sandbox", `Agent sandbox ${policy.mode} via ${policy.provider}`, { details })];
  }

  if (policy.mode === "required" || policy.mode === "strict") {
    return [error("agent-sandbox-posture", "sandbox", `Agent sandbox ${policy.mode} is not enforceable`, {
      details,
      remediation: policy.reason || "Install a supported sandbox provider or configure CPB_AGENT_SANDBOX_COMMAND.",
    })];
  }

  if (policy.enabled) {
    return [warn("agent-sandbox-posture", "sandbox", `Agent sandbox ${policy.mode} via ${policy.provider} is not fail-closed`, {
      details,
      remediation: "Use CPB_AGENT_SANDBOX=required or CPB_AGENT_SANDBOX=strict for fail-closed enforcement.",
    })];
  }

  return [warn("agent-sandbox-posture", "sandbox", "Agent process sandbox is off", {
    details,
    remediation: "Set CPB_AGENT_SANDBOX=required or CPB_AGENT_SANDBOX=strict, and configure CPB_AGENT_SANDBOX_COMMAND if no built-in provider fits this host.",
  })];
}

export async function runAgentSandboxSelfTestCheck({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  probe,
  timeout = SUBPROCESS_TIMEOUT_MS,
}: { env?: ReadinessEnv; cwd?: string; platform?: NodeJS.Platform; probe?: unknown; timeout?: number } = {}) {
  if (!["1", "true", "yes"].includes(String(env.CPB_AGENT_SANDBOX_SELF_TEST || "").toLowerCase())) {
    return skipped("agent-sandbox-self-test", "sandbox", "Agent sandbox live self-test not requested", {
      details: { reason: "set CPB_AGENT_SANDBOX_SELF_TEST=1 to run" },
      remediation: "Run with CPB_AGENT_SANDBOX_SELF_TEST=1 after configuring CPB_AGENT_SANDBOX=required or strict.",
    });
  }

  let policy;
  try {
    policy = resolveAgentSandboxPolicy(env, { cwd, platform, ...(sandboxProbe(probe) ? { probe: sandboxProbe(probe) } : {}) });
  } catch (e) {
    return error("agent-sandbox-self-test", "sandbox", `Agent sandbox live self-test cannot resolve policy: ${e.message}`, {
      details: { error: e.message },
      remediation: "Fix CPB_AGENT_SANDBOX_* environment variables.",
    });
  }

  if (!policy.enabled) {
    const failClosedRequested = policy.mode === "required" || policy.mode === "strict";
    const make = failClosedRequested ? error : warn;
    const message = failClosedRequested
      ? "Agent sandbox live self-test unavailable because sandbox is not enforceable"
      : "Agent sandbox live self-test skipped because sandbox is not enabled";
    return make("agent-sandbox-self-test", "sandbox", message, {
      details: {
        mode: policy.mode,
        reason: policy.reason || null,
      },
      remediation: "Set CPB_AGENT_SANDBOX=required or strict and ensure a supported provider is available.",
    });
  }

  let launch;
  try {
    launch = buildAgentSandboxLaunch(
      process.execPath,
      ["-e", "process.stdout.write('cpb-agent-sandbox-self-test')"],
      { env, cwd, platform, ...(sandboxProbe(probe) ? { probe: sandboxProbe(probe) } : {}) },
    );
  } catch (e) {
    return error("agent-sandbox-self-test", "sandbox", `Agent sandbox live self-test could not launch: ${e.message}`, {
      details: {
        mode: policy.mode,
        provider: policy.provider,
        error: e.message,
      },
      remediation: "Install/configure a sandbox provider or use CPB_AGENT_SANDBOX_COMMAND.",
    });
  }

  try {
    const result = await execFileAsync(launch.command, launch.args, {
      cwd,
      env,
      timeout,
    });
    const stdout = String(result.stdout || "");
    if (!stdout.includes("cpb-agent-sandbox-self-test")) {
      return error("agent-sandbox-self-test", "sandbox", "Agent sandbox live self-test produced unexpected output", {
        details: {
          mode: launch.sandbox.mode,
          provider: launch.sandbox.provider,
          stdout,
        },
        remediation: "Inspect the configured sandbox wrapper and provider command execution path.",
      });
    }
    return ok("agent-sandbox-self-test", "sandbox", `Agent sandbox live self-test passed via ${launch.sandbox.provider}`, {
      details: {
        mode: launch.sandbox.mode,
        provider: launch.sandbox.provider,
        command: launch.command,
        exitCode: 0,
      },
    });
  } catch (e) {
    return error("agent-sandbox-self-test", "sandbox", `Agent sandbox live self-test failed: ${e.message}`, {
      details: {
        mode: launch.sandbox?.mode || policy.mode,
        provider: launch.sandbox?.provider || policy.provider,
        command: launch.command,
        exitCode: e.code ?? null,
        signal: e.signal ?? null,
        stderr: e.stderr ? String(e.stderr) : undefined,
      },
      remediation: "Run cpb doctor with the same CPB_AGENT_SANDBOX_* env and inspect the sandbox provider/wrapper logs.",
    });
  }
}

// --- Orchestrator ---

async function checkServerDeps(cpbRoot: string) {
  const nmPath = path.join(path.resolve(cpbRoot), "server", "node_modules");
  try {
    await access(nmPath, fsConstants.R_OK);
    return ok("server-deps", "toolchain", "Server dependencies installed");
  } catch {
    return warn("server-deps", "toolchain", "Server dependencies not installed", {
      remediation: "Run: cd server && npm install",
    });
  }
}

async function checkGithubReadiness(hubRoot: string) {
  const checks = [];
  try {
    const { resolveGithubTransport } = await import("./github/github-api.js");
    const { loadGithubAppConfig, resolveGithubWebhookSecret } = await import("./github/github-api.js");
    const { listProjects } = await import("./hub/hub-registry.js");

    // App config
    let config = null;
    try {
      config = await loadGithubAppConfig(hubRoot);
      checks.push(ok("github-app-config", "github", `GitHub App ${config.appId} configured`));
      if (config.installationId) {
        checks.push(ok("github-app-installation", "github", `Installation ${config.installationId} configured`));
      } else {
        checks.push(warn("github-app-installation", "github", "GitHub App installation id missing"));
      }
      if (config.privateKeyRef) {
        checks.push(ok("github-app-private-key", "github", `Private key configured (${config.privateKeyRef.split(":")[0]}:*)`));
      } else {
        checks.push(warn("github-app-private-key", "github", "No private key — outbound transport will use gh CLI"));
      }
    } catch {
      checks.push(error("github-app-config", "github", "GitHub App config missing or invalid"));
    }

    // Webhook secret
    if (config?.webhookSecretRef) {
      try {
        resolveGithubWebhookSecret(config);
        checks.push(ok("github-webhook-secret", "github", "Webhook secret available"));
      } catch {
        checks.push(error("github-webhook-secret", "github", "GitHub webhook secret unavailable"));
      }
    } else {
      checks.push(warn("github-webhook-secret", "github", "No webhook secret configured"));
    }

    // Transport
    try {
      const transport = await resolveGithubTransport(hubRoot);
      if (transport.mode === "api") {
        checks.push(ok("github-transport", "github", "Transport: api"));
      } else if (transport.mode === "gh") {
        const reason = readinessArray(transport.diagnostics).find((d) => d.level === "info")?.message || "gh CLI fallback";
        checks.push(warn("github-transport", "github", `Transport: gh (${reason})`));
      } else {
        checks.push(error("github-transport", "github", "GitHub outbound transport unavailable"));
      }
    } catch (e) {
      checks.push(error("github-transport", "github", `GitHub transport check failed: ${e.message}`));
    }

    // Repo bindings
    try {
      const projects = await listProjects(hubRoot, { enabledOnly: true });
      const bound = projects.filter((p) => p.github?.fullName);
      if (bound.length > 0) {
        checks.push(ok("github-repo-bindings", "github", `${bound.length} repo(s) bound`));
      } else {
        checks.push(warn("github-repo-bindings", "github", "No repos bound to GitHub"));
      }
    } catch {
      checks.push(warn("github-repo-bindings", "github", "Could not check repo bindings"));
    }
  } catch (e) {
    checks.push(error("github-readiness", "github", `GitHub readiness check failed: ${e.message}`));
  }
  return checks;
}

export async function runReadinessChecks({ cpbRoot, hubRoot, adapterOverrides, env = process.env }: ReadinessRecord & { env?: ReadinessEnv } = {}) {
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const resolvedHubRoot = path.resolve(hubRoot || resolveHubRoot(resolvedCpbRoot));
  let setup = null;
  let setupChecks: Check[] = [];
  try {
    setup = await detectSetupEnvironment();
    setupChecks = buildSetupReadinessChecks(setup, listSetupAgents().map(readinessRecord));
  } catch (e) {
    setup = { schemaVersion: 1, error: e.message };
    setupChecks = [warn("setup-readiness", "setup", `Setup readiness unavailable: ${e.message}`)];
  }

  // Resolve adapter checks from registry
  let adapterChecks: Promise<Check>[] = [];
  try {
    await (agentRegistry.loadRegistry as () => Promise<void>)();
    const agents = agentRegistry.listAgents();
    for (const d of agents) {
      const override = adapterOverrides?.[d.name];
      const command = override?.command || d.command;
      const args = override?.args || (d.args?.length ? d.args : ["--help"]);
      const npxPkg = d.fallbackCommand === "npx" && d.fallbackArgs?.length
        ? d.fallbackArgs.find((a: string) => !a.startsWith("-"))
        : undefined;
      adapterChecks.push(
        checkAcpAdapter(d.name, command, args, {
          npxPkg,
          stability: d.stability,
        }),
      );
    }
  } catch {
    // Registry unavailable, fall back to hardcoded ACP adapters
    const codexAdapter = adapterOverrides?.codex || { command: "codex-acp", args: ["--help"] };
    const claudeAdapter = adapterOverrides?.claude || { command: "claude-agent-acp", args: ["--help"] };
    const reasonixAdapter = adapterOverrides?.reasonix || { command: "reasonix", args: ["acp"] };
    adapterChecks = [
      checkAcpAdapter("codex", codexAdapter.command, codexAdapter.args, { npxPkg: "@zed-industries/codex-acp" }),
      checkAcpAdapter("claude", claudeAdapter.command, claudeAdapter.args, { npxPkg: "@agentclientprotocol/claude-agent-acp" }),
      checkAcpAdapter("reasonix", reasonixAdapter.command, reasonixAdapter.args, { stability: "discovered" }),
    ];
  }

  const sandboxChecks = buildAgentSandboxReadinessChecks({ env, cwd: resolvedCpbRoot });

  const [githubChecks, sandboxSelfTestCheck, ...results] = await Promise.all([
    checkGithubReadiness(resolvedHubRoot),
    runAgentSandboxSelfTestCheck({ env, cwd: resolvedCpbRoot }),
    checkNode(),
    checkNpm(),
    checkGit(),
    checkServerDeps(resolvedCpbRoot),
    checkDiskSpace(resolvedCpbRoot, "project"),
    checkDiskSpace(resolvedHubRoot, "hub"),
    ...adapterChecks,
    checkHubLiveness(resolvedHubRoot),
    checkHubWritability(resolvedHubRoot),
    checkHubAuthentication(resolvedHubRoot, env),
    checkHubBackupSigning(env),
    checkHubStateBackend(resolvedHubRoot, env),
    checkHubAccessAudit(resolvedHubRoot, env),
    checkRegistryConsistency(resolvedHubRoot),
    checkStaleJobs(resolvedCpbRoot),
    checkStaleWorkers(resolvedHubRoot),
    checkOrphanLeases(resolvedCpbRoot),
    checkProviderBackoff(resolvedHubRoot),
    checkHubProjectPollution(resolvedHubRoot),
  ]);

  const checks = [...results, ...sandboxChecks, sandboxSelfTestCheck, ...setupChecks, ...githubChecks];
  const summary = deriveSummary(checks);

  // Collect per-project runtime roots
  let projectRuntimeRoots: ReadinessRecord = {};
  try {
      const registry = await loadRegistry(resolvedHubRoot);
      for (const project of Object.values(registry.projects).map(readinessRecord)) {
      if (project.projectRuntimeRoot) {
        projectRuntimeRoots[project.id] = project.projectRuntimeRoot;
      }
    }
  } catch {}

  return {
    command: "cpb doctor",
    generatedAt: new Date().toISOString(),
    roots: {
      executorRoot: resolvedCpbRoot,
      hubRoot: resolvedHubRoot,
      projectRuntimeRoots,
    },
    setup,
    summary,
    checks,
  };
}

// --- Release doctor checks ---

function okR(id: string, message: string, opts: ReadinessRecord = {}) {
  return { id, status: "ok", message, ...opts };
}

function warnR(id: string, message: string, { guidance, ...rest }: ReadinessRecord = {}) {
  return { id, status: "warn", message, guidance, ...rest };
}

function failR(id: string, message: string, { guidance, ...rest }: ReadinessRecord = {}) {
  return { id, status: "fail", message, guidance, ...rest };
}

async function checkReleaseCurrentMetadata({ env }: { env: ReadinessEnv }) {
  const selection = await inspectCurrentRelease({ env });
  if (!selection) {
    return warnR("release.current_metadata", "No release selected", {
      guidance: "Run: cpb release use <release-id> to select a release.",
    });
  }
  if (!selection.metadata) {
    return warnR("release.current_metadata", `Release '${selection.selector?.releaseId || "unknown"}' selected but metadata is unreadable`, {
      guidance: "Release directory may be corrupt. Reinstall with: cpb release install",
    });
  }
  const m = selection.metadata;
  const missing = [];
  if (!m.releaseId) missing.push("releaseId");
  if (!m.installedPath) missing.push("installedPath");
  if (!m.codeVersion) missing.push("codeVersion");
  if (!m.stateFormatVersions) missing.push("stateFormatVersions");
  if (missing.length > 0) {
    return warnR("release.current_metadata", `Current release metadata missing fields: ${missing.join(", ")}`, {
      guidance: "Release manifest may be incomplete. Reinstall with: cpb release install",
      details: { releaseId: m.releaseId, missing },
    });
  }

  const storeRoot = resolveReleaseStoreRoot({ env });
  const resolvedInstalled = path.resolve(m.installedPath);
  if (!resolvedInstalled.startsWith(storeRoot + path.sep) && resolvedInstalled !== storeRoot) {
    return failR("release.current_metadata", `Current release '${m.releaseId}' is outside the managed release root`, {
      guidance: "Use releases installed under the managed root. Reinstall with: cpb release install",
      details: { installedPath: m.installedPath, releaseStoreRoot: storeRoot },
    });
  }

  return okR("release.current_metadata", `Current release: ${m.releaseId} v${m.codeVersion}`, {
    details: { releaseId: m.releaseId, codeVersion: m.codeVersion },
  });
}

async function checkReleaseExecutorRoot({ env }: { env: ReadinessEnv }) {
  const executorRoot = env.CPB_EXECUTOR_ROOT ? path.resolve(env.CPB_EXECUTOR_ROOT) : null;
  if (!executorRoot) {
    return warnR("release.executor_root", "CPB_EXECUTOR_ROOT not set", {
      guidance: "Set CPB_EXECUTOR_ROOT or run from the CPB install directory.",
    });
  }
  let meta;
  try {
    meta = await executorMetadata(executorRoot);
  } catch (err) {
    return failR("release.executor_root", `Executor root invalid: ${err.message}`, {
      guidance: "Ensure CPB_EXECUTOR_ROOT points to a valid CPB installation with required files.",
    });
  }
  const selection = await inspectCurrentRelease({ env });
  if (selection?.metadata?.releaseId && meta.releaseId) {
    if (selection.metadata.releaseId !== meta.releaseId) {
      return warnR("release.executor_root", `Executor root release '${meta.releaseId}' differs from selected release '${selection.metadata.releaseId}'`, {
        guidance: "Run: cpb release use <release-id> to align, or restart with the correct CPB_EXECUTOR_ROOT.",
        details: { executorReleaseId: meta.releaseId, selectedReleaseId: selection.metadata.releaseId },
      });
    }
  }
  return okR("release.executor_root", `Executor root: ${executorRoot} (release: ${meta.releaseId || "dev"})`);
}

async function checkReleaseRuntimeRoot({ env }: { env: ReadinessEnv }) {
  const executorRoot = env.CPB_EXECUTOR_ROOT ? path.resolve(env.CPB_EXECUTOR_ROOT) : null;
  if (!executorRoot) {
    return warnR("release.runtime_root", "Cannot check runtime root without CPB_EXECUTOR_ROOT", {
      guidance: "Set CPB_EXECUTOR_ROOT or run from the CPB install directory.",
    });
  }
  try {
    const { runtimeDataRoot } = await import("./runtime.js");
    const rtRoot = runtimeDataRoot(executorRoot);
    await readdir(rtRoot);
    return okR("release.runtime_root", `Runtime root readable: ${rtRoot}`);
  } catch {
    return warnR("release.runtime_root", "Runtime root not yet initialized", {
      guidance: "Runtime data will be created on first use. No action needed if this is a fresh install.",
    });
  }
}

async function checkReleaseStateFormat({ env }: { env: ReadinessEnv }) {
  const selection = await inspectCurrentRelease({ env });
  if (!selection?.metadata?.stateFormatVersions) {
    return warnR("release.state_format", "No release selected or metadata missing stateFormatVersions", {
      guidance: "Select a release with: cpb release use <release-id>",
    });
  }
  const supported = await supportedStateFormatVersions();
  const mismatches = [];
  for (const [key, version] of Object.entries(selection.metadata.stateFormatVersions)) {
    if (!supported[key]?.includes(version)) {
      mismatches.push({ key, version, supported: supported[key] || [] });
    }
  }
  if (mismatches.length > 0) {
    return failR("release.state_format", `State format mismatch: ${mismatches.map(m => `${m.key}=${m.version}`).join(", ")}`, {
      guidance: "Upgrade the release or migrate runtime data to match the current state format.",
      details: mismatches,
    });
  }
  return okR("release.state_format", "State format versions compatible");
}

async function checkReleaseLauncherHealth({ env }: { env: ReadinessEnv }) {
  const cpbHome = env.CPB_HOME || path.join(env.HOME || "/tmp", ".cpb");
  const binLink = path.join(cpbHome, "bin", "cpb");
  let target;
  try {
    const { realpath } = await import("node:fs/promises");
    target = await realpath(binLink);
  } catch {
    return warnR("release.launcher_health", "No launcher binary found", {
      guidance: "Install launcher with: cpb install-bin",
    });
  }
  const selection = await inspectCurrentRelease({ env });
  if (selection?.metadata?.installedPath && target) {
    const releaseDir = path.resolve(selection.metadata.installedPath);
    if (!target.startsWith(releaseDir + path.sep) && target !== path.join(releaseDir, "cpb")) {
      return warnR("release.launcher_health", `Launcher points to '${target}', outside current release '${selection.metadata.releaseId}'`, {
        guidance: "Reinstall launcher for current release: cpb install-bin",
        details: { launcherTarget: target, currentReleasePath: releaseDir },
      });
    }
  }
  return okR("release.launcher_health", `Launcher resolves to: ${target}`);
}

async function checkReleaseJobPinning({ env, cpbRoot }: { env: ReadinessEnv; cpbRoot?: string }) {
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const selection = await inspectCurrentRelease({ env });
  const currentReleaseId = selection?.metadata?.releaseId || null;
  if (!currentReleaseId) {
    return okR("release.job_pinning", "No current release selected, skipping pin check");
  }
  try {
    const allJobs = await listJobs(resolvedCpbRoot);
    const issues = [];
    for (const job of allJobs) {
      const jobReleaseId = job.executor?.releaseId
        || job.lineage?.executorSelection?.selectedReleaseId
        || job.lineage?.executorSelection?.parentReleaseId
        || null;
      if (!jobReleaseId) continue;
      if (jobReleaseId !== currentReleaseId) {
        const terminal = ["completed", "failed", "blocked", "cancelled"].includes(job.status);
        issues.push({
          jobId: job.jobId,
          status: job.status,
          jobReleaseId,
          currentReleaseId,
          severity: terminal ? "info" : "warn",
        });
      }
    }
    if (issues.length === 0) {
      return okR("release.job_pinning", "All jobs reference the current release");
    }
    const active = issues.filter(i => i.severity === "warn");
    if (active.length > 0) {
      return warnR("release.job_pinning", `${active.length} active job(s) pinned to a different release`, {
        guidance: "Active jobs may depend on the old release. Wait for them to complete or recover with: cpb retry --use-current-executor",
        details: active,
      });
    }
    return okR("release.job_pinning", `${issues.length} completed job(s) used older releases (no action needed)`, {
      details: issues,
    });
  } catch (err) {
    return warnR("release.job_pinning", `Cannot check job pinning: ${err.message}`);
  }
}

export async function runReleaseDoctorChecks({ cpbRoot, env = process.env }: ReadinessRecord & { env?: ReadinessEnv } = {}) {
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const checks = await Promise.all([
    checkReleaseCurrentMetadata({ env }),
    checkReleaseExecutorRoot({ env }),
    checkReleaseRuntimeRoot({ env }),
    checkReleaseStateFormat({ env }),
    checkReleaseLauncherHealth({ env }),
    checkReleaseJobPinning({ env, cpbRoot: resolvedCpbRoot }),
  ]);

  const summary = { ok: 0, warn: 0, fail: 0, success: false };
  for (const check of checks) {
    if (check.status === "ok") summary.ok = (summary.ok || 0) + 1;
    if (check.status === "warn") summary.warn = (summary.warn || 0) + 1;
    if (check.status === "fail") summary.fail = (summary.fail || 0) + 1;
  }
  summary.success = summary.fail === 0;

  return {
    command: "cpb release doctor",
    generatedAt: new Date().toISOString(),
    summary,
    checks,
  };
}

export function formatReleaseDoctorHuman(result: ReadinessRecord & { summary: ReadinessRecord; checks: Check[] }) {
  const { summary, checks } = result;
  const lines = [];
  lines.push(`${BOLD}Release Doctor${NC}`);
  lines.push("");
  for (const check of checks) {
    const color = STATUS_COLOR[check.status === "fail" ? "error" : check.status === "warn" ? "warn" : "ok"];
    const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗";
    let line = `  ${color}${icon}${NC} ${check.id}: ${check.message}`;
    if (check.guidance) line += ` ${color}→ ${check.guidance}${NC}`;
    lines.push(line);
  }
  lines.push("");
  if (summary.success) {
    if (summary.warn > 0) {
      lines.push(`  ${STATUS_COLOR.warn}${summary.warn} warning(s)${NC}, ${summary.ok} passed.`);
    } else {
      lines.push(`  ${STATUS_COLOR.ok}All release checks passed.${NC}`);
    }
  } else {
    lines.push(`  ${STATUS_COLOR.error}${summary.fail} failure(s)${NC}, ${summary.warn} warning(s), ${summary.ok} passed.`);
  }
  return lines.join("\n");
}

export function formatReleaseDoctorJson(result: ReadinessRecord & { summary: ReadinessRecord; checks: Check[] }) {
  return JSON.stringify(result, null, 2);
}

// --- Output formatters ---

const CATEGORY_ORDER = ["toolchain", "disk", "setup", "sandbox", "acp", "hub", "registry", "jobs", "workers", "leases", "provider"];
const CATEGORY_LABELS = {
  toolchain: "Toolchain",
  disk: "Disk",
  setup: "Setup",
  sandbox: "Agent Sandbox",
  acp: "ACP Adapters",
  hub: "Hub",
  registry: "Registry",
  jobs: "Jobs",
  workers: "Workers",
  leases: "Leases",
  provider: "Provider",
};

const STATUS_ICON = { ok: "✓", warn: "!", error: "✗", skipped: "-" };
const STATUS_COLOR = {
  ok: "\x1b[0;32m",
  warn: "\x1b[1;33m",
  error: "\x1b[0;31m",
  skipped: "\x1b[0;36m",
};
const NC = "\x1b[0m";
const BOLD = "\x1b[1m";

export function formatReadinessHuman(result: LooseRecord) {
  const redacted = redactSecrets(result) as LooseRecord;
  const summary = redacted.summary as Record<string, number> | undefined;
  const checks = (Array.isArray(redacted.checks) ? redacted.checks : []) as LooseRecord[];
  const lines = [];

  lines.push(`${BOLD}CodePatchbay Doctor${NC}`);

  const byCategory = new Map();
  for (const check of checks) {
    if (!byCategory.has(check.category)) byCategory.set(check.category, []);
    byCategory.get(check.category).push(check);
  }

  for (const cat of CATEGORY_ORDER) {
    const catChecks = byCategory.get(cat);
    if (!catChecks) continue;
    lines.push("");
    lines.push(`  ${BOLD}${CATEGORY_LABELS[cat] || cat}:${NC}`);
    for (const check of catChecks) {
      const color = STATUS_COLOR[check.status];
      const icon = STATUS_ICON[check.status];
      let line = `    ${color}${icon}${NC} ${check.message}`;
      if (check.remediation) line += ` ${color}→ ${check.remediation}${NC}`;
      lines.push(line);
    }
  }

  lines.push("");
  if (summary.success) {
    if (summary.warn > 0) {
      lines.push(`  ${STATUS_COLOR.warn}${summary.warn} warning(s)${NC}, ${summary.ok} passed, ${summary.skipped} skipped.`);
    } else {
      lines.push(`  ${STATUS_COLOR.ok}All checks passed.${NC}`);
    }
  } else {
    lines.push(`  ${STATUS_COLOR.error}${summary.error} error(s)${NC}, ${summary.warn} warning(s), ${summary.ok} passed.`);
  }

  return lines.join("\n");
}

export function formatReadinessJson(result: LooseRecord) {
  const redacted = redactSecrets(result) as LooseRecord;
  const checks = (Array.isArray(redacted.checks) ? redacted.checks : []) as Check[];
  const normalized = {
    ...redacted,
    readiness: redacted.readiness ?? deriveReadinessLevels(checks),
    checks: checks.map((check: Check) => ({
      ...check,
      evidence: check.evidence ?? check.details ?? { message: check.message },
      recommendedAction: check.recommendedAction ?? check.remediation ?? null,
    })),
  };
  return JSON.stringify(normalized, null, 2);
}

// ── CodeGraph readiness (from codegraph-readiness.ts) ──────────────────────

export class CodeGraphUnavailableError extends Error {
  constructor(reason: string, details: ReadinessRecord = {}) {
    super(reason);
    this.name = "CodeGraphUnavailableError";
    (this as Error & { code?: string; details?: ReadinessRecord }).code = "codegraph_unavailable";
    (this as Error & { code?: string; details?: ReadinessRecord }).details = details;
  }
}

export type CodeGraphReadinessTestHooks = {
  boundedRead?: BoundedRegularFileReadHooks;
};

const codeGraphReadinessTestHookStorage = new AsyncLocalStorage<CodeGraphReadinessTestHooks>();

export function withCodeGraphReadinessTestHooksForTests<T>(
  hooks: CodeGraphReadinessTestHooks,
  operation: () => T,
): T {
  const parent = codeGraphReadinessTestHookStorage.getStore();
  return codeGraphReadinessTestHookStorage.run(parent ? { ...parent, ...hooks } : hooks, operation);
}

function codeGraphReadinessTestHooks() {
  return codeGraphReadinessTestHookStorage.getStore() || {};
}

const CODEGRAPH_STATE_MAX_BYTES = 64 * 1024;

function processIdentityFromRecord(value: unknown, expectedPid?: number): ProcessIdentity | null {
  const candidate = recordValue(value);
  const pid = Number(candidate.pid);
  const capturedAt = typeof candidate.capturedAt === "string" ? candidate.capturedAt : "";
  const processGroupId = Number(candidate.processGroupId);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || (expectedPid !== undefined && pid !== expectedPid)
    || typeof candidate.birthId !== "string"
    || candidate.birthId.length === 0
    || candidate.incarnation !== `${pid}:${candidate.birthId}`
    || !capturedAt
    || !Number.isFinite(Date.parse(capturedAt))
    || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
    || candidate.birthIdPrecision !== "exact"
    || (candidate.processGroupId !== undefined
      && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
  ) return null;
  return {
    pid,
    birthId: candidate.birthId,
    incarnation: candidate.incarnation,
    capturedAt,
    birthIdPrecision: "exact",
    ...(candidate.processGroupId === undefined ? {} : { processGroupId }),
  };
}

function verifyAliveIdentity(pid: number, identityValue: unknown) {
  const parsed = Number(pid);
  const identity = processIdentityFromRecord(identityValue, parsed);
  if (!Number.isInteger(parsed) || parsed <= 0 || !identity) {
    return { alive: false, reason: "missing_process_identity" };
  }
  try {
    process.kill(parsed, 0);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "ESRCH") return { alive: false, reason: "dead_process" };
    return {
      alive: false,
      reason: "process_liveness_unverified",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let current: ProcessIdentity | null;
  try {
    current = captureProcessIdentity(parsed, { strict: true });
  } catch (error) {
    return {
      alive: false,
      reason: "process_identity_unverified",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!current || !sameProcessIdentity(identity, current)) {
    return { alive: false, reason: "process_identity_mismatch" };
  }
  return { alive: true, reason: "alive" };
}

function stateReadErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

async function readCodeGraphStateOwner(file: string, stateKind: "runtime_state" | "daemon_owner") {
  const statePath = path.resolve(file);
  let raw: string;
  try {
    raw = await readBoundedRegularFileNoFollow(statePath, {
      maxBytes: CODEGRAPH_STATE_MAX_BYTES,
      hooks: codeGraphReadinessTestHooks().boundedRead,
    });
  } catch (error) {
    const errorCode = stateReadErrorCode(error);
    if (errorCode === "ENOENT") return null;
    throw new CodeGraphUnavailableError("CodeGraph readiness state cannot be read safely", {
      reason: "unsafe_codegraph_state",
      stateKind,
      statePath,
      errorCode: errorCode || "CODEGRAPH_STATE_READ_FAILED",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CodeGraphUnavailableError("CodeGraph readiness state contains malformed JSON", {
      reason: "malformed_codegraph_state",
      stateKind,
      statePath,
      errorCode: "CODEGRAPH_STATE_MALFORMED",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CodeGraphUnavailableError("CodeGraph readiness state must be a JSON object", {
      reason: "malformed_codegraph_state",
      stateKind,
      statePath,
      errorCode: "CODEGRAPH_STATE_MALFORMED",
      error: "state root is not a JSON object",
    });
  }

  const state = recordValue(parsed);
  if (
    state.statePath !== undefined
    && (
      typeof state.statePath !== "string"
      || !path.isAbsolute(state.statePath)
      || path.resolve(state.statePath) !== statePath
    )
  ) {
    throw new CodeGraphUnavailableError("CodeGraph readiness state is bound to a different owner path", {
      reason: "codegraph_state_path_mismatch",
      stateKind,
      statePath,
      declaredStatePath: typeof state.statePath === "string" ? state.statePath : null,
    });
  }
  return { ...state, statePath };
}

async function canonicalDir(value: string) {
  if (!value || typeof value !== "string") return null;
  try {
    return await realpath(path.resolve(value));
  } catch {
    return null;
  }
}

async function firstUsableIndexFile(codebaseRoot: string) {
  const candidates = [
    path.join(codebaseRoot, ".codegraph", "codegraph.db"),
    path.join(codebaseRoot, ".codegraph", "index.sqlite"),
  ];
  for (const file of candidates) {
    try {
      const info = await statFs(file);
      if (info.isFile() && info.size >= MIN_CODEGRAPH_DB_BYTES) return file;
    } catch {
      // Try the next known CodeGraph index filename.
    }
  }
  return null;
}

const MIN_CODEGRAPH_DB_BYTES = 1024;

async function readDaemonState(sourceRoot: string) {
  const daemonPidFile = path.join(sourceRoot, ".codegraph", "daemon.pid");
  const state = await readCodeGraphStateOwner(daemonPidFile, "daemon_owner");
  if (!state) return null;
  const owner = state as Record<string, unknown>;
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new CodeGraphUnavailableError("CodeGraph daemon owner has an invalid pid", {
      reason: "invalid_codegraph_state",
      stateKind: "daemon_owner",
      statePath: daemonPidFile,
      error: "pid must be a positive safe integer",
    });
  }
  const codebaseRoot = owner.codebaseRoot === undefined ? sourceRoot : owner.codebaseRoot;
  if (typeof codebaseRoot !== "string" || codebaseRoot.trim().length === 0) {
    throw new CodeGraphUnavailableError("CodeGraph daemon owner has an invalid codebase root", {
      reason: "invalid_codegraph_state",
      stateKind: "daemon_owner",
      statePath: daemonPidFile,
      error: "codebaseRoot must be a non-empty string when present",
    });
  }
  return {
    pid: owner.pid,
    codebaseRoot,
    socketPath: owner.socketPath || null,
    processIdentity: owner.processIdentity ?? owner.ownerIdentity ?? null,
    source: owner.source || "codegraph_daemon",
    statePath: daemonPidFile,
  };
}

export async function checkCodeGraphReady({ cpbRoot, sourcePath }: ReadinessRecord = {}) {
  const sourceRoot = await canonicalDir(sourcePath);
  if (!sourceRoot) {
    throw new CodeGraphUnavailableError("sourcePath is required for CodeGraph readiness", {
      reason: "missing_source_path",
      sourcePath: sourcePath || null,
    });
  }

  const statePath = path.join(path.resolve(cpbRoot || sourceRoot), "cpb-task", "codegraph-state.json");
  const stateFile = await readCodeGraphStateOwner(statePath, "runtime_state");
  const daemonState = await readDaemonState(sourceRoot);
  const indexOnlyOk = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK === "1";

  const indexFile = await firstUsableIndexFile(sourceRoot);
  if (!indexFile) {
    throw new CodeGraphUnavailableError("CodeGraph index is unavailable", {
      reason: "missing_codegraph_index",
      sourcePath: sourceRoot,
    });
  }

  if (indexOnlyOk && !daemonState) {
    return {
      available: true,
      sourcePath: sourceRoot,
      indexFile,
      state: {
        source: "index_only",
        codebaseRoot: sourceRoot,
        pid: null,
        socketPath: null,
      },
    };
  }

  if (!daemonState) {
    if (stateFile) {
      throw new CodeGraphUnavailableError("CodeGraph runtime state has no canonical daemon owner", {
        reason: "unbound_codegraph_state",
        sourcePath: sourceRoot,
        indexFile,
        statePath,
        daemonStatePath: path.join(sourceRoot, ".codegraph", "daemon.pid"),
      });
    }
    throw new CodeGraphUnavailableError("CodeGraph readiness state is unavailable", {
      reason: "missing_codegraph_state",
      sourcePath: sourceRoot,
      indexFile,
    });
  }
  const state = daemonState;
  if (!Number.isSafeInteger(state.pid) || state.pid <= 0) {
    throw new CodeGraphUnavailableError("CodeGraph readiness state has an invalid pid", {
      reason: "invalid_codegraph_state",
      sourcePath: sourceRoot,
      indexFile,
      statePath: state.statePath,
    });
  }
  const stateRoot = await canonicalDir(state.codebaseRoot);
  if (!stateRoot || stateRoot !== sourceRoot) {
    throw new CodeGraphUnavailableError("CodeGraph state does not match sourcePath", {
      reason: "codegraph_root_mismatch",
      stateRoot,
      sourcePath: sourceRoot,
      statePath: state.statePath,
    });
  }
  const stateLiveness = verifyAliveIdentity(state.pid, state.processIdentity);
  if (!stateLiveness.alive) {
    throw new CodeGraphUnavailableError("CodeGraph process is not running", {
      reason: stateLiveness.reason || "dead_codegraph_process",
      pid: state.pid,
      sourcePath: sourceRoot,
      statePath: state.statePath,
      detail: "detail" in stateLiveness ? stateLiveness.detail : undefined,
    });
  }

  return {
    available: true,
    sourcePath: sourceRoot,
    indexFile,
    state,
  };
}

// ── Demo runner (from demo-runner.ts) ──────────────────────────────────────

const INITIAL_SUM_SOURCE = "export function sum(a, b) {\n  return a - b;\n}\n";
const FIXED_SUM_SOURCE = "export function sum(a, b) {\n  return a + b;\n}\n";
const SUM_TEST_SOURCE = "import assert from 'node:assert/strict';\nimport { sum } from './sum.js';\n\nassert.equal(sum(2, 3), 5);\nassert.equal(sum(-1, 4), 3);\nconsole.log('ok - sum handles positive and negative integers');\n";
const STORY_ORDER = ["plan", "diff", "tests", "verdict", "risk"];
const DEMO_TEST_TIMEOUT_MS = Number(process.env.CPB_DEMO_TEST_TIMEOUT_MS || 30_000);

function nowSafe() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function bestEffortGitInit(sourcePath: string) {
  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: sourcePath, timeout: 10_000 });
    await execFileAsync("git", ["config", "user.email", "demo@example.invalid"], { cwd: sourcePath, timeout: 10_000 });
    await execFileAsync("git", ["config", "user.name", "CodePatchBay Demo"], { cwd: sourcePath, timeout: 10_000 });
    await execFileAsync("git", ["add", "."], { cwd: sourcePath, timeout: 10_000 });
    await execFileAsync("git", ["commit", "-m", "demo toy repo"], { cwd: sourcePath, timeout: 10_000 });
  } catch {
    // The demo remains useful without git; artifacts and event logs are the core contract.
  }
}

async function writeToyRepo(sourcePath: string) {
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({
      name: "codepatchbay-demo-toy-repo",
      private: true,
      type: "module",
      scripts: { test: "node src/sum.test.js" },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(sourcePath, "src", "sum.js"), INITIAL_SUM_SOURCE, "utf8");
  await writeFile(path.join(sourcePath, "src", "sum.test.js"), SUM_TEST_SOURCE, "utf8");
  await writeFile(path.join(sourcePath, "README.md"), "# CodePatchBay Demo Toy Repo\n", "utf8");
  await bestEffortGitInit(sourcePath);
}

function demoDiffPatch() {
  return `diff --git a/src/sum.js b/src/sum.js
index 6fbc235..e741ad8 100644
--- a/src/sum.js
+++ b/src/sum.js
@@ -1,3 +1,3 @@
 export function sum(a, b) {
-  return a - b;
+  return a + b;
 }
`;
}

async function captureToyDiff(sourcePath: string) {
  try {
    const result = await execFileAsync("git", ["diff", "--", "src/sum.js"], {
      cwd: sourcePath,
      timeout: 10_000,
    });
    if (result.stdout) {
      return result.stdout;
    }
  } catch {
    // Fall back to stable demo evidence if git is unavailable in the runtime.
  }
  return demoDiffPatch();
}

async function runToyTests(sourcePath: string) {
  const started = Date.now();
  const command = "node src/sum.test.js";
  try {
    const result = await execFileAsync(process.execPath, ["src/sum.test.js"], {
      cwd: sourcePath,
      timeout: DEMO_TEST_TIMEOUT_MS,
    });
    return {
      command,
      status: "pass",
      exitCode: 0,
      durationMs: Date.now() - started,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      command,
      status: "fail",
      exitCode: error.code ?? 1,
      durationMs: Date.now() - started,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
    };
  }
}

function formatTestReport(result: { command: string; status: string; exitCode: number; durationMs: number; stdout: string; stderr: string }) {
  const stdout = result.stdout.trim() || "(no stdout)";
  const stderr = result.stderr.trim() || "(no stderr)";
  return `# TESTS

Command: ${result.command}
Status: ${result.status}
Exit Code: ${result.exitCode}
Duration: ${result.durationMs}ms

## Stdout

${stdout}

## Stderr

${stderr}
`;
}

function makeRiskSummary(sourcePath: string) {
  return {
    level: "low",
    summary: "Demo-only temporary toy repo; no user project, network provider, or credentialed agent is touched.",
    factors: [
      "All files are created under a temporary demo directory.",
      "The patch is limited to src/sum.js in the toy repo.",
      "Validation uses the local Node.js runtime and has no package install step.",
      `Cleanup is removal of the temp root that contains ${sourcePath}.`,
    ],
  };
}

function formatRiskReport(risk: { level: string; summary: string; factors: string[] }) {
  return `# RISK

Level: ${risk.level}
Summary: ${risk.summary}

## Factors
${risk.factors.map((factor: string) => `- ${factor}`).join("\n")}
`;
}

function storyEntries({ planPath, diffPath, testsPath, verdictPath, riskPath, testResult, risk }) {
  const summaries = {
    plan: "Planner defines a one-file toy fix and local acceptance checks.",
    diff: "Patch changes src/sum.js from subtraction to addition.",
    tests: `${testResult.command} completed with status ${testResult.status}.`,
    verdict: "Verifier verdict records passing evidence for the local demo.",
    risk: `${risk.level} risk: ${risk.summary}`,
  };
  const paths = {
    plan: planPath,
    diff: diffPath,
    tests: testsPath,
    verdict: verdictPath,
    risk: riskPath,
  };
  return STORY_ORDER.map((name) => ({
    name,
    label: name.toUpperCase(),
    summary: summaries[name],
    path: paths[name],
  }));
}

async function writeProjectForDemo(cpbRoot: string, project: string, sourcePath: string) {
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  await writeFile(
    path.join(wikiDir, "project.json"),
    `${JSON.stringify({
      id: project,
      name: project,
      sourcePath,
      policy: { useWorktree: false },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(wikiDir, "context.md"), `# ${project}\n\nLocal demo toy repo: ${sourcePath}\n`, "utf8");
  await writeFile(path.join(wikiDir, "decisions.md"), `# ${project} Decisions\n`, "utf8");
  return wikiDir;
}

function demoWorkspaceCleanupFailure(primary: unknown, cleanup: unknown, rootPath: string) {
  const recovery = temporaryWorkspaceErrorDetails(cleanup);
  return Object.assign(new AggregateError(
    [primary, cleanup],
    `local demo and temporary workspace cleanup both failed for ${rootPath}`,
    { cause: primary },
  ), {
    primaryError: primary,
    cleanupError: cleanup,
    ...(recovery ? {
      temporaryWorkspaceRecovery: recovery,
      recoveryPaths: recovery.recoveryPaths,
      successorPreserved: recovery.successorPreserved,
    } : {}),
  });
}

function demoFailureWithCleanupProof(
  primary: unknown,
  cleanup: TemporaryWorkspaceCleanupProof,
  rootPath: string,
) {
  return Object.assign(new AggregateError(
    [primary],
    `local demo failed; temporary workspace was retained at ${cleanup.recoveryPaths.quarantineRoot || rootPath}`,
    { cause: primary },
  ), {
    primaryError: primary,
    temporaryWorkspaceRecovery: cleanup,
    recoveryPaths: cleanup.recoveryPaths,
    successorPreserved: cleanup.successorPreserved,
  });
}

export async function runWithDemoTemporaryWorkspace<T>(
  task: (rootPath: string) => Promise<T>,
  createWorkspace: (options: { prefix: string }) => Promise<TemporaryWorkspace> = createTemporaryWorkspace,
): Promise<{
  value: T;
  canonicalRoot: string;
  cleanup: TemporaryWorkspaceCleanupProof;
}> {
  const workspace = await createWorkspace({ prefix: "cpb-demo-" });
  let value!: T;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    value = await task(workspace.rootPath);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  let cleanup: TemporaryWorkspaceCleanupProof | null = null;
  let cleanupError: unknown;
  let hasCleanupError = false;
  try {
    cleanup = await workspace.cleanup();
  } catch (error) {
    cleanupError = error;
    hasCleanupError = true;
  }

  if (hasPrimaryError && hasCleanupError) {
    throw demoWorkspaceCleanupFailure(primaryError, cleanupError, workspace.rootPath);
  }
  if (hasPrimaryError && cleanup) {
    throw demoFailureWithCleanupProof(primaryError, cleanup, workspace.rootPath);
  }
  if (hasPrimaryError) throw primaryError;
  if (hasCleanupError) throw cleanupError;
  if (!cleanup) throw new Error(`local demo temporary workspace cleanup produced no proof for ${workspace.rootPath}`);
  return { value, canonicalRoot: workspace.rootPath, cleanup };
}

function remapDemoWorkspacePaths<T>(value: T, canonicalRoot: string, retainedRoot: string): T {
  const seen = new WeakMap<object, unknown>();
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      const relative = path.relative(canonicalRoot, entry);
      if (relative === "") return retainedRoot;
      if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
        return path.join(retainedRoot, relative);
      }
      return entry;
    }
    if (!entry || typeof entry !== "object") return entry;
    const prior = seen.get(entry);
    if (prior) return prior;
    if (Array.isArray(entry)) {
      const output: unknown[] = [];
      seen.set(entry, output);
      for (const item of entry) output.push(visit(item));
      return output;
    }
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) return entry;
    const output: Record<string, unknown> = {};
    seen.set(entry, output);
    for (const [key, item] of Object.entries(entry)) output[key] = visit(item);
    return output;
  };
  return visit(value) as T;
}

async function runDemoInRoot(tempRoot: string, project: string, task: string) {
  const cpbRoot = path.join(tempRoot, "cpb-root");
  const sourcePath = path.join(tempRoot, "toy-repo");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(sourcePath, { recursive: true });
  await writeToyRepo(sourcePath);

  const wikiDir = await writeProjectForDemo(cpbRoot, project, sourcePath);
  const dataRoot = cpbRoot;
  const { buildArtifactIndex } = await import("./job/job-projection.js");
  const { appendEvent, eventFileFor } = await import("./event/event-store.js");
  const { completeJob, completePhase, createJob, getJob, startPhase } = await import("./job/job-store.js");
  const job = await createJob(cpbRoot, {
    project,
    task,
    workflow: "standard",
    dataRoot,
    sourceContext: { type: "demo", sourcePath },
  });

  const planPath = path.join(wikiDir, "inbox", "plan-001.md");
  const deliverablePath = path.join(wikiDir, "outputs", "deliverable-001.md");
  const diffPath = path.join(wikiDir, "outputs", "diff-001.patch");
  const testsPath = path.join(wikiDir, "outputs", "tests-001.txt");
  const verdictPath = path.join(wikiDir, "outputs", "verdict-001.md");
  const riskPath = path.join(wikiDir, "outputs", "risk-001.md");

  await startPhase(cpbRoot, project, job.jobId, { phase: "plan", attempt: 1, dataRoot });
  await writeFile(
    planPath,
    `# PLAN

Task: ${task}

## Change Strategy
- Fix the toy repo's \`sum(a, b)\` implementation so it adds both operands.
- Capture the exact patch as local diff evidence.
- Run the toy repo's Node.js test command and preserve the output.
- Produce a verifier verdict and risk assessment that explain the demo boundary.

## Acceptance Criteria
- Toy repo exists.
- Diff artifact shows the one-file source change.
- Test artifact shows the local command passed.
- Verdict status is pass.
- Risk is low because the demo only touches a temporary toy repo.
`,
    "utf8",
  );
  await completePhase(cpbRoot, project, job.jobId, { phase: "plan", artifact: "plan-001.md", dataRoot });

  await startPhase(cpbRoot, project, job.jobId, { phase: "execute", attempt: 1, dataRoot });
  await writeFile(path.join(sourcePath, "src", "sum.js"), FIXED_SUM_SOURCE, "utf8");
  await writeFile(diffPath, await captureToyDiff(sourcePath), "utf8");
  const testResult = await runToyTests(sourcePath);
  await writeFile(testsPath, formatTestReport(testResult), "utf8");
  await writeFile(
    deliverablePath,
    `# Demo Deliverable

Plan-Ref: 001

The local demo fixed the toy repo sum implementation and exercised the CodePatchBay job/artifact path without real provider credentials.

## Evidence
- Diff: ${diffPath}
- Tests: ${testsPath}
`,
    "utf8",
  );
  await appendEvent(cpbRoot, project, job.jobId, {
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "execute",
    kind: "diff",
    artifact: "diff-001.patch",
    ts: new Date().toISOString(),
  }, { dataRoot });
  await appendEvent(cpbRoot, project, job.jobId, {
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "execute",
    kind: "tests",
    artifact: "tests-001.txt",
    ts: new Date().toISOString(),
  }, { dataRoot });
  await completePhase(cpbRoot, project, job.jobId, { phase: "execute", artifact: "deliverable-001.md", dataRoot });

  await startPhase(cpbRoot, project, job.jobId, { phase: "verify", attempt: 1, dataRoot });
  const risk = makeRiskSummary(sourcePath);
  await writeFile(riskPath, formatRiskReport(risk), "utf8");
  await writeFile(
    verdictPath,
    `${JSON.stringify({
      status: testResult.status === "pass" ? "pass" : "fail",
      confidence: testResult.status === "pass" ? 1 : 0.4,
      layers: {
        fast: { status: testResult.status, detail: "Toy repo tests were executed locally." },
        changed: { status: "not_run", detail: "Demo does not mutate a user project." },
        regression: { status: "skipped", detail: "Demo is a mock pipeline smoke." },
        acceptance: { status: testResult.status, detail: "Plan, diff, tests, verdict, and risk artifacts were produced." },
      },
      blocking: testResult.status === "pass" ? [] : ["Toy repo tests failed."],
      diff_summary: "1 file changed, 1 insertion(+), 1 deletion(-)",
      task_goal: task,
      executor_summary: "Mock executor fixed src/sum.js and captured diff/test evidence.",
      reason: "CodePatchBay demo completed without provider credentials.",
      fix_scope: ["temporary toy repo src/sum.js"],
      test_summary: {
        command: testResult.command,
        status: testResult.status,
        exitCode: testResult.exitCode,
        report: testsPath,
      },
      risk,
      risk_story: risk.factors,
    }, null, 2)}\n`,
    "utf8",
  );
  await appendEvent(cpbRoot, project, job.jobId, {
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "verify",
    kind: "risk",
    artifact: "risk-001.md",
    ts: new Date().toISOString(),
  }, { dataRoot });
  await completePhase(cpbRoot, project, job.jobId, { phase: "verify", artifact: "verdict-001.md", dataRoot });
  const completedJob = await completeJob(cpbRoot, project, job.jobId, { dataRoot });

  const eventLog = eventFileFor(cpbRoot, project, job.jobId, { dataRoot });
  const artifactIndex = await buildArtifactIndex(cpbRoot, project, job.jobId, { dataRoot, wikiDir });
  const finalJob = completedJob || await getJob(cpbRoot, project, job.jobId, { dataRoot });

  return {
    ok: true,
    name: "codepatchbay-demo",
    project,
    task,
    tempRoot,
    cpbRoot,
    sourcePath,
    eventLog,
    job: finalJob,
    artifacts: {
      plan: { id: "plan-001", path: planPath },
      deliverable: { id: "deliverable-001", path: deliverablePath },
      diff: { id: "diff-001", path: diffPath },
      tests: { id: "tests-001", path: testsPath },
      verdict: { id: "verdict-001", path: verdictPath },
      risk: { id: "risk-001", path: riskPath },
    },
    story: storyEntries({ planPath, diffPath, testsPath, verdictPath, riskPath, testResult, risk }),
    artifactIndex,
  };
}

export async function runDemo({
  project = `demo-${nowSafe()}`,
  task = "Run the CodePatchBay local demo.",
} = {}) {
  const outcome = await runWithDemoTemporaryWorkspace(
    (tempRoot) => runDemoInRoot(tempRoot, project, task),
  );
  const retainedRoot = outcome.cleanup.recoveryPaths.quarantineRoot;
  if (!retainedRoot) {
    throw Object.assign(new Error("local demo cleanup proof did not identify its retained quarantine root"), {
      code: "TEMPORARY_WORKSPACE_RECOVERY_PATH_MISSING",
      temporaryWorkspaceRecovery: outcome.cleanup,
      recoveryPaths: outcome.cleanup.recoveryPaths,
    });
  }
  return {
    ...remapDemoWorkspacePaths(outcome.value, outcome.canonicalRoot, retainedRoot),
    workspaceCleanup: outcome.cleanup,
  };
}

// ── Audit export (from audit-export.ts) ────────────────────────────────────

function collectRuntimeFailureRefs(events: LooseRecord[], materialized?: ReadinessRecord) {
  // Prefer materialized state (event-replay source of truth)
  if (materialized?.runtimeFailures && Array.isArray(materialized.runtimeFailures) && materialized.runtimeFailures.length > 0) {
    return materialized.runtimeFailures;
  }
  // Fallback: scan event log for legacy event types (pre-runtime_failure_recorded jobs)
  return events
    .filter((event) => event.type === "runtime_failure_recorded" || event.type === "phase_poisoned_session" || event.type === "job_panic")
    .map((event) => ({
      type: event.failureType || event.type,
      attemptId: event.attemptId || null,
      phase: event.phase || null,
      nodeId: event.nodeId || null,
      reason: event.reason || (Array.isArray(event.reasons) ? event.reasons.join(", ") : null),
      ts: event.ts || null,
    }));
}

export async function buildJobAuditExport(cpbRoot: string, project: string, jobId: string, { dataRoot, wikiDir }: { dataRoot?: string; wikiDir?: string } = {}) {
  const { readEventsReadOnly, materializeJob } = await import("./event/event-store.js");
  const { buildArtifactIndex: buildArtifactIndexForAudit } = await import("./job/job-projection.js");
  const { redactSecrets: redactSecretsForAudit } = await import("./secret-policy.js");
  const { parseVerdictEnvelope } = await import("../../core/workflow/verdict.js");
  const { readActiveChecklistArtifacts, readChecklistArtifactHistory } = await import("../../core/workflow/checklist-artifacts.js");

  const events = await readEventsReadOnly(cpbRoot, project, jobId, { dataRoot });

  const artifactIndex = await buildArtifactIndexForAudit(cpbRoot, project, jobId, {
    events,
    dataRoot,
    wikiDir,
    restrictToWiki: true,
  });
  delete artifactIndex.generatedAt;
  artifactIndex.brokenReferences = artifactIndex.brokenReferences.map((e) => ({ ...e }));

  let verdict = null;
  const verdictEntry = [...artifactIndex.entries].reverse().find((e) => e.kind === "verdict" && !e.broken);
  if (verdictEntry) {
    try {
      const content = await readFile(verdictEntry.path, "utf8");
      verdict = parseVerdictEnvelope(content);
    } catch {
      verdict = null;
    }
  }

  let pr = null;
  const prEvent = [...events].reverse().find((e) => e.type === "pr_opened");
  if (prEvent) {
    pr = {
      url: prEvent.prUrl || prEvent.pullRequestUrl || prEvent.url || null,
      number: prEvent.prNumber || prEvent.number || null,
      artifact: prEvent.artifact || null,
      openedAt: prEvent.ts || null,
    };
  }

  const materialized = readinessRecord(materializeJob(events));

  const checklistArtifacts = await readActiveChecklistArtifacts({
    artifactIndex,
    attemptId: materialized.completionGate?.attemptId || jobId,
    requiredKinds: ["acceptance-checklist", "execution-map", "evidence-ledger", "checklist-verdict"],
  });

  const checklistArtifactHistory = await readChecklistArtifactHistory({
    artifactIndex,
  });

  return redactSecretsForAudit({
    schemaVersion: 1,
    project,
    jobId,
    eventLog: events,
    artifactIndex,
    verdict,
    pr,
    checklistArtifactHistory,
    checklist: checklistArtifacts["acceptance-checklist"] || null,
    executionMap: checklistArtifacts["execution-map"] || null,
    evidenceLedger: checklistArtifacts["evidence-ledger"] || null,
    checklistVerdict: checklistArtifacts["checklist-verdict"] || null,
    runtimeFailures: collectRuntimeFailureRefs(events, materialized),
    runtimeContext: materialized.runtimeContext || null,
    completionGate: materialized.completionGate || null,
  });
}

export async function writeJobAuditExport(outputDir: string, auditPackage: ReadinessRecord) {
  const { redactSecrets: redactSecretsForWrite } = await import("./secret-policy.js");
  const safe = redactSecretsForWrite(auditPackage);
  const slug = `${auditPackage.project}-${auditPackage.jobId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(outputDir, `${slug}-audit.json`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(safe, null, 2), "utf8");
  return filePath;
}
