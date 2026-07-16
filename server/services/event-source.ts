import { readFile, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { enqueue as enqueueHubQueue, updateEntry as updateHubQueueEntry } from "./hub/hub-queue.js";
import { getProject } from "./hub/hub-registry.js";
import { createJob as createJobStore } from "./job/job-store.js";
import {
  triageChannelCommand,
  triageChannelCommandWithAcp,
  triageGithubIssue,
  triageGithubIssueWithAcp,
} from "./project/project-loader.js";
import type { LooseRecord } from "../../core/contracts/types.js";

type EventSourceStorageOptions = LooseRecord & {
  hubRoot?: string;
  controlRoot?: string;
};

type CandidateEvent = LooseRecord & {
  source?: string;
  externalId?: unknown;
  projectId?: string | null;
  priority?: string;
  payload?: LooseRecord;
  receivedAt?: string;
};

type CandidateEntry = LooseRecord & {
  id: string;
  source: string;
  externalId: string;
  projectId: string | null;
  priority: string;
  dedupeKey: string;
  payload: LooseRecord;
  receivedAt: string;
  status: string;
  statusReason?: string;
  updatedAt?: string;
};

type CandidateListOptions = EventSourceStorageOptions & {
  status?: string;
  source?: string;
};

type CandidateUpdateOptions = EventSourceStorageOptions & {
  status?: string;
  reason?: string;
};

type RouteDetails = LooseRecord & {
  workflow?: string;
  planMode?: string;
  category?: string;
};

type ProtectedScope = LooseRecord & {
  scope?: string;
};

type AcpTriager = LooseRecord & {
  agent?: string;
  error?: string | null;
  raw?: unknown;
};

type TriageRoute = LooseRecord & {
  triageMode?: string;
  effectiveRoute?: RouteDetails;
  effective?: RouteDetails;
  requestedRoute?: RouteDetails | null;
  requested?: RouteDetails | null;
  ruleRoute?: RouteDetails | null;
  acpRoute?: RouteDetails | null;
  acpTriager?: AcpTriager | null;
  triageStrategy?: LooseRecord | null;
  protectedUpgrade?: boolean;
  protectedKeywords?: string[];
  protectedScopes?: ProtectedScope[];
  actualDiffRisk?: (LooseRecord & { protected?: boolean }) | null;
  actorTrust?: unknown;
  downgradeAllowed?: boolean | null;
  reasons?: unknown[];
};

type TriageStrategy = LooseRecord & {
  useAcp?: boolean;
  usedAcp?: boolean;
  reason?: string | null;
};

type RouteOptions = EventSourceStorageOptions & {
  triageMode?: unknown;
  acpPool?: unknown;
  triageAgent?: string;
  triageTimeoutMs?: number;
  triageCwd?: string;
};

type GithubEvent = CandidateEvent & {
  status?: string;
  delivery?: string;
  event?: string;
  repo?: string;
  issueNumber?: number | string;
  action?: string;
  commandText?: string;
  label?: string;
  labels?: string[];
  title?: string;
  body?: string;
  url?: string;
  actor?: string;
  projectId?: string;
};

type GithubMatch = LooseRecord & {
  matched?: boolean;
  workflow?: string;
  planMode?: string;
  reason?: string;
};

type GithubPayload = LooseRecord & {
  issueNumber: number | string | null;
  repo: string | null;
  title: string;
  body: string;
  url: string | null;
  actor: string | null;
  workflow: string;
  planMode: string;
  route: TriageRoute;
  action: string | null;
  commandText: string | null;
  labels: string[];
  delivery: string | null;
  triggerReason: string | null;
};

type ProjectGithubConfig = LooseRecord & {
  fullName?: string;
  repo?: string;
};

type ProjectRecord = LooseRecord & {
  sourcePath?: string | null;
  projectRuntimeRoot?: string | null;
  github?: ProjectGithubConfig | null;
};

type ContextPack = LooseRecord & {
  path?: string;
};

type ContextPackResult = LooseRecord & {
  contextPack?: ContextPack | null;
  error?: unknown;
};

type HubQueueInput = LooseRecord & {
  projectId?: string;
  sourcePath?: string | null;
  priority?: string;
  description?: string;
  type?: string;
  metadata?: LooseRecord;
  createdAt?: string;
  updatedAt?: string;
};

type HubQueueEntry = LooseRecord & {
  id?: string;
  metadata?: LooseRecord;
};

type EnqueueFn = (hubRoot: string, input: HubQueueInput) => Promise<HubQueueEntry>;

type CreateJobFn = (cpbRoot: string, input: LooseRecord) => Promise<LooseRecord | null>;

type GithubQueueOptions = RouteOptions & {
  enqueueFn?: EnqueueFn;
  sourcePath?: string | null;
  getProjectFn?: ((root: string, id: string) => Promise<ProjectRecord | null>) | null;
};

type ChannelCommand = LooseRecord & {
  type?: string;
  project?: string;
  task?: string;
  issue?: number | string;
  workflowRequested?: boolean;
  workflow?: string;
  planMode?: string;
  command?: string;
  triage?: string;
};

type ChannelContext = LooseRecord & {
  channel?: string;
  externalId?: string;
  triggerId?: string;
  teamId?: string;
  channelId?: string;
  actor?: string;
  sourcePath?: string;
  commandText?: string;
  actorName?: string;
  channelName?: string;
};

type ChannelPayload = LooseRecord & {
  task: string;
  workflow: string;
  planMode: string;
  command: string | null;
  issueNumber: number | string | null;
  requestedWorkflow: string | null;
  requestedPlanMode: string | null;
  triage: string | null;
  route: TriageRoute | null;
  commandText: string | null;
  actor: string | null;
  actorName: string | null;
  teamId: string | null;
  channelId: string | null;
  channelName: string | null;
  triggerId: string | null;
};

type ChannelQueueOptions = RouteOptions & {
  enqueueFn?: EnqueueFn;
  createJobFn?: CreateJobFn | null;
  sourcePath?: string | null;
  getProjectFn?: ((root: string, id: string) => Promise<ProjectRecord | null>) | null;
};

type IssueLabel = string | (LooseRecord & { name?: string });

type GithubIssue = LooseRecord & {
  number?: number | string;
  id?: number | string;
  projectId?: string;
  labels?: IssueLabel[];
  title?: string;
  body?: string;
  url?: string;
  state?: string;
};

type CiFailure = LooseRecord & {
  runId?: string;
  buildId?: string;
  workflow?: string;
  branch?: string;
  commit?: string;
  message?: string;
  url?: string;
};

const EVENT_SOURCE_DIR = "event-sources";
const CANDIDATE_QUEUE_FILE = "candidates.json";
const CANDIDATE_LOCK_TTL_MS = 30_000;
const ROUTABLE_WORKFLOWS = new Set(["direct", "standard", "complex", "blocked"]);


function controlRoot(cpbRoot: string, { hubRoot, controlRoot: explicitControlRoot }: EventSourceStorageOptions = {}): string {
  const root = explicitControlRoot || hubRoot || cpbRoot;
  if (!root || typeof root !== "string" || !root.trim()) {
    throw new Error("hubRoot or controlRoot is required for event source storage");
  }
  return path.resolve(root);
}

function sourceDir(cpbRoot: string, options: EventSourceStorageOptions = {}): string {
  return path.join(controlRoot(cpbRoot, options), EVENT_SOURCE_DIR);
}

function candidateFile(cpbRoot: string, options: EventSourceStorageOptions = {}): string {
  return path.join(sourceDir(cpbRoot, options), CANDIDATE_QUEUE_FILE);
}

function generateId() {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeKey(source: string, externalId: unknown): string {
  return `${source}:${externalId}`;
}

// Values are sequencing chains whose resolved result is never consumed (only
// `.then`-chained and compared by reference for cleanup), so the resolved type
// is intentionally left as `unknown` rather than cast to `void`.
const candidateChains = new Map<string, Promise<unknown>>();

function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

async function withCandidateFileLock<T>(cpbRoot: string, options: EventSourceStorageOptions, fn: () => Promise<T>): Promise<T> {
  const file = candidateFile(cpbRoot, options);
  const lockDir = `${file}.lock`;
  await mkdir(path.dirname(lockDir), { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!hasErrorCode(err, "EEXIST")) throw err;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs >= CANDIDATE_LOCK_TTL_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock disappeared between mkdir and stat; retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  if (!acquired) throw new Error(`candidate queue lock busy: ${path.basename(file)}`);

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function withCandidateLock<T>(cpbRoot: string, options: EventSourceStorageOptions, fn: () => Promise<T>): Promise<T> {
  const key = controlRoot(cpbRoot, options);
  const prev = candidateChains.get(key) || Promise.resolve();
  const next = prev.then(() => withCandidateFileLock<T>(cpbRoot, options, fn));
  candidateChains.set(key, next.catch(() => {}));
  const cleanup = () => {
    if (candidateChains.get(key) === next) candidateChains.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

async function atomicWriteJson(file: string, data: unknown) {
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

async function readQueue(file: string): Promise<CandidateEntry[]> {
  try {
    const raw = await readFile(file, "utf8");
    const queue = JSON.parse(raw);
    if (!Array.isArray(queue)) {
      throw new Error(`candidate queue malformed: expected array in ${file}`);
    }
    return queue;
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return [];
    if (err instanceof SyntaxError) {
      throw new Error(`candidate queue malformed: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Ingest an external event into the candidate queue.
 * Returns the created candidate entry.
 */
export async function ingestEvent(cpbRoot: string, event: CandidateEvent, options: EventSourceStorageOptions = {}): Promise<CandidateEntry> {
  const {
    source,
    externalId,
    projectId,
    priority = "normal",
    payload = {},
    receivedAt,
  } = event;

  if (!source || !externalId) {
    throw new Error("ingestEvent requires source and externalId");
  }

  const entry: CandidateEntry = {
    id: generateId(),
    source,
    externalId: String(externalId),
    projectId: projectId || null,
    priority,
    dedupeKey: dedupeKey(source, externalId),
    payload,
    receivedAt: receivedAt || new Date().toISOString(),
    status: "pending",
  };

  return withCandidateLock(cpbRoot, options, async () => {
    const dir = sourceDir(cpbRoot, options);
    await mkdir(dir, { recursive: true });

    const file = candidateFile(cpbRoot, options);
    const queue = await readQueue(file);

    const existing = queue.find((e) => e.dedupeKey === entry.dedupeKey);
    if (existing) {
      return { ...existing, status: "duplicate" };
    }

    queue.push(entry);
    await atomicWriteJson(file, queue);

    return entry;
  });
}

function githubQueueExternalId(event: GithubEvent) {
  if (event.delivery) return event.delivery;
  return [
    event.event || "github",
    event.repo || "repo",
    event.issueNumber || "issue",
    event.action || "action",
    event.commandText || event.label || "",
  ].join(":");
}

function githubPriority(labels: string[] = []) {
  return labels.some((label) => /p0|critical|urgent|blocker/i.test(label)) ? "high" : "normal";
}

function effectiveRoute(route: TriageRoute | null | undefined): RouteDetails {
  return route?.effectiveRoute || route?.effective || {};
}

function requestedRoute(route: TriageRoute | null | undefined): RouteDetails | null {
  return route?.requestedRoute || route?.requested || null;
}

function routingMetadata(route: TriageRoute | null | undefined) {
  if (!route) return null;
  const acpTriager = route.acpTriager
    ? {
        agent: route.acpTriager.agent || null,
        error: route.acpTriager.error || null,
        used: Boolean(route.acpTriager.raw && !route.acpTriager.error),
      }
    : null;
  return {
    triageMode: route.triageMode || null,
    category: route.effectiveRoute?.category || route.requestedRoute?.category || route.requested?.category || null,
    requested: requestedRoute(route),
    ruleRoute: route.ruleRoute || null,
    acpRoute: route.acpRoute || null,
    acpTriager,
    triageStrategy: route.triageStrategy || null,
    effective: effectiveRoute(route),
    effectiveRoute: route.effectiveRoute || null,
    protectedUpgrade: route.protectedUpgrade ?? ((route.protectedScopes || []).length > 0 || Boolean(route.actualDiffRisk?.protected)),
    protectedKeywords: route.protectedKeywords || (route.protectedScopes || []).map((scope: ProtectedScope) => scope.scope),
    protectedScopes: route.protectedScopes || [],
    actualDiffRisk: route.actualDiffRisk || null,
    actorTrust: route.actorTrust || null,
    downgradeAllowed: route.downgradeAllowed ?? null,
    reasons: route.reasons || [],
  };
}

function normalizeTriageMode(mode: unknown, fallback: string = "rules"): string {
  const value = String(mode || fallback || "rules").trim().toLowerCase();
  if (value === "acp" || value === "auto" || value === "rules" || value === "none") return value;
  return fallback;
}

function acpEnabledForAuto() {
  return process.env.CPB_TRIAGE_ACP === "1" || process.env.CPB_TRIAGE_MODE === "acp";
}

function autoTriageMode(explicitMode: unknown, envMode: unknown): string {
  if (explicitMode) return normalizeTriageMode(explicitMode, "rules");
  if (envMode) return normalizeTriageMode(envMode, "rules");
  return process.env.CPB_TRIAGE_ACP === "1" ? "auto" : "rules";
}

function routeConflict(decision: TriageRoute): boolean {
  return Boolean(
    decision?.requestedRoute
      && decision?.ruleRoute
      && (
        decision.requestedRoute.workflow !== decision.ruleRoute.workflow
        || decision.requestedRoute.planMode !== decision.ruleRoute.planMode
      ),
  );
}

function autoAcpDecision(decision: TriageRoute = {}) {
  if ((decision.protectedScopes || []).length > 0 || decision.actualDiffRisk?.protected) {
    return { useAcp: false, reason: "protected or changed-file risk is already forced to complex/full" };
  }
  if (decision.effectiveRoute?.workflow === "complex" && decision.effectiveRoute?.planMode === "full") {
    return { useAcp: false, reason: "high-risk rules already selected complex/full" };
  }
  if (decision.ruleRoute?.category === "unknown") {
    return { useAcp: true, reason: "uncertain unknown rule route" };
  }
  if (routeConflict(decision)) {
    return { useAcp: true, reason: "conflicting requested and rule routes" };
  }
  return { useAcp: false, reason: "confident deterministic route" };
}

function withTriageStrategy(decision: TriageRoute, mode: string, strategy: TriageStrategy): TriageRoute {
  return {
    ...decision,
    triageMode: mode,
    triageStrategy: {
      mode,
      usedAcp: Boolean(strategy?.usedAcp),
      reason: strategy?.reason || null,
    },
  };
}

function triageRoute(decision: LooseRecord): TriageRoute {
  return decision as TriageRoute;
}

function withTriageMode(decision: LooseRecord, mode: string): TriageRoute {
  return {
    ...decision,
    triageMode: mode,
  } as TriageRoute;
}

async function resolveGithubRoute(cpbRoot: string, event: GithubEvent, {
  hubRoot,
  triageMode,
  acpPool,
  triageAgent = "claude",
  triageTimeoutMs = 60_000,
  triageCwd = process.cwd(),
}: RouteOptions = {}): Promise<TriageRoute> {
  const requestedMode = autoTriageMode(
    triageMode || process.env.CPB_GITHUB_TRIAGE_MODE,
    process.env.CPB_TRIAGE_MODE,
  );
  const effectiveMode = requestedMode === "auto" ? "auto" : requestedMode;
  if (effectiveMode === "acp") {
    return triageRoute(await triageGithubIssueWithAcp(event, {
      cpbRoot,
      hubRoot,
      cwd: triageCwd,
      agent: triageAgent,
      timeoutMs: triageTimeoutMs,
      acpPool,
    }));
  }
  const rulesDecision = triageRoute(triageGithubIssue(event));
  if (effectiveMode === "auto") {
    const strategy = autoAcpDecision(rulesDecision);
    if (strategy.useAcp) {
      const acpDecision = triageRoute(await triageGithubIssueWithAcp(event, {
        cpbRoot,
        hubRoot,
        cwd: triageCwd,
        agent: triageAgent,
        timeoutMs: triageTimeoutMs,
        acpPool,
      }));
      return withTriageStrategy(acpDecision, "auto", { ...strategy, usedAcp: true });
    }
    return withTriageStrategy(rulesDecision, "auto", { ...strategy, usedAcp: false });
  }
  return withTriageMode(rulesDecision, effectiveMode);
}

async function resolveChannelRoute(cpbRoot: string, command: ChannelCommand, context: ChannelContext, {
  hubRoot,
  triageMode,
  acpPool,
  triageAgent = "claude",
  triageTimeoutMs = 60_000,
  triageCwd = process.cwd(),
}: RouteOptions = {}): Promise<TriageRoute> {
  const requestedMode = autoTriageMode(
    command.triage || triageMode || process.env.CPB_CHANNEL_TRIAGE_MODE,
    process.env.CPB_TRIAGE_MODE,
  );
  const effectiveMode = requestedMode === "auto" ? "auto" : requestedMode;
  if (effectiveMode === "acp") {
    return triageRoute(await triageChannelCommandWithAcp(command, context, {
      cpbRoot,
      hubRoot,
      cwd: triageCwd,
      agent: triageAgent,
      timeoutMs: triageTimeoutMs,
      acpPool,
    }));
  }
  const rulesDecision = triageRoute(triageChannelCommand(command, context));
  if (effectiveMode === "auto") {
    const strategy = autoAcpDecision(rulesDecision);
    if (strategy.useAcp) {
      const acpDecision = triageRoute(await triageChannelCommandWithAcp(command, context, {
        cpbRoot,
        hubRoot,
        cwd: triageCwd,
        agent: triageAgent,
        timeoutMs: triageTimeoutMs,
        acpPool,
      }));
      return withTriageStrategy(acpDecision, "auto", { ...strategy, usedAcp: true });
    }
    return withTriageStrategy(rulesDecision, "auto", { ...strategy, usedAcp: false });
  }
  return withTriageMode(rulesDecision, effectiveMode);
}

function githubQueuePayload(event: GithubEvent, match: GithubMatch, route: TriageRoute): GithubPayload {
  const effective = effectiveRoute(route);
  return {
    issueNumber: event.issueNumber ?? null,
    repo: event.repo || null,
    title: event.title || (event.issueNumber ? `Issue #${event.issueNumber}` : "GitHub issue"),
    body: event.body || "",
    url: event.url || null,
    actor: event.actor || null,
    workflow: effective.workflow || match.workflow || "standard",
    planMode: match.planMode || effective.planMode || "full",
    route,
    action: event.action || null,
    commandText: event.commandText || null,
    labels: event.labels || [],
    delivery: event.delivery || null,
    triggerReason: match.reason || null,
  };
}

function githubHubPriority(labels: string[] = []) {
  return labels.some((label) => /p0|critical|urgent|blocker/i.test(label)) ? "P0" : "P2";
}

async function resolveRegisteredProject(hubRoot: string, projectId: string, getProjectFn: ((root: string, id: string) => Promise<ProjectRecord | null>) | null) {
  if (!hubRoot || !projectId || typeof getProjectFn !== "function") return null;
  try {
    return await getProjectFn(hubRoot, projectId);
  } catch {
    return null;
  }
}

function sourcePathForQueue(explicitSourcePath: string | null, project: ProjectRecord | null): string | null {
  return explicitSourcePath || project?.sourcePath || null;
}

function projectRuntimeRootForImmediateJob(project: ProjectRecord | null): string | null {
  const dataRoot = project?.projectRuntimeRoot;
  return typeof dataRoot === "string" && dataRoot.trim() ? dataRoot : null;
}

async function maybeGenerateQueueContextPack(project: ProjectRecord | null, hubRoot: string, task: string): Promise<ContextPackResult | null> {
  return null;
}

function githubHubQueueInput({
  event,
  match,
  payload,
  candidateEntry,
  sourcePath,
  contextPackResult = null,
}: {
  event: GithubEvent;
  match: GithubMatch;
  payload: GithubPayload;
  candidateEntry: CandidateEntry;
  sourcePath: string | null;
  contextPackResult?: ContextPackResult | null;
}): HubQueueInput {
  const route = payload.route;
  const contextPack = contextPackResult?.contextPack || null;
  return {
    projectId: event.projectId,
    sourcePath,
    priority: githubHubPriority(event.labels),
    description: payload.title || `GitHub issue #${payload.issueNumber}`,
    type: "github_issue",
    metadata: {
      source: "github",
      candidateEntryId: candidateEntry.id,
      queueDedupeKey: candidateEntry.dedupeKey,
      issueNumber: payload.issueNumber,
      issueUrl: payload.url,
      repo: payload.repo,
      issueTitle: payload.title,
      issueBody: payload.body || "",
      actor: payload.actor,
      delivery: payload.delivery,
      commandText: payload.commandText,
      triggerReason: payload.triggerReason,
      workflow: payload.workflow || match.workflow || "standard",
      planMode: payload.planMode || "full",
      contextPackPath: contextPack?.path || null,
      contextPack,
      contextPackError: contextPackResult?.error || null,
      requestedRoute: requestedRoute(route),
      routing: routingMetadata(route),
      autoFinalize: true,
    },
  };
}

export async function createGithubIssueQueueJob(
  cpbRoot: string,
  event: GithubEvent,
  match: GithubMatch,
  {
    hubRoot = cpbRoot,
    enqueueFn = enqueueHubQueue,
    sourcePath = null,
    getProjectFn = getProject,
    triageMode = null,
    acpPool = null,
    triageAgent = "claude",
    triageTimeoutMs = 60_000,
  }: GithubQueueOptions = {},
) {
  if (!event || event.status !== "ok") {
    throw new Error("GitHub event must be normalized before queue creation");
  }
  if (!match?.matched) {
    throw new Error("GitHub event did not match a trigger rule");
  }
  if (!event.projectId) {
    throw new Error("GitHub event missing project id");
  }

  const route = await resolveGithubRoute(cpbRoot, event, {
    hubRoot,
    triageMode,
    acpPool,
    triageAgent,
    triageTimeoutMs,
    triageCwd: sourcePath || process.cwd(),
  });
  const payload = githubQueuePayload(event, match, route);
  const entry = await ingestEvent(cpbRoot, {
    source: "github-issue",
    externalId: githubQueueExternalId(event),
    projectId: event.projectId,
    priority: githubPriority(event.labels),
    payload,
  }, { hubRoot });

  if (entry.status === "duplicate") {
    return { status: "duplicate", entry, candidateEntry: entry, queueEntry: null, job: null };
  }

  const project = await resolveRegisteredProject(hubRoot, event.projectId, getProjectFn);
  const sourcePathForEntry = sourcePathForQueue(sourcePath, project);
  const contextPackResult = await maybeGenerateQueueContextPack(
    project,
    hubRoot,
    [payload.title, payload.body].filter(Boolean).join("\n\n"),
  );
  const queueEntry = await enqueueFn(
    hubRoot,
    githubHubQueueInput({
      event,
      match,
      payload,
      candidateEntry: entry,
      sourcePath: sourcePathForEntry,
      contextPackResult,
    }),
  );
  const updated = await updateCandidate(cpbRoot, entry.id, {
    status: "queued",
    reason: `queued hub entry ${queueEntry.id}`,
  }, { hubRoot });

  let job = null;
  const immediateJobDataRoot = projectRuntimeRootForImmediateJob(project);
  if (immediateJobDataRoot) {
    const effective = effectiveRoute(route);
    job = await createJobStore(cpbRoot, {
      project: event.projectId,
      task: payload.title || `GitHub issue #${payload.issueNumber}`,
      workflow: effective.workflow || match.workflow || "standard",
      planMode: match.planMode || effective.planMode || "full",
      dataRoot: immediateJobDataRoot,
      queueEntryId: queueEntry.id,
      sourceContext: {
        source: "github",
        issueNumber: payload.issueNumber,
        repo: payload.repo,
        issueTitle: payload.title,
        issueBody: payload.body || "",
        issueUrl: payload.url,
        actor: payload.actor,
        delivery: event.delivery,
        triggerReason: payload.triggerReason,
        candidateEntryId: entry.id,
      },
    });
  }

  return {
    status: "created",
    entry: updated || entry,
    candidateEntry: updated || entry,
    queueEntry,
    job,
  };
}

function channelExternalId(source: string, context: ChannelContext = {}): string {
  if (context.externalId) return context.externalId;
  if (context.triggerId) return context.triggerId;
  return [
    source,
    context.teamId || "team",
    context.channelId || "channel",
    context.actor || "actor",
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8),
  ].join(":");
}

function channelQueuePayload(command: ChannelCommand, context: ChannelContext = {}, route: TriageRoute | null = null): ChannelPayload {
  const effective = effectiveRoute(route);
  const workflowRequested = command.workflowRequested || (command.workflow && command.workflow !== "standard");
  const explicitCustomWorkflow = workflowRequested
    && command.workflow
    && !ROUTABLE_WORKFLOWS.has(command.workflow);
  return {
    task: command.task || (command.issue ? `GitHub issue #${command.issue}` : ""),
    workflow: explicitCustomWorkflow ? command.workflow : (effective.workflow || command.workflow || "standard"),
    planMode: effective.planMode || command.planMode || "full",
    command: command.command || command.type || null,
    issueNumber: command.issue || null,
    requestedWorkflow: command.workflow || null,
    requestedPlanMode: command.planMode || null,
    triage: command.triage || null,
    route,
    commandText: context.commandText || null,
    actor: context.actor || null,
    actorName: context.actorName || null,
    teamId: context.teamId || null,
    channelId: context.channelId || null,
    channelName: context.channelName || null,
    triggerId: context.triggerId || null,
  };
}

function channelDescription(payload: ChannelPayload): string {
  return payload.task || (payload.issueNumber ? `GitHub issue #${payload.issueNumber}` : "");
}

function channelHubQueueInput({
  command,
  source,
  payload,
  candidateEntry,
  sourcePath,
  project,
  contextPackResult = null,
}: {
  command: ChannelCommand;
  source: string;
  payload: ChannelPayload;
  candidateEntry: CandidateEntry;
  sourcePath: string | null;
  project: ProjectRecord | null;
  contextPackResult?: ContextPackResult | null;
}): HubQueueInput {
  const repo = project?.github?.fullName || project?.github?.repo || null;
  const issueUrl = payload.issueNumber && repo ? `https://github.com/${repo}/issues/${payload.issueNumber}` : null;
  const contextPack = contextPackResult?.contextPack || null;
  return {
    projectId: command.project,
    sourcePath,
    priority: "P2",
    description: channelDescription(payload),
    type: source,
    metadata: {
      source,
      channel: source,
      candidateEntryId: candidateEntry.id,
      queueDedupeKey: candidateEntry.dedupeKey,
      actor: payload.actor,
      actorName: payload.actorName,
      teamId: payload.teamId,
      channelId: payload.channelId,
      channelName: payload.channelName,
      commandText: payload.commandText,
      triggerId: payload.triggerId,
      issueNumber: payload.issueNumber,
      issueUrl,
      repo,
      workflow: payload.workflow || "standard",
      planMode: payload.planMode || "full",
      contextPackPath: contextPack?.path || null,
      contextPack,
      contextPackError: contextPackResult?.error || null,
      requestedRoute: requestedRoute(payload.route),
      routing: routingMetadata(payload.route),
      triage: payload.triage,
      autoFinalize: false,
    },
  };
}

export async function createChannelQueueJob(
  cpbRoot: string,
  command: ChannelCommand,
  context: ChannelContext = {},
  {
    hubRoot = cpbRoot,
    enqueueFn = enqueueHubQueue,
    createJobFn = createJobStore,
    sourcePath = context.sourcePath || null,
    getProjectFn = getProject,
    triageMode = null,
    acpPool = null,
    triageAgent = "claude",
    triageTimeoutMs = 60_000,
  }: ChannelQueueOptions = {},
) {
  if (!command || !["run", "issue"].includes(command.type)) {
    throw new Error("channel command must be a run or issue command before queue creation");
  }
  if (!command.project || (!command.task && !command.issue)) {
    throw new Error("channel command requires project and task or issue");
  }

  const source = context.channel || "channel";
  const route = await resolveChannelRoute(cpbRoot, command, context, {
    hubRoot,
    triageMode,
    acpPool,
    triageAgent,
    triageTimeoutMs,
    triageCwd: sourcePath || context.sourcePath || process.cwd(),
  });
  const payload = channelQueuePayload(command, context, route);
  const entry = await ingestEvent(cpbRoot, {
    source,
    externalId: channelExternalId(source, context),
    projectId: command.project,
    payload,
  }, { hubRoot });

  if (entry.status === "duplicate") {
    return { status: "duplicate", entry, candidateEntry: entry, queueEntry: null, job: null };
  }

  const project = await resolveRegisteredProject(hubRoot, command.project, getProjectFn);
  const sourcePathForEntry = sourcePathForQueue(sourcePath, project);
  const contextPackResult = await maybeGenerateQueueContextPack(project, hubRoot, payload.task || payload.commandText || "");
  const queueEntry = await enqueueFn(
    hubRoot,
    channelHubQueueInput({
      command,
      source,
      payload,
      candidateEntry: entry,
      sourcePath: sourcePathForEntry,
      project,
      contextPackResult,
    }),
  );
  const updated = await updateCandidate(cpbRoot, entry.id, {
    status: "queued",
    reason: `queued hub entry ${queueEntry.id}`,
  }, { hubRoot });

  let job = null;
  const immediateJobDataRoot = projectRuntimeRootForImmediateJob(project);
  if (command.type === "run" && createJobFn && immediateJobDataRoot) {
    try {
      job = await createJobFn(cpbRoot, {
        project: command.project,
        task: payload.task || command.task,
        workflow: payload.workflow || "standard",
        planMode: payload.planMode || null,
        dataRoot: immediateJobDataRoot,
        queueEntryId: queueEntry.id,
        sourceContext: {
          source,
          channel: source,
          actor: context.actor || null,
          actorName: context.actorName || null,
          teamId: context.teamId || null,
          channelId: context.channelId || null,
          channelName: context.channelName || null,
          candidateEntryId: entry.id,
          queueEntryId: queueEntry.id,
        },
      });
    } catch {
      // Queue creation is the durable handoff; job creation is an immediate status convenience.
    }
  }

  return {
    status: "created",
    entry: updated || entry,
    candidateEntry: updated || entry,
    queueEntry,
    job,
  };
}

/**
 * List candidate events, optionally filtered by status or source.
 */
export async function listCandidates(cpbRoot: string, { status, source, ...rootOptions }: CandidateListOptions = {}): Promise<CandidateEntry[]> {
  const file = candidateFile(cpbRoot, rootOptions);
  const queue = await readQueue(file);

  return queue.filter((e) => {
    if (status && e.status !== status) return false;
    if (source && e.source !== source) return false;
    return true;
  });
}

/**
 * Update a candidate's status (pending → processed | dismissed).
 */
export async function updateCandidate(
  cpbRoot: string,
  candidateId: string,
  { status, reason, ...inlineRootOptions }: CandidateUpdateOptions,
  options: EventSourceStorageOptions = {},
): Promise<CandidateEntry | null> {
  const rootOptions = { ...inlineRootOptions, ...options };
  return withCandidateLock(cpbRoot, rootOptions, async () => {
    const file = candidateFile(cpbRoot, rootOptions);
    const queue = await readQueue(file);
    if (!queue.length) return null;

    const entry = queue.find((e) => e.id === candidateId);
    if (!entry) return null;

    entry.status = status;
    if (reason) entry.statusReason = reason;
    entry.updatedAt = new Date().toISOString();

    await atomicWriteJson(file, queue);
    return entry;
  });
}

/**
 * Normalize a GitHub issue into a candidate event.
 */
export function githubIssueToCandidate(issue: GithubIssue, { projectId }: { projectId?: string } = {}) {
  return {
    source: "github-issue",
    externalId: String(issue.number || issue.id),
    projectId: projectId || issue.projectId || null,
    priority: issue.labels?.some?.((l: string | LooseRecord) => {
      const name = typeof l === "string" ? l : (typeof l.name === "string" ? l.name : "");
      return name && /p0|critical|urgent|blocker/i.test(name);
    }) ? "high" : "normal",
    payload: {
      title: issue.title || `Issue #${issue.number}`,
      body: (issue.body || "").slice(0, 2000),
      labels: Array.isArray(issue.labels)
        ? issue.labels.map((l: IssueLabel) => (typeof l === "string" ? l : l.name)).filter(Boolean)
        : [],
      url: issue.url || null,
      state: issue.state || "OPEN",
    },
  };
}

/**
 * Normalize a CI failure into a candidate event.
 */
export function ciFailureToCandidate(failure: CiFailure, { projectId }: { projectId?: string } = {}) {
  return {
    source: "ci-failure",
    externalId: failure.runId || failure.buildId || `ci-${Date.now()}`,
    projectId: projectId || null,
    priority: "high",
    payload: {
      workflow: failure.workflow || null,
      branch: failure.branch || null,
      commit: failure.commit || null,
      message: failure.message || "CI failure",
      url: failure.url || null,
    },
  };
}
