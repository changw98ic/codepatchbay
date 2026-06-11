// @ts-nocheck
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { runtimeDataPath, runtimeDataRoot } from "./runtime-root.js";
import { resolveProjectDataRoot } from "./runtime-context.js";
import { getJob } from "./job-store.js";
import { getWorkflow } from "../../core/workflow/definition.js";

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
    const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot: process.env.CPB_HUB_ROOT });
    locator.eventLogPath = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
    locator.processRegistryDir = path.join(dataRoot, "processes");
    locator.stateFilePath = path.join(dataRoot, "state", `pipeline-${project}.json`);
    const job = await getJob(cpbRoot, project, jobId);
    if (job?.jobId) {
      locator.task = job.task;
      locator.workflow = job.workflow;
      locator.artifacts = { ...job.artifacts };
      locator.completedPhases = [...(job.completedPhases || [])];
      locator.jobStatus = job.status;
      locator.worktree = job.worktree || null;
      locator.lineage = job.lineage || null;
      locator.sourceContext = job.sourceContext || null;
      locator.retryCount = job.retryCount ?? 0;
      locator.failurePhase = job.failurePhase ?? null;
      locator.blockedReason = job.blockedReason ?? null;
    }

    // Derive issue metadata from queue or task metadata
    try {
      const { listQueue } = await import("./hub-queue.js");
      const hubRoot = process.env.CPB_HUB_ROOT || cpbRoot;
      const queueEntries = await listQueue(hubRoot, { projectId: project });
      const matching = queueEntries.find((e) => {
        if (e.status !== "pending" && e.status !== "in_progress") return false;
        return e.description === locator.task || e.metadata?.jobId === jobId;
      });
      if (matching?.metadata) {
        locator.issueNumber = matching.metadata.issueNumber || null;
        locator.issueUrl = matching.metadata.issueUrl || null;
        locator.repo = matching.metadata.repo || matching.metadata.repository || null;
      }
    } catch {}

    // Fallback: derive from environment or project metadata
    if (!locator.issueNumber) {
      const meta = await resolveProjectSourcePath(cpbRoot, project);
      locator.issueNumber = process.env.CPB_ISSUE_NUMBER || null;
      locator.issueUrl = process.env.CPB_ISSUE_URL || null;
      locator.repo = process.env.CPB_REPO || null;
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
    processRegistryDir: locator.processRegistryDir || null,
    stateFilePath: locator.stateFilePath || null,
    task: locator.task || null,
    workflow: locator.workflow || null,
    artifacts: locator.artifacts || {},
    completedPhases: locator.completedPhases || [],
    jobStatus: locator.jobStatus || null,
    worktree: locator.worktree || null,
    lineage: locator.lineage || null,
    sourceContext: locator.sourceContext || null,
    retryCount: locator.retryCount ?? 0,
    failurePhase: locator.failurePhase || null,
    blockedReason: locator.blockedReason || null,
    issueNumber: locator.issueNumber || null,
    issueUrl: locator.issueUrl || null,
    repo: locator.repo || null,
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
    if (info.isDirectory()) return true;
  } catch {}
  try {
    const { resolveHubRoot, getProject } = await import("./hub-registry.js");
    const hubRoot = resolveHubRoot(cpbRoot);
    const p = await getProject(hubRoot, project);
    return !!p;
  } catch {}
  return false;
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

  return locator;
}
