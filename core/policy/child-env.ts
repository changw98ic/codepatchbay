import type { LooseRecord } from "../../shared/types.js";
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
  "CPB_ROOT", "CPB_EXECUTOR_ROOT", "CPB_HUB_ROOT",
  "CPB_INSTALL_ROOT", "CPB_PROJECT_RUNTIME_ROOT", "CPB_PROJECT_PATH_OVERRIDE",
  "CPB_WORKFLOW", "CPB_PLAN_MODE", "CPB_TRIAGE_MODE",
  "CPB_QUEUE_ENTRY_ID", "CPB_SESSION_ID", "CPB_WORKER_ID",
  "CPB_SOURCE_CONTEXT_JSON", "CPB_CONTEXT_PACK_PATH",
  "CPB_PARENT_PLAN_CACHE_JSON", "CPB_INDEX_SNAPSHOT_JSON",
  "CPB_ISSUE_NUMBER", "CPB_ISSUE_URL", "CPB_ISSUE_REPO", "CPB_ISSUE_TITLE",
  "CPB_FAILED_QUEUE_ID", "CPB_FAILED_JOB_ID", "CPB_FAILURE_ARTIFACT",
  "CPB_GITHUB_PR_AFTER_PASS", "CPB_GITHUB_PR_DRY_RUN", "CPB_GITHUB_BRANCH_PUSHED",
  "CPB_TEAM_POLICY_JSON", "CPB_APPROVAL_POLL_MS", "CPB_APPROVAL_TIMEOUT_MS",
  "CPB_VERSION", "CPB_DANGEROUS",
  "CPB_CODEGRAPH_ENABLED", "CPB_CODEGRAPH_PORT", "CPB_CODEGRAPH_MCP_STDIO", "CPB_CODEGRAPH_INDEX_ONLY_OK", "CPB_PERMISSION_MODE",
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
  "CPB_ACP_UI_LANE", "CPB_ACP_UI_LANE_REASON",
  "CPB_ACP_WRITE_ALLOW", "CPB_ACP_TERMINAL",
  "CPB_ACP_TOOL_POLICY_FILE", "CPB_ACP_DENY_TOOLS", "CPB_ACP_ALLOW_TOOLS",
  "CPB_ACP_DISABLE_WEB_TOOLS", "CPB_ACP_EXACT_TEST_COMMAND_GUARD",
  "CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT", "CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS",
  "CPB_TASK_RISK_LEVEL", "CPB_TASK_VERIFICATION_DEPTH",
  "CPB_TASK_EVIDENCE_REQUIREMENTS_JSON", "CPB_TASK_PHASE_BUDGET_POLICY_JSON",
  "CPB_CANONICAL_TEST_COMMANDS_JSON", "CPB_DIAGNOSTIC_TEST_COMMANDS_JSON",
  "CPB_ACP_PERMISSION", "CPB_AGENT_ISOLATE_HOME", "CPB_LEGACY_CONTENT",
  "CPB_OVERRIDE_AGENT",
  "CPB_AGENT_SANDBOX", "CPB_AGENT_SANDBOX_MODE",
  "CPB_AGENT_SANDBOX_NETWORK", "CPB_AGENT_SANDBOX_PROCESS",
  "CPB_AGENT_SANDBOX_ALLOW_READ", "CPB_AGENT_SANDBOX_ALLOW_WRITE",
  "CPB_AGENT_SANDBOX_COMMAND", "CPB_AGENT_SANDBOX_ARGS",
  "CPB_AGENT_SANDBOX_INHERITED",
  "CPB_AGENT_FS_BOUNDARY_JSON",
  "CPB_VERIFIER_REPLAY_WORKSPACE_WRITE",
  "CPB_CODEX_VERIFIER_WORKSPACE_WRITE",
  "CPB_ACP_CODEX_COMMAND", "CPB_ACP_CODEX_ARGS",
  "CPB_ACP_CLAUDE_COMMAND", "CPB_ACP_CLAUDE_ARGS",
  "CPB_ACP_CLAUDE_GLM_COMMAND", "CPB_ACP_CLAUDE_GLM_ARGS", "CPB_ACP_CLAUDE_GLM_VARIANT",
  "CPB_ACP_CLAUDE_MIMO_COMMAND", "CPB_ACP_CLAUDE_MIMO_ARGS", "CPB_ACP_CLAUDE_MIMO_VARIANT",
  "CPB_CLAUDE_CLI_COMMAND", "CPB_CLAUDE_PLAN_MAX_TEXT_CHARS", "CPB_CLAUDE_PLAN_MAX_THINKING_TOKENS",
  "CPB_CLAUDE_PLAN_MAX_TURNS",
  "CPB_CLAUDE_MAX_INTERNAL_API_RETRIES",
  "MAX_THINKING_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CPB_CLAUDE_VARIANT", "CPB_BUILDER_VARIANT", "CPB_ACP_CLAUDE_VARIANT",
  "CPB_ACTIVE_CLAUDE_VARIANT",
  "CPB_SUPERVISOR_INTERVAL_MS", "CPB_SUPERVISOR_MAX_CONCURRENT",
]);

const PROVIDER_CREDENTIALS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  // Xiaomi / MiMo variant
  "XIAOMI_BASE_URL", "MIMO_BASE_URL",
  "XIAOMI_API_KEY", "XIAOMI_AUTH_TOKEN",
  "MIMO_API_KEY", "MIMO_AUTH_TOKEN",
  "XIAOMI_MODEL", "MIMO_MODEL",
  // Zhipu / GLM variant
  "ZHIPU_BASE_URL", "GLM_BASE_URL",
  "ZHIPU_API_KEY", "ZHIPU_AUTH_TOKEN",
  "GLM_API_KEY", "GLM_AUTH_TOKEN",
  "ZHIPU_MODEL", "GLM_MODEL",
]);

const OPENAI_COMPATIBLE_CREDENTIALS = new Set([
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
]);

const ANTHROPIC_COMPATIBLE_CREDENTIALS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  // Xiaomi / MiMo is applied as a Claude-compatible provider variant by
  // server/services/apply-variant.js.
  "XIAOMI_BASE_URL", "MIMO_BASE_URL",
  "XIAOMI_API_KEY", "XIAOMI_AUTH_TOKEN",
  "MIMO_API_KEY", "MIMO_AUTH_TOKEN",
  "XIAOMI_MODEL", "MIMO_MODEL",
  // Zhipu / GLM is applied through the same Claude-compatible variant path.
  "ZHIPU_BASE_URL", "GLM_BASE_URL",
  "ZHIPU_API_KEY", "ZHIPU_AUTH_TOKEN",
  "GLM_API_KEY", "GLM_AUTH_TOKEN",
  "ZHIPU_MODEL", "GLM_MODEL",
]);

const GEMINI_COMPATIBLE_CREDENTIALS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
]);

const PROVIDER_CREDENTIALS_BY_AGENT = new Map([
  ["codex", OPENAI_COMPATIBLE_CREDENTIALS],
  ["claude", ANTHROPIC_COMPATIBLE_CREDENTIALS],
  ["gemini", GEMINI_COMPATIBLE_CREDENTIALS],
  ["kimi", ANTHROPIC_COMPATIBLE_CREDENTIALS],
]);

const ALLOWED_ENV = new Set([
  ...RUNTIME_BASICS,
  ...CPB_RUNTIME_ENV,
  ...ACP_RUNTIME_ENV,
  ...PROVIDER_CREDENTIALS,
]);

const EXPLICIT_ONLY_CHILD_ENV = new Set([
  "CPB_PROJECT_RUNTIME_ROOT",
  "CPB_AGENT_HOME_INSTANCE_ID",
]);

const ACP_POOL_ENV = new Set([
  "CPB_ACP_RATE_LIMIT_BACKOFF_MS",
  "CPB_ACP_POOL_PROVIDER_MAX",
  "CPB_ACP_POOL_MAX_REQUESTS",
  "CPB_ACP_POOL_MAX_AGE_MS",
  "CPB_ACP_POOL_IDLE_MS",
  "CPB_ACP_POOL_CONNECTION_POLL_MS",
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
  return normalizeAgentName(options.agent || options.agentName || options.provider);
}

export function providerCredentialKeysForAgent(agent: unknown): Set<string> {
  const normalized = normalizeAgentName(agent);
  const scoped = PROVIDER_CREDENTIALS_BY_AGENT.get(normalized);
  return new Set(scoped || PROVIDER_CREDENTIALS);
}

function allowedProviderCredentialsForOptions(options: ChildEnvOptions = {}) {
  const agent = agentNameFromOptions(options);
  if (!agent) return PROVIDER_CREDENTIALS;
  return PROVIDER_CREDENTIALS_BY_AGENT.get(agent) || PROVIDER_CREDENTIALS;
}

function isAcpPoolNumericEntry(key: string, value: unknown): boolean {
  return (ACP_POOL_ENV.has(key) || isDynamicAcpPoolEnvKey(key)) && isNumericEnvValue(value);
}

function shouldCopyAcpPoolEnvEntry(key: string, value: unknown): boolean {
  return isAcpPoolNumericEntry(key, value) || isAllowedChildEnvKey(key);
}

function shouldCopyChildEnvEntry(key: string, value: unknown, options: ChildEnvOptions = {}): boolean {
  return isAcpPoolNumericEntry(key, value) || isAllowedChildEnvKey(key, options);
}

export function isAllowedChildEnvKey(key: string, options: ChildEnvOptions = {}): boolean {
  if (PROVIDER_CREDENTIALS.has(key)) {
    return allowedProviderCredentialsForOptions(options).has(key);
  }
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
  return _filterEnv(parentEnv, extra, (k, v) => allowKeys.has(k) || shouldCopyChildEnvEntry(k, v, options));
}

export function buildRuntimeEnv(parentEnv: EnvMap = {}, extra: EnvMap = {}) {
  return _filterEnv(parentEnv, extra, (k) => RUNTIME_ALLOWED.has(k));
}

export function buildAcpPoolEnv(parentEnv: EnvMap = {}, extra: EnvMap = {}) {
  return _filterEnv(parentEnv, extra, (k, v) => shouldCopyAcpPoolEnvEntry(k, v));
}

export {
  RUNTIME_BASICS,
  CPB_RUNTIME_ENV,
  ACP_RUNTIME_ENV,
  ACP_POOL_ENV,
  PROVIDER_CREDENTIALS,
  OPENAI_COMPATIBLE_CREDENTIALS,
  ANTHROPIC_COMPATIBLE_CREDENTIALS,
  GEMINI_COMPATIBLE_CREDENTIALS,
  PROVIDER_CREDENTIALS_BY_AGENT,
  ALLOWED_ENV,
};
