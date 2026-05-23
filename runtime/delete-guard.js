#!/usr/bin/env node
import path from "node:path";
import os from "node:os";

const PROTECTED_SYSTEM_PATHS = [
  "/",
  "/Users",
  "/System",
  "/Library",
  "/Applications",
  "/bin",
  "/usr",
  "/etc",
  "/var",
  "/private",
  "/tmp",
];

const HOME = os.homedir();
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const DEFAULT_BULK_THRESHOLD = 100;

function normalize(p) {
  return p.replace(/\/+$/, "") || "/";
}

function isOrContainsGit(p) {
  const n = normalize(p);
  return n.endsWith("/.git") || n === ".git"
    || n.includes("/.git/") || n.startsWith(".git/");
}

function isSystemPath(resolved) {
  const n = normalize(resolved);
  return PROTECTED_SYSTEM_PATHS.some((sp) => n === sp);
}

function isHomePath(p) {
  if (p === "~" || p === "$HOME") return true;
  const expanded = p.startsWith("~/")
    ? path.join(HOME, p.slice(2))
    : path.resolve(p);
  return expanded === HOME;
}

function escapesRoot(target, cwd, root) {
  const resolved = path.resolve(cwd, target);
  const normRoot = normalize(root);
  return !resolved.startsWith(normRoot + "/") && resolved !== normRoot;
}

function parseRmFlags(args) {
  let recursive = false;
  let force = false;
  const paths = [];
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--recursive") { recursive = true; continue; }
    if (arg === "--force") { force = true; continue; }
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
      for (const ch of arg.slice(1)) {
        if (ch === "r" || ch === "R") recursive = true;
        if (ch === "f") force = true;
      }
      continue;
    }
    paths.push(arg);
  }
  return { recursive, force, paths };
}

function block(reason, details = {}) {
  return { allowed: false, reason, messageKey: "delete_blocked", details };
}

function checkRmPaths(paths, recursive, force, cwd, repoRoot) {
  const root = repoRoot || cwd;
  for (const p of paths) {
    const resolved = path.resolve(cwd, p);

    if (isOrContainsGit(p) || isOrContainsGit(resolved)) {
      return block("git_dir_delete", { target: ".git" });
    }
    if (isSystemPath(resolved)) {
      return block("system_path_delete", { target: resolved });
    }
    if (isHomePath(p)) {
      return block("home_recursive_delete", { target: p });
    }
    if (recursive && escapesRoot(p, cwd, root)) {
      return block("external_recursive_delete", { target: p });
    }
  }
  if (recursive && force && paths.length === 0) {
    return block("dangerous_rm_rf", {});
  }
  return null;
}

function checkRm(args, cwd, threshold, repoRoot) {
  const { recursive, force, paths } = parseRmFlags(args);
  const pathBlock = checkRmPaths(paths, recursive, force, cwd, repoRoot);
  if (pathBlock) return pathBlock;
  if (paths.length > threshold) {
    return block("bulk_delete_threshold", { targetCount: paths.length, threshold });
  }
  return { allowed: true };
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C", "--git-dir", "--work-tree", "-c", "--config-env", "--exec-path",
]);

const GIT_GLOBAL_OPTIONS_WITHOUT_VALUE = new Set([
  "--html-path", "--man-path", "--info-path",
  "-p", "--paginate", "--no-pager", "--no-replace-objects", "--bare",
  "--no-lazy-fetch", "--literal-pathspecs", "--glob-pathspecs",
  "--noglob-pathspecs", "--icase-pathspecs",
]);

function checkGit(args) {
  if (args.length === 0) return { allowed: true };

  // Skip global options before the subcommand without consuming valueless option followers.
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const arg = args[i];
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      i += 2;
    } else if ([...GIT_GLOBAL_OPTIONS_WITH_VALUE].some((opt) => arg.startsWith(`${opt}=`))) {
      i += 1;
    } else if (GIT_GLOBAL_OPTIONS_WITHOUT_VALUE.has(arg) || arg.startsWith("-")) {
      i += 1;
    }
  }

  if (i >= args.length) return { allowed: true };
  const sub = args[i];
  const flags = args.slice(i + 1);
  if (sub === "clean" && flags.some((f) => f.includes("f") || f === "--force")) {
    return block("dangerous_git_clean", { flags });
  }
  if (sub === "reset" && flags.includes("--hard")) {
    return block("dangerous_git_reset_hard", { flags });
  }
  return { allowed: true };
}

const SYSTEM_DIR_NAMES = "tmp|usr|bin|etc|var|System|Library|Applications|Users|private";

function checkShellString(cmdStr) {
  const rmPresent = /\brm\s/.test(cmdStr);
  const hasRecursive = rmPresent && (/-[a-zA-Z]*[rR]/.test(cmdStr) || /--recursive/.test(cmdStr));
  const hasForce = rmPresent && (/-[a-zA-Z]*[fF]/.test(cmdStr) || /--force/.test(cmdStr));

  // .git deletion must be blocked regardless of recursive flag
  if (rmPresent && /\.git(?:\/|$|[\s;&|])/.test(cmdStr)) return block("git_dir_delete", { shell: true });

  if (hasRecursive) {
    if (new RegExp(`(?:\\s|^|['"])\/(?:${SYSTEM_DIR_NAMES})(?:\\/|\\s|$|&|;|\\||'")`).test(cmdStr)) {
      return block("system_path_delete", { shell: true });
    }
    if (/(?:\s|^|['"])\/(?:\s|$|&|;|\||'")/.test(cmdStr)) {
      return block("system_path_delete", { shell: true });
    }
    if (/~|\$HOME|\$\{HOME\}/.test(cmdStr)) return block("home_recursive_delete", { shell: true });
    if (/\.\.\//.test(cmdStr)) return block("external_recursive_delete", { shell: true });
    if (/(?:\s|^|['"])\/[a-zA-Z]/.test(cmdStr)) return block("external_recursive_delete", { shell: true });
  }

  if (hasRecursive && hasForce) {
    const rmPortion = cmdStr.slice(cmdStr.search(/\brm\s/) + 3);
    if (!/\.?\//.test(rmPortion) && !/\w+\.\w+/.test(rmPortion)) {
      return block("dangerous_rm_rf", { shell: true });
    }
  }

  if (/\bgit\s+.*\bclean\s/.test(cmdStr) && /(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b/.test(cmdStr)) {
    return block("dangerous_git_clean", { shell: true });
  }
  if (/\bgit\s+.*\breset\b/.test(cmdStr) && /--hard/.test(cmdStr)) {
    return block("dangerous_git_reset_hard", { shell: true });
  }

  return { allowed: true };
}

export function classifyDeleteRisk(command, args, { cwd, repoRoot, bulkThreshold } = {}) {
  const threshold = bulkThreshold ?? DEFAULT_BULK_THRESHOLD;
  const base = path.basename(command);

  if (SHELL_COMMANDS.has(base)) {
    const ci = args.indexOf("-c");
    if (ci !== -1 && ci + 1 < args.length) {
      const result = checkShellString(args[ci + 1]);
      if (!result.allowed) return result;
    }
    return { allowed: true };
  }

  if (base === "rm") return checkRm(args, cwd, threshold, repoRoot);
  if (base === "git") return checkGit(args);

  return { allowed: true };
}

export function formatDeleteBlockedMessage(result) {
  const messages = {
    git_dir_delete: "CPB blocked deletion of .git directory.",
    external_recursive_delete: "CPB blocked recursive deletion outside the worktree.",
    home_recursive_delete: "CPB blocked recursive deletion targeting home directory.",
    system_path_delete: "CPB blocked deletion of a system-protected path.",
    dangerous_rm_rf: "CPB blocked bare rm -rf without explicit targets.",
    dangerous_git_clean: "CPB blocked git clean with force flags.",
    dangerous_git_reset_hard: "CPB blocked git reset --hard.",
    bulk_delete_threshold: "CPB blocked bulk deletion exceeding threshold.",
  };
  return `${messages[result.reason] || "CPB blocked a destructive delete operation."} (reason: ${result.reason})`;
}

export function logDeleteBlock(command, args, cwd, result, sink) {
  const write = sink || ((msg) => process.stderr.write(msg));
  write(`[delete-blocked] ${JSON.stringify({
    type: "delete_blocked",
    messageKey: "delete_blocked",
    reason: result.reason,
    command,
    args: args.slice(0, 10),
    cwd,
    ts: new Date().toISOString(),
  })}\n`);
}
