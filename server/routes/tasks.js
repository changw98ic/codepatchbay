import path from 'path';
import { spawn } from 'child_process';
import { broadcast } from '../services/ws-broadcast.js';
import { getRunningTasks, getDurableTasks, registerTask, unregisterTask } from '../services/executor.js';
import { requestCancelJob, requestRedirectJob } from '../services/job-store.js';

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

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

  // Trigger Codex plan
  fastify.post('/tasks/:name/plan', async (req) => {
    const { name } = req.params;
    const { task } = req.body || {};
    if (!task) throw fastify.httpErrors.badRequest('task required');
    return spawnBridge(req.cpbRoot, name, 'codex-plan.sh', [name, task], req.log);
  });

  // Trigger Claude execute
  fastify.post('/tasks/:name/execute', async (req) => {
    const { name } = req.params;
    const { planId } = req.body || {};
    if (!planId) throw fastify.httpErrors.badRequest('planId required');
    return spawnBridge(req.cpbRoot, name, 'claude-execute.sh', [name, planId], req.log);
  });

  // Trigger Codex verify
  fastify.post('/tasks/:name/verify', async (req) => {
    const { name } = req.params;
    const { deliverableId } = req.body || {};
    if (!deliverableId) throw fastify.httpErrors.badRequest('deliverableId required');
    return spawnBridge(req.cpbRoot, name, 'codex-verify.sh', [name, deliverableId], req.log);
  });

  // Trigger full pipeline
  fastify.post('/tasks/:name/pipeline', async (req) => {
    const { name } = req.params;
    const { task, maxRetries = '3', timeout = '0', workflow = 'standard' } = req.body || {};
    if (!task) throw fastify.httpErrors.badRequest('task required');

    return spawnBridge(req.cpbRoot, name, 'run-pipeline.sh', [name, task, maxRetries, timeout, workflow], req.log);
  });

  // Cancel a running job
  fastify.post('/tasks/:name/cancel', async (req) => {
    const { name } = req.params;
    const { jobId, reason } = req.body || {};
    if (!jobId) throw fastify.httpErrors.badRequest('jobId required');
    const job = await requestCancelJob(req.cpbRoot, name, jobId, { reason });
    broadcast({ type: 'job:cancel_requested', project: name, jobId, reason });
    return job;
  });

  // Redirect a running job
  fastify.post('/tasks/:name/redirect', async (req) => {
    const { name } = req.params;
    const { jobId, instructions, reason } = req.body || {};
    if (!jobId) throw fastify.httpErrors.badRequest('jobId required');
    if (!instructions) throw fastify.httpErrors.badRequest('instructions required');
    const job = await requestRedirectJob(req.cpbRoot, name, jobId, { instructions, reason });
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
      env: { ...process.env, CPB_ROOT: cpbRoot, CPB_DANGEROUS: process.env.CPB_DANGEROUS || '0', ...extraEnv },
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
      broadcast({ type: 'task:output', taskId, project, output: text, stream: 'stdout' });
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      appendOutput(text);
      broadcast({ type: 'task:output', taskId, project, output: text, stream: 'stderr' });
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
        outputTail: tailBuffer,
        outputBytes: totalBytes,
        outputTruncated,
      });
      log?.info(`Task ${taskId} exited with code ${code}`);
    });
  });
}
