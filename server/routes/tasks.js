import path from 'path';
import { spawn } from 'child_process';
import { broadcast } from '../index.js';
import { getRunningTasks, getDurableTasks, registerTask, unregisterTask } from '../services/executor.js';
import { createJob } from '../services/job-store.js';

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export async function taskRoutes(fastify, opts) {
  const { prefix } = opts;

  // Validate project name param
  fastify.addHook('preHandler', (req, _res, done) => {
    const { name } = req.params;
    if (name && !SAFE_NAME.test(name)) {
      return done(fastify.httpErrors.badRequest('Invalid project name'));
    }
    done();
  });

  // Get running tasks
  fastify.get(`${prefix}/tasks/running`, async () => {
    return getRunningTasks();
  });

  // Get durable tasks
  fastify.get(`${prefix}/tasks/durable`, async (req) => {
    return getDurableTasks(req.flowRoot);
  });

  // Trigger Codex plan
  fastify.post(`${prefix}/tasks/:name/plan`, async (req) => {
    const { name } = req.params;
    const { task } = req.body || {};
    if (!task) throw fastify.httpErrors.badRequest('task required');
    return spawnBridge(req.flowRoot, name, 'codex-plan.sh', [name, task], req.log);
  });

  // Trigger Claude execute
  fastify.post(`${prefix}/tasks/:name/execute`, async (req) => {
    const { name } = req.params;
    const { planId } = req.body || {};
    if (!planId) throw fastify.httpErrors.badRequest('planId required');
    return spawnBridge(req.flowRoot, name, 'claude-execute.sh', [name, planId], req.log);
  });

  // Trigger Codex verify
  fastify.post(`${prefix}/tasks/:name/verify`, async (req) => {
    const { name } = req.params;
    const { deliverableId } = req.body || {};
    if (!deliverableId) throw fastify.httpErrors.badRequest('deliverableId required');
    return spawnBridge(req.flowRoot, name, 'codex-verify.sh', [name, deliverableId], req.log);
  });

  // Trigger full pipeline
  fastify.post(`${prefix}/tasks/:name/pipeline`, async (req) => {
    const { name } = req.params;
    const { task, maxRetries = '3', timeout = '0' } = req.body || {};
    if (!task) throw fastify.httpErrors.badRequest('task required');

    const job = await createJob(req.flowRoot, {
      project: name,
      task,
      workflow: 'standard',
    });

    return spawnBridge(req.flowRoot, name, 'run-pipeline.sh', [name, task, maxRetries, timeout], req.log, job.jobId);
  });
}

function spawnBridge(flowRoot, project, script, args, log, providedTaskId = '') {
  const scriptPath = path.join(flowRoot, 'bridges', script);
  const taskId = providedTaskId || `${project}:${script}:${Date.now()}`;

  const child = spawn('bash', [scriptPath, ...args], {
    cwd: flowRoot,
    env: { ...process.env, FLOW_ROOT: flowRoot, FLOW_DANGEROUS: process.env.FLOW_DANGEROUS || '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  registerTask(taskId, project, script, child.pid);

  // Stream stdout/stderr to WebSocket
  let output = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    broadcast({ type: 'task:output', taskId, project, output: text, stream: 'stdout' });
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    broadcast({ type: 'task:output', taskId, project, output: text, stream: 'stderr' });
  });

  child.on('exit', (code) => {
    unregisterTask(taskId);
    broadcast({ type: 'task:complete', taskId, project, script, exitCode: code, output });
    log?.info(`Task ${taskId} exited with code ${code}`);
  });

  return { accepted: true, taskId, pid: child.pid };
}
