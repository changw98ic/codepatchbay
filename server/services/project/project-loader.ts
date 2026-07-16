import type { LooseRecord } from "../../../shared/types.js";
import fs from 'fs/promises';
import path from 'path';
import { isSecretPath, notifySecretBlocked } from '../secret-policy.js';

/**
 * In-process memoized cache for project wiki files.
 * Keyed by project directory path.
 * Invalidated by mtime/size changes on source files.
 *
 * Feature flag: CPB_PROJECT_CACHE=0 disables caching (fallback to eager reads).
 */

const CACHE_ENABLED = process.env.CPB_PROJECT_CACHE !== '0';

const cache = new Map<string, { data: Record<string, string | null>; stats: Record<string, { mtimeMs: number; size: number } | null> }>();

const ALL_FILES = ['context', 'tasks', 'decisions', 'log'];

function projectFileList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : ALL_FILES;
}

function secretBlockedHandler(value: unknown): ((event: LooseRecord) => void) | null {
  return typeof value === 'function' ? (event: LooseRecord) => value(event) : null;
}

async function statFile(filePath: string) {
  try {
    const s = await fs.stat(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

async function readFileOrNull(filePath: string, onSecretBlocked: ((event: LooseRecord) => void) | null) {
  if (isSecretPath(filePath)) {
    notifySecretBlocked(onSecretBlocked, filePath, 'secret path read blocked');
    return null;
  }
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function statsEqual(a: { mtimeMs: number; size: number } | null, b: { mtimeMs: number; size: number } | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * Load project files with in-process cache and mtime-based invalidation.
 *
 * @param {string} projDir - absolute path to project wiki directory
 * @param {object} opts
 * @param {string[]} [opts.files] - subset to load (default: all 4)
 * @returns {Object<string, string|null>} file contents keyed by name (no .md extension)
 */
export async function loadProjectFiles(projDir: string, opts: LooseRecord = {}) {
  const requested = projectFileList(opts.files);
  const onSecretBlocked = secretBlockedHandler(opts.onSecretBlocked);

  if (!CACHE_ENABLED) {
    const entries = await Promise.all(
      requested.map(async (name) => {
        const content = await readFileOrNull(path.join(projDir, `${name}.md`), onSecretBlocked);
        return [name, content];
      })
    );
    return Object.fromEntries(entries);
  }

  const cached = cache.get(projDir);
  const result: Record<string, string | null> = {};
  const toLoad: Array<{ name: string; stat: { mtimeMs: number; size: number } | null }> = [];

  const statEntries: Array<[string, { mtimeMs: number; size: number } | null]> = await Promise.all(
    requested.map(async (name) => {
      const stat = await statFile(path.join(projDir, `${name}.md`));
      return [name, stat] as [string, { mtimeMs: number; size: number } | null];
    })
  );

  for (const [name, currentStat] of statEntries) {
    if (cached && statsEqual(cached.stats[name], currentStat) && name in cached.data) {
      result[name] = cached.data[name];
    } else {
      toLoad.push({ name, stat: currentStat });
    }
  }

  if (toLoad.length === 0) return result;

  const loaded = await Promise.all(
    toLoad.map(async ({ name, stat }) => ({
      name,
      content: await readFileOrNull(path.join(projDir, `${name}.md`), onSecretBlocked),
      stat,
    }))
  );

  const entry: { data: Record<string, string | null>; stats: Record<string, { mtimeMs: number; size: number } | null> } = cached || { data: {}, stats: {} };
  for (const { name, content, stat } of loaded) {
    entry.data[name] = content;
    entry.stats[name] = stat;
    result[name] = content;
  }
  if (!cached) cache.set(projDir, entry);

  return result;
}

/**
 * Extract recent log lines from log content.
 */
export function extractLogTail(logContent: string, count: number = 3) {
  if (!logContent) return [];
  return logContent.split('\n').filter(l => l.startsWith('- **')).slice(-count);
}

/**
 * Clear the project file cache.
 * @param {string} [projDir] - clear specific project, or omit to clear all
 */
export function clearProjectCache(projDir?: string) {
  if (projDir) cache.delete(projDir);
  else cache.clear();
}

export { ALL_FILES, CACHE_ENABLED };

// ── Triager re-exports from issue-triage.ts ──────────────────────────────
export {
  buildAcpTriagerPrompt,
  parseAcpTriagerResponse,
  triageIssue,
  triageIssueWithAcp,
  triageGithubIssue,
  triageGithubIssueWithAcp,
  triageChannelCommand,
  triageChannelCommandWithAcp,
} from "../issue-triage.js";

// ── prepareTask re-export from riskmap-service.ts ─────────────────────────
export { prepareTask, ProjectCapabilityMapUnavailableError } from "../riskmap-service.js";
