export function parseAgentJson(output) {
  if (!output || typeof output !== "string") {
    return { ok: false, reason: "agent output is empty" };
  }

  // Strategy 1: JSON inside a markdown code block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const result = tryParseJsonObject(codeBlockMatch[1].trim());
    if (result.ok) return result;
  }

  // Strategy 2: entire output is JSON
  const trimmedResult = tryParseJsonObject(output.trim());
  if (trimmedResult.ok) return trimmedResult;

  // Strategy 3: find first { to last } — handles mixed text+JSON output
  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = output.slice(firstBrace, lastBrace + 1);
    const result = tryParseJsonObject(candidate);
    if (result.ok) return result;
  }

  return { ok: false, reason: `agent output is not valid JSON: unexpected format` };
}

function tryParseJsonObject(str) {
  try {
    const parsed = JSON.parse(str);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, reason: "agent output is not a JSON object" };
    }
    if (parsed.status !== "ok") {
      return { ok: false, reason: parsed.reason || parsed.error || "agent reported non-ok status" };
    }
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, reason: "parse failed" };
  }
}

export function parsePlannerJson(output) {
  const result = parseAgentJson(output);
  if (!result.ok) return result;
  if (!result.data.planMarkdown) {
    return { ok: false, reason: "planner response missing planMarkdown field" };
  }
  return { ok: true, planMarkdown: result.data.planMarkdown };
}

export function parseExecutorJson(output) {
  const result = parseAgentJson(output);
  if (!result.ok) return result;
  return {
    ok: true,
    summary: result.data.summary || "",
    tests: result.data.tests || [],
    risks: result.data.risks || [],
  };
}

export function parseVerifierJson(output) {
  const result = parseAgentJson(output);
  if (!result.ok) return result;
  // Verifier envelope: { status: "ok", verdict: "pass"|"fail"|"partial", reason, details }
  const verdict = result.data.verdict;
  if (!verdict || !["pass", "fail", "partial"].includes(verdict)) {
    return { ok: false, reason: `invalid verdict: expected pass|fail|partial, got "${verdict}"` };
  }
  return {
    ok: true,
    status: verdict,
    reason: result.data.reason || "",
    details: result.data.details || "",
    confidence: result.data.confidence,
  };
}
