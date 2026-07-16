import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pinnedHubRedisConfigFile } from "../../shared/hub-state-redis.js";
import type { LooseRecord } from "../../shared/types.js";
import { buildLocator, locatorEnvelope, projectExists } from "./phase-locator.js";
import { getJob, listJobsFromIndex } from "./job/job-store.js";
import { getWorkflow, bridgeForPhase as workflowBridgeForPhase, roleForPhase as workflowRoleForPhase } from "./workflow-definition.js";
import { checkPermission } from "./permission-matrix.js";
import { resolveProjectDataRoot } from "./runtime.js";
import { BoundedOutput, subprocessOutputMaxBytes } from "../../shared/bounded-output.js";

type RunChildResult = { exitCode: number; stdout: string; outputTruncated?: boolean; error?: Error | null };
type RunChildOptions = {
  env?: NodeJS.ProcessEnv;
  onOutput?: (chunk: string) => void;
};
const PARENT_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function processEnv(value: unknown): NodeJS.ProcessEnv {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as NodeJS.ProcessEnv : process.env;
}

export function roleForBridge(scriptPath: string) {
  const base = path.basename(scriptPath);
  if (base === "planner.sh") return "planner";
  if (base === "executor.sh") return "executor";
  if (base === "repairer.sh") return "repairer";
  if (base === "verifier.sh") return "verifier";
  if (base === "reviewer.sh") return "reviewer";
  return null;
}

export function phaseRole(phase: string) {
  switch (phase) {
    case "plan": return "planner";
    case "execute": return "executor";
    case "verify": return "verifier";
    case "review": return "reviewer";
    case "repair": return "repairer";
    default: return null;
  }
}

export async function validatePhaseInputs(cpbRoot: string, project: string, jobId: string, phase: string) {
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

  let dataRoot = null;
  try {
    dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot: process.env.CPB_HUB_ROOT });
  } catch (err) {
    errors.push(err?.message || `project runtime root required for project: ${project}`);
  }

  const job = dataRoot ? await getJob(cpbRoot, project, jobId, { dataRoot }) : null;
  if (!job?.jobId) {
    errors.push(`job not found: ${jobId}`);
  }

  return { valid: errors.length === 0, errors };
}

export async function checkPhasePermissions(cpbRoot: string, project: string, jobId: string, phase: string, targetPath: string, action: string) {
  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot: process.env.CPB_HUB_ROOT });
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  const workflow = getWorkflow(job?.workflow || "standard");
  const role = workflowRoleForPhase(workflow, phase) || phaseRole(phase);
  if (!role) return { allowed: true };

  const sourcePath = job?.worktree || process.env.CPB_PROJECT_PATH_OVERRIDE || null;

  return checkPermission(role, action, targetPath, cpbRoot, project, { sourcePath, jobId, dataRoot });
}

async function fileExists(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function requireParentPlanDataRoot(dataRoot?: string | null) {
  if (!dataRoot) {
    throw new Error("project runtime root required for parent plan cache");
  }
  return path.resolve(dataRoot);
}

export function parentPlanStoreDir(_cpbRoot: string, project: string, { dataRoot }: { dataRoot?: string | null } = {}) {
  return path.join(requireParentPlanDataRoot(dataRoot), "plan-cache", project);
}

export function parentPlanRecordPath(cpbRoot: string, project: string, planCacheKey: string, opts: { dataRoot?: string | null } = {}) {
  return path.join(parentPlanStoreDir(cpbRoot, project, opts), `${planCacheKey}.json`);
}

async function writeAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

export async function readParentPlanRecord(cpbRoot: string, project: string, planCacheKey?: string | null, opts: { dataRoot?: string | null } = {}) {
  if (!planCacheKey) return null;
  const file = parentPlanRecordPath(cpbRoot, project, planCacheKey, opts);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeParentPlanRecord(cpbRoot: string, project: string, planCacheKey: string, record: LooseRecord, opts: { dataRoot?: string | null } = {}) {
  if (!planCacheKey) throw new Error("planCacheKey is required");
  const file = parentPlanRecordPath(cpbRoot, project, planCacheKey, opts);
  await writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, cachePath: file };
}

function normalizeWords(text: string = "") {
  return text.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
}

function wordOverlap(a: string, b: string) {
  const sa = new Set(normalizeWords(a));
  const sb = new Set(normalizeWords(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const word of sa) if (sb.has(word)) common++;
  return common / Math.min(sa.size, sb.size);
}

async function planFileExists(cpbRoot: string, project: string, planId: string, { dataRoot }: LooseRecord = {}) {
  try {
    if (!dataRoot) throw new Error("project runtime root required for parent plan artifact lookup");
    await access(path.join(path.resolve(dataRoot), "wiki", "inbox", `plan-${planId}.md`));
    return true;
  } catch {
    return false;
  }
}

function stableParentPlanPayload({ project, task, sourceContext = {} }: LooseRecord = {}): LooseRecord {
  const context = recordValue(sourceContext);
  const planGroupId = context.planGroupId || null;
  if (planGroupId) {
    return {
      project,
      planGroupId,
      source: {
        repo: context.repo || null,
        issueNumber: context.issueNumber ?? null,
      },
    };
  }
  return {
    project,
    task: String(task || "").trim().replace(/\s+/g, " "),
    source: {
      repo: context.repo || null,
      issueNumber: context.issueNumber ?? null,
      issueUrl: context.issueUrl || null,
      sourceFingerprint: context.sourceFingerprint || null,
      specHash: context.specHash || null,
      designHash: context.designHash || null,
      tasksHash: context.tasksHash || null,
      taskId: context.taskId || null,
      parentPlanId: context.parentPlanId || null,
    },
  };
}

function explicitParentPlanId(sourceContext: LooseRecord = {}) {
  const value = recordValue(sourceContext).parentPlanId || null;
  return value ? String(value).replace(/^plan-/, "") : null;
}

function hashPayload(payload: LooseRecord) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function planArtifactPath(_cpbRoot: string, _project: string, planArtifact: string, { dataRoot }: LooseRecord = {}) {
  if (!dataRoot) throw new Error("project runtime root required for parent plan artifact path");
  const artifact = String(planArtifact || "").replace(/^plan-/, "");
  return path.join(path.resolve(dataRoot), "wiki", "inbox", `plan-${artifact}.md`);
}

async function artifactExists(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export function parentPlanCacheIdentity({ project, task, sourceContext = {} }: LooseRecord = {}) {
  const payload = stableParentPlanPayload({ project, task, sourceContext });
  const digest = hashPayload(payload);
  return {
    planGroupId: `plan-group-${digest.slice(0, 12)}`,
    planCacheKey: digest.slice(0, 16),
    payload,
  };
}

async function resolvePlanCacheDataRoot(cpbRoot: string, project: string, { dataRoot, hubRoot }: LooseRecord = {}) {
  return await resolveProjectDataRoot(cpbRoot, project, { dataRoot, hubRoot });
}

export async function resolveParentPlanCache(cpbRoot: string, { project, task, sourceContext = {}, dataRoot, hubRoot }: LooseRecord = {}) {
  if (!project) throw new Error("project is required");
  const projectId = stringValue(project);
  const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, projectId, { dataRoot, hubRoot });
  const sourceContextRecord = recordValue(sourceContext);
  const identity = parentPlanCacheIdentity({ project, task, sourceContext: sourceContextRecord });
  const file = parentPlanRecordPath(cpbRoot, projectId, identity.planCacheKey, { dataRoot: resolvedDataRoot });
  const cached = recordValue(await readParentPlanRecord(cpbRoot, projectId, identity.planCacheKey, { dataRoot: resolvedDataRoot }));

  const explicitPlanId = explicitParentPlanId(sourceContextRecord);
  const planId = cached?.parentPlanId || cached?.planId || explicitPlanId || null;
  const planArtifact = cached?.planArtifact || (planId ? `plan-${planId}` : null);
  const artifactPath = planArtifact ? planArtifactPath(cpbRoot, projectId, String(planArtifact), { dataRoot: resolvedDataRoot }) : null;
  const cacheHit = Boolean(planId && artifactPath && await artifactExists(artifactPath));

  return {
    schemaVersion: 1,
    source: "parent_plan_cache",
    project: projectId,
    dataRoot: resolvedDataRoot,
    task,
    ...identity,
    cachePath: file,
    cacheHit,
    parentPlanId: cacheHit ? planId : null,
    reusedPlanId: cacheHit ? planId : null,
    reusedPlanArtifact: cacheHit ? planArtifact : null,
    mergedPlanIds: cacheHit ? [...new Set([String(planId), ...stringArray(cached.mergedPlanIds)])] : [],
    stale: Boolean(cached && !cacheHit),
    cachedAt: cached?.updatedAt || null,
  };
}

export async function writeParentPlanCache(cpbRoot: string, {
  project,
  task,
  sourceContext = {},
  dataRoot,
  hubRoot,
  planGroupId = null,
  planCacheKey = null,
  planId,
  planArtifact = null,
  mergedPlanIds = [],
}: LooseRecord = {}) {
  if (!project) throw new Error("project is required");
  if (!planId) throw new Error("planId is required");
  const projectId = stringValue(project);
  const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, projectId, { dataRoot, hubRoot });
  const identity = planCacheKey && planGroupId
    ? { planGroupId, planCacheKey, payload: stableParentPlanPayload({ project, task, sourceContext }) }
    : parentPlanCacheIdentity({ project, task, sourceContext });
  const artifact = planArtifact || `plan-${planId}`;
  const record = {
    schemaVersion: 1,
    source: "parent_plan_cache",
    project: projectId,
    task,
    planGroupId: identity.planGroupId,
    planCacheKey: identity.planCacheKey,
    parentPlanId: String(planId),
    planId: String(planId),
    planArtifact: artifact,
    planArtifactPath: planArtifactPath(cpbRoot, projectId, String(artifact), { dataRoot: resolvedDataRoot }),
    mergedPlanIds: [...new Set([String(planId), ...stringArray(mergedPlanIds)])],
    payload: identity.payload,
    updatedAt: new Date().toISOString(),
  };
  const stored = await writeParentPlanRecord(cpbRoot, projectId, String(identity.planCacheKey), record, { dataRoot: resolvedDataRoot });
  return {
    ...stored,
    dataRoot: resolvedDataRoot,
    cacheHit: true,
    planCacheKey: record.planCacheKey,
    parentPlanId: record.parentPlanId,
    reusedPlanId: record.planId,
    reusedPlanArtifact: record.planArtifact,
  };
}

function parentPlanHitResult(identity: LooseRecord, { source, planId, artifact, parentJobId = null, cachedAt = null }: LooseRecord) {
  const payload = recordValue(identity.payload);
  return {
    schemaVersion: 2,
    cacheHit: true,
    source,
    project: payload.project,
    task: payload.task,
    ...identity,
    parentPlanId: planId,
    reusedPlanId: planId,
    reusedPlanArtifact: artifact,
    mergedPlanIds: [planId],
    parentJobId,
    stale: false,
    cachedAt,
  };
}

function parentPlanMissResult(identity: LooseRecord, stale = false, cachedAt: string | null = null): LooseRecord {
  const payload = recordValue(identity.payload);
  return {
    schemaVersion: 2,
    cacheHit: false,
    source: null,
    project: payload.project,
    task: payload.task,
    ...identity,
    parentPlanId: null,
    reusedPlanId: null,
    reusedPlanArtifact: null,
    mergedPlanIds: [],
    parentJobId: null,
    stale,
    cachedAt,
  };
}

async function findParentPlanJobIndexHit(cpbRoot: string, project: string, { sourceContext, task, dataRoot }: LooseRecord = {}) {
  const allJobs = await listJobsFromIndex(cpbRoot, { dataRoot });
  const cutoff = Date.now() - PARENT_PLAN_MAX_AGE_MS;
  const context = recordValue(sourceContext);
  const jobs = Array.isArray(allJobs) ? allJobs.map(recordValue) : [];
  const candidates = jobs
    .filter((job) => job.project === project)
    .filter((job) => stringArray(job.completedPhases).includes("plan"))
    .filter((job) => recordValue(job.artifacts).plan)
    .filter((job) => job.status !== "cancelled")
    .filter((job) => {
      const updatedAt = new Date(job.updatedAt || job.createdAt).getTime();
      return !Number.isNaN(updatedAt) && updatedAt >= cutoff;
    })
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

  if (candidates.length === 0) return null;

  const issueNumber = context.issueNumber;
  if (issueNumber) {
    for (const job of candidates) {
      const jobIssue = recordValue(job.sourceContext).issueNumber;
      if (jobIssue && String(jobIssue) === String(issueNumber)) {
        const planId = String(recordValue(job.artifacts).plan).replace(/^plan-/, "");
        if (await planFileExists(cpbRoot, project, planId, { dataRoot })) {
          return { planId, parentJobId: job.jobId, source: "same_issue" };
        }
      }
    }
  }

  for (const job of candidates) {
    const overlap = wordOverlap(String(task || ""), String(job.task || ""));
    if (overlap >= 0.5) {
      const planId = String(recordValue(job.artifacts).plan).replace(/^plan-/, "");
      if (await planFileExists(cpbRoot, project, planId, { dataRoot })) {
        return { planId, parentJobId: job.jobId, source: "task_overlap" };
      }
    }
  }

  return null;
}

export async function resolveParentPlan(cpbRoot: string, { project, task, sourceContext = {}, dataRoot, hubRoot }: LooseRecord = {}) {
  if (!project) throw new Error("project is required");
  const projectId = stringValue(project);
  const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, projectId, { dataRoot, hubRoot });
  const sourceContextRecord = recordValue(sourceContext);
  const identity = parentPlanCacheIdentity({ project, task, sourceContext: sourceContextRecord });

  const explicitPlanId = explicitParentPlanId(sourceContextRecord);
  if (explicitPlanId) {
    const artifact = `plan-${explicitPlanId}`;
    if (await planFileExists(cpbRoot, projectId, explicitPlanId, { dataRoot: resolvedDataRoot })) {
      return parentPlanHitResult(identity, { source: "explicit", planId: explicitPlanId, artifact });
    }
  }

  const cached = recordValue(await readParentPlanRecord(cpbRoot, projectId, identity.planCacheKey, { dataRoot: resolvedDataRoot }));
  const cachedPlanId = cached?.parentPlanId || cached?.planId || null;
  if (cachedPlanId) {
    const artifact = cached?.planArtifact || `plan-${cachedPlanId}`;
    if (await planFileExists(cpbRoot, projectId, String(cachedPlanId), { dataRoot: resolvedDataRoot })) {
      return parentPlanHitResult(identity, {
        source: "cache",
        planId: String(cachedPlanId),
        artifact: String(artifact),
        cachedAt: cached?.updatedAt ? String(cached.updatedAt) : null,
      });
    }
  }

  const indexHit = await findParentPlanJobIndexHit(cpbRoot, projectId, { sourceContext, task, dataRoot: resolvedDataRoot });
  if (indexHit) {
    const artifact = `plan-${indexHit.planId}`;
    return parentPlanHitResult(identity, {
      source: indexHit.source,
      planId: indexHit.planId,
      artifact,
      parentJobId: indexHit.parentJobId,
    });
  }

  return parentPlanMissResult(identity, Boolean(cached), cached?.updatedAt ? String(cached.updatedAt) : null);
}

function runChild(command: string, args: string[], cwd: string, options: RunChildOptions = {}): Promise<RunChildResult> {
  return new Promise((resolve) => {
    let settled = false;
    const stdout = new BoundedOutput(subprocessOutputMaxBytes(process.env.CPB_SUBPROCESS_OUTPUT_MAX_BYTES));

    function finish(result: RunChildResult) {
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
      stdout.append(chunk);
      if (options.onOutput) options.onOutput(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("error", (err) => finish({ exitCode: 1, stdout: stdout.toString(), outputTruncated: stdout.truncated, error: err }));
    child.on("close", (code) => {
      finish({ exitCode: code ?? 1, stdout: stdout.toString(), outputTruncated: stdout.truncated });
    });
  });
}

export async function dispatchPhase(cpbRoot: string, { project, jobId, phase, script, scriptArgs, executorRoot, env }: LooseRecord = {}) {
  const projectId = stringValue(project);
  const job = stringValue(jobId);
  const phaseName = stringValue(phase);
  const scriptPath = stringValue(script);
  const validation = await validatePhaseInputs(cpbRoot, projectId, job, phaseName);
  if (!validation.valid) {
    return { exitCode: 1, error: new Error(validation.errors.join("; ")), envelope: null };
  }

  const locator = await buildLocator(cpbRoot, projectId, job, { phase: phaseName, executorRoot });
  const envelope = locatorEnvelope(locator);

  const resolvedExecutorRoot = executorRoot ? path.resolve(stringValue(executorRoot)) : path.resolve(cpbRoot);
  const bridgeScript = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.join(resolvedExecutorRoot, scriptPath);

  const jobRunner = path.resolve(resolvedExecutorRoot, "bridges", "job-runner.js");
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
    "--project", projectId,
    "--job-id", job,
    "--phase", phaseName,
    "--script", bridgeScript,
    "--",
    ...stringArray(scriptArgs),
  ];

  const runnerEnv = { ...processEnv(env) };
  const hubRoot = runnerEnv.CPB_HUB_ROOT;
  if (hubRoot && !runnerEnv.CPB_HUB_STATE_REDIS_CONFIG_FILE) {
    const pinnedConfig = await pinnedHubRedisConfigFile(hubRoot);
    if (pinnedConfig) runnerEnv.CPB_HUB_STATE_REDIS_CONFIG_FILE = pinnedConfig;
  }
  const result = await runChild("node", runnerArgs, cpbRoot, { env: runnerEnv });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    error: result.error || null,
    envelope,
  };
}

export async function runPhase(cpbRoot: string, options: LooseRecord) {
  return dispatchPhase(cpbRoot, options);
}

export async function runPhaseFromLocator(locator: LooseRecord, script: string, scriptArgs: string[]) {
  const result = await dispatchPhase(stringValue(locator.cpbRoot), {
    project: stringValue(locator.project),
    jobId: stringValue(locator.jobId),
    phase: stringValue(locator.phase),
    script,
    scriptArgs,
    executorRoot: stringValue(locator.executorRoot),
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    error: result.error,
    locator,
  };
}

export function extractArtifactId(stdout: string, prefix: string) {
  const lower = prefix.toLowerCase().replace(/s$/, "");
  const pattern = new RegExp(`^${prefix}: .*${lower}-(\\d+)\\.md$`, "mi");
  const match = stdout.match(pattern);
  if (match) return match[1];

  const genericPattern = new RegExp(`^${prefix}: .*/(?:${lower}|${prefix})-(\\d+)\\.md$`, "mi");
  const genericMatch = stdout.match(genericPattern);
  return genericMatch ? genericMatch[1] : null;
}

export function extractPlanId(stdout: string) {
  return extractArtifactId(stdout, "Plan");
}

export function extractDeliverableId(stdout: string) {
  return extractArtifactId(stdout, "Deliverable");
}
