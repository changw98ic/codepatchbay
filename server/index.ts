import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import sensible from '@fastify/sensible';
import { fileURLToPath } from 'url';
import path from 'path';
import { accessSync, constants, existsSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { registerWatcher } from './services/infra.js';
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
import { inboxRoutes } from './routes/inbox.js';
import { getProject, resolveHubRoot } from './services/hub/hub-registry.js';
import { getHubRuntime } from './services/hub/hub-registry.js';
import { assertNoLegacyRuntimeData } from './services/runtime-migration-guard.js';
import { addClient, removeClient, broadcast, closeAll } from './services/infra.js';
import { initNotificationService } from './services/notification/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPB_ROOT = path.resolve(process.env.CPB_ROOT || path.resolve(__dirname, '..'));
const CPB_EXECUTOR_ROOT = path.resolve(process.env.CPB_EXECUTOR_ROOT || CPB_ROOT);
const PORT = parseInt(process.env.CPB_PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3456', 10);
const HOST = process.env.CPB_HOST || '127.0.0.1';
const HUB_ROOT = resolveHubRoot(CPB_ROOT);
const DEFAULT_PROACTIVE_INTERVAL_MS = 300_000;
const MIN_PROACTIVE_INTERVAL_MS = 10_000;
const MIN_TEST_PROACTIVE_INTERVAL_MS = 10;

const hubRuntime = getHubRuntime(CPB_ROOT, HUB_ROOT);

function parsePositiveInteger(value) {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function proactiveScanIntervalMs(env = process.env) {
  const testInterval = env.NODE_ENV === 'test'
    ? parsePositiveInteger(env.CPB_TEST_PROACTIVE_INTERVAL_MS)
    : null;
  if (testInterval !== null) return Math.max(MIN_TEST_PROACTIVE_INTERVAL_MS, testInterval);

  const configured = parsePositiveInteger(env.CPB_PROACTIVE_INTERVAL_MS);
  if (configured === null) return DEFAULT_PROACTIVE_INTERVAL_MS;
  return Math.max(MIN_PROACTIVE_INTERVAL_MS, configured);
}

function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function hasConfiguredApiKeys() {
  return Boolean(process.env.CPB_API_KEYS?.split(',').map(k => k.trim()).filter(Boolean).length);
}

function requestPath(req) {
  return String(req.url || '').split('?')[0];
}

try {
  accessSync(CPB_ROOT, constants.F_OK | constants.R_OK);
  const stat = statSync(CPB_ROOT);
  if (!stat.isDirectory()) throw new Error();
} catch {
  console.error(`Invalid CPB_ROOT: ${CPB_ROOT}`);
  process.exit(1);
}

try {
  await assertNoLegacyRuntimeData(CPB_ROOT);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (!isLoopbackHost(HOST) && !hasConfiguredApiKeys()) {
  console.error(`Refusing public CPB_HOST ${HOST}: public binds require CPB_API_KEYS; use CPB_HOST=127.0.0.1 for local unauthenticated UI.`);
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

// API key authentication (gate behind CPB_API_KEYS env var)
const apiKeys = process.env.CPB_API_KEYS
  ? new Set(process.env.CPB_API_KEYS.split(',').map(k => k.trim()).filter(Boolean))
  : null;

function parseCookieHeader(header) {
  const cookies: Record<string, string> = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function extractApiKey(req) {
  const headerKey = Array.isArray(req.headers['x-api-key'])
    ? req.headers['x-api-key'][0]
    : req.headers['x-api-key'];
  if (headerKey) return headerKey;
  const cookieKey = parseCookieHeader(req.headers.cookie).cpb_api_key;
  if (cookieKey) return cookieKey;
  return (req.query as Record<string, any> | undefined)?.api_key;
}

function hasValidApiKey(req) {
  if (!apiKeys || apiKeys.size === 0) return true;
  const key = extractApiKey(req);
  return Boolean(key && apiKeys.has(key));
}

function requireApiKey(req, reply, done) {
  if (hasValidApiKey(req)) {
    done();
    return;
  }
  reply.code(401).send({ error: 'Unauthorized: valid x-api-key required' });
}

// WebSocket endpoint
app.register(async function (fastify) {
  fastify.get('/ws', {
    websocket: true,
    preValidation: requireApiKey,
  }, (socket) => {
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
  const request = req as Record<string, any>;
  request.cpbRoot = CPB_ROOT;
  request.cpbHubRoot = hubRuntime.hubRoot;
  request.hubRuntime = hubRuntime;
  done();
});

if (apiKeys && apiKeys.size > 0) {
  app.addHook('onRequest', (req, res, done) => {
    if (requestPath(req) === '/api/health') return done();
    if (!hasValidApiKey(req)) return res.code(401).send({ error: 'Unauthorized: valid x-api-key required' });
    done();
  });
}

app.get('/api/health', async () => ({
  ok: true,
  status: 'ok',
  uptimeMs: Math.round(process.uptime() * 1000),
}));

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
app.register(inboxRoutes, { prefix: '/api' });

// Low-frequency agent status broadcast (every 30s)
const { collectAgentMetrics } = await import('./services/agent/agent-config.js');
const agentStatusInterval = setInterval(async () => {
  try {
    const metrics = await collectAgentMetrics(CPB_ROOT, { hubRoot: HUB_ROOT });
    broadcast({ type: 'agent:status', agents: metrics, ts: new Date().toISOString() });
  } catch {}
}, 30_000);
agentStatusInterval.unref();

// Proactive auto-scan (only when CPB_PROACTIVE=1, every 5 minutes)
if (process.env.CPB_PROACTIVE === '1') {
  const { scanCandidates } = await import('./services/evolve/evolve.js');
  const { checkProactiveBudget } = await import('./services/evolve/evolve.js');
  const { createJob } = await import('./services/job/job-store.js');
  const { updateCandidate } = await import('./services/event/event-source.js');
  const proactiveInterval = setInterval(async () => {
    try {
      const budget = await checkProactiveBudget(CPB_ROOT, { hubRoot: HUB_ROOT, logger: app.log });
      if (!budget.allowed) return;

      const evaluations = await scanCandidates(CPB_ROOT, { hubRoot: HUB_ROOT });
      const safeAuto = evaluations.filter(e => e.recommendation.autoExecutable);
      let dispatched = 0;
      for (const { candidate, recommendation } of safeAuto) {
        if (dispatched >= budget.remaining) break;
        try {
          const projectId = candidate.projectId || recommendation.candidateId;
          const project = projectId ? await getProject(HUB_ROOT, projectId) : null;
          const dataRoot = typeof project?.projectRuntimeRoot === 'string' && project.projectRuntimeRoot.trim()
            ? project.projectRuntimeRoot
            : null;
          if (!dataRoot) continue;
          await createJob(CPB_ROOT, {
            project: projectId,
            task: recommendation.taskDescription,
            workflow: recommendation.recommendedWorkflow,
            dataRoot,
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
          }, { hubRoot: HUB_ROOT });
          dispatched++;
        } catch {}
      }
      if (dispatched > 0) {
        broadcast({ type: 'proactive:dispatched', count: dispatched, ts: new Date().toISOString() });
      }
    } catch {}
  }, proactiveScanIntervalMs());
  proactiveInterval.unref();
}

// Serve pre-built web UI from the compiled executor root, with a source-root fallback for local development.
const executorWebDist = path.join(CPB_EXECUTOR_ROOT, 'web', 'dist');
const sourceWebDist = path.join(CPB_ROOT, 'web', 'dist');
const webDist = existsSync(executorWebDist) ? executorWebDist : sourceWebDist;
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

const watchers = await registerWatcher(CPB_ROOT, notifBroadcast) as Record<string, any>;

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
