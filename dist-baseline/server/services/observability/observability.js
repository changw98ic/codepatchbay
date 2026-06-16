// ── observability ──
import path from "node:path";
import { getManagedAcpPool } from "../acp/acp-pool.js";
import { deriveWorkerStatus, hubStatus, listProjects } from "../hub/hub-registry.js";
import { listQueue, queueStatus } from "../hub/hub-queue.js";
import { knowledgePolicySummary } from "../knowledge/knowledge.js";
import { listDispatches } from "../dispatch/dispatch.js";
import { redactSecrets } from "../secret-policy.js";
// buildChainSnapshot and analyzeChainSnapshot are defined locally below
import { WorkerStore, summarizeWorkers } from "../../../shared/orchestrator/worker-store.js";
export function redactDiagnostics(value, key = "") {
    return redactSecrets(value, key);
}
export async function buildObservabilitySummary({ cpbRoot, hubRoot, acpPool } = {}) {
    const pool = acpPool || getManagedAcpPool({ cpbRoot, hubRoot });
    const now = Date.now();
    const workerStore = new WorkerStore(hubRoot);
    const [hub, projects, queue, acpStatus, providerQuotas, dispatches, workers] = await Promise.all([
        hubStatus(hubRoot),
        listProjects(hubRoot),
        queueStatus(hubRoot),
        pool.status(),
        pool.readProviderQuotas(),
        listDispatches(hubRoot),
        workerStore.listWorkers(),
    ]);
    const registryWorkers = projects
        .filter((project) => project.worker)
        .map((project) => ({
        workerId: project.worker.workerId || project.id,
        projectId: project.id,
        pid: project.worker.pid || null,
        status: deriveWorkerStatus(project.worker),
        currentAssignmentId: project.worker.currentAssignmentId || null,
        startedAt: project.worker.startedAt || null,
        lastHeartbeatAt: project.worker.lastSeenAt || null,
    }));
    const workerIds = new Set(workers.map((worker) => worker.workerId));
    const allWorkers = [
        ...workers,
        ...registryWorkers.filter((worker) => !workerIds.has(worker.workerId)),
    ];
    const workerDetails = allWorkers.map((worker) => {
        const lastSeen = worker.lastHeartbeatAt || worker.startedAt || null;
        const ageMs = lastSeen ? now - new Date(lastSeen).getTime() : null;
        return {
            id: worker.workerId,
            status: worker.status || "unknown",
            projectId: worker.projectId || null,
            currentAssignmentId: worker.currentAssignmentId || null,
            pid: worker.pid || null,
            lastSeenAt: lastSeen || null,
            ageMs,
        };
    });
    const workerSummary = summarizeWorkers(allWorkers);
    const pools = {};
    const acpPoolSummary = {
        sessionAges: [],
        requestCounts: {},
        recycleCounts: {},
        promptByteTotals: {},
    };
    for (const [agent, state] of Object.entries(acpStatus.pools || {})) {
        const spawnAge = state.lastSpawnAt ? now - new Date(state.lastSpawnAt).getTime() : null;
        pools[agent] = {
            active: state.active ?? 0,
            limit: state.limit ?? 1,
            queued: state.queued ?? 0,
            requestCount: state.requestCount ?? 0,
            errorCount: state.errorCount ?? 0,
            recycleCount: state.recycleCount ?? 0,
            lastRecycleReason: state.lastRecycleReason || null,
            lastSpawnAt: state.lastSpawnAt || null,
            processAgeMs: spawnAge,
            rateLimitedUntil: state.rateLimitedUntil || null,
            mode: state.mode || "bounded-one-shot",
            transport: state.transport || "request-scoped-child-process",
            providerProcessReuse: state.providerProcessReuse ?? false,
            activeRequests: Array.isArray(state.activeRequests) ? state.activeRequests.length : 0,
        };
        if (state.sessionAgeMs != null) {
            acpPoolSummary.sessionAges.push({ agent, ageMs: state.sessionAgeMs });
        }
        acpPoolSummary.requestCounts[agent] = state.requestCount ?? 0;
        acpPoolSummary.recycleCounts[agent] = state.recycleCount ?? 0;
        const activeRequests = Array.isArray(state.activeRequests) ? state.activeRequests : [];
        acpPoolSummary.promptByteTotals[agent] = activeRequests.reduce((sum, r) => sum + (r.promptBytes || 0), 0);
    }
    const dispatchSummary = { total: 0, completed: 0, failed: 0, running: 0, assigned: 0, pending: 0 };
    for (const d of dispatches) {
        dispatchSummary.total++;
        if (dispatchSummary[d.status] !== undefined)
            dispatchSummary[d.status]++;
    }
    let observerBlockedChains = 0;
    let observerStaleProcesses = 0;
    let observerDuplicateReviews = 0;
    try {
        const queueEntries = await listQueue(hubRoot, { status: "in_progress" });
        for (const entry of queueEntries) {
            if (!entry.projectId)
                continue;
            try {
                const snapshot = await buildChainSnapshot({
                    cpbRoot,
                    hubRoot,
                    project: entry.projectId,
                    jobId: entry.metadata?.originJobId || entry.id,
                });
                const analysis = analyzeChainSnapshot(snapshot);
                if (analysis.recommendation === "blocked")
                    observerBlockedChains++;
                if (analysis.recommendation === "stale_process")
                    observerStaleProcesses++;
                if (analysis.recommendation === "dedupe")
                    observerDuplicateReviews++;
            }
            catch { }
        }
    }
    catch { }
    const projectRuntimeRoots = projects.reduce((acc, p) => {
        if (p.projectRuntimeRoot)
            acc[p.id] = p.projectRuntimeRoot;
        return acc;
    }, {});
    return {
        generatedAt: new Date().toISOString(),
        roots: {
            executorRoot: cpbRoot || undefined,
            hubRoot: hubRoot || undefined,
            projectRuntimeRoots,
        },
        workers: {
            ...workerSummary,
            online: workerSummary.online || 0,
            stale: workerSummary.stale || 0,
            offline: workerSummary.offline || 0,
            details: workerDetails,
        },
        queue,
        pools,
        acpPool: acpPoolSummary,
        providerQuotas,
        rateLimits: providerQuotas,
        dispatchSummary,
        observerBlockedChains,
        observerStaleProcesses,
        observerDuplicateReviews,
    };
}
export async function buildDiagnosticBundle({ cpbRoot, hubRoot, acpPool } = {}) {
    const pool = acpPool || getManagedAcpPool({ cpbRoot, hubRoot });
    const [hub, projects, queue, queueEntries, providerQuotas] = await Promise.all([
        hubStatus(hubRoot),
        listProjects(hubRoot),
        queueStatus(hubRoot),
        listQueue(hubRoot),
        pool.readProviderQuotas(),
    ]);
    return redactDiagnostics({
        generatedAt: new Date().toISOString(),
        runtime: {
            backend: "js",
            cpbRoot,
            hubRoot,
        },
        hub,
        projects,
        queue,
        queueEntries,
        acp: {
            ...pool.status(),
            providerQuotas,
            rateLimits: providerQuotas,
        },
        knowledgePolicy: knowledgePolicySummary(),
    });
}
// ── observer ──
import { readEvents, materializeJob } from "../event/event-store.js";
import { readLease, isLeaseStale } from "../infra.js";
import { listInboxMessages } from "../hub/hub-queue.js";
import { listSessions } from "../review/review-session.js";
const EVENT_TAIL_SIZE = 10;
export async function buildChainSnapshot({ cpbRoot, hubRoot, project, jobId }) {
    const timestamp = new Date().toISOString();
    const snapshot = {
        job: null,
        eventTail: [],
        lease: null,
        acpPool: null,
        queueEntry: null,
        inboxPending: 0,
        reviewSession: null,
        timestamp,
    };
    let events = [];
    try {
        events = await readEvents(cpbRoot, project, jobId);
        if (events.length > 0) {
            snapshot.job = materializeJob(events);
        }
        snapshot.eventTail = events.slice(-EVENT_TAIL_SIZE);
    }
    catch { }
    if (snapshot.job?.leaseId) {
        try {
            snapshot.lease = await readLease(cpbRoot, snapshot.job.leaseId);
        }
        catch { }
    }
    try {
        const pool = getManagedAcpPool({ cpbRoot, hubRoot });
        snapshot.acpPool = pool.status();
    }
    catch { }
    if (hubRoot) {
        try {
            const entries = await listQueue(hubRoot);
            snapshot.queueEntry =
                entries.find((e) => e.metadata?.originJobId === jobId ||
                    (e.projectId === project && e.status === "in_progress")) || null;
        }
        catch { }
        try {
            const msgs = await listInboxMessages(cpbRoot, project, {
                status: "pending",
            });
            snapshot.inboxPending = msgs.length;
        }
        catch { }
    }
    try {
        const sessions = await listSessions(cpbRoot);
        snapshot.reviewSession =
            sessions.find((s) => s.jobId === jobId) || null;
    }
    catch { }
    return snapshot;
}
export function analyzeChainSnapshot(snapshot) {
    const { job, eventTail, lease, acpPool, queueEntry, reviewSession } = snapshot;
    const reasons = [];
    const details = {};
    if (!job || !job.jobId) {
        return {
            recommendation: "wait",
            reasons: ["no job state found"],
            details: {},
        };
    }
    details.jobId = job.jobId;
    details.status = job.status;
    details.phase = job.phase;
    if (lease) {
        try {
            if (isLeaseStale(lease)) {
                reasons.push(`lease expired at ${lease.expiresAt}`);
                details.staleLeaseId = lease.leaseId;
                details.staleExpiresAt = lease.expiresAt;
                return { recommendation: "stale_process", reasons, details };
            }
        }
        catch {
            reasons.push("lease is malformed or unreadable");
            return { recommendation: "stale_process", reasons, details };
        }
    }
    const blockedReasons = [];
    if (job.status === "blocked") {
        blockedReasons.push(job.blockedReason || "job is blocked");
    }
    for (const evt of eventTail) {
        if (evt.type === "permission_denied") {
            blockedReasons.push(`permission_denied: ${evt.category || "infra"} ${evt.action || ""}`);
        }
        if (evt.type === "job_blocked") {
            blockedReasons.push(`job_blocked: ${evt.reason || "unknown"}`);
        }
    }
    if (acpPool?.pools) {
        for (const [agent, info] of Object.entries(acpPool.pools)) {
            if (info.rateLimitedUntil) {
                blockedReasons.push(`provider rate limited: ${agent} until ${info.rateLimitedUntil}`);
            }
        }
    }
    if (blockedReasons.length > 0) {
        reasons.push(...blockedReasons);
        details.blockedReasons = blockedReasons;
        return { recommendation: "blocked", reasons, details };
    }
    const terminalStatuses = new Set(["failed", "cancelled"]);
    if (terminalStatuses.has(job.status)) {
        reasons.push(`job is terminal: ${job.status}`);
        if (job.blockedReason)
            details.failureReason = job.blockedReason;
        if (job.failureCode)
            details.failureCode = job.failureCode;
        return { recommendation: "recover_as_new_job", reasons, details };
    }
    if (reviewSession) {
        if (queueEntry && reviewSession.jobId === job.jobId) {
            reasons.push("job has both review session and queue entry");
            details.dedupeSessionId = reviewSession.sessionId;
            details.dedupeQueueId = queueEntry.id;
            return { recommendation: "dedupe", reasons, details };
        }
    }
    if (reviewSession?.idempotency?.dispatchKey) {
        details.dispatchKey = reviewSession.idempotency.dispatchKey;
    }
    if (job.status === "running" && lease && job.phase) {
        const recentActivity = eventTail.filter((e) => e.type === "phase_activity" || e.type === "phase_started");
        if (recentActivity.length > 0) {
            const lastActivityTs = recentActivity[recentActivity.length - 1].ts || null;
            if (lastActivityTs) {
                const ageMs = Date.now() - new Date(lastActivityTs).getTime();
                details.lastActivityAgeMs = ageMs;
                if (ageMs < 240_000) {
                    reasons.push("job has active lease and recent events");
                    return { recommendation: "continue", reasons, details };
                }
            }
        }
        reasons.push("job has active lease and phase in progress");
        return { recommendation: "continue", reasons, details };
    }
    if (job.status === "running") {
        reasons.push("job is running, no issues detected");
        return { recommendation: "wait", reasons, details };
    }
    if (job.status === "completed") {
        reasons.push("job completed successfully");
        return { recommendation: "wait", reasons, details };
    }
    reasons.push(`job status: ${job.status}, no specific action needed`);
    return { recommendation: "wait", reasons, details };
}
// ── performance-tracker ──
import { readFile, mkdir as mkdirPerf } from "node:fs/promises";
import { appendEvent } from "../event/event-store.js";
const PERFORMANCE_DIR = "performance";
function perfDir(cpbRoot, options = {}) {
    if (!options.dataRoot)
        throw new Error("dataRoot is required");
    return path.join(path.resolve(options.dataRoot), PERFORMANCE_DIR);
}
function agentKey(agent, role, phase) {
    return `${agent}:${role}:${phase}`;
}
/**
 * Record a performance entry from a completed job phase.
 * Writes a performance_recorded event and appends to agent metrics file.
 */
export async function recordPerformance(cpbRoot, project, jobId, entry) {
    const { agent, role, phase, status, durationMs, error, ts } = entry;
    if (!agent || !phase)
        return;
    if (!entry.dataRoot)
        throw new Error("dataRoot is required");
    try {
        await appendEvent(cpbRoot, project, jobId, {
            type: "performance_recorded",
            agent,
            role: role || null,
            phase,
            status,
            durationMs: durationMs || null,
            error: error || null,
            ts: ts || new Date().toISOString(),
        }, entry.dataRoot ? { dataRoot: entry.dataRoot, includeLegacyFallback: false } : {});
    }
    catch { }
    const dir = perfDir(cpbRoot, entry);
    await mkdirPerf(dir, { recursive: true });
    const file = path.join(dir, `${agent}.jsonl`);
    const line = JSON.stringify({
        ts: ts || new Date().toISOString(),
        project,
        jobId,
        role: role || null,
        phase,
        status,
        durationMs: durationMs || null,
        error: error || null,
    });
    await appendLine(file, line);
}
/**
 * Get aggregated performance metrics for an agent.
 */
export async function getAgentPerformance(cpbRoot, agent, options = {}) {
    const dir = perfDir(cpbRoot, options);
    const file = path.join(dir, `${agent}.jsonl`);
    let lines;
    try {
        const raw = await readFile(file, "utf8");
        lines = raw.split("\n").filter((l) => l.trim());
    }
    catch {
        return { agent, entries: 0, totalRequests: 0, totalErrors: 0, avgDurationMs: null, phases: {} };
    }
    const entries = lines.map((l) => {
        try {
            return JSON.parse(l);
        }
        catch {
            return null;
        }
    }).filter(Boolean);
    const totalRequests = entries.length;
    const totalErrors = entries.filter((e) => e.status === "failed").length;
    const durations = entries.map((e) => e.durationMs).filter((d) => d && d > 0);
    const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    const phases = {};
    for (const e of entries) {
        if (!phases[e.phase])
            phases[e.phase] = { count: 0, failures: 0 };
        phases[e.phase].count++;
        if (e.status === "failed")
            phases[e.phase].failures++;
    }
    return { agent, entries: totalRequests, totalRequests, totalErrors, avgDurationMs, phases };
}
/**
 * Record a quality score for an agent based on verifier verdict.
 */
export async function recordQualityScore(cpbRoot, project, jobId, { agent, phase, verdict, ts }) {
    try {
        await appendEvent(cpbRoot, project, jobId, {
            type: "agent_quality_scored",
            agent,
            phase,
            verdict,
            ts: ts || new Date().toISOString(),
        });
    }
    catch { }
    const dir = perfDir(cpbRoot);
    await mkdirPerf(dir, { recursive: true });
    const file = path.join(dir, `${agent}-quality.jsonl`);
    await appendLine(file, JSON.stringify({
        ts: ts || new Date().toISOString(),
        project,
        jobId,
        phase,
        verdict,
    }));
}
/**
 * Get quality metrics for an agent.
 */
export async function getAgentQuality(cpbRoot, agent) {
    const dir = perfDir(cpbRoot);
    const file = path.join(dir, `${agent}-quality.jsonl`);
    let lines;
    try {
        const raw = await readFile(file, "utf8");
        lines = raw.split("\n").filter((l) => l.trim());
    }
    catch {
        return { agent, total: 0, pass: 0, fail: 0, passRate: null };
    }
    const entries = lines.map((l) => {
        try {
            return JSON.parse(l);
        }
        catch {
            return null;
        }
    }).filter(Boolean);
    const pass = entries.filter((e) => e.verdict === "PASS").length;
    const fail = entries.filter((e) => e.verdict === "FAIL").length;
    const total = entries.length;
    return {
        agent,
        total,
        pass,
        fail,
        passRate: total > 0 ? Math.round((pass / total) * 100) : null,
    };
}
async function appendLine(file, line) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, line + "\n", "utf8");
}
// ── diagnostics-bundle ──
import { listJobs } from "../job/job-store.js";
function jobSummary(job) {
    return {
        jobId: job.jobId,
        project: job.project,
        status: job.status,
        workflow: job.workflow,
        task: job.task,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        currentPhase: job.currentPhase || null,
        failureCode: job.failureCode || null,
        retryCount: job.retryCount || 0,
    };
}
export async function gatherDiagnostics({ cpbRoot, hubRoot, recentJobsLimit = 5, acpPool = null, } = {}) {
    const errors = [];
    let hub;
    try {
        hub = await hubStatus(hubRoot);
    }
    catch (e) {
        errors.push({ source: "hub-status", message: e.message });
        hub = { hubRoot: path.resolve(hubRoot), projectCount: 0, enabledProjectCount: 0 };
    }
    let managedWorkers = [];
    try {
        const workerStore = new WorkerStore(hubRoot);
        managedWorkers = await workerStore.listWorkers();
    }
    catch (e) {
        errors.push({ source: "workers", message: e.message });
    }
    let projects = [];
    try {
        projects = await listProjects(hubRoot);
    }
    catch (e) {
        errors.push({ source: "projects", message: e.message });
    }
    let queue;
    try {
        queue = await queueStatus(hubRoot);
    }
    catch (e) {
        errors.push({ source: "queue", message: e.message });
        queue = { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 };
    }
    let acp;
    try {
        if (acpPool) {
            const providerQuotas = await acpPool.readProviderQuotas();
            acp = { ...acpPool.status(), providerQuotas, rateLimits: providerQuotas };
        }
        else {
            const { AcpPool } = await import("../acp/acp-pool.js");
            const pool = new AcpPool({ cpbRoot, hubRoot });
            const providerQuotas = await pool.readProviderQuotas();
            acp = { ...pool.status(), providerQuotas, rateLimits: providerQuotas };
        }
    }
    catch (e) {
        errors.push({ source: "acp-pool", message: e.message });
        acp = { pools: {}, providerQuotas: {}, rateLimits: {} };
    }
    let knowledgePolicy;
    try {
        knowledgePolicy = knowledgePolicySummary();
    }
    catch (e) {
        errors.push({ source: "knowledge-policy", message: e.message });
        knowledgePolicy = null;
    }
    let recentJobs = [];
    try {
        const allJobs = await listJobs(cpbRoot);
        recentJobs = allJobs.slice(0, recentJobsLimit).map(jobSummary);
    }
    catch (e) {
        errors.push({ source: "jobs", message: e.message });
    }
    const result = {
        gatheredAt: new Date().toISOString(),
        cpbRoot: path.resolve(cpbRoot),
        roots: {
            executorRoot: path.resolve(cpbRoot),
            hubRoot: path.resolve(hubRoot),
            projectRuntimeRoots: projects.reduce((acc, p) => {
                if (p.projectRuntimeRoot)
                    acc[p.id] = p.projectRuntimeRoot;
                return acc;
            }, {}),
        },
        hub: {
            hubRoot: hub.hubRoot,
            projectCount: hub.projectCount,
            enabledProjectCount: hub.enabledProjectCount,
            updatedAt: hub.updatedAt,
        },
        workers: {
            ...summarizeWorkers(managedWorkers),
            details: managedWorkers,
        },
        projectIds: projects.map((p) => p.id),
        queue,
        acp,
        knowledgePolicy,
        recentJobs,
        errors: errors.length ? errors : undefined,
    };
    return redactSecrets(result);
}
export { redactSecrets };
