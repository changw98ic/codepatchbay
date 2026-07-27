import { readdir, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordValue, type LooseRecord } from "../../shared/types.js";
import { loadRegistry, mutateRegistry } from "./hub/hub-registry.js";

const VALID_STATES = new Set(["indexed", "stale", "failed", "indexing", "unmerged"]);

export function normalizeProjectIndex(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as LooseRecord; // retain: dynamic JSON record shape (object guard → indexable)

  const rawState = typeof obj.state === "string" ? obj.state : "";
  const state = VALID_STATES.has(rawState) ? rawState : null;

  if (!state) return null;

  const timestamp = obj.timestamp || null;
  // Narrow dynamic JSON input: non-string gitHead treated as absent (null).
  const gitHeadRaw = obj.gitHead;
  const gitHead = typeof gitHeadRaw === "string" ? gitHeadRaw : null;
  const shortHead = gitHead
    ? gitHead.length > 12
      ? gitHead.slice(0, 12)
      : gitHead
    : null;

  return {
    state,
    branch: obj.branch || null,
    gitHead: gitHead || null,
    gitHeadShort: shortHead,
    indexedFrom: obj.indexedFrom || null,
    timestamp: timestamp ? new Date(String(timestamp)).toISOString() : null,
    error: obj.error || null,
  };
}

export async function readProjectIndex(hubRoot: string | null, cpbRoot: string | null, projectId: string) {
  if (!hubRoot) throw new Error("hubRoot is required for project index reads");
  try {
    const registry = await loadRegistry(hubRoot);
    const project = registry.projects[projectId];
    if (project?.metadata?.projectIndex) {
      return normalizeProjectIndex(project.metadata.projectIndex);
    }
  } catch {}
  return null;
}

export async function writeProjectIndex(hubRoot: string | null, cpbRoot: string | null, projectId: string, data: LooseRecord) {
  if (!hubRoot) throw new Error("hubRoot is required for project index writes");
  const normalized = normalizeProjectIndex(data);
  if (!normalized) {
    throw new Error("Invalid project index data: cannot normalize");
  }

  const persistable = {
    state: data.state || normalized.state,
    branch: data.branch || null,
    gitHead: data.gitHead || null,
    indexedFrom: data.indexedFrom || null,
    timestamp: normalized.timestamp || new Date().toISOString(),
    ...(data.error ? { error: data.error } : {}),
  };

  const returned = { ...normalized, timestamp: persistable.timestamp };

  const persisted = await mutateRegistry(hubRoot, (registry) => {
    const project = registry.projects[projectId];
    if (!project) return false;
    project.metadata = project.metadata || {};
    project.metadata.projectIndex = persistable;
    return true;
  });
  if (!persisted) throw new Error(`registered project not found: ${projectId}`);
  return returned;
}

export function formatProjectIndexLine(idx: LooseRecord | null) {
  if (!idx) return null;
  const parts = [
    `Project index: ${idx.state}`,
    `branch:${idx.branch || "-"}`,
    `gitHead:${idx.gitHeadShort || idx.gitHead || "-"}`,
    `indexedFrom:${idx.indexedFrom || "-"}`,
    `timestamp:${idx.timestamp || "-"}`,
  ];
  if (idx.error) parts.push(`error:${idx.error}`);
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

export function isUnderTestPath(filePath: unknown) {
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

export function classifyProject(project: LooseRecord, { hubRoot, skipPathChecks = false }: LooseRecord = {}) {
  const reasons: string[] = [];
  const metadata = recordValue(project.metadata);

  // Explicit visibility tags
  if (typeof metadata.visibility === "string" && TEST_VISIBILITY.has(metadata.visibility)) {
    reasons.push(`metadata.visibility=${metadata.visibility}`);
  }
  if (metadata.test === true) reasons.push("metadata.test=true");
  if (metadata.fixture === true) reasons.push("metadata.fixture=true");
  if (metadata.generated === true) reasons.push("metadata.generated=true");
  if (typeof metadata.generatedBy === "string" && metadata.generatedBy.length > 0) {
    reasons.push(`metadata.generatedBy=${metadata.generatedBy}`);
  }

  // Known pollution name patterns (check id AND name independently)
  const candidates = [project.id, project.name].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const { pattern, reason } of POLLUTION_NAME_PATTERNS) {
    if (candidates.some((c) => pattern.test(c))) {
      reasons.push(reason);
      break;
    }
  }

  // Temp-path warning (only when path checks enabled)
  if (!skipPathChecks) {
    if (isUnderTestPath(typeof project.sourcePath === "string" ? project.sourcePath : "")) {
      reasons.push("sourcePath under tmpdir");
    }
    // projectRuntimeRoot under hubRoot is expected (Hub-managed), not pollution
    const hubResolved = hubRoot ? path.resolve(hubRoot) : null;
  const rtResolved = typeof project.projectRuntimeRoot === "string" ? path.resolve(project.projectRuntimeRoot) : null;
    const isHubManaged = hubResolved && rtResolved &&
      (rtResolved.startsWith(hubResolved + path.sep) || rtResolved === hubResolved);
    if (!isHubManaged && isUnderTestPath(typeof project.projectRuntimeRoot === "string" ? project.projectRuntimeRoot : "")) {
      reasons.push("projectRuntimeRoot under tmpdir");
    }
  }

  return {
    visibility: reasons.length > 0 ? "test" : "production",
    reasons,
  };
}

export function filterVisibleProjects(projects: LooseRecord[], opts: LooseRecord = {}) {
  const { includeTest = false } = opts;
  if (includeTest) return projects;
  const skipPathChecks = opts.skipPathChecks || isUnderTestPath(opts.hubRoot);

  return projects.filter((project) => {
    const { visibility } = classifyProject(project, { hubRoot: opts.hubRoot, skipPathChecks });
    return visibility === "production";
  });
}

export async function scanHubPollution(hubRoot: string) {
  const candidates: LooseRecord[] = [];
  const orphanRuntimeDirs: LooseRecord[] = [];

  // Read registry
  let registry;
  try {
    registry = await loadRegistry(hubRoot);
  } catch {
    registry = { projects: {} };
  }

  const projects: LooseRecord[] = typeof registry.projects === "object" && registry.projects !== null
    ? Object.values(registry.projects)
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
