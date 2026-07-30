import type { LooseRecord } from "../../shared/types.js";
import {
  providerCredentialInputKeysForAgent,
  providerEnvironmentKeysForAgent,
  providerEnvironmentKeysForAllAgents,
} from "../agents/registry.js";
import {
  getConfiguredProvider,
  providerEnvironmentKeysFromConfig,
  configuredProviderCredentialInputKeys,
  configuredProviderEnvironmentKeys,
} from "../agents/provider-catalog.js";
import {
  providerCredentialInputKeysForSelection,
  providerEnvironmentKeysForSelection,
} from "../agents/provider-config.js";
// Shared child-process environment policy.
// Keep this in core so runtime, bridges, and server entrypoints enforce the
// same secret boundary without importing server modules.

type EnvMap = Record<string, string | undefined>;
type ChildEnvOptions = LooseRecord | string;

const RUNTIME_BASICS = new Set([
  "PATH", "HOME", "SHELL", "TERM", "TMPDIR", "TEMP", "TMP",
  "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "CI", "PYTHONDONTWRITEBYTECODE",
  "CODEX_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
  "npm_config_cache", "NPM_CONFIG_CACHE",
]);

const CPB_RUNTIME_ENV = new Set([
  "CPB_ROOT", "CPB_EXECUTOR_ROOT", "CPB_HUB_ROOT", "CPB_HOME", "CPB_PROVIDERS_FILE",
  "CPB_INSTALL_ROOT", "CPB_PROJECT_RUNTIME_ROOT", "CPB_PROJECT_PATH_OVERRIDE",
  "CPB_WORKFLOW", "CPB_PLAN_MODE", "CPB_TRIAGE_MODE",
  "CPB_PROVIDER", "CPB_PROVIDER_ID", "CPB_MODEL", "CPB_MODEL_NAME", "CPB_PROVIDER_AGENT",
  "CPB_QUEUE_ENTRY_ID", "CPB_SESSION_ID", "CPB_WORKER_ID",
  "CPB_SOURCE_CONTEXT_JSON", "CPB_CONTEXT_PACK_PATH",
  "CPB_PARENT_PLAN_CACHE_JSON", "CPB_INDEX_SNAPSHOT_JSON",
  "CPB_ISSUE_NUMBER", "CPB_ISSUE_URL", "CPB_ISSUE_REPO", "CPB_ISSUE_TITLE",
  "CPB_FAILED_QUEUE_ID", "CPB_FAILED_JOB_ID", "CPB_FAILURE_ARTIFACT",
  "CPB_GITHUB_PR_AFTER_PASS", "CPB_GITHUB_PR_DRY_RUN", "CPB_GITHUB_BRANCH_PUSHED",
  "CPB_TEAM_POLICY_JSON", "CPB_APPROVAL_POLL_MS", "CPB_APPROVAL_TIMEOUT_MS",
  "CPB_VERSION", "CPB_DANGEROUS",
  "CPB_PERMISSION_MODE",
  "CPB_STALE_GRACE_COUNT", "CPB_ACTIVITY_STALE_MS", "CPB_PROJECT_CACHE",
  "CPB_RETRY_COUNT", "CPB_PREVIOUS_VERDICT_ID", "CPB_PREVIOUS_VERDICT_PATH",
  "CPB_LEASE_TTL_MS", "CPB_LEASE_RENEW_INTERVAL_MS",
  "CPB_SUBPROCESS_OUTPUT_MAX_BYTES",
  "CPB_HUB_MAX_ACTIVE_PER_PROJECT",
  "CPB_MULTI_EVOLVE_INTERVAL_MS", "CPB_MULTI_EVOLVE_BATCH_SIZE",
  "CPB_MULTI_EVOLVE_MAX_ROUNDS", "CPB_MULTI_EVOLVE_MAX_ISSUES",
  "CPB_MULTI_EVOLVE_PROJECTS", "CPB_MULTI_EVOLVE_AGENT",
  "CPB_MULTI_EVOLVE_TIMEOUT_MS", "CPB_MULTI_EVOLVE_WORKFLOW",
  "CPB_MULTI_EVOLVE_MAX_DURATION_MS", "CPB_MULTI_EVOLVE_SCAN_FIXTURE",
  "CPB_PORT", "CPB_HOST",
]);

const ACP_RUNTIME_ENV = new Set([
  "CPB_JOB_ID", "CPB_ACP_JOB_ID", "CPB_ACP_PHASE", "CPB_ACP_PROJECT",
  "CPB_ACP_ROLE", "CPB_ACP_CPB_ROOT", "CPB_ACP_CWD", "CPB_AGENT_HOME_INSTANCE_ID",
  "CPB_ACP_CLIENT", "CPB_ACP_TIMEOUT_MS", "CPB_ACP_IDLE_TIMEOUT_MS", "CPB_ACP_SESSION_UPDATE_IDLE_TIMEOUT_MS", "CPB_ACP_PHASE_TIMEOUT_MS", "CPB_ACP_USE_MANAGED_POOL",
  "CPB_ACP_PERSISTENT_PROCESS", "CPB_ACP_LAUNCH_PROFILE",
  "CPB_ACP_POOL_SCOPE", "CPB_ACP_CONTROL_PLANE",
  "CPB_ACP_AUDIT_FILE", "CPB_PROVIDER_PREFLIGHT_NONCE",
  "CPB_ACP_UI_LANE", "CPB_ACP_UI_LANE_REASON",
  "CPB_ACP_WRITE_ALLOW", "CPB_ACP_TERMINAL", "CPB_ACP_RTK_ENABLED",
  "CPB_ACP_TEST_SCENARIO_JSON", "CPB_ACP_TEST_SCENARIO", "CPB_ACP_TEST_TRANSCRIPT",
  "CPB_ACP_TOOL_POLICY_FILE", "CPB_ACP_DENY_TOOLS", "CPB_ACP_ALLOW_TOOLS",
  "CPB_ACP_DISABLE_WEB_TOOLS", "CPB_ACP_EXACT_TEST_COMMAND_GUARD",
  "CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT", "CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS",
  "CPB_TASK_RISK_LEVEL", "CPB_TASK_VERIFICATION_DEPTH",
  "CPB_TASK_EVIDENCE_REQUIREMENTS_JSON", "CPB_TASK_PHASE_BUDGET_POLICY_JSON",
  "CPB_CANONICAL_TEST_COMMANDS_JSON", "CPB_DIAGNOSTIC_TEST_COMMANDS_JSON",
  "CPB_ACP_PERMISSION", "CPB_AGENT_ISOLATE_HOME",
  "CPB_OVERRIDE_AGENT",
  "CPB_AGENT_SANDBOX", "CPB_AGENT_SANDBOX_MODE",
  "CPB_AGENT_SANDBOX_NETWORK", "CPB_AGENT_SANDBOX_PROCESS",
  "CPB_AGENT_SANDBOX_ALLOW_READ", "CPB_AGENT_SANDBOX_ALLOW_WRITE",
  "CPB_AGENT_SANDBOX_COMMAND", "CPB_AGENT_SANDBOX_ARGS",
  "CPB_AGENT_SANDBOX_INHERITED",
  "CPB_AGENT_FS_BOUNDARY_JSON",
  "CPB_VERIFIER_REPLAY_WORKSPACE_WRITE",
  "CPB_CODEX_VERIFIER_WORKSPACE_WRITE",
  "CPB_CLAUDE_VARIANT", "CPB_BUILDER_VARIANT", "CPB_ACP_CLAUDE_VARIANT",
  "CPB_SUPERVISOR_INTERVAL_MS", "CPB_SUPERVISOR_MAX_CONCURRENT",
]);

const NO_PROVIDER_CREDENTIALS = new Set<string>();

// A pool is a trusted CPB process boundary, not an agent child. Before the
// descriptor registry is loaded it still needs to retain conventional provider
// variables so the later descriptor-scoped filter can select them. The child
// boundary never uses this pattern; it only accepts descriptor-declared keys.
const PROVIDER_ENV_NAME_PATTERN = /(?:API_KEY|AUTH_TOKEN|BASE_URL|ENDPOINT|MODEL|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/;

const ALLOWED_ENV = new Set([
  ...RUNTIME_BASICS,
  ...CPB_RUNTIME_ENV,
  ...ACP_RUNTIME_ENV,
]);

const EXPLICIT_ONLY_CHILD_ENV = new Set([
  "CPB_PROJECT_RUNTIME_ROOT",
  "CPB_AGENT_HOME_INSTANCE_ID",
]);

const ACP_POOL_ENV = new Set([
  // A run may host multiple isolated worker processes. This path lets their
  // ACP pools coordinate provider leases without sharing project state.
  "CPB_ACP_POOL_LEASE_ROOT",
  "CPB_ACP_POOL_TIMEOUT_MS",
  "CPB_ACP_POOL_WAIT_TIMEOUT_MS",
  "CPB_ACP_RATE_LIMIT_BACKOFF_MS",
  "CPB_ACP_POOL_PROVIDER_MAX",
  "CPB_ACP_POOL_MAX_REQUESTS",
  "CPB_ACP_POOL_MAX_AGE_MS",
  "CPB_ACP_POOL_IDLE_MS",
  "CPB_ACP_POOL_CONNECTION_POLL_MS",
  "CPB_ACP_PROVIDER_FALLBACKS",
]);

function isDynamicAllowedEnvKey(key: string): boolean {
  return (
    key === "CPB_ACP_AGENT_VARIANT" ||
    /^CPB_ACP_TOOL_(?:CALL|EVENT)_BUDGET(?:_[A-Z0-9_]+)?$/.test(key) ||
    /^CPB_ACP_[A-Z0-9_]+_(?:COMMAND|ARGS|VARIANT|PROVIDER|PROFILE_ROOT|HEADLESS|RECORD|TRACE|SLOW_MO|TIMEOUT_MS)$/.test(key)
  );
}

function isDynamicAcpPoolEnvKey(key: string): boolean {
  return /^CPB_ACP_POOL_PROVIDER_[A-Z0-9_]+_MAX$/.test(key);
}

function isNumericEnvValue(value: unknown): boolean {
  return /^\d+$/.test(String(value ?? "").trim());
}

function normalizeAgentName(agent: unknown): string {
  return String(agent || "").trim().toLowerCase();
}

function agentNameFromOptions(options: ChildEnvOptions = {}) {
  if (typeof options === "string") return normalizeAgentName(options);
  return normalizeAgentName(options.agent || options.agentName);
}

function providerNameFromOptions(options: ChildEnvOptions = {}) {
  if (typeof options === "string") return "";
  return normalizeAgentName(options.provider || options.providerId);
}

function providerKeysFromOptions(options: ChildEnvOptions = {}) {
  if (typeof options === "string" || !Array.isArray(options.providerCredentialKeys)) return new Set<string>();
  return new Set(options.providerCredentialKeys.filter((key: unknown): key is string => typeof key === "string"));
}

export function providerCredentialKeysForAgent(
  agent: unknown,
  provider: unknown = null,
  model: unknown = null,
  providerEnv: Record<string, string | undefined> = process.env,
): Set<string> {
  const normalized = normalizeAgentName(agent);
  if (!normalized) return new Set();
  try {
    const providerName = typeof provider === "string" ? provider.trim() : "";
    return providerName
      ? new Set(providerEnvironmentKeysForSelection(normalized, null, providerName, typeof model === "string" ? model : null, providerEnv))
      : new Set(providerEnvironmentKeysForAgent(normalized));
  } catch {
    return new Set(NO_PROVIDER_CREDENTIALS);
  }
}

export function providerCredentialInputKeysForAgentName(
  agent: unknown,
  provider: unknown = null,
  model: unknown = null,
  providerEnv: Record<string, string | undefined> = process.env,
): Set<string> {
  const normalized = normalizeAgentName(agent);
  if (!normalized) return new Set();
  try {
    const providerName = typeof provider === "string" ? provider.trim() : "";
    return providerName
      ? new Set(providerCredentialInputKeysForSelection(normalized, null, providerName, typeof model === "string" ? model : null, providerEnv))
      : new Set(providerCredentialInputKeysForAgent(normalized));
  } catch {
    return new Set();
  }
}

function allowedProviderCredentialsForOptions(
  options: ChildEnvOptions = {},
  providerEnv: Record<string, string | undefined> = process.env,
) {
  if (typeof options !== "string" && options.includeProviderCredentials === false) {
    return NO_PROVIDER_CREDENTIALS;
  }
  const explicit = providerKeysFromOptions(options);
  const agent = agentNameFromOptions(options);
  const provider = providerNameFromOptions(options);
  const providerConfig = provider ? getConfiguredProvider(provider, providerEnv) : null;
  const selectedProviderKeys = providerConfig ? providerEnvironmentKeysFromConfig(providerConfig) : new Set<string>();
  if (!agent && explicit.size === 0) {
    try {
      return new Set([
        ...providerEnvironmentKeysForAllAgents(),
        ...configuredProviderEnvironmentKeys(providerEnv),
        ...selectedProviderKeys,
      ]);
    } catch {
      return new Set([...configuredProviderEnvironmentKeys(providerEnv), ...selectedProviderKeys]);
    }
  }
  return new Set([
    ...explicit,
    ...providerCredentialKeysForAgent(agent, provider, typeof options === "string" ? null : options.model, providerEnv),
    ...selectedProviderKeys,
  ]);
}

function isAcpPoolNumericEntry(key: string, value: unknown): boolean {
  return (ACP_POOL_ENV.has(key) || isDynamicAcpPoolEnvKey(key)) && isNumericEnvValue(value);
}

function shouldCopyAcpPoolEnvEntry(
  key: string,
  value: unknown,
  providerEnv: Record<string, string | undefined> = process.env,
): boolean {
  if (key === "CPB_ACP_POOL_LEASE_ROOT") return typeof value === "string" && value.trim().length > 0;
  if (key === "CPB_ACP_PROVIDER_FALLBACKS") return typeof value === "string" && value.trim().length > 0;
  return isAcpPoolNumericEntry(key, value) || isAllowedChildEnvKey(key, {}, providerEnv);
}

function shouldCopyChildEnvEntry(
  key: string,
  value: unknown,
  options: ChildEnvOptions = {},
  providerEnv: Record<string, string | undefined> = process.env,
): boolean {
  return isAcpPoolNumericEntry(key, value) || isAllowedChildEnvKey(key, options, providerEnv);
}

export function isAllowedChildEnvKey(
  key: string,
  options: ChildEnvOptions = {},
  providerEnv: Record<string, string | undefined> = process.env,
): boolean {
  if (allowedProviderCredentialsForOptions(options, providerEnv).has(key)) return true;
  return ALLOWED_ENV.has(key) || isDynamicAllowedEnvKey(key) || isDynamicAcpPoolEnvKey(key);
}

const RUNTIME_ALLOWED = new Set([...RUNTIME_BASICS, ...CPB_RUNTIME_ENV]);

function allowKeysFromOptions(options: ChildEnvOptions) {
  if (!options || typeof options === "string") return new Set<string>();
  return new Set(Array.isArray(options.allowKeys) ? options.allowKeys : []);
}

function _filterEnv(parentEnv: EnvMap = {}, extra: EnvMap = {}, predicate: (key: string, value: string | undefined) => boolean): EnvMap {
  const env: EnvMap = {};
  for (const [k, v] of Object.entries(parentEnv || {})) {
    if (EXPLICIT_ONLY_CHILD_ENV.has(k)) continue;
    if (predicate(k, v)) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra || {})) { if (predicate(k, v)) env[k] = v; }
  return env;
}

export function buildChildEnv(parentEnv: EnvMap = {}, extra: EnvMap = {}, options: ChildEnvOptions = {}) {
  const allowKeys = allowKeysFromOptions(options);
  const providerEnv = { ...process.env, ...parentEnv, ...extra };
  return _filterEnv(parentEnv, extra, (k, v) => allowKeys.has(k) || shouldCopyChildEnvEntry(k, v, options, providerEnv));
}

export function buildRuntimeEnv(parentEnv: EnvMap = {}, extra: EnvMap = {}) {
  return _filterEnv(parentEnv, extra, (k) => RUNTIME_ALLOWED.has(k));
}

export function buildAcpPoolEnv(parentEnv: EnvMap = {}, extra: EnvMap = {}) {
  const providerEnv = { ...process.env, ...parentEnv, ...extra };
  let configured = new Set<string>();
  try {
    for (const key of configuredProviderEnvironmentKeys(providerEnv)) configured.add(key);
    for (const key of configuredProviderCredentialInputKeys(providerEnv)) configured.add(key);
  } catch {
    // A malformed or unreadable providers.json contributes no keys.
  }
  try {
    configured = providerEnvironmentKeysForAllAgents();
    for (const key of configuredProviderEnvironmentKeys(providerEnv)) configured.add(key);
    for (const key of configuredProviderCredentialInputKeys(providerEnv)) configured.add(key);
  } catch {
    // The pool can be constructed before async registry initialization. The
    // conventional-name pass keeps those values in the trusted pool only;
    // child processes still require a descriptor declaration.
  }
  return _filterEnv(parentEnv, extra, (k, v) => (
    shouldCopyAcpPoolEnvEntry(k, v, providerEnv)
    || configured.has(k)
    || PROVIDER_ENV_NAME_PATTERN.test(k)
  ));
}

export {
  RUNTIME_BASICS,
  CPB_RUNTIME_ENV,
  ACP_RUNTIME_ENV,
  ACP_POOL_ENV,
  ALLOWED_ENV,
};
