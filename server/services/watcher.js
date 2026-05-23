import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { projectPipelineState } from './job-projection.js';
import { readEventsReadOnly, materializeJob } from './event-store.js';

const TERMINAL_STATES = new Set(['completed', 'failed', 'blocked', 'cancelled']);

export function registerWatcher(cpbRoot, broadcast) {
  const projectsDir = path.join(cpbRoot, 'wiki/projects');

  // Watch project wiki files
  const wikiWatcher = chokidar.watch(
    [path.join(projectsDir, '*/inbox/*.md'), path.join(projectsDir, '*/outputs/*.md'), path.join(projectsDir, '*/log.md')],
    {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
    }
  );

  wikiWatcher.on('all', async (event, filePath) => {
    try {
      const rel = path.relative(projectsDir, filePath);
      const projectName = rel.split(path.sep)[0];
      const fileRel = rel.split(path.sep).slice(1).join('/');

      if (event === 'add') {
        broadcast({ type: 'file:created', project: projectName, path: fileRel });
      } else if (event === 'change') {
        if (fileRel === 'log.md') {
          const content = await fs.readFile(filePath, 'utf8');
          const lines = content.split('\n').filter(l => l.startsWith('- **'));
          const lastLine = lines[lines.length - 1];
          if (lastLine) {
            broadcast({ type: 'log:append', project: projectName, entry: lastLine });
          }
        } else {
          broadcast({ type: 'file:modified', project: projectName, path: fileRel });
        }
      } else if (event === 'unlink') {
        broadcast({ type: 'file:deleted', project: projectName, path: fileRel });
      }
    } catch (err) {
      console.error(`[watcher] wiki file error (${filePath}): ${err.message}`);
    }
  });

  // Watch durable job event logs
  const eventsWatcher = chokidar.watch(path.join(cpbRoot, 'cpb-task', 'events', '*', '*.jsonl'), {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200 },
  });

  eventsWatcher.on('all', async (_event, filePath) => {
    try {
      const rel = path.relative(path.join(cpbRoot, 'cpb-task', 'events'), filePath);
      const [projectName, fileName] = rel.split(path.sep);
      const jobId = fileName.replace(/\.jsonl$/, '');
      broadcast({ type: 'job:update', project: projectName, jobId });
      const state = await projectPipelineState(cpbRoot, projectName);
      broadcast({ type: 'pipeline:update', project: projectName, state });

      // Broadcast agent:metrics on terminal job state
      try {
        const events = await readEventsReadOnly(cpbRoot, projectName, jobId);
        const jobState = materializeJob(events);
        if (TERMINAL_STATES.has(jobState.status)) {
          const { collectAgentMetrics } = await import('./agent-metrics.js');
          const metrics = await collectAgentMetrics(cpbRoot);
          broadcast({ type: 'agent:metrics', agent: jobState.executor || 'unknown', jobId, status: jobState.status, metrics, ts: new Date().toISOString() });
        }
      } catch {}
    } catch (err) {
      console.error(`[watcher] job event error (${filePath}): ${err.message}`);
    }
  });

  return { wikiWatcher, eventsWatcher };
}
