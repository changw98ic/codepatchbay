import os from "node:os";
import path from "node:path";

export function cpbHome() {
  return process.env.CPB_HOME || path.join(os.homedir(), ".cpb");
}

export function defaultProjectRuntimeRoot(projectId: string) {
  return path.join(cpbHome(), "projects", projectId);
}

export function projectRuntimeRoot(hubRoot: string, projectId: string) {
  return path.join(path.resolve(hubRoot), "projects", projectId);
}

export function projectRuntimePath(hubRoot: string, projectId: string, ...parts: string[]) {
  return path.join(projectRuntimeRoot(hubRoot, projectId), ...parts);
}

export function resolveDataRoot(_cpbRoot: string, { hubRoot, projectId }: { hubRoot?: string; projectId?: string } = {}) {
  if (!hubRoot || !projectId) {
    throw new Error("hubRoot and projectId are required for project runtime paths");
  }
  return projectRuntimeRoot(hubRoot, projectId);
}

export function dataPath(root: string, ...parts: string[]) {
  return path.join(path.resolve(root), ...parts);
}
