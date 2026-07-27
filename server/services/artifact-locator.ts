import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { withDurableDirectoryLock } from "../../core/runtime/durable-directory-lock.js";
import { projectRuntimePath } from "./runtime.js";

export { buildArtifactIndex } from "./job/job-projection.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export type ArtifactLocatorTestHooks = {
  syncFile?: (filePath: string) => void | Promise<void>;
  syncDirectory?: (directory: string) => void | Promise<void>;
};

const artifactLocatorTestHookStorage = new AsyncLocalStorage<ArtifactLocatorTestHooks>();

export function withArtifactLocatorTestHooks<T>(hooks: ArtifactLocatorTestHooks, action: () => T): T {
  return artifactLocatorTestHookStorage.run(hooks, action);
}

function validateName(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

async function syncArtifactDirectory(directory: string, hooks: ArtifactLocatorTestHooks) {
  if (hooks.syncDirectory) {
    await hooks.syncDirectory(directory);
    return;
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  if (handle) {
    try { await handle.close(); } catch (error) { closeError = error; }
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw new AggregateError([primaryError, closeError], `artifact directory sync and close failed: ${directory}`, {
      cause: primaryError,
    });
  }
  if (closeError) throw closeError;
}

function artifactIdCommittedAmbiguity(
  artifactId: string,
  artifactPath: string,
  directory: string,
  errors: unknown[],
) {
  const primaryError = errors[0];
  const cause = errors.length === 1
    ? primaryError
    : new AggregateError(errors, `artifact placeholder durability failed: ${artifactPath}`, {
      cause: primaryError,
    });
  return Object.assign(new Error(`artifact ID ${artifactId} committed with ambiguous durability`, { cause }), {
    code: "ARTIFACT_ID_COMMITTED_AMBIGUOUS",
    artifactId,
    artifactPath,
    committed: true,
    committedPath: artifactPath,
    recoveryPaths: [artifactPath, directory],
    primaryError,
    cleanupErrors: errors.slice(1),
  });
}

export async function allocateArtifactId(dir: string, prefix: string) {
  validateName(prefix, "prefix");
  await mkdir(dir, { recursive: true });
  const hooks = artifactLocatorTestHookStorage.getStore() || {};

  const lockDir = path.join(dir, ".cpb-id.lock");
  return withDurableDirectoryLock(lockDir, async () => {
    const entries = await readdir(dir);
    const pattern = new RegExp(`^${prefix}-(\\d+)\\.md$`);
    let last = 0;
    for (const entry of entries) {
      const match = entry.match(pattern);
      if (match) last = Math.max(last, parseInt(match[1], 10));
    }
    const newId = String(last + 1).padStart(3, "0");
    const artifactPath = path.join(dir, `${prefix}-${newId}.md`);
    const handle = await open(artifactPath, "wx", 0o600);
    let primaryError: unknown = null;
    try {
      if (hooks.syncFile) await hooks.syncFile(artifactPath);
      else await handle.sync();
    } catch (error) {
      primaryError = error;
    }
    let closeError: unknown = null;
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
    const fileErrors = [primaryError, closeError].filter((error) => error !== null);
    if (fileErrors.length > 0) {
      throw artifactIdCommittedAmbiguity(newId, artifactPath, dir, fileErrors);
    }
    try {
      await syncArtifactDirectory(dir, hooks);
    } catch (error) {
      throw artifactIdCommittedAmbiguity(newId, artifactPath, dir, [error]);
    }
    return newId;
  }, { ttlMs: 30_000, waitMs: 10_000, retryMs: 50 });
}

// --- Hub-managed project runtime paths ---

export function runtimeWikiDir(hubRoot: string, projectId: string) {
  validateName(projectId, "projectId");
  return projectRuntimePath(hubRoot, projectId, "wiki");
}

export function runtimeInboxDir(hubRoot: string, projectId: string) {
  return path.join(runtimeWikiDir(hubRoot, projectId), "inbox");
}

export function runtimeOutputsDir(hubRoot: string, projectId: string) {
  return path.join(runtimeWikiDir(hubRoot, projectId), "outputs");
}

export async function resolveWikiDir(hubRoot: string, _cpbRoot: string, projectId: string) {
  if (!hubRoot) throw new Error("hubRoot is required for project wiki paths");
  return runtimeWikiDir(hubRoot, projectId);
}

export async function resolveInboxDir(hubRoot: string, _cpbRoot: string, projectId: string) {
  if (!hubRoot) throw new Error("hubRoot is required for project inbox paths");
  return runtimeInboxDir(hubRoot, projectId);
}

export async function resolveOutputsDir(hubRoot: string, _cpbRoot: string, projectId: string) {
  if (!hubRoot) throw new Error("hubRoot is required for project outputs paths");
  return runtimeOutputsDir(hubRoot, projectId);
}

function validateRelativePath(relativePath: string) {
  if (String(relativePath).includes("\0")) {
    throw new Error("relative path traversal denied");
  }
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("relative path traversal denied");
  }
  return normalized;
}

export function runtimeArtifactPath(hubRoot: string, projectId: string, relativePath: string) {
  const normalized = validateRelativePath(relativePath);
  return path.join(runtimeWikiDir(hubRoot, projectId), normalized);
}

export async function resolveArtifactPath(hubRoot: string, _cpbRoot: string, projectId: string, relativePath: string) {
  if (!hubRoot) throw new Error("hubRoot is required for project artifact paths");
  return runtimeArtifactPath(hubRoot, projectId, relativePath);
}

// --- Runtime-aware artifact writers ---

export async function runtimePlanFilePath(hubRoot: string, cpbRoot: string, project: string, planId: string) {
  const dir = await resolveInboxDir(hubRoot, cpbRoot, project);
  return path.join(dir, `plan-${planId}.md`);
}

export async function runtimeDeliverableFilePath(hubRoot: string, cpbRoot: string, project: string, deliverableId: string) {
  const dir = await resolveOutputsDir(hubRoot, cpbRoot, project);
  return path.join(dir, `deliverable-${deliverableId}.md`);
}

export async function runtimeVerdictFilePath(hubRoot: string, cpbRoot: string, project: string, artifactId: string) {
  const dir = await resolveOutputsDir(hubRoot, cpbRoot, project);
  return path.join(dir, `verdict-${artifactId}.md`);
}

export async function runtimeWikiLogPath(hubRoot: string, cpbRoot: string, project: string) {
  const dir = await resolveWikiDir(hubRoot, cpbRoot, project);
  return path.join(dir, "log.md");
}

export function dashboardPath(hubRoot: string) {
  if (!hubRoot) throw new Error("hubRoot is required for the system dashboard path");
  return path.join(path.resolve(hubRoot), "wiki", "system", "dashboard.md");
}
