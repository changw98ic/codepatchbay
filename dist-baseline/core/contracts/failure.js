export const FailureKind = Object.freeze({
    AGENT_UNAVAILABLE: "agent_unavailable",
    AGENT_RATE_LIMITED: "agent_rate_limited",
    AGENT_SPAWN_ERROR: "agent_spawn_error",
    AGENT_EXIT_NONZERO: "agent_exit_nonzero",
    AGENT_CONTRACT_INVALID: "agent_contract_invalid",
    ARTIFACT_INVALID: "artifact_invalid",
    ISSUE_MISMATCH: "issue_mismatch",
    PERMISSION_DENIED: "permission_denied",
    RUNTIME_INTERRUPTED: "runtime_interrupted",
    WORKER_CRASHED: "worker_crashed",
    WORKER_HEARTBEAT_LOST: "worker_heartbeat_lost",
    ASSIGNMENT_PROGRESS_STALE: "assignment_progress_stale",
    TIMEOUT: "timeout",
    CODEGRAPH_UNAVAILABLE: "codegraph_unavailable",
    VERIFICATION_FAILED: "verification_failed",
    VERDICT_INVALID: "verdict_invalid",
    HUMAN_APPROVAL_REQUIRED: "human_approval_required",
    RUNJOB_PANIC: "runjob_panic",
    POISONED_SESSION: "poisoned_session",
    SCOPE_VIOLATION: "scope_violation",
    UNKNOWN: "unknown",
});
const VALID_KINDS = new Set(Object.values(FailureKind));
export function isValidFailureKind(kind) {
    return typeof kind === "string" && VALID_KINDS.has(kind);
}
export function failure({ kind, phase = null, reason, retryable = false, exitCode = null, signal = null, stdoutSnippet = "", stderrSnippet = "", cause = {}, }) {
    if (!VALID_KINDS.has(kind))
        throw new Error(`invalid FailureKind: ${kind}`);
    return {
        kind,
        phase,
        reason: String(reason),
        retryable: Boolean(retryable),
        exitCode,
        signal,
        stdoutSnippet: String(stdoutSnippet).slice(0, 2000),
        stderrSnippet: String(stderrSnippet).slice(0, 2000),
        cause,
    };
}
