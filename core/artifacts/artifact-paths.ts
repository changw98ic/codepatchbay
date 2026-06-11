import path from "node:path";

const KIND_DIR: Record<string, string> = { plan: "inbox", deliverable: "outputs", verdict: "outputs", review: "outputs", remediation: "outputs", prompt: "outputs" };

export function resolveArtifactDir(cpbRoot: string, project: string, kind: string) {
  const sub = KIND_DIR[kind] || "outputs";
  const dataRoot = process.env.CPB_PROJECT_RUNTIME_ROOT;
  if (dataRoot) return path.join(dataRoot, "wiki", sub);
  throw new Error(`project runtime root required for project '${project}'`);
}

export function resolveArtifactDirForRoot(dataRoot: string, kind: string) {
  const sub = KIND_DIR[kind] || "outputs";
  if (!dataRoot) throw new Error("project runtime root is required");
  return path.join(dataRoot, "wiki", sub);
}

export function resolveArtifactPathForRoot(dataRoot: string, kind: string, id: string) {
  return path.join(resolveArtifactDirForRoot(dataRoot, kind), `${kind}-${id}.md`);
}

export function resolveLegacyArtifactDir(cpbRoot: string, project: string, kind: string) {
  const sub = KIND_DIR[kind] || "outputs";
  return path.join(cpbRoot, "wiki", "projects", project, sub);
}

export function resolveArtifactPath(cpbRoot: string, project: string, kind: string, id: string) {
  return path.join(resolveArtifactDir(cpbRoot, project, kind), `${kind}-${id}.md`);
}
