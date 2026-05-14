import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { fileURLToPath } from 'url';
import path from 'path';
import { registerWatcher } from './services/watcher.js';
import { projectRoutes } from './routes/projects.js';
import { taskRoutes } from './routes/tasks.js';
import { channelRoutes } from './routes/channels.js';
import { reviewRoutes } from './routes/review.js';
import { addClient, removeClient, broadcast, closeAll } from './services/ws-broadcast.js';
import { initNotificationService } from './services/notification/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLOW_ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.FLOW_PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3456', 10);
const HOST = process.env.FLOW_HOST || '127.0.0.1';

const app = Fastify({ logger: { level: 'info' } });

const corsOrigins = process.env.FLOW_CORS_ORIGINS
  ? process.env.FLOW_CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];
await app.register(cors, { origin: corsOrigins });
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

// Inject FLOW_ROOT into requests
app.addHook('onRequest', (req, _res, done) => {
  req.flowRoot = FLOW_ROOT;
  done();
});

// File watcher + notification service
const notifService = initNotificationService(FLOW_ROOT);
const notifBroadcast = (event) => {
  broadcast(event);
  notifService.notify(event).catch(() => {});
};

// Register routes — decorate broadcast for channel notifications
app.decorate('notifBroadcast', notifBroadcast);

// Register routes
app.register(projectRoutes, { prefix: '/api' });
app.register(taskRoutes, { prefix: '/api' });
app.register(channelRoutes, { prefix: '/api' });
app.register(reviewRoutes, { prefix: '/api' });

const watchers = registerWatcher(FLOW_ROOT, notifBroadcast);

// Start
try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Flow UI server running at http://localhost:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async (sig) => {
  console.log(`\n${sig} received, shutting down...`);
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
