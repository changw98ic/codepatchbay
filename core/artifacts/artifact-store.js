import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import { resolveArtifactDir, resolveArtifactPath } from "./artifact-paths.js";

export async function writeArtifact(cpbRoot, { project, jobId, kind, content, metadata = {} }) {
  const id = await allocateArtifactId(cpbRoot, project, kind);
  const filePath = resolveArtifactPath(cpbRoot, project, kind, id);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");

  return {
    kind,
    id,
    name: `${kind}-${id}`,
    path: filePath,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content),
    metadata: { ...metadata, project, jobId, kind },
  };
}

export async function allocateArtifactId(cpbRoot, project, kind) {
  const dir = resolveArtifactDir(cpbRoot, project, kind);
  await mkdir(dir, { recursive: true });

  // mkdir-based atomic ID allocation (same pattern as existing artifact-locator.js)
  const ts = Date.now();
  for (let seq = 1; seq <= 999; seq++) {
    const id = String(seq).padStart(3, "0");
    const lockDir = path.join(dir, `.lock-${kind}-${id}`);
    try {
      await mkdir(lockDir);
      // Write placeholder to reserve the ID
      await writeFile(path.join(lockDir, "job"), jobId || "unknown", "utf8");
      return id;
    } catch {
      continue;
    }
  }
  throw new Error(`artifact ID exhausted for ${project}/${kind}`);
}

function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

