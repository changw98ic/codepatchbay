import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { buildLocator, locatorEnvelope, projectExists } from "./phase-locator.js";
import { getJob } from "./job-store.js";
import { getWorkflow, bridgeForPhase as workflowBridgeForPhase } from "./workflow-definition.js";
import { checkPermission } from "./permission-matrix.js";

export function roleForBridge(scriptPath) {
  const base = path.basename(scriptPath);
  if (base.includes("codex-plan")) return "codex-plan";
  if (base.includes("claude-execute") || base.includes("claude-repair")) return "claude-execute";
  if (base.includes("codex-verify")) return "codex-verify";
  if (base.includes("reviewer-review")) return "reviewer-review";
  return null;
}

export function phaseRole(phase) {
  switch (phase) {
    case "plan": return "codex-plan";
    case "execute": return "claude-execute";
    case "verify": return "codex-verify";
    case "review": return "reviewer-review";
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

export async function dispatchPhase(cpbRoot, { project, jobId, phase, script, scriptArgs, executorRoot, env } = {}) {
  const validation = await validatePhaseInputs(cpbRoot, project, jobId, phase);
  if (!validation.valid) {
    return { exitCode: 1, error: new Error(validation.errors.join("; ")), envelope: null };
  }

  const locator = await buildLocator(cpbRoot, project, jobId, { phase, executorRoot });
  const envelope = locatorEnvelope(locator);

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
    "--",
    ...(scriptArgs || []),
  ];

  const result = await runChild("node", runnerArgs, cpbRoot, { env: env || process.env });

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
