import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export async function projectRoutes(fastify, opts) {
  const { prefix } = opts;

  // List all projects with status
  fastify.get(`${prefix}/projects`, async (req) => {
    const wikiDir = path.join(req.flowRoot, 'wiki/projects');
    const entries = await fs.readdir(wikiDir).catch(() => []);
    const projects = [];

    for (const name of entries) {
      if (name === '_template' || name.startsWith('.')) continue;
      const projDir = path.join(wikiDir, name);
      const stat = await fs.stat(projDir).catch(() => null);
      if (!stat?.isDirectory()) continue;

      // Read last 3 log lines
      let recentLog = [];
      try {
        const log = await fs.readFile(path.join(projDir, 'log.md'), 'utf8');
        recentLog = log.split('\n').filter(l => l.startsWith('- **')).slice(-3);
      } catch {}

      // Read pipeline state
      let pipelineState = null;
      try {
        const stateFile = path.join(req.flowRoot, `.omc/state/pipeline-${name}.json`);
        pipelineState = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      } catch {}

      // Count inbox/outputs
      const inbox = (await fs.readdir(path.join(projDir, 'inbox')).catch(() => [])).filter(f => f.endsWith('.md')).length;
      const outputs = (await fs.readdir(path.join(projDir, 'outputs')).catch(() => [])).filter(f => f.endsWith('.md')).length;

      projects.push({ name, recentLog, pipelineState, inbox, outputs });
    }

    return projects;
  });

  // Project detail
  fastify.get(`${prefix}/projects/:name`, async (req) => {
    const { name } = req.params;
    const projDir = path.join(req.flowRoot, 'wiki/projects', name);
    await fs.access(projDir).catch(() => { throw fastify.httpErrors.notFound(`Project '${name}' not found`); });

    const readFile = async (f) => { try { return await fs.readFile(path.join(projDir, f), 'utf8'); } catch { return null; } };
    const context = await readFile('context.md');
    const tasks = await readFile('tasks.md');
    const decisions = await readFile('decisions.md');
    const log = await readFile('log.md');

    let pipelineState = null;
    try {
      pipelineState = JSON.parse(await fs.readFile(path.join(req.flowRoot, `.omc/state/pipeline-${name}.json`), 'utf8'));
    } catch {}

    return { name, context, tasks, decisions, log, pipelineState };
  });

  // List inbox files
  fastify.get(`${prefix}/projects/:name/inbox`, async (req) => {
    const inboxDir = path.join(req.flowRoot, 'wiki/projects', req.params.name, 'inbox');
    const files = (await fs.readdir(inboxDir).catch(() => [])).filter(f => f.endsWith('.md'));
    return files;
  });

  // List output files
  fastify.get(`${prefix}/projects/:name/outputs`, async (req) => {
    const outDir = path.join(req.flowRoot, 'wiki/projects', req.params.name, 'outputs');
    const files = (await fs.readdir(outDir).catch(() => [])).filter(f => f.endsWith('.md'));
    return files;
  });

  // Read specific file (wildcard matches nested paths like inbox/plan-001.md)
  fastify.get(`${prefix}/projects/:name/files/*`, async (req) => {
    const name = req.params.name;
    const filePath = req.params['*'];
    const fullPath = path.join(req.flowRoot, 'wiki/projects', name, filePath);

    // Security: prevent path traversal
    const projDir = path.join(req.flowRoot, 'wiki/projects', name);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(projDir))) {
      throw fastify.httpErrors.forbidden('Path traversal denied');
    }

    try {
      const content = await fs.readFile(fullPath, 'utf8');
      return { path: filePath, content };
    } catch {
      throw fastify.httpErrors.notFound(`File not found: ${filePath}`);
    }
  });

  // Init new project
  fastify.post(`${prefix}/projects/init`, async (req) => {
    const { path: projectPath, name } = req.body || {};
    if (!projectPath || !name) throw fastify.httpErrors.badRequest('path and name required');
    if (!SAFE_NAME.test(name)) throw fastify.httpErrors.badRequest('name: alphanumeric + hyphens only');

    try {
      const { stdout } = await execFileAsync(
        req.flowRoot + '/bridges/init-project.sh',
        [projectPath, name],
        { timeout: 10000, cwd: req.flowRoot }
      );
      return { success: true, output: stdout };
    } catch (err) {
      throw fastify.httpErrors.internalServerError(err.message);
    }
  });
}
