import path from "node:path";
import { readFile } from "node:fs/promises";

export const ROUTING_FEEDBACK_EXIT_CODE = 42;
export const DISPATCH_FEEDBACK_SCHEMA_VERSION = 1;

const WORKFLOWS = new Set(["standard", "complex", "sdd-standard"]);
const PLAN_MODES = new Set(["light", "full", "parent"]);

export function dispatchFeedbackPath(cpbRoot, project, jobId) {
  return path.join(
    path.resolve(cpbRoot),
    "wiki",
    "projects",
    project,
    "outputs",
    `dispatch-feedback-${jobId}.json`,
  );
}

export function normalizeDispatchFeedback(input: Record<string, any> = {}, defaults: Record<string, any> = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("dispatch feedback must be an object");
  }
  const requested: Record<string, any> = input.requested && typeof input.requested === "object" ? input.requested : {};
  const workflow = String(requested.workflow || input.workflow || "").trim();
  const planMode = String(requested.planMode || input.planMode || "").trim();
  const reason = String(input.reason || requested.reason || "").trim();

  if (!WORKFLOWS.has(workflow)) {
    throw new Error(`dispatch feedback can only request stronger workflows: ${workflow || "missing"}`);
  }
  if (!PLAN_MODES.has(planMode)) {
    throw new Error(`dispatch feedback can only request stronger plan modes: ${planMode || "missing"}`);
  }
  if (!reason) {
    throw new Error("dispatch feedback reason is required");
  }

  return {
    schemaVersion: input.schemaVersion || DISPATCH_FEEDBACK_SCHEMA_VERSION,
    jobId: input.jobId || defaults.jobId || null,
    project: input.project || defaults.project || null,
    phase: input.phase || defaults.phase || "execute",
    requested: {
      workflow,
      planMode,
      reviewer: Boolean(requested.reviewer || input.reviewer || workflow === "complex"),
    },
    reason,
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : null,
    signals: Array.isArray(input.signals) ? input.signals.map(String).filter(Boolean) : [],
  };
}

export async function readDispatchFeedbackFile(cpbRoot, project, jobId, { phase = "execute" } = {}) {
  const file = dispatchFeedbackPath(cpbRoot, project, jobId);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return {
    path: file,
    feedback: normalizeDispatchFeedback(JSON.parse(raw), { jobId, project, phase }),
  };
}

export function buildRoutingFeedbackEvent(feedback, { jobId, project, phase, upgradedQueueEntryId = null }: Record<string, any> = {}) {
  feedback = feedback as Record<string, any>;
  return {
    type: "executor_routing_feedback",
    jobId,
    project,
    phase: phase || feedback.phase || "execute",
    requested: feedback.requested,
    reason: feedback.reason,
    confidence: feedback.confidence,
    signals: feedback.signals,
    upgradedQueueEntryId,
  };
}
