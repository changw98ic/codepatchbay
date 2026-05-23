import { readEvents, materializeJob } from "./event-store.js";
import { readLease, isLeaseStale } from "./lease-manager.js";
import { getManagedAcpPool } from "../../runtime/acp-pool.js";
import { listQueue } from "./hub-queue.js";
import { listInboxMessages } from "./inbox-mail.js";
import { listSessions } from "./review-session.js";

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

  // 1. Materialize job state + event tail
  let events = [];
  try {
    events = await readEvents(cpbRoot, project, jobId);
    if (events.length > 0) {
      snapshot.job = materializeJob(events);
    }
    snapshot.eventTail = events.slice(-EVENT_TAIL_SIZE);
  } catch {}

  // 2. Lease state
  if (snapshot.job?.leaseId) {
    try {
      snapshot.lease = await readLease(cpbRoot, snapshot.job.leaseId);
    } catch {}
  }

  // 3. ACP pool status
  try {
    const pool = getManagedAcpPool({ cpbRoot, hubRoot });
    snapshot.acpPool = pool.status();
  } catch {}

  // 4. Queue entry matching this job
  if (hubRoot) {
    try {
      const entries = await listQueue(hubRoot);
      snapshot.queueEntry =
        entries.find(
          (e) =>
            e.metadata?.originJobId === jobId ||
            (e.projectId === project && e.status === "in_progress"),
        ) || null;
    } catch {}

    // 5. Inbox pending count
    try {
      const msgs = await listInboxMessages(cpbRoot, project, {
        status: "pending",
      });
      snapshot.inboxPending = msgs.length;
    } catch {}
  }

  // 6. Review session matching this job
  try {
    const sessions = await listSessions(cpbRoot);
    snapshot.reviewSession =
      sessions.find((s) => s.jobId === jobId) || null;
  } catch {}

  return snapshot;
}

export function analyzeChainSnapshot(snapshot) {
  const { job, eventTail, lease, acpPool, queueEntry, reviewSession } = snapshot;
  const reasons = [];
  const details = {};

  // No job found — nothing to analyze
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

  // --- Stale process: lease heartbeat expired ---
  if (lease) {
    try {
      if (isLeaseStale(lease)) {
        reasons.push(`lease expired at ${lease.expiresAt}`);
        details.staleLeaseId = lease.leaseId;
        details.staleExpiresAt = lease.expiresAt;
        return { recommendation: "stale_process", reasons, details };
      }
    } catch {
      // Malformed lease — treat as stale
      reasons.push("lease is malformed or unreadable");
      return { recommendation: "stale_process", reasons, details };
    }
  }

  // --- Blocked: infra denial, rate limit, permission denied ---
  const blockedReasons = [];
  if (job.status === "blocked") {
    blockedReasons.push(job.blockedReason || "job is blocked");
  }

  // Scan event tail for permission_denied or rate-limit signals
  for (const evt of eventTail) {
    if (evt.type === "permission_denied") {
      blockedReasons.push(
        `permission_denied: ${evt.category || "infra"} ${evt.action || ""}`,
      );
    }
    if (evt.type === "job_blocked") {
      blockedReasons.push(`job_blocked: ${evt.reason || "unknown"}`);
    }
  }

  // Check ACP pool for provider rate limits
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

  // --- Recovery: terminal failed/cancelled job ---
  const terminalStatuses = new Set(["failed", "cancelled"]);
  if (terminalStatuses.has(job.status)) {
    reasons.push(`job is terminal: ${job.status}`);
    if (job.blockedReason) details.failureReason = job.blockedReason;
    if (job.failureCode) details.failureCode = job.failureCode;
    return { recommendation: "recover_as_new_job", reasons, details };
  }

  // --- Dedupe: duplicate review/dispatch detected ---
  if (reviewSession) {
    // Check for multiple sessions matching the same job
    // (the snapshot only holds one, but we can flag if session exists alongside queue entry)
    if (queueEntry && reviewSession.jobId === job.jobId) {
      reasons.push("job has both review session and queue entry");
      details.dedupeSessionId = reviewSession.sessionId;
      details.dedupeQueueId = queueEntry.id;
      return { recommendation: "dedupe", reasons, details };
    }
  }

  // Check for idempotency key conflicts across sessions
  // This is a lightweight check: if session has a dispatchKey that matches
  if (reviewSession?.idempotency?.dispatchKey) {
    details.dispatchKey = reviewSession.idempotency.dispatchKey;
  }

  // --- Continue: actively progressing ---
  if (job.status === "running" && lease && job.phase) {
    const recentActivity = eventTail.filter(
      (e) => e.type === "phase_activity" || e.type === "phase_started",
    );
    if (recentActivity.length > 0) {
      const lastActivityTs =
        recentActivity[recentActivity.length - 1].ts || null;
      if (lastActivityTs) {
        const ageMs = Date.now() - new Date(lastActivityTs).getTime();
        details.lastActivityAgeMs = ageMs;
        // If last activity within 2x typical TTL (240s), consider it active
        if (ageMs < 240_000) {
          reasons.push("job has active lease and recent events");
          return { recommendation: "continue", reasons, details };
        }
      }
    }
    // Has lease + phase but no recent activity — still running
    reasons.push("job has active lease and phase in progress");
    return { recommendation: "continue", reasons, details };
  }

  // --- Wait: active lease/process within TTL, no apparent issue ---
  if (job.status === "running") {
    reasons.push("job is running, no issues detected");
    return { recommendation: "wait", reasons, details };
  }

  if (job.status === "completed") {
    reasons.push("job completed successfully");
    return { recommendation: "wait", reasons, details };
  }

  // Default fallback
  reasons.push(`job status: ${job.status}, no specific action needed`);
  return { recommendation: "wait", reasons, details };
}
