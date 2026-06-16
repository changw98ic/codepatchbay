// Shared secret policy for P0.3: child-env allowlist, recursive redaction,
// secret-path detection, and secret-artifact classification.
export { buildAcpPoolEnv, buildChildEnv, buildRuntimeEnv, isAllowedChildEnvKey, providerCredentialKeysForAgent, RUNTIME_BASICS, CPB_RUNTIME_ENV, ACP_RUNTIME_ENV, ACP_POOL_ENV, PROVIDER_CREDENTIALS, OPENAI_COMPATIBLE_CREDENTIALS, ANTHROPIC_COMPATIBLE_CREDENTIALS, GEMINI_COMPATIBLE_CREDENTIALS, PROVIDER_CREDENTIALS_BY_AGENT, ALLOWED_ENV, } from "../../core/policy/child-env.js";
// --- Secret redaction ---
const SECRET_KEY_PATTERN = /authorization|cookie|api[_-]?key|auth[_-]?token|token|secret|password|credential|private[_-]?key|access[_-]?key|session[_-]?key|webhook/i;
const SECRET_REFERENCE_KEY_PATTERN = /(?:authorization|cookie|api[_-]?key|auth[_-]?token|token|secret|password|credential|private[_-]?key|access[_-]?key|session[_-]?key|webhook)[A-Za-z0-9_-]*(?:ref|reference)$/i;
const WEBHOOK_URL_PATTERN = /https?:\/\/[^\s"']*(?:webhook|hook|bot)[^\s"']*/gi;
const QUERY_SECRET_PATTERN = /([?&](?:token|secret|key|signature)=)[^&\s"']+/gi;
const GITHUB_URL_TOKEN_PATTERN = /https:\/\/x-access-token:[^@\s"']+@github\.com\/[^\s"']*/gi;
const SECRET_INPUT_GUIDANCE = "Do not paste API keys or tokens into CodePatchBay. Use provider-native login or the local setup URL.";
function isSecretReferenceKey(key = "") {
    return SECRET_REFERENCE_KEY_PATTERN.test(String(key));
}
function redactString(value, key = "") {
    if (typeof key === "string" && SECRET_KEY_PATTERN.test(key))
        return "[REDACTED]";
    return String(value)
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
        .replace(GITHUB_URL_TOKEN_PATTERN, "[REDACTED_URL]")
        .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]")
        .replace(/\bsk-(?:ant-)?[a-zA-Z0-9_-]{8,}/g, "[REDACTED]")
        .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
        .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
        .replace(/\bAKIA[0-9A-Z]{16}/g, "[REDACTED]")
        .replace(/\bAIza[0-9A-Za-z_-]{35}/g, "[REDACTED]")
        .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|auth[_-]?token|token|secret|password|credential)[A-Za-z0-9_]*)(\s*[:=]\s*)(['"]?)[^\s,'"&?]+/gi, "$1$2$3[REDACTED]")
        .replace(WEBHOOK_URL_PATTERN, "[REDACTED_URL]");
}
export function redactSecrets(value, key = "") {
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string")
        return redactString(value, key);
    if (typeof value === "number" || typeof value === "boolean")
        return value;
    if (Array.isArray(value))
        return value.map((item) => redactSecrets(item));
    if (typeof value !== "object")
        return value;
    const seen = new WeakSet();
    function walk(val) {
        if (val === null || val === undefined)
            return val;
        if (typeof val === "string")
            return redactString(val);
        if (typeof val === "number" || typeof val === "boolean")
            return val;
        if (Array.isArray(val)) {
            if (seen.has(val))
                return "[Circular]";
            seen.add(val);
            return val.map(walk);
        }
        if (typeof val !== "object")
            return val;
        if (seen.has(val))
            return "[Circular]";
        seen.add(val);
        const out = {};
        for (const [k, v] of Object.entries(val)) {
            if (SECRET_KEY_PATTERN.test(k) && !isSecretReferenceKey(k)) {
                out[k] = "[REDACTED]";
            }
            else if (typeof v === "string") {
                out[k] = redactString(v, isSecretReferenceKey(k) ? "" : k);
            }
            else {
                out[k] = walk(v);
            }
        }
        return out;
    }
    return walk(value);
}
// --- Raw input secret detection ---
const RAW_SECRET_INPUT_PATTERNS = [
    { name: "github_url_token", pattern: /https:\/\/x-access-token:[^@\s"']+@github\.com\//i },
    { name: "credential_assignment", pattern: /\b[A-Za-z0-9_]*(?:api[_-]?key|auth[_-]?token|token|secret|password|credential)[A-Za-z0-9_]*\s*[:=]\s*\S+/i },
    { name: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i },
    { name: "provider_key", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/i },
    { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/i },
    { name: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{8,}\b/i },
    { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];
export function detectSecretInput(input) {
    const text = Array.isArray(input) ? input.join(" ") : String(input ?? "");
    const match = RAW_SECRET_INPUT_PATTERNS.find(({ pattern }) => pattern.test(text));
    return {
        matched: Boolean(match),
        kind: match ? "raw_secret_input" : null,
        pattern: match?.name || null,
        redacted: redactSecrets(text),
        guidance: SECRET_INPUT_GUIDANCE,
    };
}
export function assertNoSecretInput(input) {
    const detected = detectSecretInput(input);
    if (detected.matched) {
        const error = new Error(SECRET_INPUT_GUIDANCE);
        error.code = "SECRET_INPUT_REJECTED";
        error.detection = detected;
        throw error;
    }
    return detected;
}
export function makeSecretInputRejectedEvent({ source, input, reason } = {}) {
    const detected = detectSecretInput(input);
    return {
        type: "secret_input_rejected",
        messageKey: "secret_input_rejected",
        source: redactSecrets(source || "unknown"),
        reason: reason || "raw secret input rejected",
        evidence: {
            matched: detected.matched,
            pattern: detected.pattern,
            input: detected.redacted,
        },
        guidance: detected.guidance,
        ts: new Date().toISOString(),
    };
}
// --- Secret-path detection ---
const SECRET_PATH_PATTERNS = [
    /^\.env$/,
    /^\.env\./,
    /^\.npmrc$/,
    /^\.pypirc$/,
    /^\.netrc$/,
    /^\.gitconfig$/,
    /^\.git-credentials$/,
    /^\.zsh_history$/,
    /^\.bash_history$/,
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
    /(^|[/\\])\.gitconfig$/,
    /(^|[/\\])\.git-credentials$/,
    /(^|[/\\])\.zsh_history$/,
    /(^|[/\\])\.bash_history$/,
    /known_hosts$/,
    /(^|[/\\])keys\.json$/i,
    /(^|[/\\])google-creds\.json$/i,
    /(^|[/\\])credentials\.json$/i,
    /(^|[/\\])service-account[^/\\]*\.json$/i,
];
export function isSecretPath(filePath) {
    if (!filePath || typeof filePath !== "string")
        return false;
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
    if (typeof content !== "string")
        return false;
    return SECRET_ARTIFACT_PATTERNS.some((p) => p.test(content));
}
export function isSecretArtifact(name, content) {
    if (isSecretPath(name))
        return true;
    if (typeof content === "string" && isSecretContent(content))
        return true;
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
    }
    else {
        process.stderr.write(`[secret-blocked] ${JSON.stringify(event)}\n`);
    }
    return event;
}
