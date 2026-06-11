import path from "node:path";
import { getProject, listProjects, resolveHubRoot } from "./hub-registry.js";

type RuntimeRootEntry = { kind: string; dataRoot: string; projectId: string | null };

function uniqueRoots(entries: RuntimeRootEntry[]) {
  const seen = new Set<string>();
  const result: RuntimeRootEntry[] = [];
  for (const entry of entries) {
    if (!entry?.dataRoot) continue;
    const dataRoot = path.resolve(entry.dataRoot);
    if (seen.has(dataRoot)) continue;
    seen.add(dataRoot);
    result.push({ ...entry, dataRoot });
  }
  return result;
}

export async function resolveProjectDataRoot(cpbRoot: string, project: string, { hubRoot, dataRoot }: { hubRoot?: string; dataRoot?: string } = {}) {
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  const registered = await getProject(resolvedHubRoot, project);
  if (registered?.projectRuntimeRoot) {
    const registeredRoot = path.resolve(registered.projectRuntimeRoot);
    if (dataRoot && path.resolve(dataRoot) !== registeredRoot) {
      throw new Error(`CPB_PROJECT_RUNTIME_ROOT does not match Hub registry for project '${project}'`);
    }
    return registeredRoot;
  }
  throw new Error(`project runtime root required for project '${project}'`);
}

export async function listRuntimeDataRoots(cpbRoot: string, { hubRoot, includeHubProjects = true, includeLegacy = false }: { hubRoot?: string; includeHubProjects?: boolean; includeLegacy?: boolean } = {}) {
  const entries: RuntimeRootEntry[] = [];
  if (includeLegacy) {
    entries.push({ kind: "legacy", dataRoot: path.join(path.resolve(cpbRoot), "cpb-task"), projectId: null });
  }
  if (!includeHubProjects) return uniqueRoots(entries);
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  const projects = await listProjects(resolvedHubRoot) as Array<{ id: string; projectRuntimeRoot?: string }>;
  for (const project of projects) {
    if (project.projectRuntimeRoot) {
      entries.push({
        kind: "project",
        projectId: project.id,
        dataRoot: project.projectRuntimeRoot,
      });
    }
  }
  return uniqueRoots(entries);
}
