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
export type ScopeGuardResult = {
  withinScope: boolean;
  violations: string[];
  changedFiles: string[];
  fixScope: string[];
};

function repoPathText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRepoRelativePosixPath(value: unknown) {
  const path = repoPathText(value);
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

export function normalizeRepoRelativePaths(values: unknown) {
  const normalized = new Set<string>();
  for (const value of Array.isArray(values) ? values : [values]) {
    const path = stripGitStatusPrefix(repoPathText(value));
    if (!isRepoRelativePosixPath(path)) throw new Error(`invalid repo-relative path: ${String(value)}`);
    normalized.add(path);
  }
  return [...normalized].sort();
}

export const normalizeFixScope = normalizeRepoRelativePaths;

export function validateScopeConstraint({ diffPaths, fixScope }: { diffPaths: string[]; fixScope: string[] }) {
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

export function evaluateScopeGuard({
  changedFiles,
  fixScope,
}: {
  changedFiles: unknown[];
  fixScope: string[];
}): ScopeGuardResult {
  const cleanPaths = (Array.isArray(changedFiles) ? changedFiles : [])
    .map((file) => stripGitStatusPrefix(String(file)))
    .filter((file) => file.length > 0);
  const cleanFixScope = (Array.isArray(fixScope) ? fixScope : [])
    .map((scope) => String(scope || ""))
    .filter((scope) => scope.length > 0);
  const result = validateScopeConstraint({
    diffPaths: cleanPaths,
    fixScope: cleanFixScope,
  });
  return {
    ...result,
    changedFiles: cleanPaths,
    fixScope: cleanFixScope,
  };
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
export function stripGitStatusPrefix(line: string) {
  if (!line || typeof line !== "string") return "";
  // porcelain v1 format: XY<space>path. Some upstream artifacts collapse this
  // to one status character, so accept 1-2 known status chars before spacing.
  const match = line.match(/^[ MADRCU?!]{1,2}\s+(.+)$/);
  return match ? match[1] : line;
}

/**
 * Check whether a single file path matches a scope pattern.
 * Supports exact match, directory prefix, and simple glob (* and **).
 *
 * @param {string} filePath
 * @param {string} scopePattern
 * @returns {boolean}
 */
function isPathInScope(filePath: string, scopePattern: string) {
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
function globMatch(filePath: string, pattern: string) {
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
