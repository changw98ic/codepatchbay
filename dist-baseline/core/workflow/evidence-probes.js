const INVALID = { valid: false, satisfied: false };
function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
/**
 * Validate an evidence observation entry against the checklist item's verification method.
 *
 * Each method requires specific observation fields. Predicate echo — a bare
 * { checklistId, verificationMethod, predicateId, result: "pass" } — is rejected
 * because the method-specific fields are missing.
 */
export function validateEvidenceObservation(entry, checklistItem, { attemptId, finalWorktree } = {}) {
    if (!entry || typeof entry !== "object")
        return INVALID;
    if (text(attemptId) && text(entry.attemptId) !== text(attemptId))
        return INVALID;
    switch (checklistItem.verificationMethod) {
        case "command":
        case "test":
            return validateCommandObservation(entry);
        case "static":
            return validateStaticObservation(entry);
        case "runtime_event":
            return validateRuntimeEventObservation(entry);
        case "artifact_event":
            return validateArtifactEventObservation(entry);
        case "audit_export":
            return validateAuditExportObservation(entry);
        case "dag_event":
            return validateDagEventObservation(entry);
        case "worker_lifecycle":
            return validateWorkerLifecycleObservation(entry);
        case "manual":
            return validateManualObservation(entry, checklistItem);
        case "absence_check":
            return validateAbsenceCheckObservation(entry);
        default:
            return INVALID;
    }
}
/**
 * Wrap a legacy boolean validator result as { valid, satisfied }.
 * Preserves existing strictness for methods whose honest-zero distinction is
 * not yet modeled (satisfied === valid). Tracking this per-method is separate
 * debt and intentionally out of scope for this fix.
 */
function wrap(ok) {
    return { valid: ok, satisfied: ok };
}
/**
 * command / test (single validator serves both methods — dispatched together in
 * validateEvidenceObservation): spec requires command identity, cwd/repo root,
 * integer exit code, stdout/stderr or parsed-output digest, worktree identity,
 * and attempt id.
 *
 * - `valid` = a structurally complete command record: command identity, integer
 *   exitCode, an output digest (stdoutSha256, stderrSha256, or a parsed
 *   parsedOutput digest), and WHERE it ran (cwd or repoRoot). The record-gate:
 *   a well-formed observation is recorded honestly rather than silently dropped.
 * - `satisfied` = valid AND exitCode === 0 AND worktreeHead present. The
 *   objective positive signal is a clean exit; worktreeHead ties the result to
 *   the declared worktree so a stale/forged run about a different worktree
 *   cannot satisfy. (buildEvidenceLedger stamps worktreeHead onto every ledger
 *   entry, so real production command evidence carries it.) cwd/repoRoot is
 *   required for valid — the record must say where it ran — but is not a
 *   pass/fail signal on its own.
 */
function validateCommandObservation(entry) {
    const hasCommand = text(entry.command);
    const hasIntegerExitCode = Number.isInteger(entry.exitCode);
    const hasDigest = text(entry.stdoutSha256) || text(entry.stderrSha256) || text(entry.parsedOutputDigest);
    const hasLocation = text(entry.cwd) || text(entry.repoRoot);
    const valid = Boolean(hasCommand && hasIntegerExitCode && hasDigest && hasLocation);
    const satisfied = Boolean(valid && entry.exitCode === 0 && text(entry.worktreeHead));
    return { valid, satisfied };
}
/**
 * static: valid requires queryId + integer matchCount (the record-gate —
 * a well-formed observation with matchCount:0 is recorded honestly). satisfied
 * additionally requires matchCount > 0 (the observation actually proves the
 * item). matchCount:0 → { valid: true, satisfied: false }.
 */
function validateStaticObservation(entry) {
    const hasQueryId = text(entry.queryId);
    const hasIntegerMatchCount = Number.isInteger(entry.matchCount);
    const valid = Boolean(hasQueryId && hasIntegerMatchCount);
    const satisfied = Boolean(valid && entry.matchCount > 0);
    return { valid, satisfied };
}
/**
 * runtime_event: valid = event identity (eventType + event id or timestamp +
 * attemptId); satisfied = valid plus a POSITIVE payload matcher
 * (payloadMatcher + matchedValue) so a self-attested "I observed an event of
 * type X" is recorded honestly as not-satisfied rather than silently passing.
 */
function validateRuntimeEventObservation(entry) {
    const valid = Boolean(text(entry.eventType)
        && (text(entry.eventId) || text(entry.observedAt) || text(entry.ts))
        && text(entry.attemptId));
    const satisfied = Boolean(valid
        && text(entry.payloadMatcher)
        && text(entry.matchedValue));
    return { valid, satisfied };
}
/**
 * artifact_event: valid = artifact identity (kind/type + artifact hash or path
 * or artifactId, the artifact-identity signal the spec requires) + timestamp +
 * attemptId; satisfied = valid plus a POSITIVE payload matcher
 * (payloadMatcher + matchedValue).
 */
function validateArtifactEventObservation(entry) {
    const valid = Boolean((text(entry.artifactKind) || text(entry.eventType))
        && (text(entry.artifactHash) || text(entry.path) || text(entry.artifactId))
        && (text(entry.observedAt) || text(entry.ts))
        && text(entry.attemptId));
    const satisfied = Boolean(valid
        && text(entry.payloadMatcher)
        && text(entry.matchedValue));
    return { valid, satisfied };
}
/**
 * audit_export: valid requires an export invocation identity (exportId,
 * invocationId, or probeId), a sectionPath, and an attemptId — the structural
 * record-gate so a well-formed observation is recorded honestly rather than
 * silently dropped. satisfied additionally requires valueDigest (an objective
 * hash of the observed export value) — the positive proof that the export
 * actually contained the section's content. Without the digest an agent can
 * only self-attest "I exported section X" with no proof of content, which is
 * recordable (valid) but not satisfying.
 */
function validateAuditExportObservation(entry) {
    const valid = Boolean((text(entry.exportId) || text(entry.invocationId) || text(entry.probeId))
        && text(entry.sectionPath)
        && text(entry.attemptId));
    const satisfied = Boolean(valid && text(entry.valueDigest));
    return { valid, satisfied };
}
/**
 * dag_event: valid = DAG node identity + event type/kind/probeId + timestamp +
 * attemptId; satisfied = valid plus a POSITIVE payload matcher
 * (payloadMatcher + matchedValue) so a self-attested "DAG node N fired" is
 * recorded honestly as not-satisfied rather than silently passing.
 */
function validateDagEventObservation(entry) {
    const valid = Boolean((text(entry.nodeId) || text(entry.dagNodeId))
        && (text(entry.eventType) || text(entry.artifactKind) || text(entry.probeId))
        && (text(entry.observedAt) || text(entry.ts))
        && text(entry.attemptId));
    const satisfied = Boolean(valid
        && text(entry.payloadMatcher)
        && text(entry.matchedValue));
    return { valid, satisfied };
}
/**
 * worker_lifecycle: valid = assignment/worker identity + lifecycle event type +
 * timestamp + attemptId; satisfied = valid plus a POSITIVE payload matcher
 * (payloadMatcher + matchedValue) so a self-attested "worker W transitioned" is
 * recorded honestly as not-satisfied rather than silently passing.
 */
function validateWorkerLifecycleObservation(entry) {
    const valid = Boolean((text(entry.assignmentId) || text(entry.workerId))
        && (text(entry.eventType) || text(entry.lifecycleEvent) || text(entry.probeId))
        && (text(entry.observedAt) || text(entry.ts))
        && text(entry.attemptId));
    const satisfied = Boolean(valid
        && text(entry.payloadMatcher)
        && text(entry.matchedValue));
    return { valid, satisfied };
}
/**
 * manual: spec line 284 — approval artifact/event "resolvable through the
 * artifact or event index with approver, timestamp, scope covering the
 * checklist id, and attempt id. Self-attested approval fields in a ledger
 * entry are not enough."
 *
 * - valid: the structural record-gate — approver, timestamp, scope covering
 *   the checklist id, a resolvable approval artifact/event id, and the
 *   agent's resolution flag set true. Enough to RECORD the claim honestly.
 * - satisfied: valid AND the resolution produced an objective content hash
 *   (`resolvedArtifactHash`) of the approval artifact/event as resolved from
 *   the index. A bare `approvalArtifactResolved: true` flag an agent can set
 *   is NOT proof — spec requires the artifact be objectively resolvable, so a
 *   real hash must accompany the flag. valid-without-hash →
 *   { valid: true, satisfied: false } (recordable but not proven), matching
 *   spec's "self-attested approval fields are not enough".
 */
function validateManualObservation(entry, checklistItem) {
    const valid = Boolean(text(entry.approver)
        && (text(entry.approvedAt) || text(entry.ts))
        && Array.isArray(entry.scope)
        && entry.scope.includes(checklistItem.id)
        && Boolean(text(entry.approvalArtifactId || entry.approvalEventId) && entry.approvalArtifactResolved === true));
    const satisfied = Boolean(valid && text(entry.resolvedArtifactHash));
    return { valid, satisfied };
}
/**
 * absence_check: spec line 285 — "bounded query source, query window, event
 * types, active attempt id, and a negative query result."
 *
 * - valid: the structural record-gate — absence===true, bounded queryWindow
 *   {from,to}, event types, and attemptId. Enough to RECORD an honest
 *   absence claim.
 * - satisfied: valid AND a bounded query source (`querySource` — the
 *   path/index actually queried) AND an objective negative-result signature
 *   (`queryResultSignature` — e.g. an empty-result count+hash, or the query
 *   command plus its empty-result digest). A bare `absence: true`
 *   self-attested boolean is NOT proof — spec frames the result as a real
 *   "negative query result", so the observation must carry evidence the query
 *   RAN and returned empty, not just a flag. valid-without-signature →
 *   { valid: true, satisfied: false }.
 */
function validateAbsenceCheckObservation(entry) {
    const valid = Boolean(entry.absence === true
        && text(entry.queryWindow?.from)
        && text(entry.queryWindow?.to)
        && Array.isArray(entry.eventTypes)
        && text(entry.attemptId));
    const satisfied = Boolean(valid && text(entry.querySource) && text(entry.queryResultSignature));
    return { valid, satisfied };
}
/**
 * Build a probe plan from the acceptance checklist and hard-gate checks.
 *
 * PRIMARY SOURCE: acceptance checklist items. Each item with a verificationMethod
 * and predicateId gets a probe generated automatically. This ensures every
 * checklist item has a corresponding evidence claim path.
 *
 * SECONDARY SOURCE: explicit hard-gate checks that already carry checklistId,
 * predicateId, and probeId. These are merged in — deduplicated by checklistId.
 */
export function buildEvidenceProbePlan({ acceptanceChecklist, hardGateChecks = [], attemptId }) {
    const probes = [];
    const probeByChecklistId = new Map();
    const seenExplicitChecklistIds = new Set();
    // Primary: generate probes from acceptance checklist items
    const items = Array.isArray(acceptanceChecklist?.items) ? acceptanceChecklist.items : [];
    for (const item of items) {
        const checklistId = text(item.id);
        const predicateId = text(item.predicateId);
        if (!checklistId || !predicateId)
            continue;
        const probe = {
            checklistId,
            predicateId,
            probeId: `probe-${checklistId}`,
            observation: {
                checklistId,
                predicateId,
                verificationMethod: item.verificationMethod || "static",
                expectedEvidence: item.expectedEvidence || null,
                area: item.area || null,
            },
            emitFailedClaim: true,
        };
        probeByChecklistId.set(checklistId, probe);
        probes.push(probe);
    }
    // Secondary: merge in explicit hard-gate checks. An explicit check is more
    // authoritative (it carries a real method-specific observation from a hard
    // gate), so when its checklistId was already added by primary we UPGRADE
    // that probe's observation/emitFailedClaim in place rather than dropping it.
    // Duplicate explicit checks (same checklistId) are deduped — first wins.
    for (const check of hardGateChecks) {
        const checklistId = text(check.checklistId);
        const predicateId = text(check.predicateId);
        const probeId = text(check.probeId);
        if (!checklistId || !predicateId || !probeId)
            continue;
        if (seenExplicitChecklistIds.has(checklistId))
            continue;
        seenExplicitChecklistIds.add(checklistId);
        const existing = probeByChecklistId.get(checklistId);
        if (existing) {
            existing.observation = check.observation || check;
            // Defensive re-stamp: the secondary observation may have been rebuilt
            // from a bare `check` object lacking attemptId. Re-assert it so no
            // probe observation can lose attemptId (the validateEvidenceObservation
            // gate requires it when attemptId is non-empty).
            if (text(attemptId))
                existing.observation.attemptId = existing.observation.attemptId ?? attemptId;
            if (check.emitFailedClaim === true)
                existing.emitFailedClaim = true;
            continue;
        }
        const probe = {
            checklistId,
            predicateId,
            probeId,
            observation: check.observation || check,
            emitFailedClaim: check.emitFailedClaim === true,
        };
        if (text(attemptId))
            probe.observation.attemptId = probe.observation.attemptId ?? attemptId;
        probeByChecklistId.set(checklistId, probe);
        probes.push(probe);
    }
    return {
        schemaVersion: 1,
        attemptId,
        probes,
    };
}
/**
 * Build a method-specific probe for a checklist item.
 * Returns a probe definition that can be used to generate evidence claims.
 */
export function buildProbeForMethod(checklistItem, observation, probeId) {
    return {
        checklistId: checklistItem.id,
        predicateId: checklistItem.predicateId,
        probeId,
        observation,
        emitFailedClaim: false,
    };
}
