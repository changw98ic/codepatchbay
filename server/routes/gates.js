import { listJobs, getJob } from "../services/job-store.js";
import { approveGate } from "../services/approval-gate.js";
import { requestCancelJob } from "../services/job-store.js";
import { broadcast } from "../services/ws-broadcast.js";

function isApprovalPending(job) {
  return job.status === "blocked" || job.phase === "approval_required"
    || (job.events && job.events.some(e => e.type === "approval_required"))
    || job.blockedReason?.includes("approval");
}

export async function gateRoutes(fastify) {

  // List pending approval gates
  fastify.get("/gates", async (req) => {
    const { project } = req.query || {};
    const jobs = await listJobs(req.cpbRoot, { project });
    const gates = jobs.filter(isApprovalPending).map(j => ({
      jobId: j.jobId,
      project: j.project,
      status: j.status,
      phase: j.phase,
      blockedReason: j.blockedReason || null,
      instruction: j.task || null,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    }));
    return { gates };
  });

  // Get gate status for a specific job
  fastify.get("/gates/:jobId", async (req) => {
    const { jobId } = req.params;
    const { project } = req.query || {};
    let job;
    if (project) {
      job = await getJob(req.cpbRoot, project, jobId);
    } else {
      const all = await listJobs(req.cpbRoot);
      job = all.find(j => j.jobId === jobId) || null;
    }
    if (!job?.jobId) throw fastify.httpErrors.notFound(`Job not found: ${jobId}`);

    return {
      jobId: job.jobId,
      project: job.project,
      status: job.status,
      phase: job.phase,
      blockedReason: job.blockedReason || null,
      instruction: job.task || null,
      approvalPending: isApprovalPending(job),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  });

  // Approve a pending gate
  fastify.post("/gates/:jobId/approve", async (req) => {
    const { jobId } = req.params;
    const { project, actor = "api" } = req.body || {};

    let job;
    if (project) {
      job = await getJob(req.cpbRoot, project, jobId);
    } else {
      const all = await listJobs(req.cpbRoot);
      job = all.find(j => j.jobId === jobId) || null;
    }
    if (!job?.jobId) throw fastify.httpErrors.notFound(`Job not found: ${jobId}`);
    if (!isApprovalPending(job)) {
      throw fastify.httpErrors.badRequest(`Job ${jobId} is not pending approval (status: ${job.status})`);
    }

    const updated = await approveGate(req.cpbRoot, job.project, jobId, {
      actor,
      action: "approved",
    });
    broadcast({ type: "gate:approved", project: job.project, jobId, actor });
    return { approved: true, job: updated };
  });

  // Deny (cancel) a pending gate
  fastify.post("/gates/:jobId/deny", async (req) => {
    const { jobId } = req.params;
    const { project, reason = "denied via API", actor = "api" } = req.body || {};

    let job;
    if (project) {
      job = await getJob(req.cpbRoot, project, jobId);
    } else {
      const all = await listJobs(req.cpbRoot);
      job = all.find(j => j.jobId === jobId) || null;
    }
    if (!job?.jobId) throw fastify.httpErrors.notFound(`Job not found: ${jobId}`);
    if (!isApprovalPending(job)) {
      throw fastify.httpErrors.badRequest(`Job ${jobId} is not pending approval (status: ${job.status})`);
    }

    const updated = await requestCancelJob(req.cpbRoot, job.project, jobId, { reason });
    broadcast({ type: "gate:denied", project: job.project, jobId, reason, actor });
    return { denied: true, job: updated };
  });
}
