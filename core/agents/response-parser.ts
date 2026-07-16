export function parseAgentJson(output: string) {
  if (!output || typeof output !== "string") {
    return { ok: false, reason: "agent output is empty" };
  }

  let structuredFailureReason = "";

  // Prefer the final fenced JSON block. Agents often include earlier command
  // output or scratch JSON before the final CPB envelope.
  for (const candidate of markdownCodeBlockCandidates(output).reverse()) {
    const result = tryParseJsonObject(candidate);
    if (result.ok) return result;
    if (isStructuredJsonFailure(result.reason)) structuredFailureReason = result.reason;
  }

  const trimmedResult = tryParseJsonObject(output.trim());
  if (trimmedResult.ok) return trimmedResult;
  if (isStructuredJsonFailure(trimmedResult.reason)) structuredFailureReason = trimmedResult.reason;

  for (const candidate of jsonObjectCandidates(output).reverse()) {
    const result = tryParseJsonObject(candidate);
    if (result.ok) return result;
    if (isStructuredJsonFailure(result.reason)) structuredFailureReason = result.reason;
  }

  if (structuredFailureReason) return { ok: false, reason: structuredFailureReason };
  return { ok: false, reason: `agent output is not valid JSON: unexpected format` };
}

function markdownCodeBlockCandidates(output: string) {
  const candidates: string[] = [];
  const pattern = /```(?:[A-Za-z0-9_-]+)?[^\n]*\n?([\s\S]*?)\n?```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    candidates.push(match[1].trim());
  }
  return candidates;
}

function jsonObjectCandidates(output: string) {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < output.length; index += 1) {
    const ch = output[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(output.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

const AGENT_SUCCESS_STATUSES = new Set(["ok"]);
const EXECUTOR_SUCCESS_STATUSES = new Set(["ok", "resolved", "success", "completed", "done"]);

function isStructuredJsonFailure(reason: unknown) {
  return typeof reason === "string" && reason !== "parse failed";
}

function tryParseJsonObject(str: string) {
  return tryParseJsonObjectWithStatuses(str, AGENT_SUCCESS_STATUSES);
}

function tryParseJsonObjectWithStatuses(str: string, successStatuses: Set<string>) {
  try {
    const parsed = JSON.parse(str);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, reason: "agent output is not a JSON object" };
    }
    const status = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
    if (!successStatuses.has(status)) {
      return {
        ok: false,
        reason: parsed.reason || parsed.error || (status
          ? `agent reported non-success status: ${parsed.status}`
          : "agent response missing status field"),
      };
    }
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, reason: "parse failed" };
  }
}

export function parsePlannerJson(output: string) {
  const result = parseAgentJson(output);
  if (!result.ok) return result;
  if (!result.data.planMarkdown) {
    return { ok: false, reason: "planner response missing planMarkdown field" };
  }
  return { ok: true, planMarkdown: result.data.planMarkdown };
}

export function parseExecutorJson(output: string) {
  const result = parseAgentJson(output);
  const data = result.ok ? result.data : parseExecutorJsonObject(output);
  if (!data) return result;
  return {
    ok: true,
    summary: data.summary || data.message || "",
    tests: normalizeExecutorTests(data),
    risks: Array.isArray(data.risks) ? data.risks : [],
    checklistMapping: Array.isArray(data.checklistMapping) ? data.checklistMapping : [],
  };
}

function parseExecutorJsonObject(output: string) {
  if (!output || typeof output !== "string") return null;
  const candidates = [
    ...markdownCodeBlockCandidates(output).reverse(),
    output.trim(),
    ...jsonObjectCandidates(output).reverse(),
  ];
  for (const candidate of candidates) {
    const result = tryParseJsonObjectWithStatuses(candidate, EXECUTOR_SUCCESS_STATUSES);
    if (result.ok) return result.data;
  }
  return null;
}

function normalizeExecutorTests(data: Record<string, unknown>) {
  if (Array.isArray(data.tests)) return data.tests;
  const verification = data.verification;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) return [];
  const tests: string[] = [];
  for (const [key, value] of Object.entries(verification)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) tests.push(`${key}: ${String(item)}`);
  }
  return tests;
}

export function parseVerifierJson(output: string) {
  const result = parseAgentJson(output);
  const data = result.ok ? result.data : parseVerifierJsonObject(output);
  if (!data) return result;
  // Verifier envelope: { status: "ok", verdict: "pass"|"fail"|"partial", reason, details }
  const verdict = data.verdict || data.status;
  if (!verdict || !["pass", "fail", "partial"].includes(verdict)) {
    return { ok: false, reason: `invalid verdict: expected pass|fail|partial, got "${verdict}"` };
  }
  const details = data.details;
  const nestedChecklistVerdict = details
    && typeof details === "object"
    && !Array.isArray(details)
    ? (details as Record<string, unknown>).checklistVerdict
    : null;
  return {
    ...data,
    ok: true,
    status: verdict,
    reason: data.reason || "",
    details: details || "",
    confidence: data.confidence,
    // The protocol requires a top-level checklistVerdict. Recover the fully
    // structured nested form defensively because otherwise a semantically
    // complete verifier result is misclassified as a transport/schema error.
    // Downstream checklist validation remains fail-closed.
    checklistVerdict: data.checklistVerdict || nestedChecklistVerdict || null,
  };
}

function parseVerifierJsonObject(output: string) {
  if (!output || typeof output !== "string") return null;
  const candidates = [
    ...markdownCodeBlockCandidates(output).reverse(),
    output.trim(),
    ...jsonObjectCandidates(output).reverse(),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object") continue;
      const verdict = parsed.verdict || parsed.status;
      if (["pass", "fail", "partial"].includes(verdict)) return parsed;
    } catch {
      // keep scanning later candidates
    }
  }
  return null;
}
