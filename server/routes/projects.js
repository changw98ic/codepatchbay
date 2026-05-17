import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { projectPipelineState, listProjectPipelineStates } from '../services/job-projection.js';

const execFileAsync = promisify(execFile);
const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export async function projectRoutes(fastify, opts) {

  // List all projects with status
  fastify.get('/projects', async (req) => {
    const wikiDir = path.join(req.cpbRoot, 'wiki/projects');
    const entries = await fs.readdir(wikiDir).catch(() => []);
    const projects = [];

    const projectionStates = await listProjectPipelineStates(req.cpbRoot);

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

      const pipelineState = projectionStates[name] ?? null;

      // Count inbox/outputs
      const inbox = (await fs.readdir(path.join(projDir, 'inbox')).catch(() => [])).filter(f => f.endsWith('.md')).length;
      const outputs = (await fs.readdir(path.join(projDir, 'outputs')).catch(() => [])).filter(f => f.endsWith('.md')).length;

      projects.push({ name, recentLog, pipelineState, inbox, outputs });
    }

    return projects;
  });

  // Project detail
  fastify.get('/projects/:name', async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) throw fastify.httpErrors.badRequest('name: alphanumeric + hyphens only');
    const projDir = path.join(req.cpbRoot, 'wiki/projects', name);
    await fs.access(projDir).catch(() => { throw fastify.httpErrors.notFound(`Project '${name}' not found`); });

    const readFile = async (f) => { try { return await fs.readFile(path.join(projDir, f), 'utf8'); } catch { return null; } };
    const context = await readFile('context.md');
    const tasks = await readFile('tasks.md');
    const decisions = await readFile('decisions.md');
    const log = await readFile('log.md');

    const pipelineState = await projectPipelineState(req.cpbRoot, name);

    return { name, context, tasks, decisions, log, pipelineState };
  });

  // List inbox files
  fastify.get('/projects/:name/inbox', async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) throw fastify.httpErrors.badRequest('name: alphanumeric + hyphens only');
    const inboxDir = path.join(req.cpbRoot, 'wiki/projects', name, 'inbox');
    const files = (await fs.readdir(inboxDir).catch(() => [])).filter(f => f.endsWith('.md'));
    return files;
  });

  // List output files
  fastify.get('/projects/:name/outputs', async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) throw fastify.httpErrors.badRequest('name: alphanumeric + hyphens only');
    const outDir = path.join(req.cpbRoot, 'wiki/projects', name, 'outputs');
    const files = (await fs.readdir(outDir).catch(() => [])).filter(f => f.endsWith('.md'));
    return files;
  });

  // Read specific file (wildcard matches nested paths like inbox/plan-001.md)
  fastify.get('/projects/:name/files/*', async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) throw fastify.httpErrors.badRequest('name: alphanumeric + hyphens only');
    const filePath = req.params['*'];
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      throw fastify.httpErrors.badRequest('Invalid file path');
    }
    const projDir = path.join(req.cpbRoot, 'wiki/projects', name);
    const fullPath = path.join(projDir, filePath);

    // Resolve real paths to defeat symlink-based escapes.
    // path.resolve only normalizes the string; fs.realpath follows symlinks.
    let projectRealRoot;
    try {
      projectRealRoot = await fs.realpath(projDir);
    } catch {
      throw fastify.httpErrors.notFound(`Project '${name}' not found`);
    }

    let candidateRealPath;
    try {
      candidateRealPath = await fs.realpath(fullPath);
    } catch {
      throw fastify.httpErrors.notFound(`File not found: ${filePath}`);
    }

    if (!candidateRealPath.startsWith(projectRealRoot + path.sep) && candidateRealPath !== projectRealRoot) {
      throw fastify.httpErrors.forbidden('Path traversal denied');
    }

    try {
      const content = await fs.readFile(candidateRealPath, 'utf8');
      return { path: filePath, content };
    } catch {
      throw fastify.httpErrors.notFound(`File not found: ${filePath}`);
    }
  });

  // Init new project
  fastify.post('/projects/init', async (req) => {
    const { path: projectPath, name } = req.body || {};
    if (!projectPath || !name) throw fastify.httpErrors.badRequest('path and name required');
    if (!SAFE_NAME.test(name)) throw fastify.httpErrors.badRequest('name: alphanumeric + hyphens only');

    try {
      const { stdout } = await execFileAsync(
        req.cpbRoot + '/bridges/init-project.sh',
        [projectPath, name],
        { timeout: 10000, cwd: req.cpbRoot }
      );
      return { success: true, output: stdout };
    } catch (err) {
      throw fastify.httpErrors.internalServerError(err.message);
    }
  });
}
