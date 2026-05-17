import { execSync } from "node:child_process";

const HIGH_RISK_PATTERNS = [
  { pattern: /\b(?:secret|api[_-]?key|password|token|credential)\b/i, reason: "involves secrets or credentials" },
  { pattern: /\b(?:auth(?:entication|orization)?)\b/i, reason: "modifies authentication or authorization" },
  { pattern: /\b(?:drop[_\s-]?table|delete\s+from|truncate\b|\bdestroy\b)/i, reason: "potentially destructive database operation" },
  { pattern: /\b(?:migration|schema\s+change)\b/i, reason: "database schema migration" },
  { pattern: /\b(?:public\s+api|breaking\s+change|deprecat)/i, reason: "affects public API surface" },
];

/**
 * Check whether an issue passes all guarded-repair policy checks.
 *
 * @param {object} issue - The issue to validate
 * @param {string} issue.description - Issue description text
 * @param {string} issue.project - Project identifier
 * @param {string} issue.sourcePath - Project source path on disk
 * @param {object} [opts]
 * @param {string[]} [opts.allowlist] - Allowed project IDs (empty = all allowed)
 * @param {boolean} [opts.requireCleanWorktree=true] - Reject if git working tree is dirty
 * @returns {{ allowed: boolean, reasons: string[] }}
 */
export function checkPolicy(issue, opts = {}) {
  const reasons = [];
  const allowlist = opts.allowlist || [];
  const requireCleanWorktree = opts.requireCleanWorktree !== false;

  // Project allowlist
  if (allowlist.length > 0 && !allowlist.includes(issue.project)) {
    reasons.push(`project '${issue.project}' not in allowlist`);
  }

  // High-risk description patterns
  for (const { pattern, reason } of HIGH_RISK_PATTERNS) {
    if (pattern.test(issue.description || "")) {
      reasons.push(`high-risk description: ${reason}`);
    }
  }

  // Clean worktree check
  if (requireCleanWorktree && issue.sourcePath) {
    try {
      const output = execSync("git status --porcelain", {
        cwd: issue.sourcePath,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const dirtyLines = output
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .filter((line) => {
          const filePath = line.slice(3).replace(/^"|"$/g, "");
          return !(filePath === "cpb-task" || filePath.startsWith("cpb-task/") || filePath === ".cpb" || filePath.startsWith(".cpb/"));
        });
      if (dirtyLines.length > 0) {
        reasons.push(`dirty worktree: ${dirtyLines.length} uncommitted change(s)`);
      }
    } catch {
      // Not a git repo or git unavailable - skip check
    }
  }

  return { allowed: reasons.length === 0, reasons };
}
