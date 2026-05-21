import path from 'path';
import { spawn } from 'child_process';
import { broadcast } from '../services/ws-broadcast.js';
import { getRunningTasks, getDurableTasks, registerTask, unregisterTask } from '../services/executor.js';
import { requestCancelJob, requestRedirectJob } from '../services/job-store.js';
import { getProject } from '../services/hub-registry.js';
import { buildChildEnv, redactSecrets } from '../services/secret-policy.js';
import { resolveAcpLane } from '../services/acp-lane-policy.js';

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

async function projectRuntimeEnv(hubRoot, name) {
  if (!hubRoot) return {};
  try {
    const project = await getProject(hubRoot, name);
    const env = {};
    if (project?.projectRuntimeRoot) env.CPB_PROJECT_RUNTIME_ROOT = project.projectRuntimeRoot;
    return env;
  } catch {
    return {};
  }
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

  // Trigger planner phase
  fastify.post('/tasks/:name/plan', async (req) => {
    const { name } = req.params;
    const { task } = req.body || {};
    if (!task) throw fastify.httpErrors.badRequest('task required');
    const extraEnv = await projectRuntimeEnv(req.cpbHubRoot, name);
    return spawnBridge(req.cpbRoot, name, 'planner.sh', [name, task], req.log, '', extraEnv);
  });

  // Trigger executor phase
  fastify.post('/tasks/:name/execute', async (req) => {
    const { name } = req.params;
    const { planId } = req.body || {};
    if (!planId) throw fastify.httpErrors.badRequest('planId required');
    const extraEnv = await projectRuntimeEnv(req.cpbHubRoot, name);
    return spawnBridge(req.cpbRoot, name, 'executor.sh', [name, planId], req.log, '', extraEnv);
  });

  // Trigger verifier phase
  fastify.post('/tasks/:name/verify', async (req) => {
    const { name } = req.params;
    const { deliverableId } = req.body || {};
    if (!deliverableId) throw fastify.httpErrors.badRequest('deliverableId required');
    const extraEnv = await projectRuntimeEnv(req.cpbHubRoot, name);
    return spawnBridge(req.cpbRoot, name, 'verifier.sh', [name, deliverableId], req.log, '', extraEnv);
  });

  // Trigger full pipeline
  fastify.post('/tasks/:name/pipeline', async (req) => {
    const { name } = req.params;
    const { task, maxRetries = '3', timeout = '0', workflow = 'standard', acpProfile, uiLaneReason } = req.body || {};
    if (!task) throw fastify.httpErrors.badRequest('task required');
    if (acpProfile !== undefined) {
      const lane = resolveAcpLane({ profile: acpProfile, uiLaneReason });
      if (lane.error) throw fastify.httpErrors.badRequest(lane.error);
    }
    const extraEnv = await projectRuntimeEnv(req.cpbHubRoot, name);
    // Preserve ACP lane fields from API request (issue #62)
    // Slot 6 is JOB_ID in run-pipeline.sh — pass empty for no override
    const pipelineArgs = [name, task, maxRetries, timeout, workflow];
    if (acpProfile || uiLaneReason) pipelineArgs.push('');
    if (acpProfile) pipelineArgs.push('--acp-profile', acpProfile);
    if (uiLaneReason) pipelineArgs.push('--ui-lane-reason', uiLaneReason);
    return spawnBridge(req.cpbRoot, name, 'run-pipeline.sh', pipelineArgs, req.log, '', extraEnv);
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
}

const MAX_TAIL_BYTES = 65536; // 64KB tail buffer

export function spawnBridge(cpbRoot, project, script, args, log, providedTaskId = '', extraEnv = {}) {
  const scriptPath = path.join(cpbRoot, 'bridges', script);
  const taskId = providedTaskId || `${project}:${script}:${Date.now()}`;

  let child;
  try {
    child = spawn('bash', [scriptPath, ...args], {
      cwd: cpbRoot,
      env: buildChildEnv(process.env, { CPB_ROOT: cpbRoot, CPB_DANGEROUS: process.env.CPB_DANGEROUS || '0', ...extraEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    log?.error(`spawnBridge sync error for ${taskId}: ${err.message}`);
    return { accepted: false, taskId, error: err.message };
  }

  return new Promise((resolve) => {
    let settled = false;
    let registered = false;
    let totalBytes = 0;
    let tailBuffer = '';
    let outputTruncated = false;

    function appendOutput(text) {
      totalBytes += Buffer.byteLength(text, 'utf8');
      tailBuffer += text;
      if (tailBuffer.length > MAX_TAIL_BYTES) {
        tailBuffer = tailBuffer.slice(-MAX_TAIL_BYTES);
        outputTruncated = true;
      }
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      appendOutput(text);
      broadcast({ type: 'task:output', taskId, project, output: redactSecrets(text), stream: 'stdout' });
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      appendOutput(text);
      broadcast({ type: 'task:output', taskId, project, output: redactSecrets(text), stream: 'stderr' });
    });

    child.on('spawn', () => {
      if (settled) return;
      settled = true;
      registered = true;
      registerTask(taskId, project, script, child.pid);
      resolve({ accepted: true, taskId, pid: child.pid });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      log?.error(`spawnBridge async error for ${taskId}: ${err.message}`);
      resolve({ accepted: false, taskId, error: err.message });
    });

    child.on('exit', (code) => {
      if (registered) unregisterTask(taskId);
      broadcast({
        type: 'task:complete', taskId, project, script, exitCode: code,
        outputTail: redactSecrets(tailBuffer),
        outputBytes: totalBytes,
        outputTruncated,
      });
      log?.info(`Task ${taskId} exited with code ${code}`);
    });
  });
}
