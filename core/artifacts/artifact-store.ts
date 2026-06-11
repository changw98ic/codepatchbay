import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import { resolveArtifactDir, resolveArtifactPath } from "./artifact-paths.js";

export async function writeArtifact(cpbRoot: string, { project, jobId, kind, content, metadata = {} }: { project: string; jobId: string; kind: string; content: string; metadata?: Record<string, unknown> }) {
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

export async function allocateArtifactId(cpbRoot: string, project: string, kind: string) {
  const dir = resolveArtifactDir(cpbRoot, project, kind);
  await mkdir(dir, { recursive: true });

  // Timestamp-based ID with collision retry
  const base = Date.now();
  for (let attempt = 0; attempt < 10; attempt++) {
    const ts = base + attempt;
    const id = String(ts).slice(-6);
    const lockDir = path.join(dir, `.lock-${kind}-${id}`);
    try {
      await mkdir(lockDir);
      return id;
    } catch {
      continue;
    }
  }
  // Fallback: random ID
  const id = crypto.randomBytes(3).toString("hex");
  const lockDir = path.join(dir, `.lock-${kind}-${id}`);
  await mkdir(lockDir, { recursive: true });
  return id;
}

function sha256(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
