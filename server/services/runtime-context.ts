import path from "node:path";
import { runtimeDataRoot } from "./runtime-root.js";
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
  if (dataRoot) return path.resolve(dataRoot);
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  try {
    const registered = await getProject(resolvedHubRoot, project);
    if (registered?.projectRuntimeRoot) return path.resolve(registered.projectRuntimeRoot);
  } catch {}
  return runtimeDataRoot(cpbRoot);
}

export async function listRuntimeDataRoots(cpbRoot: string, { hubRoot, includeHubProjects = true }: { hubRoot?: string; includeHubProjects?: boolean } = {}) {
  const entries: RuntimeRootEntry[] = [{ kind: "legacy", dataRoot: runtimeDataRoot(cpbRoot), projectId: null }];
  if (!includeHubProjects) return uniqueRoots(entries);
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  try {
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
  } catch {}
  return uniqueRoots(entries);
}
