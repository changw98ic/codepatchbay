import path from "node:path";
import { recordValue, type LooseRecord } from "../../shared/types.js";

import { buildPhaseLocator, locatorEnvelope } from "./phase-locator.js";
import { readEvents, materializeJob } from "./event/event-store.js";

const DEFAULT_MAX_BYTES = 8192;

type PhaseHook = (context: LooseRecord) => unknown;


export const HOOK_POINTS = Object.freeze({
  PRE_PLAN: "pre-plan",
  PRE_EXECUTE: "pre-execute",
  POST_EXECUTE: "post-execute",
  PRE_VERIFY: "pre-verify",
  POST_VERIFY: "post-verify",
  ON_FAILURE: "on-failure",
});

const ALL_POINTS = Object.values(HOOK_POINTS) as string[];
const registry = new Map<string, PhaseHook[]>();

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function registerPhaseHook(point: string, fn: PhaseHook) {
  if (!ALL_POINTS.includes(point)) {
    throw new Error(`unknown hook point: ${point}`);
  }
  if (typeof fn !== "function") {
    throw new Error("hook must be a function");
  }
  const hooks = registry.get(point) || [];
  hooks.push(fn);
  registry.set(point, hooks);
}

export function clearPhaseHooks(point: string | undefined = undefined) {
  if (point !== undefined) {
    registry.delete(point);
  } else {
    registry.clear();
  }
}

export function getPhaseHooks(point: string) {
  return [...(registry.get(point) || [])];
}

export function basePhase(phase: string) {
  if (!phase || typeof phase !== "string") return phase;
  return phase.replace(/-(?:retry|fix)-\d+$/, "");
}

export function hookPointFor(bp: string, timing: string) {
  if (timing === "on-failure") return HOOK_POINTS.ON_FAILURE;
  const point = `${timing}-${bp}`;
  return ALL_POINTS.includes(point) ? point : null;
}

export function buildHookContext({ hookPoint, locator, envelope, role, phase, result, error }: LooseRecord) {
  const env = recordValue(envelope || locator);
  return {
    hookPoint,
    phase: phase || env.phase || null,
    role: role || null,
    timestamp: new Date().toISOString(),
    project: env.project || null,
    jobId: env.jobId || null,
    cpbRoot: env.cpbRoot || null,
    executorRoot: env.executorRoot || null,
    stateRoot: env.stateRoot || null,
    sourcePath: env.sourcePath || null,
    worktree: env.worktree || null,
    wikiDir: env.wikiDir || null,
    inboxDir: env.inboxDir || null,
    outputsDir: env.outputsDir || null,
    eventLogPath: env.eventLogPath || null,
    task: env.task || null,
    workflow: env.workflow || null,
    artifacts: env.artifacts || {},
    completedPhases: env.completedPhases || [],
    jobStatus: env.jobStatus || null,
    lineage: env.lineage || null,
    retryCount: env.retryCount ?? 0,
    failurePhase: env.failurePhase || null,
    blockedReason: env.blockedReason || null,
    result: result || null,
    error: error || null,
  };
}

export function makeHookEvent(type: string, context: LooseRecord, extra: LooseRecord = {}) {
  return {
    type,
    jobId: context.jobId,
    project: context.project,
    phase: context.phase,
    role: context.role,
    hookPoint: context.hookPoint,
    ts: context.timestamp || new Date().toISOString(),
    ...extra,
  };
}

function makeDiagnosticEvent(context: LooseRecord, diagnostic: LooseRecord) {
  return {
    type: "phase_hook_diagnostic",
    jobId: context.jobId,
    project: context.project,
    phase: context.phase,
    role: context.role,
    hookPoint: context.hookPoint,
    classification: diagnostic.classification || "info",
    message: diagnostic.message || "",
    blockPhase: diagnostic.blockPhase || false,
    ts: context.timestamp || new Date().toISOString(),
  };
}

export async function runPhaseHooks(context: LooseRecord) {
  const point = stringValue(context.hookPoint);
  const hooks = getPhaseHooks(point);

  if (hooks.length === 0) {
    return { ok: true, diagnostics: [] as LooseRecord[], events: [] as LooseRecord[], blockPhase: false, hookResults: [] as LooseRecord[], hookEvents: [] as LooseRecord[] };
  }

  const hookEvents = [makeHookEvent("phase_hook_started", context, { hookCount: hooks.length })];
  const hookResults: LooseRecord[] = [];
  const allDiagnostics: LooseRecord[] = [];
  let ok = true;
  let blockPhase = false;
  let classification = "info";

  for (const hook of hooks) {
    let hookResult;
    try {
      hookResult = await hook(context);
    } catch (err) {
      const errorRecord = recordValue(err);
      hookResult = {
        ok: false,
        diagnostics: [{ message: stringValue(errorRecord.message), classification: "infra" }],
        events: [] as LooseRecord[],
        blockPhase: false,
        classification: "infra",
      };
    }
    const result = recordValue(hookResult);
    hookResults.push(result);
    if (Array.isArray(result.diagnostics)) allDiagnostics.push(...result.diagnostics.map(recordValue));
    if (!result.ok) ok = false;
    if (result.blockPhase) blockPhase = true;
    if (result.classification === "blocking") classification = "blocking";
    else if (result.classification === "infra" && classification !== "blocking") classification = "infra";
  }

  hookEvents.push(
    ok
      ? makeHookEvent("phase_hook_completed", context, { classification, hookCount: hooks.length })
      : makeHookEvent("phase_hook_failed", context, { classification, blockPhase, hookCount: hooks.length })
  );

  const shouldEmitDiagnostics = !ok || point === HOOK_POINTS.ON_FAILURE;
  if (shouldEmitDiagnostics && allDiagnostics.length > 0) {
    for (const diag of allDiagnostics) {
      hookEvents.push(makeDiagnosticEvent(context, diag));
    }
  }

  return { ok, diagnostics: allDiagnostics, events: [] as LooseRecord[], blockPhase, classification, hookResults, hookEvents };
}

function preflightCheck(requiredFields: string[], artifactCheck: ((ctx: LooseRecord) => { ok: boolean; message?: string }) | null = null) {
  return function preflight(context: LooseRecord) {
    const missing = requiredFields.filter((f) => !context[f]);
    if (missing.length > 0) {
      return {
        ok: false,
        diagnostics: [{ message: `missing required fields: ${missing.join(", ")}`, classification: "blocking" }],
        events: [] as LooseRecord[],
        blockPhase: true,
        classification: "blocking",
      };
    }
    if (artifactCheck) {
      const r = artifactCheck(context);
      if (!r.ok) {
        return {
          ok: false,
          diagnostics: [{ message: r.message, classification: "blocking" }],
          events: [] as LooseRecord[],
          blockPhase: true,
          classification: "blocking",
        };
      }
    }
    return { ok: true, diagnostics: [] as LooseRecord[], events: [] as LooseRecord[], blockPhase: false };
  };
}

const REQUIRED_LOCATOR_FIELDS = ["project", "jobId", "phase", "eventLogPath"];

const builtinHooks: Record<string, PhaseHook> = {
  [HOOK_POINTS.PRE_PLAN]: preflightCheck(REQUIRED_LOCATOR_FIELDS),
  [HOOK_POINTS.PRE_EXECUTE]: preflightCheck(REQUIRED_LOCATOR_FIELDS, (ctx) => {
    const artifacts = recordValue(ctx.artifacts);
    if (!artifacts.plan) {
      return { ok: false, message: "pre-execute requires artifacts.plan" };
    }
    return { ok: true };
  }),
  [HOOK_POINTS.PRE_VERIFY]: preflightCheck(REQUIRED_LOCATOR_FIELDS, (ctx) => {
    const artifacts = recordValue(ctx.artifacts);
    const hasArtifact = Boolean(artifacts.execute || artifacts.deliverable);
    const hasExecuteCompletion = stringArray(ctx.completedPhases).includes("execute");
    const hasWorktree = Boolean(ctx.worktree);
    if (!hasArtifact && !hasExecuteCompletion && !hasWorktree) {
      return { ok: false, message: "pre-verify requires execute completion, deliverable artifact, or worktree" };
    }
    return { ok: true };
  }),
  [HOOK_POINTS.POST_EXECUTE]: function postExecuteVerify() {
    const cmd = process.env.CPB_HOOK_POST_EXECUTE_VERIFY_CMD;
    if (!cmd) {
      return { ok: true, diagnostics: [] as LooseRecord[], events: [] as LooseRecord[], blockPhase: false };
    }
    return {
      ok: true,
      diagnostics: [{ message: `post-execute verification configured: ${cmd}`, classification: "info" }],
      events: [] as LooseRecord[],
      blockPhase: false,
    };
  },
  [HOOK_POINTS.ON_FAILURE]: function onFailureDiagnostics(context: LooseRecord) {
    const errorRecord = recordValue(context.error);
    const errorMsg = typeof context.error === "string" ? context.error : stringValue(errorRecord.message);
    const isPermissionDenial = /\b(write|execute|read)\s+denied\b/i.test(errorMsg)
      || /\bPERMISSION_FAIL_FAST\b/.test(errorMsg)
      || /\binfra_block\b/.test(errorMsg);

    const failureClassification = isPermissionDenial ? "blocked" : "infra";
    const diagnosticClassification = isPermissionDenial ? "infra_block" : "infra";

    return {
      ok: true,
      diagnostics: [{
        message: `phase ${context.phase} ${failureClassification} for ${context.project}/${context.jobId}`,
        classification: diagnosticClassification,
        phase: context.phase,
        role: context.role,
        error: errorMsg || null,
        paths: {
          eventLogPath: context.eventLogPath,
          wikiDir: context.wikiDir,
          worktree: context.worktree,
        },
      }],
      events: [] as LooseRecord[],
      blockPhase: false,
      classification: failureClassification,
    };
  },
};

let builtinsRegistered = false;

export function registerBuiltinHooks() {
  for (const [point, hook] of Object.entries(builtinHooks)) {
    registerPhaseHook(point, hook);
  }
  builtinsRegistered = true;
}

export function _resetHookRegistration() {
  clearPhaseHooks();
  builtinsRegistered = false;
}

export async function buildPhaseContextPacket(
  cpbRoot: string,
  project: string,
  jobId: string,
  phase: string,
  options: LooseRecord = {},
) {
  const configuredMaxBytes =
    numberValue(options.maxBytes, 0) ||
    (process.env.CPB_PHASE_CONTEXT_MAX_BYTES ? Number(process.env.CPB_PHASE_CONTEXT_MAX_BYTES) || 0 : 0);
  const maxBytes = configuredMaxBytes || DEFAULT_MAX_BYTES;

  const locator = await buildPhaseLocator(cpbRoot, project, jobId, phase, options);
  const locators = locatorEnvelope(locator);
  const events = await readEvents(cpbRoot, project, jobId, {
    dataRoot: stringValue(locator.stateRoot),
    includeLegacyFallback: false,
  });
  const job = materializeJob(events);
  const jobRecord = recordValue(job);
  const jobArtifacts = recordValue(jobRecord.artifacts);
  const budget = { maxBytes, actualBytes: 0, clipped: false };

  const packet: LooseRecord = {
    schemaVersion: 1,
    project,
    jobId,
    phase,
    locators,
    task: jobRecord.task || null,
    workflow: jobRecord.workflow || null,
    artifacts: { ...jobArtifacts },
    completedPhases: stringArray(jobRecord.completedPhases),
    sourceContext: locator.sourcePath || jobRecord.sourceContext || null,
    readInstructions: buildReadInstructions(locator, jobRecord, phase),
    budget,
    indexSummary: null,
    eventTailSummary: null,
  };

  let usedBytes = measureUtf8Bytes(packet);
  if (events.length > 0 && maxBytes > usedBytes) {
    const tail = buildEventTail(events);
    if (measureUtf8Bytes(tail) <= maxBytes - usedBytes) {
      packet.eventTailSummary = tail;
      usedBytes += measureUtf8Bytes(tail);
    }
  }
  budget.actualBytes = usedBytes;
  budget.clipped = usedBytes > maxBytes;
  return packet;
}

function buildReadInstructions(locator: LooseRecord, job: LooseRecord, phase: string) {
  const instructions: string[] = [];
  if (locator.eventLogPath) instructions.push(`Read event log: ${locator.eventLogPath}`);
  if (locator.prevArtifactPath) {
    instructions.push(`Read previous phase artifact (${locator.prevPhase}): ${locator.prevArtifactPath}`);
  }
  if (phase === "plan" && locator.inboxDir) {
    instructions.push(`Check inbox directory for existing plans: ${locator.inboxDir}`);
  }
  const artifacts = recordValue(job.artifacts);
  if (["execute", "review", "verify"].includes(phase) && artifacts.plan) {
    const planPath = resolveArtifactName(locator, artifacts.plan);
    if (planPath) instructions.push(`Read plan artifact: ${planPath}`);
  }
  if (["review", "verify"].includes(phase) && artifacts.execute) {
    const execPath = resolveArtifactName(locator, artifacts.execute);
    if (execPath) instructions.push(`Read execute deliverable: ${execPath}`);
  }
  if (phase === "verify" && artifacts.review) {
    const reviewPath = resolveArtifactName(locator, artifacts.review);
    if (reviewPath) instructions.push(`Read review artifact: ${reviewPath}`);
  }
  if (locator.wikiDir) {
    const wikiDir = stringValue(locator.wikiDir);
    instructions.push(`Read project context (if exists): ${path.join(wikiDir, "context.md")}`);
    instructions.push(`Read project decisions (if exists): ${path.join(wikiDir, "decisions.md")}`);
  }
  if (locator.sourcePath) instructions.push(`Source code root: ${locator.sourcePath}`);
  return instructions;
}

function resolveArtifactName(locator: LooseRecord, artifact: unknown) {
  const artifactName = stringValue(artifact);
  if (!artifactName) return null;
  if (path.isAbsolute(artifactName)) return artifactName;
  const normalized = artifactName.endsWith(".md") ? artifactName : `${artifactName}.md`;
  const dir = normalized.startsWith("plan-") ? stringValue(locator.inboxDir) : stringValue(locator.outputsDir);
  return path.join(dir, normalized);
}

function buildEventTail(events: LooseRecord[]) {
  return events.slice(-10)
    .map((event) => {
      const parts = [event.type];
      if (event.phase) parts.push(`phase=${event.phase}`);
      if (event.artifact) parts.push(`artifact=${event.artifact}`);
      if (event.status) parts.push(`status=${event.status}`);
      return parts.join(" ");
    })
    .join("\n");
}

function measureUtf8Bytes(value: unknown) {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(str, "utf8");
}
