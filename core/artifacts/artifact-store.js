import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { resolveArtifactDir, resolveArtifactPath } from "./artifact-paths.js";
import { createArtifact, allocateArtifactId } from "./canonical-artifact.js";

export { allocateArtifactId };

export async function writeArtifact(cpbRoot, { project, jobId, kind, content, metadata = {} }) {
  const dir = resolveArtifactDir(cpbRoot, project, kind);
  const id = await allocateArtifactId(dir, kind);
  const filePath = resolveArtifactPath(cpbRoot, project, kind, id);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");

  return createArtifact({
    kind,
    id,
    path: filePath,
    content,
    project,
    jobId,
    metadata,
  });
}
