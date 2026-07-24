import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, lstat, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, type LooseRecord } from "../../../core/contracts/types.js";
import {
  AcpClient,
  parseToolPolicy,
  resolveAcpAuditFile,
  resolveAcpRuntimeGuards,
  resolveWriteAllowPaths,
} from "./acp-client.js";
import { applyVariantToEnv, resolveVariantConfig } from "../apply-variant.js";
import { saveSessionId, loadSessionId, clearSessionId } from "../../../core/agents/session-cache.js";
import { createAgentHome, resolveAgentHomeRuntimeRoot } from "../../../core/agents/isolation.js";
import { buildAcpPoolEnv, buildChildEnv } from "../../../core/policy/child-env.js";
import { buildAgentSandboxLaunch } from "../../../core/policy/agent-sandbox.js";
import { codexSandboxModeForExecution } from "../../../core/acp/policy.js";
import {
  claudeFilesystemBoundarySettings,
  parseAgentFilesystemBoundary,
  resolveLinkedGitMetadataReadRoots,
} from "../../../core/policy/filesystem-boundary.js";
import {
  ProviderQuotaError,
  assertProviderAvailable,
  classifyQuotaFailure,
} from "../provider-quota.js";
import { getProviderAdapter } from "../provider-adapters.js";
import {
  captureProcessIdentity,
  captureSpawnProcessIdentity,
  killTree,
  sameProcessIdentity,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../../../core/runtime/process-tree.js";
import type { BoundedRegularFileReadHooks } from "../../../core/runtime/durable-directory-lock.js";

type AgentDescriptor = LooseRecord & {
  poolLimit?: number;
  displayName?: string;
  stability?: string;
  capabilities?: unknown[];
  defaultRoles?: unknown[];
  command?: unknown;
  envPrefix?: unknown;
  providerKey?: unknown;
  providerVariant?: unknown;
  lifecycle?: string;
  transport?: string;
};

type AgentRegistryModule = {
  loadRegistry(configDir?: string): Promise<void>;
  listAgentNames(): string[];
  getDescriptor(agent: string): AgentDescriptor | null | undefined;
};

type PoolClientKeyOptions = LooseRecord & {
  projectId?: string;
  workspaceId?: string;
  dataRoot?: string | null;
  processCwd?: string;
  policyHash?: string;
  variant?: string | null;
  conversationKey?: string;
  launchPermissionLane?: string;
};

type EnvRecord = Record<string, string | undefined> & {
  CPB_ROOT?: string;
  CPB_HUB_ROOT?: string;
  CPB_PROJECT_RUNTIME_ROOT?: string;
  CPB_ACP_PERSISTENT_PROCESS?: string;
  CPB_ACP_POOL_LEASE_ROOT?: string;
  CPB_ACP_POOL_MAX_REQUESTS?: string;
  CPB_ACP_POOL_MAX_AGE_MS?: string;
  CPB_ACP_POOL_IDLE_MS?: string;
  CPB_ACP_POOL_PROVIDER_MAX?: string;
  CPB_ACP_POOL_CONNECTION_POLL_MS?: string;
  CPB_ACP_POOL_WAIT_TIMEOUT_MS?: string;
  CPB_ACP_PROVIDER_FALLBACKS?: string;
  CPB_ACP_CLIENT?: string;
  CPB_ACP_TERMINAL?: string;
  CPB_AGENT_HOME_INSTANCE_ID?: string;
};

type UsageRollup = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
  toolCalls: number;
  functionCalls: number;
  events: number;
  tokenSource: string | null;
  reported: Set<string>;
};

type UsageFilter = {
  phase?: string | null;
  role?: string | null;
};

type UsageFinalizeOptions = {
  tokenEvents?: number;
  toolCalls?: number;
  source?: string;
};

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

type UsageAuditEvent = LooseRecord & {
  event?: string;
  usage?: LooseRecord;
};

type ProgressReporter = (event: LooseRecord) => Promise<unknown> | unknown;

type AcpMetadataOptions = LooseRecord & {
  projectId?: string;
  jobId?: string;
  dataRoot?: string | null;
  phase?: string;
  role?: string;
  poolScope?: string;
  controlPlane?: boolean;
};

type PoolRequestOptions = PoolClientKeyOptions & AcpMetadataOptions & {
  cwd?: string;
  env?: EnvRecord;
  providerKey?: string;
  waitTimeoutMs?: unknown;
  bypass?: boolean;
  onProgress?: ProgressReporter | null;
  signal?: AbortSignal;
};

type PoolRunnerOptions = {
  agent: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

type PoolRunner = (opts: PoolRunnerOptions) => Promise<string>;

type AcpPoolOptions = LooseRecord & {
  cpbRoot?: string;
  hubRoot?: string;
  env?: EnvRecord;
  limits?: LooseRecord;
  runner?: PoolRunner | null;
  persistentProcesses?: unknown;
  maxSessionRequests?: unknown;
  maxSessionAgeMs?: unknown;
  sessionIdleMs?: unknown;
  providerConnectionLimit?: unknown;
  providerConnectionLimits?: Record<string, number>;
  connectionPollMs?: unknown;
  leaseRoot?: string;
  providerFallbacks?: unknown;
  connectionLockFsHooks?: ConnectionLockFsHooks;
};

export type ProviderFallbackCandidate = {
  providerKey: string;
  agent: string;
  variant?: string | null;
  providerFallback?: boolean;
};

type PoolStatus = ReturnType<AcpPool["status"]>;
type PoolStatusEntry = LooseRecord & {
  descriptor?: LooseRecord;
  capabilities?: unknown[];
};

type AcpExecutionErrorWithMetadata = Error & {
  usage?: LooseRecord | null;
  acpAuditFile?: string | null;
  message: string;
};

type QuotaClassification = LooseRecord & {
  isQuota?: boolean;
  status?: string;
  nextEligibleAt?: number | null;
  source?: string;
  confidence?: number;
  reason?: string;
};

type ProviderQuotaErrorWithMetadata = ProviderQuotaError & {
  usage?: LooseRecord | null;
  acpAuditFile?: string | null;
};

export type AcpPoolSpawnedChild = ChildProcessWithoutNullStreams & {
  detached?: boolean;
  processIdentity?: ProcessIdentity | null;
};

type SpawnedChild = AcpPoolSpawnedChild;

type JsonSchema = Record<string, unknown>;

type AcquiredPoolSlot = {
  agent: string;
  requestId: string;
  release: () => void;
};

type PendingPoolRequest = {
  resolve: (slot: AcquiredPoolSlot) => void;
  reject: (error: Error) => void;
  agent: string;
  providerKey: string;
  signal?: AbortSignal;
  aborted?: boolean;
  _timer?: NodeJS.Timeout;
  _warnTimer?: NodeJS.Timeout;
  _abortCleanup?: () => void;
};

type LivePoolRequest = {
  agent: string;
  startedAt: number;
  providerKey: string;
  promptSnippet?: string | null;
  promptBytes?: number;
  phase?: string | null;
};

type PoolSession = {
  agent: string;
  conversationKey: string | null;
  startedAt: number;
  lastUsedAt: number | null;
  requestCount: number;
  recycleReason: string | null;
  recycledAt: number | null;
  sessionId: string | null;
};

type ConnectionLease = {
  leaseId?: string;
  ownerToken?: string;
  generation?: string;
  pid?: number | string;
  processIdentity?: ProcessIdentity | null;
  agent?: string;
  providerKey?: string;
  phase?: string | null;
  role?: string | null;
  poolScope?: string | null;
  controlPlane?: boolean;
  acquiredAt?: string;
  filePath?: string;
};

type ConnectionLockOwner = {
  format: typeof CONNECTION_LOCK_OWNER_FORMAT;
  binding: "pending" | "bound";
  ownerToken: string;
  generation: string;
  pid: number;
  host: string;
  acquiredAt: string;
  processIdentity: ProcessIdentity;
  identity: ConnectionLockGeneration | null;
};

const CONNECTION_LOCK_OWNER_FORMAT = "cpb-acp-connection-lock/v1";
const CONNECTION_LOCK_PENDING_PADDING_BYTES = 1024;

type ConnectionLockGeneration = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type ConnectionLockFsPhase =
  | "acquire-publish"
  | "recover-isolation"
  | "recover-rename"
  | "release-isolation"
  | "release-rename"
  | "lease-release-rename";

type ConnectionLockDirectorySyncStage =
  | "after-open"
  | "before-sync"
  | "after-sync"
  | "after-primary-close"
  | "after-fallback-close";

type ConnectionLockMovedPhase = "recover" | "release";

type ConnectionLockRenameDurability = {
  durabilityVerified: boolean;
  isolationDirectoryDurable: boolean;
  parentDirectoryDurable: boolean;
  failures: Array<{
    directory: string;
    phase: ConnectionLockFsPhase;
    error: unknown;
  }>;
};

type ConnectionLockBoundedReadHooks = BoundedRegularFileReadHooks & {
  afterVerifiedRead?: (context: {
    filePath: string;
    totalBytes: number;
    identity: ConnectionLockGeneration;
  }) => Promise<void> | void;
};

type ConnectionLockFsHooks = {
  syncDirectory?: (directory: string, phase: ConnectionLockFsPhase) => Promise<void> | void;
  directorySyncFault?: (details: {
    directory: string;
    phase: ConnectionLockFsPhase;
    stage: ConnectionLockDirectorySyncStage;
  }) => Promise<void> | void;
  boundedRead?: ConnectionLockBoundedReadHooks;
  durableWriteFault?: (details: {
    operation: "connection-owner" | "connection-lease";
    stage:
      | "after-open"
      | "after-primary-close"
      | "after-fallback-close"
      | "after-publish"
      | "before-temp-cleanup"
      | "after-temp-validation";
    filePath: string;
    tempPath: string;
  }) => Promise<void> | void;
  afterMove?: (details: {
    phase: ConnectionLockMovedPhase;
    lockDir: string;
    movedDir: string;
    owner: ConnectionLockOwner | null;
  }) => Promise<void> | void;
  beforeMove?: (details: {
    phase: ConnectionLockMovedPhase;
    lockDir: string;
    owner: ConnectionLockOwner | null;
  }) => Promise<void> | void;
};

const connectionLockBoundedReadHooksStorage = new AsyncLocalStorage<
  ConnectionLockBoundedReadHooks | undefined
>();

export type ClaudeApiRetryEvent = {
  attempt: number;
  maxRetries: number | null;
  retryDelayMs: number | null;
  httpStatus: number | null;
  error: string | null;
  sessionId: string | null;
  uuid: string | null;
};

export type ClaudeCliToolAuditEvent = {
  event: "tool_call";
  toolCallId: string;
  title?: string;
  status: "in_progress" | "completed" | "failed";
  kind?: "execute" | "read" | "search" | "edit" | "other";
  toolName?: string;
  sessionId?: string | null;
};

type PersistentClientState = {
  client: AcpClient;
  agent: string;
  projectId: string;
  jobId: string;
  dataRoot: string | null;
  conversationKey: string | null;
  sessionKey: string;
  providerKey: string;
  connectionLease: ConnectionLease | null;
  launchCwd: string;
  lastCwd?: string;
  launchScopedMcp: boolean;
  startedAt: number;
  requestCount: number;
  lastUsedAt: number | null;
};

const USAGE_NUMBER_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "costUsd",
  "toolCalls",
  "functionCalls",
  "events",
] as const;

let _registryCache: AgentRegistryModule | null = null;
let _registryLoadPromise: Promise<AgentRegistryModule | null> | null = null;

/**
 * Compound key for persistent client isolation.
 * Job id, role, and cwd are intentionally excluded so a long-lived worker can
 * reuse the same ACP provider process across sequential jobs. Launch-time
 * permission lanes remain isolated: a read-only planning process must never be
 * reused for execution, and a workspace-write process must never leak into
 * verification. Runtime data roots are also isolated so a live process cannot
 * carry session or environment state across project-runtime boundaries. Agents
 * with launch-scoped MCP config can opt into processCwd.
 */
export function poolClientKey(agent: string, options: PoolClientKeyOptions = {}) {
  const projectId = options.projectId || "";
  const workspaceId = options.workspaceId || "";
  const requestedDataRoot = stringValue(options.dataRoot);
  const dataRoot = requestedDataRoot ? path.resolve(requestedDataRoot) : "";
  const processCwd = options.processCwd || "";
  const policyHash = options.policyHash || "";
  const variant = options.variant || "";
  const launchPermissionLane = options.launchPermissionLane || "";
  const baseKey = [agent, projectId, workspaceId, dataRoot, processCwd, policyHash, variant, launchPermissionLane].join("::");
  const conversationKey = stringValue(options.conversationKey);
  return conversationKey
    ? `${baseKey}::conversation:${encodeURIComponent(conversationKey)}`
    : baseKey;
}

function conversationAgentHomeInstanceId(conversationKey: string | null) {
  if (!conversationKey) return null;
  return `conversation-${createHash("sha256").update(conversationKey).digest("hex").slice(0, 16)}`;
}

const STRING_ARRAY_SCHEMA: JsonSchema = {
  type: "array",
  items: { type: "string" },
};

const RECORD_ARRAY_SCHEMA: JsonSchema = {
  type: "array",
  items: { type: "object" },
};

function planProposalObjectSchema(proposalId: "A" | "B"): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      proposalId: { type: "string", enum: [proposalId] },
      planMarkdown: { type: "string", minLength: 1 },
      problemModel: { type: "string", minLength: 1 },
      claims: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            claimId: { type: "string", minLength: 1 },
            statement: { type: "string", minLength: 1 },
            evidenceRefs: STRING_ARRAY_SCHEMA,
            falsificationProbe: { type: "string", minLength: 1 },
            status: { type: "string", minLength: 1 },
          },
          required: ["claimId", "statement", "evidenceRefs", "falsificationProbe", "status"],
        },
      },
      decomposedItems: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            requirement: { type: "string", minLength: 1 },
            predicateId: { type: "string", minLength: 1 },
            verificationMethod: {
              type: "string",
              enum: [
                "command", "test", "static", "runtime_event", "artifact_event",
                "audit_export", "dag_event", "worker_lifecycle", "manual", "absence_check",
              ],
            },
            allowedFiles: { ...STRING_ARRAY_SCHEMA, minItems: 1 },
            sourceRefs: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", minLength: 1 },
                  locator: { type: "string", minLength: 1 },
                },
                required: ["kind", "locator"],
              },
            },
            expectedEvidence: { type: "string", minLength: 1 },
            evidenceOrigin: { type: "string", minLength: 1 },
            requiresRealPathEvidence: { type: "boolean" },
            observableContract: {
              type: "object",
              additionalProperties: false,
              properties: {
                observationKind: {
                  type: "string",
                  enum: ["exact_text", "contains_text", "state_transition", "invariant"],
                },
                probeInput: { type: "string", minLength: 1 },
                expectedObservation: { type: "string", minLength: 1 },
                forbiddenObservations: STRING_ARRAY_SCHEMA,
                oracleSourceRefs: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: { type: "string", minLength: 1 },
                      locator: { type: "string", minLength: 1 },
                    },
                    required: ["kind", "locator"],
                  },
                },
                candidateIndependent: { type: "boolean", enum: [true] },
              },
              required: [
                "observationKind", "probeInput", "expectedObservation", "forbiddenObservations",
                "oracleSourceRefs", "candidateIndependent",
              ],
            },
          },
          required: [
            "requirement", "predicateId", "verificationMethod", "allowedFiles", "sourceRefs",
            "expectedEvidence", "evidenceOrigin", "requiresRealPathEvidence", "observableContract",
          ],
        },
      },
      changeScope: STRING_ARRAY_SCHEMA,
      invariants: STRING_ARRAY_SCHEMA,
      implementationSteps: STRING_ARRAY_SCHEMA,
      verification: STRING_ARRAY_SCHEMA,
      unresolvedAssumptions: STRING_ARRAY_SCHEMA,
    },
    required: [
      "proposalId", "planMarkdown", "problemModel", "claims", "decomposedItems",
      "changeScope", "invariants", "implementationSteps", "verification", "unresolvedAssumptions",
    ],
  };
}

function planProposalEnvelopeSchema(proposalId: "A" | "B"): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["ok"] },
      proposal: planProposalObjectSchema(proposalId),
    },
    required: ["status", "proposal"],
  };
}

function planCritiqueEnvelopeSchema(reviewer: "A" | "B"): JsonSchema {
  const targetProposalId = reviewer === "A" ? "B" : "A";
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["ok"] },
      critique: {
        type: "object",
        additionalProperties: false,
        properties: {
          reviewer: { type: "string", enum: [reviewer] },
          targetProposalId: { type: "string", enum: [targetProposalId] },
          objections: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                objectionId: { type: "string", minLength: 1 },
                targetClaimId: { type: "string", minLength: 1 },
                severity: { type: "string", minLength: 1 },
                statement: { type: "string", minLength: 1 },
                evidenceRefs: STRING_ARRAY_SCHEMA,
                falsificationProbe: { type: "string", minLength: 1 },
                requiredRevision: { type: "string", minLength: 1 },
              },
              required: [
                "objectionId", "targetClaimId", "severity", "statement", "evidenceRefs",
                "falsificationProbe", "requiredRevision",
              ],
            },
          },
          acceptedClaims: STRING_ARRAY_SCHEMA,
          unresolvedDisputes: RECORD_ARRAY_SCHEMA,
        },
        required: ["reviewer", "targetProposalId", "objections", "acceptedClaims", "unresolvedDisputes"],
      },
    },
    required: ["status", "critique"],
  };
}

function planArbitrationEnvelopeSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["ok"] },
      arbitration: {
        type: "object",
        additionalProperties: false,
        properties: {
          decision: { type: "string", enum: ["A", "B", "merge", "unresolved"] },
          reason: { type: "string", minLength: 1 },
          proposal: {
            anyOf: [planProposalObjectSchema("A"), planProposalObjectSchema("B"), { type: "null" }],
          },
          acceptedConstraints: STRING_ARRAY_SCHEMA,
          rejectedAlternatives: RECORD_ARRAY_SCHEMA,
        },
        required: ["decision", "reason", "proposal", "acceptedConstraints", "rejectedAlternatives"],
      },
    },
    required: ["status", "arbitration"],
  };
}

/** Return the native Claude structured-output contract for a tournament role. */
export function claudePlanningJsonSchemaForRole(role: string): JsonSchema | null {
  const proposalMatch = role.match(/^(?:planner|revision)_([ab])(?:_|$)/);
  if (proposalMatch) return planProposalEnvelopeSchema(proposalMatch[1] === "a" ? "A" : "B");
  const critiqueMatch = role.match(/^critic_([ab])(?:_|$)/);
  if (critiqueMatch) return planCritiqueEnvelopeSchema(critiqueMatch[1] === "a" ? "A" : "B");
  if (role === "plan_arbiter" || role.startsWith("plan_arbiter_")) return planArbitrationEnvelopeSchema();
  return null;
}

async function getRegistry(): Promise<AgentRegistryModule | null> {
  if (_registryCache) return _registryCache;
  if (_registryLoadPromise) return _registryLoadPromise;
  _registryLoadPromise = (async () => {
    try {
      const mod = await import("../../../core/agents/registry.js");
      const registry: AgentRegistryModule = {
        loadRegistry: (configDir = "") => mod.loadRegistry(configDir),
        listAgentNames: () => mod.listAgentNames(),
        getDescriptor: (agent: string) => mod.getDescriptor(agent),
      };
      await registry.loadRegistry();
      _registryCache = registry;
      return registry;
    } catch {
      _registryCache = null;
      return null;
    } finally {
      _registryLoadPromise = null;
    }
  })();
  return _registryLoadPromise;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// One-shot pool children are acp-client wrappers. On SIGTERM the wrapper runs
// AcpClient.close(), which closes its own detached provider process and waits up
// to roughly 2s. Killing the wrapper after 500ms interrupts that cleanup and can
// leave codex-acp/codegraph grandchildren orphaned.
const CHILD_TERM_GRACE_MS = 3_000;
const CHILD_KILL_GRACE_MS = 1_500;
// The phase timeout covers provider work. The one-shot wrapper still needs a
// bounded window to close the ACP session and reap the detached provider after
// the final response has been streamed. Without this grace a response that
// completes just before the phase deadline is discarded while acp-client is
// doing successful cleanup (the child then reports code=null).
const ONE_SHOT_CLOSE_GRACE_MS = 3_000;
const DEFAULT_PROVIDER_CONNECTION_LIMIT = 3;
const CONNECTION_LOCK_TTL_MS = 30_000;
const CONNECTION_POLL_MS = 50;
const POOL_WAIT_WARN_INTERVAL_MS = 30_000;

function resolveHubRootFromEnv(cpbRoot: string, env: EnvRecord = {}) {
  if (typeof env.CPB_HUB_ROOT === "string" && env.CPB_HUB_ROOT) return path.resolve(env.CPB_HUB_ROOT);
  const home = os.homedir();
  return home ? path.join(home, ".cpb") : path.join(path.resolve(cpbRoot), ".cpb", "hub");
}

function emptyUsageRollup(): UsageRollup {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    toolCalls: 0,
    functionCalls: 0,
    events: 0,
    tokenSource: null,
    reported: new Set(),
  };
}

function addUsageRollup(target: UsageRollup, usage: LooseRecord = {}) {
  for (const key of USAGE_NUMBER_FIELDS) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] += value;
      target.reported.add(key);
    }
  }
  target.tokenSource = typeof usage.tokenSource === "string"
    ? usage.tokenSource
    : target.tokenSource || "acp_audit";
}

function finalizeUsageRollup(rollup: UsageRollup, { tokenEvents = 0, toolCalls = 0, source = "acp_audit" }: UsageFinalizeOptions = {}) {
  if (rollup.events <= 0 && tokenEvents <= 0) {
    return toolCalls > 0
      ? {
          ...Object.fromEntries(USAGE_NUMBER_FIELDS.map((key) => [key, key === "toolCalls" ? toolCalls : null])),
          events: 0,
          tokenSource: "acp_not_reported",
        }
      : null;
  }
  const result = Object.fromEntries(USAGE_NUMBER_FIELDS.map((key) => [
    key,
    rollup.reported.has(key) ? rollup[key] : null,
  ])) as LooseRecord;
  // Tool calls are observed directly in the ACP audit even when the adapter's
  // token payload omits a toolCalls field, so zero is a real measurement here.
  if (!rollup.reported.has("toolCalls")) result.toolCalls = toolCalls;
  result.events = Math.max(rollup.events, tokenEvents);
  result.tokenSource = rollup.tokenSource ? `${source}:${rollup.tokenSource}` : source;
  return result;
}

function auditEventMatches(event: UsageAuditEvent, { phase = null, role = null }: UsageFilter = {}) {
  if (phase && event.phase !== phase) return false;
  if (role && event.role !== role) return false;
  return true;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

async function reportPoolProgress(onProgress: ProgressReporter | null | undefined, event: LooseRecord) {
  if (typeof onProgress !== "function") return;
  try {
    await onProgress({ ts: new Date().toISOString(), ...event });
  } catch {
    // Progress reporting must never alter provider execution outcome.
  }
}

function acpActivityLines(agent: string, chunk: string | Buffer): string[] {
  const prefix = `[acp:${agent}]`;
  return String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
}

export async function readAcpUsageFromAudit(auditFile: string | null, filter: UsageFilter = {}) {
  if (!auditFile) return null;
  let raw;
  try {
    raw = await readFile(auditFile, "utf8");
  } catch {
    return null;
  }

  const promptRollup = emptyUsageRollup();
  const tokenRollup = emptyUsageRollup();
  let promptEvents = 0;
  let tokenEvents = 0;
  let toolCalls = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const event: UsageAuditEvent = parsed;
    if (!auditEventMatches(event, filter)) continue;
    if (event.event === "tool_call") toolCalls += 1;
    if (event.event === "prompt_usage" && isRecord(event.usage)) {
      addUsageRollup(promptRollup, event.usage);
      promptEvents += 1;
    } else if (event.event === "token_usage" && isRecord(event.usage)) {
      addUsageRollup(tokenRollup, event.usage);
      tokenEvents += 1;
    }
  }

  if (promptEvents > 0) {
    return finalizeUsageRollup(promptRollup, {
      tokenEvents: promptEvents,
      toolCalls,
      source: "acp_audit_prompt_usage",
    });
  }
  return finalizeUsageRollup(tokenRollup, {
    tokenEvents,
    toolCalls,
    source: "acp_audit_token_usage",
  });
}

export class RateLimitError extends Error {
  agent: string;
  untilTs: number;

  constructor(agent: string, untilTs: number, message = "ACP provider is rate limited") {
    super(`${message}: ${agent} until ${new Date(untilTs).toISOString()}`);
    this.name = "RateLimitError";
    this.agent = agent;
    this.untilTs = untilTs;
  }
}

/**
 * Structured ACP execution error with partial stdout/stderr for handoff bundles.
 */
export class AcpExecutionError extends Error {
  agent: string;
  providerKey: string;
  partialStdout: string;
  partialStderr: string;
  exitCode: number | null;
  signal: string | null;
  phase: string | null;
  role: string | null;
  quota: LooseRecord | null;

  constructor(message: string, {
    agent,
    providerKey,
    stdout = "",
    stderr = "",
    exitCode = null,
    signal = null,
    phase = null,
    role = null,
    quota = null,
  }: { agent?: string; providerKey?: string; stdout?: string; stderr?: string; exitCode?: number | null; signal?: string | null; phase?: string | null; role?: string | null; quota?: LooseRecord | null } = {}) {
    super(message);
    this.name = "AcpExecutionError";
    this.agent = agent ?? "";
    this.providerKey = providerKey || agent || "";
    this.partialStdout = String(stdout || "").slice(-4000);
    this.partialStderr = String(stderr || "").slice(-4000);
    this.exitCode = exitCode;
    this.signal = signal;
    this.phase = phase;
    this.role = role;
    this.quota = quota; // ProviderQuotaError if this was a quota failure
  }
}

export class PoolExhaustedError extends Error {
  code: string;
  agent: string;
  providerKey: string;
  elapsedMs: number;

  constructor(agent: string, providerKey: string, elapsedMs: number, message?: string) {
    super(message || `ACP pool exhausted: ${agent}/${providerKey} waited ${Math.round(elapsedMs / 1000)}s`);
    this.name = "PoolExhaustedError";
    this.code = "POOL_EXHAUSTED";
    this.agent = agent;
    this.providerKey = providerKey;
    this.elapsedMs = elapsedMs;
  }
}

function agentEnvName(agent: string) {
  return String(agent || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

const CLAUDE_COMPATIBLE_AGENT_VARIANTS: Record<string, string> = {
  "claude-glm": "glm",
  "claude-mimo": "mimo-v2.5pro",
};

function isClaudeCompatibleAgent(agent: string) {
  return agent === "claude" || Boolean(CLAUDE_COMPATIBLE_AGENT_VARIANTS[agent]);
}

export function providerVariantForAgent(agent: string, variant: string | null = null) {
  return variant || CLAUDE_COMPATIBLE_AGENT_VARIANTS[agent] || null;
}

export function providerKeyForAgent(agent: string, env: EnvRecord = {}, variant: string | null = null) {
  const providerVariant = providerVariantForAgent(agent, variant);
  if (isClaudeCompatibleAgent(agent)) {
    if (providerVariant) return `claude:${providerVariant}`;
    const config = resolveVariantConfig(env);
    return config.variant && config.variant !== "none"
      ? `claude:${config.variant}`
      : "claude";
  }

  if (variant) return `${agent}:${variant}`;
  return agent;
}

function variantNameFromProviderKey(providerKey: string, agent: string) {
  const prefix = `${agent}:`;
  return providerKey.startsWith(prefix) ? providerKey.slice(prefix.length) : null;
}

function variantNameForProviderKey(providerKey: string, agent: string) {
  return variantNameFromProviderKey(providerKey, isClaudeCompatibleAgent(agent) ? "claude" : agent);
}

export function envForAgent(agent: string, env: EnvRecord = {}, variant: string | null = null): EnvRecord {
  const next: EnvRecord = { ...env };
  const providerVariant = providerVariantForAgent(agent, variant);

  if (providerVariant) {
    next.CPB_ACP_AGENT_VARIANT = providerVariant;
    next[`CPB_ACP_${agentEnvName(agent)}_VARIANT`] = providerVariant;
  }

  if (isClaudeCompatibleAgent(agent)) {
    if (providerVariant) next.CPB_CLAUDE_VARIANT = providerVariant;
    applyVariantToEnv(next);
  }

  return next;
}

function acpMetadataEnv(options: AcpMetadataOptions = {}) {
  const meta: Record<string, string> = {};
  if (options.projectId) meta.CPB_ACP_PROJECT = options.projectId;
  if (options.jobId) meta.CPB_ACP_JOB_ID = options.jobId;
  if (options.dataRoot) meta.CPB_PROJECT_RUNTIME_ROOT = options.dataRoot;
  if (options.phase) meta.CPB_ACP_PHASE = options.phase;
  if (options.role) meta.CPB_ACP_ROLE = options.role;
  if (options.poolScope) meta.CPB_ACP_POOL_SCOPE = options.poolScope;
  if (options.controlPlane) meta.CPB_ACP_CONTROL_PLANE = "1";
  const homeInstanceId = conversationAgentHomeInstanceId(stringValue(options.conversationKey));
  if (homeInstanceId) meta.CPB_AGENT_HOME_INSTANCE_ID = homeInstanceId;
  return meta;
}

function childEnvWithoutControlPlaneAuditPath(env: NodeJS.ProcessEnv) {
  const childEnv = { ...env };
  delete childEnv.CPB_ACP_AUDIT_FILE;
  delete childEnv.CPB_ACP_AUDIT;
  if (childEnv.CPB_ACP_CONTROL_PLANE === "1") {
    delete childEnv.CPB_PROJECT_RUNTIME_ROOT;
    delete childEnv.CPB_ACP_PROJECT;
    delete childEnv.CPB_ACP_JOB_ID;
    delete childEnv.CPB_PROVIDER_PREFLIGHT_NONCE;
  }
  return childEnv;
}

// Re-export from provider-quota (redaction unified there)
export { sanitizeProviderReason } from "../provider-quota.js";

async function normalizeLimitsAsync(limits: LooseRecord = {}) {
  const registry = await getRegistry();

  const result: LooseRecord = { ...limits };

  if (registry) {
    for (const agent of registry.listAgentNames()) {
      if (!(agent in result)) {
        result[agent] = registry.getDescriptor(agent)?.poolLimit || 1;
      }
    }
  }

  return result;
}

// Sync fallback for constructor (registry not loaded yet)
function normalizeLimits(limits: LooseRecord = {}) {
  const result: LooseRecord = { ...limits };
  if (!result.codex) result.codex = 1;
  if (!result.claude) result.claude = 1;
  return result;
}

function numericOption(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function resolvePoolWaitTimeoutMs(value: unknown = "") {
  return numericOption(value, 0);
}

function booleanOption(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function positiveIntOption(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function providerEnvKey(providerKey: string) {
  return String(providerKey || "unknown").toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

const DEFAULT_PROVIDER_FALLBACKS: Readonly<Record<string, readonly ProviderFallbackCandidate[]>> = Object.freeze({
  // GLM is the normal low-cost executor in CPB.  MiMo is an independent
  // Claude-compatible provider and is therefore safe to use when GLM is
  // quota-blocked or its transport becomes unavailable.  Keep this mapping
  // provider-key based so the handoff is auditable and never masquerades as
  // another GLM request.
  "claude:glm": Object.freeze([
    Object.freeze({
      providerKey: "claude:mimo-v2.5pro",
      agent: "claude-mimo",
      variant: "mimo-v2.5pro",
      providerFallback: true,
    }),
  ]),
});

function parseProviderFallbacks(value: unknown): LooseRecord | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedProviderFallbackCandidate(value: unknown): ProviderFallbackCandidate | null {
  if (!isRecord(value)) return null;
  const providerKey = typeof value.providerKey === "string" ? value.providerKey.trim() : "";
  const agent = typeof value.agent === "string"
    ? value.agent.trim()
    : typeof value.name === "string"
      ? value.name.trim()
      : "";
  if (!providerKey || !agent) return null;
  const variant = typeof value.variant === "string" && value.variant.trim()
    ? value.variant.trim()
    : null;
  return { providerKey, agent, variant, providerFallback: true };
}

function normalizeProviderFallbacks(value: unknown): Record<string, ProviderFallbackCandidate[]> {
  const configured = parseProviderFallbacks(value);
  const entries = configured ? Object.entries(configured) : [];
  const result: Record<string, ProviderFallbackCandidate[]> = {};

  // The built-in mapping is always present.  Operators may override a key in
  // CPB_ACP_PROVIDER_FALLBACKS without losing the safe default for unrelated
  // providers.  An explicitly configured empty array disables that key.
  for (const [key, candidates] of Object.entries(DEFAULT_PROVIDER_FALLBACKS)) {
    result[key] = candidates.map((candidate) => ({ ...candidate }));
  }
  for (const [rawKey, rawCandidates] of entries) {
    const key = rawKey.trim();
    if (!key) continue;
    if (!Array.isArray(rawCandidates)) {
      result[key] = [];
      continue;
    }
    result[key] = rawCandidates
      .map((candidate) => normalizedProviderFallbackCandidate(candidate))
      .filter((candidate): candidate is ProviderFallbackCandidate => Boolean(candidate));
  }
  return result;
}

function serializableProviderFallbacks(fallbacks: Record<string, ProviderFallbackCandidate[]>) {
  return Object.fromEntries(Object.entries(fallbacks).map(([key, candidates]) => [
    key,
    candidates.map(({ providerKey, agent, variant }) => ({ providerKey, agent, variant })),
  ]));
}

function createAbortError(message = "ACP pool request aborted") {
  const error = new Error(message) as Error & { code?: string };
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function abortErrorForSignal(signal: AbortSignal | undefined, message?: string) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return createAbortError(message || (reason ? String(reason) : undefined));
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined, message?: string) {
  if (signal?.aborted) throw abortErrorForSignal(signal, message);
}

function addAbortHandler(signal: AbortSignal | undefined, onAbort: () => void) {
  if (!signal) return () => {};
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function cleanupPendingPoolRequest(entry: PendingPoolRequest) {
  if (entry._timer) clearTimeout(entry._timer);
  if (entry._warnTimer) clearInterval(entry._warnTimer);
  entry._abortCleanup?.();
  entry._timer = undefined;
  entry._warnTimer = undefined;
  entry._abortCleanup = undefined;
}

function sleep(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const cleanup = addAbortHandler(signal, () => {
      if (timer) clearTimeout(timer);
      reject(abortErrorForSignal(signal));
    });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

async function raceWithAbort<T>(work: Promise<T>, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (!signal) return work;
  let abortCleanup: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortCleanup = addAbortHandler(signal, () => reject(abortErrorForSignal(signal)));
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    abortCleanup?.();
  }
}

export function normalizeClaudeApiRetryEvent(value: unknown): ClaudeApiRetryEvent | null {
  if (!isRecord(value) || value.type !== "system" || value.subtype !== "api_retry") return null;
  const attempt = Number(value.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  const maxRetriesValue = value.max_retries == null ? null : Number(value.max_retries);
  const retryDelayValue = value.retry_delay_ms == null ? null : Number(value.retry_delay_ms);
  const statusValue = value.error_status == null ? null : Number(value.error_status);
  return {
    attempt,
    maxRetries: Number.isInteger(maxRetriesValue) && Number(maxRetriesValue) >= 1 ? Number(maxRetriesValue) : null,
    retryDelayMs: Number.isFinite(retryDelayValue) && Number(retryDelayValue) >= 0 ? Number(retryDelayValue) : null,
    httpStatus: Number.isInteger(statusValue) && Number(statusValue) >= 100 ? Number(statusValue) : null,
    error: typeof value.error === "string" ? value.error : null,
    sessionId: typeof value.session_id === "string" ? value.session_id : null,
    uuid: typeof value.uuid === "string" ? value.uuid : null,
  };
}

function claudeToolKind(name: string): ClaudeCliToolAuditEvent["kind"] {
  if (name === "Bash") return "execute";
  if (name === "Read") return "read";
  if (name === "Grep" || name === "Glob") return "search";
  if (name === "Edit" || name === "Write") return "edit";
  return "other";
}

function claudeToolTitle(name: string, input: LooseRecord) {
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  const pathValue = typeof input.path === "string" ? input.path : "";
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const command = typeof input.command === "string" ? input.command : "";
  const title = name === "Bash"
    ? command
    : name === "Read" || name === "Edit" || name === "Write"
      ? filePath
      : name === "Grep" || name === "Glob"
        ? [pattern, pathValue].filter(Boolean).join(" @ ")
        : name;
  return title.slice(0, 4_000);
}

/** Normalize Claude CLI native tool-use records into the same audit shape ACP uses. */
export function normalizeClaudeCliToolAuditEvents(value: unknown): ClaudeCliToolAuditEvent[] {
  if (!isRecord(value)) return [];
  const sessionId = typeof value.session_id === "string" ? value.session_id : null;
  const message: LooseRecord = isRecord(value.message) ? value.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  if (value.type === "assistant") {
    return content.map((entry) => isRecord(entry) ? entry : {})
      .filter((entry) => entry.type === "tool_use" && typeof entry.id === "string")
      .map((entry) => {
        const toolName = typeof entry.name === "string" ? entry.name : "unknown";
        const input = isRecord(entry.input) ? entry.input : {};
        return {
          event: "tool_call" as const,
          toolCallId: String(entry.id),
          title: claudeToolTitle(toolName, input),
          status: "in_progress" as const,
          kind: claudeToolKind(toolName),
          toolName,
          sessionId,
        };
      });
  }
  if (value.type === "user") {
    return content.map((entry) => isRecord(entry) ? entry : {})
      .filter((entry) => entry.type === "tool_result" && typeof entry.tool_use_id === "string")
      .map((entry) => ({
        event: "tool_call" as const,
        toolCallId: String(entry.tool_use_id),
        status: entry.is_error === true ? "failed" as const : "completed" as const,
        sessionId,
      }));
  }
  return [];
}

/**
 * Claude CLI implements --json-schema through an internal StructuredOutput
 * tool. Compatible providers can submit a complete object and then keep
 * reasoning, so preserve every complete tool input for terminal recovery.
 */
export function claudeStructuredOutputCandidates(value: unknown): string[] {
  if (!isRecord(value) || value.type !== "assistant") return [];
  const message: LooseRecord = isRecord(value.message) ? value.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((entry) => isRecord(entry) ? entry : {})
    .filter((entry) => entry.type === "tool_use" && entry.name === "StructuredOutput" && isRecord(entry.input))
    .map((entry) => JSON.stringify(entry.input));
}

export function resolveClaudePlanningMaxTurns({
  configured,
  repositoryDiscovery,
  structuredOutput,
  toolCallBudget,
}: {
  configured?: unknown;
  repositoryDiscovery: boolean;
  structuredOutput: boolean;
  toolCallBudget: number;
}) {
  // A configured positive value is an explicit test/operator cap. With no
  // explicit value, omit --max-turns entirely so the provider can spend the
  // time and tool calls needed to produce a correct plan.
  const explicit = positiveIntOption(configured, 0);
  if (explicit > 0) return explicit;
  if (configured !== undefined && configured !== null && String(configured).trim() !== "") return 0;
  void repositoryDiscovery;
  void structuredOutput;
  void toolCallBudget;
  return 0;
}

function connectionLeaseFrom(value: unknown, filePath: string): ConnectionLease | null {
  if (!isRecord(value)) return null;
  const pid = typeof value.pid === "number" || typeof value.pid === "string" ? Number(value.pid) : NaN;
  const processIdentity = processIdentityFrom(value.processIdentity, pid);
  if (!Number.isInteger(pid) || pid <= 0 || !processIdentity) return null;
  return {
    leaseId: typeof value.leaseId === "string" ? value.leaseId : undefined,
    ownerToken: typeof value.ownerToken === "string" ? value.ownerToken : undefined,
    generation: typeof value.generation === "string" ? value.generation : undefined,
    pid,
    processIdentity,
    agent: typeof value.agent === "string" ? value.agent : undefined,
    providerKey: typeof value.providerKey === "string" ? value.providerKey : undefined,
    phase: typeof value.phase === "string" ? value.phase : null,
    role: typeof value.role === "string" ? value.role : null,
    poolScope: typeof value.poolScope === "string" ? value.poolScope : null,
    controlPlane: Boolean(value.controlPlane),
    acquiredAt: typeof value.acquiredAt === "string" ? value.acquiredAt : undefined,
    filePath,
  };
}

function acpPoolError(message: string, code: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function acpErrorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code || "";
}

function acpErrorCauseCode(error: unknown) {
  return acpErrorCode((error as Error | undefined)?.cause);
}

function processIdentityFrom(value: unknown, expectedPid?: number): ProcessIdentity | null {
  if (!isRecord(value)) return null;
  const pid = Number(value.pid);
  const capturedAt = typeof value.capturedAt === "string" ? value.capturedAt : "";
  const processGroupId = Number(value.processGroupId);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (expectedPid !== undefined && (!Number.isSafeInteger(expectedPid) || pid !== expectedPid)) return null;
  if (typeof value.birthId !== "string" || !value.birthId) return null;
  if (value.incarnation !== `${pid}:${value.birthId}`) return null;
  if (value.birthIdPrecision !== "exact") return null;
  if (
    !capturedAt
    || Number.isNaN(new Date(capturedAt).getTime())
    || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
  ) return null;
  if (value.processGroupId !== undefined && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)) return null;
  return {
    pid,
    birthId: value.birthId,
    incarnation: value.incarnation,
    capturedAt,
    birthIdPrecision: "exact",
    ...(value.processGroupId === undefined ? {} : { processGroupId }),
  };
}

function exactProcessIdentity(identity: ProcessIdentity | null): ProcessIdentity | null {
  if (!identity || identity.birthIdPrecision !== "exact") return null;
  return identity;
}

let cachedCurrentExactProcessIdentity: ProcessIdentity | null = null;

function captureCurrentExactProcessIdentity() {
  if (!cachedCurrentExactProcessIdentity) {
    cachedCurrentExactProcessIdentity = exactProcessIdentity(captureProcessIdentity(process.pid, { strict: true }));
  }
  return cachedCurrentExactProcessIdentity ? { ...cachedCurrentExactProcessIdentity } : null;
}

function samePersistedProcessIdentity(
  expected: ProcessIdentity | null | undefined,
  actual: ProcessIdentity | null | undefined,
) {
  return sameProcessIdentity(expected, actual)
    && expected?.birthId === actual?.birthId
    && expected?.capturedAt === actual?.capturedAt
    && expected?.birthIdPrecision === actual?.birthIdPrecision
    && expected?.processGroupId === actual?.processGroupId;
}

function sameConnectionLeaseAuthority(expected: ConnectionLease, actual: ConnectionLease | null) {
  return Boolean(actual
    && actual.leaseId === expected.leaseId
    && actual.ownerToken === expected.ownerToken
    && actual.generation === expected.generation
    && actual.pid === expected.pid
    && actual.agent === expected.agent
    && actual.providerKey === expected.providerKey
    && actual.phase === expected.phase
    && actual.role === expected.role
    && actual.poolScope === expected.poolScope
    && actual.controlPlane === expected.controlPlane
    && actual.acquiredAt === expected.acquiredAt
    && samePersistedProcessIdentity(actual.processIdentity, expected.processIdentity));
}

function sameConnectionLockDirectoryAuthority(
  expected: ConnectionLockGeneration,
  actual: ConnectionLockGeneration,
) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.birthtimeMs === actual.birthtimeMs;
}

async function syncDirectory(
  directory: string,
  options: {
    phase?: ConnectionLockFsPhase;
    fault?: ConnectionLockFsHooks["directorySyncFault"];
  } = {},
) {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  const closeErrors: unknown[] = [];
  const invokeFault = async (stage: ConnectionLockDirectorySyncStage) => {
    if (options.phase) {
      await options.fault?.({ directory, phase: options.phase, stage });
    }
  };
  try {
    if (
      typeof constants.O_DIRECTORY !== "number"
      || constants.O_DIRECTORY === 0
      || typeof constants.O_NOFOLLOW !== "number"
      || constants.O_NOFOLLOW === 0
    ) {
      throw acpPoolError(
        `ACP strict directory sync flags are unavailable: ${directory}`,
        "ACP_POOL_STATE_UNSAFE",
      );
    }
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw acpPoolError(`ACP directory sync target is not a real directory: ${directory}`, "ACP_POOL_STATE_UNSAFE");
    }
    const beforeGeneration = connectionLockGeneration(before);
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    handle = await open(directory, flags);
    const opened = await handle.stat();
    if (!opened.isDirectory()
      || !sameConnectionLockDirectoryAuthority(beforeGeneration, connectionLockGeneration(opened))) {
      throw acpPoolError(`ACP directory sync target changed while opening: ${directory}`, "ACP_POOL_STATE_UNVERIFIED");
    }
    const openedGeneration = connectionLockGeneration(opened);
    const openedPath = await lstat(directory);
    if (!openedPath.isDirectory()
      || openedPath.isSymbolicLink()
      || !sameConnectionLockDirectoryAuthority(openedGeneration, connectionLockGeneration(openedPath))) {
      throw acpPoolError(`ACP directory sync path changed while opening: ${directory}`, "ACP_POOL_STATE_UNVERIFIED");
    }
    await invokeFault("after-open");
    await invokeFault("before-sync");
    await handle.sync();
    await invokeFault("after-sync");
    const afterDescriptor = await handle.stat();
    const afterPath = await lstat(directory);
    if (!afterDescriptor.isDirectory()
      || !afterPath.isDirectory()
      || afterPath.isSymbolicLink()
      || !sameConnectionLockDirectoryAuthority(openedGeneration, connectionLockGeneration(afterDescriptor))
      || !sameConnectionLockDirectoryAuthority(openedGeneration, connectionLockGeneration(afterPath))) {
      throw acpPoolError(`ACP directory sync target changed during sync: ${directory}`, "ACP_POOL_STATE_UNVERIFIED");
    }
  } catch (error) {
    primaryError = error;
  }
  if (handle) {
    try {
      await handle.close();
      handle = null;
      await invokeFault("after-primary-close");
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (handle) {
    try {
      await handle.close();
      handle = null;
      await invokeFault("after-fallback-close");
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (primaryError && closeErrors.length > 0) {
    throw Object.assign(new AggregateError(
      [primaryError, ...closeErrors],
      `ACP directory sync and close failed: ${directory}`,
      { cause: primaryError },
    ), {
      code: acpErrorCode(primaryError) || "ACP_DIRECTORY_SYNC_FAILED",
      primaryError,
      closeError: closeErrors[0],
      closeErrors,
      directory,
      phase: options.phase,
    });
  }
  if (primaryError) throw primaryError;
  if (closeErrors.length === 1) {
    throw Object.assign(acpPoolError(
      `ACP directory close failed: ${directory}`,
      acpErrorCode(closeErrors[0]) || "ACP_DIRECTORY_CLOSE_FAILED",
      closeErrors[0],
    ), {
      closeError: closeErrors[0],
      closeErrors,
      directory,
      phase: options.phase,
    });
  }
  if (closeErrors.length > 1) {
    throw Object.assign(new AggregateError(
      closeErrors,
      `ACP directory close attempts failed: ${directory}`,
      { cause: closeErrors[0] },
    ), {
      code: acpErrorCode(closeErrors[0]) || "ACP_DIRECTORY_CLOSE_FAILED",
      closeError: closeErrors[0],
      closeErrors,
      directory,
      phase: options.phase,
    });
  }
}

async function readRegularJsonNoFollow(filePath: string, label: string) {
  return (await readRegularJsonNoFollowWithIdentity(filePath, label))?.value ?? null;
}

function connectionLockGeneration(info: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}): ConnectionLockGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function connectionLockGenerationFrom(value: unknown): ConnectionLockGeneration | null {
  if (!isRecord(value)) return null;
  const generation = {
    dev: Number(value.dev),
    ino: Number(value.ino),
    size: Number(value.size),
    mtimeMs: Number(value.mtimeMs),
    ctimeMs: Number(value.ctimeMs),
    birthtimeMs: Number(value.birthtimeMs),
  };
  if (!Object.values(generation).every(Number.isFinite)
    || !Number.isSafeInteger(generation.dev)
    || !Number.isSafeInteger(generation.ino)
    || !Number.isSafeInteger(generation.size)
    || generation.size < 0) return null;
  return generation;
}

function sameConnectionLockGeneration(
  expected: ConnectionLockGeneration,
  actual: ConnectionLockGeneration,
) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

// A directory rename may update ctime while preserving the directory object.
// Capture a new full baseline immediately after the rename, and use these
// immutable fields only to prove that baseline came from the canonical object.
function sameConnectionLockAcrossRename(
  canonical: ConnectionLockGeneration,
  moved: ConnectionLockGeneration,
) {
  return canonical.dev === moved.dev
    && canonical.ino === moved.ino
    && canonical.size === moved.size
    && canonical.mtimeMs === moved.mtimeMs
    && canonical.birthtimeMs === moved.birthtimeMs;
}

function sameConnectionLockOwner(
  expected: ConnectionLockOwner | null,
  actual: ConnectionLockOwner | null,
) {
  if (!expected || !actual) return expected === actual;
  return expected.format === actual.format
    && expected.binding === actual.binding
    && expected.ownerToken === actual.ownerToken
    && expected.generation === actual.generation
    && expected.pid === actual.pid
    && expected.host === actual.host
    && expected.acquiredAt === actual.acquiredAt
    && samePersistedProcessIdentity(expected.processIdentity, actual.processIdentity)
    && (
      expected.identity && actual.identity
        ? sameConnectionLockGeneration(expected.identity, actual.identity)
        : expected.identity === actual.identity
    );
}

async function rewriteRegularJsonNoFollow(filePath: string, value: unknown, label: string) {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw acpPoolError(`${label} cannot be rewritten without no-follow support: ${filePath}`, "ACP_POOL_STATE_UNSAFE");
  }
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw acpPoolError(`${label} is not a real regular file: ${filePath}`, "ACP_POOL_STATE_UNSAFE");
  }
  const beforeGeneration = connectionLockGeneration(before);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  try {
    handle = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()
      || !sameConnectionLockGeneration(beforeGeneration, connectionLockGeneration(opened))) {
      throw acpPoolError(`${label} changed while opening for rewrite: ${filePath}`, "ACP_POOL_STATE_UNVERIFIED");
    }
    const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (serialized.length > opened.size) {
      throw acpPoolError(
        `${label} bound payload exceeds its preallocated pending record: ${filePath}`,
        "ACP_POOL_STATE_UNVERIFIED",
      );
    }
    // Keep the preallocated file size stable and replace the small record in
    // place. Trailing JSON whitespace is valid; avoiding truncate removes the
    // empty/partial-file window visible to concurrent lock contenders.
    const payload = Buffer.alloc(opened.size, 0x20);
    serialized.copy(payload);
    let offset = 0;
    while (offset < payload.length) {
      const { bytesWritten } = await handle.write(payload, offset, payload.length - offset, offset);
      if (bytesWritten <= 0) {
        throw acpPoolError(`${label} rewrite made no progress: ${filePath}`, "ACP_POOL_STATE_UNVERIFIED");
      }
      offset += bytesWritten;
    }
    await handle.sync();
    const afterDescriptor = await handle.stat();
    const afterPath = await lstat(filePath);
    if (!afterDescriptor.isFile()
      || !afterPath.isFile()
      || afterPath.isSymbolicLink()
      || !sameConnectionLockGeneration(
        connectionLockGeneration(afterDescriptor),
        connectionLockGeneration(afterPath),
      )) {
      throw acpPoolError(`${label} path changed during rewrite: ${filePath}`, "ACP_POOL_STATE_UNVERIFIED");
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
    throw Object.assign(new AggregateError(
      [primaryError, closeError],
      `${label} rewrite and close failed: ${filePath}`,
      { cause: primaryError },
    ), {
      code: acpErrorCode(primaryError) || "ACP_POOL_STATE_UNVERIFIED",
      primaryError,
      closeError,
    });
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
}

type BoundedReadFailureCode =
  | "BOUNDED_FILE_UNSAFE"
  | "BOUNDED_FILE_TOO_LARGE"
  | "BOUNDED_FILE_CHANGED"
  | "BOUNDED_FILE_READ_FAILED";

function boundedReadFailure(message: string, code: BoundedReadFailureCode, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

async function readBoundedRegularFileNoFollowWithIdentity(
  filePath: string,
  maxBytes: number,
  hooks: ConnectionLockBoundedReadHooks | undefined,
  invokeAfterVerifiedRead: boolean,
) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw boundedReadFailure(
      `no-follow file opens are unavailable for bounded read: ${filePath}`,
      "BOUNDED_FILE_UNSAFE",
    );
  }
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw boundedReadFailure(`bounded read requires a regular file: ${filePath}`, "BOUNDED_FILE_UNSAFE");
  }
  if (before.size > maxBytes) {
    throw boundedReadFailure(`file exceeds ${maxBytes} byte limit: ${filePath}`, "BOUNDED_FILE_TOO_LARGE");
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let value = "";
  let identity: ConnectionLockGeneration | null = null;
  let primaryError: unknown = null;
  try {
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (["ELOOP", "EMLINK"].includes(acpErrorCode(error))) {
        throw boundedReadFailure(
          `symbolic-link file rejected during bounded read: ${filePath}`,
          "BOUNDED_FILE_UNSAFE",
          error,
        );
      }
      throw error;
    }
    const opened = await handle.stat();
    const openedIdentity = connectionLockGeneration(opened);
    if (!opened.isFile()
      || !sameConnectionLockGeneration(connectionLockGeneration(before), openedIdentity)) {
      throw boundedReadFailure(`file changed while opening for bounded read: ${filePath}`, "BOUNDED_FILE_CHANGED");
    }
    await hooks?.afterOpen?.({ filePath, size: opened.size });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = maxBytes + 1 - totalBytes;
      if (remaining <= 0) {
        throw boundedReadFailure(`file exceeds ${maxBytes} byte limit: ${filePath}`, "BOUNDED_FILE_TOO_LARGE");
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, totalBytes);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw boundedReadFailure(`file exceeds ${maxBytes} byte limit: ${filePath}`, "BOUNDED_FILE_TOO_LARGE");
      }
      if (totalBytes > opened.size) {
        throw boundedReadFailure(`file grew during bounded read: ${filePath}`, "BOUNDED_FILE_CHANGED");
      }
      chunks.push(chunk.subarray(0, bytesRead));
      await hooks?.afterChunk?.({ filePath, bytesRead, totalBytes });
      const observed = await handle.stat();
      if (!observed.isFile()
        || !sameConnectionLockGeneration(openedIdentity, connectionLockGeneration(observed))) {
        throw boundedReadFailure(`file changed during bounded read: ${filePath}`, "BOUNDED_FILE_CHANGED");
      }
    }

    const afterDescriptor = await handle.stat();
    if (!afterDescriptor.isFile()
      || !sameConnectionLockGeneration(openedIdentity, connectionLockGeneration(afterDescriptor))) {
      throw boundedReadFailure(`file changed after bounded descriptor read: ${filePath}`, "BOUNDED_FILE_CHANGED");
    }
    await hooks?.beforePathGenerationCheck?.({ filePath, totalBytes });
    let afterPath;
    try {
      afterPath = await lstat(filePath);
    } catch (error) {
      throw boundedReadFailure(`file path disappeared after bounded read: ${filePath}`, "BOUNDED_FILE_CHANGED", error);
    }
    const verifiedIdentity = connectionLockGeneration(afterPath);
    if (!afterPath.isFile()
      || afterPath.isSymbolicLink()
      || !sameConnectionLockGeneration(openedIdentity, verifiedIdentity)) {
      throw boundedReadFailure(`file path changed after bounded read: ${filePath}`, "BOUNDED_FILE_CHANGED");
    }
    value = Buffer.concat(chunks, totalBytes).toString("utf8");
    identity = verifiedIdentity;
    if (invokeAfterVerifiedRead) {
      await hooks?.afterVerifiedRead?.({ filePath, totalBytes, identity: { ...verifiedIdentity } });
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
    throw Object.assign(new AggregateError(
      [primaryError, closeError],
      `bounded file read and close failed: ${filePath}`,
      { cause: primaryError },
    ), {
      code: acpErrorCode(primaryError) || "BOUNDED_FILE_READ_FAILED",
      primaryError,
      closeError,
    });
  }
  if (primaryError) throw primaryError;
  if (closeError) {
    throw boundedReadFailure(`bounded file close failed: ${filePath}`, "BOUNDED_FILE_READ_FAILED", closeError);
  }
  if (!identity) {
    throw boundedReadFailure(`bounded file generation unavailable after read: ${filePath}`, "BOUNDED_FILE_READ_FAILED");
  }
  return { value, identity };
}

async function readRegularJsonNoFollowWithIdentity(
  filePath: string,
  label: string,
  { invokeAfterVerifiedRead = true }: { invokeAfterVerifiedRead?: boolean } = {},
) {
  try {
    const bounded = await readBoundedRegularFileNoFollowWithIdentity(
      filePath,
      1024 * 1024,
      connectionLockBoundedReadHooksStorage.getStore(),
      invokeAfterVerifiedRead,
    );
    return {
      value: JSON.parse(bounded.value) as unknown,
      identity: bounded.identity,
    };
  } catch (error) {
    if (acpErrorCode(error) === "ENOENT") return null;
    if (["BOUNDED_FILE_UNSAFE", "BOUNDED_FILE_TOO_LARGE"].includes(acpErrorCode(error))) {
      throw acpPoolError(`${label} is not a safe bounded regular file: ${filePath}`, "ACP_POOL_STATE_UNSAFE", error);
    }
    if (acpErrorCode(error).startsWith("BOUNDED_FILE_")) {
      throw acpPoolError(`${label} changed while reading: ${filePath}`, "ACP_POOL_STATE_UNVERIFIED", error);
    }
    throw acpPoolError(`${label} is not valid JSON or cannot be inspected safely: ${filePath}`, "ACP_POOL_STATE_UNVERIFIED", error);
  }
}

async function assertSafeDirectoryNoFollow(directory: string, label: string) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (acpErrorCode(error) === "ENOENT") return null;
    throw acpPoolError(`${label} cannot be inspected safely: ${directory}`, "ACP_POOL_STATE_UNVERIFIED", error);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw acpPoolError(`${label} is not a real directory: ${directory}`, "ACP_POOL_STATE_UNSAFE");
  }
  return connectionLockGeneration(info);
}

async function writeJsonDurable(
  filePath: string,
  value: unknown,
  {
    operation,
    syncParent = () => syncDirectory(path.dirname(filePath)),
    fault,
  }: {
    operation: "connection-owner" | "connection-lease";
    syncParent?: () => Promise<void>;
    fault?: ConnectionLockFsHooks["durableWriteFault"];
  },
) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let tempIdentity: ConnectionLockGeneration | null = null;
  let tempCreated = false;
  let published = false;
  let tempEvidencePath: string | null = null;
  let tempAuthorityPreserved = false;
  let tempAuthorityVerified = false;
  let evidenceIdentity: ConnectionLockGeneration | null = null;
  let residualPath: string | null = null;
  let residualIdentity: ConnectionLockGeneration | null = null;
  let primaryError: unknown = null;
  const closeErrors: unknown[] = [];
  try {
    handle = await open(tempPath, "wx", 0o600);
    tempCreated = true;
    tempIdentity = connectionLockGeneration(await handle.stat());
    await fault?.({ operation, stage: "after-open", filePath, tempPath });
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    tempIdentity = connectionLockGeneration(await handle.stat());
    try {
      await handle.close();
      handle = null;
      await fault?.({ operation, stage: "after-primary-close", filePath, tempPath });
    } catch (error) {
      closeErrors.push(error);
      throw error;
    }
    try {
      await lstat(filePath);
      throw acpPoolError(`ACP durable JSON target already exists: ${filePath}`, "EEXIST");
    } catch (error) {
      if (acpErrorCode(error) !== "ENOENT") throw error;
    }
    await rename(tempPath, filePath);
    published = true;
    await fault?.({ operation, stage: "after-publish", filePath, tempPath });
    await syncParent();
  } catch (error) {
    primaryError = error;
  }

  if (handle) {
    try {
      await handle.close();
      handle = null;
      await fault?.({ operation, stage: "after-fallback-close", filePath, tempPath });
    } catch (error) {
      closeErrors.push(error);
    }
  }

  const cleanupErrors: unknown[] = [];
  if (!published && tempCreated) {
    const inspectResidual = async (candidatePath: string) => {
      try {
        return await readBoundedRegularFileNoFollowWithIdentity(
          candidatePath,
          1024 * 1024,
          undefined,
          false,
        );
      } catch (error) {
        if (acpErrorCode(error) === "ENOENT") return null;
        cleanupErrors.push(error);
        return null;
      }
    };
    const recordPreservedCandidate = async (candidatePath: string, acrossRename: boolean) => {
      const candidate = await inspectResidual(candidatePath);
      if (!candidate) return;
      const matchesExpected = tempIdentity && (
        acrossRename
          ? sameConnectionLockAcrossRename(tempIdentity, candidate.identity)
          : sameConnectionLockGeneration(tempIdentity, candidate.identity)
      );
      if (matchesExpected) {
        tempEvidencePath = candidatePath;
        tempAuthorityPreserved = true;
        tempAuthorityVerified = true;
        evidenceIdentity = candidate.identity;
        residualPath = candidatePath;
        residualIdentity = candidate.identity;
        return;
      }
      residualPath = candidatePath;
      residualIdentity = candidate.identity;
    };

    try {
      await fault?.({ operation, stage: "before-temp-cleanup", filePath, tempPath });
    } catch (error) {
      cleanupErrors.push(error);
    }

    let validatedIdentity: ConnectionLockGeneration | null = null;
    try {
      const tempInfo = await lstat(tempPath);
      const currentIdentity = connectionLockGeneration(tempInfo);
      if (!tempInfo.isFile()
        || tempInfo.isSymbolicLink()
        || !tempIdentity
        || !sameConnectionLockGeneration(tempIdentity, currentIdentity)) {
        throw acpPoolError(`ACP durable JSON temp changed before retirement: ${tempPath}`, "ACP_POOL_STATE_UNVERIFIED");
      }
      validatedIdentity = currentIdentity;
    } catch (error) {
      cleanupErrors.push(error);
      await recordPreservedCandidate(tempPath, false);
    }

    if (validatedIdentity) {
      try {
        await fault?.({ operation, stage: "after-temp-validation", filePath, tempPath });
      } catch (error) {
        cleanupErrors.push(error);
      }
      let afterHookIdentity: ConnectionLockGeneration | null = null;
      try {
        const afterHook = await lstat(tempPath);
        const currentIdentity = connectionLockGeneration(afterHook);
        if (!afterHook.isFile()
          || afterHook.isSymbolicLink()
          || !sameConnectionLockGeneration(validatedIdentity, currentIdentity)) {
          throw acpPoolError(`ACP durable JSON temp changed after retirement hook: ${tempPath}`, "ACP_POOL_STATE_UNVERIFIED");
        }
        afterHookIdentity = currentIdentity;
      } catch (error) {
        cleanupErrors.push(error);
        await recordPreservedCandidate(tempPath, false);
      }

      if (afterHookIdentity) {
        const isolatedPath = `${tempPath}.failed-${randomUUID()}`;
        let renamed = false;
        try {
          await rename(tempPath, isolatedPath);
          renamed = true;
          const movedInfo = await lstat(isolatedPath);
          const movedIdentity = connectionLockGeneration(movedInfo);
          if (!movedInfo.isFile()
            || movedInfo.isSymbolicLink()
            || !sameConnectionLockAcrossRename(afterHookIdentity, movedIdentity)) {
            throw acpPoolError(
              `ACP durable JSON temp retirement moved an unexpected generation: ${isolatedPath}`,
              "ACP_POOL_STATE_UNVERIFIED",
            );
          }
          const pinned = await readBoundedRegularFileNoFollowWithIdentity(
            isolatedPath,
            1024 * 1024,
            undefined,
            false,
          );
          if (!sameConnectionLockGeneration(movedIdentity, pinned.identity)) {
            throw acpPoolError(
              `ACP durable JSON retired temp changed during verification: ${isolatedPath}`,
              "ACP_POOL_STATE_UNVERIFIED",
            );
          }
          try {
            await syncParent();
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            const finalPinned = await readBoundedRegularFileNoFollowWithIdentity(
              isolatedPath,
              1024 * 1024,
              undefined,
              false,
            );
            if (!sameConnectionLockGeneration(pinned.identity, finalPinned.identity)) {
              throw acpPoolError(
                `ACP durable JSON retired temp changed after directory sync: ${isolatedPath}`,
                "ACP_POOL_STATE_UNVERIFIED",
              );
            }
            tempEvidencePath = isolatedPath;
            tempAuthorityPreserved = true;
            tempAuthorityVerified = true;
            evidenceIdentity = finalPinned.identity;
            residualPath = isolatedPath;
            residualIdentity = finalPinned.identity;
          } catch (error) {
            cleanupErrors.push(error);
            await recordPreservedCandidate(isolatedPath, true);
          }
        } catch (error) {
          cleanupErrors.push(error);
          await recordPreservedCandidate(renamed ? isolatedPath : tempPath, renamed);
        }
      }
    }
  }

  const cleanupError = cleanupErrors.length === 0
    ? null
    : cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, `ACP durable JSON temp retirement failed: ${tempPath}`, {
        cause: cleanupErrors[0],
      });
  if (!primaryError && closeErrors.length === 0 && !cleanupError) return;
  const causes = [primaryError, ...closeErrors, cleanupError]
    .filter((error, index, all) => error !== null && all.indexOf(error) === index);
  const cause = causes.length === 1
    ? causes[0]
    : new AggregateError(causes, `ACP durable JSON write failed: ${filePath}`, {
      cause: primaryError ?? causes[0],
    });
  if (published) {
    throw Object.assign(acpPoolError(
      `ACP durable JSON publish committed with ambiguous directory durability: ${filePath}`,
      "ACP_DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS",
      cause,
    ), {
      committed: true,
      phase: `${operation}-publish`,
      path: filePath,
      committedPath: filePath,
      recoveryPaths: { committed: filePath, parent: path.dirname(filePath) },
      primaryError,
      closeErrors,
    });
  }
  const failure = causes.length === 1
    ? acpPoolError(`ACP durable JSON write failed: ${filePath}`, "ACP_DURABLE_JSON_WRITE_FAILED", causes[0])
    : cause;
  throw Object.assign(failure, {
    code: "ACP_DURABLE_JSON_WRITE_FAILED",
    primaryCode: acpErrorCode(primaryError) || null,
    committed: false,
    path: filePath,
    tempPath,
    tempEvidencePath,
    tempAuthorityPreserved,
    tempAuthorityVerified,
    evidenceIdentity,
    residualPath,
    residualIdentity,
    recoveryPaths: {
      target: filePath,
      ...(tempEvidencePath ? { evidence: tempEvidencePath } : {}),
      ...(residualPath && residualPath !== tempEvidencePath ? { residual: residualPath } : {}),
      parent: path.dirname(filePath),
    },
    primaryError,
    closeErrors,
    cleanupError,
  });
}

function connectionOwnerAlive(identity: ProcessIdentity) {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    if (acpErrorCode(error) === "ESRCH") return false;
    throw error;
  }
  const current = identity.pid === process.pid
    ? captureCurrentExactProcessIdentity()
    : captureProcessIdentity(identity.pid, { strict: true });
  return sameProcessIdentity(identity, current);
}

export interface AcpPoolChildTerminationOptions {
  system?: ProcessTreeSystem;
  graceMs?: number;
  forceVerifyMs?: number;
}

export interface AcpPoolChildCleanupResult {
  attempted: boolean;
  cleanupVerified: boolean;
  rootIdentity: ProcessIdentity | null;
}

function processIdentityUnavailable(message: string) {
  return Object.assign(new Error(message), { code: "PROCESS_IDENTITY_UNAVAILABLE" });
}

function captureSpawnedChildIdentity(child: SpawnedChild) {
  if (!child.pid) {
    child.processIdentity = null;
    return null;
  }
  const identity = captureSpawnProcessIdentity(child);
  if (!identity) {
    throw processIdentityUnavailable(`ACP pool child process identity unavailable after spawn pid=${child.pid}`);
  }
  child.processIdentity = identity;
  return identity;
}

export async function terminateAcpPoolChild(
  child: AcpPoolSpawnedChild,
  {
    system,
    graceMs = CHILD_TERM_GRACE_MS,
    forceVerifyMs = CHILD_KILL_GRACE_MS,
  }: AcpPoolChildTerminationOptions = {},
): Promise<AcpPoolChildCleanupResult> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return {
      attempted: false,
      cleanupVerified: true,
      rootIdentity: child?.processIdentity || null,
    };
  }
  const rootIdentity = child.processIdentity;
  if (!rootIdentity) {
    throw processIdentityUnavailable(`ACP pool child teardown requires captured process identity pid=${child.pid}`);
  }
  await killTree(child.pid, graceMs, {
    expectedRootIdentity: rootIdentity,
    requireDescendantScan: true,
    forceVerifyMs,
    ...(system ? { system } : {}),
  });
  return { attempted: true, cleanupVerified: true, rootIdentity };
}

function terminateChild(child: SpawnedChild) {
  return terminateAcpPoolChild(child);
}

function asExecutionError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function primaryWithCleanupErrors(primary: unknown, cleanupErrors: Error[]) {
  const primaryError = asExecutionError(primary);
  if (cleanupErrors.length === 0) return primaryError;
  return Object.assign(
    new AggregateError([primaryError, ...cleanupErrors], primaryError.message, { cause: primaryError }),
    {
      code: (primaryError as NodeJS.ErrnoException).code,
      primaryError,
      cleanupErrors,
      cleanupVerified: false,
    },
  );
}

async function failureAfterCleanup(primary: unknown, cleanup: Promise<unknown>[]) {
  const settled = await Promise.allSettled(cleanup);
  const cleanupErrors = settled
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => asExecutionError(result.reason));
  return primaryWithCleanupErrors(primary, cleanupErrors);
}

function rejectAfterCleanup(
  reject: (error: Error) => void,
  primary: unknown,
  cleanup: Promise<unknown>[],
) {
  void failureAfterCleanup(primary, cleanup).then(reject);
}

function collectedCleanupError(message: string, cleanupErrors: Error[]) {
  if (cleanupErrors.length === 1) {
    const error = cleanupErrors[0] as Error & { cleanupErrors?: Error[]; cleanupVerified?: boolean };
    if (!error.cleanupErrors) error.cleanupErrors = cleanupErrors;
    error.cleanupVerified = false;
    return error;
  }
  return Object.assign(
    new AggregateError(cleanupErrors, message),
    { code: "ACP_POOL_CLEANUP_FAILED", cleanupErrors, cleanupVerified: false },
  );
}

function throwCollectedCleanupErrors(message: string, errors: unknown[]) {
  const cleanupErrors = errors.map(asExecutionError);
  if (cleanupErrors.length > 0) throw collectedCleanupError(message, cleanupErrors);
}

export class AcpPool {
  cpbRoot: string;
  hubRoot: string;
  leaseRoot: string;
  env: EnvRecord;
  limits: LooseRecord;
  runner: PoolRunner | null;
  persistentProcesses: boolean;
  maxSessionRequests: number;
  maxSessionAgeMs: number;
  sessionIdleMs: number;
  providerConnectionLimit: number;
  providerConnectionLimits: Record<string, number>;
  providerFallbacks: Record<string, ProviderFallbackCandidate[]>;
  connectionPollMs: number;
  active: Map<string, number>;
  activeProviders: Map<string, number>;
  pending: Map<string, PendingPoolRequest[]>;
  requestCount: Map<string, number>;
  errorCount: Map<string, number>;
  lastSpawnAt: Map<string, number>;
  spawnCount: Map<string, number>;
  recycleCount: Map<string, number>;
  liveRequests: Map<string, LivePoolRequest>;
  sessions: Map<string, PoolSession>;
  persistentClients: Map<string, PersistentClientState>;
  persistentChains: Map<string, Promise<unknown>>;
  oneShotChildren: Set<SpawnedChild>;
  lastRecycleReason: Map<string, string>;
  toolPolicyPromise: Promise<Map<string, string> | null> | null;
  connectionLockFsHooks: ConnectionLockFsHooks | null;
  _seq: number;
  stopped: boolean;
  createdAt: number;

  constructor(opts: AcpPoolOptions = {}) {
    const parentEnv = opts.env || process.env;
    this.cpbRoot = resolveAgentHomeRuntimeRoot(
      opts.cpbRoot || parentEnv.CPB_ROOT || path.join(__dirname, ".."),
      "CPB_ROOT",
    );
    this.hubRoot = path.resolve(opts.hubRoot || resolveHubRootFromEnv(this.cpbRoot, parentEnv));
    this.env = buildAcpPoolEnv(parentEnv, {
      CPB_ROOT: this.cpbRoot,
      CPB_ACP_CPB_ROOT: this.cpbRoot,
      CPB_HUB_ROOT: this.hubRoot,
      ...(parentEnv.CPB_PROJECT_RUNTIME_ROOT ? { CPB_PROJECT_RUNTIME_ROOT: parentEnv.CPB_PROJECT_RUNTIME_ROOT } : {}),
    });
    this.leaseRoot = path.resolve(
      opts.leaseRoot || this.env.CPB_ACP_POOL_LEASE_ROOT || this.hubRoot,
    );
    this.limits = normalizeLimits(opts.limits || opts);
    this.runner = opts.runner || null;
    this.persistentProcesses = !this.runner && booleanOption(
      opts.persistentProcesses ?? this.env.CPB_ACP_PERSISTENT_PROCESS,
      false,
    );
    this.maxSessionRequests = Math.max(
      0,
      numericOption(opts.maxSessionRequests ?? this.env.CPB_ACP_POOL_MAX_REQUESTS, 0),
    );
    this.maxSessionAgeMs = Math.max(
      0,
      numericOption(opts.maxSessionAgeMs ?? this.env.CPB_ACP_POOL_MAX_AGE_MS, 0),
    );
    this.sessionIdleMs = Math.max(
      0,
      numericOption(opts.sessionIdleMs ?? this.env.CPB_ACP_POOL_IDLE_MS, 0),
    );
    this.providerConnectionLimit = positiveIntOption(
      opts.providerConnectionLimit ?? this.env.CPB_ACP_POOL_PROVIDER_MAX,
      DEFAULT_PROVIDER_CONNECTION_LIMIT,
    );
    this.providerConnectionLimits = opts.providerConnectionLimits || {};
    this.providerFallbacks = normalizeProviderFallbacks(
      opts.providerFallbacks ?? this.env.CPB_ACP_PROVIDER_FALLBACKS,
    );
    this.connectionPollMs = positiveIntOption(
      opts.connectionPollMs ?? this.env.CPB_ACP_POOL_CONNECTION_POLL_MS,
      CONNECTION_POLL_MS,
    );
    this.active = new Map();
    this.activeProviders = new Map();
    this.pending = new Map();
    this.requestCount = new Map();
    this.errorCount = new Map();
    this.lastSpawnAt = new Map();
    this.spawnCount = new Map();
    this.recycleCount = new Map();
    this.liveRequests = new Map();
    this.sessions = new Map();
    this.persistentClients = new Map();
    this.persistentChains = new Map();
    this.oneShotChildren = new Set();
    this.lastRecycleReason = new Map();
    this.toolPolicyPromise = null;
    this.connectionLockFsHooks = opts.connectionLockFsHooks || null;
    this._seq = 0;
    this.stopped = false;
    this.createdAt = Date.now();
  }

  async init() {
    const registry = await getRegistry();
    if (registry) {
      this.limits = await normalizeLimitsAsync(this.limits);
    }
    return this;
  }

  async start() {
    await this.init();
    return this.status();
  }

  async stop() {
    this.stopped = true;
    await Promise.all([...this.oneShotChildren].map((child) => terminateChild(child)));
    this.oneShotChildren.clear();
    await Promise.all([...this.persistentClients.keys()].map((agent) => this.#closePersistentClient(agent)));
    for (const queue of this.pending.values()) {
      while (queue.length) {
        const item = queue.shift();
        if (!item) continue;
        cleanupPendingPoolRequest(item);
        item.reject(new Error("ACP pool stopped"));
      }
    }
    this.pending.clear();
    this.liveRequests.clear();
    this.active.clear();
    this.sessions.clear();
    this.activeProviders.clear();
    this.persistentChains.clear();
  }

  async releaseWorktree(cwd: string, reason: string | Record<string, unknown> = "worktree_release", options: Record<string, unknown> = {}) {
    if (!cwd) return false;
    const releaseReason = typeof reason === "string" ? reason : "worktree_release";
    if (reason && typeof reason === "object") {
      options = reason;
    }
    const closeProvider = Boolean(options.closeProvider || options.closePersistent);
    const target = path.resolve(cwd);
    let released = false;
    const cleanupErrors: unknown[] = [];
    for (const [key, persistent] of [...this.persistentClients.entries()]) {
      const clientCwd = persistent.client?.activeSessionCwd
        ? path.resolve(persistent.client.activeSessionCwd)
        : null;
      const launchCwd = persistent.launchCwd ? path.resolve(persistent.launchCwd) : null;
      const lastCwd = persistent.lastCwd ? path.resolve(persistent.lastCwd) : null;
      const activeMatches = clientCwd === target;
      let terminalCleanupCount = 0;
      try {
        terminalCleanupCount = await persistent.client.cleanupTerminalsForCwd(target, { reason: releaseReason });
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (persistent.launchScopedMcp || closeProvider) {
        if (!activeMatches && launchCwd !== target && lastCwd !== target && terminalCleanupCount === 0) continue;
        try {
          await this.#closePersistentClient(key);
        } catch (error) {
          cleanupErrors.push(error);
          continue;
        }
      } else {
        if (activeMatches) {
          try {
            await persistent.client.closeActiveSession(releaseReason);
          } catch (error) {
            cleanupErrors.push(error);
            continue;
          }
        }
        if (!activeMatches && terminalCleanupCount === 0) continue;
      }
      released = true;
    }
    throwCollectedCleanupErrors("ACP pool worktree release cleanup failed", cleanupErrors);
    return released;
  }

  async releaseJob(projectId: string, jobId: string, reason = "job_release") {
    const targetProjectId = stringValue(projectId);
    const targetJobId = stringValue(jobId);
    if (!targetProjectId || !targetJobId) return false;

    const matches = [...this.persistentClients.entries()].filter(([, persistent]) =>
      persistent.projectId === targetProjectId && persistent.jobId === targetJobId
    );
    if (matches.length === 0) return false;

    // Close every logical session before terminating any provider process.
    // Process cleanup is intentionally aggressive and must not prevent a peer
    // conversation from recording its terminal audit event.
    const sessionResults = await Promise.allSettled(
      matches.map(([, persistent]) => persistent.client.closeActiveSession(reason)),
    );
    const providerResults = await Promise.allSettled(
      matches.map(([key]) => this.#closePersistentClient(key)),
    );
    throwCollectedCleanupErrors(
      "ACP pool job release cleanup failed",
      [...sessionResults, ...providerResults]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason),
    );
    return true;
  }

  async statusAsync() {
    const registry = await getRegistry();
    const base = this.status();
    for (const [agent, pool] of Object.entries(base.pools) as [string, PoolStatusEntry][]) {
      const desc = registry?.getDescriptor(agent);
      if (desc) {
        pool.descriptor = {
          displayName: desc.displayName || agent,
          stability: desc.stability || "unknown",
          agentCapabilities: desc.capabilities || [],
          defaultRoles: desc.defaultRoles || [],
          command: desc.command,
          envPrefix: desc.envPrefix,
        };
      }
    }
    return base;
  }

  status() {
    const providerProcessReuse = this.#usesProviderProcessReuse();
    const agents = [...new Set([
      ...Object.keys(this.limits),
      ...this.active.keys(),
      ...this.pending.keys(),
      ...this.sessions.keys(),
      ...this.persistentClients.keys(),
    ])];
    const allLive = [...this.liveRequests.entries()]
      .map(([id, v]) => ({
        requestId: id,
        startedAt: v.startedAt,
        promptSnippet: v.promptSnippet || null,
        promptBytes: v.promptBytes || 0,
        phase: v.phase || null,
      }));
    const now = Date.now();
    const pools: Record<string, PoolStatusEntry> = {};
    for (const agent of agents) {
      const session = this.sessions.get(agent);
      const persistent = this.persistentClients.get(agent);
      const agentProviderKey = this.providerKey(agent);
      const fallbackCandidates = this.fallbackCandidates(agent, null, agentProviderKey);
      const capabilities = [
        "rate-limit-backoff",
        "concurrency-bound",
        "durable-state",
        "live-requests",
        "session-recycle-policy",
      ];
      if (fallbackCandidates.length > 0) capabilities.push("provider-fallback");
      if (providerProcessReuse) capabilities.push("provider-process-reuse");
      pools[agent] = {
        providerKey: agentProviderKey,
        limit: this.#providerConnectionLimit(agentProviderKey),
        active: this.active.get(agent) || 0,
        queued: this.pending.get(`provider:${agentProviderKey}`)?.length || 0,
        fallbackProviders: fallbackCandidates.map((candidate) => candidate.providerKey),
        activeRequests: allLive.filter((r) => r.requestId.startsWith(`${agent}-`)),
        requestCount: this.requestCount.get(agent) || 0,
        sessionRequestCount: session?.requestCount || 0,
        errorCount: this.errorCount.get(agent) || 0,
        spawnCount: this.spawnCount.get(agent) || 0,
        recycleCount: this.recycleCount.get(agent) || 0,
        lastSpawnAt: this.lastSpawnAt.get(agent) || null,
        sessionStartedAt: session?.startedAt || null,
        sessionAgeMs: session?.startedAt ? Math.max(0, now - session.startedAt) : null,
        lastRecycleAt: session?.recycledAt || null,
        recycleReason: session?.recycleReason || null,
        lastRecycleReason: this.lastRecycleReason.get(agent) || null,
        sessionId: session?.sessionId || null,
        rateLimitedUntil: null, // now managed by provider-quota service
        mode: this.runner
          ? "managed-reusable"
          : this.env.CPB_ACP_CLIENT
            ? "custom-client-one-shot"
            : providerProcessReuse
              ? "persistent-provider-process"
              : "bounded-one-shot",
        transport: this.runner
          ? "injected-runner-function"
          : this.env.CPB_ACP_CLIENT
            ? "custom-client-child-process"
            : providerProcessReuse
              ? "persistent-acp-agent-process"
              : "request-scoped-child-process",
        providerProcessReuse,
        providerProcessPid: persistent?.client?.child?.pid || null,
        providerProcessStartedAt: persistent?.startedAt || null,
        providerProcessRequestCount: persistent?.requestCount || 0,
        providerProcessHealthy: persistent ? !persistent.client.closed : null,
        capabilities,
      };
    }
    return {
      createdAt: this.createdAt,
      connectionLeaseRoot: this.leaseRoot,
      connectionLeaseScope: this.leaseRoot === this.hubRoot ? "hub" : "shared",
      providerProcessReuse,
      connectionLimits: {
        providerDefault: this.providerConnectionLimit,
      },
      providerFallbacks: serializableProviderFallbacks(this.providerFallbacks),
      pools,
    };
  }

  #usesProviderProcessReuse() {
    return Boolean(this.persistentProcesses && !this.runner);
  }

  #usesLaunchScopedMcp(agent: string, options: PoolRequestOptions = {}) {
    if (agent !== "codex") return false;
    const env = this.#executionEnv(agent, options);
    return env.CPB_CODEGRAPH_ENABLED !== "0";
  }

  #persistentClientKey(agent: string, options: PoolRequestOptions = {}) {
    const processCwd = this.#usesLaunchScopedMcp(agent, options) ? options.cwd || "" : "";
    const launchPermissionLane = agent === "codex"
      ? codexSandboxModeForExecution(this.#executionEnv(agent, options))
      : "";
    const dataRoot = this.#requestDataRoot(options);
    return poolClientKey(agent, {
      ...options,
      dataRoot: dataRoot || null,
      processCwd,
      launchPermissionLane,
    });
  }

  #conversationKey(options: PoolRequestOptions = {}) {
    return stringValue(options.conversationKey);
  }

  #requestDataRoot(options: PoolRequestOptions = {}, persistent: PersistentClientState | null = null) {
    return stringValue(options.dataRoot)
      || persistent?.dataRoot
      || stringValue(this.env.CPB_PROJECT_RUNTIME_ROOT);
  }

  #sessionKey(agent: string, options: PoolRequestOptions = {}) {
    return this.#conversationKey(options) || this.#requestDataRoot(options)
      ? this.#persistentClientKey(agent, options)
      : agent;
  }

  #providerKeyForRequest(agent: string, options: PoolRequestOptions = {}) {
    return options.providerKey || this.providerKey(agent, options.variant);
  }

  _nextId(agent: string) {
    return `${agent}-${Date.now()}-${++this._seq}`;
  }

  acquire(agent: string, options: PoolRequestOptions = {}) {
    if (options.signal?.aborted) {
      return Promise.reject(abortErrorForSignal(options.signal));
    }
    const providerKey = this.#providerKeyForRequest(agent, options);
    const limit = this.#providerConnectionLimit(providerKey);
    // Count all agents sharing the same provider key
    const active = this.#providerActiveCount(providerKey);
    if (active < limit) {
      const requestId = this._nextId(agent);
      this.active.set(agent, (this.active.get(agent) || 0) + 1);
      this.activeProviders.set(providerKey, (this.activeProviders.get(providerKey) || 0) + 1);
      this.liveRequests.set(requestId, { agent, startedAt: Date.now(), providerKey });
      return Promise.resolve({ agent, requestId, release: () => this.release(agent, requestId) });
    }
    const timeoutMs = this.#poolWaitTimeoutMs(options.waitTimeoutMs);
    const start = Date.now();
    return new Promise<AcquiredPoolSlot>((resolve, reject) => {
      // Queue under provider key (not agent name) so cross-agent waits are shared
      const queueKey = `provider:${providerKey}`;
      const queue = this.pending.get(queueKey) || [];
      const entry: PendingPoolRequest = { resolve, reject, agent, providerKey, signal: options.signal };
      const removeFromQueue = () => {
        const currentQueue = this.pending.get(queueKey) || queue;
        const idx = currentQueue.indexOf(entry);
        if (idx !== -1) currentQueue.splice(idx, 1);
        if (currentQueue.length === 0) this.pending.delete(queueKey);
      };
      entry._abortCleanup = addAbortHandler(options.signal, () => {
        if (entry.aborted) return;
        entry.aborted = true;
        cleanupPendingPoolRequest(entry);
        removeFromQueue();
        reject(abortErrorForSignal(options.signal));
      });
      queue.push(entry);
      this.pending.set(queueKey, queue);

      // 30-second warn log
      entry._warnTimer = setInterval(() => {
        const elapsed = Date.now() - start;
        const currentActive = this.#providerActiveCount(providerKey);
        process.stderr.write(
          `[acp-pool] warn: ACP pool wait: ${agent}/${providerKey} waiting ${Math.round(elapsed / 1000)}s for provider slot (${currentActive}/${limit})\n`,
        );
      }, POOL_WAIT_WARN_INTERVAL_MS);
      entry._warnTimer.unref();

      // Timeout
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          cleanupPendingPoolRequest(entry);
          removeFromQueue();
          const elapsed = Date.now() - start;
          reject(new PoolExhaustedError(agent, providerKey, elapsed));
        }, timeoutMs);
        entry._timer = timer;
      }
    });
  }

  /**
   * Count active sessions across all agents that share the same provider key.
   * This is the in-process gate; the file-based lease in #run() handles cross-process.
   */
  #providerActiveCount(providerKey: string) {
    return this.activeProviders.get(providerKey) || 0;
  }

  release(agent: string, requestId: string) {
    const request = requestId ? this.liveRequests.get(requestId) : null;
    const providerKey = request?.providerKey || this.providerKey(agent);
    const active = Math.max(0, (this.active.get(agent) || 1) - 1);
    this.active.set(agent, active);
    const providerActive = Math.max(0, (this.activeProviders.get(providerKey) || 1) - 1);
    this.activeProviders.set(providerKey, providerActive);
    if (requestId) this.liveRequests.delete(requestId);
    // Drain from provider-keyed queue (cross-agent sharing)
    const queueKey = `provider:${providerKey}`;
    const queue = this.pending.get(queueKey) || [];
    while (queue.length) {
      const next = queue.shift();
      if (!next) continue;
      cleanupPendingPoolRequest(next);
      if (next.aborted || next.signal?.aborted) {
        next.reject(abortErrorForSignal(next.signal));
        continue;
      }
      const nextAgent = next.agent || agent;
      const nextProviderKey = next.providerKey || this.providerKey(nextAgent);
      const nextId = this._nextId(nextAgent);
      this.active.set(nextAgent, (this.active.get(nextAgent) || 0) + 1);
      this.activeProviders.set(nextProviderKey, (this.activeProviders.get(nextProviderKey) || 0) + 1);
      this.liveRequests.set(nextId, { agent: nextAgent, startedAt: Date.now(), providerKey: nextProviderKey });
      next.resolve({ agent: nextAgent, requestId: nextId, release: () => this.release(nextAgent, nextId) });
      break;
    }
    if (queue.length === 0) this.pending.delete(queueKey);
  }

  providerKey(agent: string, variant: string | null = null) {
    return providerKeyForAgent(agent, this.env, variant);
  }

  /**
   * Return provider-level handoff candidates for a failed agent/provider.
   *
   * Candidates are deliberately provider-key based.  A fallback therefore
   * changes both the launched agent and the audited provider identity instead
   * of relabelling a request to the exhausted provider.  The optional config
   * is merged at construction time and can be inspected through status().
   */
  fallbackCandidates(
    agent: string,
    currentVariant: string | null | undefined = null,
    excludeKey: string | null | undefined = null,
  ): ProviderFallbackCandidate[] {
    const currentProviderKey = this.providerKey(agent, currentVariant || null);
    const keys = [currentProviderKey, agent].filter((key, index, all) => Boolean(key) && all.indexOf(key) === index);
    const result: ProviderFallbackCandidate[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      for (const candidate of this.providerFallbacks[key] || []) {
        if (candidate.providerKey === currentProviderKey || candidate.providerKey === excludeKey) continue;
        if (seen.has(candidate.providerKey)) continue;
        seen.add(candidate.providerKey);
        result.push({ ...candidate });
      }
    }
    return result;
  }

  #connectionLeasesDir() {
    return path.join(this.leaseRoot, "providers", "acp-leases");
  }

  #connectionLockDir() {
    return path.join(this.#connectionLeasesDir(), ".lock");
  }

  #providerConnectionLimit(providerKey: string) {
    const specific = this.providerConnectionLimits[providerKey]
      ?? this.env[`CPB_ACP_POOL_PROVIDER_${providerEnvKey(providerKey)}_MAX`];
    return positiveIntOption(specific, this.providerConnectionLimit);
  }

  async #withConnectionLock<T>(callback: () => Promise<T>, signal?: AbortSignal, allowStopped = false) {
    return connectionLockBoundedReadHooksStorage.run(this.connectionLockFsHooks?.boundedRead, async () => {
      const dir = this.#connectionLeasesDir();
      const lockDir = this.#connectionLockDir();
      const ownerFile = path.join(lockDir, "owner.json");
      const ownerToken = randomUUID();
      const generation = randomUUID();
      const processIdentity = captureCurrentExactProcessIdentity();
      if (!processIdentity) throw acpPoolError("ACP connection lock process identity unavailable", "ACP_POOL_STATE_UNVERIFIED");
      await mkdir(dir, { recursive: true });
      await assertSafeDirectoryNoFollow(dir, "ACP connection lease directory");

      let acquired = false;
      while (!this.stopped || allowStopped) {
        throwIfAborted(signal);
        try {
          await mkdir(lockDir);
          const ownerBase = {
            format: CONNECTION_LOCK_OWNER_FORMAT,
            ownerToken,
            generation,
            pid: process.pid,
            host: os.hostname(),
            acquiredAt: new Date().toISOString(),
            processIdentity,
          };
          await writeJsonDurable(ownerFile, {
            ...ownerBase,
            binding: "pending",
            padding: " ".repeat(CONNECTION_LOCK_PENDING_PADDING_BYTES),
          }, {
            operation: "connection-owner",
            syncParent: async () => {
              await syncDirectory(lockDir);
              await this.#syncConnectionLockParent(lockDir, "acquire-publish");
            },
            fault: this.connectionLockFsHooks?.durableWriteFault,
          });
          const identity = connectionLockGeneration(await lstat(lockDir));
          await rewriteRegularJsonNoFollow(ownerFile, {
            ...ownerBase,
            binding: "bound",
            identity,
          }, "ACP connection lock owner");
          const afterOwnerRewrite = connectionLockGeneration(await lstat(lockDir));
          if (!sameConnectionLockGeneration(identity, afterOwnerRewrite)) {
            throw acpPoolError(
              `ACP connection lock changed while binding its persisted owner: ${lockDir}`,
              "ACP_POOL_STATE_UNVERIFIED",
            );
          }
          const owner = await this.#readConnectionLockOwner(lockDir, ownerFile);
          if (!owner
            || owner.binding !== "bound"
            || !owner.identity
            || owner.ownerToken !== ownerToken
            || owner.generation !== generation
            || !samePersistedProcessIdentity(owner.processIdentity, processIdentity)
            || !sameConnectionLockGeneration(owner.identity, identity)) {
            throw acpPoolError(`ACP connection lock owner commit is ambiguous: ${ownerFile}`, "ACP_POOL_STATE_UNVERIFIED");
          }
          acquired = true;
          break;
        } catch (err) {
          if (acpErrorCode(err) !== "EEXIST") throw err;
          if (await this.#recoverConnectionLock(lockDir, ownerFile)) continue;
          await sleep(10, signal);
        }
      }

      let result!: T;
      let primaryError: unknown;
      let hasPrimaryError = false;
      try {
        throwIfAborted(signal);
        if (!acquired) throw new Error("ACP pool stopped");
        throwIfAborted(signal);
        if (this.stopped && !allowStopped) throw new Error("ACP pool stopped");
        result = await callback();
      } catch (error) {
        primaryError = error;
        hasPrimaryError = true;
      }

      let releaseError: unknown;
      if (acquired) {
        try {
          await this.#releaseConnectionLock(lockDir, ownerFile, ownerToken, generation);
        } catch (error) {
          releaseError = error;
        }
      }
      if (hasPrimaryError && releaseError) {
        throw this.#connectionLockOperationAndReleaseFailure(primaryError, releaseError);
      }
      if (hasPrimaryError) throw primaryError;
      if (releaseError) throw releaseError;
      return result;
    });
  }

  async #readConnectionLockOwner(
    lockDir: string,
    ownerFile: string,
    expectedPersistedIdentity?: ConnectionLockGeneration,
  ): Promise<ConnectionLockOwner | null> {
    let info;
    try {
      info = await lstat(lockDir);
    } catch (error) {
      if (acpErrorCode(error) === "ENOENT") return null;
      throw acpPoolError(`ACP connection lock cannot be inspected safely: ${lockDir}`, "ACP_POOL_STATE_UNVERIFIED", error);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw acpPoolError(`ACP connection lock is not a real directory: ${lockDir}`, "ACP_POOL_STATE_UNSAFE");
    }
    const beforeGeneration = connectionLockGeneration(info);
    let raw;
    try {
      raw = await readRegularJsonNoFollow(ownerFile, "ACP connection lock owner");
    } catch (error) {
      if (acpErrorCauseCode(error) === "BOUNDED_FILE_CHANGED") {
        try {
          const afterFailure = await lstat(lockDir);
          if (!sameConnectionLockGeneration(
            beforeGeneration,
            connectionLockGeneration(afterFailure),
          )) {
            throw acpPoolError(
              `ACP connection lock generation changed while reading owner: ${lockDir}`,
              "ACP_CONNECTION_LOCK_RETRY",
              error,
            );
          }
          throw acpPoolError(
            `ACP connection lock owner publication changed during read: ${ownerFile}`,
            "ACP_CONNECTION_LOCK_RETRY",
            error,
          );
        } catch (afterError) {
          if (acpErrorCode(afterError) === "ENOENT") {
            throw acpPoolError(
              `ACP connection lock moved while reading owner: ${lockDir}`,
              "ACP_CONNECTION_LOCK_RETRY",
              error,
            );
          }
          throw afterError;
        }
      }
      throw error;
    }
    let after;
    try {
      after = await lstat(lockDir);
    } catch (error) {
      if (acpErrorCode(error) === "ENOENT") {
        throw acpPoolError(
          `ACP connection lock moved after reading owner: ${lockDir}`,
          "ACP_CONNECTION_LOCK_RETRY",
          error,
        );
      }
      throw error;
    }
    const afterGeneration = connectionLockGeneration(after);
    if (!after.isDirectory()
      || after.isSymbolicLink()
      || !sameConnectionLockGeneration(beforeGeneration, afterGeneration)) {
      throw acpPoolError(
        `ACP connection lock generation changed after reading owner: ${lockDir}`,
        "ACP_CONNECTION_LOCK_RETRY",
      );
    }
    if (raw === null) return null;
    if (!isRecord(raw)
      || raw.format !== CONNECTION_LOCK_OWNER_FORMAT
      || !["pending", "bound"].includes(String(raw.binding || ""))
      || typeof raw.ownerToken !== "string" || !raw.ownerToken
      || typeof raw.generation !== "string" || !raw.generation
      || !Number.isInteger(Number(raw.pid))
      || typeof raw.host !== "string"
      || typeof raw.acquiredAt !== "string") {
      throw acpPoolError(`ACP connection lock owner is malformed: ${ownerFile}`, "ACP_POOL_STATE_UNVERIFIED");
    }
    const processIdentity = processIdentityFrom(raw.processIdentity, Number(raw.pid));
    if (!processIdentity) {
      throw acpPoolError(`ACP connection lock owner lacks process identity: ${ownerFile}`, "ACP_POOL_STATE_UNVERIFIED");
    }
    if (raw.binding === "pending") {
      return {
        format: CONNECTION_LOCK_OWNER_FORMAT,
        binding: "pending",
        ownerToken: raw.ownerToken,
        generation: raw.generation,
        pid: Number(raw.pid),
        host: raw.host,
        acquiredAt: raw.acquiredAt,
        processIdentity,
        identity: null,
      };
    }
    const persistedIdentity = connectionLockGenerationFrom(raw.identity);
    if (!persistedIdentity
      || !sameConnectionLockGeneration(
        expectedPersistedIdentity || beforeGeneration,
        persistedIdentity,
      )) {
      throw acpPoolError(`ACP connection lock owner is malformed: ${ownerFile}`, "ACP_POOL_STATE_UNVERIFIED");
    }
    return {
      format: CONNECTION_LOCK_OWNER_FORMAT,
      binding: "bound",
      ownerToken: raw.ownerToken,
      generation: raw.generation,
      pid: Number(raw.pid),
      host: raw.host,
      acquiredAt: raw.acquiredAt,
      processIdentity,
      identity: persistedIdentity,
    };
  }

  #connectionLockOwnerDead(owner: ConnectionLockOwner | null, lockDir: string) {
    if (!owner) return false;
    if (owner.host !== os.hostname()) return false;
    try {
      return !connectionOwnerAlive(owner.processIdentity);
    } catch (error) {
      throw acpPoolError(`ACP connection lock owner liveness is unverified: ${lockDir}`, "ACP_POOL_STATE_UNVERIFIED", error);
    }
  }

  async #assertCanonicalConnectionLockGeneration(
    lockDir: string,
    ownerFile: string,
    expectedOwner: ConnectionLockOwner | null,
    expectedIdentity: ConnectionLockGeneration,
    phase: ConnectionLockMovedPhase,
  ) {
    const before = await lstat(lockDir);
    if (!before.isDirectory()
      || before.isSymbolicLink()
      || !sameConnectionLockGeneration(expectedIdentity, connectionLockGeneration(before))) {
      throw acpPoolError(
        `ACP canonical connection lock changed before ${phase}: ${lockDir}`,
        "ACP_POOL_STATE_UNVERIFIED",
      );
    }
    const observedOwner = await this.#readConnectionLockOwner(lockDir, ownerFile);
    const after = await lstat(lockDir);
    if (!after.isDirectory()
      || after.isSymbolicLink()
      || !sameConnectionLockGeneration(expectedIdentity, connectionLockGeneration(after))
      || !sameConnectionLockOwner(expectedOwner, observedOwner)) {
      throw acpPoolError(
        `ACP canonical connection lock owner or generation changed before ${phase}: ${lockDir}`,
        "ACP_POOL_STATE_UNVERIFIED",
      );
    }
  }

  async #assertMovedConnectionLockGeneration(
    movedDir: string,
    expectedOwner: ConnectionLockOwner | null,
    expectedCanonicalIdentity: ConnectionLockGeneration,
    expectedMovedIdentity: ConnectionLockGeneration,
    phase: ConnectionLockMovedPhase,
  ) {
    const before = await lstat(movedDir);
    const beforeGeneration = connectionLockGeneration(before);
    if (!before.isDirectory()
      || before.isSymbolicLink()
      || !sameConnectionLockGeneration(expectedMovedIdentity, beforeGeneration)
      || !sameConnectionLockAcrossRename(expectedCanonicalIdentity, beforeGeneration)) {
      throw acpPoolError(
        `ACP connection lock directory changed during ${phase}: ${movedDir}`,
        "ACP_POOL_STATE_UNVERIFIED",
      );
    }
    const observedOwner = await this.#readConnectionLockOwner(
      movedDir,
      path.join(movedDir, "owner.json"),
      expectedOwner?.identity || undefined,
    );
    const after = await lstat(movedDir);
    const afterGeneration = connectionLockGeneration(after);
    if (!after.isDirectory()
      || after.isSymbolicLink()
      || !sameConnectionLockGeneration(expectedMovedIdentity, afterGeneration)) {
      throw acpPoolError(
        `ACP connection lock directory changed while validating ${phase}: ${movedDir}`,
        "ACP_POOL_STATE_UNVERIFIED",
      );
    }
    if (!expectedOwner) {
      if (observedOwner) {
        throw acpPoolError(
          `ACP incomplete connection lock gained an owner during ${phase}: ${movedDir}`,
          "ACP_POOL_STATE_UNVERIFIED",
        );
      }
      return;
    }
    if (!sameConnectionLockOwner(expectedOwner, observedOwner)) {
      throw acpPoolError(
        `ACP connection lock owner changed during ${phase}: ${movedDir}`,
        "ACP_POOL_STATE_UNVERIFIED",
      );
    }
  }

  async #syncConnectionLockDirectory(directory: string, phase: ConnectionLockFsPhase) {
    if (this.connectionLockFsHooks?.syncDirectory) {
      await this.connectionLockFsHooks.syncDirectory(directory, phase);
      return;
    }
    await syncDirectory(directory, {
      phase,
      fault: this.connectionLockFsHooks?.directorySyncFault,
    });
  }

  async #syncConnectionLockParent(lockDir: string, phase: ConnectionLockFsPhase) {
    await this.#syncConnectionLockDirectory(path.dirname(lockDir), phase);
  }

  async #syncConnectionLockRenameDurability(
    lockDir: string,
    movedDir: string,
    phase: ConnectionLockMovedPhase,
  ): Promise<ConnectionLockRenameDurability> {
    const failures: Array<{
      directory: string;
      phase: ConnectionLockFsPhase;
      error: unknown;
    }> = [];
    const isolationPhase: ConnectionLockFsPhase = phase === "release"
      ? "release-isolation"
      : "recover-isolation";
    const parentPhase: ConnectionLockFsPhase = phase === "release"
      ? "release-rename"
      : "recover-rename";
    let isolationDirectoryDurable = false;
    let parentDirectoryDurable = false;
    try {
      await this.#syncConnectionLockDirectory(movedDir, isolationPhase);
      isolationDirectoryDurable = true;
    } catch (error) {
      failures.push({ directory: movedDir, phase: isolationPhase, error });
    }
    try {
      await this.#syncConnectionLockParent(lockDir, parentPhase);
      parentDirectoryDurable = true;
    } catch (error) {
      failures.push({ directory: path.dirname(lockDir), phase: parentPhase, error });
    }
    return {
      durabilityVerified: isolationDirectoryDurable && parentDirectoryDurable,
      isolationDirectoryDurable,
      parentDirectoryDurable,
      failures,
    };
  }

  #connectionLockFailure(message: string, errors: unknown[], extra: LooseRecord = {}) {
    const causes = errors.filter((error) => error !== undefined && error !== null);
    const cause = causes.length === 1 ? causes[0] : new AggregateError(causes, message);
    return Object.assign(new Error(message, { cause }), {
      code: "ACP_POOL_STATE_UNVERIFIED",
      errors: causes,
      ...extra,
    });
  }

  #connectionLockOperationAndReleaseFailure(primaryError: unknown, releaseError: unknown) {
    const releaseDetails = releaseError && typeof releaseError === "object"
      ? releaseError as LooseRecord
      : {};
    const releaseTruth: LooseRecord = {};
    for (const key of [
      "committed",
      "renameCommitted",
      "removalCommitted",
      "canonicalRemovalCommitted",
      "phase",
      "committedPath",
      "residualPath",
      "quarantinePreserved",
      "successorPreserved",
      "successorGeneration",
      "durabilityVerified",
      "isolationDirectoryDurable",
      "parentDirectoryDurable",
      "failedPhases",
      "durabilityFailures",
      "recoveryPaths",
    ]) {
      if (releaseDetails[key] !== undefined) releaseTruth[key] = releaseDetails[key];
    }
    return Object.assign(new AggregateError(
      [primaryError, releaseError],
      "ACP connection lock operation and release both failed",
      { cause: primaryError },
    ), {
      ...releaseTruth,
      code: "ACP_CONNECTION_LOCK_OPERATION_AND_RELEASE_FAILED",
      primaryCode: acpErrorCode(primaryError) || null,
      releaseCode: acpErrorCode(releaseError) || null,
      primaryError,
      releaseError,
    });
  }

  async #connectionLockCommittedAmbiguity(
    message: string,
    movedPhase: ConnectionLockMovedPhase,
    lockDir: string,
    movedDir: string,
    errors: unknown[],
    durability: ConnectionLockRenameDurability,
  ) {
    const preservation = await this.#movedConnectionLockPreservedFailure(
      lockDir,
      movedDir,
      movedPhase,
      [...errors],
    );
    const preservationDetails = preservation as unknown as LooseRecord;
    const causes = Array.isArray(preservationDetails.errors)
      ? preservationDetails.errors as unknown[]
      : [...errors];
    const cause = causes[0];
    const failure = causes.length > 1
      ? new AggregateError(causes, message, { cause })
      : new Error(message, cause === undefined ? undefined : { cause });
    const failedPhases = durability.failures.map((failure) => failure.phase);
    const phase = failedPhases.length === 1 ? failedPhases[0] : `${movedPhase}-durability`;
    return Object.assign(failure, {
      ...preservationDetails,
      code: "ACP_CONNECTION_LOCK_RENAME_COMMITTED_DURABILITY_AMBIGUOUS",
      committed: true,
      renameCommitted: true,
      removalCommitted: false,
      canonicalRemovalCommitted: true,
      phase,
      committedPath: movedDir,
      residualPath: movedDir,
      durabilityVerified: false,
      isolationDirectoryDurable: durability.isolationDirectoryDurable,
      parentDirectoryDurable: durability.parentDirectoryDurable,
      failedPhases,
      durabilityFailures: durability.failures.map((failure) => ({
        directory: failure.directory,
        phase: failure.phase,
        code: acpErrorCode(failure.error) || null,
        message: failure.error instanceof Error ? failure.error.message : String(failure.error),
      })),
      errors: causes,
      recoveryPaths: { canonical: lockDir, moved: movedDir },
    });
  }

  async #movedConnectionLockPreservedFailure(
    lockDir: string,
    movedDir: string,
    phase: ConnectionLockMovedPhase,
    errors: unknown[],
  ) {
    let successorPreserved: boolean | null = false;
    let successorGeneration: string | undefined;
    let movedPathPresent: boolean | null = false;
    try {
      await lstat(movedDir);
      movedPathPresent = true;
    } catch (error) {
      if (acpErrorCode(error) !== "ENOENT") {
        movedPathPresent = null;
        errors.push(error);
      }
    }
    try {
      const canonicalInfo = await lstat(lockDir);
      successorPreserved = true;
      if (canonicalInfo.isDirectory() && !canonicalInfo.isSymbolicLink()) {
        try {
          successorGeneration = (await this.#readConnectionLockOwner(lockDir, path.join(lockDir, "owner.json")))?.generation;
        } catch (error) {
          errors.push(error);
        }
      }
    } catch (error) {
      if (acpErrorCode(error) !== "ENOENT") {
        successorPreserved = null;
        errors.push(error);
      }
    }
    const quarantinePreserved = movedPathPresent;
    return this.#connectionLockFailure(
      successorPreserved && quarantinePreserved === true
        ? `ACP connection lock ${phase} failed; successor and moved lock were preserved: ${lockDir}`
        : quarantinePreserved === true
          ? `ACP connection lock ${phase} failed; moved lock was preserved for recovery: ${lockDir}`
          : `ACP connection lock ${phase} failed; moved lock state requires recovery: ${lockDir}`,
      errors,
      {
        committed: true,
        renameCommitted: true,
        removalCommitted: false,
        phase: `${phase}-preserved`,
        successorPreserved,
        quarantinePreserved,
        ...(successorGeneration ? { successorGeneration } : {}),
        residualPath: movedDir,
        recoveryPaths: { canonical: lockDir, moved: movedDir },
      },
    );
  }

  async #finalizeMovedConnectionLock(
    lockDir: string,
    movedDir: string,
    owner: ConnectionLockOwner | null,
    canonicalIdentity: ConnectionLockGeneration,
    phase: ConnectionLockMovedPhase,
  ) {
    const errors: unknown[] = [];
    let movedIdentity: ConnectionLockGeneration | null = null;
    try {
      const movedInfo = await lstat(movedDir);
      const observedMovedIdentity = connectionLockGeneration(movedInfo);
      if (!movedInfo.isDirectory()
        || movedInfo.isSymbolicLink()
        || !sameConnectionLockAcrossRename(canonicalIdentity, observedMovedIdentity)) {
        throw acpPoolError(
          `ACP connection lock ${phase} moved an unexpected generation: ${movedDir}`,
          "ACP_POOL_STATE_UNVERIFIED",
        );
      }
      movedIdentity = observedMovedIdentity;
    } catch (error) {
      errors.push(error);
    }

    const durability = await this.#syncConnectionLockRenameDurability(
      lockDir,
      movedDir,
      phase,
    );
    errors.push(...durability.failures.map((failure) => failure.error));

    try {
      await this.connectionLockFsHooks?.afterMove?.({ phase, lockDir, movedDir, owner });
    } catch (error) {
      errors.push(error);
    }

    if (movedIdentity) {
      try {
        await this.#assertMovedConnectionLockGeneration(
          movedDir,
          owner,
          canonicalIdentity,
          movedIdentity,
          phase,
        );
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 0) return;
    if (!durability.durabilityVerified) {
      throw await this.#connectionLockCommittedAmbiguity(
        `ACP connection lock ${phase} rename is committed but directory durability is ambiguous: ${lockDir}`,
        phase,
        lockDir,
        movedDir,
        errors,
        durability,
      );
    }
    throw await this.#movedConnectionLockPreservedFailure(
      lockDir,
      movedDir,
      phase,
      errors,
    );
  }

  async #recoverConnectionLock(lockDir: string, ownerFile: string) {
    let before;
    try {
      before = await lstat(lockDir);
    } catch (error) {
      if (acpErrorCode(error) === "ENOENT") return true;
      throw error;
    }
    let owner;
    try {
      owner = await this.#readConnectionLockOwner(lockDir, ownerFile);
    } catch (error) {
      if (acpErrorCode(error) === "ACP_CONNECTION_LOCK_RETRY") return true;
      throw error;
    }
    let info;
    try {
      info = await lstat(lockDir);
    } catch (error) {
      if (acpErrorCode(error) === "ENOENT") return true;
      throw error;
    }
    const beforeIdentity = connectionLockGeneration(before);
    const identity = connectionLockGeneration(info);
    if (!sameConnectionLockGeneration(beforeIdentity, identity)) return true;
    const incomplete = !owner && Date.now() - info.mtimeMs >= CONNECTION_LOCK_TTL_MS;
    if (!incomplete && !this.#connectionLockOwnerDead(owner, lockDir)) return false;
    const quarantine = `${lockDir}.stale-${owner?.generation || "incomplete"}-${randomUUID()}`;
    await this.connectionLockFsHooks?.beforeMove?.({ phase: "recover", lockDir, owner });
    try {
      await this.#assertCanonicalConnectionLockGeneration(lockDir, ownerFile, owner, identity, "recover");
    } catch (error) {
      if (["ENOENT", "ACP_CONNECTION_LOCK_RETRY"].includes(acpErrorCode(error))) return true;
      throw error;
    }
    try {
      await rename(lockDir, quarantine);
    } catch (error) {
      if (acpErrorCode(error) === "ENOENT") return true;
      throw error;
    }
    await this.#finalizeMovedConnectionLock(lockDir, quarantine, owner, identity, "recover");
    // Keep the uniquely named, fully validated quarantine as durable recovery
    // evidence; no later pathname operation can affect a successor.
    return true;
  }

  async #releaseConnectionLock(lockDir: string, ownerFile: string, ownerToken: string, generation: string) {
    const owner = await this.#readConnectionLockOwner(lockDir, ownerFile);
    if (!owner
      || owner.binding !== "bound"
      || !owner.identity
      || owner.ownerToken !== ownerToken
      || owner.generation !== generation) return;
    const identity = owner.identity;
    const released = `${lockDir}.released-${generation}-${randomUUID()}`;
    await this.connectionLockFsHooks?.beforeMove?.({ phase: "release", lockDir, owner });
    try {
      await this.#assertCanonicalConnectionLockGeneration(lockDir, ownerFile, owner, identity, "release");
    } catch (error) {
      if (["ENOENT", "ACP_CONNECTION_LOCK_RETRY"].includes(acpErrorCode(error))) return;
      throw error;
    }
    try {
      await rename(lockDir, released);
    } catch (error) {
      if (acpErrorCode(error) === "ENOENT") return;
      throw error;
    }
    await this.#finalizeMovedConnectionLock(lockDir, released, owner, identity, "release");
    // Preserve the exact released generation as evidence; see recovery above.
  }

  #leaseAlive(lease: ConnectionLease | null | undefined) {
    if (!lease?.processIdentity) throw acpPoolError("ACP connection lease lacks process identity", "ACP_POOL_STATE_UNVERIFIED");
    try {
      return connectionOwnerAlive(lease.processIdentity);
    } catch (error) {
      throw acpPoolError(`ACP connection lease liveness is unverified: ${lease.filePath || lease.leaseId || "unknown"}`, "ACP_POOL_STATE_UNVERIFIED", error);
    }
  }

  async #listLiveConnectionLeasesLocked() {
    const dir = this.#connectionLeasesDir();
    const leases: ConnectionLease[] = [];
    let files = [];
    try {
      await assertSafeDirectoryNoFollow(dir, "ACP connection lease directory");
      files = await readdir(dir);
      } catch (error) {
        if (acpErrorCode(error) === "ENOENT") return leases;
        throw error;
      }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(dir, file);
      const raw = await readRegularJsonNoFollow(filePath, "ACP connection lease");
      if (raw === null) continue;
      const lease = connectionLeaseFrom(raw, filePath);
      if (!lease?.leaseId || !lease.ownerToken || !lease.generation || !lease.providerKey) {
        throw acpPoolError(`ACP connection lease is malformed: ${filePath}`, "ACP_POOL_STATE_UNVERIFIED");
      }
      if (this.#leaseAlive(lease)) {
        leases.push(lease);
      } else {
        await this.#retireConnectionLeaseFile(lease);
      }
    }
    return leases;
  }

  async #retireConnectionLeaseFile(lease: ConnectionLease) {
    if (!lease.filePath || !lease.ownerToken || !lease.generation || !lease.processIdentity) return;
    const observed = await readRegularJsonNoFollowWithIdentity(lease.filePath, "ACP connection lease");
    if (observed === null) return;
    const current = connectionLeaseFrom(observed.value, lease.filePath);
    if (!sameConnectionLeaseAuthority(lease, current)) {
      throw acpPoolError(`ACP connection lease changed during retirement: ${lease.filePath}`, "ACP_POOL_STATE_UNVERIFIED");
    }
    const retiredPath = `${lease.filePath}.released-${lease.generation}-${randomUUID()}`;
    await rename(lease.filePath, retiredPath);
    const authorityFailure = (message: string, cause?: unknown) => Object.assign(acpPoolError(
      message,
      "ACP_POOL_STATE_UNVERIFIED",
      cause,
    ), {
      committed: true,
      releaseCommitted: true,
      retirementCommitted: false,
      renameCommitted: true,
      authorityVerified: false,
      phase: "lease-release-rename",
      candidatePath: retiredPath,
      recoveryPaths: { canonical: lease.filePath, candidate: retiredPath },
    });
    const revalidateEvidence = async (expectedIdentity: ConnectionLockGeneration) => {
      const pinned = await readRegularJsonNoFollowWithIdentity(
        retiredPath,
        "ACP released connection lease",
        { invokeAfterVerifiedRead: false },
      );
      const pinnedLease = connectionLeaseFrom(pinned?.value, retiredPath);
      if (!pinned
        || !sameConnectionLockGeneration(expectedIdentity, pinned.identity)
        || !sameConnectionLeaseAuthority(lease, pinnedLease)) {
        throw authorityFailure(`ACP connection lease retired evidence authority changed: ${retiredPath}`);
      }
      return pinned;
    };
    let movedInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      movedInfo = await lstat(retiredPath);
    } catch (error) {
      throw authorityFailure(`ACP connection lease retired path cannot be inspected: ${retiredPath}`, error);
    }
    const movedIdentity = connectionLockGeneration(movedInfo);
    if (!movedInfo.isFile()
      || movedInfo.isSymbolicLink()
      || !sameConnectionLockAcrossRename(observed.identity, movedIdentity)) {
      throw authorityFailure(`ACP connection lease release moved an unexpected generation: ${retiredPath}`);
    }
    let moved: { value: unknown; identity: ConnectionLockGeneration };
    try {
      moved = await revalidateEvidence(movedIdentity);
    } catch (error) {
      if ((error as LooseRecord | undefined)?.authorityVerified === false) throw error;
      throw authorityFailure(`ACP connection lease retired evidence cannot be validated: ${retiredPath}`, error);
    }
    let syncError: unknown = null;
    try {
      await this.#syncConnectionLockDirectory(path.dirname(lease.filePath), "lease-release-rename");
    } catch (error) {
      syncError = error;
    }
    let finalEvidence;
    try {
      finalEvidence = await revalidateEvidence(moved.identity);
    } catch (error) {
      if ((error as LooseRecord | undefined)?.authorityVerified === false) throw error;
      throw authorityFailure(
        `ACP connection lease retired evidence could not be revalidated: ${retiredPath}`,
        error,
      );
    }
    if (syncError) {
      throw Object.assign(acpPoolError(
        `ACP connection lease retirement rename committed with ambiguous directory durability: ${lease.filePath}`,
        "ACP_CONNECTION_LEASE_RENAME_COMMITTED_DURABILITY_AMBIGUOUS",
        syncError,
      ), {
        committed: true,
        releaseCommitted: true,
        retirementCommitted: true,
        renameCommitted: true,
        authorityVerified: true,
        phase: "lease-release-rename",
        committedPath: retiredPath,
        evidencePath: retiredPath,
        residualPath: retiredPath,
        evidenceIdentity: finalEvidence.identity,
        recoveryPaths: { canonical: lease.filePath, evidence: retiredPath },
      });
    }
  }

  async #readConnectionLeaseFile(filePath: string) {
    const raw = await readRegularJsonNoFollow(filePath, "ACP connection lease");
    if (raw === null) return null;
    const lease = connectionLeaseFrom(raw, filePath);
    if (!lease?.leaseId || !lease.ownerToken || !lease.generation || !lease.providerKey) {
      throw acpPoolError(`ACP connection lease is malformed: ${filePath}`, "ACP_POOL_STATE_UNVERIFIED");
    }
    return lease;
  }

  async #tryAcquireConnectionLease(agent: string, providerKey: string, options: PoolRequestOptions = {}) {
    return this.#withConnectionLock(async () => {
      const leases = await this.#listLiveConnectionLeasesLocked();
      const providerLimit = this.#providerConnectionLimit(providerKey);
      const providerCount = leases.filter((lease) => lease.providerKey === providerKey).length;
      if (providerCount >= providerLimit) {
        return null;
      }

      const processIdentity = captureCurrentExactProcessIdentity();
      if (!processIdentity) throw acpPoolError("ACP connection lease process identity unavailable", "ACP_POOL_STATE_UNVERIFIED");
      const lease = {
        leaseId: `${Date.now()}-${process.pid}-${++this._seq}`,
        ownerToken: randomUUID(),
        generation: randomUUID(),
        pid: process.pid,
        processIdentity,
        agent,
        providerKey,
        phase: options.phase || null,
        role: options.role || null,
        poolScope: options.poolScope || null,
        controlPlane: Boolean(options.controlPlane || options.poolScope === "control-plane"),
        acquiredAt: new Date().toISOString(),
      };
      const filePath = path.join(this.#connectionLeasesDir(), `${lease.leaseId}.json`);
      await writeJsonDurable(filePath, lease, {
        operation: "connection-lease",
        fault: this.connectionLockFsHooks?.durableWriteFault,
      });
      const published = await this.#readConnectionLeaseFile(filePath);
      if (!published
        || published.ownerToken !== lease.ownerToken
        || published.generation !== lease.generation
        || !samePersistedProcessIdentity(published.processIdentity, processIdentity)) {
        throw acpPoolError(`ACP connection lease commit is ambiguous: ${filePath}`, "ACP_POOL_STATE_UNVERIFIED");
      }
      return published;
    }, options.signal);
  }

  async #acquireConnectionLease(agent: string, providerKey: string, options: PoolRequestOptions = {}) {
    const timeoutMs = this.#poolWaitTimeoutMs(options.waitTimeoutMs);
    const start = Date.now();
    let lastWarnAt = start;
    while (!this.stopped) {
      throwIfAborted(options.signal);
      const lease = await this.#tryAcquireConnectionLease(agent, providerKey, options);
      if (options.signal?.aborted) {
        await this.#releaseConnectionLease(lease);
        throw abortErrorForSignal(options.signal);
      }
      if (lease) return lease;
      const elapsed = Date.now() - start;
      if (timeoutMs > 0 && elapsed >= timeoutMs) {
        throw new PoolExhaustedError(agent, providerKey, elapsed);
      }
      if (elapsed - (lastWarnAt - start) >= POOL_WAIT_WARN_INTERVAL_MS) {
        const providerLimit = this.#providerConnectionLimit(providerKey);
        const providerCount = await this.#countProviderLeases(providerKey);
        process.stderr.write(
          `[acp-pool] warn: ${agent}/${providerKey} waiting ${Math.round(elapsed / 1000)}s for provider slot (${providerCount}/${providerLimit})\n`,
        );
        lastWarnAt = Date.now();
      }
      await sleep(this.connectionPollMs, options.signal);
    }
    throw new Error("ACP pool stopped");
  }

  async #countProviderLeases(providerKey: string) {
    const leases = await this.#withConnectionLock(() => this.#listLiveConnectionLeasesLocked());
    return leases.filter((lease) => lease.providerKey === providerKey).length;
  }

  async #releaseConnectionLease(lease: ConnectionLease | null | undefined) {
    if (!lease?.filePath) return;
    await this.#withConnectionLock(async () => {
      await this.#retireConnectionLeaseFile(lease);
    }, undefined, true);
  }

  #executionEnv(agent: string, options: PoolRequestOptions = {}): EnvRecord {
    const projectRuntimeRoot = this.#requestDataRoot(options);
    return buildChildEnv(
      envForAgent(agent, this.env, options.variant),
      {
        CPB_ROOT: this.cpbRoot,
        CPB_ACP_CPB_ROOT: this.cpbRoot,
        CPB_HUB_ROOT: this.hubRoot,
        ...(projectRuntimeRoot ? { CPB_PROJECT_RUNTIME_ROOT: projectRuntimeRoot } : {}),
        ...acpMetadataEnv(options),
        ...(isRecord(options.env) ? options.env as EnvRecord : {}),
        ...(projectRuntimeRoot ? { CPB_PROJECT_RUNTIME_ROOT: projectRuntimeRoot } : {}),
        ...(typeof options.cwd === "string" && options.cwd ? { CPB_PROJECT_PATH_OVERRIDE: options.cwd } : {}),
      },
      { agent },
    );
  }

  /**
   * Return all known agent/provider keys from registry + config.
   * Used by hub status to display providers with 0 active leases.
   */
  /**
   * Return the effective connection limit for a provider key.
   * Matches the internal provider-limit resolver used by lease acquisition.
   */
  getProviderLimit(providerKey: string) {
    return this.#providerConnectionLimit(providerKey);
  }

  async getKnownProviderKeys() {
    const keys = new Set(Object.keys(this.limits || {}));
    for (const k of Object.keys(this.providerConnectionLimits || {})) keys.add(k);
    try {
      const registry = await getRegistry();
      if (registry) {
        for (const name of registry.listAgentNames()) keys.add(name);
      }
    } catch {}
    // Ensure codex and claude are always present (sync fallback)
    keys.add("codex");
    keys.add("claude");
    return [...keys];
  }

  async connectionLeaseStatus() {
    const counts: Record<string, number> = {};
    try {
      const leases = await this.#withConnectionLock(() => this.#listLiveConnectionLeasesLocked());
      for (const lease of leases) {
        const key = lease.providerKey || "unknown";
        counts[key] = (counts[key] || 0) + 1;
      }
    } catch (error) {
      if (acpErrorCode(error) === "ENOENT") {
        return { total: 0, providers: {} };
      }
      if (acpErrorCode(error) === "ACP_POOL_STATE_UNVERIFIED" || acpErrorCode(error) === "ACP_POOL_STATE_UNSAFE") {
        throw error;
      }
      if (this.stopped) {
        return { total: 0, providers: {} };
      }
      throw error;
    }
    const total = Object.values(counts).reduce((a, b) => a + Number(b), 0);
    return { total, providers: counts };
  }

  async readProviderQuotas() {
    const { readProviderQuotas } = await import("../provider-quota.js");
    return readProviderQuotas(this.hubRoot);
  }

  #newSession(
    agent: string,
    options: PoolRequestOptions = {},
    recycleReason: string | null = null,
    recycledAt: number | null = null,
  ) {
    const now = Date.now();
    const session: PoolSession = {
      agent,
      conversationKey: this.#conversationKey(options),
      startedAt: now,
      lastUsedAt: null,
      requestCount: 0,
      recycleReason,
      recycledAt,
      sessionId: null,
    };
    this.sessions.set(this.#sessionKey(agent, options), session);
    this.lastSpawnAt.set(agent, now);
    return session;
  }

  #sessionRecycleReason(session: PoolSession | null) {
    if (!session) return null;
    if (this.maxSessionRequests > 0 && session.requestCount >= this.maxSessionRequests) {
      return "max_requests";
    }
    if (this.maxSessionAgeMs > 0 && Date.now() - session.startedAt >= this.maxSessionAgeMs) {
      return "max_age";
    }
    if (this.sessionIdleMs > 0 && session.lastUsedAt && Date.now() - session.lastUsedAt >= this.sessionIdleMs) {
      return "idle_timeout";
    }
    return null;
  }

  async #recycleSession(agent: string, reason: string, options: PoolRequestOptions = {}) {
    this.recycleCount.set(agent, (this.recycleCount.get(agent) || 0) + 1);
    this.lastRecycleReason.set(agent, reason);
    // Save sessionId before closing if agent uses cached lifecycle
    const sessionKey = this.#sessionKey(agent, options);
    const session = this.sessions.get(sessionKey);
    if (session?.sessionId) {
      const reg = await getRegistry();
      const desc = reg?.getDescriptor(agent);
      if (desc?.lifecycle === "cached") {
        await saveSessionId(this.cpbRoot, agent, session.sessionId, {
          dataRoot: this.#requestDataRoot(options),
          ...(session.conversationKey ? { conversationKey: session.conversationKey } : {}),
        }).catch(() => null);
      }
    }
    const persistentKey = this.#conversationKey(options) || this.#requestDataRoot(options)
      ? this.#persistentClientKey(agent, options)
      : agent;
    await this.#closePersistentClient(persistentKey);
    return this.#newSession(agent, options, reason, Date.now());
  }

  async #prepareSession(agent: string, options: PoolRequestOptions = {}) {
    let session = this.sessions.get(this.#sessionKey(agent, options));
    if (!session) return this.#newSession(agent, options);

    const reason = this.#sessionRecycleReason(session);
    if (reason) session = await this.#recycleSession(agent, reason, options);
    return session;
  }

  #noteSpawn(agent: string) {
    this.spawnCount.set(agent, (this.spawnCount.get(agent) || 0) + 1);
    if (!this.runner) this.lastSpawnAt.set(agent, Date.now());
  }

  #defaultTimeoutMs() {
    return numericOption(this.env.CPB_ACP_POOL_TIMEOUT_MS, 0);
  }

  #poolWaitTimeoutMs(value: unknown = undefined) {
    return value === undefined || value === null || value === ""
      ? resolvePoolWaitTimeoutMs(this.env.CPB_ACP_POOL_WAIT_TIMEOUT_MS ?? "")
      : numericOption(value, 0);
  }

  async execute(agent: string, prompt: string, cwd = this.cpbRoot, timeoutMs = this.#defaultTimeoutMs(), options: PoolRequestOptions = {}) {
    const scopedOptions: PoolRequestOptions = { ...options, cwd };
    throwIfAborted(scopedOptions.signal);
    if (options.bypass) {
      const output = await this.#run(agent, prompt, cwd, timeoutMs, scopedOptions);
      return { output, providerKey: null, agent, variant: null };
    }
    const providerKey = this.#providerKeyForRequest(agent, scopedOptions);
    const providerVariant = variantNameForProviderKey(providerKey, agent);
    const acpAuditFile = resolveAcpAuditFile(this.#executionEnv(agent, scopedOptions));

    // Pre-flight quota gate (replaces old assertNotRateLimited)
    if (!this.runner) {
      await assertProviderAvailable(this.hubRoot, {
        providerKey,
        agent,
        variant: providerVariant,
        phase: scopedOptions.phase,
        role: scopedOptions.role,
      });
    }

    const session = await this.acquire(agent, scopedOptions);
    try {
      throwIfAborted(scopedOptions.signal);
      const lifecycle = await this.#prepareSession(agent, scopedOptions);
      if (session.requestId) {
        const entry = this.liveRequests.get(session.requestId);
        if (entry) {
          const promptText = String(prompt);
          entry.promptSnippet = promptText.slice(0, 80);
          entry.promptBytes = Buffer.byteLength(promptText, "utf8");
          if (scopedOptions.phase) entry.phase = scopedOptions.phase;
        }
      }
      if (this.runner || !this.persistentProcesses) this.#noteSpawn(agent);
      const output = await this.#run(agent, prompt, cwd, timeoutMs, scopedOptions);
      const usage = await readAcpUsageFromAudit(acpAuditFile, {
        phase: scopedOptions.phase || null,
        role: scopedOptions.role || null,
      });
      this.requestCount.set(agent, (this.requestCount.get(agent) || 0) + 1);
      lifecycle.requestCount += 1;
      lifecycle.lastUsedAt = Date.now();
      lifecycle.recycleReason = null;
      return {
        output,
        providerKey,
        agent,
        variant: providerVariant || null,
        acpAuditFile,
        usage,
        sessionId: lifecycle.sessionId || null,
      };
    } catch (error) {
      const execError = error as AcpExecutionErrorWithMetadata;
      const usage = await readAcpUsageFromAudit(acpAuditFile, {
        phase: scopedOptions.phase || null,
        role: scopedOptions.role || null,
      });
      if (usage) execError.usage = usage;
      if (acpAuditFile) execError.acpAuditFile = acpAuditFile;
      if (isAbortError(execError)) throw execError;
      this.errorCount.set(agent, (this.errorCount.get(agent) || 0) + 1);

      // Classify via provider-quota (replaces old is429 + noteRateLimit)
      const adapterRecord = getProviderAdapter(providerKey);
      const parseLimitError = adapterRecord.parseLimitError;
      const adapter = {
        timezone: typeof adapterRecord.timezone === "string" ? adapterRecord.timezone : undefined,
        parseLimitError: typeof parseLimitError === "function"
          ? (args: { error: Error; stdout?: string; stderr?: string }) => Promise.resolve(parseLimitError(args))
          : undefined,
      };
      const quotaResult: QuotaClassification = await classifyQuotaFailure({
        providerKey,
        agent,
        variant: providerVariant,
        error: execError,
        stdout: "",
        stderr: execError?.message || "",
        adapter,
      });

      if (quotaResult.isQuota) {
        await this.#recycleSession(agent, "rate_limit", scopedOptions);
        // Route through delegate client (fail closed — delegate error propagates)
        const { delegateMarkProviderUnavailable } = await import("../quota-delegate-client.js");
        await delegateMarkProviderUnavailable(this.hubRoot, {
          providerKey,
          agent,
          variant: scopedOptions.variant,
          status: quotaResult.status,
          nextEligibleAt: quotaResult.nextEligibleAt,
          source: quotaResult.source || "acp-pool-classifier",
          confidence: quotaResult.confidence,
          reason: quotaResult.reason,
        }, undefined);
        const quotaError = new ProviderQuotaError(quotaResult.reason, {
          providerKey,
          agent,
          variant: scopedOptions.variant,
          status: quotaResult.status,
          nextEligibleAt: quotaResult.nextEligibleAt,
          source: "acp-pool-classifier",
          confidence: quotaResult.confidence,
          reason: quotaResult.reason,
          phase: scopedOptions.phase,
          role: scopedOptions.role,
        }) as ProviderQuotaErrorWithMetadata;
        quotaError.usage = usage || null;
        quotaError.acpAuditFile = acpAuditFile;
        throw quotaError;
      }

      await this.#recycleSession(agent, "error", scopedOptions);
      throw execError;
    } finally {
      session.release();
    }
  }

  async #run(agent: string, prompt: string, cwd: string, timeoutMs: number, options: PoolRequestOptions = {}) {
    throwIfAborted(options.signal);
    if (this.runner) {
      const lease = await this.#acquireConnectionLease(agent, this.#providerKeyForRequest(agent, options), options);
      try {
        throwIfAborted(options.signal);
        return await raceWithAbort(
          this.runner({ agent, prompt, cwd, timeoutMs, signal: options.signal }),
          options.signal,
        );
      } finally {
        await this.#releaseConnectionLease(lease);
      }
    }
    const descriptor = (await getRegistry())?.getDescriptor(agent);
    if (descriptor?.transport === "claude-cli") {
      return this.#runClaudeCli(agent, prompt, cwd, timeoutMs, options);
    }
    if (this.env.CPB_ACP_CLIENT) return this.#runOneShot(agent, prompt, cwd, timeoutMs, options);
    if (this.persistentProcesses) return this.#runPersistent(agent, prompt, cwd, timeoutMs, options);
    return this.#runOneShot(agent, prompt, cwd, timeoutMs, options);
  }

  async #appendCliAudit(auditFile: string | null, agent: string, options: PoolRequestOptions, event: LooseRecord) {
    if (!auditFile) return;
    await mkdir(path.dirname(auditFile), { recursive: true });
    await appendFile(auditFile, `${JSON.stringify({
      ts: new Date().toISOString(),
      agent,
      project: options.projectId || null,
      jobId: options.jobId || null,
      phase: options.phase || null,
      role: options.role || null,
      ...(options.env?.CPB_PROVIDER_PREFLIGHT_NONCE ? { correlationNonce: options.env.CPB_PROVIDER_PREFLIGHT_NONCE } : {}),
      ...event,
    })}\n`, "utf8");
  }

  async #runClaudeCli(agent: string, prompt: string, cwd: string, timeoutMs: number, options: PoolRequestOptions = {}) {
    await mkdir(this.cpbRoot, { recursive: true });
    await mkdir(this.hubRoot, { recursive: true });
    const providerKey = this.#providerKeyForRequest(agent, options);
    const env = this.#executionEnv(agent, options);
    const executionCwd = path.resolve(cwd);
    const homeDataRoot = options.dataRoot || env.CPB_PROJECT_RUNTIME_ROOT || null;
    const isolatedHome = await createAgentHome(
      this.cpbRoot,
      "claude",
      String(options.jobId || "default"),
      {
        parentEnv: env,
        dataRoot: homeDataRoot,
        isolateTemp: Boolean(env.CPB_AGENT_FS_BOUNDARY_JSON),
        instanceId: env.CPB_AGENT_HOME_INSTANCE_ID || null,
      },
    );
    Object.assign(env, isolatedHome);
    const auditFile = resolveAcpAuditFile(env);
    const model = String(env.ANTHROPIC_MODEL || env.ZHIPU_MODEL || "").trim();
    const phase = String(options.phase || "");
    const role = String(options.role || "");
    const planning = phase === "plan";
    const writableVerificationReplay = (
      phase === "verify" || phase === "adversarial_verify"
    ) && (
      env.CPB_VERIFIER_REPLAY_WORKSPACE_WRITE === "1"
      || env.CPB_CODEX_VERIFIER_WORKSPACE_WRITE === "1"
    );
    const validationPhase = (phase === "verify" || phase === "review")
      && !writableVerificationReplay;
    const strictReadOnlyPhase = Boolean(phase)
      && !planning
      && phase !== "execute"
      && phase !== "remediate"
      && !validationPhase
      && !writableVerificationReplay;
    const readOnlyPhase = strictReadOnlyPhase || validationPhase || writableVerificationReplay;
    const providerLivePreflight = Boolean(options.env?.CPB_PROVIDER_PREFLIGHT_NONCE);
    const runtimeGuards = resolveAcpRuntimeGuards(env);
    const planningJsonSchema = planning && !providerLivePreflight
      ? claudePlanningJsonSchemaForRole(role)
      : null;
    // CPB must not cap normal planning output. Explicit CPB_CLAUDE_PLAN_MAX_*
    // values remain available for deliberately bounded probes and tests.
    const configuredPlanningThinkingTokens = positiveIntOption(env.CPB_CLAUDE_PLAN_MAX_THINKING_TOKENS, 0);
    const configuredPlanningOutputTokens = positiveIntOption(env.CPB_CLAUDE_PLAN_MAX_TEXT_CHARS, 0);
    if (planning && configuredPlanningThinkingTokens > 0 && !env.MAX_THINKING_TOKENS) {
      env.MAX_THINKING_TOKENS = String(configuredPlanningThinkingTokens);
    }
    if (planning && configuredPlanningOutputTokens > 0 && !env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(configuredPlanningOutputTokens);
    }
    const pathGuardScript = path.resolve(__dirname, "../../../scripts/claude-path-guard.js");
    const configuredPathGuardWriteRoots = String(env.CPB_ACP_WRITE_ALLOW || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry && entry !== "__cpb_no_worktree_writes__")
      .map((entry) => entry.includes("*") ? entry.slice(0, entry.indexOf("*")) : entry)
      .map((entry) => entry.replace(/[\\/]+$/, ""))
      .filter(Boolean);
    const strictPhaseOutputRoot = strictReadOnlyPhase && homeDataRoot
      ? path.join(homeDataRoot, "phase-io", phase)
      : null;
    let pathGuardWriteRoots = configuredPathGuardWriteRoots;
    if (strictReadOnlyPhase) {
      pathGuardWriteRoots = strictPhaseOutputRoot ? [strictPhaseOutputRoot] : [];
    }
    const filesystemBoundary = parseAgentFilesystemBoundary(env.CPB_AGENT_FS_BOUNDARY_JSON);
    const linkedGitMetadataReadRoots = filesystemBoundary
      ? await resolveLinkedGitMetadataReadRoots(executionCwd)
      : [];
    const boundarySettings = filesystemBoundary
      ? claudeFilesystemBoundarySettings(filesystemBoundary, [
          executionCwd,
          ...linkedGitMetadataReadRoots,
          String(env.HOME || ""),
          String(env.TMPDIR || env.TMP || env.TEMP || ""),
          ...pathGuardWriteRoots,
        ].filter(Boolean))
      : null;
    const planningRepositoryDiscovery = planning
      && !providerLivePreflight
      && Boolean(boundarySettings)
      && (planningJsonSchema === null || /^planner_[ab](?:_|$)/.test(role));
    const planningMaxTurns = planning
      ? resolveClaudePlanningMaxTurns({
          configured: env.CPB_CLAUDE_PLAN_MAX_TURNS,
          repositoryDiscovery: planningRepositoryDiscovery,
          structuredOutput: Boolean(planningJsonSchema),
          toolCallBudget: Number(runtimeGuards.toolCallBudget || 0),
        })
      : 0;
    const sandboxedBashEnabled = Boolean(boundarySettings);
    const pathGuardCommand = [process.execPath, pathGuardScript, executionCwd, ...pathGuardWriteRoots]
      .map(shellQuote)
      .join(" ");
    const nativeExecutionSettings = JSON.stringify({
      permissions: {
        allow: ["Glob", "Grep", ...(sandboxedBashEnabled ? ["Bash"] : [])],
        deny: [
          ...(!sandboxedBashEnabled ? ["Bash"] : []),
          "WebFetch", "WebSearch", "NotebookEdit",
          ...(boundarySettings?.permissionDeny || []),
        ],
      },
      hooks: {
        PreToolUse: [{
          matcher: "Read|Edit|Write|Bash",
          hooks: [{
            type: "command",
            command: pathGuardCommand,
            timeout: 5,
          }],
        }],
      },
      sandbox: boundarySettings ? {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        filesystem: {
          allowWrite: [
            executionCwd,
            String(env.HOME || ""),
            String(env.TMPDIR || env.TMP || env.TEMP || ""),
            ...pathGuardWriteRoots,
          ].filter(Boolean),
          denyRead: boundarySettings.denyRead,
          allowRead: boundarySettings.allowRead,
        },
        network: { allowedDomains: [] },
      } : {
        enabled: false,
        allowUnsandboxedCommands: false,
      },
    });
    const nativeVerificationReplaySettings = JSON.stringify({
      permissions: {
        allow: ["Read", "Glob", "Grep", ...(sandboxedBashEnabled ? ["Bash"] : [])],
        deny: [
          ...(!sandboxedBashEnabled ? ["Bash"] : []),
          "Edit", "Write", "MultiEdit", "WebFetch", "WebSearch", "NotebookEdit",
          ...(boundarySettings?.permissionDeny || []),
        ],
      },
      hooks: {
        PreToolUse: [{
          matcher: "Read|Bash",
          hooks: [{
            type: "command",
            command: pathGuardCommand,
            timeout: 5,
          }],
        }],
      },
      sandbox: boundarySettings ? {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        filesystem: {
          // Canonical tests may write build products in this disposable replay.
          // Direct mutation tools stay denied and candidate drift is checked
          // after the verifier returns.
          allowWrite: [
            executionCwd,
            String(env.HOME || ""),
            String(env.TMPDIR || env.TMP || env.TEMP || ""),
            ...pathGuardWriteRoots,
          ].filter(Boolean),
          denyRead: boundarySettings.denyRead,
          allowRead: boundarySettings.allowRead,
        },
        network: { allowedDomains: [] },
      } : {
        enabled: false,
        allowUnsandboxedCommands: false,
      },
    });
    const validationWriteEnabled = phase === "verify" && Boolean(boundarySettings);
    const nativeValidationSettings = JSON.stringify({
      permissions: {
        allow: [
          "Read", "Glob", "Grep",
          ...(validationWriteEnabled ? ["Write"] : []),
          ...(sandboxedBashEnabled ? ["Bash"] : []),
        ],
        deny: [
          ...(!sandboxedBashEnabled ? ["Bash"] : []),
          "Edit", "MultiEdit",
          ...(!validationWriteEnabled ? ["Write"] : []),
          "WebFetch", "WebSearch", "NotebookEdit",
          ...(boundarySettings?.permissionDeny || []),
        ],
      },
      hooks: {
        PreToolUse: [{
          matcher: "Read|Write|Bash",
          hooks: [{
            type: "command",
            command: pathGuardCommand,
            timeout: 5,
          }],
        }],
      },
      sandbox: boundarySettings ? {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        filesystem: {
          // Validation may write its phase-owned verdict and isolated temp
          // files, but it cannot write the candidate checkout.
          allowWrite: [
            String(env.HOME || ""),
            String(env.TMPDIR || env.TMP || env.TEMP || ""),
            ...pathGuardWriteRoots,
          ].filter(Boolean),
          denyRead: boundarySettings.denyRead,
          allowRead: boundarySettings.allowRead,
        },
        network: { allowedDomains: [] },
      } : {
        enabled: false,
        allowUnsandboxedCommands: false,
      },
    });
    const nativeReadOnlySettings = JSON.stringify({
      permissions: {
        allow: ["Read", "Glob", "Grep"],
        deny: ["Bash", "Edit", "Write", "MultiEdit", "WebFetch", "WebSearch", "NotebookEdit"],
      },
      sandbox: boundarySettings ? {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        filesystem: {
          // Read-only phases may persist their structured phase artifact, but
          // provider tools cannot write into the candidate worktree.
          allowWrite: [
            String(env.HOME || ""),
            String(env.TMPDIR || env.TMP || env.TEMP || ""),
            ...pathGuardWriteRoots,
          ].filter(Boolean),
          denyRead: boundarySettings.denyRead,
          allowRead: boundarySettings.allowRead,
        },
        network: { allowedDomains: [] },
      } : {
        enabled: false,
        allowUnsandboxedCommands: false,
      },
    });
    const nativePlanningSettings = JSON.stringify({
      permissions: {
        allow: ["Read", "Glob", "Grep"],
        deny: ["Bash", "Edit", "Write", "MultiEdit", "WebFetch", "WebSearch", "NotebookEdit"],
      },
      sandbox: boundarySettings ? {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        filesystem: {
          // Claude CLI may maintain its isolated home and temporary files, but
          // the planning actor receives no worktree-mutating tools.
          allowWrite: [
            String(env.HOME || ""),
            String(env.TMPDIR || env.TMP || env.TEMP || ""),
          ].filter(Boolean),
          denyRead: boundarySettings.denyRead,
          allowRead: boundarySettings.allowRead,
        },
        network: { allowedDomains: [] },
      } : {
        enabled: false,
        allowUnsandboxedCommands: false,
      },
    });
    const nativeLivePreflightSettings = JSON.stringify({
      permissions: {
        allow: [],
        deny: ["Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "NotebookEdit"],
      },
      sandbox: {
        enabled: false,
        allowUnsandboxedCommands: false,
      },
    });
    const defaultExecutionTools = [
      "Read", "Edit", "Write", "Glob", "Grep",
      ...(sandboxedBashEnabled ? ["Bash"] : []),
    ].join(",");
    const verificationReplayTools = [
      "Read", "Glob", "Grep",
      ...(sandboxedBashEnabled ? ["Bash"] : []),
    ].join(",");
    const validationTools = [
      "Read",
      ...(validationWriteEnabled ? ["Write"] : []),
      "Glob",
      "Grep",
      ...(sandboxedBashEnabled ? ["Bash"] : []),
    ].join(",");
    let runtimeSettings: string | null = null;
    let runtimeTools: string | null = null;
    if (providerLivePreflight) {
      runtimeSettings = nativeLivePreflightSettings;
      runtimeTools = "";
    } else if (!planning) {
      if (strictReadOnlyPhase) {
        runtimeSettings = nativeReadOnlySettings;
        runtimeTools = "Read,Glob,Grep";
      } else if (writableVerificationReplay) {
        runtimeSettings = nativeVerificationReplaySettings;
        runtimeTools = verificationReplayTools;
      } else if (validationPhase) {
        runtimeSettings = nativeValidationSettings;
        runtimeTools = validationTools;
      } else {
        runtimeSettings = nativeExecutionSettings;
        runtimeTools = defaultExecutionTools;
      }
    }
    const runtimeCliArgs = [];
    if (runtimeSettings !== null && runtimeTools !== null) {
      runtimeCliArgs.push(
        "--settings", runtimeSettings,
        "--setting-sources", "user",
        "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
        "--disable-slash-commands",
        "--tools", runtimeTools,
      );
    }
    let planningContractTools = ["StructuredOutput"];
    if (providerLivePreflight) {
      planningContractTools = [];
    } else if (planningRepositoryDiscovery) {
      planningContractTools = ["Read", "Glob", "Grep", "StructuredOutput"];
    }
    const livePreflightPolicy = providerLivePreflight ? {
      terminalPolicy: "deny",
      permissionRequests: "reject",
      webToolsDisabled: true,
      tools: [],
      mcpServers: [],
      slashCommandsDisabled: true,
      settings: {
        permissions: {
          allow: [],
          deny: ["Bash", "Edit", "Glob", "Grep", "MultiEdit", "NotebookEdit", "Read", "WebFetch", "WebSearch", "Write"],
        },
        strictMcpConfig: true,
      },
    } : null;
    let outerSandboxMode = "claude-native-permissions";
    if (planningRepositoryDiscovery) {
      outerSandboxMode = "claude-native-readonly-plan";
    } else if (planning) {
      outerSandboxMode = "zero-repository-tool-plan";
    } else if (strictReadOnlyPhase) {
      outerSandboxMode = "claude-native-readonly";
    } else if (writableVerificationReplay) {
      outerSandboxMode = "claude-native-verification-replay";
    } else if (validationPhase) {
      outerSandboxMode = "claude-native-validation";
    }
    const args = [
      "-p",
      ...(planning ? ["--bare"] : []),
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "dontAsk",
      "--effort", planning ? "low" : "high",
      "--no-session-persistence",
      // Keep the user's provider configuration, but ignore repository-local
      // settings so an untrusted task cannot widen the explicit deny rules.
      ...runtimeCliArgs,
      ...(planningRepositoryDiscovery ? [
        "--settings", nativePlanningSettings,
        "--setting-sources", "user",
        "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
        "--disable-slash-commands",
        "--tools", "Read,Glob,Grep",
      ] : planning ? ["--tools", ""] : []),
      ...(planning && planningMaxTurns > 0 ? ["--max-turns", String(planningMaxTurns)] : []),
      // Claude-compatible planning providers do not all honor prose-only
      // instructions to return one bounded JSON object. Native structured
      // output keeps the transport contract machine-enforced while the
      // tournament parser continues to validate the role-specific schema.
      ...(planningJsonSchema ? ["--json-schema", JSON.stringify(planningJsonSchema)] : []),
      ...(model ? ["--model", model] : []),
    ];
    const cliCommand = env.CPB_CLAUDE_CLI_COMMAND || "claude";
    // Initial planners may inspect the bounded checkout with Read/Glob/Grep
    // under Claude's native fail-closed filesystem sandbox. Later tournament
    // rounds receive the frozen proposals and expose only StructuredOutput.
    // Wrapping the CLI process itself in sandbox-exec breaks its provider
    // stream on macOS, so the native settings own this boundary.
    const launch = { command: cliCommand, args };
    const streamFile = options.dataRoot
      ? path.join(
          options.dataRoot,
          "acp-streams",
          String(options.jobId || "job").replace(/[^A-Za-z0-9_.-]/g, "-"),
          `${String(options.role || phase || "agent").replace(/[^A-Za-z0-9_.-]/g, "-")}.jsonl`,
        )
      : null;
    if (streamFile) await mkdir(path.dirname(streamFile), { recursive: true });
    await this.#appendCliAudit(auditFile, agent, options, {
      event: "agent_launch",
      command: path.basename(launch.command),
      transport: "claude-cli",
      model: model || null,
      streamFile,
      runtimeGuards,
      planningContract: planning ? {
        structuredOutput: Boolean(planningJsonSchema),
        repositoryDiscovery: planningRepositoryDiscovery,
        maxTurns: planningMaxTurns,
        tools: planningContractTools,
      } : null,
      livePreflightPolicy,
      executionPolicy: {
        outerSandboxMode,
        readOnly: planning || readOnlyPhase,
        sourceBoundary: filesystemBoundary ? {
          schemaVersion: filesystemBoundary.schemaVersion,
          dependencyReadRootCount: filesystemBoundary.dependencyReadRoots.length,
          denyReadPathCount: filesystemBoundary.denyReadPaths.length,
        } : null,
      },
    });
    // Home/settings preparation can fail before a child exists. Acquire the
    // provider lease only after those fallible local steps so every acquired
    // lease is covered by the release finally below.
    const lease = await this.#acquireConnectionLease(agent, providerKey, options);
    try {
      // No await is allowed between this gate and the synchronous Promise
      // executor adding the child to oneShotChildren. That makes stop() either
      // win before spawn or observe and terminate the spawned child.
      throwIfAborted(options.signal);
      if (this.stopped) throw new Error("ACP pool stopped");
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(launch.command, launch.args, {
          cwd: executionCwd,
          env: childEnvWithoutControlPlaneAuditPath(env),
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        }) as SpawnedChild;
        this.oneShotChildren.add(child);
        captureSpawnedChildIdentity(child);
        let stdout = "";
        let stdoutLineBuffer = "";
        let stderr = "";
        let settled = false;
        let streamWriteChain = Promise.resolve();
        let auditWriteChain = Promise.resolve();
        let lastStreamAuditAt = 0;
        let generatedTextChars = 0;
        let generatedThinkingTokens = 0;
        let latestStructuredOutputJson: string | null = null;
        let latestStructuredOutputSha256: string | null = null;
        let structuredOutputCandidateCount = 0;
        let structuredOutputChars = 0;
        const structuredOutputFingerprints = new Set<string>();
        const toolCallFingerprints = new Set<string>();
        const toolEventFingerprints = new Set<string>();
        const executeNoEditToolFingerprints = new Set<string>();
        let executeNoEditSatisfied = false;
        let executeNoEditIdleTimer: NodeJS.Timeout | null = null;
        let auditUpdateEvents = 0;
        let abortCleanup: (() => void) | null = null;
        const configuredTextBudget = Number(env.CPB_CLAUDE_PLAN_MAX_TEXT_CHARS || 0);
        const configuredThinkingBudget = Number(env.CPB_CLAUDE_PLAN_MAX_THINKING_TOKENS || 0);
        const maxGeneratedTextChars = planning
          ? Math.max(0, Number.isFinite(configuredTextBudget) ? configuredTextBudget : 0)
          : 0;
        const maxGeneratedThinkingTokens = planning
          ? Math.max(0, Number.isFinite(configuredThinkingBudget) ? configuredThinkingBudget : 0)
          : 0;
        const configuredInternalRetries = Number(env.CPB_CLAUDE_MAX_INTERNAL_API_RETRIES || 3);
        const maxInternalApiRetries = Math.max(1, Number.isFinite(configuredInternalRetries) ? configuredInternalRetries : 3);
        const idleTimeoutMs = runtimeGuards.promptIdleTimeoutMs;
        let idleTimer: NodeJS.Timeout | null = null;
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          if (idleTimeoutMs <= 0 || settled) return;
          idleTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (executeNoEditIdleTimer) clearTimeout(executeNoEditIdleTimer);
            rejectAfterCleanup(
              reject,
              new Error(`${agent} CLI stream idle timed out after ${idleTimeoutMs}ms without output`),
              [terminateChild(child)],
            );
          }, idleTimeoutMs);
          idleTimer.unref();
        };
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            if (settled) return;
            settled = true;
            if (idleTimer) clearTimeout(idleTimer);
            if (executeNoEditIdleTimer) clearTimeout(executeNoEditIdleTimer);
            rejectAfterCleanup(
              reject,
              new Error(`${agent} timed out after ${timeoutMs}ms`),
              [terminateChild(child)],
            );
          }, timeoutMs)
          : null;
        if (timer) timer.unref();
        const clearExecutionTimers = () => {
          if (timer) clearTimeout(timer);
          if (idleTimer) clearTimeout(idleTimer);
          if (executeNoEditIdleTimer) clearTimeout(executeNoEditIdleTimer);
          abortCleanup?.();
          abortCleanup = null;
          idleTimer = null;
          executeNoEditIdleTimer = null;
        };
        const rejectAfterFailureCleanup = (error: Error, audit: Promise<unknown>) => {
          clearExecutionTimers();
          rejectAfterCleanup(reject, error, [audit, streamWriteChain, terminateChild(child)]);
        };
        const failOutputBudget = () => {
          if (settled) return;
          settled = true;
          const reason = `agent_output_budget_exceeded: ${agent} generated textChars=${generatedTextChars}/${maxGeneratedTextChars}, thinkingTokens=${generatedThinkingTokens}/${maxGeneratedThinkingTokens}`;
          const audit = auditWriteChain.then(() => this.#appendCliAudit(auditFile, agent, options, {
            event: "output_budget_exceeded",
            transport: "claude-cli",
            generatedTextChars,
            maxGeneratedTextChars,
            generatedThinkingTokens,
            maxGeneratedThinkingTokens,
            structuredOutputCandidateCount,
            structuredOutputChars,
          }));
          rejectAfterFailureCleanup(new Error(reason), audit);
        };
        const failProviderRetry = (retry: ClaudeApiRetryEvent) => {
          if (settled) return;
          settled = true;
          const statusLabel = retry.httpStatus == null ? "unknown-status" : String(retry.httpStatus);
          const errorLabel = retry.error || "retryable provider error";
          const reason = `${statusLabel} ${errorLabel} after ${retry.attempt} internal retries; CPB is yielding the worker for a fresh scheduled retry`;
          const audit = auditWriteChain.then(() => this.#appendCliAudit(auditFile, agent, options, {
            event: "provider_retry_exhausted",
            transport: "claude-cli",
            httpStatus: retry.httpStatus,
            attempt: retry.attempt,
            maxInternalApiRetries,
            providerMaxRetries: retry.maxRetries,
            retryDelayMs: retry.retryDelayMs,
            providerError: retry.error,
            sessionId: retry.sessionId,
            retryUuid: retry.uuid,
          }));
          rejectAfterFailureCleanup(new Error(reason), audit);
        };
        const failRuntimeGuard = (
          toolEvent: ClaudeCliToolAuditEvent,
          auditEvent: "tool_blocked" | "tool_budget_exceeded" | "tool_event_budget_exceeded",
          reason: string,
          details: LooseRecord,
        ) => {
          if (settled) return false;
          settled = true;
          const audit = auditWriteChain.then(() => this.#appendCliAudit(auditFile, agent, options, {
            ...toolEvent,
            event: auditEvent,
            transport: "claude-cli",
            ...details,
            reason,
          }));
          auditWriteChain = audit.then(() => undefined);
          rejectAfterFailureCleanup(new Error(`PERMISSION_FAIL_FAST: ${reason}`), audit);
          return true;
        };
        const armExecuteNoEditIdleTimer = (toolEvent: ClaudeCliToolAuditEvent, count: number) => {
          if (executeNoEditIdleTimer) clearTimeout(executeNoEditIdleTimer);
          const timeout = runtimeGuards.executeNoEditIdleTimeoutMs;
          if (timeout <= 0 || executeNoEditSatisfied || settled) return;
          executeNoEditIdleTimer = setTimeout(() => {
            const classification = "execute_no_edit_progress";
            const reason = `${classification}: execute phase made ${count} read/search tool calls without edits and then went idle for ${timeout}ms; stop re-reading, make the planned source/test edit, or report a concrete blocker`;
            failRuntimeGuard(toolEvent, "tool_blocked", reason, {
              classification,
              noEditToolLimit: runtimeGuards.executeNoEditToolLimit,
              noEditToolCount: count,
              noEditIdleTimeoutMs: timeout,
            });
          }, timeout);
          executeNoEditIdleTimer.unref();
        };
        const enforceClaudeRuntimeGuards = (toolEvent: ClaudeCliToolAuditEvent) => {
          const fingerprint = `id:${toolEvent.toolCallId}`;
          if (toolEvent.status === "in_progress" && toolEvent.kind === "edit") {
            executeNoEditToolFingerprints.clear();
            if (executeNoEditIdleTimer) clearTimeout(executeNoEditIdleTimer);
            executeNoEditIdleTimer = null;
            executeNoEditSatisfied = true;
          } else if (
            !executeNoEditSatisfied
            && toolEvent.status === "in_progress"
            && (toolEvent.kind === "read" || toolEvent.kind === "search")
            && runtimeGuards.executeNoEditToolLimit > 0
          ) {
            executeNoEditToolFingerprints.add(fingerprint);
            const count = executeNoEditToolFingerprints.size;
            armExecuteNoEditIdleTimer(toolEvent, count);
            if (count > runtimeGuards.executeNoEditToolLimit) {
              const classification = "execute_no_edit_progress";
              const reason = `${classification}: execute phase exceeded no-edit read/search limit ${runtimeGuards.executeNoEditToolLimit}; stop re-reading, make the planned source/test edit, or report a concrete blocker`;
              return failRuntimeGuard(toolEvent, "tool_blocked", reason, {
                classification,
                noEditToolLimit: runtimeGuards.executeNoEditToolLimit,
                noEditToolCount: count,
              });
            }
          }

          auditUpdateEvents += 1;
          toolCallFingerprints.add(fingerprint);
          toolEventFingerprints.add([
            fingerprint,
            toolEvent.status,
            toolEvent.title || "",
            toolEvent.kind || "",
            toolEvent.toolName || "",
          ].join("|"));
          const normalizedToolEvents = toolEventFingerprints.size;
          if (runtimeGuards.toolEventBudget > 0 && normalizedToolEvents > runtimeGuards.toolEventBudget) {
            const reason = `tool_event_budget_exceeded: ACP phase exceeded normalized tool-event budget ${runtimeGuards.toolEventBudget}`;
            return failRuntimeGuard(toolEvent, "tool_event_budget_exceeded", reason, {
              toolEventBudget: runtimeGuards.toolEventBudget,
              auditUpdateEvents,
              normalizedToolEvents,
            });
          }
          const normalizedToolCalls = toolCallFingerprints.size;
          if (runtimeGuards.toolCallBudget > 0 && normalizedToolCalls > runtimeGuards.toolCallBudget) {
            const reason = `tool_budget_exceeded: ACP phase exceeded normalized tool-call budget ${runtimeGuards.toolCallBudget}`;
            return failRuntimeGuard(toolEvent, "tool_budget_exceeded", reason, {
              toolCallBudget: runtimeGuards.toolCallBudget,
              normalizedToolCalls,
              auditUpdateEvents,
            });
          }
          return false;
        };
        const finishWithResult = (result: LooseRecord) => {
          if (settled) return;
          const terminalFailure = result.is_error === true || result.subtype !== "success";
          const maxTurnToolStop = planning
            && result.subtype === "error_max_turns"
            && result.stop_reason === "tool_use";
          const resultStructuredOutputJson = isRecord(result.structured_output)
            ? JSON.stringify(result.structured_output)
            : null;
          const recoveredStructuredOutputJson = maxTurnToolStop && planningJsonSchema
            ? resultStructuredOutputJson || latestStructuredOutputJson
            : null;
          if (terminalFailure && !recoveredStructuredOutputJson) {
            settled = true;
            clearExecutionTimers();
            const resultErrors = Array.isArray(result.errors)
              ? result.errors.map((entry) => String(entry)).filter(Boolean).join("; ")
              : "";
            const resultDetail = [String(result.result || "").trim(), resultErrors, stderr.trim()]
              .filter(Boolean)
              .join("; ")
              .slice(-1000);
            const reason = maxTurnToolStop
              ? `tool_budget_exceeded: ${agent} structured planning exhausted maxTurns=${planningMaxTurns} stopReason=tool_use without a recoverable StructuredOutput candidate: ${resultDetail}`
              : `${agent} returned an unsuccessful Claude CLI result subtype=${String(result.subtype || "unknown")} stopReason=${String(result.stop_reason || "unknown")}: ${resultDetail}`;
            if (maxTurnToolStop) {
              const audit = auditWriteChain.then(() => this.#appendCliAudit(auditFile, agent, options, {
                event: "planning_turn_budget_exhausted",
                transport: "claude-cli",
                resultSubtype: result.subtype,
                stopReason: result.stop_reason,
                numTurns: Number(result.num_turns || 0),
                maxTurns: planningMaxTurns,
                structuredOutputCandidateCount,
                recoverableCandidate: false,
              }));
              rejectAfterFailureCleanup(new Error(reason), audit);
            } else {
              rejectAfterCleanup(reject, new Error(reason), [terminateChild(child)]);
            }
            return;
          }
          settled = true;
          clearExecutionTimers();
          const usage = isRecord(result.usage) ? result.usage : {};
          const inputTokens = Number(usage.input_tokens || 0);
          const cachedInputTokens = Number(usage.cache_read_input_tokens || 0);
          const cacheCreationTokens = Number(usage.cache_creation_input_tokens || 0);
          const outputTokens = Number(usage.output_tokens || 0);
          const normalizedUsage = {
            inputTokens,
            cachedInputTokens,
            outputTokens,
            reasoningOutputTokens: 0,
            totalTokens: inputTokens + cachedInputTokens + cacheCreationTokens + outputTokens,
            costUsd: Number(result.total_cost_usd || 0),
            toolCalls: Array.isArray(usage.iterations) ? usage.iterations.length : 0,
            functionCalls: 0,
            events: 1,
            tokenSource: "claude_cli_result",
          };
          let audit = auditWriteChain.then(() => this.#appendCliAudit(auditFile, agent, options, {
            event: "prompt_usage",
            sessionId: typeof result.session_id === "string" ? result.session_id : null,
            usage: normalizedUsage,
          }));
          if (recoveredStructuredOutputJson) {
            const candidateSha256 = resultStructuredOutputJson
              ? createHash("sha256").update(resultStructuredOutputJson).digest("hex")
              : latestStructuredOutputSha256;
            audit = audit.then(() => this.#appendCliAudit(auditFile, agent, options, {
              event: "structured_output_recovered",
              transport: "claude-cli",
              source: resultStructuredOutputJson ? "result.structured_output" : "assistant.tool_use",
              resultSubtype: result.subtype,
              stopReason: result.stop_reason,
              numTurns: Number(result.num_turns || 0),
              maxTurns: planningMaxTurns,
              structuredOutputCandidateCount,
              selectedCandidateIndex: resultStructuredOutputJson ? null : structuredOutputCandidateCount,
              candidateSha256,
              candidateBytes: Buffer.byteLength(recoveredStructuredOutputJson),
            }));
          }
          audit = audit.then(() => this.#appendCliAudit(auditFile, agent, options, {
            event: "session_close",
            sessionId: typeof result.session_id === "string" ? result.session_id : null,
            reason: recoveredStructuredOutputJson ? "structured_output_recovered" : "prompt_complete",
            transport: "claude-cli",
          }));
          const structuredOutput = result.structured_output;
          const output = recoveredStructuredOutputJson || (isRecord(structuredOutput)
            ? JSON.stringify(structuredOutput)
            : String(structuredOutput || result.result || "").trim());
          Promise.all([audit, streamWriteChain, terminateChild(child)])
            .then(() => resolve(output), reject);
        };
        const inspectResultLine = (line: string) => {
          if (!line.trim() || settled) return;
          try {
            const parsed = JSON.parse(line);
            const providerEvent = isRecord(parsed) && isRecord(parsed.event) ? parsed.event : {};
            const delta = isRecord(providerEvent.delta) ? providerEvent.delta : {};
            const retryEvent = normalizeClaudeApiRetryEvent(parsed);
            for (const candidateJson of claudeStructuredOutputCandidates(parsed)) {
              const fingerprint = createHash("sha256").update(candidateJson).digest("hex");
              if (structuredOutputFingerprints.has(fingerprint)) continue;
              structuredOutputFingerprints.add(fingerprint);
              structuredOutputCandidateCount += 1;
              structuredOutputChars += candidateJson.length;
              generatedTextChars += candidateJson.length;
              latestStructuredOutputJson = candidateJson;
              latestStructuredOutputSha256 = fingerprint;
            }
            if (planning && maxGeneratedTextChars > 0 && generatedTextChars > maxGeneratedTextChars) {
              failOutputBudget();
              return;
            }
            for (const toolEvent of normalizeClaudeCliToolAuditEvents(parsed)) {
              auditWriteChain = auditWriteChain.then(() => this.#appendCliAudit(auditFile, agent, options, {
                ...toolEvent,
                transport: "claude-cli",
              }));
              if (enforceClaudeRuntimeGuards(toolEvent)) return;
            }
            if (retryEvent) {
              auditWriteChain = auditWriteChain.then(() => this.#appendCliAudit(auditFile, agent, options, {
                event: "provider_api_retry",
                transport: "claude-cli",
                httpStatus: retryEvent.httpStatus,
                attempt: retryEvent.attempt,
                maxInternalApiRetries,
                providerMaxRetries: retryEvent.maxRetries,
                retryDelayMs: retryEvent.retryDelayMs,
                providerError: retryEvent.error,
                sessionId: retryEvent.sessionId,
                retryUuid: retryEvent.uuid,
              }));
              // The CLI emits api_retry only for errors it has already deemed
              // retryable. CPB owns the outer scheduling budget, including
              // connection failures whose error_status is null.
              if (retryEvent.attempt >= maxInternalApiRetries) {
                failProviderRetry(retryEvent);
                return;
              }
            }
            if (planning && isRecord(parsed) && parsed.type === "system" && parsed.subtype === "thinking_tokens") {
              const estimatedTokens = Number(parsed.estimated_tokens || 0);
              if (Number.isFinite(estimatedTokens)) generatedThinkingTokens = Math.max(generatedThinkingTokens, estimatedTokens);
              if (maxGeneratedThinkingTokens > 0 && generatedThinkingTokens > maxGeneratedThinkingTokens) {
                failOutputBudget();
                return;
              }
            }
            if (planning && delta.type === "text_delta" && typeof delta.text === "string") {
              generatedTextChars += delta.text.length;
              if (maxGeneratedTextChars > 0 && generatedTextChars > maxGeneratedTextChars) {
                failOutputBudget();
                return;
              }
            }
            if (isRecord(parsed) && parsed.type === "result") finishWithResult(parsed);
            else if (isRecord(parsed) && Date.now() - lastStreamAuditAt >= 5_000) {
              lastStreamAuditAt = Date.now();
              auditWriteChain = auditWriteChain.then(() => this.#appendCliAudit(auditFile, agent, options, {
                event: "provider_stream_event",
                transport: "claude-cli",
                messageType: typeof parsed.type === "string" ? parsed.type : null,
                eventType: typeof providerEvent.type === "string" ? providerEvent.type : null,
              }));
            }
          } catch {
            // Stream diagnostics are allowed; only structured result lines end the turn.
          }
        };
        abortCleanup = addAbortHandler(options.signal, () => {
          if (settled) return;
          settled = true;
          clearExecutionTimers();
          rejectAfterCleanup(
            reject,
            abortErrorForSignal(options.signal),
            [streamWriteChain, auditWriteChain, terminateChild(child)],
          );
        });
        resetIdleTimer();
        child.stdout.on("data", (chunk) => {
          const text = String(chunk);
          stdout += text;
          if (streamFile) streamWriteChain = streamWriteChain.then(() => appendFile(streamFile, text, "utf8"));
          stdoutLineBuffer += text;
          const lines = stdoutLineBuffer.split(/\r?\n/);
          stdoutLineBuffer = lines.pop() || "";
          for (const line of lines) inspectResultLine(line);
          resetIdleTimer();
          void reportPoolProgress(options.onProgress, {
            type: "provider_activity",
            agent,
            providerKey,
            phase: options.phase || null,
            role: options.role || null,
          });
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          resetIdleTimer();
          void reportPoolProgress(options.onProgress, {
            type: "provider_activity",
            agent,
            providerKey,
            phase: options.phase || null,
            role: options.role || null,
          });
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearExecutionTimers();
          rejectAfterCleanup(reject, error, [terminateChild(child)]);
        });
        child.on("close", (code, signal) => {
          this.oneShotChildren.delete(child);
          if (settled) return;
          clearExecutionTimers();
          if (code !== 0) {
            settled = true;
            reject(new Error(`${agent} exited ${code} signal=${signal || "none"}: ${stderr.slice(-1000)}`));
            return;
          }
          // A normally exiting process may leave the final JSON line without a
          // newline. Inspect it once before declaring the transport incomplete.
          inspectResultLine(stdoutLineBuffer);
          if (!settled) {
            settled = true;
            reject(new Error(
              `${agent} did not return a successful Claude CLI result: ${stderr.slice(-1000) || stdout.slice(-1000)}`,
            ));
          }
        });
        child.stdin.end(prompt);
      });
    } finally {
      await this.#releaseConnectionLease(lease);
    }
  }

  async #runOneShot(agent: string, prompt: string, cwd: string, timeoutMs: number, options: PoolRequestOptions = {}) {
    await mkdir(this.cpbRoot, { recursive: true });
    await mkdir(this.hubRoot, { recursive: true });
    const providerKey = this.#providerKeyForRequest(agent, options);
    const lease = await this.#acquireConnectionLease(agent, providerKey, options);
    const customClient = this.env.CPB_ACP_CLIENT;
    const clientPath = customClient || path.join(__dirname, "acp-client.js");
    const command = customClient ? clientPath : process.execPath;
    const args = customClient ? ["--agent", agent, "--cwd", cwd] : [clientPath, "--agent", agent, "--cwd", cwd];
    const env = this.#executionEnv(agent, options);
    if (env.CPB_PROJECT_RUNTIME_ROOT) {
      await mkdir(path.join(env.CPB_PROJECT_RUNTIME_ROOT, "agent-homes"), { recursive: true });
      await mkdir(path.join(env.CPB_PROJECT_RUNTIME_ROOT, "acp-audit"), { recursive: true });
    }
    try {
      throwIfAborted(options.signal);
      return await new Promise<string>((resolve, reject) => {
        const launch = customClient
          ? buildAgentSandboxLaunch(command, args, { env, cwd: this.cpbRoot })
          : { command, args };
        const child = spawn(launch.command, launch.args, {
          cwd: this.cpbRoot,
          env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        }) as SpawnedChild;
        this.oneShotChildren.add(child);
        captureSpawnedChildIdentity(child);
        let stdout = "";
        let stderr = "";
        let settled = false;
        let abortCleanup: (() => void) | null = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          abortCleanup?.();
          abortCleanup = null;
        };
        child.once("close", () => {
          this.oneShotChildren.delete(child);
        });
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectAfterCleanup(
              reject,
              new Error(`${agent} timed out after ${timeoutMs}ms`),
              [terminateChild(child)],
            );
          }, timeoutMs + ONE_SHOT_CLOSE_GRACE_MS)
          : null;
        if (timer) timer.unref();
        abortCleanup = addAbortHandler(options.signal, () => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectAfterCleanup(reject, abortErrorForSignal(options.signal), [terminateChild(child)]);
        });
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          this.#reportAgentActivity(agent, providerKey, chunk, options);
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectAfterCleanup(reject, error, [terminateChild(child)]);
        });
        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (code === 0) resolve(stdout.trim());
          else reject(new AcpExecutionError(
            `${agent} exited ${code} signal=${signal || "none"}: ${stderr.slice(-1000)}`,
            {
              agent,
              providerKey,
              stdout,
              stderr,
              exitCode: code,
              signal,
              phase: options.phase || null,
              role: options.role || null,
            },
          ));
        });
        child.stdin.write(prompt);
        child.stdin.end();
      });
    } finally {
      await this.#releaseConnectionLease(lease);
    }
  }

  #runPersistent(agent: string, prompt: string, cwd: string, timeoutMs: number, options: PoolRequestOptions = {}) {
    throwIfAborted(options.signal);
    const key = this.#persistentClientKey(agent, { ...options, cwd });
    const prior = this.persistentChains.get(key) || Promise.resolve();
    const providerKey = this.#providerKeyForRequest(agent, options);
    const waitTimeout = this.#poolWaitTimeoutMs(options.waitTimeoutMs);
    const warnInterval = POOL_WAIT_WARN_INTERVAL_MS;

    // Wrap prior promise with timeout + warn so a stuck predecessor doesn't block forever
    const timedPrior = new Promise<void>((resolve, reject) => {
      let elapsed = 0;
      let settled = false;
      const warnTimer = setInterval(() => {
        elapsed += warnInterval;
        if (waitTimeout > 0 && elapsed >= waitTimeout) {
          settled = true;
          clearInterval(warnTimer);
          cleanup();
          reject(new PoolExhaustedError(agent, providerKey, elapsed, `persistent chain wait timeout: ${agent}/${providerKey} waited ${Math.round(elapsed / 1000)}s for prior call to complete`));
        } else {
          const ts = new Date().toISOString();
          process.stderr.write(`${ts} [warn] [acp-pool] persistent chain wait: ${agent} waiting ${Math.round(elapsed / 1000)}s for prior call to complete\n`);
        }
      }, warnInterval);
      warnTimer.unref();
      const cleanup = addAbortHandler(options.signal, () => {
        if (settled) return;
        settled = true;
        clearInterval(warnTimer);
        reject(abortErrorForSignal(options.signal));
      });
      const finishPrior = () => {
        if (settled) return;
        settled = true;
        clearInterval(warnTimer);
        cleanup();
        resolve();
      };
      prior.then(finishPrior, finishPrior);
    });

    const run = timedPrior
      .then(() => this.#runPersistentNow(key, agent, prompt, cwd, timeoutMs, options));
    this.persistentChains.set(key, run.catch(() => null));
    return run;
  }

  async #runPersistentNow(key: string, agent: string, prompt: string, cwd: string, timeoutMs: number, options: PoolRequestOptions = {}) {
    throwIfAborted(options.signal);
    const persistent = await this.#getPersistentClient(key, agent, cwd, options);
    if (options.signal?.aborted) {
      await this.#closePersistentClient(key);
      throw abortErrorForSignal(options.signal);
    }
    persistent.projectId = stringValue(options.projectId);
    persistent.jobId = stringValue(options.jobId);
    persistent.dataRoot = this.#requestDataRoot(options, persistent);
    persistent.lastCwd = cwd;
    const client = persistent.client;
    const executionEnv = this.#executionEnv(agent, options);
    const providerKey = this.#providerKeyForRequest(agent, options);
    client.setAuditContext(executionEnv, {
      cwd,
      writeAllowPaths: resolveWriteAllowPaths(cwd, executionEnv),
    });
    const previousOutputSink = client.outputSink;
    const previousErrorSink = client.errorSink;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let abortCleanup: (() => void) | undefined;
    let requestedTeardown: Promise<void> | null = null;
    const beginTeardown = () => {
      requestedTeardown ||= this.#closePersistentClient(key);
      return requestedTeardown;
    };

    const timeout = timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            beginTeardown();
            reject(new Error(`${agent} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref();
        })
      : new Promise<never>(() => {}); // never resolves — no timeout
    const abort = new Promise<never>((_, reject) => {
      abortCleanup = addAbortHandler(options.signal, () => {
        beginTeardown();
        reject(abortErrorForSignal(options.signal));
      });
    });

    client.outputSink = (chunk: string | Buffer) => { stdout += chunk?.toString ? chunk.toString() : String(chunk); };
    client.errorSink = (chunk: string | Buffer) => {
      stderr += chunk?.toString ? chunk.toString() : String(chunk);
      this.#reportAgentActivity(agent, providerKey, chunk, options);
    };

    try {
      const sessionId = await Promise.race([client.promptOnce(prompt, cwd), timeout, abort]);
      if (options.signal?.aborted) {
        throw abortErrorForSignal(options.signal);
      }
      persistent.requestCount += 1;
      persistent.lastUsedAt = Date.now();
      // Capture sessionId for cached lifecycle
      if (sessionId) {
        const session = this.sessions.get(persistent.sessionKey);
        if (session) session.sessionId = sessionId;
      }
      return stdout.trim();
    } catch (error) {
      let primary = asExecutionError(error);
      if (!isAbortError(primary) && stderr && !String(primary.message || "").includes(stderr.slice(-120))) {
        primary = new Error(`${primary.message}: ${stderr.slice(-1000)}`, { cause: primary });
      }
      const cleanupResults = await Promise.allSettled([requestedTeardown || beginTeardown()]);
      const cleanupErrors = cleanupResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => asExecutionError(result.reason));
      throw primaryWithCleanupErrors(primary, cleanupErrors);
    } finally {
      if (timer) clearTimeout(timer);
      abortCleanup?.();
      client.outputSink = previousOutputSink;
      client.errorSink = previousErrorSink;
    }
  }

  async #getPersistentClient(key: string, agent: string, cwd: string, options: PoolRequestOptions = {}) {
    throwIfAborted(options.signal);
    const existing = this.persistentClients.get(key);
    // Defense-in-depth: never reuse a persistent client spawned for a different
    // provider. poolClientKey is agent+conversation-scoped and does NOT encode
    // providerKey, so an exotic same-agent/same-conversation request with a
    // different providerKey would otherwise inherit the stale client. On
    // mismatch, fall through to close + respawn for the now-different provider.
    if (existing && existing.client.isUsable()
      && existing.providerKey === this.#providerKeyForRequest(agent, options)) {
      return existing;
    }
    if (existing) await this.#closePersistentClient(key);

    // Load cached sessionId for cached lifecycle agents
    let resumeSessionId = null;
    const reg = await getRegistry();
    const desc = reg?.getDescriptor(agent);
    const conversationKey = this.#conversationKey(options);
    const dataRoot = this.#requestDataRoot(options);
    if (desc?.lifecycle === "cached") {
      const cached = await loadSessionId(this.cpbRoot, agent, {
        dataRoot,
        ...(conversationKey ? { conversationKey } : {}),
      }).catch(() => null);
      if (cached?.sessionId) resumeSessionId = cached.sessionId;
    }

    const providerKey = this.#providerKeyForRequest(agent, options);
    const lease = await this.#acquireConnectionLease(agent, providerKey, options);
    if (options.signal?.aborted) {
      await this.#releaseConnectionLease(lease);
      throw abortErrorForSignal(options.signal);
    }
    const launchScopedMcp = this.#usesLaunchScopedMcp(agent, { ...options, cwd });
    const executionEnv = this.#executionEnv(agent, options);
    const client = new AcpClient({
      agent,
      cwd,
      prompt: "",
      writeAllowPaths: resolveWriteAllowPaths(cwd, executionEnv),
      terminalPolicy: this.env.CPB_ACP_TERMINAL === "deny" ? "deny" : "allow",
      toolPolicy: await this.#getToolPolicy(),
      outputSink: () => {},
      errorSink: () => {},
      env: executionEnv,
      resumeSessionId,
      reuseSession: true,
      agentHomeInstanceId: conversationAgentHomeInstanceId(conversationKey),
    });
    const meta: PersistentClientState = {
      client,
      agent,
      projectId: stringValue(options.projectId),
      jobId: stringValue(options.jobId),
      dataRoot,
      conversationKey,
      sessionKey: this.#sessionKey(agent, { ...options, cwd }),
      providerKey,
      connectionLease: lease,
      launchCwd: cwd,
      launchScopedMcp,
      startedAt: Date.now(),
      requestCount: 0,
      lastUsedAt: null,
    };
    this.persistentClients.set(key, meta);
    this.#noteSpawn(agent);

    try {
      throwIfAborted(options.signal);
      let startAbortCleanup: (() => void) | undefined;
      const startAbort = new Promise<never>((_, reject) => {
        startAbortCleanup = addAbortHandler(options.signal, () => {
          reject(abortErrorForSignal(options.signal));
        });
      });
      try {
        await Promise.race([client.start(), startAbort]);
      } finally {
        startAbortCleanup?.();
      }
      if (options.signal?.aborted) {
        throw abortErrorForSignal(options.signal);
      }
      return meta;
    } catch (error) {
      const closeResults = await Promise.allSettled([client.close()]);
      const leaseResults = closeResults[0].status === "fulfilled"
        ? await Promise.allSettled([this.#releaseConnectionLease(lease)])
        : [];
      if (leaseResults[0]?.status === "fulfilled") meta.connectionLease = null;
      const cleanupErrors = [...closeResults, ...leaseResults]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => asExecutionError(result.reason));
      if (cleanupErrors.length === 0) this.persistentClients.delete(key);
      throw primaryWithCleanupErrors(error, cleanupErrors);
    }
  }

  #reportAgentActivity(agent: string, providerKey: string, chunk: string | Buffer, options: PoolRequestOptions = {}) {
    const lines = acpActivityLines(agent, chunk);
    if (lines.length === 0) return;
    for (const line of lines) {
      void reportPoolProgress(options.onProgress, {
        type: "agent_activity",
        phase: stringValue(options.phase),
        role: stringValue(options.role),
        jobId: stringValue(options.jobId),
        project: stringValue(options.projectId),
        agent,
        providerKey,
        message: line.replace(/\s+/g, " ").slice(0, 500),
      });
    }
  }

  #getToolPolicy() {
    if (!this.toolPolicyPromise) this.toolPolicyPromise = parseToolPolicy(this.env);
    return this.toolPolicyPromise;
  }

  async #closePersistentClient(keyOrAgent: string) {
    // Support both compound key (agent::role::projectId) and bare agent name
    const matchingKeys = [...this.persistentClients.keys()].filter(k =>
      k === keyOrAgent || k.startsWith(`${keyOrAgent}::`)
    );

    const cleanupErrors: unknown[] = [];
    for (const key of matchingKeys) {
      const persistent = this.persistentClients.get(key);
      if (!persistent) continue;
      const agent = persistent.agent;
      // Save sessionId for cached lifecycle before closing
      const session = this.sessions.get(persistent.sessionKey);
      const saveSession = session?.sessionId ? (async () => {
        const reg = await getRegistry();
        const desc = reg?.getDescriptor(agent);
        if (desc?.lifecycle === "cached") {
          await saveSessionId(this.cpbRoot, agent, session.sessionId, {
            dataRoot: this.#requestDataRoot({}, persistent),
            ...(persistent.conversationKey ? { conversationKey: persistent.conversationKey } : {}),
          });
        }
      })() : Promise.resolve();
      const closeResults = await Promise.allSettled([
        saveSession,
        persistent.client.close(),
      ]);
      const leaseResults = closeResults[1].status === "fulfilled"
        ? await Promise.allSettled([this.#releaseConnectionLease(persistent.connectionLease)])
        : [];
      if (leaseResults[0]?.status === "fulfilled") persistent.connectionLease = null;
      if (closeResults[1].status === "fulfilled" && leaseResults[0]?.status === "fulfilled") {
        this.persistentClients.delete(key);
      }
      cleanupErrors.push(...[...closeResults, ...leaseResults]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason));
    }
    throwCollectedCleanupErrors("ACP persistent client cleanup failed", cleanupErrors);
  }
}

// ─── Singleton management (from server/services/acp-pool-runtime.js) ───

const runtimes = new Map<string, AcpPool>();
const managedViews = new Map<string, AcpPool>();

function managedStatus(pool: AcpPool) {
  const status = pool.status();
  return {
    ...status,
    mode: "managed-shared",
    poolSingleton: true,
    pools: Object.fromEntries((Object.entries(status.pools) as [string, PoolStatusEntry][]).map(([agent, state]) => [
      agent,
      {
        ...state,
        mode: "pool-admission-singleton",
        poolSingleton: true,
        capabilities: [...new Set([...(state.capabilities || []), "pool-singleton"])],
      },
    ])),
  };
}

function managedView(pool: AcpPool) {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "status") return () => managedStatus(target);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function resolvePoolRoots(hubRoot: string | undefined, cpbRoot: string | undefined, env: Record<string, string | undefined> = process.env) {
  const resolvedCpbRoot = resolveAgentHomeRuntimeRoot(
    cpbRoot || env.CPB_ROOT || path.join(__dirname, ".."),
    "CPB_ROOT",
  );
  const resolvedHubRoot = path.resolve(hubRoot || resolveHubRootFromEnv(resolvedCpbRoot, env));
  return {
    cpbRoot: resolvedCpbRoot,
    hubRoot: resolvedHubRoot,
    key: `${resolvedHubRoot}\0${resolvedCpbRoot}`,
  };
}

export function getPoolRuntime(hubRoot: string | undefined, cpbRoot: string | undefined, opts: AcpPoolOptions = {}) {
  const env = opts.env || process.env;
  const roots = resolvePoolRoots(hubRoot, cpbRoot, env);
  if (!runtimes.has(roots.key)) {
    const persistentProcesses = opts.persistentProcesses ?? (
      opts.runner ? false : env.CPB_ACP_PERSISTENT_PROCESS !== "0"
    );
    runtimes.set(roots.key, new AcpPool({ ...opts, env, cpbRoot: roots.cpbRoot, hubRoot: roots.hubRoot, persistentProcesses }));
  }
  return runtimes.get(roots.key);
}

export function getManagedAcpPool({ cpbRoot, hubRoot, ...opts }: AcpPoolOptions = {}) {
  const roots = resolvePoolRoots(hubRoot, cpbRoot, opts.env || process.env);
  const pool = getPoolRuntime(roots.hubRoot, roots.cpbRoot, opts);
  if (!managedViews.has(roots.key)) {
    managedViews.set(roots.key, managedView(pool));
  }
  return managedViews.get(roots.key);
}

export async function stopPoolRuntime(hubRootOrObj: string | AcpPoolOptions) {
  let key;
  if (typeof hubRootOrObj === "string") {
    key = hubRootOrObj;
  } else if (hubRootOrObj) {
    key = resolvePoolRoots(
      hubRootOrObj.hubRoot,
      hubRootOrObj.cpbRoot,
      hubRootOrObj.env || process.env,
    ).key;
  }
  const pool = runtimes.get(key);
  if (pool) {
    runtimes.delete(key);
    managedViews.delete(key);
    await pool.stop();
    return true;
  }
  return false;
}

export function resetPoolRuntime(hubRootOrObj: string | AcpPoolOptions) {
  void stopPoolRuntime(hubRootOrObj);
}

export async function stopAllPoolRuntimes() {
  const pools = [...runtimes.values()];
  runtimes.clear();
  managedViews.clear();
  await Promise.all(pools.map((pool) => pool.stop()));
}

export function resetAllPoolRuntimes() {
  void stopAllPoolRuntimes();
}

export function stopManagedAcpPool({ cpbRoot, hubRoot, ...opts }: AcpPoolOptions = {}) {
  return stopPoolRuntime({ cpbRoot, hubRoot, env: opts.env || process.env });
}

export function releaseManagedAcpWorktree({ cpbRoot, hubRoot, cwd, reason = "worktree_release", closeProvider = false, closePersistent = false, ...opts }: AcpPoolOptions & {
  cwd?: string;
  reason?: string;
  closeProvider?: boolean;
  closePersistent?: boolean;
} = {}) {
  const roots = resolvePoolRoots(hubRoot, cpbRoot, opts.env || process.env);
  const pool = runtimes.get(roots.key);
  if (!pool) return false;
  return pool.releaseWorktree(cwd, reason, { closeProvider, closePersistent });
}

export function releaseManagedAcpJob({ cpbRoot, hubRoot, projectId, jobId, reason = "job_release", ...opts }: AcpPoolOptions & {
  projectId?: string;
  jobId?: string;
  reason?: string;
} = {}) {
  const roots = resolvePoolRoots(hubRoot, cpbRoot, opts.env || process.env);
  const pool = runtimes.get(roots.key);
  if (!pool) return false;
  return pool.releaseJob(projectId || "", jobId || "", reason);
}

export const resetManagedAcpPoolsForTests = resetAllPoolRuntimes;
