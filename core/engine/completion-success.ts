import type { LooseRecord } from "../contracts/types.js";

type CompletedJobResult = {
  status: "completed";
  jobId: string;
  exitCode: 0;
  failure: null;
  phaseResults: LooseRecord[];
  completionReport?: LooseRecord | null;
};

type CompletionSuccessInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phaseResults: LooseRecord[];
  completionReport?: LooseRecord | null;
  completeJob: (cpbRoot: string, project: string, jobId: string) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

type CompletionReportInput = {
  project: string;
  jobId: string;
  checklistArtifacts?: LooseRecord | null;
  riskMap?: LooseRecord | null;
  phaseResults?: LooseRecord[];
  candidateValidation?: LooseRecord | null;
};

function recordArray(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.filter((entry): entry is LooseRecord => (
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
  )) : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.map(text).filter(Boolean))].sort();
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueStrings(value);
  const single = text(value);
  return single ? [single] : [];
}

function fieldStrings(record: LooseRecord, fields: string[]) {
  return fields.flatMap((field) => stringList(record[field]));
}

function artifactRecord(checklistArtifacts: LooseRecord | null | undefined, kind: string) {
  const value = checklistArtifacts?.[kind];
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function phaseResidualRisks(phaseResults: LooseRecord[] = []) {
  const risks: string[] = [];
  for (const result of phaseResults) {
    const artifact = result.artifact && typeof result.artifact === "object" && !Array.isArray(result.artifact)
      ? result.artifact as LooseRecord
      : {};
    const metadata = artifact.metadata && typeof artifact.metadata === "object" && !Array.isArray(artifact.metadata)
      ? artifact.metadata as LooseRecord
      : {};
    risks.push(...fieldStrings(result, ["risk", "risks", "residualRisk", "residualRisks"]));
    risks.push(...fieldStrings(artifact, ["risk", "risks", "residualRisk", "residualRisks"]));
    risks.push(...fieldStrings(metadata, ["risk", "risks", "residualRisk", "residualRisks"]));
  }
  return risks;
}

export function buildCompletionReport({
  project,
  jobId,
  checklistArtifacts = null,
  riskMap = null,
  phaseResults = [],
  candidateValidation = null,
}: CompletionReportInput): LooseRecord | null {
  const checklist = artifactRecord(checklistArtifacts, "acceptance-checklist");
  const executionMap = artifactRecord(checklistArtifacts, "execution-map");
  const evidenceLedger = artifactRecord(checklistArtifacts, "evidence-ledger");
  const verdict = artifactRecord(checklistArtifacts, "checklist-verdict");
  const scopeAmendment = artifactRecord(checklistArtifacts, "scope-amendment");
  const items = recordArray(checklist.items);
  const evidence = recordArray(evidenceLedger.evidence);
  const changedFiles = uniqueStrings(Array.isArray(executionMap.changedFiles) ? executionMap.changedFiles : []);

  if (
    items.length === 0
    && evidence.length === 0
    && changedFiles.length === 0
    && !candidateValidation
  ) return null;

  const assumptions = recordArray(checklist.assumptions)
    .map((entry) => text(entry.text || entry.reason || entry.summary))
    .filter(Boolean);
  const failedOrUnchecked = recordArray(verdict.items)
    .filter((entry) => text(entry.result) === "fail" || text(entry.result) === "unchecked")
    .map((entry) => `${text(entry.checklistId) || "unknown"}:${text(entry.reason || entry.actualResult) || text(entry.result)}`);

  return {
    schemaVersion: 1,
    jobId,
    project,
    changedFiles,
    changedFileCount: changedFiles.length,
    checklistItems: items.map((item) => ({
      id: text(item.id),
      requirement: text(item.requirement),
      verificationMethod: text(item.verificationMethod),
      evidenceClass: text(item.evidenceClass || item.requiredEvidenceClass) || null,
      evidenceOrigin: text(item.evidenceOrigin || item.requiredEvidenceOrigin) || null,
      required: item.required === true,
    })),
    realActors: uniqueStrings(items.flatMap((item) => fieldStrings(item, ["realActors", "actors"]))),
    realEntrypoints: uniqueStrings(items.flatMap((item) => fieldStrings(item, ["realEntrypoints", "entrypoints", "entryPoints"]))),
    bypassCandidates: uniqueStrings(items.flatMap((item) => fieldStrings(item, ["bypassCandidates", "bypasses"]))),
    evidenceClasses: uniqueStrings(evidence.map((entry) => entry.evidenceClass)),
    evidenceOrigins: uniqueStrings(evidence.map((entry) => entry.evidenceOrigin || entry.origin)),
    verificationMethods: uniqueStrings([
      ...items.map((item) => item.verificationMethod),
      ...evidence.map((entry) => entry.verificationMethod),
    ]),
    commands: uniqueStrings(evidence.map((entry) => entry.command)),
    evidenceCounts: {
      total: evidence.length,
      passed: evidence.filter((entry) => text(entry.result) === "pass").length,
      failed: evidence.filter((entry) => text(entry.result) === "fail").length,
    },
    candidateValidation,
    scopeAmendment: Object.keys(scopeAmendment).length > 0 ? scopeAmendment : null,
    residualRisk: {
      riskLevel: text(riskMap?.riskLevel) || null,
      adversarialRequired: riskMap?.adversarialRequired === true,
      assumptions,
      failedOrUncheckedChecklist: failedOrUnchecked,
      notes: uniqueStrings([
        ...phaseResidualRisks(phaseResults),
        ...fieldStrings(riskMap || {}, ["residualRisk", "residualRisks", "risks"]),
      ]),
    },
  };
}

async function reportProgress(
  onProgress: CompletionSuccessInput["onProgress"],
  event: LooseRecord,
  now: () => string,
) {
  if (typeof onProgress !== "function") return;
  try {
    await onProgress({ ts: now(), ...event });
  } catch {
    // Progress reporting must not change job execution outcome.
  }
}

export async function handleCompletionSuccess({
  cpbRoot,
  project,
  jobId,
  phaseResults,
  completionReport = null,
  completeJob,
  onProgress = null,
  now = () => new Date().toISOString(),
}: CompletionSuccessInput): Promise<CompletedJobResult> {
  const reportFields = completionReport ? { completionReport } : {};
  await reportProgress(onProgress, { type: "completion_gate_passed", jobId, project, ...reportFields }, now);
  await completeJob(cpbRoot, project, jobId);
  await reportProgress(onProgress, { type: "job_completed", jobId, project, ...reportFields }, now);

  const result: CompletedJobResult = {
    status: "completed",
    jobId,
    exitCode: 0,
    failure: null,
    phaseResults,
  };
  if (completionReport) result.completionReport = completionReport;
  return result;
}
