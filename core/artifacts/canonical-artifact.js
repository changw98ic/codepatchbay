import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";

export const ARTIFACT_SCHEMA_VERSION = 2;

export const ArtifactKind = {
  PLAN: "plan",
  DELIVERABLE: "deliverable",
  VERDICT: "verdict",
  REVIEW: "review",
  REPAIR: "repair",
  DIFF: "diff",
  TESTS: "tests",
  RISK: "risk",
  PR: "pr",
  CONTEXT_PACK: "context-pack",
};

export const KNOWN_KINDS = new Set(Object.values(ArtifactKind));

/**
 * Create a canonical artifact descriptor.
 * This is the single source of truth for artifact metadata shape.
 */
export function createArtifact({
  kind,
  id,
  path: artifactPath,
  content,
  project,
  jobId,
  producerAgent = null,
  phase = null,
  metadata = {},
}) {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    kind,
    id,
    name: `${kind}-${id}`,
    path: artifactPath,
    bytes: content ? Buffer.byteLength(content, "utf8") : 0,
    sha256: content ? sha256(content) : null,
    project,
    jobId,
    phase,
    producerAgent,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Allocate a unique sequential artifact ID within a directory.
 * Uses mkdir-based atomic locking.
 */
export async function allocateArtifactId(dir, prefix) {
  await mkdir(dir, { recursive: true });

  const lockDir = path.join(dir, ".cpb-id.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!acquired) {
    try { await mkdir(lockDir); } catch { /* force through stale lock */ }
  }

  try {
    const entries = await readdir(dir);
    const pattern = new RegExp(`^${prefix}-(\\d+)\\.md$`);
    let last = 0;
    for (const entry of entries) {
      const match = entry.match(pattern);
      if (match) last = Math.max(last, parseInt(match[1], 10));
    }
    return String(last + 1).padStart(3, "0");
  } finally {
    try {
      const { rmdir } = await import("node:fs/promises");
      await rmdir(lockDir);
    } catch {}
  }
}

function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
