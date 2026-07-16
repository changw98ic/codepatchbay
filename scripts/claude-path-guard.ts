import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

type HookInput = {
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: { file_path?: unknown; command?: unknown };
};

function canonicalTarget(targetPath: string) {
  let current = path.resolve(targetPath);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(targetPath);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync(current), ...suffix);
}

function decision(permissionDecision: "allow" | "deny", permissionDecisionReason: string) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
  }));
}

const configuredRoots = process.argv.slice(2).filter(Boolean);
let input: HookInput = {};
try {
  input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
} catch {
  decision("deny", "CPB path guard rejected malformed hook input");
  process.exit(2);
}

const roots = (configuredRoots.length > 0 ? configuredRoots : [String(input.cwd || process.cwd())])
  .map((configuredRoot) => canonicalTarget(path.resolve(configuredRoot)));
const root = roots[0];
if (input.tool_name === "Bash") {
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) {
    decision("deny", "CPB command guard requires a Bash command");
    process.exit(2);
  }
  if (/(^|[\s;&|({])(?:sudo\s+)?find\s+\/(?=\s|$)/.test(command)) {
    decision("deny", "CPB command guard denied a whole-filesystem find; search the isolated worktree instead");
    process.exit(2);
  }
  decision("allow", "CPB command guard approved a bounded Bash command");
  process.exit(0);
}
const rawPath = input.tool_input?.file_path;
if (typeof rawPath !== "string" || !rawPath.trim()) {
  decision("deny", "CPB path guard requires a file_path for filesystem tools");
  process.exit(2);
}

const target = canonicalTarget(path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath));
const allowed = roots.some((allowedRoot) => target === allowedRoot || target.startsWith(`${allowedRoot}${path.sep}`));
decision(
  allowed ? "allow" : "deny",
  allowed
    ? "CPB path guard approved an operation inside an isolated write root"
    : `CPB path guard denied access outside the isolated write roots: ${target}`,
);
if (!allowed) process.exit(2);
