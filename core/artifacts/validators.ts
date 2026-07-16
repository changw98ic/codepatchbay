import type { LooseRecord } from "../../shared/types.js";
import { isRecord } from "../workflow/checklist-shared.js";

export function validatePlanMarkdown(content: unknown) {
  if (!content || typeof content !== "string") {
    return { ok: false, reason: "plan content is empty or not a string" };
  }
  if (content.trim().length < 50) {
    return { ok: false, reason: "plan content is too short (< 50 chars)" };
  }
  return { ok: true };
}

export function validateDeliverable(content: unknown, ctx?: LooseRecord) {
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

export function validateVerdict(verdict: unknown) {
  if (!isRecord(verdict)) {
    return { ok: false, reason: "verdict is not an object" };
  }
  const status = verdict.status;
  if (typeof status !== "string" || !["pass", "fail", "partial"].includes(status)) {
    return { ok: false, reason: `invalid verdict status: ${status}` };
  }
  return { ok: true };
}
