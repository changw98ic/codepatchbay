#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  killTree,
  sameProcessIdentity,
  type ProcessIdentity,
} from "../core/runtime/process-tree.js";
import {
  createTemporaryWorkspace,
  temporaryWorkspaceErrorDetails,
  type TemporaryWorkspace,
} from "../core/runtime/temporary-workspace.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { writeJsonAtomic } from "../shared/fs-utils.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import type { LooseRecord } from "../shared/types.js";

type SweBenchRecord = LooseRecord & {
  benchmarkInstanceId?: string;
  representativeRepository?: string;
  baseCommit?: string;
  datasetRowRef?: string;
  evidenceBundleRef?: string;
};

export type ProductValidationPlanMode = "full" | "light";
export type ProductValidationAgents = {
  planner: string;
  executor: string;
  verifier: string;
  adversarial_verifier: string;
};

type CliOptions = {
  instance: string | null;
  agent: string;
  agents: ProductValidationAgents;
  timeoutMs: number;
  keepTemp: boolean;
  outputDir: string;
  planMode: ProductValidationPlanMode;
};

type CommandResult = {
  command: string;
  args: string[];
  cwd: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  errorMessage?: string | null;
  errorName?: string | null;
  errorCode?: string | null;
  errorCause?: unknown;
  rootIdentity?: ProcessIdentity;
};

type CodeGraphEvidence = {
  init: {
    code: number | null;
    stdoutTail: string;
    stderrTail: string;
  };
  statusCommand: {
    code: number | null;
    stdoutTail: string;
    stderrTail: string;
  };
};

type SweBenchVerificationCommands = {
  failToPass: string[];
  passToPass: string[];
  notes: string[];
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_ROOT = path.resolve(import.meta.dirname, "..");
const PRODUCT_EVIDENCE_FILE = process.env.CPB_SWEBENCH_PRODUCT_EVIDENCE_FILE
  ? path.resolve(process.env.CPB_SWEBENCH_PRODUCT_EVIDENCE_FILE)
  : path.join(REPO_ROOT, "docs", "product", "cpb-flagship-product-validation.json");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "docs", "product", "evidence", "swe-bench-real-runs");
const MANAGED_WORKER_OUTPUT_TAIL_BYTES = 2_000_000;
const DEFAULT_MANAGED_WORKER_CANCEL_WRITE_TIMEOUT_MS = 2_000;
export const DEFAULT_PRODUCT_VALIDATION_AGENTS: ProductValidationAgents = {
  planner: "codex",
  executor: "claude-glm",
  verifier: "claude-mimo",
  adversarial_verifier: "claude-mimo",
};

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] || null;
}

function parsePlanMode(value: string | null): ProductValidationPlanMode {
  if (value === null || value === "full") return "full";
  if (value === "light") return "light";
  throw new Error(`--plan-mode must be "full" or "light", got ${value}`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function productValidationCleanupFailure(primary: unknown, cleanup: unknown, rootPath: string) {
  const recovery = temporaryWorkspaceErrorDetails(cleanup);
  return Object.assign(new AggregateError(
    [primary, cleanup],
    `SWE-bench product validation and temporary workspace cleanup both failed for ${rootPath}`,
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

function productValidationFailureWithCleanupProof(primary: unknown, cleanup: unknown, rootPath: string) {
  const recovery = temporaryWorkspaceErrorDetails(cleanup);
  if (!recovery) return primary;
  return Object.assign(new AggregateError(
    [primary],
    `SWE-bench product validation failed; temporary workspace was retained at ${recovery.recoveryPaths.quarantineRoot || rootPath}`,
    { cause: primary },
  ), {
    primaryError: primary,
    temporaryWorkspaceRecovery: recovery,
    recoveryPaths: recovery.recoveryPaths,
    successorPreserved: recovery.successorPreserved,
  });
}

export async function runProductValidationTemporaryWorkspace<T>({
  keepTemp,
  task,
  onKeepTemp = (rootPath) => { console.error(`[keep-temp] ${rootPath}`); },
  createWorkspace = createTemporaryWorkspace,
}: {
  keepTemp: boolean;
  task: (rootPath: string) => Promise<T>;
  onKeepTemp?: (rootPath: string) => void | Promise<void>;
  createWorkspace?: (options: { prefix: string }) => Promise<TemporaryWorkspace>;
}): Promise<T> {
  const workspace = await createWorkspace({ prefix: "cpb-swebench-product-" });
  let value!: T;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    value = await task(workspace.rootPath);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  let cleanupError: unknown;
  let hasCleanupError = false;
  let cleanupResult: unknown;
  try {
    if (keepTemp) await onKeepTemp(workspace.rootPath);
    else cleanupResult = await workspace.cleanup();
  } catch (error) {
    cleanupError = error;
    hasCleanupError = true;
  }

  if (hasPrimaryError && hasCleanupError) {
    throw productValidationCleanupFailure(primaryError, cleanupError, workspace.rootPath);
  }
  if (hasPrimaryError) {
    throw productValidationFailureWithCleanupProof(primaryError, cleanupResult, workspace.rootPath);
  }
  if (hasCleanupError) throw cleanupError;
  return value;
}

function concreteCleanupErrors(errors: readonly unknown[]): unknown[] {
  return errors.flatMap((error) => (
    error instanceof AggregateError
      ? concreteCleanupErrors(error.errors)
      : [error]
  ));
}

function errorCode(error: Error): string | null {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function managedWorkerAbortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" && reason ? reason : "managed worker aborted") as Error & { code?: string };
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

type ManagedWorkerOutputTail = {
  chunks: Buffer[];
  byteLength: number;
};

function createManagedWorkerOutputTail(): ManagedWorkerOutputTail {
  return { chunks: [], byteLength: 0 };
}

function appendManagedWorkerOutput(current: ManagedWorkerOutputTail, chunk: Buffer | string) {
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (next.byteLength >= MANAGED_WORKER_OUTPUT_TAIL_BYTES) {
    current.chunks = [Buffer.from(next.subarray(next.byteLength - MANAGED_WORKER_OUTPUT_TAIL_BYTES))];
    current.byteLength = MANAGED_WORKER_OUTPUT_TAIL_BYTES;
    return;
  }
  current.chunks.push(next);
  current.byteLength += next.byteLength;
  let excess = current.byteLength - MANAGED_WORKER_OUTPUT_TAIL_BYTES;
  while (excess > 0) {
    const first = current.chunks[0];
    if (first.byteLength <= excess) {
      current.chunks.shift();
      current.byteLength -= first.byteLength;
      excess -= first.byteLength;
      continue;
    }
    current.chunks[0] = first.subarray(excess);
    current.byteLength -= excess;
    excess = 0;
  }
}

function managedWorkerOutputText(output: ManagedWorkerOutputTail) {
  const text = Buffer.concat(output.chunks, output.byteLength).toString("utf8");
  if (Buffer.byteLength(text, "utf8") <= MANAGED_WORKER_OUTPUT_TAIL_BYTES) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    if (Buffer.byteLength(text.slice(midpoint), "utf8") <= MANAGED_WORKER_OUTPUT_TAIL_BYTES) high = midpoint;
    else low = midpoint + 1;
  }
  return text.slice(low);
}

function managedWorkerTeardownTimeoutMs() {
  const parsed = Number.parseInt(process.env.CPB_MANAGED_WORKER_TEARDOWN_TIMEOUT_MS || "15000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}

function managedWorkerCancelWriteTimeoutMs() {
  const parsed = Number.parseInt(
    process.env.CPB_MANAGED_WORKER_CANCEL_WRITE_TIMEOUT_MS || String(DEFAULT_MANAGED_WORKER_CANCEL_WRITE_TIMEOUT_MS),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MANAGED_WORKER_CANCEL_WRITE_TIMEOUT_MS;
}

type ManagedProcessTeardown = (
  pid: number,
  options: {
    signal: AbortSignal;
    deadlineAt: number;
    expectedRootIdentity: ProcessIdentity;
  },
) => void | Promise<void>;

type ProductCommandOptions = {
  teardownProcessTree?: ManagedProcessTeardown;
  onSpawn?: (identity: ProcessIdentity) => void;
};

export type ScopedCodegraphCleanupOptions = {
  listProcesses?: () => Promise<string>;
  readProcessCommand?: (pid: number) => Promise<string | null>;
  captureIdentity?: (pid: number) => ProcessIdentity | null;
  isIdentityAlive?: (identity: ProcessIdentity) => boolean;
  teardownProcessTree?: ManagedProcessTeardown;
};

export type ScopedCodegraphCleanupUnresolved = {
  pid: number;
  reason:
    | "identity_unavailable"
    | "identity_mismatch"
    | "command_mismatch"
    | "teardown_failed"
    | "cleanup_unverified";
  message: string;
};

export function resolveProductValidationAgents(args: string[]): ProductValidationAgents {
  const singleAgent = argValue(args, "--agent");
  if (singleAgent) {
    return {
      planner: singleAgent,
      executor: singleAgent,
      verifier: singleAgent,
      adversarial_verifier: singleAgent,
    };
  }
  return {
    planner: argValue(args, "--planner-agent") || DEFAULT_PRODUCT_VALIDATION_AGENTS.planner,
    executor: argValue(args, "--executor-agent") || DEFAULT_PRODUCT_VALIDATION_AGENTS.executor,
    verifier: argValue(args, "--verifier-agent") || DEFAULT_PRODUCT_VALIDATION_AGENTS.verifier,
    adversarial_verifier: argValue(args, "--adversarial-agent") || DEFAULT_PRODUCT_VALIDATION_AGENTS.adversarial_verifier,
  };
}

function summarizeAgents(agents: ProductValidationAgents) {
  return [...new Set([agents.planner, agents.executor, agents.verifier, agents.adversarial_verifier])].join("+");
}

function agentNames(agents: ProductValidationAgents) {
  return [agents.planner, agents.executor, agents.verifier, agents.adversarial_verifier];
}

function shouldPrintHelp(argv: string[]) {
  return argv.includes("--help") || argv.includes("-h");
}

function printUsage() {
  console.log(`Usage: node dist/scripts/run-swebench-product-validation.js [options]

Options:
  --instance <id>       SWE-bench Verified instance id to run.
  --agent <name>        Single real agent override for all phases.
  --planner-agent <n>   Planner agent. Defaults to codex.
  --executor-agent <n>  Executor agent. Defaults to claude-glm.
  --verifier-agent <n>  Verifier agent. Defaults to claude-mimo.
  --adversarial-agent <n> Adversarial verifier agent. Defaults to claude-mimo.
  --timeout-ms <ms>     Managed worker timeout. Defaults to 1800000.
  --keep-temp           Keep temporary source, hub, and cpb directories.
  --output-dir <dir>    Directory for the evidence bundle.
  --plan-mode <mode>    full or light. Defaults to full.
  -h, --help            Show this help.
`);
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const agents = resolveProductValidationAgents(args);
  return {
    instance: argValue(args, "--instance"),
    agent: summarizeAgents(agents),
    agents,
    timeoutMs: Number.parseInt(argValue(args, "--timeout-ms") || "1800000", 10),
    keepTemp: args.includes("--keep-temp"),
    outputDir: path.resolve(argValue(args, "--output-dir") || DEFAULT_OUTPUT_DIR),
    planMode: parsePlanMode(argValue(args, "--plan-mode")),
  };
}

function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stringArrayFromJson(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value !== "string" || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [value];
  }
}

function safeId(value: string) {
  return value
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "sample";
}

async function readJson(filePath: string): Promise<LooseRecord> {
  return JSON.parse(await readFile(filePath, "utf8")) as LooseRecord;
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readTextTail(filePath: string, limit = 8000) {
  try {
    return (await readFile(filePath, "utf8")).slice(-limit);
  } catch {
    return null;
  }
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 300000,
  options: ProductCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let childClosed = false;
    let childIdentity: ProcessIdentity | null = null;
    let childIdentityError: unknown = null;
    let pendingTeardown = false;
    let teardown: Promise<void> | null = null;
    const cleanupErrors: unknown[] = [];
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const startTeardown = () => {
      pendingTeardown = true;
      if (teardown || childClosed || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      pendingTeardown = false;
      const pid = child.pid;
      const expectedRootIdentity = childIdentity;
      const teardownTimeoutMs = managedWorkerTeardownTimeoutMs();
      const deadlineAt = Date.now() + teardownTimeoutMs;
      const controller = new AbortController();
      const deadlineError = Object.assign(
        new Error(`command teardown timed out after ${teardownTimeoutMs}ms`),
        { name: "AbortError", code: "ABORT_ERR" },
      );
      const deadlineTimer = setTimeout(() => controller.abort(deadlineError), teardownTimeoutMs);
      const cleanup: ManagedProcessTeardown = options.teardownProcessTree || ((cleanupPid, cleanupOptions) => killTree(
        cleanupPid,
        10_000,
        { requireDescendantScan: true, expectedRootIdentity: cleanupOptions.expectedRootIdentity },
      ));
      teardown = (async () => {
        const errors: unknown[] = [];
        try {
          if (!expectedRootIdentity) {
            throw Object.assign(
              new Error("command process identity was not captured at spawn", {
                cause: childIdentityError || undefined,
              }),
              { code: "PROCESS_IDENTITY_UNAVAILABLE" },
            );
          }
          try {
            await cleanup(pid, { signal: controller.signal, deadlineAt, expectedRootIdentity });
            if (controller.signal.aborted) errors.push(controller.signal.reason);
          } catch (error) {
            errors.push(error);
          }

          let stillAlive = true;
          try {
            stillAlive = isProcessIdentityAlive(expectedRootIdentity);
          } catch (error) {
            errors.push(error);
          }
          if (stillAlive && options.teardownProcessTree) {
            try {
              await killTree(pid, 10_000, {
                requireDescendantScan: true,
                expectedRootIdentity,
              });
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            if (isProcessIdentityAlive(expectedRootIdentity)) {
              errors.push(Object.assign(
                new Error("command process is still running after teardown"),
                { code: "PROCESS_CLEANUP_UNVERIFIED" },
              ));
            }
          } catch (error) {
            errors.push(error);
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, "command teardown failed");
        } finally {
          clearTimeout(deadlineTimer);
        }
      })().catch((error) => {
        cleanupErrors.push(error);
      });
    };
    const timer = setTimeout(() => {
      const timeoutError = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stderr}`);
      startTeardown();
      finish(null, null, timeoutError);
    }, timeoutMs);
    const finish = (code: number | null, childSignal: NodeJS.Signals | null, error: Error | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void (async () => {
        if (teardown) await teardown;
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
        if (cleanupErrors.length > 0) {
          reject(new AggregateError(
            [...(error ? [error] : []), ...cleanupErrors],
            "command cleanup failed",
          ));
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve({
          command,
          args,
          cwd,
          code,
          signal: childSignal,
          stdout,
          stderr,
          rootIdentity: childIdentity || undefined,
        });
      })();
    };
    child.once("spawn", () => {
      const pid = child.pid;
      if (pid) {
        try {
          childIdentity = captureProcessIdentity(pid, { strict: true });
          if (!childIdentity) {
            throw Object.assign(
              new Error("command process exited before its identity could be captured"),
              { code: "PROCESS_IDENTITY_UNAVAILABLE" },
            );
          }
          options.onSpawn?.(childIdentity);
        } catch (error) {
          childIdentityError = error;
        }
      }
      if (pendingTeardown) startTeardown();
    });
    child.on("error", (error) => {
      finish(null, null, error);
    });
    child.on("close", (code, signal) => {
      childClosed = true;
      finish(code, signal);
    });
  });
}

async function runRequired(command: string, args: string[], cwd: string, timeoutMs?: number) {
  const result = await runCommand(command, args, cwd, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function scopedPathVariants(targetPath: string) {
  const resolved = path.resolve(targetPath);
  const variants = new Set([resolved]);
  if (resolved.startsWith("/var/")) variants.add(`/private${resolved}`);
  if (resolved.startsWith("/private/var/")) variants.add(resolved.replace(/^\/private/, ""));
  return [...variants];
}

function isScopedCodegraphCommand(command: string, variants: string[]) {
  return command.includes("codegraph")
    && command.includes("serve")
    && command.includes("--mcp")
    && variants.some((variant) => command.includes(variant));
}

function codegraphCleanupError(
  message: string,
  code: string,
  unresolved: ScopedCodegraphCleanupUnresolved[],
  cause?: unknown,
) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  return Object.assign(error, { code, unresolvedCleanup: unresolved });
}

function decorateCodegraphCleanupError(error: unknown, unresolved: ScopedCodegraphCleanupUnresolved[]) {
  if (error instanceof Error) {
    return Object.assign(error, { unresolvedCleanup: unresolved });
  }
  return Object.assign(new Error(String(error)), { unresolvedCleanup: unresolved });
}

function isExactProcessIdentityForPid(identity: ProcessIdentity | null, pid: number) {
  return Boolean(identity && identity.pid === pid && sameProcessIdentity(identity, identity));
}

export async function cleanupScopedCodegraphDaemons(
  worktreePath: string,
  options: ScopedCodegraphCleanupOptions = {},
) {
  const variants = scopedPathVariants(worktreePath);
  const listProcesses = options.listProcesses || (async () => {
    const result = await runCommand("ps", ["-axo", "pid=,command="], REPO_ROOT, 30000);
    if (result.code !== 0) {
      throw new Error(`failed to enumerate Codegraph daemons (ps exited ${result.code}): ${result.stderr}`);
    }
    return result.stdout;
  });
  const readProcessCommand = options.readProcessCommand || (async (pid: number) => {
    const result = await runCommand("ps", ["-p", String(pid), "-o", "command="], REPO_ROOT, 30000);
    return result.code === 0 ? result.stdout.trim() : null;
  });
  const captureIdentity = options.captureIdentity || ((pid: number) => captureProcessIdentity(pid, { strict: true }));
  const identityAlive = options.isIdentityAlive || isProcessIdentityAlive;
  const lines = (await listProcesses()).split("\n");
  const matches = lines
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number.parseInt(match[1], 10), command: match[2] };
    })
    .filter((entry): entry is { pid: number; command: string } => Boolean(entry))
    .filter((entry) => isScopedCodegraphCommand(entry.command, variants));

  const errors: unknown[] = [];
  const killed: number[] = [];
  const unresolved: ScopedCodegraphCleanupUnresolved[] = [];
  const targets: Array<{ pid: number; identity: ProcessIdentity }> = [];
  for (const entry of matches) {
    try {
      const observedIdentity = captureIdentity(entry.pid);
      if (!isExactProcessIdentityForPid(observedIdentity, entry.pid)) {
        throw codegraphCleanupError(
          `failed to capture an exact identity for Codegraph daemon pid ${entry.pid}; refusing to claim cleanup`,
          "PROCESS_IDENTITY_UNAVAILABLE",
          [],
        );
      }
      const currentCommand = await readProcessCommand(entry.pid);
      const confirmedIdentity = captureIdentity(entry.pid);
      if (!isExactProcessIdentityForPid(confirmedIdentity, entry.pid)) {
        throw codegraphCleanupError(
          `failed to re-capture an exact identity for Codegraph daemon pid ${entry.pid}; refusing to signal`,
          "PROCESS_IDENTITY_UNAVAILABLE",
          [],
        );
      }
      if (!sameProcessIdentity(observedIdentity, confirmedIdentity)) {
        throw codegraphCleanupError(
          `Codegraph daemon pid ${entry.pid} changed identity before cleanup; refusing to signal successor`,
          "PROCESS_IDENTITY_MISMATCH",
          [],
        );
      }
      if (!currentCommand || !isScopedCodegraphCommand(currentCommand, variants)) {
        throw codegraphCleanupError(
          `Codegraph daemon pid ${entry.pid} no longer matches the scoped command; refusing to signal`,
          "PROCESS_IDENTITY_MISMATCH",
          [],
        );
      }
      targets.push({ pid: entry.pid, identity: confirmedIdentity });
    } catch (error) {
      const cause = toError(error);
      const code = errorCode(cause);
      const reason: ScopedCodegraphCleanupUnresolved["reason"] = code === "PROCESS_IDENTITY_MISMATCH"
        ? (cause.message.includes("no longer matches") ? "command_mismatch" : "identity_mismatch")
        : "identity_unavailable";
      unresolved.push({ pid: entry.pid, reason, message: cause.message });
      errors.push(new Error(`failed to bind Codegraph daemon pid ${entry.pid} to a process identity`, { cause: error }));
    }
  }

  for (const target of targets) {
    const teardownTimeoutMs = managedWorkerTeardownTimeoutMs();
    const deadlineAt = Date.now() + teardownTimeoutMs;
    const controller = new AbortController();
    const deadlineError = Object.assign(
      new Error(`Codegraph daemon teardown timed out after ${teardownTimeoutMs}ms`),
      { name: "AbortError", code: "ABORT_ERR" },
    );
    const deadlineTimer = setTimeout(() => controller.abort(deadlineError), teardownTimeoutMs);
    try {
      const cleanup: ManagedProcessTeardown = options.teardownProcessTree || ((pid, cleanupOptions) => killTree(
        pid,
        10_000,
        { requireDescendantScan: true, expectedRootIdentity: cleanupOptions.expectedRootIdentity },
      ));
      await cleanup(target.pid, {
        signal: controller.signal,
        deadlineAt,
        expectedRootIdentity: target.identity,
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      let stillAlive: boolean;
      try {
        stillAlive = identityAlive(target.identity);
      } catch (error) {
        throw codegraphCleanupError(
          `could not verify cleanup of Codegraph daemon pid ${target.pid}: ${toError(error).message}`,
          "PROCESS_CLEANUP_UNVERIFIED",
          [],
          error,
        );
      }
      if (stillAlive) {
        throw codegraphCleanupError(
          `Codegraph daemon pid ${target.pid} is still running after teardown`,
          "PROCESS_CLEANUP_UNVERIFIED",
          [],
        );
      }
      killed.push(target.pid);
    } catch (error) {
      const cause = toError(error);
      unresolved.push({
        pid: target.pid,
        reason: errorCode(cause) === "PROCESS_CLEANUP_UNVERIFIED" ? "cleanup_unverified" : "teardown_failed",
        message: cause.message,
      });
      const diagnosticCause = cause.cause === undefined ? error : cause.cause;
      errors.push(new Error(`failed to clean up Codegraph daemon pid ${target.pid}`, { cause: diagnosticCause }));
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  if (errors.length === 1) throw decorateCodegraphCleanupError(errors[0], unresolved);
  if (errors.length > 1) {
    throw Object.assign(
      new AggregateError(errors, "scoped Codegraph daemon cleanup failed"),
      { unresolvedCleanup: unresolved },
    );
  }

  return {
    worktreePath,
    matchedPids: matches.map((entry) => entry.pid),
    killedPids: killed,
    unresolvedCleanup: unresolved,
  };
}

async function fetchDatasetRow(record: SweBenchRecord) {
  const ref = stringValue(record.datasetRowRef);
  if (!ref) throw new Error(`record ${record.benchmarkInstanceId} is missing datasetRowRef`);
  const response = await fetch(ref);
  if (!response.ok) throw new Error(`failed to fetch ${ref}: ${response.status} ${response.statusText}`);
  const payload = await response.json() as LooseRecord;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const first = rows[0];
  if (!isRecord(first) || !isRecord(first.row)) {
    throw new Error(`dataset row ref did not return a row: ${ref}`);
  }
  return {
    rowIndex: first.row_idx,
    row: first.row as LooseRecord,
  };
}

async function cloneAtCommit({ repo, baseCommit, targetDir }: { repo: string; baseCommit: string; targetDir: string }) {
  await mkdir(targetDir, { recursive: true });
  await runRequired("git", ["init"], targetDir);
  await runRequired("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], targetDir);
  await runRequired("git", ["fetch", "--depth=1", "origin", baseCommit], targetDir, 600000);
  await runRequired("git", ["checkout", "--detach", "FETCH_HEAD"], targetDir);
}

async function initCodeGraph(sourcePath: string): Promise<CodeGraphEvidence> {
  const init = await runRequired("codegraph", ["init", sourcePath], REPO_ROOT, 600000);
  const status = await runRequired("codegraph", ["status", sourcePath], REPO_ROOT, 120000);
  return {
    init: {
      code: init.code,
      stdoutTail: init.stdout.slice(-4000),
      stderrTail: init.stderr.slice(-4000),
    },
    statusCommand: {
      code: status.code,
      stdoutTail: status.stdout.slice(-4000),
      stderrTail: status.stderr.slice(-4000),
    },
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function parenthesizedTestTarget(testName: string) {
  const match = testName.match(/\(([^)]+)\)\s*$/);
  return match?.[1]?.trim() || "";
}

function isDjangoDottedTestTarget(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value);
}

function dottedTestGroup(testName: string) {
  const trimmed = testName.trim();
  const parenthesized = parenthesizedTestTarget(trimmed);
  if (parenthesized) return isDjangoDottedTestTarget(parenthesized) ? parenthesized : "";
  const parts = trimmed.split(".").filter(Boolean);
  const last = parts.at(-1) || "";
  if (parts.length > 1 && /^test/i.test(last)) {
    const group = parts.slice(0, -1).join(".");
    return isDjangoDottedTestTarget(group) ? group : "";
  }
  return isDjangoDottedTestTarget(trimmed) ? trimmed : "";
}

function djangoCommandTarget(testName: string) {
  const trimmed = testName.trim();
  const parenthesized = parenthesizedTestTarget(trimmed);
  if (parenthesized) {
    if (!isDjangoDottedTestTarget(parenthesized)) return "";
    const methodText = trimmed.slice(0, trimmed.lastIndexOf("(")).trim();
    const methodName = methodText.split(/\s+/).filter(Boolean).at(-1) || "";
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(methodName) && /^test/i.test(methodName)) {
      return `${parenthesized}.${methodName}`;
    }
    return parenthesized;
  }
  return isDjangoDottedTestTarget(trimmed) ? trimmed : "";
}

function djangoRuntestsCommand(tests: string[], limit?: number) {
  const targets = uniqueStrings(tests.map(djangoCommandTarget));
  const scopedTargets = typeof limit === "number" ? targets.slice(0, limit) : targets;
  if (scopedTargets.length === 0) return null;
  return `PYTHONPATH=. python3 tests/runtests.py ${scopedTargets.join(" ")}`;
}

function djangoDiagnosticCommand(tests: string[], limit = 4) {
  const groups = uniqueStrings(tests.map(dottedTestGroup).filter(Boolean)).slice(0, limit);
  if (groups.length === 0) return null;
  return `PYTHONPATH=. python3 tests/runtests.py ${groups.join(" ")}`;
}

function pytestCommand(tests: string[], limit?: number) {
  const targets = uniqueStrings(tests);
  const scopedTargets = typeof limit === "number" ? targets.slice(0, limit) : targets;
  if (scopedTargets.length === 0) return null;
  return `python3 -m pytest -q ${scopedTargets.join(" ")}`;
}

function pytestDiagnosticTarget(testName: string) {
  const trimmed = testName.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("::").filter(Boolean);
  if (parts.length >= 3) return `${parts[0]}::${parts[1]}`;
  if (parts.length >= 2) return parts[0];
  return trimmed;
}

function pytestDiagnosticCommand(tests: string[], limit = 4) {
  const targets = uniqueStrings(tests.map(pytestDiagnosticTarget).filter(Boolean)).slice(0, limit);
  if (targets.length === 0) return null;
  return `python3 -m pytest -q ${targets.join(" ")}`;
}

export function deriveSweBenchDiagnosticCommands(row: LooseRecord, record: SweBenchRecord): string[] {
  const failToPass = stringArrayFromJson(row.FAIL_TO_PASS);
  const command = record.representativeRepository === "django/django"
    ? djangoDiagnosticCommand(failToPass)
    : pytestDiagnosticCommand(failToPass);
  return uniqueStrings([command].filter((item): item is string => Boolean(item)));
}

export function deriveSweBenchVerificationCommands(
  row: LooseRecord,
  record: SweBenchRecord,
): SweBenchVerificationCommands {
  const failToPass = stringArrayFromJson(row.FAIL_TO_PASS);
  const passToPass = stringArrayFromJson(row.PASS_TO_PASS);
  const notes = [
    "Before changing implementation code, add or update a minimal real in-repo regression test that reproduces the issue and fails before the implementation change and passes after the fix.",
    "Use the exact canonical FAIL_TO_PASS command for failing-before and passing-after regression evidence; do not create a smaller direct regression command.",
    "Do not satisfy this by editing fakes, fixtures, snapshots, or generated test doubles.",
    "Treat SWE-bench FAIL_TO_PASS/PASS_TO_PASS test names as verification targets and external oracle targets in addition to your own regression test, not as a substitute for creating local coverage.",
    "Do not replace these canonical commands with broad package, app, full-suite, or self-invented test commands; canonical command results remain the acceptance ledger evidence.",
    "Run the exact canonical commands when recording SWE-bench acceptance evidence. Do not split, shorten, pipe, redirect, wrap, tail, or otherwise transform the canonical evidence commands.",
    "Use bounded code inspection or explicitly allowed diagnostics to prove the real problem path and bypass candidates; these diagnostics can supplement but never replace canonical acceptance evidence.",
    "If an exact canonical command fails, record that failure as evidence and fix the implementation; do not invent smaller replacement commands.",
  ];
  if (record.representativeRepository !== "django/django") {
    return {
      failToPass: uniqueStrings([pytestCommand(failToPass)].filter((item): item is string => Boolean(item))),
      passToPass: uniqueStrings([pytestCommand(passToPass, 4)].filter((item): item is string => Boolean(item))),
      notes,
    };
  }

  return {
    failToPass: uniqueStrings([djangoRuntestsCommand(failToPass)].filter((item): item is string => Boolean(item))),
    passToPass: uniqueStrings([djangoRuntestsCommand(passToPass, 4)].filter((item): item is string => Boolean(item))),
    notes: [
      "Django test commands must run from the repository root with PYTHONPATH=. and tests/runtests.py.",
      "Do not shorten the command path or omit the environment prefix.",
      ...notes,
    ],
  };
}

export function buildTask(row: LooseRecord, record: SweBenchRecord) {
  // The solver receives the same task surface as an ordinary CPB job. Dataset
  // identity, oracle tests, and scorer data stay outside the solving path.
  void record;
  return stringValue(row.problem_statement).trim();
}

async function writeAssignment({
  hubRoot,
  workerId,
  sourcePath,
  record,
  row,
  agents,
  planMode,
}: {
  hubRoot: string;
  workerId: string;
  sourcePath: string;
  record: SweBenchRecord;
  row: LooseRecord;
  agents: ProductValidationAgents;
  planMode: ProductValidationPlanMode;
}) {
  const projectId = safeId(`swebench-${record.benchmarkInstanceId}`);
  const assignmentId = safeId(`a-${record.benchmarkInstanceId}`);
  const entryId = safeId(record.benchmarkInstanceId || "swebench");
  const jobId = `job-${entryId}`;
  const attemptToken = `attempt-${entryId}-001`;
  const task = buildTask(row, record);
  const project = await registerProject(hubRoot, {
    id: projectId,
    name: projectId,
    sourcePath,
    metadata: {
      productValidation: true,
      benchmarkDataset: "SWE-bench/SWE-bench_Verified",
      benchmarkInstanceId: record.benchmarkInstanceId,
    },
  });

  const attemptDir = path.join(hubRoot, "assignments", assignmentId, "attempts", "001");
  await mkdir(path.join(attemptDir, "control"), { recursive: true });
  await writeJson(path.join(attemptDir, "attempt.json"), {
    assignmentId,
    attempt: 1,
    entryId,
    projectId,
    workerId,
    status: "assigned",
    attemptToken,
    createdAt: new Date().toISOString(),
  });
  await writeJson(path.join(hubRoot, "workers", "inbox", workerId, `${assignmentId}.json`), {
    assignmentId,
    entryId,
    projectId,
    workerId,
    task,
    sourcePath,
    workflow: "standard",
    planMode,
    sourceContext: {
      benchmarkDataset: "SWE-bench/SWE-bench_Verified",
      benchmarkInstanceId: record.benchmarkInstanceId,
      benchmarkRepository: record.representativeRepository,
      benchmarkBaseCommit: record.baseCommit,
      issueNumber: null,
      productValidation: {
        validationMode: "swe-bench-verified",
        benchmarkInstanceId: record.benchmarkInstanceId,
        planMode,
        agents,
      },
    },
    metadata: {
      autoFinalize: true,
      finalizeMode: "dry-run",
      agents: {
        planner: agents.planner,
        executor: agents.executor,
        verifier: agents.verifier,
        adversarial_verifier: agents.adversarial_verifier,
      },
      productValidation: {
        validationMode: "swe-bench-verified",
        benchmarkInstanceId: record.benchmarkInstanceId,
        planMode,
        agents,
      },
    },
    attempt: 1,
    attemptToken,
    orchestratorEpoch: 1,
  });
  return { project, projectId, assignmentId, entryId, attemptDir };
}

export async function runManagedWorker({
  workerId,
  hubRoot,
  cpbRoot,
  assignmentId,
  phaseAgents,
  timeoutMs,
  distRoot = DIST_ROOT,
  extraEnv = {},
  signal,
  teardownProcessTree,
  onSpawn,
}: {
  workerId: string;
  hubRoot: string;
  cpbRoot: string;
  assignmentId: string;
  phaseAgents: ProductValidationAgents;
  timeoutMs: number;
  distRoot?: string;
  extraEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  teardownProcessTree?: ManagedProcessTeardown;
  onSpawn?: (identity: ProcessIdentity) => void;
}) {
  if (signal?.aborted) throw managedWorkerAbortError(signal);
  const workerScript = path.join(distRoot, "runtime", "worker", "managed-worker.js");
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(process.execPath, [
      workerScript,
      "--worker-id", workerId,
      "--hub-root", hubRoot,
      "--cpb-root", cpbRoot,
      "--once",
    ], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...extraEnv,
        CPB_ROOT: cpbRoot,
        CPB_HUB_ROOT: hubRoot,
        CPB_EXECUTOR_ROOT: REPO_ROOT,
        CPB_PROJECT_ROOTS: path.dirname(hubRoot),
        CPB_WORKER_DISPATCH_ENABLED: "0",
        CPB_ACP_USE_MANAGED_POOL: "0",
        CPB_ACP_PERSISTENT_PROCESS: "0",
        CPB_DYNAMIC_VERIFIER_AGENT: phaseAgents.verifier,
        CPB_PRODUCT_VALIDATION_KEEP_WORKTREE: "1",
        CPB_ACP_TIMEOUT_MS: String(timeoutMs),
        CPB_ACP_IDLE_TIMEOUT_MS: process.env.CPB_ACP_IDLE_TIMEOUT_MS || String(Math.min(timeoutMs, 600_000)),
        CPB_ACP_PHASE_TIMEOUT_MS: String(timeoutMs),
        CPB_ACP_POOL_TIMEOUT_MS: String(timeoutMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout = createManagedWorkerOutputTail();
    const stderr = createManagedWorkerOutputTail();
    let timedOut = false;
    let aborted = false;
    let finishStarted = false;
    const cleanupErrors: unknown[] = [];
    let terminationCause: Error | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let teardown: Promise<void> | null = null;
    let cancelRequest: Promise<void> | null = null;
    let pendingTeardown = false;
    let onAbort = () => {};
    let childClosed = false;
    let childPid: number | null = null;
    let childIdentity: ProcessIdentity | null = null;
    let childIdentityError: unknown = null;
    const clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };
    const abortError = () => managedWorkerAbortError(signal);
    const timeoutError = () => Object.assign(new Error(`managed worker timed out after ${timeoutMs}ms`), { code: "MANAGED_WORKER_TIMEOUT" });
    const waitForCancelRequest = () => cancelRequest || Promise.resolve();
    const appendStderr = (message: string) => {
      appendManagedWorkerOutput(stderr, message);
    };
    const requestCancel = () => {
      if (cancelRequest) return cancelRequest;
      const cancelTimeoutMs = managedWorkerCancelWriteTimeoutMs();
      const deadlineAt = Date.now() + cancelTimeoutMs;
      const controller = new AbortController();
      const deadlineError = Object.assign(
        new Error(`managed worker cancel write timed out after ${cancelTimeoutMs}ms`),
        { name: "AbortError", code: "ABORT_ERR" },
      );
      const cancelTimer = setTimeout(() => controller.abort(deadlineError), cancelTimeoutMs);
      cancelRequest = (async () => {
        try {
          const store = new AssignmentStore(hubRoot);
          await store.init();
          await store.writeCancel(
            assignmentId,
            1,
            `product validation timed out after ${timeoutMs}ms`,
            { signal: controller.signal, deadlineAt },
          );
        } catch (error) {
          appendStderr(`\n[product-validation] failed to request worker cancellation: ${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          clearTimeout(cancelTimer);
        }
      })();
      return cancelRequest;
    };
    const startTeardown = () => {
      pendingTeardown = true;
      if (!childPid || childClosed || child.exitCode !== null || child.signalCode !== null || teardown) return;
      pendingTeardown = false;
      const pid = childPid;
      const expectedRootIdentity = childIdentity;
      const teardownTimeoutMs = managedWorkerTeardownTimeoutMs();
      const deadlineAt = Date.now() + teardownTimeoutMs;
      const controller = new AbortController();
      const deadlineError = Object.assign(
        new Error(`managed worker teardown timed out after ${teardownTimeoutMs}ms`),
        { name: "AbortError", code: "ABORT_ERR" },
      );
      const deadlineTimer = setTimeout(() => controller.abort(deadlineError), teardownTimeoutMs);
      const cleanup: ManagedProcessTeardown = teardownProcessTree || ((cleanupPid, options) => killTree(
        cleanupPid,
        10_000,
        { requireDescendantScan: true, expectedRootIdentity: options.expectedRootIdentity },
      ));
      teardown = (async () => {
        const teardownErrors: unknown[] = [];
        try {
          if (!expectedRootIdentity) {
            throw Object.assign(
              new Error("managed worker process identity was not captured at spawn", {
                cause: childIdentityError || undefined,
              }),
              { code: "PROCESS_IDENTITY_UNAVAILABLE" },
            );
          }
          try {
            await cleanup(pid, { signal: controller.signal, deadlineAt, expectedRootIdentity });
            if (controller.signal.aborted) teardownErrors.push(controller.signal.reason);
          } catch (error) {
            teardownErrors.push(error);
          }

          let stillAlive = true;
          try {
            stillAlive = isProcessIdentityAlive(expectedRootIdentity);
          } catch (error) {
            teardownErrors.push(error);
          }
          if (stillAlive && teardownProcessTree) {
            try {
              await killTree(pid, 10_000, {
                requireDescendantScan: true,
                expectedRootIdentity,
              });
            } catch (error) {
              teardownErrors.push(error);
            }
          }
          try {
            if (isProcessIdentityAlive(expectedRootIdentity)) {
              teardownErrors.push(Object.assign(
                new Error("managed worker process is still running after teardown"),
                { code: "PROCESS_CLEANUP_UNVERIFIED" },
              ));
            }
          } catch (error) {
            teardownErrors.push(error);
          }
          if (teardownErrors.length === 1) throw teardownErrors[0];
          if (teardownErrors.length > 1) {
            throw new AggregateError(teardownErrors, "managed worker teardown failed");
          }
        } finally {
          clearTimeout(deadlineTimer);
        }
      })().catch((error) => {
        cleanupErrors.push(error);
        throw error;
      });
      void teardown.then(() => {
        if (!finishStarted && (timedOut || aborted)) finish(null, null);
      }, () => {
        if (!finishStarted) finish(null, null);
      });
    };
    const finish = (code: number | null, childSignal: NodeJS.Signals | null, error: Error | null = null) => {
      if (finishStarted) return;
      finishStarted = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      void Promise.allSettled([teardown || Promise.resolve(), waitForCancelRequest()]).then(() => {
        if (cleanupErrors.length > 0) {
          const original = error || terminationCause;
          const concreteErrors = concreteCleanupErrors(cleanupErrors);
          reject(new AggregateError(
            [...(original ? [original] : []), ...concreteErrors],
            "managed worker cleanup failed",
            { cause: concreteErrors[0] },
          ));
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve({
          command: process.execPath,
          args: [workerScript],
          cwd: REPO_ROOT,
          code,
          signal: childSignal,
          stdout: managedWorkerOutputText(stdout),
          stderr: managedWorkerOutputText(stderr),
          timedOut,
          errorMessage: timedOut ? `managed worker timed out after ${timeoutMs}ms` : aborted ? abortError().message : null,
          errorName: aborted ? abortError().name : null,
          errorCode: aborted ? errorCode(abortError()) : null,
          errorCause: aborted ? abortError().cause : undefined,
          rootIdentity: childIdentity || undefined,
        });
      });
    };
    child.stdout.on("data", (chunk) => { appendManagedWorkerOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { appendManagedWorkerOutput(stderr, chunk); });
    child.once("spawn", () => {
      childPid = child.pid || null;
      if (childPid) {
        try {
          childIdentity = captureProcessIdentity(childPid, { strict: true });
          if (childIdentity) onSpawn?.(childIdentity);
        } catch (error) {
          childIdentityError = error;
        }
      }
      if (pendingTeardown) startTeardown();
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminationCause = timeoutError();
      void requestCancel();
      if (child.exitCode === null && child.signalCode === null) startTeardown();
    }, timeoutMs);
    onAbort = () => {
      aborted = true;
      terminationCause = abortError();
      startTeardown();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on("error", (error) => {
      finish(null, null, error instanceof Error ? error : new Error(String(error)));
    });
    child.on("close", (code, childSignal) => {
      childClosed = true;
      finish(code, childSignal);
    });
  });
}

function summarizeJobResult(result: LooseRecord | null) {
  const jobResult = isRecord(result?.jobResult) ? result.jobResult : {};
  const finalizeResult = isRecord(result?.finalizeResult) ? result.finalizeResult : null;
  const phaseResults = Array.isArray(jobResult.phaseResults)
    ? jobResult.phaseResults.map((phase) => isRecord(phase) ? phase.phase : null)
    : [];
  const failure = isRecord(jobResult.failure) ? jobResult.failure : {};
  const failurePhase = typeof failure.phase === "string" ? failure.phase : null;
  return {
    assignmentStatus: result?.status || null,
    jobStatus: jobResult.status || null,
    jobId: jobResult.jobId || null,
    phases: phaseResults.length > 0 ? phaseResults : (failurePhase ? [failurePhase] : []),
    completionGate: jobResult.completionGate || jobResult.completionGateResult || null,
    finalizeResult,
  };
}

async function main() {
  if (shouldPrintHelp(process.argv)) {
    printUsage();
    return;
  }

  const options = parseArgs(process.argv);
  const evidence = await readJson(PRODUCT_EVIDENCE_FILE);
  const records = Array.isArray(evidence.records) ? evidence.records.filter(isRecord) as SweBenchRecord[] : [];
  const record = records.find((item) => item.validationMode === "swe-bench-verified" && (
    options.instance ? item.benchmarkInstanceId === options.instance : true
  ));
  if (!record) {
    throw new Error(`No SWE-bench Verified record found${options.instance ? ` for ${options.instance}` : ""}`);
  }
  if (agentNames(options.agents).includes("fake-acp")) {
    throw new Error("Refusing to run product validation with fake-acp. Use a real agent such as codex or claude.");
  }
  const previousIndexOnly = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
  process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = "1";
  let bundlePath: string | null = null;

  try {
    await runProductValidationTemporaryWorkspace({
      keepTemp: options.keepTemp,
      task: async (tmpRoot) => {
        const { rowIndex, row } = await fetchDatasetRow(record);
        const problemHash = createHash("sha256").update(stringValue(row.problem_statement)).digest("hex");
        if (problemHash !== record.problemStatementSha256) {
          throw new Error(`problem statement hash mismatch for ${record.benchmarkInstanceId}: ${problemHash}`);
        }

        const hubRoot = path.join(tmpRoot, "hub");
        const cpbRoot = path.join(tmpRoot, "cpb");
        const sourcePath = path.join(tmpRoot, "source");
        const workerId = "w-swebench";
        let codegraphEvidence: CodeGraphEvidence | null = null;
        const failToPassTests = stringArrayFromJson(row.FAIL_TO_PASS);
        const passToPassTests = stringArrayFromJson(row.PASS_TO_PASS);

    await new AssignmentStore(hubRoot).init();
    await cloneAtCommit({
      repo: stringValue(record.representativeRepository),
      baseCommit: stringValue(record.baseCommit),
      targetDir: sourcePath,
    });
    codegraphEvidence = await initCodeGraph(sourcePath);
    const assignment = await writeAssignment({
      hubRoot,
      workerId,
      sourcePath,
      record,
      row,
      agents: options.agents,
      planMode: options.planMode,
    });
    const worker = await runManagedWorker({
      workerId,
      hubRoot,
      cpbRoot,
      assignmentId: assignment.assignmentId,
      phaseAgents: options.agents,
      timeoutMs: options.timeoutMs,
    });
    const resultPath = path.join(assignment.attemptDir, "result.json");
    const heartbeatPath = path.join(assignment.attemptDir, "heartbeat.json");
    const eventLogPath = path.join(hubRoot, "projects", assignment.projectId, "events", assignment.projectId, `job-${assignment.entryId}.jsonl`);
    const acpAuditPath = path.join(hubRoot, "projects", assignment.projectId, "acp-audit", assignment.projectId, `job-${assignment.entryId}.jsonl`);
    const worktreePath = path.join(hubRoot, "worktrees", `job-${assignment.entryId}-pipeline`);
    const codegraphDaemonCleanup = await cleanupScopedCodegraphDaemons(worktreePath);
    const result = await readJson(resultPath).catch(() => null);
    const heartbeat = await readJson(heartbeatPath).catch(() => null);
    const worktreeStatus = await runCommand("git", ["status", "--short"], worktreePath, 120000).catch((error: unknown) => ({
      command: "git",
      args: ["status", "--short"],
      cwd: worktreePath,
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      errorMessage: error instanceof Error ? error.message : String(error),
    } satisfies CommandResult));
    const worktreeDiffStat = await runCommand("git", ["diff", "--stat"], worktreePath, 120000).catch((error: unknown) => ({
      command: "git",
      args: ["diff", "--stat"],
      cwd: worktreePath,
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      errorMessage: error instanceof Error ? error.message : String(error),
    } satisfies CommandResult));
    const summary = summarizeJobResult(result);
    const bundle = {
      schemaVersion: 1,
      validationMode: "swe-bench-verified-real-run",
      validatedAt: new Date().toISOString(),
      agent: options.agent,
      agents: options.agents,
      planMode: options.planMode,
      source: {
        dataset: "SWE-bench/SWE-bench_Verified",
        split: "test",
        datasetRowRef: record.datasetRowRef,
        rowIndex,
      },
      sample: {
        instanceId: record.benchmarkInstanceId,
        repository: record.representativeRepository,
        baseCommit: record.baseCommit,
        problemStatementSha256: problemHash,
        failToPassTests: failToPassTests.length,
        passToPassTests: passToPassTests.length,
      },
      cpbRun: {
        hubRoot,
        cpbRoot,
        sourcePath,
        codegraph: codegraphEvidence,
        codegraphIndexOnlyAccepted: true,
        capabilityMapConfidence: assignment.project.metadata?.capabilityMapConfidence || null,
        projectRuntimeRoot: assignment.project.projectRuntimeRoot,
        resultPath,
        workerExitCode: worker.code,
        workerSignal: worker.signal,
        workerTimedOut: worker.timedOut || false,
        workerErrorMessage: worker.errorMessage || null,
        codegraphDaemonCleanup,
        stdoutTail: worker.stdout.slice(-4000),
        stderrTail: worker.stderr.slice(-4000),
        heartbeat,
        eventLogTail: await readTextTail(eventLogPath),
        acpAuditTail: await readTextTail(acpAuditPath),
        worktreeStatus: {
          code: worktreeStatus.code,
          stdout: worktreeStatus.stdout,
          stderrTail: worktreeStatus.stderr.slice(-2000),
          errorMessage: worktreeStatus.errorMessage || null,
        },
        worktreeDiffStat: {
          code: worktreeDiffStat.code,
          stdout: worktreeDiffStat.stdout,
          stderrTail: worktreeDiffStat.stderr.slice(-2000),
          errorMessage: worktreeDiffStat.errorMessage || null,
        },
        summary,
      },
    };
    bundlePath = path.join(options.outputDir, `${safeId(record.benchmarkInstanceId || "sample")}-real-run.json`);
    await writeJsonAtomic(bundlePath, bundle);
    console.log(`Wrote SWE-bench product validation evidence: ${path.relative(REPO_ROOT, bundlePath)}`);
    console.log(JSON.stringify(summary, null, 2));
    if (worker.code !== 0 || worker.timedOut || summary.jobStatus !== "completed") {
      process.exitCode = 1;
    }
      },
    });
  } finally {
    if (previousIndexOnly === undefined) delete process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
    else process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = previousIndexOnly;
  }

  if (!bundlePath) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
