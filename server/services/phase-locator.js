import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { runtimeDataPath, runtimeDataRoot } from "./runtime-root.js";
import { getJob } from "./job-store.js";
import { getWorkflow } from "./workflow-definition.js";

function validateName(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

export function wikiProjectDir(cpbRoot, project) {
  return path.resolve(cpbRoot, "wiki", "projects", project);
}

export function inboxDir(cpbRoot, project) {
  return path.join(wikiProjectDir(cpbRoot, project), "inbox");
}

export function outputsDir(cpbRoot, project) {
  return path.join(wikiProjectDir(cpbRoot, project), "outputs");
}

export function projectMetaPath(cpbRoot, project) {
  return path.join(wikiProjectDir(cpbRoot, project), "project.json");
}

export function contextPath(cpbRoot, project) {
  return path.join(wikiProjectDir(cpbRoot, project), "context.md");
}

export function decisionsPath(cpbRoot, project) {
  return path.join(wikiProjectDir(cpbRoot, project), "decisions.md");
}

export function eventLogPath(cpbRoot, project, jobId) {
  return runtimeDataPath(cpbRoot, "events", project, `${jobId}.jsonl`);
}

export async function resolveProjectSourcePath(cpbRoot, project) {
  const metaFile = projectMetaPath(cpbRoot, project);
  try {
    const raw = await readFile(metaFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.sourcePath || null;
  } catch {
    return null;
  }
}

export async function buildLocator(cpbRoot, project, jobId, { phase, executorRoot } = {}) {
  validateName(project, "project");
  if (jobId) validateName(jobId, "jobId");

  const locator = {
    cpbRoot: path.resolve(cpbRoot),
    project,
    jobId: jobId || null,
    phase: phase || null,
    executorRoot: executorRoot ? path.resolve(executorRoot) : path.resolve(cpbRoot),
    stateRoot: runtimeDataRoot(cpbRoot),
    wikiDir: wikiProjectDir(cpbRoot, project),
    inboxDir: inboxDir(cpbRoot, project),
    outputsDir: outputsDir(cpbRoot, project),
  };

  locator.sourcePath = process.env.CPB_PROJECT_PATH_OVERRIDE || await resolveProjectSourcePath(cpbRoot, project);

  if (jobId) {
    locator.eventLogPath = eventLogPath(cpbRoot, project, jobId);
    const job = await getJob(cpbRoot, project, jobId);
    if (job?.jobId) {
      locator.task = job.task;
      locator.workflow = job.workflow;
      locator.artifacts = { ...job.artifacts };
      locator.completedPhases = [...(job.completedPhases || [])];
      locator.jobStatus = job.status;
      locator.worktree = job.worktree || null;
      locator.lineage = job.lineage || null;
      locator.retryCount = job.retryCount ?? 0;
      locator.failurePhase = job.failurePhase ?? null;
      locator.blockedReason = job.blockedReason ?? null;
    }
  }

  return locator;
}

export async function reconstructJobState(cpbRoot, project, jobId) {
  const job = await getJob(cpbRoot, project, jobId);
  if (!job?.jobId) return null;

  return buildLocator(cpbRoot, project, jobId, { phase: job.phase });
}

export function locatorEnvelope(locator) {
  return {
    cpbRoot: locator.cpbRoot,
    project: locator.project,
    jobId: locator.jobId,
    phase: locator.phase,
    executorRoot: locator.executorRoot,
    stateRoot: locator.stateRoot,
    sourcePath: locator.sourcePath,
    wikiDir: locator.wikiDir,
    inboxDir: locator.inboxDir,
    outputsDir: locator.outputsDir,
    eventLogPath: locator.eventLogPath || null,
    task: locator.task || null,
    workflow: locator.workflow || null,
    artifacts: locator.artifacts || {},
    completedPhases: locator.completedPhases || [],
    jobStatus: locator.jobStatus || null,
    worktree: locator.worktree || null,
    lineage: locator.lineage || null,
    retryCount: locator.retryCount ?? 0,
    failurePhase: locator.failurePhase || null,
    blockedReason: locator.blockedReason || null,
  };
}

export async function readProjectContext(cpbRoot, project) {
  const file = contextPath(cpbRoot, project);
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function readProjectDecisions(cpbRoot, project) {
  const file = decisionsPath(cpbRoot, project);
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function projectExists(cpbRoot, project) {
  try {
    const info = await stat(wikiProjectDir(cpbRoot, project));
    return info.isDirectory();
  } catch {
    return false;
  }
}

function resolveArtifactPath(cpbRoot, project, artifact) {
  if (!artifact || typeof artifact !== "string") return null;
  if (path.isAbsolute(artifact)) return artifact;
  const normalized = artifact.endsWith(".md") ? artifact : `${artifact}.md`;
  const directory = normalized.startsWith("plan-")
    ? inboxDir(cpbRoot, project)
    : outputsDir(cpbRoot, project);
  return path.join(directory, normalized);
}

export async function buildPhaseLocator(cpbRoot, project, jobId, phase) {
  const locator = await buildLocator(cpbRoot, project, jobId, { phase });
  if (!locator.jobId) {
    locator.prevPhase = null;
    locator.prevArtifact = null;
    locator.prevArtifactPath = null;
    locator.bridgeScript = null;
    return locator;
  }

  const workflow = getWorkflow(locator.workflow);
  const phaseIdx = workflow.phases.indexOf(phase);
  const prevPhaseArtifact = phaseIdx > 0
    ? locator.artifacts[workflow.phases[phaseIdx - 1]] || null
    : null;

  locator.prevPhase = phaseIdx > 0 ? workflow.phases[phaseIdx - 1] : null;
  locator.prevArtifact = prevPhaseArtifact;
  locator.prevArtifactPath = resolveArtifactPath(cpbRoot, project, prevPhaseArtifact);
  locator.bridgeScript = workflow.bridgeForPhase[phase] || null;

  return locator;
}
