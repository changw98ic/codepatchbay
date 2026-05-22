import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TEST_VISIBILITY = new Set(["test", "fixture", "generated"]);
const POLLUTION_NAME_PATTERNS = [
  { pattern: /fake-repo/i, reason: "fake-repo name" },
  { pattern: /-test$/i, reason: "test-suffix name" },
  { pattern: /^exec-/i, reason: "exec-prefix name" },
];

function isUnderTestPath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const tmpDir = os.tmpdir();
  const resolved = path.resolve(filePath);
  return resolved.startsWith(tmpDir + path.sep) || resolved === tmpDir;
}

export function classifyProject(project, { hubRoot, skipPathChecks = false } = {}) {
  const reasons = [];
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

export function filterVisibleProjects(projects, opts = {}) {
  const { includeTest = false } = opts;
  if (includeTest) return projects;

  return projects.filter((project) => {
    const { visibility } = classifyProject(project, { hubRoot: opts.hubRoot });
    return visibility === "production";
  });
}

export async function scanHubPollution(hubRoot) {
  const candidates = [];
  const orphanRuntimeDirs = [];

  // Read registry
  let registry;
  try {
    const { loadRegistry } = await import("./hub-registry.js");
    registry = await loadRegistry(hubRoot);
  } catch {
    registry = { projects: {} };
  }

  const projects = typeof registry.projects === "object" && registry.projects !== null
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
