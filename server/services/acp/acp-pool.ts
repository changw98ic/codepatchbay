import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
import { applyVariantToEnv, resolveVariantConfig } from "../setup.js";
import { saveSessionId, loadSessionId, clearSessionId } from "../../../core/agents/session-cache.js";
import { createAgentHome } from "../../../core/agents/isolation.js";
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
  dataRoot?: string;
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
};

type PoolRunnerOptions = {
  agent: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
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

type SpawnedChild = ChildProcessWithoutNullStreams & {
  detached?: boolean;
};

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
  _timer?: NodeJS.Timeout;
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
  pid?: number | string;
  agent?: string;
  providerKey?: string;
  phase?: string | null;
  role?: string | null;
  poolScope?: string | null;
  controlPlane?: boolean;
  acquiredAt?: string;
  filePath?: string;
};

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
 * verification. Agents with launch-scoped MCP config can opt into processCwd.
 */
export function poolClientKey(agent: string, options: PoolClientKeyOptions = {}) {
  const projectId = options.projectId || "";
  const workspaceId = options.workspaceId || "";
  const processCwd = options.processCwd || "";
  const policyHash = options.policyHash || "";
  const variant = options.variant || "";
  const launchPermissionLane = options.launchPermissionLane || "";
  const baseKey = [agent, projectId, workspaceId, processCwd, policyHash, variant, launchPermissionLane].join("::");
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
const DEFAULT_TIMEOUT_MS = Number(process.env.CPB_ACP_POOL_TIMEOUT_MS || 0);
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
const DEFAULT_POOL_WAIT_TIMEOUT_MS = resolvePoolWaitTimeoutMs();
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

export function resolvePoolWaitTimeoutMs(value = process.env.CPB_ACP_POOL_WAIT_TIMEOUT_MS) {
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
  const derivedDiscoveryTurns = Math.min(32, Math.max(8, Math.ceil(Math.max(0, toolCallBudget) / 3) + 4));
  const fallback = repositoryDiscovery ? derivedDiscoveryTurns : structuredOutput ? 4 : 2;
  return Math.min(64, positiveIntOption(configured, fallback));
}

function connectionLeaseFrom(value: unknown, filePath: string): ConnectionLease | null {
  if (!isRecord(value)) return null;
  return {
    leaseId: typeof value.leaseId === "string" ? value.leaseId : undefined,
    pid: typeof value.pid === "number" || typeof value.pid === "string" ? value.pid : undefined,
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

function signalChild(child: SpawnedChild, signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try {
    if (child.detached && process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function descendantPids(rootPid: number) {
  if (process.platform === "win32" || !rootPid) return [];
  const result = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  if (result.error || typeof result.stdout !== "string") return [];

  const children = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid <= 0) continue;
    const siblings = children.get(ppid) || [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }

  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) || [])];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    pending.push(...(children.get(pid) || []));
  }
  return descendants;
}

function signalDetachedDescendants(pids: number[], signal: NodeJS.Signals) {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(-pid, signal);
    } catch {
      try { process.kill(pid, signal); } catch {}
    }
  }
}

function terminateChild(child: SpawnedChild) {
  return new Promise<void>((resolve) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    // A sandboxed wrapper may spawn its provider into a separate process group.
    // Capture those descendants before signalling the wrapper: once it exits,
    // detached providers are re-parented and can no longer be discovered from
    // the wrapper PID. The parent control plane remains outside the sandbox and
    // can therefore terminate them even when the wrapper cannot signal across
    // sandbox process-group boundaries.
    const detachedDescendants = descendantPids(child.pid);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      child.removeListener("close", finish);
      resolve();
    };
    const termTimer = setTimeout(() => {
      signalChild(child, "SIGTERM");
      signalDetachedDescendants(detachedDescendants, "SIGTERM");
    }, 0);
    const killTimer = setTimeout(() => {
      signalChild(child, "SIGKILL");
      signalDetachedDescendants(detachedDescendants, "SIGKILL");
      setTimeout(finish, CHILD_KILL_GRACE_MS).unref();
    }, CHILD_TERM_GRACE_MS);
    termTimer.unref();
    killTimer.unref();
    child.once("close", finish);
  });
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
  _seq: number;
  stopped: boolean;
  createdAt: number;

  constructor(opts: AcpPoolOptions = {}) {
    const parentEnv = opts.env || process.env;
    this.cpbRoot = path.resolve(opts.cpbRoot || parentEnv.CPB_ROOT || path.join(__dirname, ".."));
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
    for (const [key, persistent] of [...this.persistentClients.entries()]) {
      const clientCwd = persistent.client?.activeSessionCwd
        ? path.resolve(persistent.client.activeSessionCwd)
        : null;
      const launchCwd = persistent.launchCwd ? path.resolve(persistent.launchCwd) : null;
      const lastCwd = persistent.lastCwd ? path.resolve(persistent.lastCwd) : null;
      const activeMatches = clientCwd === target;
      const terminalCleanupCount = await persistent.client.cleanupTerminalsForCwd(target, { reason: releaseReason }).catch(() => 0);

      if (persistent.launchScopedMcp || closeProvider) {
        if (!activeMatches && launchCwd !== target && lastCwd !== target && terminalCleanupCount === 0) continue;
        await this.#closePersistentClient(key);
      } else {
        if (activeMatches) await persistent.client.closeActiveSession(releaseReason).catch(() => null);
        if (!activeMatches && terminalCleanupCount === 0) continue;
      }
      released = true;
    }
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
    for (const [, persistent] of matches) {
      await persistent.client.closeActiveSession(reason).catch(() => null);
    }
    for (const [key] of matches) {
      await this.#closePersistentClient(key);
    }
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
    return poolClientKey(agent, { ...options, processCwd, launchPermissionLane });
  }

  #conversationKey(options: PoolRequestOptions = {}) {
    return stringValue(options.conversationKey);
  }

  #sessionKey(agent: string, options: PoolRequestOptions = {}) {
    return this.#conversationKey(options)
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
    const timeoutMs = numericOption(options.waitTimeoutMs, DEFAULT_POOL_WAIT_TIMEOUT_MS);
    const start = Date.now();
    let warnTimer = null;
    return new Promise<AcquiredPoolSlot>((resolve, reject) => {
      // Queue under provider key (not agent name) so cross-agent waits are shared
      const queueKey = `provider:${providerKey}`;
      const queue = this.pending.get(queueKey) || [];
      const entry: PendingPoolRequest = { resolve, reject, agent, providerKey };
      queue.push(entry);
      this.pending.set(queueKey, queue);

      // 30-second warn log
      warnTimer = setInterval(() => {
        const elapsed = Date.now() - start;
        const currentActive = this.#providerActiveCount(providerKey);
        process.stderr.write(
          `[acp-pool] warn: ACP pool wait: ${agent}/${providerKey} waiting ${Math.round(elapsed / 1000)}s for provider slot (${currentActive}/${limit})\n`,
        );
      }, POOL_WAIT_WARN_INTERVAL_MS);
      warnTimer.unref();

      // Timeout
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          clearInterval(warnTimer);
          const idx = queue.indexOf(entry);
          if (idx !== -1) queue.splice(idx, 1);
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
    const next = queue.shift();
    if (!next) return;
    if (next._timer) clearTimeout(next._timer);
    const nextAgent = next.agent || agent;
    const nextProviderKey = next.providerKey || this.providerKey(nextAgent);
    const nextId = this._nextId(nextAgent);
    this.active.set(nextAgent, (this.active.get(nextAgent) || 0) + 1);
    this.activeProviders.set(nextProviderKey, (this.activeProviders.get(nextProviderKey) || 0) + 1);
    this.liveRequests.set(nextId, { agent: nextAgent, startedAt: Date.now(), providerKey: nextProviderKey });
    next.resolve({ agent: nextAgent, requestId: nextId, release: () => this.release(nextAgent, nextId) });
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

  async #connectionLockIsStale(lockDir: string) {
    try {
      const info = await stat(lockDir);
      return Date.now() - info.mtimeMs >= CONNECTION_LOCK_TTL_MS;
    } catch {
      return false;
    }
  }

  async #withConnectionLock<T>(callback: () => Promise<T>) {
    const dir = this.#connectionLeasesDir();
    const lockDir = this.#connectionLockDir();
    await mkdir(dir, { recursive: true });

    let acquired = false;
    while (!this.stopped) {
      try {
        await mkdir(lockDir);
        acquired = true;
        break;
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
        if (await this.#connectionLockIsStale(lockDir)) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        await sleep(10);
      }
    }

    if (!acquired) throw new Error("ACP pool stopped");
    try {
      if (this.stopped) throw new Error("ACP pool stopped");
      return await callback();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  }

  #leaseAlive(lease: ConnectionLease | null | undefined) {
    if (!lease?.pid) return false;
    try {
      process.kill(Number(lease.pid), 0);
      return true;
    } catch {
      return false;
    }
  }

  async #listLiveConnectionLeasesLocked() {
    const dir = this.#connectionLeasesDir();
    const leases: ConnectionLease[] = [];
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      return leases;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(dir, file);
      try {
        const lease = connectionLeaseFrom(JSON.parse(await readFile(filePath, "utf8")), filePath);
        if (!lease) {
          await rm(filePath, { force: true });
          continue;
        }
        if (this.#leaseAlive(lease)) {
          leases.push(lease);
        } else {
          await rm(filePath, { force: true });
        }
      } catch {
        await rm(filePath, { force: true }).catch(() => null);
      }
    }
    return leases;
  }

  async #tryAcquireConnectionLease(agent: string, providerKey: string, options: PoolRequestOptions = {}) {
    return this.#withConnectionLock(async () => {
      const leases = await this.#listLiveConnectionLeasesLocked();
      const providerLimit = this.#providerConnectionLimit(providerKey);
      const providerCount = leases.filter((lease) => lease.providerKey === providerKey).length;
      if (providerCount >= providerLimit) {
        return null;
      }

      const lease = {
        leaseId: `${Date.now()}-${process.pid}-${++this._seq}`,
        pid: process.pid,
        agent,
        providerKey,
        phase: options.phase || null,
        role: options.role || null,
        poolScope: options.poolScope || null,
        controlPlane: Boolean(options.controlPlane || options.poolScope === "control-plane"),
        acquiredAt: new Date().toISOString(),
      };
      const filePath = path.join(this.#connectionLeasesDir(), `${lease.leaseId}.json`);
      await writeFile(filePath, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
      return { ...lease, filePath };
    });
  }

  async #acquireConnectionLease(agent: string, providerKey: string, options: PoolRequestOptions = {}) {
    const timeoutMs = numericOption(options.waitTimeoutMs, DEFAULT_POOL_WAIT_TIMEOUT_MS);
    const start = Date.now();
    let lastWarnAt = start;
    while (!this.stopped) {
      const lease = await this.#tryAcquireConnectionLease(agent, providerKey, options);
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
      await sleep(this.connectionPollMs);
    }
    throw new Error("ACP pool stopped");
  }

  async #countProviderLeases(providerKey: string) {
    try {
      const leases = await this.#withConnectionLock(() => this.#listLiveConnectionLeasesLocked());
      return leases.filter((lease) => lease.providerKey === providerKey).length;
    } catch {
      return -1;
    }
  }

  async #releaseConnectionLease(lease: ConnectionLease | null | undefined) {
    if (!lease?.filePath) return;
    await rm(lease.filePath, { force: true }).catch(() => null);
  }

  #executionEnv(agent: string, options: PoolRequestOptions = {}): EnvRecord {
    const projectRuntimeRoot = options.dataRoot || this.env.CPB_PROJECT_RUNTIME_ROOT;
    return buildChildEnv(
      envForAgent(agent, this.env, options.variant),
      {
        CPB_ROOT: this.cpbRoot,
        CPB_ACP_CPB_ROOT: this.cpbRoot,
        CPB_HUB_ROOT: this.hubRoot,
        ...(projectRuntimeRoot ? { CPB_PROJECT_RUNTIME_ROOT: projectRuntimeRoot } : {}),
        ...acpMetadataEnv(options),
        ...(isRecord(options.env) ? options.env as EnvRecord : {}),
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
   * Matches the internal #providerConnectionLimit() resolver.
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
    const dir = this.#connectionLeasesDir();
    const counts: Record<string, number> = {};
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      return { total: 0, providers: {} };
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const lease = JSON.parse(await readFile(path.join(dir, file), "utf8"));
        if (!this.#leaseAlive(lease)) {
          await rm(path.join(dir, file), { force: true }).catch(() => null);
          continue;
        }
        const key = lease.providerKey || "unknown";
        counts[key] = (counts[key] || 0) + 1;
      } catch {}
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
          ...(session.conversationKey ? { conversationKey: session.conversationKey } : {}),
        }).catch(() => null);
      }
    }
    const persistentKey = this.#conversationKey(options)
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

  async execute(agent: string, prompt: string, cwd = this.cpbRoot, timeoutMs = DEFAULT_TIMEOUT_MS, options: PoolRequestOptions = {}) {
    const scopedOptions: PoolRequestOptions = { ...options, cwd };
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
    try {
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
    if (this.runner) {
      const lease = await this.#acquireConnectionLease(agent, this.#providerKeyForRequest(agent, options), options);
      try {
        return await this.runner({ agent, prompt, cwd, timeoutMs });
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
    const runtimeGuards = resolveAcpRuntimeGuards(env);
    const planningJsonSchema = planning ? claudePlanningJsonSchemaForRole(role) : null;
    // Claude-compatible providers count hidden thinking and the structured
    // answer against the same output ceiling. Reserve 8k tokens for the JSON
    // result so a valid plan is not truncated after consuming its thinking
    // budget. The compatible endpoint used here advertises a 32k maximum.
    const defaultPlanningThinkingTokens = role.startsWith("critic_") ? 24_000 : 12_000;
    const defaultPlanningOutputTokens = Math.min(32_000, defaultPlanningThinkingTokens + 8_000);
    if (planning) {
      if (!env.MAX_THINKING_TOKENS) env.MAX_THINKING_TOKENS = String(defaultPlanningThinkingTokens);
      if (!env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(defaultPlanningOutputTokens);
      }
    }
    const pathGuardScript = path.resolve(__dirname, "../../../scripts/claude-path-guard.js");
    const pathGuardWriteRoots = String(env.CPB_ACP_WRITE_ALLOW || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry && entry !== "__cpb_no_worktree_writes__")
      .map((entry) => entry.includes("*") ? entry.slice(0, entry.indexOf("*")) : entry)
      .map((entry) => entry.replace(/[\\/]+$/, ""))
      .filter(Boolean);
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
    const nativePlanningSettings = JSON.stringify({
      permissions: {
        allow: ["Read", "Glob", "Grep"],
        deny: ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "NotebookEdit"],
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
      ...(!planning ? [
        "--settings", nativeExecutionSettings,
        "--setting-sources", "user",
        "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
        "--disable-slash-commands",
        "--tools", sandboxedBashEnabled ? "Read,Edit,Write,Glob,Grep,Bash" : "Read,Edit,Write,Glob,Grep",
      ] : []),
      ...(planningRepositoryDiscovery ? [
        "--settings", nativePlanningSettings,
        "--setting-sources", "user",
        "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
        "--disable-slash-commands",
        "--tools", "Read,Glob,Grep",
      ] : planning ? ["--tools", ""] : []),
      ...(planning ? ["--max-turns", String(planningMaxTurns)] : []),
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
        tools: planningRepositoryDiscovery ? ["Read", "Glob", "Grep", "StructuredOutput"] : ["StructuredOutput"],
      } : null,
      executionPolicy: {
        outerSandboxMode: planningRepositoryDiscovery
          ? "claude-native-readonly-plan"
          : planning
            ? "zero-repository-tool-plan"
            : "claude-native-permissions",
        readOnly: planning,
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
      if (this.stopped) throw new Error("ACP pool stopped");
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(launch.command, launch.args, {
          cwd: executionCwd,
          env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        }) as SpawnedChild;
        this.oneShotChildren.add(child);
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
        const configuredTextBudget = Number(env.CPB_CLAUDE_PLAN_MAX_TEXT_CHARS || 32_000);
        const configuredThinkingBudget = Number(env.CPB_CLAUDE_PLAN_MAX_THINKING_TOKENS || defaultPlanningThinkingTokens);
        const maxGeneratedTextChars = planning
          ? Math.max(1_000, Number.isFinite(configuredTextBudget) ? configuredTextBudget : 32_000)
          : 0;
        const maxGeneratedThinkingTokens = planning
          ? Math.max(1_000, Number.isFinite(configuredThinkingBudget) ? configuredThinkingBudget : defaultPlanningThinkingTokens)
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
            terminateChild(child).finally(() => reject(new Error(
              `${agent} CLI stream idle timed out after ${idleTimeoutMs}ms without output`,
            )));
          }, idleTimeoutMs);
          idleTimer.unref();
        };
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            if (settled) return;
            settled = true;
            if (idleTimer) clearTimeout(idleTimer);
            if (executeNoEditIdleTimer) clearTimeout(executeNoEditIdleTimer);
            terminateChild(child).finally(() => reject(new Error(`${agent} timed out after ${timeoutMs}ms`)));
          }, timeoutMs)
          : null;
        if (timer) timer.unref();
        const clearExecutionTimers = () => {
          if (timer) clearTimeout(timer);
          if (idleTimer) clearTimeout(idleTimer);
          if (executeNoEditIdleTimer) clearTimeout(executeNoEditIdleTimer);
          idleTimer = null;
          executeNoEditIdleTimer = null;
        };
        const rejectAfterFailureCleanup = (error: Error, audit: Promise<unknown>) => {
          clearExecutionTimers();
          Promise.all([
            audit.catch(() => null),
            streamWriteChain.catch(() => null),
            terminateChild(child).catch(() => null),
          ]).then(() => reject(error), () => reject(error));
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
              void terminateChild(child).finally(() => reject(new Error(reason)));
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
          void terminateChild(child).finally(() => reject(error));
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
        let stdout = "";
        let stderr = "";
        let settled = false;
        child.once("close", () => {
          this.oneShotChildren.delete(child);
        });
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            if (settled) return;
            settled = true;
            terminateChild(child).finally(() => {
              reject(new Error(`${agent} timed out after ${timeoutMs}ms`));
            });
          }, timeoutMs + ONE_SHOT_CLOSE_GRACE_MS)
          : null;
        if (timer) timer.unref();
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          this.#reportAgentActivity(agent, providerKey, chunk, options);
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
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
    const key = this.#persistentClientKey(agent, { ...options, cwd });
    const prior = this.persistentChains.get(key) || Promise.resolve();
    const providerKey = this.#providerKeyForRequest(agent, options);
    const waitTimeout = numericOption(this.env.CPB_ACP_POOL_WAIT_TIMEOUT_MS, DEFAULT_POOL_WAIT_TIMEOUT_MS);
    const warnInterval = POOL_WAIT_WARN_INTERVAL_MS;

    // Wrap prior promise with timeout + warn so a stuck predecessor doesn't block forever
    const timedPrior = new Promise<void>((resolve, reject) => {
      let elapsed = 0;
      const warnTimer = setInterval(() => {
        elapsed += warnInterval;
        if (waitTimeout > 0 && elapsed >= waitTimeout) {
          clearInterval(warnTimer);
          reject(new PoolExhaustedError(agent, providerKey, elapsed, `persistent chain wait timeout: ${agent}/${providerKey} waited ${Math.round(elapsed / 1000)}s for prior call to complete`));
        } else {
          const ts = new Date().toISOString();
          process.stderr.write(`${ts} [warn] [acp-pool] persistent chain wait: ${agent} waiting ${Math.round(elapsed / 1000)}s for prior call to complete\n`);
        }
      }, warnInterval);
      prior.then(() => { clearInterval(warnTimer); resolve(); }, () => { clearInterval(warnTimer); resolve(); });
    });

    const run = timedPrior
      .then(() => this.#runPersistentNow(key, agent, prompt, cwd, timeoutMs, options));
    this.persistentChains.set(key, run.catch(() => null));
    return run;
  }

  async #runPersistentNow(key: string, agent: string, prompt: string, cwd: string, timeoutMs: number, options: PoolRequestOptions = {}) {
    const persistent = await this.#getPersistentClient(key, agent, cwd, options);
    persistent.projectId = stringValue(options.projectId);
    persistent.jobId = stringValue(options.jobId);
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

    const timeout = timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.#closePersistentClient(key);
            reject(new Error(`${agent} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref();
        })
      : new Promise<never>(() => {}); // never resolves — no timeout

    client.outputSink = (chunk: string | Buffer) => { stdout += chunk?.toString ? chunk.toString() : String(chunk); };
    client.errorSink = (chunk: string | Buffer) => {
      stderr += chunk?.toString ? chunk.toString() : String(chunk);
      this.#reportAgentActivity(agent, providerKey, chunk, options);
    };

    try {
      const sessionId = await Promise.race([client.promptOnce(prompt, cwd), timeout]);
      persistent.requestCount += 1;
      persistent.lastUsedAt = Date.now();
      // Capture sessionId for cached lifecycle
      if (sessionId) {
        const session = this.sessions.get(persistent.sessionKey);
        if (session) session.sessionId = sessionId;
      }
      return stdout.trim();
    } catch (error) {
      await this.#closePersistentClient(key);
      if (stderr && !String(error.message || "").includes(stderr.slice(-120))) {
        throw new Error(`${error.message}: ${stderr.slice(-1000)}`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      client.outputSink = previousOutputSink;
      client.errorSink = previousErrorSink;
    }
  }

  async #getPersistentClient(key: string, agent: string, cwd: string, options: PoolRequestOptions = {}) {
    const existing = this.persistentClients.get(key);
    if (existing && existing.client.isUsable()) return existing;
    if (existing) await this.#closePersistentClient(key);

    // Load cached sessionId for cached lifecycle agents
    let resumeSessionId = null;
    const reg = await getRegistry();
    const desc = reg?.getDescriptor(agent);
    const conversationKey = this.#conversationKey(options);
    if (desc?.lifecycle === "cached") {
      const cached = await loadSessionId(this.cpbRoot, agent, {
        ...(conversationKey ? { conversationKey } : {}),
      }).catch(() => null);
      if (cached?.sessionId) resumeSessionId = cached.sessionId;
    }

    const providerKey = this.#providerKeyForRequest(agent, options);
    const lease = await this.#acquireConnectionLease(agent, providerKey, options);
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
      await client.start();
      return meta;
    } catch (error) {
      this.persistentClients.delete(key);
      await client.close().catch(() => null);
      await this.#releaseConnectionLease(lease);
      throw error;
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

    for (const key of matchingKeys) {
      const persistent = this.persistentClients.get(key);
      if (!persistent) continue;
      const agent = persistent.agent;
      // Save sessionId for cached lifecycle before closing
      const session = this.sessions.get(persistent.sessionKey);
      if (session?.sessionId) {
        const reg = await getRegistry();
        const desc = reg?.getDescriptor(agent);
        if (desc?.lifecycle === "cached") {
          await saveSessionId(this.cpbRoot, agent, session.sessionId, {
            ...(persistent.conversationKey ? { conversationKey: persistent.conversationKey } : {}),
          }).catch(() => null);
        }
      }
      this.persistentClients.delete(key);
      await persistent.client.close().catch(() => null);
      await this.#releaseConnectionLease(persistent.connectionLease);
    }
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
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || path.join(__dirname, ".."));
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
