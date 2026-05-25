// Shared child-process environment policy.
// Keep this in core so runtime, bridges, and server entrypoints enforce the
// same secret boundary without importing server modules.

const RUNTIME_BASICS = new Set([
  "PATH", "HOME", "SHELL", "TERM", "TMPDIR", "TEMP", "TMP",
  "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "CI",
  "CODEX_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
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
  "CPB_USE_WORKTREE", "CPB_ALLOW_SOURCEPATH_REBIND",
  "CPB_VERSION", "CPB_DANGEROUS",
  "CPB_STALE_GRACE_COUNT", "CPB_ACTIVITY_STALE_MS", "CPB_PROJECT_CACHE",
  "CPB_RETRY_COUNT", "CPB_PREVIOUS_VERDICT_ID", "CPB_PREVIOUS_VERDICT_PATH",
  "CPB_LEASE_TTL_MS", "CPB_LEASE_RENEW_INTERVAL_MS",
  "CPB_EXECUTION_BOUNDARY",
  "CPB_MULTI_EVOLVE_INTERVAL_MS", "CPB_MULTI_EVOLVE_BATCH_SIZE",
  "CPB_MULTI_EVOLVE_MAX_ROUNDS", "CPB_MULTI_EVOLVE_MAX_ISSUES",
  "CPB_MULTI_EVOLVE_PROJECTS", "CPB_MULTI_EVOLVE_AGENT",
  "CPB_MULTI_EVOLVE_TIMEOUT_MS", "CPB_MULTI_EVOLVE_WORKFLOW",
  "CPB_MULTI_EVOLVE_MAX_DURATION_MS", "CPB_MULTI_EVOLVE_SCAN_FIXTURE",
  "CPB_PORT", "CPB_HOST",
]);

const ACP_RUNTIME_ENV = new Set([
  "CPB_JOB_ID", "CPB_ACP_JOB_ID", "CPB_ACP_PHASE", "CPB_ACP_PROJECT",
  "CPB_ACP_ROLE", "CPB_ACP_CPB_ROOT", "CPB_ACP_CWD",
  "CPB_ACP_CLIENT", "CPB_ACP_TIMEOUT_MS", "CPB_ACP_USE_MANAGED_POOL",
  "CPB_ACP_PERSISTENT_PROCESS", "CPB_ACP_LAUNCH_PROFILE",
  "CPB_ACP_UI_LANE", "CPB_ACP_UI_LANE_REASON",
  "CPB_ACP_WRITE_ALLOW", "CPB_ACP_TERMINAL",
  "CPB_ACP_TOOL_POLICY_FILE", "CPB_ACP_DENY_TOOLS", "CPB_ACP_ALLOW_TOOLS",
  "CPB_ACP_PERMISSION", "CPB_AGENT_ISOLATE_HOME", "CPB_LEGACY_CONTENT",
  "CPB_ACP_CODEX_COMMAND", "CPB_ACP_CODEX_ARGS",
  "CPB_ACP_CLAUDE_COMMAND", "CPB_ACP_CLAUDE_ARGS",
  "CPB_CLAUDE_VARIANT", "CPB_BUILDER_VARIANT", "CPB_ACP_CLAUDE_VARIANT",
  "CPB_ACTIVE_CLAUDE_VARIANT",
  "CPB_SUPERVISOR_INTERVAL_MS", "CPB_SUPERVISOR_MAX_CONCURRENT",
]);

const PROVIDER_CREDENTIALS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  // Kimi / Ollama Cloud variant
  "OLLAMA_CLOUD_URL", "OLLAMA_CLOUD_BASE_URL",
  "OLLAMACLOUD_BASE_URL", "OLLAMACLOUD_URL",
  "KIMI_BASE_URL", "MOONSHOT_BASE_URL",
  "OLLAMA_CLOUD_KEY", "OLLAMA_CLOUD_API_KEY",
  "OLLAMACLOUD_API_KEY", "OLLAMACLOUD_KEY",
  "KIMI_API_KEY", "MOONSHOT_API_KEY",
  "OLLAMA_CLOUD_MODEL", "OLLAMACLOUD_MODEL",
  "KIMI_MODEL", "MOONSHOT_MODEL",
  // Xiaomi / MiMo variant
  "XIAOMI_BASE_URL", "MIMO_BASE_URL",
  "XIAOMI_API_KEY", "XIAOMI_AUTH_TOKEN",
  "MIMO_API_KEY", "MIMO_AUTH_TOKEN",
  "XIAOMI_MODEL", "MIMO_MODEL",
]);

const ALLOWED_ENV = new Set([
  ...RUNTIME_BASICS,
  ...CPB_RUNTIME_ENV,
  ...ACP_RUNTIME_ENV,
  ...PROVIDER_CREDENTIALS,
]);

const ACP_POOL_ENV = new Set([
  "CPB_ACP_RATE_LIMIT_BACKOFF_MS",
  "CPB_ACP_POOL_MAX_REQUESTS",
  "CPB_ACP_POOL_MAX_AGE_MS",
  "CPB_ACP_POOL_IDLE_MS",
]);

function isDynamicAllowedEnvKey(key) {
  return /^CPB_ACP_[A-Z0-9_]+_(?:COMMAND|ARGS)$/.test(key);
}

function isDynamicAcpPoolEnvKey(key) {
  return /^CPB_ACP_POOL_[A-Z0-9_]+$/.test(key);
}

function isNumericEnvValue(value) {
  return /^\d+$/.test(String(value ?? "").trim());
}

function shouldCopyAcpPoolEnvEntry(key, value) {
  if (ACP_POOL_ENV.has(key) || isDynamicAcpPoolEnvKey(key)) {
    return isNumericEnvValue(value);
  }
  return isAllowedChildEnvKey(key);
}

export function isAllowedChildEnvKey(key) {
  return ALLOWED_ENV.has(key) || isDynamicAllowedEnvKey(key);
}

export function buildChildEnv(parentEnv = {}, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv || {})) {
    if (isAllowedChildEnvKey(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (isAllowedChildEnvKey(key)) env[key] = value;
  }
  return env;
}

export function buildRuntimeEnv(parentEnv = {}, extra = {}) {
  const env = {};
  const allowed = new Set([...RUNTIME_BASICS, ...CPB_RUNTIME_ENV]);
  for (const [key, value] of Object.entries(parentEnv || {})) {
    if (allowed.has(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (allowed.has(key)) env[key] = value;
  }
  return env;
}

export function buildAcpPoolEnv(parentEnv = {}, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv || {})) {
    if (shouldCopyAcpPoolEnvEntry(key, value)) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (shouldCopyAcpPoolEnvEntry(key, value)) env[key] = value;
  }
  return env;
}

export {
  RUNTIME_BASICS,
  CPB_RUNTIME_ENV,
  ACP_RUNTIME_ENV,
  ACP_POOL_ENV,
  PROVIDER_CREDENTIALS,
  ALLOWED_ENV,
};
