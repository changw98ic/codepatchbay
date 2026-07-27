import path from "node:path";

const KIND_DIR: Record<string, string> = { plan: "inbox", deliverable: "outputs", verdict: "outputs", review: "outputs", remediation: "outputs", prompt: "outputs" };

export function resolveArtifactDirForRoot(dataRoot: string, kind: string) {
  const sub = KIND_DIR[kind] || "outputs";
  if (!dataRoot) throw new Error("project runtime root is required");
  return path.join(dataRoot, "wiki", sub);
}

export function resolveArtifactPathForRoot(dataRoot: string, kind: string, id: string) {
  return path.join(resolveArtifactDirForRoot(dataRoot, kind), `${kind}-${id}.md`);
}
