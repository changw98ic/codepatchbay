// ── setup.ts — merged: setup-events, init-project, install-bin, apply-variant, executor, executor-root, test-acp-agent ──

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { recordValue, type LooseRecord } from "../../shared/types.js";

import { executeInstallPlan } from "../../core/setup/install-plan.js";
import { buildChildEnv } from "../../core/policy/child-env.js";
import { listJobsAcrossRuntimeRoots } from "./job/job-store.js";
import { jobToQueueRow } from "./job/job-projection.js";

const execFileAsync = promisify(execFile);

// ── setup-events (from setup-events.ts) ────────────────────────────────────

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY)[A-Z0-9_]*=[^\s]+/gi,
  /SECRET_[A-Z0-9_]+/g,
];

function setupEventsPath(cpbRoot: string) {
  return path.join(path.resolve(cpbRoot || process.env.CPB_ROOT || process.cwd()), "cpb-task", "setup-events.jsonl");
}

function redact(value: unknown): string {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function stringEnv(value: unknown): Record<string, string | undefined> {
  const record = recordValue(value);
  const env: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(record)) {
    env[key] = entry == null ? undefined : String(entry);
  }
  return env;
}

function commandHash(plan: LooseRecord) {
  const text = stringValue(plan.displayCommand) || [stringValue(plan.command), ...stringArray(plan.args)].join(" ");
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function appendSetupEvent(cpbRoot: string, event: LooseRecord) {
  const file = setupEventsPath(cpbRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
}

function startedEvent(plan: LooseRecord, startedAt: string) {
  const agent = recordValue(plan.agent);
  return {
    type: "setup_install_started",
    schemaVersion: 1,
    agentId: agent.id || stringValue(plan.agent),
    method: plan.method,
    sourceUrl: plan.sourceUrl,
    commandHash: commandHash(plan),
    shell: Boolean(plan.shell),
    startedAt,
  };
}

function finishedEvent(plan: LooseRecord, startedAt: string, result: unknown, error: unknown) {
  const finishedAt = new Date().toISOString();
  const failed = Boolean(error);
  const agent = recordValue(plan.agent);
  const resultRecord = recordValue(result);
  const errorRecord = recordValue(error);
  return {
    type: "setup_install_finished",
    schemaVersion: 1,
    agentId: agent.id || stringValue(plan.agent),
    method: plan.method,
    sourceUrl: plan.sourceUrl,
    commandHash: commandHash(plan),
    result: failed ? "failed" : "succeeded",
    exitCode: failed ? (Number.isInteger(errorRecord.code) ? errorRecord.code : null) : resultRecord.code,
    error: failed ? { message: redact(errorRecord.message), code: Number.isInteger(errorRecord.code) ? errorRecord.code : null } : null,
    startedAt,
    finishedAt,
  };
}

export async function runInstallPlanWithEvents(plan: LooseRecord, { cpbRoot, stdio = "inherit" }: LooseRecord = {}) {
  const startedAt = new Date().toISOString();
  const cpbRootPath = stringValue(cpbRoot);
  await appendSetupEvent(cpbRootPath, startedEvent(plan, startedAt));
  try {
    const result = await executeInstallPlan(plan, { stdio });
    await appendSetupEvent(cpbRootPath, finishedEvent(plan, startedAt, result, null));
    return result;
  } catch (error) {
    await appendSetupEvent(cpbRootPath, finishedEvent(plan, startedAt, null, error));
    throw error;
  }
}

export async function readSetupEvents(cpbRoot: string) {
  let raw;
  try {
    raw = await readFile(setupEventsPath(cpbRoot), "utf8");
  } catch (error) {
    if (recordValue(error).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ── init-project (from init-project.ts) — CLI runner ───────────────────────

export async function runInitProject(argv: string[]) {
  const { initProject } = await import("../../cli/commands/init.js");
  const executorRoot = path.resolve(
    process.env.CPB_EXECUTOR_ROOT || path.resolve(new URL(".", import.meta.url).pathname, ".."),
  );
  const cpbRoot = path.resolve(process.env.CPB_ROOT || executorRoot);
  await initProject(argv, { cpbRoot, executorRoot });
}

// ── install-bin (from install-bin.ts) ──────────────────────────────────────

export function shellQuoteSingle(s: string) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function renderLauncher({ executorRoot, runtimeRootDefault }: LooseRecord) {
  const quotedRoot = shellQuoteSingle(executorRoot);
  const escapedDefault = runtimeRootDefault;

  return `#!/bin/sh
set -eu

: "\${CPB_HOME:=\$HOME/.cpb}"
: "\${CPB_ROOT:=${escapedDefault}}"
export CPB_ROOT

if [ -z "\${CPB_EXECUTOR_ROOT:-}" ]; then
  CPB_EXECUTOR_ROOT=${quotedRoot}
  export CPB_EXECUTOR_ROOT
fi

if [ ! -x "\${CPB_EXECUTOR_ROOT}/cpb" ]; then
  echo "cpb: executor not found at \${CPB_EXECUTOR_ROOT}/cpb" >&2
  exit 127
fi

exec "\${CPB_EXECUTOR_ROOT}/cpb" "$@"
`;
}

export async function resolveInstallBinExecutorRoot({ executorRootOption, scriptRoot, env }: LooseRecord) {
  const option = stringValue(executorRootOption);
  const envRecord = recordValue(env);
  if (option && option !== "current") {
    return assertExecutorRoot(option);
  }

  if (option === "current") {
    const cpbHome = stringValue(envRecord.CPB_HOME) || path.join(stringValue(envRecord.HOME, "/tmp"), ".cpb");
    const currentLink = path.join(cpbHome, "current");
    let resolved;
    try {
      resolved = await stat(currentLink);
    } catch {
      throw new Error(
        `No current CPB release selected at ${currentLink}. Install or select a release before using --executor-root current.`,
      );
    }
    let realPath;
    try {
      const { realpath } = await import("node:fs/promises");
      realPath = await realpath(currentLink);
    } catch {
      throw new Error(
        `No current CPB release selected at ${currentLink}. Install or select a release before using --executor-root current.`,
      );
    }
    return assertExecutorRoot(realPath);
  }

  const envExecutorRoot = stringValue(envRecord.CPB_EXECUTOR_ROOT);
  if (envExecutorRoot) {
    return assertExecutorRoot(envExecutorRoot);
  }

  return assertExecutorRoot(stringValue(scriptRoot));
}

export async function installBin({ target, executorRoot }: LooseRecord) {
  const resolvedExecutorRoot = await assertExecutorRoot(stringValue(executorRoot));
  const resolvedTarget = path.resolve(stringValue(target));
  const runtimeRootDefault = `\${CPB_HOME:-\$HOME/.cpb}`;

  const launcherContent = renderLauncher({
    executorRoot: resolvedExecutorRoot,
    runtimeRootDefault,
  });

  const targetDir = path.dirname(resolvedTarget);
  await mkdir(targetDir, { recursive: true });

  const tmpFile = path.join(targetDir, `.cpb-launcher.tmp-${Date.now()}-${process.pid}`);
  await writeFile(tmpFile, launcherContent, "utf8");
  await chmod(tmpFile, 0o755);
  await rename(tmpFile, resolvedTarget);

  return {
    target: resolvedTarget,
    executorRoot: resolvedExecutorRoot,
    runtimeRootDefault,
    launcherVersion: 1,
  };
}

// ── apply-variant (from apply-variant.ts) ──────────────────────────────────


function envFirst(env: LooseRecord, ...names: string[]): string | undefined {
  for (const name of names) {
    const val = env[name];
    if (typeof val === "string" && val) return val;
  }
  return undefined;
}

function normalizeVariant(requested: unknown): string {
  return (typeof requested === "string" ? requested : "").trim().toLowerCase();
}

function normalizeProviderModel(value: unknown): string {
  return stringValue(value).replace(/\[[^\]]+\]$/, "");
}

function resolveVariant(env: LooseRecord = process.env): string {
  const requested =
    env.CPB_CLAUDE_VARIANT ||
    env.CPB_BUILDER_VARIANT ||
    env.CPB_ACP_CLAUDE_VARIANT ||
    "";

  if (requested) return normalizeVariant(requested);

  return "none";
}

function applyXiaomi(env: LooseRecord = process.env): LooseRecord {
  const variant = "mimo-v2.5pro";
  const baseUrl = envFirst(env, "XIAOMI_BASE_URL", "MIMO_BASE_URL");
  const authToken = envFirst(env, "XIAOMI_API_KEY", "XIAOMI_AUTH_TOKEN", "MIMO_API_KEY", "MIMO_AUTH_TOKEN");
  const model = normalizeProviderModel(envFirst(env, "XIAOMI_MODEL", "MIMO_MODEL") || "mimo-v2.5-pro");

  if (!baseUrl || !authToken) {
    throw new Error(`Missing base URL or API key for variant '${variant}'. Set XIAOMI_BASE_URL + XIAOMI_API_KEY (or MIMO_BASE_URL + MIMO_API_KEY).`);
  }

  return { variant, displayName: "MiMo v2.5 Pro", baseUrl, authToken, model };
}

function applyZhipu(env: LooseRecord = process.env): LooseRecord {
  const variant = "glm";
  const baseUrl = envFirst(env, "ZHIPU_BASE_URL", "GLM_BASE_URL");
  const authToken = envFirst(env, "ZHIPU_API_KEY", "ZHIPU_AUTH_TOKEN", "GLM_API_KEY", "GLM_AUTH_TOKEN");
  const model = normalizeProviderModel(envFirst(env, "ZHIPU_MODEL", "GLM_MODEL"));

  if (!baseUrl || !authToken || !model) {
    throw new Error(`Missing base URL, API key, or model for variant '${variant}'. Set ZHIPU_BASE_URL + ZHIPU_API_KEY + ZHIPU_MODEL (or GLM_BASE_URL + GLM_API_KEY + GLM_MODEL).`);
  }

  return { variant, displayName: "GLM", baseUrl, authToken, model };
}

function resolveConfig(env: LooseRecord = process.env): LooseRecord {
  const normalized = resolveVariant(env);

  switch (normalized) {
    case "none":
    case "off":
    case "default":
    case "anthropic":
    case "claude":
      return { variant: "none" };

    case "xiaomi":
    case "mimo":
    case "mimo-v2.5pro":
      return applyXiaomi(env);

    case "zhipu":
    case "glm":
    case "glm-compatible":
      return applyZhipu(env);

    default:
      throw new Error(`Unknown Claude variant: '${normalized}'. Use mimo-v2.5pro, glm, or none.`);
  }
}

export function resolveVariantConfig(env: LooseRecord = process.env): LooseRecord {
  return resolveConfig(env);
}

export function applyVariantToEnv(env: LooseRecord = process.env, opts: LooseRecord = {}): LooseRecord {
  if (opts.variant) {
    env.CPB_CLAUDE_VARIANT = stringValue(opts.variant);
  }
  const config = resolveConfig(env);

  if (config.variant === "none") {
    env.CPB_ACTIVE_CLAUDE_VARIANT = "none";
    return config;
  }

  const variant = stringValue(config.variant);
  const displayName = stringValue(config.displayName);
  const baseUrl = stringValue(config.baseUrl);
  const authToken = stringValue(config.authToken);
  const model = stringValue(config.model);

  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = authToken;
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION = model;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = displayName;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = `CodePatchbay provider variant: ${variant}`;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  // Claude Code's attribution request path is not supported consistently by
  // Anthropic-compatible gateways. User HOME settings often disable it, but
  // isolated agent homes intentionally do not inherit settings.json. Pin the
  // compatibility contract here so provider behavior does not depend on HOME.
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  env.CPB_ACTIVE_CLAUDE_VARIANT = variant;

  return config;
}

export function applyVariant(opts: LooseRecord = {}) {
  return applyVariantToEnv(process.env, opts);
}

// ── executor (from executor.ts) ────────────────────────────────────────────

const runningTasks = new Map<string, { project: string; script: string; pid: number; started: number }>();

export function registerTask(taskId: string, project: string, script: string, pid: number) {
  runningTasks.set(taskId, { project, script, pid, started: Date.now() });
}

export function unregisterTask(taskId: string) {
  runningTasks.delete(taskId);
}

export function getRunningTasks() {
  return Array.from(runningTasks.entries()).map(([id, task]) => ({
    id,
    ...task,
    duration: Date.now() - task.started,
  }));
}

export async function getDurableTasks(cpbRoot: string, { hubRoot, cacheTtlMs }: { hubRoot?: string; cacheTtlMs?: number } = {}) {
  const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, {
    hubRoot,
    includeHubProjects: Boolean(hubRoot),
  });
  return jobs.map((job) => ({ ...job, ...jobToQueueRow(job) }));
}

// ── executor-root (from executor-root.ts) ──────────────────────────────────

export const REQUIRED_EXECUTOR_FILES = [
  "cpb",
  "cli/cpb.js",
  "bridges/engine-bridge.js",
  "bridges/runtime-services.js",
  "core/workflow/definition.js",
  "shared/fs-utils.js",
  "shared/hub-auth.js",
  "shared/hub-maintenance.js",
  "shared/logger.js",
  "shared/orchestrator/assignment-store.js",
  "shared/orchestrator/worker-store.js",
  "server/index.js",
  "server/services/audit/hub-access-audit.js",
  "server/services/audit/hub-access-audit-archive.js",
  "server/services/acp/acp-client.js",
  "server/services/engine-runner.js",
  "server/services/event/event-store.js",
  "server/services/hub/hub-backup.js",
  "server/services/hub/hub-queue.js",
  "server/services/hub/hub-registry.js",
  "server/services/job/job-store.js",
  "server/services/release/release-store.js",
  "scripts/validate-scan-readiness.js",
  "runtime/evolve/multi-evolve.js",
  "runtime/worker/managed-worker.js",
];

export function resolveExecutorRoot({ env = process.env, fallbackRoot = process.cwd() }: LooseRecord = {}) {
  const envRecord = recordValue(env);
  return path.resolve(stringValue(envRecord.CPB_EXECUTOR_ROOT) || stringValue(fallbackRoot));
}

export function executorEnv(env: LooseRecord = process.env, { cpbRoot, executorRoot, extra }: LooseRecord = {}) {
  const envRecord = recordValue(env);
  return buildChildEnv(stringEnv(envRecord), {
    CPB_ROOT: path.resolve(stringValue(cpbRoot) || stringValue(envRecord.CPB_ROOT) || process.cwd()),
    CPB_EXECUTOR_ROOT: path.resolve(stringValue(executorRoot) || stringValue(envRecord.CPB_EXECUTOR_ROOT) || stringValue(cpbRoot) || process.cwd()),
    ...stringEnv(extra),
  });
}

export async function assertExecutorRoot(executorRoot: string) {
  const root = path.resolve(executorRoot);
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new Error(`executor root is not a directory: ${root}`);
  }

  for (const relativePath of REQUIRED_EXECUTOR_FILES) {
    try {
      await access(path.join(root, relativePath), fsConstants.R_OK);
    } catch {
      throw new Error(`executor root is missing ${relativePath}: ${root}`);
    }
  }

  return root;
}

export async function readExecutorPackage(executorRoot: string) {
  try {
    const raw = await readFile(path.join(path.resolve(executorRoot), "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return {
      name: parsed.name || null,
      version: parsed.version || null,
    };
  } catch {
    return {
      name: null,
      version: null,
    };
  }
}

export async function executorMetadata(executorRoot: string, { codeVersion, env = process.env }: LooseRecord = {}) {
  const root = await assertExecutorRoot(executorRoot);
  const pkg = await readExecutorPackage(root);
  const envRecord = recordValue(env);

  let releaseId = null;
  let stateFormatVersions = null;
  try {
    const manifestPath = path.join(root, "release", "manifest.json");
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    if (typeof manifest.releaseId === "string" && manifest.releaseId.length > 0) {
      releaseId = manifest.releaseId;
    }
    if (manifest.stateFormatVersions && typeof manifest.stateFormatVersions === "object") {
      stateFormatVersions = manifest.stateFormatVersions;
    }
  } catch {}

  if (!stateFormatVersions) {
    try {
      const { QUEUE_VERSION } = await import("./hub/hub-queue.js");
      const { JOBS_EVENTS_FORMAT_VERSION } = await import("./event/event-store.js");
      const { LEASE_FORMAT_VERSION } = await import("./infra.js");
      const { PROCESS_REGISTRY_FORMAT_VERSION } = await import("./infra.js");
      const { RELEASE_METADATA_FORMAT_VERSION } = await import("./release/release-store.js");
      stateFormatVersions = {
        queue: QUEUE_VERSION,
        jobsEvents: JOBS_EVENTS_FORMAT_VERSION,
        leases: LEASE_FORMAT_VERSION,
        processRegistry: PROCESS_REGISTRY_FORMAT_VERSION,
        releaseMetadata: RELEASE_METADATA_FORMAT_VERSION,
      };
    } catch {}
  }

  return {
    root,
    packageName: pkg.name,
    version: pkg.version,
    releaseId,
    codeVersion: stringValue(codeVersion) || stringValue(envRecord.CPB_VERSION) || pkg.version || null,
    stateFormatVersions,
  };
}

// ── test-acp-agent (from test-acp-agent.ts) — CLI runner ───────────────────

export async function runTestAcpAgent(argv: string[]) {
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const agentPath = path.resolve(new URL(".", import.meta.url).pathname, "..", "..", "tests", "fixtures", "test-acp-agent.js");
  const args = [agentPath, ...argv];
  return execFileAsync(process.execPath, args, { timeout: 120_000 });
}

// ── Re-exports from merged modules ──
export { buildServices, runJobWithServices } from "./engine-runner.js";
export { runDemo } from "./readiness-checks.js";
