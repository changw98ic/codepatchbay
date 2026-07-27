import type { LooseRecord } from "../../shared/types.js";
import { isRecord, recordValue } from "./checklist-shared.js";

const VALID_STATUSES = new Set(["pass", "fail", "inconclusive", "infra_error"]);

export function validateVerdictEnvelope(envelope: LooseRecord) {
  if (!envelope || typeof envelope !== "object") {
    return { valid: false, error: "envelope must be an object" };
  }

  if (envelope.schemaVersion !== 2) {
    return { valid: false, error: "schemaVersion must be 2" };
  }

  if (!VALID_STATUSES.has(envelope.status)) {
    return { valid: false, error: `status must be one of: ${[...VALID_STATUSES].join(", ")}, got: ${envelope.status}` };
  }

  // Structured v2: layers + blocking fields are accepted
  if (envelope.layers !== undefined) {
    if (typeof envelope.layers !== "object" || envelope.layers === null || Array.isArray(envelope.layers)) {
      return { valid: false, error: "layers must be an object" };
    }
  }
  if (envelope.blocking !== undefined) {
    if (!Array.isArray(envelope.blocking)) {
      return { valid: false, error: "blocking must be an array" };
    }
  }
  if (envelope.fix_scope !== undefined) {
    if (!Array.isArray(envelope.fix_scope)) {
      return { valid: false, error: "fix_scope must be an array" };
    }
  }

  if (typeof envelope.reason !== "string") {
    return { valid: false, error: "reason must be a string" };
  }

  if (envelope.summary !== undefined && typeof envelope.summary !== "string") {
    return { valid: false, error: "summary must be a string" };
  }

  return { valid: true };
}

export function classifyVerdict(verdict: string) {
  const v = String(verdict).toLowerCase().trim();
  if (v === "pass") return "pass";
  if (v === "fail" || v === "partial") return "fail";
  if (v === "inconclusive" || v === "unknown") return "inconclusive";
  if (v === "infra_error") return "infra_error";
  return "inconclusive";
}

function oneLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value: unknown, max = 240): string {
  const text = oneLine(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function uniqueNonEmpty(values: unknown[]): string[] {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const clean = oneLine(value);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function summarizeBlockingEntry(entry: unknown): string {
  if (typeof entry === "string") return truncate(entry);
  if (!isRecord(entry)) return truncate(entry);

  const rec = entry;
  const criterion = oneLine(rec.criterion || rec.input || rec.check || rec.title);
  const file = oneLine(rec.file || rec.path);
  const evidence = oneLine(rec.evidence || rec.detail || rec.reason);
  const fixHint = oneLine(rec.fix_hint || rec.fixHint || rec.hint);

  const parts = [];
  if (criterion) parts.push(criterion);
  if (file) parts.push(`file: ${file}`);
  if (evidence) parts.push(`evidence: ${evidence}`);
  if (fixHint) parts.push(`fix: ${fixHint}`);
  return truncate(parts.join(" | "));
}

function failedLayerChecks(envelope: LooseRecord) {
  const layers = envelope?.layers;
  if (!isRecord(layers)) return [];
  return Object.entries(layers)
    .filter(([, layer]) => String(isRecord(layer) ? layer.status : "").toLowerCase() === "fail")
    .map(([name, layer]) => truncate(`${name}: ${isRecord(layer) ? layer.detail : "failed"}`));
}

function retryScopeFromEnvelope(envelope: LooseRecord) {
  const explicit = Array.isArray(envelope?.fix_scope) ? envelope.fix_scope : [];
  const blockingFiles = Array.isArray(envelope?.blocking)
    ? envelope.blocking.map((entry) => {
        const record = recordValue(entry);
        return record.file || record.path || "";
      })
    : [];
  return uniqueNonEmpty([...explicit, ...blockingFiles]);
}

export function normalizeRetryReason(verdictContent: string, {
  retryCount = 1,
  previousVerdictId = null,
  previousVerdictPath = null,
  maxItems = 5,
}: LooseRecord = {}) {
  const envelope = parseVerdictEnvelope(verdictContent);
  return buildRetryInputFromVerdict(envelope, {
    retryCount,
    previousVerdictId,
    previousVerdictPath,
    maxItems,
  });
}

export function buildRetryInputFromVerdict(envelope: LooseRecord, {
  retryCount = 1,
  previousVerdictId = null,
  previousVerdictPath = null,
  maxItems = 5,
}: LooseRecord = {}) {
  const maxRetryItems = numberOption(maxItems, 5);
  const status = classifyVerdict(envelope?.status || "inconclusive");
  const base: LooseRecord = {
    shouldRetry: false,
    status,
    retryCount,
    previousVerdictId,
    previousVerdictPath,
    reason: oneLine(envelope?.reason),
    failingChecks: [],
    retryScope: [],
    prompt: "",
  };

  if (status !== "fail") return base;

  const blockingChecks = Array.isArray(envelope?.blocking)
    ? envelope.blocking.map(summarizeBlockingEntry)
    : [];
  const structuredChecks = uniqueNonEmpty([
    ...blockingChecks,
    ...failedLayerChecks(envelope),
  ]);
  const failingChecks = (structuredChecks.length ? structuredChecks : uniqueNonEmpty([envelope?.reason])).slice(0, maxRetryItems);

  const retryScope = retryScopeFromEnvelope(envelope).slice(0, maxRetryItems);
  const reason = oneLine(envelope?.reason) || "verifier rejected the previous deliverable";
  const verdictLabel = previousVerdictId || "previous verifier verdict";
  const lines = [
    `Retry ${retryCount}: ${verdictLabel} failed verification.`,
    previousVerdictPath ? `Verdict file: ${previousVerdictPath}` : "",
    `Reason: ${reason}`,
    "",
    "Failing checks:",
    ...(failingChecks.length ? failingChecks.map((check) => `- ${check}`) : ["- Verifier reported a failure without structured blocking details."]),
    "",
    "Expected retry scope:",
    ...(retryScope.length ? retryScope.map((scope) => `- ${scope}`) : ["- Keep changes limited to the failing behavior and directly related tests."]),
    "",
    "Retry only the failing checks above unless local evidence proves a smaller adjacent change is required.",
  ].filter((line) => line !== "");

  return {
    ...base,
    shouldRetry: true,
    reason,
    failingChecks,
    retryScope,
    prompt: lines.join("\n"),
  };
}

export function parseVerdictEnvelope(content: string) {
  if (typeof content !== "string" || !content.trim()) {
    return {
      status: "inconclusive",
      reason: "verdict artifact is empty; canonical JSON envelope required",
      source: "invalid",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      status: "inconclusive",
      reason: `verdict artifact is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
      source: "invalid",
    };
  }

  const envelope = recordValue(parsed);
  const validation = validateVerdictEnvelope(envelope);
  if (!validation.valid) {
    return {
      ...envelope,
      status: "inconclusive",
      reason: `invalid verdict envelope: ${validation.error}`,
      source: "invalid",
    };
  }
  return { ...envelope, source: "json" };
}

export function formatVerdictEnvelope(envelope: LooseRecord) {
  const validation = validateVerdictEnvelope(envelope);
  if (!validation.valid) {
    throw new Error(`invalid verdict envelope: ${validation.error}`);
  }
  return JSON.stringify(envelope, null, 2);
}
