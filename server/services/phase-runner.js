import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { buildLocator, locatorEnvelope, projectExists } from "./phase-locator.js";
import { getJob } from "./job-store.js";
import { getWorkflow, bridgeForPhase as workflowBridgeForPhase } from "./workflow-definition.js";
import { checkPermission } from "./permission-matrix.js";
import {
  HOOK_POINTS,
  registerBuiltinHooks,
  clearPhaseHooks,
  buildHookContext,
  runPhaseHooks,
  basePhase,
  hookPointFor,
  _resetHookRegistration,
} from "./phase-hooks.js";
import { appendEvent } from "./event-store.js";

let hooksInitialized = false;

function ensureHooksRegistered() {
  if (!hooksInitialized) {
    registerBuiltinHooks();
    hooksInitialized = true;
  }
}

export { _resetHookRegistration };

// Expose a combined reset that also clears the phase-runner init flag
const _originalReset = _resetHookRegistration;
export function resetHooksForTest() {
  _originalReset();
  hooksInitialized = false;
}

export function roleForBridge(scriptPath) {
  const base = path.basename(scriptPath);
  if (base === "planner.sh") return "planner";
  if (base === "executor.sh") return "executor";
  if (base === "repairer.sh") return "repairer";
  if (base === "verifier.sh") return "verifier";
  if (base === "reviewer.sh") return "reviewer";
  return null;
}

export function phaseRole(phase) {
  switch (phase) {
    case "plan": return "planner";
    case "execute": return "executor";
    case "verify": return "verifier";
    case "review": return "reviewer";
    case "repair": return "repairer";
    default: return null;
  }
}

export async function validatePhaseInputs(cpbRoot, project, jobId, phase) {
  const errors = [];

  if (!project || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(project)) {
    errors.push(`invalid project name: ${project}`);
  }

  if (!jobId || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(jobId)) {
    errors.push(`invalid job ID: ${jobId}`);
  }

  if (!phase || typeof phase !== "string") {
    errors.push(`invalid phase: ${phase}`);
  }

  if (errors.length > 0) return { valid: false, errors };

  const exists = await projectExists(cpbRoot, project);
  if (!exists) {
    errors.push(`project not found: ${project}`);
  }

  const job = await getJob(cpbRoot, project, jobId);
  if (!job?.jobId) {
    errors.push(`job not found: ${jobId}`);
  }

  return { valid: errors.length === 0, errors };
}

export async function checkPhasePermissions(cpbRoot, project, jobId, phase, targetPath, action) {
  const role = phaseRole(phase);
  if (!role) return { allowed: true };

  const job = await getJob(cpbRoot, project, jobId);
  const sourcePath = job?.worktree || process.env.CPB_PROJECT_PATH_OVERRIDE || null;

  return checkPermission(role, action, targetPath, cpbRoot, project, { sourcePath, jobId });
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function runChild(command, args, cwd, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks = [];

    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: options.env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, stdout: "", error: err });
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      if (options.onOutput) options.onOutput(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("error", (err) => finish({ exitCode: 1, stdout: "", error: err }));
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      finish({ exitCode: code ?? 1, stdout });
    });
  });
}

async function persistHookEvents(cpbRoot, project, jobId, hookEvents) {
  for (const event of hookEvents) {
    try {
      await appendEvent(cpbRoot, project, jobId, event);
    } catch { /* best-effort persistence */ }
  }
}

export async function dispatchPhase(cpbRoot, { project, jobId, phase, script, scriptArgs, executorRoot, env, terminalOnFailure = true } = {}) {
  const validation = await validatePhaseInputs(cpbRoot, project, jobId, phase);
  if (!validation.valid) {
    return { exitCode: 1, error: new Error(validation.errors.join("; ")), envelope: null };
  }

  const locator = await buildLocator(cpbRoot, project, jobId, { phase, executorRoot });
  const envelope = locatorEnvelope(locator);

  ensureHooksRegistered();
  const bp = basePhase(phase);
  const role = phaseRole(phase);

  // --- Pre-hook ---
  const prePoint = hookPointFor(bp, "pre");
  if (prePoint) {
    const preCtx = buildHookContext({ hookPoint: prePoint, envelope, role, phase });
    const preResult = await runPhaseHooks(preCtx);
    await persistHookEvents(cpbRoot, project, jobId, preResult.hookEvents);

    if (preResult.blockPhase) {
      const diagMessages = preResult.diagnostics.map((d) => d.message).join("; ");
      return {
        exitCode: 1,
        error: new Error(`pre-hook blocked: ${diagMessages}`),
        envelope,
        hookDiagnostics: preResult.diagnostics,
        hookClassification: preResult.classification,
        hookEvents: preResult.hookEvents,
      };
    }
  }

  const resolvedExecutorRoot = executorRoot ? path.resolve(executorRoot) : path.resolve(cpbRoot);
  const bridgeScript = path.isAbsolute(script)
    ? script
    : path.join(resolvedExecutorRoot, script);

  const jobRunner = path.resolve(resolvedExecutorRoot, "bridges", "job-runner.mjs");
  if (!await fileExists(jobRunner)) {
    return {
      exitCode: 1,
      error: new Error(`job-runner not found: ${jobRunner}`),
      envelope,
    };
  }

  const runnerArgs = [
    jobRunner,
    "--cpb-root", cpbRoot,
    "--project", project,
    "--job-id", jobId,
    "--phase", phase,
    "--script", bridgeScript,
    ...(terminalOnFailure ? [] : ["--non-terminal-failure"]),
    "--",
    ...(scriptArgs || []),
  ];

  const result = await runChild("node", runnerArgs, cpbRoot, { env: env || process.env });

  // --- Post-hook or on-failure ---
  const bridgeOk = result.exitCode === 0;
  const postPoint = bridgeOk ? hookPointFor(bp, "post") : HOOK_POINTS.ON_FAILURE;
  const postCtx = buildHookContext({
    hookPoint: postPoint,
    envelope,
    role,
    phase,
    result: bridgeOk ? result : null,
    error: bridgeOk ? null : (result.error || new Error(`bridge exited ${result.exitCode}`)),
  });
  const postResult = await runPhaseHooks(postCtx);
  await persistHookEvents(cpbRoot, project, jobId, postResult.hookEvents);

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    error: result.error || null,
    envelope,
  };
}

export async function runPhase(cpbRoot, options) {
  return dispatchPhase(cpbRoot, options);
}

export async function runPhaseFromLocator(locator, script, scriptArgs) {
  const result = await dispatchPhase(locator.cpbRoot, {
    project: locator.project,
    jobId: locator.jobId,
    phase: locator.phase,
    script,
    scriptArgs,
    executorRoot: locator.executorRoot,
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    error: result.error,
    locator,
  };
}

export function extractArtifactId(stdout, prefix) {
  const lower = prefix.toLowerCase().replace(/s$/, "");
  const pattern = new RegExp(`^${prefix}: .*${lower}-(\\d+)\\.md$`, "mi");
  const match = stdout.match(pattern);
  if (match) return match[1];

  const genericPattern = new RegExp(`^${prefix}: .*/(?:${lower}|${prefix})-(\\d+)\\.md$`, "mi");
  const genericMatch = stdout.match(genericPattern);
  return genericMatch ? genericMatch[1] : null;
}

export function extractPlanId(stdout) {
  return extractArtifactId(stdout, "Plan");
}

export function extractDeliverableId(stdout) {
  return extractArtifactId(stdout, "Deliverable");
}
