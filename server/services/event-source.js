import { readFile, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";
import { enqueue as enqueueHubQueue } from "./hub-queue.js";
import { getProject } from "./hub-registry.js";
import {
  triageChannelCommand,
  triageChannelCommandWithAcp,
  triageGithubIssue,
  triageGithubIssueWithAcp,
} from "./issue-triage.js";
import { bootstrapSddFromIssue } from "./sdd-automation.js";
import { generateContextPack } from "./repo-graph.js";

const EVENT_SOURCE_DIR = "event-sources";
const CANDIDATE_QUEUE_FILE = "candidates.json";
const CANDIDATE_LOCK_TTL_MS = 30_000;
const ROUTABLE_WORKFLOWS = new Set(["direct", "standard", "complex", "sdd-standard", "blocked"]);

function sourceDir(cpbRoot) {
  return runtimeDataPath(cpbRoot, EVENT_SOURCE_DIR);
}

function candidateFile(cpbRoot) {
  return path.join(sourceDir(cpbRoot), CANDIDATE_QUEUE_FILE);
}

function generateId() {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeKey(source, externalId) {
  return `${source}:${externalId}`;
}

const candidateChains = new Map();

async function withCandidateFileLock(cpbRoot, fn) {
  const file = candidateFile(cpbRoot);
  const lockDir = `${file}.lock`;
  await mkdir(path.dirname(lockDir), { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
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

function withCandidateLock(cpbRoot, fn) {
  const key = path.resolve(cpbRoot);
  const prev = candidateChains.get(key) || Promise.resolve();
  const next = prev.then(() => withCandidateFileLock(cpbRoot, fn));
  candidateChains.set(key, next.catch(() => {}));
  const cleanup = () => {
    if (candidateChains.get(key) === next) candidateChains.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

async function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

async function readQueue(file) {
  try {
    const raw = await readFile(file, "utf8");
    const queue = JSON.parse(raw);
    if (!Array.isArray(queue)) {
      throw new Error(`candidate queue malformed: expected array in ${file}`);
    }
    return queue;
  } catch (err) {
    if (err?.code === "ENOENT") return [];
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
export async function ingestEvent(cpbRoot, event) {
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

  const entry = {
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

  return withCandidateLock(cpbRoot, async () => {
    const dir = sourceDir(cpbRoot);
    await mkdir(dir, { recursive: true });

    const file = candidateFile(cpbRoot);
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

function githubQueueExternalId(event) {
  if (event.delivery) return event.delivery;
  return [
    event.event || "github",
    event.repo || "repo",
    event.issueNumber || "issue",
    event.action || "action",
    event.commandText || event.label || "",
  ].join(":");
}

function githubPriority(labels = []) {
  return labels.some((label) => /p0|critical|urgent|blocker/i.test(label)) ? "high" : "normal";
}

function effectiveRoute(route) {
  return route?.effectiveRoute || route?.effective || {};
}

function requestedRoute(route) {
  return route?.requestedRoute || route?.requested || null;
}

function routingMetadata(route) {
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
    protectedKeywords: route.protectedKeywords || (route.protectedScopes || []).map((scope) => scope.scope),
    protectedScopes: route.protectedScopes || [],
    actualDiffRisk: route.actualDiffRisk || null,
    actorTrust: route.actorTrust || null,
    downgradeAllowed: route.downgradeAllowed ?? null,
    reasons: route.reasons || [],
  };
}

function normalizeTriageMode(mode, fallback = "rules") {
  const value = String(mode || fallback || "rules").trim().toLowerCase();
  if (value === "acp" || value === "auto" || value === "rules" || value === "none") return value;
  return fallback;
}

function acpEnabledForAuto() {
  return process.env.CPB_TRIAGE_ACP === "1" || process.env.CPB_TRIAGE_MODE === "acp";
}

function autoTriageMode(explicitMode, envMode) {
  if (explicitMode) return normalizeTriageMode(explicitMode, "rules");
  if (envMode) return normalizeTriageMode(envMode, "rules");
  return process.env.CPB_TRIAGE_ACP === "1" ? "auto" : "rules";
}

function routeConflict(decision) {
  return Boolean(
    decision?.requestedRoute
      && decision?.ruleRoute
      && (
        decision.requestedRoute.workflow !== decision.ruleRoute.workflow
        || decision.requestedRoute.planMode !== decision.ruleRoute.planMode
      ),
  );
}

function autoAcpDecision(decision = {}) {
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

function withTriageStrategy(decision, mode, strategy) {
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

async function resolveGithubRoute(cpbRoot, event, {
  hubRoot,
  triageMode,
  acpPool,
  triageAgent = "claude",
  triageTimeoutMs = 60_000,
  triageCwd = process.cwd(),
} = {}) {
  const requestedMode = autoTriageMode(
    triageMode || process.env.CPB_GITHUB_TRIAGE_MODE,
    process.env.CPB_TRIAGE_MODE,
  );
  const effectiveMode = requestedMode === "auto" ? "auto" : requestedMode;
  if (effectiveMode === "acp") {
    return triageGithubIssueWithAcp(event, {
      cpbRoot,
      hubRoot,
      cwd: triageCwd,
      agent: triageAgent,
      timeoutMs: triageTimeoutMs,
      acpPool,
    });
  }
  const rulesDecision = triageGithubIssue(event);
  if (effectiveMode === "auto") {
    const strategy = autoAcpDecision(rulesDecision);
    if (strategy.useAcp) {
      const acpDecision = await triageGithubIssueWithAcp(event, {
        cpbRoot,
        hubRoot,
        cwd: triageCwd,
        agent: triageAgent,
        timeoutMs: triageTimeoutMs,
        acpPool,
      });
      return withTriageStrategy(acpDecision, "auto", { ...strategy, usedAcp: true });
    }
    return withTriageStrategy(rulesDecision, "auto", { ...strategy, usedAcp: false });
  }
  return {
    ...rulesDecision,
    triageMode: effectiveMode,
  };
}

async function resolveChannelRoute(cpbRoot, command, context, {
  hubRoot,
  triageMode,
  acpPool,
  triageAgent = "claude",
  triageTimeoutMs = 60_000,
  triageCwd = process.cwd(),
} = {}) {
  const requestedMode = autoTriageMode(
    command.triage || triageMode || process.env.CPB_CHANNEL_TRIAGE_MODE,
    process.env.CPB_TRIAGE_MODE,
  );
  const effectiveMode = requestedMode === "auto" ? "auto" : requestedMode;
  if (effectiveMode === "acp") {
    return triageChannelCommandWithAcp(command, context, {
      cpbRoot,
      hubRoot,
      cwd: triageCwd,
      agent: triageAgent,
      timeoutMs: triageTimeoutMs,
      acpPool,
    });
  }
  const rulesDecision = triageChannelCommand(command, context);
  if (effectiveMode === "auto") {
    const strategy = autoAcpDecision(rulesDecision);
    if (strategy.useAcp) {
      const acpDecision = await triageChannelCommandWithAcp(command, context, {
        cpbRoot,
        hubRoot,
        cwd: triageCwd,
        agent: triageAgent,
        timeoutMs: triageTimeoutMs,
        acpPool,
      });
      return withTriageStrategy(acpDecision, "auto", { ...strategy, usedAcp: true });
    }
    return withTriageStrategy(rulesDecision, "auto", { ...strategy, usedAcp: false });
  }
  return {
    ...rulesDecision,
    triageMode: effectiveMode,
  };
}

function githubQueuePayload(event, match, route) {
  const effective = effectiveRoute(route);
  return {
    issueNumber: event.issueNumber ?? null,
    repo: event.repo || null,
    title: event.title || (event.issueNumber ? `Issue #${event.issueNumber}` : "GitHub issue"),
    body: event.body || "",
    url: event.url || null,
    actor: event.actor || null,
    workflow: effective.workflow || match.workflow || "standard",
    planMode: effective.planMode || match.planMode || "full",
    route,
    action: event.action || null,
    commandText: event.commandText || null,
    labels: event.labels || [],
    delivery: event.delivery || null,
    triggerReason: match.reason || null,
  };
}

function githubHubPriority(labels = []) {
  return labels.some((label) => /p0|critical|urgent|blocker/i.test(label)) ? "P0" : "P2";
}

async function resolveRegisteredProject(hubRoot, projectId, getProjectFn) {
  if (!hubRoot || !projectId || typeof getProjectFn !== "function") return null;
  try {
    return await getProjectFn(hubRoot, projectId);
  } catch {
    return null;
  }
}

function sourcePathForQueue(explicitSourcePath, project) {
  return explicitSourcePath || project?.sourcePath || null;
}

async function maybeGenerateQueueContextPack(project, hubRoot, task) {
  if (!project?.sourcePath) return null;
  try {
    const result = await generateContextPack(project, { hubRoot, task });
    return { contextPack: result.contextPack, error: null };
  } catch (error) {
    return { contextPack: null, error: error.message };
  }
}

function isSddRoute(route) {
  const effective = effectiveRoute(route);
  const requested = requestedRoute(route);
  return effective.workflow === "sdd-standard"
    || requested?.workflow === "sdd-standard"
    || route?.ruleRoute?.workflow === "sdd-standard"
    || requested?.category === "sdd"
    || route?.ruleRoute?.category === "sdd";
}

function githubHubQueueInput({ event, match, payload, candidateEntry, sourcePath, sddAutomation = null, contextPackResult = null }) {
  const route = payload.route;
  const sddMetadata = sddAutomation?.queueMetadata || {};
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
      actor: payload.actor,
      delivery: payload.delivery,
      commandText: payload.commandText,
      triggerReason: payload.triggerReason,
      workflow: payload.workflow || match.workflow || "standard",
      planMode: payload.planMode || "full",
      ...sddMetadata,
      contextPackPath: contextPack?.path || null,
      contextPack,
      contextPackError: contextPackResult?.error || null,
      requestedRoute: requestedRoute(route),
      routing: routingMetadata(route),
      autoFinalize: true,
    },
  };
}

async function enqueueSddTaskEntries({
  hubRoot,
  enqueueFn,
  event,
  parentQueueEntry,
  sourcePath,
  sddAutomation,
  route,
  contextPackResult = null,
}) {
  if (!sddAutomation?.tasks?.length) return [];
  const entries = [];
  for (const task of sddAutomation.tasks) {
    const entry = await enqueueFn(hubRoot, {
      projectId: event.projectId,
      sourcePath,
      priority: "P2",
      description: `SDD task: ${task.title}`,
      type: "sdd_task",
      metadata: {
        source: "github",
        parentQueueEntryId: parentQueueEntry.id,
        issueNumber: event.issueNumber,
        issueUrl: event.url,
        repo: event.repo,
        issueTitle: event.title,
        workflow: task.workflow,
        planMode: task.planMode,
        requestedRoute: requestedRoute(route),
        routing: routingMetadata(route),
        sddTask: task,
        sddTrace: sddAutomation.queueMetadata?.sddTrace || null,
        contextPackPath: contextPackResult?.contextPack?.path || null,
        contextPack: contextPackResult?.contextPack || null,
        contextPackError: contextPackResult?.error || null,
        queueDedupeKey: `${parentQueueEntry.metadata?.queueDedupeKey || parentQueueEntry.id}:sdd-task:${task.id}`,
        autoFinalize: true,
      },
    });
    entries.push(entry);
  }
  return entries;
}

export async function createGithubIssueQueueJob(
  cpbRoot,
  event,
  match,
  {
    hubRoot = cpbRoot,
    enqueueFn = enqueueHubQueue,
    sourcePath = null,
    getProjectFn = getProject,
    triageMode = null,
    acpPool = null,
    triageAgent = "claude",
    triageTimeoutMs = 60_000,
    sddDrafterMode = null,
    sddAcpPool = null,
    sddDrafterAgent = "claude",
    sddDrafterTimeoutMs = 60_000,
  } = {},
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
  });

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
  const sddAutomation = isSddRoute(route)
    ? await bootstrapSddFromIssue(cpbRoot, event.projectId, event, {
        sddDrafterMode: sddDrafterMode || process.env.CPB_SDD_DRAFTER_MODE || "template",
        acpPool: sddAcpPool,
        hubRoot,
        cwd: sourcePathForEntry || process.cwd(),
        agent: sddDrafterAgent,
        timeoutMs: sddDrafterTimeoutMs,
      })
    : null;
  const queueEntry = await enqueueFn(
    hubRoot,
    githubHubQueueInput({
      event,
      match,
      payload,
      candidateEntry: entry,
      sourcePath: sourcePathForEntry,
      sddAutomation,
      contextPackResult,
    }),
  );
  const sddTaskQueueEntries = await enqueueSddTaskEntries({
    hubRoot,
    enqueueFn,
    event,
    parentQueueEntry: queueEntry,
    sourcePath: sourcePathForEntry,
    sddAutomation,
    route,
    contextPackResult,
  });
  const updated = await updateCandidate(cpbRoot, entry.id, {
    status: "queued",
    reason: `queued hub entry ${queueEntry.id}`,
  });

  return {
    status: "created",
    entry: updated || entry,
    candidateEntry: updated || entry,
    queueEntry,
    sddTaskQueueEntries,
    job: null,
  };
}

function channelExternalId(source, context = {}) {
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

function channelQueuePayload(command, context = {}, route = null) {
  const effective = effectiveRoute(route);
  const workflowRequested = command.workflowRequested || (command.workflow && command.workflow !== "standard");
  const explicitCustomWorkflow = workflowRequested
    && command.workflow
    && !ROUTABLE_WORKFLOWS.has(command.workflow);
  return {
    task: command.task || (command.issue ? `GitHub issue #${command.issue}` : ""),
    workflow: explicitCustomWorkflow ? command.workflow : (effective.workflow || command.workflow || "standard"),
    planMode: effective.planMode || command.planMode || "light",
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

function channelDescription(payload) {
  return payload.task || (payload.issueNumber ? `GitHub issue #${payload.issueNumber}` : "");
}

function channelHubQueueInput({ command, source, payload, candidateEntry, sourcePath, project, contextPackResult = null }) {
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
      planMode: payload.planMode || "light",
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
  cpbRoot,
  command,
  context = {},
  {
    hubRoot = cpbRoot,
    enqueueFn = enqueueHubQueue,
    sourcePath = context.sourcePath || null,
    getProjectFn = getProject,
    triageMode = null,
    acpPool = null,
    triageAgent = "claude",
    triageTimeoutMs = 60_000,
  } = {},
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
  });

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
  });

  return {
    status: "created",
    entry: updated || entry,
    candidateEntry: updated || entry,
    queueEntry,
    job: null,
  };
}

/**
 * List candidate events, optionally filtered by status or source.
 */
export async function listCandidates(cpbRoot, { status, source } = {}) {
  const file = candidateFile(cpbRoot);
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
export async function updateCandidate(cpbRoot, candidateId, { status, reason }) {
  return withCandidateLock(cpbRoot, async () => {
    const file = candidateFile(cpbRoot);
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
export function githubIssueToCandidate(issue, { projectId } = {}) {
  return {
    source: "github-issue",
    externalId: String(issue.number || issue.id),
    projectId: projectId || issue.projectId || null,
    priority: issue.labels?.some?.((l) => {
      const name = typeof l === "string" ? l : l.name;
      return name && /p0|critical|urgent|blocker/i.test(name);
    }) ? "high" : "normal",
    payload: {
      title: issue.title || `Issue #${issue.number}`,
      body: (issue.body || "").slice(0, 2000),
      labels: Array.isArray(issue.labels)
        ? issue.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean)
        : [],
      url: issue.url || null,
      state: issue.state || "OPEN",
    },
  };
}

/**
 * Normalize a CI failure into a candidate event.
 */
export function ciFailureToCandidate(failure, { projectId } = {}) {
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
