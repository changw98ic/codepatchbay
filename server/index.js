import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import sensible from '@fastify/sensible';
import { fileURLToPath } from 'url';
import path from 'path';
import { accessSync, constants, existsSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { registerWatcher } from './services/watcher.js';
import { projectRoutes } from './routes/projects.js';
import { taskRoutes } from './routes/tasks.js';
import { channelRoutes } from './routes/channels.js';
import { reviewRoutes } from './routes/review.js';
import { evolveRoutes } from './routes/evolve.js';
import { hubRoutes } from './routes/hub.js';
import { agentRoutes } from './routes/agents.js';
import { eventRoutes } from './routes/events.js';
import { githubRoutes } from './routes/github.js';
import { skillRoutes } from './routes/skills.js';
import { resolveHubRoot } from './services/hub-registry.js';
import { getHubRuntime } from './services/hub-runtime.js';
import { addClient, removeClient, broadcast, closeAll } from './services/ws-broadcast.js';
import { initNotificationService } from './services/notification/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPB_ROOT = path.resolve(process.env.CPB_ROOT || path.resolve(__dirname, '..'));
const CPB_EXECUTOR_ROOT = path.resolve(process.env.CPB_EXECUTOR_ROOT || CPB_ROOT);
const PORT = parseInt(process.env.CPB_PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3456', 10);
const HOST = process.env.CPB_HOST || '127.0.0.1';

const hubRuntime = getHubRuntime(CPB_ROOT, resolveHubRoot(CPB_ROOT));

try {
  accessSync(CPB_ROOT, constants.F_OK | constants.R_OK);
  const stat = statSync(CPB_ROOT);
  if (!stat.isDirectory()) throw new Error();
} catch {
  console.error(`Invalid CPB_ROOT: ${CPB_ROOT}`);
  process.exit(1);
}

const app = Fastify({
  logger: {
    level: 'info',
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["x-auth-token"]',
    ],
  },
});

const corsOrigins = process.env.CPB_CORS_ORIGINS
  ? process.env.CPB_CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];
await app.register(cors, { origin: corsOrigins });
await app.register(sensible);
await app.register(websocket);

// WebSocket endpoint
app.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (socket) => {
    addClient(socket);
    socket.on('close', () => removeClient(socket));
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {}
    });
  });
});

// Inject CPB_ROOT into requests
app.addHook('onRequest', (req, _res, done) => {
  req.cpbRoot = CPB_ROOT;
  req.cpbHubRoot = hubRuntime.hubRoot;
  req.hubRuntime = hubRuntime;
  done();
});

// API key authentication (gate behind CPB_API_KEYS env var)
const apiKeys = process.env.CPB_API_KEYS
  ? new Set(process.env.CPB_API_KEYS.split(',').map(k => k.trim()).filter(Boolean))
  : null;
if (apiKeys && apiKeys.size > 0) {
  app.addHook('onRequest', (req, res, done) => {
    if (req.url.startsWith('/ws') || req.url === '/api/health') return done();
    const key = req.headers['x-api-key'] || req.query?.api_key;
    if (!key || !apiKeys.has(key)) {
      res.code(401).send({ error: 'Unauthorized: valid x-api-key required' });
      return;
    }
    done();
  });
}

// File watcher + notification service
const notifService = initNotificationService(CPB_ROOT);
const notifBroadcast = async (event) => {
  broadcast(event);
  await notifService.notify(event).catch(() => {});
};

// Register routes — decorate broadcast for channel notifications
app.decorate('notifBroadcast', notifBroadcast);

// Register routes
app.register(projectRoutes, { prefix: '/api' });
app.register(taskRoutes, { prefix: '/api' });
app.register(channelRoutes, { prefix: '/api' });
app.register(reviewRoutes, { prefix: '/api' });
app.register(evolveRoutes, { prefix: '/api' });
app.register(hubRoutes, { prefix: '/api' });
app.register(agentRoutes, { prefix: '/api' });
app.register(eventRoutes, { prefix: '/api' });
app.register(githubRoutes, { prefix: '/api' });
app.register(skillRoutes, { prefix: '/api' });

// Low-frequency agent status broadcast (every 30s)
const { collectAgentMetrics } = await import('./services/agent-metrics.js');
const agentStatusInterval = setInterval(async () => {
  try {
    const metrics = await collectAgentMetrics(CPB_ROOT);
    broadcast({ type: 'agent:status', agents: metrics, ts: new Date().toISOString() });
  } catch {}
}, 30_000);
agentStatusInterval.unref();

// Proactive auto-scan (only when CPB_PROACTIVE=1, every 5 minutes)
if (process.env.CPB_PROACTIVE === '1') {
  const { scanCandidates } = await import('./services/task-brain.js');
  const { checkProactiveBudget } = await import('./services/task-brain.js');
  const { createJob } = await import('./services/job-store.js');
  const { updateCandidate } = await import('./services/event-source.js');
  const proactiveInterval = setInterval(async () => {
    try {
      const budget = await checkProactiveBudget(CPB_ROOT);
      if (!budget.allowed) return;

      const evaluations = await scanCandidates(CPB_ROOT);
      const safeAuto = evaluations.filter(e => e.recommendation.autoExecutable);
      let dispatched = 0;
      for (const { candidate, recommendation } of safeAuto) {
        if (dispatched >= budget.remaining) break;
        try {
          await createJob(CPB_ROOT, {
            project: candidate.projectId || recommendation.candidateId,
            task: recommendation.taskDescription,
            workflow: recommendation.recommendedWorkflow,
            sourceContext: {
              type: 'proactive',
              candidateId: candidate.id,
              source: candidate.source,
              category: recommendation.category,
            },
          });
          await updateCandidate(CPB_ROOT, candidate.id, {
            status: 'dispatched',
            reason: 'proactive auto-scan',
          });
          dispatched++;
        } catch {}
      }
      if (dispatched > 0) {
        broadcast({ type: 'proactive:dispatched', count: dispatched, ts: new Date().toISOString() });
      }
    } catch {}
  }, 300_000);
  proactiveInterval.unref();
}

// Serve pre-built web UI from web/dist/ when available (npx/production mode)
const webDist = path.join(CPB_EXECUTOR_ROOT, 'web', 'dist');
if (existsSync(webDist)) {
  const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ message: `Route GET:${req.url.split('?')[0]} not found` });
    }
    const reqPath = req.url.split('?')[0];
    const filePath = path.join(webDist, reqPath === '/' ? 'index.html' : reqPath);
    const resolved = path.resolve(filePath);
    const safe = resolved === webDist || resolved.startsWith(webDist + path.sep);
    if (!safe) return reply.code(404).send('not found');
    try {
      const content = await readFile(filePath);
      const ext = path.extname(filePath);
      reply.header('content-type', MIME[ext] || 'application/octet-stream');
      return reply.send(content);
    } catch {
      try {
        return reply.header('content-type', 'text/html').send(await readFile(path.join(webDist, 'index.html')));
      } catch {
        return reply.code(404).send('not found');
      }
    }
  });
}

const watchers = await registerWatcher(CPB_ROOT, notifBroadcast);

// Start
try {
  await app.listen({ port: PORT, host: HOST });
  await hubRuntime.persist().catch((err) => app.log.warn({ err }, 'failed to persist hub.json'));
  console.log(`CodePatchbay UI server running at http://localhost:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async (sig) => {
  console.log(`\n${sig} received, shutting down...`);
  await hubRuntime.markDead().catch((err) => app.log.warn({ err }, 'failed to mark hub dead'));
  closeAll();
  await notifService.close();
  await watchers.stateWatcher?.close();
  await watchers.wikiWatcher.close();
  await watchers.eventsWatcher.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
