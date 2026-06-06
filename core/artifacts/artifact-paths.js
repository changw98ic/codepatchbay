import path from "node:path";

const KIND_DIR = { plan: "inbox", deliverable: "outputs", verdict: "outputs", review: "outputs", remediation: "outputs", prompt: "outputs" };

export function resolveArtifactDir(cpbRoot, project, kind) {
  const sub = KIND_DIR[kind] || "outputs";
  return path.join(cpbRoot, "wiki", "projects", project, sub);
}

export function resolveArtifactPath(cpbRoot, project, kind, id) {
  return path.join(resolveArtifactDir(cpbRoot, project, kind), `${kind}-${id}.md`);
}
