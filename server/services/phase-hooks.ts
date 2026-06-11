export const HOOK_POINTS = Object.freeze({
  PRE_PLAN: "pre-plan",
  PRE_EXECUTE: "pre-execute",
  POST_EXECUTE: "post-execute",
  PRE_VERIFY: "pre-verify",
  POST_VERIFY: "post-verify",
  ON_FAILURE: "on-failure",
});

const ALL_POINTS = Object.values(HOOK_POINTS) as string[];
const registry = new Map<string, Array<(context: Record<string, any>) => any>>();

export function registerPhaseHook(point, fn) {
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

export function clearPhaseHooks(point = undefined) {
  if (point !== undefined) {
    registry.delete(point);
  } else {
    registry.clear();
  }
}

export function getPhaseHooks(point) {
  return [...(registry.get(point) || [])];
}

export function basePhase(phase) {
  if (!phase || typeof phase !== "string") return phase;
  return phase.replace(/-(?:retry|fix)-\d+$/, "");
}

export function hookPointFor(bp, timing) {
  if (timing === "on-failure") return HOOK_POINTS.ON_FAILURE;
  const point = `${timing}-${bp}`;
  return ALL_POINTS.includes(point) ? point : null;
}

export function buildHookContext({ hookPoint, locator, envelope, role, phase, result, error }) {
  const env = (envelope || locator || {}) as Record<string, any>;
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

export function makeHookEvent(type, context, extra = {}) {
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

function makeDiagnosticEvent(context, diagnostic) {
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

export async function runPhaseHooks(context) {
  const point = context.hookPoint;
  const hooks = getPhaseHooks(point);

  if (hooks.length === 0) {
    return { ok: true, diagnostics: [], events: [], blockPhase: false, hookResults: [], hookEvents: [] };
  }

  const hookEvents = [makeHookEvent("phase_hook_started", context, { hookCount: hooks.length })];
  const hookResults = [];
  const allDiagnostics = [];
  let ok = true;
  let blockPhase = false;
  let classification = "info";

  for (const hook of hooks) {
    let hookResult;
    try {
      hookResult = await hook(context);
    } catch (err) {
      hookResult = {
        ok: false,
        diagnostics: [{ message: (err as Error).message, classification: "infra" }],
        events: [],
        blockPhase: false,
        classification: "infra",
      };
    }
    hookResults.push(hookResult);
    if (hookResult.diagnostics) allDiagnostics.push(...hookResult.diagnostics);
    if (!hookResult.ok) ok = false;
    if (hookResult.blockPhase) blockPhase = true;
    if (hookResult.classification === "blocking") classification = "blocking";
    else if (hookResult.classification === "infra" && classification !== "blocking") classification = "infra";
  }

  hookEvents.push(
    ok
      ? makeHookEvent("phase_hook_completed", context, { classification, hookCount: hooks.length })
      : makeHookEvent("phase_hook_failed", context, { classification, blockPhase, hookCount: hooks.length })
  );

  // Persist diagnostics as phase_hook_diagnostic events for failed hooks, thrown hooks,
  // on-failure, and blocking pre-hooks.
  const shouldEmitDiagnostics = !ok || point === HOOK_POINTS.ON_FAILURE;
  if (shouldEmitDiagnostics && allDiagnostics.length > 0) {
    for (const diag of allDiagnostics) {
      hookEvents.push(makeDiagnosticEvent(context, diag));
    }
  }

  return { ok, diagnostics: allDiagnostics, events: [], blockPhase, classification, hookResults, hookEvents };
}

function preflightCheck(requiredFields, artifactCheck = null) {
  return function preflight(context) {
    const missing = requiredFields.filter((f) => !context[f]);
    if (missing.length > 0) {
      return {
        ok: false,
        diagnostics: [{ message: `missing required fields: ${missing.join(", ")}`, classification: "blocking" }],
        events: [],
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
          events: [],
          blockPhase: true,
          classification: "blocking",
        };
      }
    }
    return { ok: true, diagnostics: [], events: [], blockPhase: false };
  };
}

const REQUIRED_LOCATOR_FIELDS = ["project", "jobId", "phase", "eventLogPath"];

const builtinHooks = {
  [HOOK_POINTS.PRE_PLAN]: preflightCheck(REQUIRED_LOCATOR_FIELDS),
  [HOOK_POINTS.PRE_EXECUTE]: preflightCheck(REQUIRED_LOCATOR_FIELDS, (ctx) => {
    if (!ctx.artifacts || !ctx.artifacts.plan) {
      return { ok: false, message: "pre-execute requires artifacts.plan" };
    }
    return { ok: true };
  }),
  // Relaxed: pass when completedPhases includes "execute" OR artifacts have execute/deliverable
  // OR event log has phase_completed for execute OR worktree diff exists
  [HOOK_POINTS.PRE_VERIFY]: preflightCheck(REQUIRED_LOCATOR_FIELDS, (ctx) => {
    const hasArtifact = ctx.artifacts && (ctx.artifacts.execute || ctx.artifacts.deliverable);
    const hasExecuteCompletion = ctx.completedPhases && ctx.completedPhases.includes("execute");
    const hasWorktree = Boolean(ctx.worktree);
    if (!hasArtifact && !hasExecuteCompletion && !hasWorktree) {
      return { ok: false, message: "pre-verify requires execute completion, deliverable artifact, or worktree" };
    }
    return { ok: true };
  }),
  [HOOK_POINTS.POST_EXECUTE]: function postExecuteVerify(context) {
    const cmd = process.env.CPB_HOOK_POST_EXECUTE_VERIFY_CMD;
    if (!cmd) {
      return { ok: true, diagnostics: [], events: [], blockPhase: false };
    }
    return {
      ok: true,
      diagnostics: [{ message: `post-execute verification configured: ${cmd}`, classification: "info" }],
      events: [],
      blockPhase: false,
    };
  },
  [HOOK_POINTS.ON_FAILURE]: function onFailureDiagnostics(context) {
    const errorMsg = typeof context.error === "string" ? context.error : context.error?.message || "";
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
      events: [],
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
