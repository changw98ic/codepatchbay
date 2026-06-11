import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { projectPipelineState } from './job-projection.js';
import { readEventsReadOnly, materializeJob } from './event-store.js';
import { listProjects, resolveHubRoot } from './hub-registry.js';

const TERMINAL_STATES = new Set(['completed', 'failed', 'blocked', 'cancelled']);

function extractEventPath(filePath, hubProjectsDirs) {
  // Try hub project paths: {runtimeRoot}/events/{project}/{jobId}.jsonl
  for (const dir of hubProjectsDirs) {
    const rel = path.relative(dir.eventsDir, filePath);
    if (!rel.startsWith('..')) {
      const parts = rel.split(path.sep);
      if (parts.length >= 2) {
        return { projectName: parts[0], jobId: parts[1].replace(/\.jsonl$/, ''), dataRoot: dir.dataRoot };
      }
    }
  }
  return null;
}

export async function registerWatcher(cpbRoot, broadcast) {
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

  // Build event watch patterns from hub project runtime roots only.
  const watchPatterns = [];
  const hubProjectsDirs = [];

  try {
    const hubRoot = resolveHubRoot(cpbRoot);
    if (hubRoot) {
      const projects = await listProjects(hubRoot);
      for (const p of projects) {
        if (p.projectRuntimeRoot) {
          const eventsDir = path.join(p.projectRuntimeRoot, 'events', p.id);
          watchPatterns.push(path.join(eventsDir, '*.jsonl'));
          hubProjectsDirs.push({
            eventsDir: path.join(p.projectRuntimeRoot, 'events'),
            dataRoot: p.projectRuntimeRoot,
          });
        }
      }
    }
  } catch {}

  // Watch durable job event logs
  const eventsWatcher = chokidar.watch(watchPatterns, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200 },
  });

  eventsWatcher.on('all', async (_event, filePath) => {
    try {
      const parsed = extractEventPath(filePath, hubProjectsDirs);
      if (!parsed) return;
      const { projectName, jobId, dataRoot } = parsed;

      broadcast({ type: 'job:update', project: projectName, jobId, dataRoot });
      const state = await projectPipelineState(cpbRoot, projectName, { dataRoot });
      broadcast({ type: 'pipeline:update', project: projectName, state, dataRoot });

      // Broadcast agent:metrics on terminal job state
      try {
        const events = await readEventsReadOnly(cpbRoot, projectName, jobId, { dataRoot });
        const jobState = materializeJob(events);
        if (TERMINAL_STATES.has(jobState.status)) {
          const { collectAgentMetrics } = await import('./agent-metrics.js');
          const metrics = await collectAgentMetrics(cpbRoot);
          broadcast({ type: 'agent:metrics', agent: jobState.executor || 'unknown', jobId, status: jobState.status, metrics, dataRoot, ts: new Date().toISOString() });
        }
      } catch {}
    } catch (err) {
      console.error(`[watcher] job event error (${filePath}): ${err.message}`);
    }
  });

  return { wikiWatcher, eventsWatcher };
}
