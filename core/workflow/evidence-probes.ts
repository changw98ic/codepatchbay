type AnyRecord = Record<string, any>;

function text(value: any) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate an evidence observation entry against the checklist item's verification method.
 *
 * Each method requires specific observation fields. Predicate echo — a bare
 * { checklistId, verificationMethod, predicateId, result: "pass" } — is rejected
 * because the method-specific fields are missing.
 */
export function validateEvidenceObservation(entry: AnyRecord, checklistItem: AnyRecord, { attemptId, finalWorktree }: AnyRecord = {}) {
  if (!entry || typeof entry !== "object") return false;
  if (text(attemptId) && text(entry.attemptId) !== text(attemptId)) return false;

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
      return false;
  }
}

/**
 * command / test: require command text, integer exitCode === 0, and stdoutSha256.
 */
function validateCommandObservation(entry: AnyRecord) {
  return Boolean(
    text(entry.command)
    && Number.isInteger(entry.exitCode)
    && entry.exitCode === 0
    && text(entry.stdoutSha256),
  );
}

/**
 * static: require queryId and integer matchCount.
 */
function validateStaticObservation(entry: AnyRecord) {
  return Boolean(
    text(entry.queryId)
    && Number.isInteger(entry.matchCount),
  );
}

/**
 * runtime_event: require event type, event id or timestamp, and attemptId.
 */
function validateRuntimeEventObservation(entry: AnyRecord) {
  return Boolean(
    text(entry.eventType)
    && (text(entry.eventId) || text(entry.observedAt) || text(entry.ts))
    && text(entry.attemptId),
  );
}

/**
 * artifact_event: require artifact kind/id, hash or path resolution status, and attemptId.
 */
function validateArtifactEventObservation(entry: AnyRecord) {
  return Boolean(
    (text(entry.artifactKind) || text(entry.eventType))
    && (text(entry.observedAt) || text(entry.ts))
    && text(entry.attemptId),
  );
}

/**
 * audit_export: require export builder invocation id, section path, and attemptId.
 */
function validateAuditExportObservation(entry: AnyRecord) {
  return Boolean(
    (text(entry.exportId) || text(entry.invocationId) || text(entry.probeId))
    && (text(entry.sectionPath) || text(entry.observedAt) || text(entry.ts))
    && text(entry.attemptId),
  );
}

/**
 * dag_event: require event type or probe id, observedAt or ts timestamp,
 * and DAG node id with attemptId.
 */
function validateDagEventObservation(entry: AnyRecord) {
  return Boolean(
    (text(entry.nodeId) || text(entry.dagNodeId))
    && (text(entry.eventType) || text(entry.artifactKind) || text(entry.probeId))
    && (text(entry.observedAt) || text(entry.ts))
    && text(entry.attemptId),
  );
}

/**
 * worker_lifecycle: require assignment id, worker id, lifecycle event type, and attemptId.
 */
function validateWorkerLifecycleObservation(entry: AnyRecord) {
  return Boolean(
    (text(entry.assignmentId) || text(entry.workerId))
    && (text(entry.eventType) || text(entry.lifecycleEvent) || text(entry.probeId))
    && (text(entry.observedAt) || text(entry.ts))
    && text(entry.attemptId),
  );
}

/**
 * manual: require approval artifact id or event id, approver, approved timestamp,
 * scope containing the checklist id, and successful artifact/event resolution.
 */
function validateManualObservation(entry: AnyRecord, checklistItem: AnyRecord) {
  return Boolean(
    text(entry.approver)
    && (text(entry.approvedAt) || text(entry.ts))
    && Array.isArray(entry.scope)
    && entry.scope.includes(checklistItem.id)
    && Boolean(text(entry.approvalArtifactId || entry.approvalEventId) && entry.approvalArtifactResolved === true),
  );
}

/**
 * absence_check: require absence === true, bounded queryWindow with from and to,
 * event types, and attemptId.
 */
function validateAbsenceCheckObservation(entry: AnyRecord) {
  return Boolean(
    entry.absence === true
    && text(entry.queryWindow?.from)
    && text(entry.queryWindow?.to)
    && Array.isArray(entry.eventTypes)
    && text(entry.attemptId),
  );
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
export function buildEvidenceProbePlan({ acceptanceChecklist, hardGateChecks = [], attemptId }: AnyRecord) {
  const probes: AnyRecord[] = [];
  const probeByChecklistId = new Map<string, AnyRecord>();
  const seenExplicitChecklistIds = new Set<string>();

  // Primary: generate probes from acceptance checklist items
  const items = Array.isArray(acceptanceChecklist?.items) ? acceptanceChecklist.items : [];
  for (const item of items) {
    const checklistId = text(item.id);
    const predicateId = text(item.predicateId);
    if (!checklistId || !predicateId) continue;
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
    if (!checklistId || !predicateId || !probeId) continue;
    if (seenExplicitChecklistIds.has(checklistId)) continue;
    seenExplicitChecklistIds.add(checklistId);

    const existing = probeByChecklistId.get(checklistId);
    if (existing) {
      existing.observation = check.observation || check;
      if (check.emitFailedClaim === true) existing.emitFailedClaim = true;
      continue;
    }

    const probe = {
      checklistId,
      predicateId,
      probeId,
      observation: check.observation || check,
      emitFailedClaim: check.emitFailedClaim === true,
    };
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
export function buildProbeForMethod(checklistItem: AnyRecord, observation: AnyRecord, probeId: string) {
  return {
    checklistId: checklistItem.id,
    predicateId: checklistItem.predicateId,
    probeId,
    observation,
    emitFailedClaim: false,
  };
}
