import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { listProjects, getProject } from '../services/hub/hub-registry.js';
import { classifyProject, filterVisibleProjects } from '../services/project/project-index.js';
import { projectPipelineState, listProjectPipelineStates } from '../services/job/job-projection.js';
import { loadProjectFiles, extractLogTail, ALL_FILES } from '../services/project/project-loader.js';
import { readProjectIndex } from '../services/project/project-index.js';
import {
  resolveInboxDir,
  resolveOutputsDir,
  resolveWikiDir,
  resolveArtifactPath,
  runtimeWikiDir,
} from '../services/artifact-locator.js';

const execFileAsync = promisify(execFile);
const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const BLOCKED_PATH_PREFIXES = [
  '/etc', '/usr', '/bin', '/sbin', '/var', '/sys', '/proc', '/dev', '/boot', '/lib', '/lib64', '/snap',
];
type LooseRecord = Record<string, any>;
const DASHBOARD_JOBS_CACHE_TTL_MS = 500;

function getProjectRoots() {
  const env = process.env.CPB_PROJECT_ROOTS;
  if (env) return env.split(':').filter(Boolean).map(p => path.resolve(p.trim()));
  const home = process.env.HOME;
  return home ? [path.resolve(home)] : [];
}

async function legacyProjectExists(cpbRoot, name) {
  try {
    const info = await fs.stat(path.join(cpbRoot, 'wiki', 'projects', name));
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function listRouteProjects(hubRoot, cpbRoot) {
  if (hubRoot) return listProjects(hubRoot);
  const projectsDir = path.join(cpbRoot, 'wiki', 'projects');
  const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '_template')
    .map((entry) => ({ id: entry.name, name: entry.name }));
}

async function getRouteProject(hubRoot, cpbRoot, name) {
  if (hubRoot) return getProject(hubRoot, name);
  if (await legacyProjectExists(cpbRoot, name)) return { id: name, name };
  return null;
}

async function validateProjectPath(projectPath, cpbRoot) {
  const normalized = path.resolve(projectPath);

  for (const prefix of BLOCKED_PATH_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix + path.sep)) {
      return { ok: false, reason: 'blocked_system_path', resolved: null };
    }
  }

  let resolved;
  try {
    resolved = await fs.realpath(normalized);
  } catch {
    return { ok: false, reason: 'path_resolution_failed', resolved: null };
  }

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return { ok: false, reason: 'path_not_accessible', resolved: null };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: 'not_a_directory', resolved };
  }

  if (resolved === cpbRoot || resolved.startsWith(cpbRoot + path.sep)) {
    return { ok: false, reason: 'inside_cpb_root', resolved };
  }

  const roots = getProjectRoots();
  if (roots.length === 0) {
    return { ok: false, reason: 'no_project_roots_configured', resolved };
  }
  const contained = roots.some(root =>
    resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!contained) {
    return { ok: false, reason: 'outside_project_scope', resolved };
  }

  return { ok: true, resolved };
}

export async function projectRoutes(fastify, opts) {

  // List all projects — backed by Hub registry + project runtime roots
  fastify.get('/projects', async (req) => {
    const hubRoot = req.cpbHubRoot;
    const cpbRoot = req.cpbRoot;

    let hubProjects = await listRouteProjects(hubRoot, cpbRoot);
    const includeTest = ['true', '1'].includes(req.query.includeTest) ||
      ['true', '1'].includes(req.query.diagnostics);
    hubProjects = filterVisibleProjects(hubProjects, { includeTest, hubRoot });
    const projectionStates = await listProjectPipelineStates(cpbRoot, {
      hubRoot,
      cacheTtlMs: DASHBOARD_JOBS_CACHE_TTL_MS,
    });

    const projectData = await Promise.all(
      hubProjects.map(async (project) => {
        const projectId = project.id;
        try {
          const wikiDir = await resolveWikiDir(hubRoot, cpbRoot, projectId);
          const [files, inboxEntries, outputEntries] = await Promise.all([
            loadProjectFiles(wikiDir, { files: ['log'] }).catch(() => ({} as LooseRecord)),
            fs.readdir(await resolveInboxDir(hubRoot, cpbRoot, projectId)).catch(() => []),
            fs.readdir(await resolveOutputsDir(hubRoot, cpbRoot, projectId)).catch(() => []),
          ]);
          const fileMap = files as LooseRecord;

          return {
            name: project.name || project.id,
            id: project.id,
            recentLog: extractLogTail(fileMap.log),
            pipelineState: projectionStates[projectId] ?? null,
            projectIndex: await readProjectIndex(hubRoot, cpbRoot, projectId),
            inbox: inboxEntries.filter(f => f.endsWith('.md')).length,
            outputs: outputEntries.filter(f => f.endsWith('.md')).length,
            ...(includeTest ? { _pollution: classifyProject(project, { hubRoot } as LooseRecord) } : {}),
          };
        } catch {
          return {
            name: project.name || project.id,
            id: project.id,
            recentLog: [],
            pipelineState: projectionStates[projectId] ?? null,
            projectIndex: await readProjectIndex(hubRoot, cpbRoot, projectId),
            inbox: 0,
            outputs: 0,
            ...(includeTest ? { _pollution: classifyProject(project, { hubRoot } as LooseRecord) } : {}),
          };
        }
      })
    );

    return projectData;
  });

  // Project detail
  fastify.get('/projects/:name', async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) throw fastify.httpErrors.badRequest('name: alphanumeric + hyphens only');

    const hubRoot = req.cpbHubRoot;
    const cpbRoot = req.cpbRoot;

    const project = await getRouteProject(hubRoot, cpbRoot, name);
    if (!project) throw fastify.httpErrors.notFound(`Project '${name}' not found`);

    const projectId = project.id;
    const wikiDir = await resolveWikiDir(hubRoot, cpbRoot, projectId);

    const fieldsParam = req.query.fields;
    const requestedFiles = fieldsParam
      ? fieldsParam.split(',').filter(f => ALL_FILES.includes(f))
      : ALL_FILES;

    const files = await loadProjectFiles(wikiDir, { files: requestedFiles }) as LooseRecord;
    const pipelineState = await projectPipelineState(cpbRoot, projectId, { hubRoot });
    const projectIndex = await readProjectIndex(hubRoot, cpbRoot, projectId);

    return { name: project.name || projectId, context: files.context ?? null, tasks: files.tasks ?? null, decisions: files.decisions ?? null, log: files.log ?? null, pipelineState, projectIndex };
  });

  // List inbox files
  fastify.get('/projects/:name/inbox', async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) throw fastify.httpErrors.badRequest('name: alphanumeric + hyphens only');
    const inboxDir = await resolveInboxDir(req.cpbHubRoot, req.cpbRoot, name);
    const files = (await fs.readdir(inboxDir).catch(() => [])).filter(f => f.endsWith('.md'));
    return files;
  });

  // List output files
  fastify.get('/projects/:name/outputs', async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) throw fastify.httpErrors.badRequest('name: alphanumeric + hyphens only');
    const outDir = await resolveOutputsDir(req.cpbHubRoot, req.cpbRoot, name);
    const files = (await fs.readdir(outDir).catch(() => [])).filter(f => f.endsWith('.md'));
    return files;
  });

  // Read specific file (wildcard matches nested paths like inbox/plan-001.md)
  fastify.get('/projects/:name/files/*', async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) throw fastify.httpErrors.badRequest('name: alphanumeric + hyphens only');
    const filePath = req.params['*'];
    if (filePath.includes('\0') || filePath.toLowerCase().includes('%00')) {
      throw fastify.httpErrors.badRequest('Invalid file path');
    }
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      throw fastify.httpErrors.badRequest('Invalid file path');
    }

    try {
      const decoded = decodeURIComponent(filePath);
      const decodedAgain = decodeURIComponent(decoded);
      for (const candidate of [decoded, decodedAgain]) {
        if (candidate.includes('\0')) throw new Error('null byte');
        const normalizedCandidate = path.normalize(candidate);
        if (normalizedCandidate.startsWith('..') || path.isAbsolute(normalizedCandidate)) {
          throw new Error('path traversal');
        }
      }
    } catch {
      throw fastify.httpErrors.badRequest('Invalid file path');
    }

    const hubRoot = req.cpbHubRoot;
    const cpbRoot = req.cpbRoot;

    // Resolve through the Hub project runtime root only.
    const fullPath = await resolveArtifactPath(hubRoot, cpbRoot, name, normalized);

    // Resolve real paths to defeat symlink-based escapes
    const wikiDir = await resolveWikiDir(hubRoot, cpbRoot, name);
    let projectRealRoot;
    try {
      projectRealRoot = await fs.realpath(wikiDir);
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

    const validation = await validateProjectPath(projectPath, req.cpbRoot);
    if (!validation.ok) {
      const securityReasons = ['blocked_system_path', 'outside_project_scope', 'inside_cpb_root'];
      const method = securityReasons.includes(validation.reason) ? 'forbidden' : 'badRequest';
      req.log.warn({
        projectPath,
        cpbRoot: req.cpbRoot,
        validationFailureReason: validation.reason,
      }, 'Project init rejected: path validation failed');
      throw fastify.httpErrors[method]('Invalid project path');
    }

    try {
      const { stdout } = await execFileAsync(
        'node',
        [req.cpbRoot + '/server/services/init-project.js', validation.resolved, name],
        { timeout: 10000, cwd: req.cpbRoot }
      );
      return { success: true, output: stdout };
    } catch (err) {
      throw fastify.httpErrors.internalServerError(err.message);
    }
  });
}
