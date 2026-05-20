import path from "node:path";
import { appendEvent } from "./runtime-events.js";
import { runtimeDataPath } from "./runtime-root.js";

const ROLES = new Set(["codex-plan", "codex-verify", "claude-execute", "claude-repair", "reviewer-review"]);

const WRITE_SCOPES = {
  "codex-plan": {
    allowed: [
      (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project, "inbox"),
    ],
    denied: [
      (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project, "outputs"),
    ],
  },
  "claude-execute": {
    allowed: [
      (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project, "outputs"),
      (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
    ],
    denied: [
      (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project, "inbox"),
      (cpbRoot) => path.resolve(cpbRoot, "wiki", "system"),
      (cpbRoot) => path.resolve(cpbRoot, "profiles"),
      (cpbRoot) => path.resolve(cpbRoot, "bridges"),
    ],
  },
  "codex-verify": {
    allowed: [
      (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project, "outputs"),
    ],
    denied: [
      (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project, "inbox"),
      (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
    ],
  },
  "claude-repair": {
    allowed: [
      (cpbRoot) => path.resolve(cpbRoot),
    ],
    denied: [],
  },
  "reviewer-review": {
    allowed: [
      (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project, "outputs"),
    ],
    denied: [],
  },
};

const OBSERVATION_PATHS = {
  "codex-plan": [
    (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project),
    (cpbRoot) => path.resolve(cpbRoot, "wiki", "system"),
    (cpbRoot) => path.resolve(cpbRoot, "templates"),
    (cpbRoot) => path.resolve(cpbRoot, "profiles"),
    (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
  ],
  "codex-verify": [
    (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project),
    (cpbRoot) => path.resolve(cpbRoot, "wiki", "system"),
    (cpbRoot) => path.resolve(cpbRoot, "templates"),
    (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
    (cpbRoot, project) => runtimeDataPath(cpbRoot, "events", project),
    (cpbRoot, project) => runtimeDataPath(cpbRoot, "state"),
    (cpbRoot) => runtimeDataPath(cpbRoot, "checkpoints"),
  ],
  "claude-execute": [
    (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project),
    (cpbRoot) => path.resolve(cpbRoot, "wiki", "system"),
    (cpbRoot) => path.resolve(cpbRoot, "templates"),
    (cpbRoot) => path.resolve(cpbRoot, "profiles"),
    (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
  ],
  "claude-repair": [
    (cpbRoot) => path.resolve(cpbRoot),
  ],
  "reviewer-review": [
    (cpbRoot, project) => path.resolve(cpbRoot, "wiki", "projects", project),
    (cpbRoot) => path.resolve(cpbRoot, "wiki", "system"),
    (_cpbRoot, _project, sourcePath) => sourcePath ? path.resolve(sourcePath) : null,
  ],
};

export function validateRole(role) {
  if (!ROLES.has(role)) {
    throw new Error(`unknown role: ${role}`);
  }
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

function resolveScopeMatches(resolvers, targetPath, cpbRoot, project, sourcePath, effect) {
  return resolvers
    .map((resolver) => resolver(cpbRoot, project, sourcePath))
    .filter(Boolean)
    .map((boundaryPath) => {
      const match = matchesPath(targetPath, boundaryPath);
      return match ? { ...match, effect } : null;
    })
    .filter(Boolean);
}

export function canWrite(role, targetPath, cpbRoot, project, sourcePath = null) {
  const scope = WRITE_SCOPES[role];
  if (!scope) return { allowed: false, reason: `unknown role: ${role}` };

  const resolved = path.resolve(targetPath);

  const matches = [
    ...resolveScopeMatches(scope.allowed, targetPath, cpbRoot, project, sourcePath, "allow"),
    ...resolveScopeMatches(scope.denied, targetPath, cpbRoot, project, sourcePath, "deny"),
  ].sort((a, b) => {
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    return a.effect === "deny" ? -1 : 1;
  });

  const winner = matches[0];
  if (winner?.effect === "allow") {
    return { allowed: true };
  }

  const allowedDirs = scope.allowed
    .map((r) => r(cpbRoot, project, sourcePath))
    .filter(Boolean)
    .map((d) => path.resolve(d));

  if (winner?.effect === "deny") {
    return {
      allowed: false,
      reason: `${role} cannot write to ${resolved}`,
      allowedBoundary: allowedDirs.join(", "),
      recoveryGuidance: `Write only under allowed boundaries: ${allowedDirs.join(", ")}`,
    };
  }

  return {
    allowed: false,
    reason: `${role} write to ${resolved} outside allowed scope: ${allowedDirs.join(", ")}`,
    allowedBoundary: allowedDirs.join(", "),
    recoveryGuidance: `Write only under allowed boundaries: ${allowedDirs.join(", ")}`,
  };
}

export function canRead(_role, _targetPath, _cpbRoot, _project, _sourcePath, _jobId) {
  return { allowed: true };
}

export function checkPermission(role, action, targetPath, cpbRoot, project, { sourcePath, jobId } = {}) {
  validateRole(role);

  if (action === "read") {
    return canRead(role, targetPath, cpbRoot, project, sourcePath, jobId);
  }

  if (action === "write") {
    return canWrite(role, targetPath, cpbRoot, project, sourcePath);
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
  }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "permission_denied",
    category: "infra",
    jobId,
    project,
    phase: phase || role || null,
    role,
    action,
    deniedOperation: action || "write",
    targetPath: targetPath || "",
    reason: reason || "write denied by permission matrix",
    allowedBoundary: allowedBoundary || "",
    recoveryGuidance: recoveryGuidance || "Retry with a path permitted by the phase policy.",
    ts: new Date().toISOString(),
  });
}

export function getObservablePaths(role, cpbRoot, project, { sourcePath = null } = {}) {
  const resolvers = OBSERVATION_PATHS[role];
  if (!resolvers) return [];
  return resolvers
    .map((r) => r(cpbRoot, project, sourcePath))
    .filter(Boolean);
}

export function isInfraDenial(event) {
  return event?.type === "permission_denied" && event?.category === "infra";
}

export function getPhasePolicy(role, cpbRoot, project, { sourcePath = null } = {}) {
  validateRole(role);
  const scope = WRITE_SCOPES[role];
  const observable = getObservablePaths(role, cpbRoot, project, { sourcePath });
  return {
    role,
    writeAllowed: scope.allowed.map((r) => r(cpbRoot, project, sourcePath)).filter(Boolean),
    writeDenied: scope.denied.map((r) => r(cpbRoot, project, sourcePath)).filter(Boolean),
    observablePaths: observable,
  };
}
