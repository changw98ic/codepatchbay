import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { loadRegistry, saveRegistry } from "./hub-registry.js";

const VALID_STATES = new Set(["indexed", "stale", "failed", "indexing", "unmerged"]);

const STATE_NORMALIZE = {
  completed_unmerged: "unmerged",
  merged_indexing: "indexing",
  merged_indexed: "indexed",
  merged_index_stale: "stale",
  merge_failed: "failed",
};

export function normalizeProjectIndex(raw) {
  if (!raw || typeof raw !== "object") return null;

  const rawState = raw.state || raw.status || "";
  const state =
    STATE_NORMALIZE[rawState] ||
    (VALID_STATES.has(rawState) ? rawState : null);

  if (!state) return null;

  const timestamp =
    raw.timestamp || raw.indexedAt || raw.updatedAt || raw.failedAt || null;
  const shortHead = raw.gitHead
    ? raw.gitHead.length > 12
      ? raw.gitHead.slice(0, 12)
      : raw.gitHead
    : null;

  return {
    state,
    raw: rawState !== state ? rawState : null,
    branch: raw.branch || null,
    gitHead: raw.gitHead || null,
    gitHeadShort: shortHead,
    indexedFrom: raw.indexedFrom || null,
    timestamp: timestamp ? new Date(timestamp).toISOString() : null,
    error: raw.error || null,
  };
}

export async function readProjectIndex(hubRoot, cpbRoot, projectId) {
  // Primary: Hub registry metadata
  if (hubRoot) {
    try {
      const registry = await loadRegistry(hubRoot);
      const project = registry.projects[projectId];
      if (project?.metadata?.projectIndex) {
        return normalizeProjectIndex(project.metadata.projectIndex);
      }
    } catch {}
  }

  // Fallback: legacy wiki project.json
  if (cpbRoot) {
    try {
      const metaPath = path.join(
        cpbRoot,
        "wiki",
        "projects",
        projectId,
        "project.json"
      );
      const raw = JSON.parse(await readFile(metaPath, "utf8"));
      if (raw.projectIndex) {
        return normalizeProjectIndex(raw.projectIndex);
      }
    } catch {}
  }

  return null;
}

export async function writeProjectIndex(hubRoot, cpbRoot, projectId, data) {
  const normalized = normalizeProjectIndex(data);
  if (!normalized) {
    throw new Error("Invalid project index data: cannot normalize");
  }

  const persistable = {
    // Store the raw state so readers can normalize with the raw facet intact
    state: data.state || data.status || normalized.state,
    branch: data.branch || null,
    gitHead: data.gitHead || null,
    indexedFrom: data.indexedFrom || null,
    timestamp: normalized.timestamp || new Date().toISOString(),
    ...(data.error ? { error: data.error } : {}),
  };

  const returned = { ...normalized, timestamp: persistable.timestamp };

  // Write to Hub registry if available
  if (hubRoot) {
    const registry = await loadRegistry(hubRoot);
    const project = registry.projects[projectId];
    if (project) {
      project.metadata = project.metadata || {};
      project.metadata.projectIndex = persistable;
      await saveRegistry(hubRoot, registry);
      return returned;
    }
  }

  // Fallback: legacy wiki project.json
  if (cpbRoot) {
    const metaPath = path.join(
      cpbRoot,
      "wiki",
      "projects",
      projectId,
      "project.json"
    );
    let existing: Record<string, any> = {};
    try {
      existing = JSON.parse(await readFile(metaPath, "utf8"));
    } catch {}
    existing.projectIndex = persistable;
    await mkdir(path.dirname(metaPath), { recursive: true });
    const tmp = `${metaPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(existing, null, 2) + "\n", "utf8");
    await rename(tmp, metaPath);
    return returned;
  }

  throw new Error("No writable storage: hubRoot or cpbRoot required");
}

export function formatProjectIndexLine(idx) {
  if (!idx) return null;
  const parts = [
    `Project index: ${idx.state}`,
    `branch:${idx.branch || "-"}`,
    `gitHead:${idx.gitHeadShort || idx.gitHead || "-"}`,
    `indexedFrom:${idx.indexedFrom || "-"}`,
    `timestamp:${idx.timestamp || "-"}`,
  ];
  if (idx.error) parts.push(`error:${idx.error}`);
  if (idx.raw) parts.push(`raw:${idx.raw}`);
  return parts.join(" ");
}
