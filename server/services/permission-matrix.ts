import path from "node:path";
import { REQUIRED_EXECUTION_BOUNDARY } from "../../core/job/meta.js";
import { appendEvent } from "./event-store.js";

const ROLES = new Set(["planner", "executor", "verifier", "remediator", "reviewer"]);
const READ_ALLOWED_PATHS = Object.freeze(["*"]);

export const INFRA_FAILURE = "INFRA_FAILURE";

const WRITE_SCOPES = {
  planner: {
    allowed: [
      (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly, "inbox"),
    ],
    denied: [
      (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly, "outputs"),
    ],
  },
  executor: {
    allowed: [
      (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly, "outputs"),
      (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
    ],
    denied: [
      (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly, "inbox"),
      (cpbRoot) => path.resolve(cpbRoot, "wiki", "system"),
      (cpbRoot) => path.resolve(cpbRoot, "profiles"),
      (cpbRoot) => path.resolve(cpbRoot, "bridges"),
    ],
  },
  verifier: {
    allowed: [
      (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly, "outputs"),
    ],
    denied: [
      (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly, "inbox"),
      (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
    ],
  },
  remediator: {
    allowed: [
      (cpbRoot) => path.resolve(cpbRoot),
    ],
    denied: [],
  },
  reviewer: {
    allowed: [
      (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly, "outputs"),
    ],
    denied: [],
  },
};

const OBSERVATION_PATHS = {
  planner: [
    (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly),
    (cpbRoot) => path.resolve(cpbRoot, "wiki", "system"),
    (cpbRoot) => path.resolve(cpbRoot, "templates"),
    (cpbRoot) => path.resolve(cpbRoot, "profiles"),
    (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
  ],
  verifier: [
    (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly),
    (cpbRoot) => path.resolve(cpbRoot, "wiki", "system"),
    (cpbRoot) => path.resolve(cpbRoot, "templates"),
    (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
    (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => dataBoundary(cpbRoot, dataRoot, legacyOnly, "events", project),
    (cpbRoot, _project, _sourcePath, dataRoot, legacyOnly) => dataBoundary(cpbRoot, dataRoot, legacyOnly, "state"),
    (cpbRoot, _project, _sourcePath, dataRoot, legacyOnly) => dataBoundary(cpbRoot, dataRoot, legacyOnly, "checkpoints"),
  ],
  executor: [
    (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly),
    (cpbRoot) => path.resolve(cpbRoot, "wiki", "system"),
    (cpbRoot) => path.resolve(cpbRoot, "templates"),
    (cpbRoot) => path.resolve(cpbRoot, "profiles"),
    (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
  ],
  remediator: [
    (cpbRoot) => path.resolve(cpbRoot),
    (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
  ],
  reviewer: [
    (cpbRoot, project, _sourcePath, dataRoot, legacyOnly) => wikiBoundary(cpbRoot, project, dataRoot, legacyOnly),
    (cpbRoot) => path.resolve(cpbRoot, "wiki", "system"),
    (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
  ],
};

function legacyWikiPath(cpbRoot: string, project: string, ...parts: string[]) {
  return path.resolve(cpbRoot, "wiki", "projects", project, ...parts);
}

function legacyDataPath(cpbRoot: string, ...parts: string[]) {
  return path.resolve(cpbRoot, "cpb-task", ...parts);
}

function wikiBoundary(cpbRoot: string, project: string, dataRoot: string | null | undefined, legacyOnly = false, ...parts: string[]) {
  if (dataRoot) return path.resolve(dataRoot, "wiki", ...parts);
  return legacyOnly ? legacyWikiPath(cpbRoot, project, ...parts) : null;
}

function dataBoundary(cpbRoot: string, dataRoot: string | null | undefined, legacyOnly = false, ...parts: string[]) {
  if (dataRoot) return path.resolve(dataRoot, ...parts);
  return legacyOnly ? legacyDataPath(cpbRoot, ...parts) : null;
}

export function validateRole(role) {
  if (!ROLES.has(role)) {
    throw new Error(`unknown role: ${role}`);
  }
  return role;
}

function matchesPath(targetPath, boundaryPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBoundary = path.resolve(boundaryPath);
  const boundaryPrefix = resolvedBoundary.endsWith(path.sep)
    ? resolvedBoundary
    : `${resolvedBoundary}${path.sep}`;
  const targetPrefix = resolvedTarget.endsWith(path.sep)
    ? resolvedTarget
    : `${resolvedTarget}${path.sep}`;

  if (resolvedTarget === resolvedBoundary || targetPrefix.startsWith(boundaryPrefix)) {
    return { path: resolvedBoundary, specificity: resolvedBoundary.length };
  }
  return null;
}

function resolveScopeMatches(resolvers, targetPath, cpbRoot, project, sourcePath, dataRoot, legacyOnly, effect) {
  return resolvers
    .map((resolver) => resolver(cpbRoot, project, sourcePath, dataRoot, legacyOnly))
    .filter(Boolean)
    .map((boundaryPath) => {
      const match = matchesPath(targetPath, boundaryPath);
      return match ? { ...match, effect } : null;
    })
    .filter(Boolean);
}

export function canWrite(role, targetPath, cpbRoot, project, sourcePath = null, { dataRoot = null, legacyOnly = false }: Record<string, any> = {}) {
  const canonicalRole = validateRole(role);
  const scope = WRITE_SCOPES[canonicalRole];
  if (!scope) return { allowed: false, reason: `unknown role: ${role}` };

  const resolved = path.resolve(targetPath);

  const matches = [
    ...resolveScopeMatches(scope.allowed, targetPath, cpbRoot, project, sourcePath, dataRoot, legacyOnly, "allow"),
    ...resolveScopeMatches(scope.denied, targetPath, cpbRoot, project, sourcePath, dataRoot, legacyOnly, "deny"),
  ].sort((a, b) => {
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    return a.effect === "deny" ? -1 : 1;
  });

  const winner = matches[0];
  if (winner?.effect === "allow") {
    return { allowed: true };
  }

  const allowedDirs = scope.allowed
    .map((r) => r(cpbRoot, project, sourcePath, dataRoot, legacyOnly))
    .filter(Boolean)
    .map((d) => path.resolve(d));

  if (winner?.effect === "deny") {
    return {
      allowed: false,
      reason: `${canonicalRole} cannot write to ${resolved}`,
      allowedBoundary: allowedDirs.join(", "),
      recoveryGuidance: `Write only under allowed boundaries: ${allowedDirs.join(", ")}`,
    };
  }

  return {
    allowed: false,
    reason: `${canonicalRole} write to ${resolved} outside allowed scope: ${allowedDirs.join(", ")}`,
    allowedBoundary: allowedDirs.join(", "),
    recoveryGuidance: `Write only under allowed boundaries: ${allowedDirs.join(", ")}`,
  };
}

export function canRead(role, _targetPath, _cpbRoot, _project, _sourcePath, _jobId) {
  validateRole(role);
  return { allowed: true };
}

export function getReadAllowedPaths(role) {
  validateRole(role);
  return [...READ_ALLOWED_PATHS];
}

const VERIFIER_READ_ONLY_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "cat",
  "sed",
  "head",
  "tail",
  "wc",
  "rg",
  "grep",
]);

// Commands that read file contents — their path arguments must be checked against secret patterns
const FILE_READING_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "bat", "sed", "awk", "grep", "rg", "sort", "uniq", "wc", "tee", "diff", "comm", "cut", "tr", "nl", "od", "xxd"]);

function hasSensitiveTargetInCommand(commandLine) {
  const unwrapped = shellWrappedCommand(commandLine) || String(commandLine || "");
  const words = splitCommandWords(unwrapped);
  const command = path.basename(words[0] || "");
  if (!FILE_READING_COMMANDS.has(command)) return false;

  // Extract non-flag arguments as potential file paths
  for (const word of words.slice(1)) {
    if (word.startsWith("-")) continue;
    // Skip common non-path arguments (numbers for sed -n, regex patterns)
    if (/^\d+$/.test(word)) continue;
    if (/^['"]/.test(word) || /^s\/|^\/.*\/$/.test(word)) continue;
    if (isSecretPath(word)) return true;
  }
  return false;
}

const VERIFIER_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "show",
  "log",
  "rev-parse",
  "ls-files",
  "grep",
]);

const VERIFIER_VALIDATION_SCRIPTS = new Set([
  "test",
  "lint",
  "typecheck",
  "type-check",
  "check",
  "build",
]);

const VERIFIER_DIRECT_TEST_COMMANDS = new Set([
  "jest",
  "mocha",
  "vitest",
  "ava",
  "pytest",
]);

function splitCommandWords(commandLine) {
  return String(commandLine || "")
    .match(/"[^"]*"|'[^']*'|\S+/g)
    ?.map((word) => word.replace(/^['"]|['"]$/g, "")) || [];
}

function shellWrappedCommand(commandLine) {
  const words = splitCommandWords(commandLine);
  const command = path.basename(words[0] || "");
  if (!["sh", "bash", "zsh"].includes(command)) return null;

  const shellFlagIndex = words.findIndex((word) => /^-[a-z]*c$/.test(word));
  if (shellFlagIndex < 0 || shellFlagIndex >= words.length - 1) return null;
  return words.slice(shellFlagIndex + 1).join(" ");
}

function hasShellMutationSyntax(commandLine) {
  return /[;&|<>`$\\\n\r]/.test(String(commandLine || ""));
}

function isVerifierReadOnlyCommand(commandLine) {
  const unwrapped = shellWrappedCommand(commandLine) || String(commandLine || "");
  if (!unwrapped.trim() || hasShellMutationSyntax(unwrapped)) return false;

  const words = splitCommandWords(unwrapped);
  const command = path.basename(words[0] || "");
  if (!command) return false;

  if (command === "git") {
    const subcommand = words.slice(1).find((word) => !word.startsWith("-"));
    return VERIFIER_READ_ONLY_GIT_SUBCOMMANDS.has(subcommand || "");
  }

  if (command === "find") {
    return !words.some((word) => ["-exec", "-execdir", "-delete", "-ok", "-okdir"].includes(word));
  }

  return VERIFIER_READ_ONLY_COMMANDS.has(command);
}

function isValidationScriptName(scriptName) {
  if (!scriptName) return false;
  if (VERIFIER_VALIDATION_SCRIPTS.has(scriptName)) return true;
  return /^(test|lint|typecheck|type-check|check|build):[A-Za-z0-9:_-]+$/.test(scriptName);
}

function isVerifierValidationCommand(commandLine) {
  const unwrapped = shellWrappedCommand(commandLine) || String(commandLine || "");
  if (!unwrapped.trim() || hasShellMutationSyntax(unwrapped)) return false;

  const words = splitCommandWords(unwrapped);
  const command = path.basename(words[0] || "");
  if (!command) return false;

  if (command === "npm") {
    const subcommand = words.slice(1).find((word) => !word.startsWith("-"));
    if (subcommand === "test" || subcommand === "t") return true;
    if (subcommand !== "run") return false;
    const runIndex = words.indexOf(subcommand);
    const scriptName = words.slice(runIndex + 1).find((word) => !word.startsWith("-"));
    return isValidationScriptName(scriptName);
  }

  if (["pnpm", "yarn", "bun"].includes(command)) {
    const subcommand = words.slice(1).find((word) => !word.startsWith("-"));
    if (subcommand === "test") return true;
    if (subcommand === "run") {
      const runIndex = words.indexOf(subcommand);
      const scriptName = words.slice(runIndex + 1).find((word) => !word.startsWith("-"));
      return isValidationScriptName(scriptName);
    }
    return isValidationScriptName(subcommand);
  }

  if (command === "node") {
    return words.slice(1).some((word) => word === "--test" || word.startsWith("--test-"));
  }

  if (command === "python" || command === "python3") {
    const moduleIndex = words.indexOf("-m");
    return moduleIndex >= 0 && words[moduleIndex + 1] === "pytest";
  }

  if (command === "go") {
    return words.slice(1).find((word) => !word.startsWith("-")) === "test";
  }

  if (command === "cargo") {
    return words.slice(1).find((word) => !word.startsWith("-")) === "test";
  }

  if (command === "mvn" || command === "mvnw" || command === "gradle" || command === "gradlew") {
    return words.slice(1).some((word) => word === "test" || word === "check" || word.endsWith(":test"));
  }

  return VERIFIER_DIRECT_TEST_COMMANDS.has(command);
}

function isKnownUnsafeCommand(commandLine) {
  const unwrapped = shellWrappedCommand(commandLine) || String(commandLine || "");
  if (!unwrapped.trim()) return true;
  if (/\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh)\b/.test(unwrapped)) return true;

  const words = splitCommandWords(unwrapped);
  const command = path.basename(words[0] || "");
  if (!command) return true;

  if (["sudo", "su", "rm", "rmdir", "dd", "mkfs", "chmod", "chown", "killall", "pkill"].includes(command)) {
    return true;
  }

  if (command === "git") {
    const subcommand = words.slice(1).find((word) => !word.startsWith("-"));
    return ["reset", "clean", "checkout", "restore", "rebase", "merge", "push", "commit", "tag"].includes(subcommand || "");
  }

  if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
    const subcommand = words.slice(1).find((word) => !word.startsWith("-"));
    if (["publish", "deploy"].includes(subcommand || "")) return true;
    if (subcommand === "run") {
      const runIndex = words.indexOf(subcommand);
      const scriptName = words.slice(runIndex + 1).find((word) => !word.startsWith("-")) || "";
      return /(^|:)(release|deploy|publish)($|:)/.test(scriptName);
    }
    return /^(release|deploy|publish)(:|$)/.test(subcommand || "");
  }

  return false;
}

export function canExecute(role, commandLine, _cpbRoot, _project, _sourcePath = null) {
  const canonicalRole = validateRole(role);

  // All roles: block commands that read sensitive file paths
  if (hasSensitiveTargetInCommand(commandLine)) {
    return {
      allowed: false,
      reason: `terminal command targets sensitive/credential path`,
      recoveryGuidance: "Reading credential or secret files via terminal is not allowed. Use environment variables or a secrets manager instead.",
    };
  }

  if (canonicalRole === "planner") {
    if (isVerifierReadOnlyCommand(commandLine)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "planner may only execute read-only inspection commands",
      recoveryGuidance: "Use read-only local inspection commands such as pwd, ls, cat, sed, rg, git status, or git diff. Leave validation and mutation to later phases.",
    };
  }

  if (canonicalRole === "reviewer") {
    if (isVerifierReadOnlyCommand(commandLine) || isVerifierValidationCommand(commandLine)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "reviewer may only execute inspection or validation commands",
      recoveryGuidance: "Use read-only inspection or validation commands such as npm test, npm run test:*, node --test, pytest, go test, or cargo test.",
    };
  }

  if (canonicalRole === "executor" || canonicalRole === "remediator") {
    if (isKnownUnsafeCommand(commandLine)) {
      return {
        allowed: false,
        reason: `${canonicalRole} cannot execute destructive or publishing commands`,
        recoveryGuidance: "Use local build, test, lint, install, and inspection commands. Do not mutate git history, publish/deploy, remove files with shell commands, or pipe remote scripts into a shell.",
      };
    }
    return { allowed: true };
  }

  if (canonicalRole === "verifier") {
    if (isVerifierReadOnlyCommand(commandLine) || isVerifierValidationCommand(commandLine)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "verifier may only execute inspection or validation commands",
      recoveryGuidance: "Use read-only inspection commands or validation commands such as npm test, npm run test:*, node --test, pytest, go test, or cargo test; write the verdict through the verdict file only.",
    };
  }

  return {
    allowed: false,
    reason: `${canonicalRole} cannot execute terminal commands`,
    recoveryGuidance: "Use file-reading tools or the provided locators for observation in this phase.",
  };
}

export function checkPermission(role, action, targetPath, cpbRoot, project, { sourcePath, jobId, dataRoot, legacyOnly = false }: Record<string, any> = {}) {
  const canonicalRole = validateRole(role);

  if (action === "read") {
    return canRead(canonicalRole, targetPath, cpbRoot, project, sourcePath, jobId);
  }

  if (action === "write") {
    return canWrite(canonicalRole, targetPath, cpbRoot, project, sourcePath, { dataRoot, legacyOnly });
  }

  if (action === "execute") {
    return canExecute(canonicalRole, targetPath, cpbRoot, project, sourcePath);
  }

  return { allowed: false, reason: `unknown action: ${action}` };
}

export async function recordPermissionDenial(
  cpbRoot,
  project,
  jobId,
  {
    role,
    action,
    targetPath,
    reason,
    phase,
    allowedBoundary,
    recoveryGuidance,
    tool,
    dataRoot,
    legacyOnly = false,
  }: Record<string, any>
) {
  if (!dataRoot && !legacyOnly) {
    throw new Error("project runtime root required to record permission denial");
  }
  const eventRole = role ? validateRole(role) : null;
  const event: Record<string, any> = {
    type: "permission_denied",
    category: "infra",
    jobId,
    project,
    phase: phase || eventRole || null,
    role: eventRole,
    action,
    deniedOperation: action || "write",
    targetPath: targetPath || "",
    reason: reason || "write denied by permission matrix",
    allowedBoundary: allowedBoundary || "",
    recoveryGuidance: recoveryGuidance || "Retry with a path permitted by the phase policy.",
    ts: new Date().toISOString(),
  };
  if (tool) event.tool = tool;
  await appendEvent(cpbRoot, project, jobId, event, dataRoot ? { dataRoot, includeLegacyFallback: false } : { includeLegacyFallback: true });
}

export function getObservablePaths(role, cpbRoot, project, { sourcePath = null, dataRoot = null, legacyOnly = false }: Record<string, any> = {}) {
  const canonicalRole = validateRole(role);
  const resolvers = OBSERVATION_PATHS[canonicalRole];
  if (!resolvers) return [];
  return resolvers
    .map((r) => r(cpbRoot, project, sourcePath, dataRoot, legacyOnly))
    .filter(Boolean);
}

export function isInfraDenial(event) {
  return event?.type === "permission_denied" && event?.category === "infra";
}

export function getPhasePolicy(role, cpbRoot, project, { sourcePath = null, profileConfig = null, dataRoot = null, legacyOnly = false }: Record<string, any> = {}) {
  const canonicalRole = validateRole(role);
  const scope = WRITE_SCOPES[canonicalRole];
  const observable = getObservablePaths(canonicalRole, cpbRoot, project, { sourcePath, dataRoot, legacyOnly });

  const basePolicy = {
    role: canonicalRole,
    readScope: "unrestricted",
    readAllowed: getReadAllowedPaths(canonicalRole),
    writeAllowed: scope.allowed.map((r) => r(cpbRoot, project, sourcePath, dataRoot, legacyOnly)).filter(Boolean),
    writeDenied: scope.denied.map((r) => r(cpbRoot, project, sourcePath, dataRoot, legacyOnly)).filter(Boolean),
    observablePaths: observable,
    executionBoundary: REQUIRED_EXECUTION_BOUNDARY,
  };

  if (profileConfig) {
    return mergeProfilePolicy(basePolicy, profileConfig);
  }
  return basePolicy;
}

export function mergeProfilePolicy(basePolicy, profileConfig) {
  if (!profileConfig || typeof profileConfig !== "object") return basePolicy;

  const merged = { ...basePolicy };

  if (Array.isArray(profileConfig.deny_tools)) {
    merged.denyTools = [...profileConfig.deny_tools];
  }
  if (Array.isArray(profileConfig.deny_commands)) {
    merged.denyCommands = [...profileConfig.deny_commands];
  }
  if (Array.isArray(profileConfig.write_paths)) {
    // Restrict glob-all write_paths (**/*) unless CPB_DANGEROUS=1
    const paths = process.env.CPB_DANGEROUS === "1"
      ? profileConfig.write_paths
      : profileConfig.write_paths.filter((p) => p !== "**/*");
    merged.writeAllowed = [...merged.writeAllowed, ...paths];
  }
  merged.executionBoundary = REQUIRED_EXECUTION_BOUNDARY;

  merged.profileConfigured = true;
  return merged;
}

const SECRET_PATH_PATTERNS = [
  /(?:^|[\\/])\.env(?:[._-]|$)/i,           // .env, .env.local, .env.production
  /(?:^|[\\/])\.credentials(?:[._-]|$)/i,   // .credentials, .credentials.json
  /(?:^|[\\/])[\w-]*secret[\w-]*(?:[._-]|$)/i,  // *secret*, *secrets*, access-secret
  /(?:^|[\\/])[\w-]*token[\w-]*(?:[._-]|$)/i,   // *token*, *tokens*, access-token.json
  /\.(?:pem|key)$/i,                         // *.pem, *.key
  /(?:^|[\\/])\.gitconfig$/i,               // .gitconfig
  /(?:^|[\\/])\.git-credentials$/i,         // .git-credentials
  /(?:^|[\\/])\.zsh_history$/i,             // .zsh_history
  /(?:^|[\\/])\.bash_history$/i,            // .bash_history
  /(?:^|[\\/])keys\.json$/i,                // keys.json
  /(?:^|[\\/])google-creds\.json$/i,        // google-creds.json
  /(?:^|[\\/])credentials\.json$/i,         // credentials.json
  /(?:^|[\\/])service-account[^\\/]*\.json$/i, // service-account*.json
];

function isSecretPath(targetPath) {
  const resolved = path.resolve(targetPath);
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(resolved));
}

export function evaluatePermissionDecision(role, phase, action, targetPath, cpbRoot, project, { sourcePath = null, dataRoot = null, legacyOnly = false }: Record<string, any> = {}) {
  // Action validation
  if (!["read", "write", "execute"].includes(action)) {
    return {
      allowed: false,
      classification: "deny",
      action,
      role,
      phase,
      reason: `unknown action: ${action}`,
      recoveryGuidance: "Action must be one of: read, write, execute.",
      observable: true,
    };
  }

  // Read: broadly allowed, except secret paths
  if (action === "read") {
    if (isSecretPath(targetPath)) {
      return {
        allowed: false,
        classification: "deny",
        action: "read",
        role,
        phase,
        reason: `read denied: ${path.resolve(targetPath)} matches secret/credential path pattern`,
        recoveryGuidance: "This path contains secrets and should not be read directly. Use environment variables or a secrets manager instead.",
        observable: true,
      };
    }
    return {
      allowed: true,
      classification: "allow",
      action: "read",
      role,
      phase,
      reason: "",
      recoveryGuidance: null,
      observable: true,
    };
  }

  // Write: delegate to existing canWrite logic
  if (action === "write") {
    const result = canWrite(role, targetPath, cpbRoot, project, sourcePath, { dataRoot, legacyOnly });
    if (result.allowed) {
      return {
        allowed: true,
        classification: "allow",
        action: "write",
        role,
        phase,
        reason: "",
        recoveryGuidance: null,
        observable: true,
      };
    }
    return {
      allowed: false,
      classification: "infra_block",
      action: "write",
      role,
      phase,
      reason: result.reason || `${role} write denied for ${targetPath}`,
      recoveryGuidance: result.recoveryGuidance || "Use the project wiki outputs directory instead.",
      observable: true,
    };
  }

  // Execute: delegate to existing canExecute logic
  if (action === "execute") {
    const result = canExecute(role, targetPath, cpbRoot, project, sourcePath);
    if (result.allowed) {
      return {
        allowed: true,
        classification: "allow",
        action: "execute",
        role,
        phase,
        reason: "",
        recoveryGuidance: null,
        observable: true,
      };
    }
    return {
      allowed: false,
      classification: "infra_block",
      action: "execute",
      role,
      phase,
      reason: result.reason || `${role} execute denied for ${targetPath}`,
      recoveryGuidance: result.recoveryGuidance || null,
      observable: true,
    };
  }

  // Should not reach here, but for completeness
  return {
    allowed: false,
    classification: "deny",
    action,
    role,
    phase,
    reason: "unhandled permission evaluation",
    recoveryGuidance: null,
    observable: true,
  };
}

export function classifyVerdictOutcome(verdictStatus) {
  if (verdictStatus === "infra_error") return INFRA_FAILURE;
  return verdictStatus;
}
