import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { resolveProjectDataRoot } from "./runtime.js";
import { getJob } from "./job/job-store.js";
import { getProject, resolveHubRoot } from "./hub/hub-registry.js";
import { getWorkflow } from "../../core/workflow/definition.js";

type AnyRecord = Record<string, any>;

function validateName(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

export function wikiProjectDir(cpbRoot, project) {
  return path.resolve(cpbRoot, "wiki", "projects", project);
}

function runtimeWikiDir(dataRoot) {
  return path.join(path.resolve(dataRoot), "wiki");
}

const runtimeRootCache = new Map<string, string>();

function runtimeRootCacheKey(cpbRoot, project) {
  return `${path.resolve(cpbRoot)}\u0000${project}`;
}

export function rememberProjectRuntimeRoot(cpbRoot, project, dataRoot) {
  if (!dataRoot) return null;
  const resolved = path.resolve(dataRoot);
  runtimeRootCache.set(runtimeRootCacheKey(cpbRoot, project), resolved);
  return resolved;
}

export function resolveCachedProjectRuntimeRoot(cpbRoot, project) {
  return runtimeRootCache.get(runtimeRootCacheKey(cpbRoot, project)) || null;
}

function runtimeWikiRoot(cpbRoot, project, { dataRoot }: AnyRecord = {}) {
  if (dataRoot) return runtimeWikiDir(dataRoot);
  const cachedRoot = resolveCachedProjectRuntimeRoot(cpbRoot, project);
  if (cachedRoot) return runtimeWikiDir(cachedRoot);
  return wikiProjectDir(cpbRoot, project);
}

export function inboxDir(cpbRoot, project, { dataRoot }: AnyRecord = {}) {
  return path.join(runtimeWikiRoot(cpbRoot, project, { dataRoot }), "inbox");
}

export function outputsDir(cpbRoot, project, { dataRoot }: AnyRecord = {}) {
  return path.join(runtimeWikiRoot(cpbRoot, project, { dataRoot }), "outputs");
}

export function projectMetaPath(cpbRoot, project) {
  return path.join(wikiProjectDir(cpbRoot, project), "project.json");
}

export function contextPath(cpbRoot, project, { dataRoot }: AnyRecord = {}) {
  return path.join(runtimeWikiRoot(cpbRoot, project, { dataRoot }), "context.md");
}

export function decisionsPath(cpbRoot, project, { dataRoot }: AnyRecord = {}) {
  return path.join(runtimeWikiRoot(cpbRoot, project, { dataRoot }), "decisions.md");
}

function requireProjectDataRoot(dataRoot, label = "phase locator") {
  if (!dataRoot || typeof dataRoot !== "string" || !dataRoot.trim()) {
    throw new Error(`dataRoot is required for ${label}`);
  }
  return path.resolve(dataRoot);
}

export function eventLogPath(cpbRoot, project, jobId, { dataRoot }: AnyRecord = {}) {
  return path.join(requireProjectDataRoot(dataRoot, "phase event log path"), "events", project, `${jobId}.jsonl`);
}

async function resolveRegisteredProject(cpbRoot, project, hubRoot = process.env.CPB_HUB_ROOT) {
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  return getProject(resolvedHubRoot, project);
}

export async function resolveProjectSourcePath(cpbRoot, project, { hubRoot, allowLegacyFallback = true }: AnyRecord = {}) {
  if (process.env.CPB_PROJECT_PATH_OVERRIDE) return path.resolve(process.env.CPB_PROJECT_PATH_OVERRIDE);
  try {
    const registered = await resolveRegisteredProject(cpbRoot, project, hubRoot);
    if (registered?.sourcePath) return path.resolve(registered.sourcePath);
  } catch {}
  if (!allowLegacyFallback) return null;
  const metaFile = projectMetaPath(cpbRoot, project);
  try {
    const raw = await readFile(metaFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.sourcePath || null;
  } catch {
    return null;
  }
}

export async function buildLocator(cpbRoot, project, jobId, { phase, executorRoot, hubRoot, dataRoot: explicitDataRoot }: AnyRecord = {}) {
  validateName(project, "project");
  if (jobId) validateName(jobId, "jobId");
  const effectiveHubRoot = hubRoot || process.env.CPB_HUB_ROOT;

  const locator: AnyRecord = {
    cpbRoot: path.resolve(cpbRoot),
    project,
    jobId: jobId || null,
    phase: phase || null,
    executorRoot: executorRoot ? path.resolve(executorRoot) : path.resolve(cpbRoot),
    stateRoot: null,
    wikiDir: wikiProjectDir(cpbRoot, project),
    inboxDir: inboxDir(cpbRoot, project),
    outputsDir: outputsDir(cpbRoot, project),
  };

  locator.sourcePath = await resolveProjectSourcePath(cpbRoot, project, {
    hubRoot: effectiveHubRoot,
    allowLegacyFallback: !jobId,
  });

  if (jobId) {
    const registered = await resolveRegisteredProject(cpbRoot, project, effectiveHubRoot).catch(() => null);
    const dataRoot = explicitDataRoot
      ? path.resolve(explicitDataRoot)
      : registered?.projectRuntimeRoot
      ? path.resolve(registered.projectRuntimeRoot)
      : await resolveProjectDataRoot(cpbRoot, project, { hubRoot: effectiveHubRoot });
    rememberProjectRuntimeRoot(cpbRoot, project, dataRoot);
    locator.stateRoot = dataRoot;
    locator.wikiDir = runtimeWikiDir(dataRoot);
    locator.inboxDir = inboxDir(cpbRoot, project, { dataRoot });
    locator.outputsDir = outputsDir(cpbRoot, project, { dataRoot });
    locator.eventLogPath = eventLogPath(cpbRoot, project, jobId, { dataRoot });
    locator.processRegistryDir = path.join(dataRoot, "processes");
    locator.stateFilePath = path.join(dataRoot, "state", `pipeline-${project}.json`);
    locator.sourcePath = locator.sourcePath || (registered?.sourcePath ? path.resolve(registered.sourcePath) : null);
    const job = await getJob(cpbRoot, project, jobId, { dataRoot });
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
      const { listQueue } = await import("./hub/hub-queue.js");
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
      locator.issueNumber = process.env.CPB_ISSUE_NUMBER || null;
      locator.issueUrl = process.env.CPB_ISSUE_URL || null;
      locator.repo = process.env.CPB_REPO || null;
    }
  }

  return locator;
}

export async function reconstructJobState(cpbRoot, project, jobId) {
  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot: process.env.CPB_HUB_ROOT });
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (!job?.jobId) return null;

  return buildLocator(cpbRoot, project, jobId, { phase: job.phase, dataRoot });
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
    prevPhase: locator.prevPhase || null,
    prevArtifact: locator.prevArtifact || null,
    prevArtifactPath: locator.prevArtifactPath || null,
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
    const p = await resolveRegisteredProject(cpbRoot, project);
    if (p) return true;
  } catch {}
  try {
    const info = await stat(wikiProjectDir(cpbRoot, project));
    if (info.isDirectory()) return true;
  } catch {}
  return false;
}

function resolveArtifactPath(locator, artifact) {
  if (!artifact || typeof artifact !== "string") return null;
  if (path.isAbsolute(artifact)) return artifact;
  const normalized = artifact.endsWith(".md") ? artifact : `${artifact}.md`;
  const directory = normalized.startsWith("plan-")
    ? locator.inboxDir
    : locator.outputsDir;
  return path.join(directory, normalized);
}

export async function buildPhaseLocator(cpbRoot, project, jobId, phase, options: AnyRecord = {}) {
  const locator = await buildLocator(cpbRoot, project, jobId, { ...options, phase });
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
  locator.prevArtifactPath = resolveArtifactPath(locator, prevPhaseArtifact);

  return locator;
}
