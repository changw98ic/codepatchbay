import fs from 'fs/promises';
import path from 'path';

/**
 * In-process memoized cache for project wiki files.
 * Keyed by project directory path.
 * Invalidated by mtime/size changes on source files.
 *
 * Feature flag: CPB_PROJECT_CACHE=0 disables caching (fallback to eager reads).
 */

const CACHE_ENABLED = process.env.CPB_PROJECT_CACHE !== '0';

const cache = new Map();

const ALL_FILES = ['context', 'tasks', 'decisions', 'log'];

async function statFile(filePath) {
  try {
    const s = await fs.stat(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

async function readFileOrNull(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function statsEqual(a, b) {
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
export async function loadProjectFiles(projDir, opts = {}) {
  const requested = opts.files || ALL_FILES;

  if (!CACHE_ENABLED) {
    const entries = await Promise.all(
      requested.map(async (name) => {
        const content = await readFileOrNull(path.join(projDir, `${name}.md`));
        return [name, content];
      })
    );
    return Object.fromEntries(entries);
  }

  const cached = cache.get(projDir);
  const result = {};
  const toLoad = [];

  const statEntries = await Promise.all(
    requested.map(async (name) => {
      const stat = await statFile(path.join(projDir, `${name}.md`));
      return [name, stat];
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
      content: await readFileOrNull(path.join(projDir, `${name}.md`)),
      stat,
    }))
  );

  const entry = cached || { data: {}, stats: {} };
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
export function extractLogTail(logContent, count = 3) {
  if (!logContent) return [];
  return logContent.split('\n').filter(l => l.startsWith('- **')).slice(-count);
}

/**
 * Clear the project file cache.
 * @param {string} [projDir] - clear specific project, or omit to clear all
 */
export function clearProjectCache(projDir) {
  if (projDir) cache.delete(projDir);
  else cache.clear();
}

export { ALL_FILES, CACHE_ENABLED };
