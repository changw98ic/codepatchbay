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
