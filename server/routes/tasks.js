import { broadcast } from '../services/ws-broadcast.js';
import { getRunningTasks, getDurableTasks } from '../services/executor.js';
import { requestCancelJob, requestRedirectJob, retryJob } from '../services/job-store.js';
import { enqueue } from '../services/hub-queue.js';
import { getProject } from '../services/hub-registry.js';
import { resolveAcpLane } from '../../core/acp/policy.js';
import { registerJobArtifactDetailRoute } from './job-artifacts.js';

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

async function projectDataRoot(hubRoot, name) {
  if (!hubRoot) return undefined;
  try {
    const project = await getProject(hubRoot, name);
    return project?.projectRuntimeRoot || undefined;
  } catch {
    return undefined;
  }
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
    return getDurableTasks(req.cpbRoot);
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
      acpProfile = 'headless', uiLaneReason = '',
      priority = 'P2', issueNumber, issueUrl, repo, issueTitle,
      actor = 'api', agents, agent,
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

    if (!hasIssueLink) {
      throw fastify.httpErrors.badRequest(
        'pipeline requires issueUrl or repo+issueNumber for PR finalization'
      );
    }

    const entry = await enqueue(req.cpbHubRoot, {
      projectId: name,
      sourcePath: project.sourcePath,
      priority,
      description: task,
      type: 'api_pipeline',
      metadata: {
        source: 'api',
        workflow, planMode, acpProfile,
        uiLane: acpProfile === 'ui',
        uiLaneReason,
        autoFinalize: true,
        issueNumber: Number.isInteger(numericIssue) ? numericIssue : null,
        issueUrl: issueUrl || null,
        repo: resolvedRepo,
        issueTitle: issueTitle || task,
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
    const job = await requestCancelJob(req.cpbRoot, name, jobId, { reason, dataRoot });
    broadcast({ type: 'job:cancel_requested', project: name, jobId, reason });
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
    const dataRoot = await projectDataRoot(req.cpbHubRoot, name);
    const result = await retryJob(dataRoot, jobId, { force });
    broadcast({ type: 'job:retried', project: name, jobId, recoveryJobId: result?.jobId });
    return result;
  });
}
