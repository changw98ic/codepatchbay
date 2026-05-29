export function parseAgentJson(output) {
  if (!output || typeof output !== "string") {
    return { ok: false, reason: "agent output is empty" };
  }

  // Try to extract JSON from markdown code block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : output.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, reason: "agent output is not a JSON object" };
    }
    if (parsed.status !== "ok") {
      return { ok: false, reason: parsed.reason || parsed.error || "agent reported non-ok status" };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, reason: `agent output is not valid JSON: ${err.message}` };
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
  if (!["pass", "fail", "partial"].includes(result.data.status)) {
    return { ok: false, reason: `invalid verdict status: ${result.data.status}` };
  }
  return {
    ok: true,
    status: result.data.status,
    reason: result.data.reason || "",
    details: result.data.details || "",
  };
}
