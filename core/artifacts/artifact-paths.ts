import path from "node:path";

const KIND_DIR: Record<string, string> = { plan: "inbox", deliverable: "outputs", verdict: "outputs", review: "outputs", remediation: "outputs", prompt: "outputs" };

export function resolveArtifactDir(cpbRoot: string, project: string, kind: string) {
  const sub = KIND_DIR[kind] || "outputs";
  return path.join(cpbRoot, "wiki", "projects", project, sub);
}

export function resolveArtifactPath(cpbRoot: string, project: string, kind: string, id: string) {
  return path.join(resolveArtifactDir(cpbRoot, project, kind), `${kind}-${id}.md`);
}
