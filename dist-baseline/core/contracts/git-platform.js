export const BOUNDARY_VERSION = "1.0.0";
export const REQUIRED_ADAPTER_METHODS = Object.freeze([
    "resolveTransport",
    "normalizeWebhookEvent",
    "matchTrigger",
    "normalizeIssue",
    "readIssues",
    "syncIssues",
    "buildIssueBranchParts",
    "loadConfig",
    "validateConfig",
    "resolveWebhookSecret",
    "verifyWebhookSignature",
]);
export const REQUIRED_TRANSPORT_METHODS = Object.freeze([
    "postComment",
    "createPullRequest",
    "closeIssue",
]);
export const SUPPORTED_PLATFORMS = Object.freeze(["github"]);
export function isValidPlatform(platform) {
    return SUPPORTED_PLATFORMS.includes(platform);
}
export function validateGitPlatformAdapter(adapter) {
    if (!adapter || typeof adapter !== "object") {
        throw new Error("git-platform adapter: must be a non-null object");
    }
    if (typeof adapter.platform !== "string" || adapter.platform.length === 0) {
        throw new Error("git-platform adapter: must have a non-empty string 'platform'");
    }
    if (adapter.boundaryVersion && adapter.boundaryVersion !== BOUNDARY_VERSION) {
        throw new Error(`git-platform adapter: boundary version mismatch (expected ${BOUNDARY_VERSION}, got ${adapter.boundaryVersion})`);
    }
    const missing = REQUIRED_ADAPTER_METHODS.filter((m) => typeof adapter[m] !== "function");
    if (missing.length > 0) {
        throw new Error(`git-platform adapter: missing required methods: ${missing.join(", ")}`);
    }
    return adapter;
}
export function validateTransportResult(transport) {
    if (!transport || typeof transport !== "object") {
        throw new Error("git-platform transport: must be a non-null object");
    }
    if (typeof transport.mode !== "string" || transport.mode.length === 0) {
        throw new Error("git-platform transport: must have a non-empty string 'mode'");
    }
    if (typeof transport.healthy !== "boolean") {
        throw new Error("git-platform transport: must have boolean 'healthy'");
    }
    if (transport.healthy) {
        const missing = REQUIRED_TRANSPORT_METHODS.filter((m) => transport[m] !== null && typeof transport[m] !== "function");
        if (missing.length > 0) {
            throw new Error(`git-platform transport: healthy transport missing callable methods: ${missing.join(", ")}`);
        }
    }
    return transport;
}
