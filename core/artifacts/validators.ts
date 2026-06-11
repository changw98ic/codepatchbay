// @ts-nocheck
export function validatePlanMarkdown(content) {
  if (!content || typeof content !== "string") {
    return { ok: false, reason: "plan content is empty or not a string" };
  }
  if (content.trim().length < 50) {
    return { ok: false, reason: "plan content is too short (< 50 chars)" };
  }
  return { ok: true };
}

export function validateDeliverable(content, ctx) {
  if (!content || typeof content !== "string") {
    return { ok: false, reason: "deliverable content is empty", kind: "artifact_invalid" };
  }
  if (content.trim().length < 20) {
    return { ok: false, reason: "deliverable content is too short", kind: "artifact_invalid" };
  }
  const sourceFileReference = /\b[\w./-]+\.(?:c|cc|cpp|cxx|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rb|rs|scss|sh|sql|swift|toml|ts|tsx|txt|yaml|yml)\b/;
  const noChangeDirectDeliverable = ctx?.workflow === "direct"
    && (ctx?.planMode === "light" || ctx?.planMode === "none")
    && Array.isArray(ctx?.changedFiles)
    && ctx.changedFiles.length === 0
    && /\bNo file changes detected\b/.test(content);
  if (!sourceFileReference.test(content) && !noChangeDirectDeliverable) {
    return {
      ok: false,
      reason: "deliverable content must reference at least one changed source file",
      kind: "artifact_invalid",
    };
  }
  return { ok: true };
}

export function validateVerdict(verdict) {
  if (!verdict || typeof verdict !== "object") {
    return { ok: false, reason: "verdict is not an object" };
  }
  if (!["pass", "fail", "partial"].includes(verdict.status)) {
    return { ok: false, reason: `invalid verdict status: ${verdict.status}` };
  }
  return { ok: true };
}
