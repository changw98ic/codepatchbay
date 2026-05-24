import path from "node:path";
import { runtimeDataRoot } from "./runtime-root.js";
import { getProject, listProjects, resolveHubRoot } from "./hub-registry.js";

function uniqueRoots(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry?.dataRoot) continue;
    const dataRoot = path.resolve(entry.dataRoot);
    if (seen.has(dataRoot)) continue;
    seen.add(dataRoot);
    result.push({ ...entry, dataRoot });
  }
  return result;
}

export async function resolveProjectDataRoot(cpbRoot, project, { hubRoot, dataRoot } = {}) {
  if (dataRoot) return path.resolve(dataRoot);
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  try {
    const registered = await getProject(resolvedHubRoot, project);
    if (registered?.projectRuntimeRoot) return path.resolve(registered.projectRuntimeRoot);
  } catch {}
  return runtimeDataRoot(cpbRoot);
}

export async function listRuntimeDataRoots(cpbRoot, { hubRoot } = {}) {
  const entries = [{ kind: "legacy", dataRoot: runtimeDataRoot(cpbRoot), projectId: null }];
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  try {
    const projects = await listProjects(resolvedHubRoot);
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
