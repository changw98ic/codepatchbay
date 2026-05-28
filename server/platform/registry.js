/**
 * GitPlatform registry and resolution.
 *
 * Manages platform adapter registration and resolves platform from repo URLs.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DESCRIPTORS_DIR = path.join(import.meta.dirname, "descriptors");
const _registry = new Map();
let _loaded = false;

/**
 * Validate a platform descriptor.
 */
function validateDescriptor(d) {
  if (!d || typeof d !== "object") return false;
  if (typeof d.name !== "string" || !d.name) return false;
  if (typeof d.protocol !== "string" || !d.protocol) return false;
  return true;
}

/**
 * Load builtin platform descriptors.
 */
async function loadBuiltinDescriptors() {
  let files;
  try {
    files = await readdir(DESCRIPTORS_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(DESCRIPTORS_DIR, f), "utf8");
      const d = JSON.parse(raw);
      if (validateDescriptor(d)) {
        _registry.set(d.name, d);
      }
    } catch {
      // Skip invalid descriptors
    }
  }
}

/**
 * Load user platform descriptors from config directory.
 */
async function loadUserDescriptors(configDir) {
  const dir = configDir || process.env.CPB_PLATFORM_CONFIG_DIR;
  if (!dir) return;
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(dir, f), "utf8");
      const d = JSON.parse(raw);
      if (validateDescriptor(d)) {
        _registry.set(d.name, d);
      }
    } catch {
      // Skip invalid descriptors
    }
  }
}

/**
 * Load the platform registry.
 *
 * Call this once at startup before using other registry functions.
 */
export async function loadRegistry(configDir) {
  if (_loaded && !configDir) return;
  _registry.clear();
  await loadBuiltinDescriptors();
  await loadUserDescriptors(configDir);
  _loaded = true;
}

/**
 * Ensure registry is loaded.
 */
function ensureLoaded() {
  if (!_loaded) {
    throw new Error("Platform registry not loaded. Call loadRegistry() first.");
  }
}

/**
 * List all registered platforms.
 */
export function listPlatforms() {
  ensureLoaded();
  return [..._registry.values()];
}

/**
 * List all platform names.
 */
export function listPlatformNames() {
  ensureLoaded();
  return [..._registry.keys()];
}

/**
 * Check if a platform is registered.
 */
export function hasPlatform(name) {
  ensureLoaded();
  return _registry.has(name);
}

/**
 * Get a platform descriptor by name.
 */
export function getDescriptor(name) {
  ensureLoaded();
  return _registry.get(name) || null;
}

/**
 * Resolve platform from a repository URL.
 *
 * Supports:
 * - GitHub: github.com, https://github.com/owner/repo
 * - GitLab: gitlab.com, https://gitlab.com/owner/repo
 * - Gitea: gitea.io, https://gitea.io/owner/repo
 * - Gitee: gitee.com, https://gitee.com/owner/repo
 *
 * @param {string} repoUrl - Repository URL or "owner/repo" string
 * @returns {string|null} Platform name (e.g., "github", "gitlab")
 */
export function resolvePlatformFromUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== "string") return null;

  const normalized = String(repoUrl).toLowerCase().trim();

  // Direct "owner/repo" format - default to GitHub
  if (/^[a-z0-9_-]+\/[a-z0-9_.-]+$/.test(normalized)) {
    return "github";
  }

  // Check for bare hostname (from git@host: format resolution)
  const hostnamePatterns = {
    "github.com": "github",
    "gitlab.com": "gitlab",
    "gitea.io": "gitea",
    "gitee.com": "gitee",
  };

  for (const [host, platform] of Object.entries(hostnamePatterns)) {
    if (normalized === host || normalized.endsWith(`.${host}`)) {
      return platform;
    }
  }

  // Parse URL and extract domain
  try {
    let url;
    if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
      url = new URL(normalized);
    } else if (normalized.includes("://")) {
      url = new URL(normalized);
    } else {
      // Assume git@host:owner/repo.git or similar
      const match = normalized.match(/@([^:]+):/);
      if (match) {
        return resolvePlatformFromUrl(match[1]);
      }
      return null;
    }

    const hostname = url.hostname?.toLowerCase() || "";

    // GitHub: github.com, www.github.com, api.github.com
    if (hostname === "github.com" || hostname.endsWith(".github.com")) {
      return "github";
    }

    // GitLab: gitlab.com, *.gitlab.com
    if (hostname === "gitlab.com" || hostname.endsWith(".gitlab.com")) {
      return "gitlab";
    }

    // Gitea: gitea.io, *.gitea.io
    if (hostname === "gitea.io" || hostname.endsWith(".gitea.io")) {
      return "gitea";
    }

    // Gitee: gitee.com, *.gitee.com
    if (hostname === "gitee.com" || hostname.endsWith(".gitee.com")) {
      return "gitee";
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve platform from repo URL with fallback.
 *
 * Falls back to "github" if no platform matches and repo looks like "owner/repo".
 *
 * @param {string} repoUrl - Repository URL or "owner/repo" string
 * @param {Object} options
 * @param {string} [options.defaultPlatform="github"] - Default platform if unresolved
 * @returns {string} Platform name
 */
export function resolvePlatformFromUrlOrDefault(repoUrl, { defaultPlatform = "github" } = {}) {
  const resolved = resolvePlatformFromUrl(repoUrl);
  return resolved || defaultPlatform;
}
