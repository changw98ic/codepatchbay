import os from "node:os";
import path from "node:path";

// --- Legacy (backward compat) ---

export function runtimeDataRoot(cpbRoot) {
  if (process.env.CPB_PROJECT_RUNTIME_ROOT) {
    return path.resolve(process.env.CPB_PROJECT_RUNTIME_ROOT);
  }
  return path.join(path.resolve(cpbRoot), "cpb-task");
}

export function runtimeDataPath(cpbRoot, ...parts) {
  return path.join(runtimeDataRoot(cpbRoot), ...parts);
}

// --- New root resolution (hub-managed) ---

export function cpbHome() {
  return process.env.CPB_HOME || path.join(os.homedir(), ".cpb");
}

export function defaultProjectRuntimeRoot(projectId) {
  return path.join(cpbHome(), "projects", projectId);
}

export function projectRuntimeRoot(hubRoot, projectId) {
  return path.join(path.resolve(hubRoot), "projects", projectId);
}

export function projectRuntimePath(hubRoot, projectId, ...parts) {
  return path.join(projectRuntimeRoot(hubRoot, projectId), ...parts);
}

export function resolveDataRoot(cpbRoot, { hubRoot, projectId } = {}) {
  if (hubRoot && projectId) {
    return projectRuntimeRoot(hubRoot, projectId);
  }
  return runtimeDataRoot(cpbRoot);
}

export function dataPath(root, ...parts) {
  return path.join(path.resolve(root), ...parts);
}
