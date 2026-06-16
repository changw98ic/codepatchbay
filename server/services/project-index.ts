import { readFile, mkdir, writeFile, rename, readdir, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnyRecord } from "../../shared/types.js";
import { loadRegistry, saveRegistry } from "./hub/hub-registry.js";

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

// ── project-pollution (inlined) ──

const TEST_VISIBILITY = new Set(["test", "fixture", "generated"]);
const POLLUTION_NAME_PATTERNS = [
  { pattern: /fake-repo/i, reason: "fake-repo name" },
  { pattern: /-test$/i, reason: "test-suffix name" },
  { pattern: /^exec-/i, reason: "exec-prefix name" },
  { pattern: /^pbi-test/i, reason: "pbi-test prefix" },
  { pattern: /^temp-prod/i, reason: "temp-prod prefix" },
  { pattern: /^jobs-test/i, reason: "jobs-test prefix" },
  { pattern: /^calc-test/i, reason: "calc-test prefix" },
];

export function isUnderTestPath(filePath: any) {
  if (!filePath || typeof filePath !== "string") return false;
  const tmpDir = realpathSync(os.tmpdir());
  try {
    const resolved = realpathSync(path.resolve(filePath));
    return resolved.startsWith(tmpDir + path.sep) || resolved === tmpDir;
  } catch {
    // Path doesn't exist — check unresolved path
    const resolved = path.resolve(filePath);
    return resolved.startsWith(tmpDir + path.sep) || resolved === tmpDir;
  }
}

export function classifyProject(project: AnyRecord, { hubRoot, skipPathChecks = false }: AnyRecord = {}) {
  const reasons: string[] = [];
  const metadata = project.metadata || {};

  // Explicit visibility tags
  if (TEST_VISIBILITY.has(metadata.visibility)) {
    reasons.push(`metadata.visibility=${metadata.visibility}`);
  }
  if (metadata.test === true) reasons.push("metadata.test=true");
  if (metadata.fixture === true) reasons.push("metadata.fixture=true");
  if (metadata.generated === true) reasons.push("metadata.generated=true");
  if (typeof metadata.generatedBy === "string" && metadata.generatedBy.length > 0) {
    reasons.push(`metadata.generatedBy=${metadata.generatedBy}`);
  }

  // Known pollution name patterns (check id AND name independently)
  const candidates = [project.id, project.name].filter(Boolean);
  for (const { pattern, reason } of POLLUTION_NAME_PATTERNS) {
    if (candidates.some((c) => pattern.test(c))) {
      reasons.push(reason);
      break;
    }
  }

  // Temp-path warning (only when path checks enabled)
  if (!skipPathChecks) {
    if (isUnderTestPath(project.sourcePath)) {
      reasons.push("sourcePath under tmpdir");
    }
    // projectRuntimeRoot under hubRoot is expected (Hub-managed), not pollution
    const hubResolved = hubRoot ? path.resolve(hubRoot) : null;
    const rtResolved = project.projectRuntimeRoot ? path.resolve(project.projectRuntimeRoot) : null;
    const isHubManaged = hubResolved && rtResolved &&
      (rtResolved.startsWith(hubResolved + path.sep) || rtResolved === hubResolved);
    if (!isHubManaged && isUnderTestPath(project.projectRuntimeRoot)) {
      reasons.push("projectRuntimeRoot under tmpdir");
    }
  }

  return {
    visibility: reasons.length > 0 ? "test" : "production",
    reasons,
  };
}

export function filterVisibleProjects(projects: AnyRecord[], opts: AnyRecord = {}) {
  const { includeTest = false } = opts;
  if (includeTest) return projects;
  const skipPathChecks = opts.skipPathChecks || isUnderTestPath(opts.hubRoot);

  return projects.filter((project) => {
    const { visibility } = classifyProject(project, { hubRoot: opts.hubRoot, skipPathChecks });
    return visibility === "production";
  });
}

export async function scanHubPollution(hubRoot: string) {
  const candidates: AnyRecord[] = [];
  const orphanRuntimeDirs: AnyRecord[] = [];

  // Read registry
  let registry;
  try {
    registry = await loadRegistry(hubRoot);
  } catch {
    registry = { projects: {} };
  }

  const projects: AnyRecord[] = typeof registry.projects === "object" && registry.projects !== null
    ? Object.values(registry.projects) as AnyRecord[]
    : [];
  const registeredIds = new Set(projects.map((p) => p.id));

  // Classify registered projects
  for (const project of projects) {
    const classification = classifyProject(project, { hubRoot });
    if (classification.visibility === "test") {
      candidates.push({
        kind: "project",
        projectId: project.id,
        reasons: classification.reasons,
        sourcePath: project.sourcePath,
        projectRuntimeRoot: project.projectRuntimeRoot,
      });
    }
  }

  // Detect orphan runtime directories
  const projectsDir = path.join(path.resolve(hubRoot), "projects");
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!registeredIds.has(entry.name)) {
      orphanRuntimeDirs.push({
        kind: "orphan-runtime-dir",
        runtimeDir: path.join(projectsDir, entry.name),
        projectId: entry.name,
        reasons: ["unregistered runtime directory"],
      });
    }
  }

  return { candidates, orphanRuntimeDirs };
}

// ── Re-exports from project-capability-map ──
export { projectCapabilityMapGate, generateProjectCapabilityMaps } from "./project-capability-map.js";
