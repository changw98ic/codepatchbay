const VALID_STATUSES = new Set(["pass", "fail", "inconclusive", "infra_error"]);

const REQUIRED_BASIS_KEYS = [
  "taskGoal", "worktreeDiff", "tests", "buildLogs",
  "events", "runtimeState", "executorSummary",
];

function fullBasis(overrides = {}) {
  const basis = {};
  for (const key of REQUIRED_BASIS_KEYS) {
    basis[key] = overrides[key] ?? "missing";
  }
  return basis;
}

export function validateVerdictEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { valid: false, error: "envelope must be an object" };
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

  // Legacy v1: basis + blockingMissingInputs still accepted
  if (envelope.basis !== undefined) {
    if (typeof envelope.basis !== "object" || envelope.basis === null || Array.isArray(envelope.basis)) {
      return { valid: false, error: "basis must be an object" };
    }
    const missing = REQUIRED_BASIS_KEYS.filter((k) => !(k in envelope.basis));
    if (missing.length > 0) {
      return { valid: false, error: `basis missing required keys: ${missing.join(", ")}` };
    }
  }

  if (envelope.blockingMissingInputs !== undefined && !Array.isArray(envelope.blockingMissingInputs)) {
    return { valid: false, error: "blockingMissingInputs must be an array" };
  }

  if (typeof envelope.reason !== "string") {
    return { valid: false, error: "reason must be a string" };
  }

  if (envelope.summary !== undefined && typeof envelope.summary !== "string") {
    return { valid: false, error: "summary must be a string" };
  }

  return { valid: true };
}

export function classifyVerdict(verdict) {
  const v = String(verdict).toLowerCase().trim();
  if (v === "pass") return "pass";
  if (v === "fail" || v === "partial") return "fail";
  if (v === "inconclusive" || v === "unknown") return "inconclusive";
  if (v === "infra_error") return "infra_error";
  return "inconclusive";
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value, max = 240) {
  const text = oneLine(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function uniqueNonEmpty(values) {
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

function summarizeBlockingEntry(entry) {
  if (typeof entry === "string") return truncate(entry);
  if (!entry || typeof entry !== "object") return truncate(entry);

  const criterion = oneLine(entry.criterion || entry.input || entry.check || entry.title);
  const file = oneLine(entry.file || entry.path);
  const evidence = oneLine(entry.evidence || entry.detail || entry.reason);
  const fixHint = oneLine(entry.fix_hint || entry.fixHint || entry.hint);

  const parts = [];
  if (criterion) parts.push(criterion);
  if (file) parts.push(`file: ${file}`);
  if (evidence) parts.push(`evidence: ${evidence}`);
  if (fixHint) parts.push(`fix: ${fixHint}`);
  return truncate(parts.join(" | "));
}

function failedLayerChecks(envelope) {
  const layers = envelope?.layers;
  if (!layers || typeof layers !== "object" || Array.isArray(layers)) return [];
  return Object.entries(layers)
    .filter(([, layer]) => String((layer as Record<string, any>)?.status || "").toLowerCase() === "fail")
    .map(([name, layer]) => truncate(`${name}: ${(layer as Record<string, any>)?.detail || "failed"}`));
}

function retryScopeFromEnvelope(envelope) {
  const explicit = Array.isArray(envelope?.fix_scope) ? envelope.fix_scope : [];
  const blockingFiles = Array.isArray(envelope?.blocking)
    ? envelope.blocking.map((entry) => typeof entry === "object" && entry ? entry.file || entry.path : "")
    : [];
  return uniqueNonEmpty([...explicit, ...blockingFiles]);
}

export function normalizeRetryReason(verdictContent, {
  retryCount = 1,
  previousVerdictId = null,
  previousVerdictPath = null,
  maxItems = 5,
} = {}) {
  const envelope = parseVerdictEnvelope(verdictContent);
  return buildRetryInputFromVerdict(envelope, {
    retryCount,
    previousVerdictId,
    previousVerdictPath,
    maxItems,
  });
}

export function buildRetryInputFromVerdict(envelope, {
  retryCount = 1,
  previousVerdictId = null,
  previousVerdictPath = null,
  maxItems = 5,
} = {}) {
  const status = classifyVerdict(envelope?.status || "inconclusive");
  const base = {
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
  const missingInputChecks = Array.isArray(envelope?.blockingMissingInputs)
    ? envelope.blockingMissingInputs.map((item) => truncate(`missing input: ${item}`))
    : [];
  const structuredChecks = uniqueNonEmpty([
    ...blockingChecks,
    ...failedLayerChecks(envelope),
    ...missingInputChecks,
  ]);
  const failingChecks = (structuredChecks.length ? structuredChecks : uniqueNonEmpty([envelope?.reason])).slice(0, maxItems);

  const retryScope = retryScopeFromEnvelope(envelope).slice(0, maxItems);
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

// Back-fill v1 basis fields from v2 structured fields for backward compatibility
function backfillLegacy(envelope) {
  if (!envelope.basis) {
    const layers = envelope.layers || {};
    const tests = layers.fast?.detail || layers.changed?.detail || "not run";
    const build = layers.acceptance?.detail || "not run";
    envelope.basis = fullBasis({
      taskGoal: envelope.task_goal || envelope.reason || "",
      worktreeDiff: envelope.diff_summary || "none",
      tests,
      buildLogs: build,
      events: "none",
      runtimeState: "none",
      executorSummary: envelope.executor_summary || "",
    });
  }
  if (!envelope.blockingMissingInputs) {
    envelope.blockingMissingInputs = (envelope.blocking || []).map(b =>
      typeof b === "string" ? b : b.criterion || b.input || String(b)
    );
  }
  return envelope;
}

export function parseVerdictEnvelope(content) {
  if (!content || typeof content !== "string") {
    return {
      status: "inconclusive",
      basis: fullBasis(),
      blockingMissingInputs: ["content"],
      reason: "empty content",
      source: "empty",
    };
  }

  // Try structured JSON envelope with `status` field (fenced code block)
  const jsonBlockMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (parsed && typeof parsed.status === "string") {
        const normalized = backfillLegacy({ ...parsed, status: parsed.status.toLowerCase() });
        const validation = validateVerdictEnvelope(normalized);
        if (validation.valid) {
          return { ...normalized, source: "envelope" };
        }
      }
    } catch {}
  }

  // Try standalone JSON with `status` field near the top.
  // Use balanced-brace extraction to handle nested objects correctly.
  const topLines = content.split(/\r?\n/).slice(0, 200).join("\n");
  const jsonStart = topLines.indexOf("{");
  if (jsonStart >= 0) {
    let depth = 0;
    let jsonEnd = -1;
    for (let i = jsonStart; i < topLines.length; i++) {
      if (topLines[i] === "{") depth++;
      else if (topLines[i] === "}") depth--;
      if (depth === 0) { jsonEnd = i + 1; break; }
    }
    if (jsonEnd > jsonStart) {
      const candidate = topLines.substring(jsonStart, jsonEnd);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed.status === "string") {
          const normalized = backfillLegacy({ ...parsed, status: parsed.status.toLowerCase() });
          const validation = validateVerdictEnvelope(normalized);
          if (validation.valid) {
            return { ...normalized, source: "envelope" };
          }
        }
      } catch {}
    }
  }

  // Legacy text format: VERDICT: PASS|FAIL|PARTIAL
  const lines = content.split(/\r?\n/).slice(0, 5);
  for (const line of lines) {
    const match = line.match(/^VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i);
    if (match) {
      const raw = match[1].toUpperCase();
      const status = raw === "PARTIAL" ? "fail" : raw.toLowerCase();
      return {
        status,
        basis: fullBasis({ taskGoal: "legacy", executorSummary: "legacy" }),
        blockingMissingInputs: [],
        reason: `Legacy verdict: ${raw}`,
        source: "legacy",
      };
    }
  }

  // Bare PASS/FAIL/PARTIAL
  for (const line of lines) {
    const legacy = line.match(/^\s*(PASS|FAIL|PARTIAL)\b/i);
    if (legacy) {
      const raw = legacy[1].toUpperCase();
      const status = raw === "PARTIAL" ? "fail" : raw.toLowerCase();
      return {
        status,
        basis: fullBasis({ taskGoal: "legacy", executorSummary: "legacy" }),
        blockingMissingInputs: [],
        reason: `Legacy bare verdict: ${raw}`,
        source: "legacy",
      };
    }
  }

  // Unrecognizable content
  return {
    status: "inconclusive",
    basis: fullBasis(),
    blockingMissingInputs: ["recognizable verdict"],
    reason: "no recognizable verdict found",
    source: "unknown",
  };
}

export function formatVerdictEnvelope(envelope) {
  const validation = validateVerdictEnvelope(envelope);
  if (!validation.valid) {
    throw new Error(`invalid verdict envelope: ${validation.error}`);
  }
  return JSON.stringify(envelope, null, 2);
}
