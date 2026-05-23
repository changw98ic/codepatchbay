// Shared secret policy for P0.3: child-env allowlist, recursive redaction,
// secret-path detection, and secret-artifact classification.

// --- Allowlists ---

const RUNTIME_BASICS = new Set([
  "PATH", "HOME", "SHELL", "TERM", "TMPDIR", "TEMP", "TMP",
  "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
  "CODEX_HOME", "XDG_CACHE_HOME",
  // CPB-specific runtime vars
  "CPB_ROOT", "CPB_EXECUTOR_ROOT", "CPB_HUB_ROOT",
  "CPB_INSTALL_ROOT",
  "CPB_ACP_PERSISTENT_PROCESS", "CPB_DANGEROUS",
  "CPB_STALE_GRACE_COUNT", "CPB_ACTIVITY_STALE_MS",
  "CPB_PROJECT_CACHE",
]);

const PROVIDER_CREDENTIALS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
]);

const ALLOWED_ENV = new Set([...RUNTIME_BASICS, ...PROVIDER_CREDENTIALS]);

// --- Child-env builder ---

export function buildChildEnv(parentEnv, extra = {}) {
  const env = {};
  for (const key of ALLOWED_ENV) {
    if (key in parentEnv) env[key] = parentEnv[key];
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (ALLOWED_ENV.has(key)) env[key] = value;
  }
  return env;
}

export { RUNTIME_BASICS, PROVIDER_CREDENTIALS, ALLOWED_ENV };

// --- Secret redaction ---

const SECRET_KEY_PATTERN = /authorization|cookie|api[_-]?key|auth[_-]?token|token|secret|password|credential|private[_-]?key|access[_-]?key|session[_-]?key|webhook/i;
const WEBHOOK_URL_PATTERN = /https?:\/\/[^\s"']*(?:webhook|hook|bot)[^\s"']*/gi;
const QUERY_SECRET_PATTERN = /([?&](?:token|secret|key|signature)=)[^&\s"']+/gi;

function redactString(value, key = "") {
  if (typeof key === "string" && SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}/g, "[REDACTED]")
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|auth[_-]?token|token|secret|password|credential)[A-Za-z0-9_]*)(\s*[:=]\s*)(['"]?)[^\s,'"]+/gi, "$1$2$3[REDACTED]")
    .replace(WEBHOOK_URL_PATTERN, "[REDACTED_URL]")
    .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]");
}

export function redactSecrets(value, key = "") {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value, key);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (typeof value !== "object") return value;

  const seen = new WeakSet();
  function walk(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === "string") return redactString(val);
    if (typeof val === "number" || typeof val === "boolean") return val;
    if (Array.isArray(val)) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
      return val.map(walk);
    }
    if (typeof val !== "object") return val;
    if (seen.has(val)) return "[Circular]";
    seen.add(val);

    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else if (typeof v === "string") {
        out[k] = redactString(v, k);
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  }

  return walk(value);
}

// --- Secret-path detection ---

const SECRET_PATH_PATTERNS = [
  /^\.env$/,
  /^\.env\./,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.netrc$/,
  /^\.ssh[/\\]/,
  /(^|[/\\])\.ssh[/\\]/,
  /id_rsa$/,
  /id_ed25519$/,
  /id_ecdsa$/,
  /\.pem$/,
  /\.key$/,
  /_rsa$/,
  /(^|[/\\])\.aws[/\\]credentials$/,
  /(^|[/\\])\.aws[/\\]config$/,
  /(^|[/\\])\.config[/\\]gcloud/,
  /(^|[/\\])\.azure/,
  /(^|[/\\])\.kube[/\\]config$/,
  /(^|[/\\])\.npmrc$/,
  /(^|[/\\])\.netrc$/,
  /(^|[/\\])\.pypirc$/,
  /known_hosts$/,
];

export function isSecretPath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const normalized = filePath.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() || "";
  return SECRET_PATH_PATTERNS.some((p) => p.test(basename) || p.test(normalized));
}

// --- Secret-artifact detection ---

const SECRET_ARTIFACT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[a-zA-Z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{35}/,
];

export function isSecretContent(content) {
  if (typeof content !== "string") return false;
  return SECRET_ARTIFACT_PATTERNS.some((p) => p.test(content));
}

export function isSecretArtifact(name, content) {
  if (isSecretPath(name)) return true;
  if (typeof content === "string" && isSecretContent(content)) return true;
  return false;
}

export function makeSecretBlockedEvent(artifactName, reason) {
  return {
    type: "secret_blocked",
    messageKey: "secret_blocked",
    artifact: redactSecrets(String(artifactName || "")),
    reason: reason || "secret-like content detected",
    ts: new Date().toISOString(),
  };
}

export function notifySecretBlocked(onSecretBlocked, artifactName, reason) {
  const event = makeSecretBlockedEvent(artifactName, reason);
  if (typeof onSecretBlocked === "function") {
    onSecretBlocked(event);
  } else {
    process.stderr.write(`[secret-blocked] ${JSON.stringify(event)}\n`);
  }
  return event;
}
