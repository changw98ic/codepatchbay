// @ts-nocheck
import { broadcast } from '../services/ws-broadcast.js';
import { getRunningTasks, getDurableTasks } from '../services/executor.js';
import { cancelJob, requestRedirectJob, retryJob } from '../services/job-store.js';
import { enqueue } from '../services/hub-queue.js';
import { getProject } from '../services/hub-registry.js';
import { resolveAcpLane } from '../../core/acp/policy.js';
import { resolveTaskRoute } from '../../core/workflow/auto-route.js';
import { registerJobArtifactDetailRoute } from './job-artifacts.js';
import { buildReviewBundle } from '../services/review-bundle.js';
import { acceptReviewBundle, rejectReviewBundle, isReviewLoopError } from '../services/review-loop.js';

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const SAFE_JOB_ID = /^job-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeJobId(value) {
  const jobId = String(value || "");
  return SAFE_JOB_ID.test(jobId) && !jobId.includes("..");
}

async function projectDataRoot(hubRoot, name) {
  if (!hubRoot) return undefined;
  try {
    const project = await getProject(hubRoot, name);
    return project?.projectRuntimeRoot || undefined;
  } catch {
    return undefined;
  }
}

function sendReviewLoopError(reply, error) {
  if (!isReviewLoopError(error)) throw error;
  return reply.code(error.statusCode).send({ error: error.message, code: error.code });
}

export async function taskRoutes(fastify, opts) {

  // Validate project name param
  fastify.addHook('preHandler', (req, _res, done) => {
    const { name } = req.params;
    if (name && !SAFE_NAME.test(name)) {
      return done(fastify.httpErrors.badRequest('Invalid project name'));
    }
    done();
  });

  // Get running tasks
  fastify.get('/tasks/running', async () => {
    return getRunningTasks();
  });

  // Get durable tasks
  fastify.get('/tasks/durable', async (req) => {
    return getDurableTasks(req.cpbRoot, { hubRoot: req.cpbHubRoot });
  });

  registerJobArtifactDetailRoute(fastify, '/tasks/:name/jobs/:jobId/artifacts', {
    projectParam: 'name',
    resolveDataRoot: (req, name) => projectDataRoot(req.cpbHubRoot, name),
  });

  // Enqueue pipeline task
  fastify.post('/tasks/:name/pipeline', async (req) => {
    const { name } = req.params;
    const body = req.body || {};
    const {
      task, workflow = 'standard', planMode = 'auto',
      triageMode = 'auto',
      acpProfile = 'headless', uiLaneReason = '',
      priority = 'P2', issueNumber, issueUrl, repo, issueTitle,
      actor = 'api', agents, agent, autoFinalize, maxRetries, timeoutSeconds,
    } = body;

    if (!task) throw fastify.httpErrors.badRequest('task required');

    const lane = resolveAcpLane({ profile: acpProfile, uiLaneReason });
    if (lane.error) throw fastify.httpErrors.badRequest(lane.error);

    const project = await getProject(req.cpbHubRoot, name);
    if (!project) throw fastify.httpErrors.notFound(`Project '${name}' not found`);
    if (!project.sourcePath) {
      throw fastify.httpErrors.badRequest(`Project '${name}' has no sourcePath`);
    }

    const resolvedRepo = repo || project.github?.fullName || null;
    const numericIssue = Number(issueNumber);
    const hasIssueLink = issueUrl || (resolvedRepo && Number.isInteger(numericIssue) && numericIssue > 0);
    const shouldAutoFinalize = autoFinalize === undefined ? true : Boolean(autoFinalize);
    const route = resolveTaskRoute({
      task,
      workflow,
      planMode,
      triageMode,
      workflowExplicit: Object.hasOwn(body, 'workflow'),
      planModeExplicit: Object.hasOwn(body, 'planMode'),
      actor,
    });

    const entry = await enqueue(req.cpbHubRoot, {
      projectId: name,
      sourcePath: project.sourcePath,
      priority,
      description: task,
      type: 'api_pipeline',
      metadata: {
        source: 'api',
        workflow: route.workflow,
        planMode: route.planMode,
        triageMode,
        routeDecision: route.decision || undefined,
        acpProfile,
        uiLane: acpProfile === 'ui',
        uiLaneReason,
        autoFinalize: shouldAutoFinalize,
        issueNumber: Number.isInteger(numericIssue) ? numericIssue : null,
        issueUrl: issueUrl || null,
        repo: resolvedRepo,
        issueTitle: issueTitle || task,
        maxRetries: Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : undefined,
        timeoutSeconds: Number.isFinite(Number(timeoutSeconds)) ? Number(timeoutSeconds) : undefined,
        actor,
        requestedAt: new Date().toISOString(),
        agents: agents || undefined,
        agent: agent || undefined,
      },
    });

    return { queued: true, entry };
  });

  // Cancel a running job
  fastify.post('/tasks/:name/cancel', async (req) => {
    const { name } = req.params;
    const { jobId, reason } = req.body || {};
    if (!jobId) throw fastify.httpErrors.badRequest('jobId required');
    const dataRoot = await projectDataRoot(req.cpbHubRoot, name);
    const job = await cancelJob(req.cpbRoot, name, jobId, { reason, dataRoot });
    broadcast({ type: 'job:cancelled', project: name, jobId, reason });
    return job;
  });

  // Redirect a running job
  fastify.post('/tasks/:name/redirect', async (req) => {
    const { name } = req.params;
    const { jobId, instructions, reason } = req.body || {};
    if (!jobId) throw fastify.httpErrors.badRequest('jobId required');
    if (!instructions) throw fastify.httpErrors.badRequest('instructions required');
    const dataRoot = await projectDataRoot(req.cpbHubRoot, name);
    const job = await requestRedirectJob(req.cpbRoot, name, jobId, { instructions, reason, dataRoot });
    broadcast({ type: 'job:redirect_requested', project: name, jobId, instructions, reason });
    return job;
  });

  // Retry a failed/cancelled job
  fastify.post('/tasks/:name/retry/:jobId', async (req) => {
    const { name, jobId } = req.params;
    const { force = false } = req.body || {};
    if (!isSafeJobId(jobId)) throw fastify.httpErrors.badRequest('Invalid job id');
    const dataRoot = await projectDataRoot(req.cpbHubRoot, name);
    const result = await retryJob(req.cpbRoot, name, jobId, { force, dataRoot });
    broadcast({ type: 'job:retried', project: name, jobId, recoveryJobId: result?.jobId });
    return result;
  });

  // Get review bundle for a job
  fastify.get('/tasks/:name/jobs/:jobId/review-bundle', async (req) => {
    const { name, jobId } = req.params;
    if (!isSafeJobId(jobId)) throw fastify.httpErrors.badRequest('Invalid job id');
    const dataRoot = await projectDataRoot(req.cpbHubRoot, name);
    const bundle = await buildReviewBundle(req.cpbRoot, name, jobId, { dataRoot });
    return bundle;
  });

  fastify.post('/tasks/:name/jobs/:jobId/review-bundle/accept', async (req, reply) => {
    const { name, jobId } = req.params;
    const { actor = 'api', feedback = '' } = req.body || {};
    if (!isSafeJobId(jobId)) throw fastify.httpErrors.badRequest('Invalid job id');
    const project = await getProject(req.cpbHubRoot, name);
    if (!project) throw fastify.httpErrors.notFound(`Project '${name}' not found`);
    const dataRoot = project.projectRuntimeRoot || await projectDataRoot(req.cpbHubRoot, name);
    let result;
    try {
      result = await acceptReviewBundle(req.cpbRoot, name, jobId, {
        actor,
        feedback,
        dataRoot,
      });
    } catch (error) {
      return sendReviewLoopError(reply, error);
    }
    broadcast({ type: 'review_bundle:accepted', project: name, jobId, round: result.round });
    return result;
  });

  fastify.post('/tasks/:name/jobs/:jobId/review-bundle/reject', async (req, reply) => {
    const { name, jobId } = req.params;
    const { actor = 'api', feedback } = req.body || {};
    if (!isSafeJobId(jobId)) throw fastify.httpErrors.badRequest('Invalid job id');
    if (!feedback || !String(feedback).trim()) throw fastify.httpErrors.badRequest('feedback required');
    const project = await getProject(req.cpbHubRoot, name);
    if (!project) throw fastify.httpErrors.notFound(`Project '${name}' not found`);
    const dataRoot = project.projectRuntimeRoot || await projectDataRoot(req.cpbHubRoot, name);
    let result;
    try {
      result = await rejectReviewBundle(req.cpbRoot, name, jobId, {
        actor,
        feedback,
        hubRoot: req.cpbHubRoot,
        sourcePath: project.sourcePath || null,
        dataRoot,
      });
    } catch (error) {
      return sendReviewLoopError(reply, error);
    }
    broadcast({
      type: 'review_bundle:rejected',
      project: name,
      jobId,
      round: result.round,
      retryQueueEntryId: result.retryQueueEntry?.id,
    });
    return result;
  });
}
