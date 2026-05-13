import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { projectPipelineState } from './job-projection.js';

export function registerWatcher(flowRoot, broadcast) {
  const projectsDir = path.join(flowRoot, 'wiki/projects');

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
  const eventsWatcher = chokidar.watch(path.join(flowRoot, 'flow-task', 'events', '*', '*.jsonl'), {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200 },
  });

  eventsWatcher.on('all', async (_event, filePath) => {
    try {
      const rel = path.relative(path.join(flowRoot, 'flow-task', 'events'), filePath);
      const [projectName, fileName] = rel.split(path.sep);
      const jobId = fileName.replace(/\.jsonl$/, '');
      broadcast({ type: 'job:update', project: projectName, jobId });
      const state = await projectPipelineState(flowRoot, projectName);
      broadcast({ type: 'pipeline:update', project: projectName, state });
    } catch (err) {
      console.error(`[watcher] job event error (${filePath}): ${err.message}`);
    }
  });

  return { wikiWatcher, eventsWatcher };
}
