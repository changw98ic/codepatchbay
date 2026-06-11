// @ts-nocheck
/**
 * Scope guard — deterministic validation that changed files stay within
 * the allowed fix_scope boundary.
 *
 * Pure logic module: no I/O, no side effects.
 */

/**
 * Validate that a set of changed file paths stays within the allowed fix_scope.
 *
 * @param {object} params
 * @param {string[]} params.diffPaths  - Changed file paths (plain paths, no git status prefix).
 * @param {string[]} params.fixScope   - Allowed scope entries (exact paths, directory prefixes, glob patterns).
 * @returns {{ withinScope: boolean, violations: string[] }}
 */
export function validateScopeConstraint({ diffPaths, fixScope }) {
  if (!Array.isArray(fixScope) || fixScope.length === 0) {
    return { withinScope: true, violations: [] };
  }
  if (!Array.isArray(diffPaths) || diffPaths.length === 0) {
    return { withinScope: true, violations: [] };
  }

  const violations = [];
  for (const changedPath of diffPaths) {
    const allowed = fixScope.some(scope => isPathInScope(changedPath, scope));
    if (!allowed) violations.push(changedPath);
  }
  return { withinScope: violations.length === 0, violations };
}

/**
 * Strip git status porcelain prefix from a line.
 * "M  src/foo.js" → "src/foo.js"
 * "?? new.js"     → "new.js"
 * Already-clean paths pass through unchanged.
 *
 * @param {string} line
 * @returns {string}
 */
export function stripGitStatusPrefix(line) {
  if (!line || typeof line !== "string") return "";
  // porcelain v1 format: XY<space>path  where XY is exactly 2 known status chars
  // Only strip when the first 2 chars are a recognized git status letter combo
  const match = line.match(/^([MADRCU?\s!])([MADRCU?\s!])\s(.+)$/);
  return match ? match[3] : line;
}

/**
 * Check whether a single file path matches a scope pattern.
 * Supports exact match, directory prefix, and simple glob (* and **).
 *
 * @param {string} filePath
 * @param {string} scopePattern
 * @returns {boolean}
 */
function isPathInScope(filePath, scopePattern) {
  if (!filePath || !scopePattern) return false;

  // Exact match
  if (filePath === scopePattern) return true;

  // Directory prefix match: "src/engine/" covers "src/engine/foo.js"
  if (scopePattern.endsWith("/")) {
    return filePath.startsWith(scopePattern);
  }
  // Also cover "src/engine" covering "src/engine/foo.js"
  if (filePath.startsWith(scopePattern + "/")) return true;

  // Glob pattern match
  if (scopePattern.includes("*")) {
    return globMatch(filePath, scopePattern);
  }

  return false;
}

/**
 * Simple glob-to-regex conversion for scope patterns.
 * Supports * (any non-slash) and ** (any including slash).
 *
 * @param {string} filePath
 * @param {string} pattern
 * @returns {boolean}
 */
function globMatch(filePath, pattern) {
  // ** → match anything including /
  // *  → match anything except /
  const regexSrc = pattern
    .split("**")
    .map(segment =>
      segment.replace(/[.+^${}()|[\]\\]/g, "\\$&")  // escape regex special chars
        .replace(/\*/g, "[^/]*")                      // * → non-slash wildcard
    )
    .join(".*");                                       // ** → any path segment
  try {
    return new RegExp(`^${regexSrc}$`).test(filePath);
  } catch {
    return false;
  }
}
