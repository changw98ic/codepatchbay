import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CodeGraphUnavailableError, checkCodeGraphReady } from "./codegraph-readiness.js";

const execFileAsync = promisify(execFile);
const CAPABILITY_SCHEMA_VERSION = 1;

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|mjs|cjs|ts|tsx|py|go|rs|rb|java|swift)$/;
const TEST_FILE_RE = /(^|\/)(?:tests?|__tests__|test|spec)(\/|$)|(?:\.test|\.spec)\.[^.]+$/;

const HIGH_RISK_AREAS = [
  { domain: "scheduler", patterns: [/scheduler/i, /orchestrator/i, /queue/i, /claim/i, /dag/i] },
  { domain: "provider_pool", patterns: [/provider/i, /quota/i, /acp/i, /pool/i, /handoff/i] },
  { domain: "worktree", patterns: [/worktree/i, /git/i, /finalizer/i, /branch/i] },
  { domain: "security", patterns: [/auth/i, /permission/i, /secret/i, /token/i, /credential/i] },
  { domain: "event_store", patterns: [/event.?store/i, /jsonl/i, /checkpoint/i, /materialize/i] },
  { domain: "subprocess", patterns: [/subprocess/i, /spawn/i, /exec/i, /shell/i, /process/i] },
  { domain: "network", patterns: [/routes?\//i, /api/i, /webhook/i, /http/i, /slack/i] },
  { domain: "concurrency", patterns: [/concurr/i, /race/i, /lock/i, /lease/i, /parallel/i, /capacity/i] },
];

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function isSourceFile(file) {
  return SOURCE_FILE_RE.test(file.path) && !TEST_FILE_RE.test(file.path);
}

function isTestFile(file) {
  return TEST_FILE_RE.test(file.path);
}

function topFiles(files, predicate, limit) {
  return files
    .filter(predicate)
    .sort((a, b) => Number(b.nodeCount || 0) - Number(a.nodeCount || 0) || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((file) => file.path);
}

async function queryCodeGraphFiles(indexFile) {
  try {
    const { stdout } = await execFileAsync("sqlite3", [
      "-json",
      indexFile,
      "SELECT path, language, node_count AS nodeCount, size FROM files ORDER BY node_count DESC, path ASC;",
    ], {
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const files = JSON.parse(stdout || "[]");
    if (!Array.isArray(files) || files.length === 0) {
      throw new CodeGraphUnavailableError("CodeGraph index has no file inventory", {
        reason: "empty_codegraph_file_inventory",
        indexFile,
      });
    }
    return files.map((file) => ({
      path: toPosixPath(file.path),
      language: file.language || "unknown",
      nodeCount: Number(file.nodeCount || 0),
      size: Number(file.size || 0),
    }));
  } catch (err) {
    if (err instanceof CodeGraphUnavailableError) throw err;
    throw new CodeGraphUnavailableError("CodeGraph file inventory is unreadable", {
      reason: "unreadable_codegraph_file_inventory",
      indexFile,
      cause: err.message,
    });
  }
}

async function packageScripts(sourcePath) {
  try {
    const pkg = JSON.parse(await readFile(path.join(sourcePath, "package.json"), "utf8"));
    const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    return Object.fromEntries(
      ["test", "test:node", "verify:p0p1", "build", "build:web"]
        .filter((name) => typeof scripts[name] === "string")
        .map((name) => [name, `npm run ${name}`]),
    );
  } catch {
    return {};
  }
}

function languageSummary(files) {
  const counts = {};
  for (const file of files) {
    counts[file.language] = (counts[file.language] || 0) + 1;
  }
  return counts;
}

function highRiskAreas(files) {
  return HIGH_RISK_AREAS.map((area) => ({
    domain: area.domain,
    files: topFiles(
      files,
      (file) => isSourceFile(file) && area.patterns.some((pattern) => pattern.test(file.path)),
      20,
    ),
  })).filter((area) => area.files.length > 0);
}

function safetyBoundaries(areas) {
  const domains = new Set(areas.map((area) => area.domain));
  const boundaries = [];
  if (domains.has("security")) boundaries.push("secrets", "github_write");
  if (domains.has("provider_pool")) boundaries.push("provider_pool");
  if (domains.has("scheduler") || domains.has("concurrency")) boundaries.push("state_locking");
  if (domains.has("worktree")) boundaries.push("filesystem", "git_write");
  if (domains.has("event_store")) boundaries.push("durable_state");
  if (domains.has("subprocess")) boundaries.push("subprocess");
  if (domains.has("network")) boundaries.push("network");
  return [...new Set(boundaries)];
}

export function projectCapabilityMapGate(project) {
  const metadata = project?.metadata || {};
  const capabilityMap = metadata.project_capability_map || project?.project_capability_map || metadata.projectCapabilityMap;
  const confidence = capabilityMap?.confidence || metadata.capabilityMapConfidence || metadata.confidence || null;
  if (!capabilityMap) {
    return { available: false, reason: "missing_project_capability_map", confidence: null };
  }
  if (confidence !== "high") {
    return { available: false, reason: "project_capability_map_not_high_confidence", confidence };
  }
  return { available: true, confidence: "high", generatedAt: capabilityMap.generatedAt || null };
}

export async function generateProjectCapabilityMaps({ cpbRoot, sourcePath } = {}) {
  const readiness = await checkCodeGraphReady({ cpbRoot, sourcePath });
  const files = await queryCodeGraphFiles(readiness.indexFile);
  const generatedAt = new Date().toISOString();
  const areas = highRiskAreas(files);
  const boundaries = safetyBoundaries(areas);
  const sourceFiles = files.filter(isSourceFile);
  const testFiles = files.filter(isTestFile);
  const coreModules = topFiles(files, isSourceFile, 30);
  const testSurfaces = topFiles(files, isTestFile, 30);

  const codegraph = {
    source: readiness.state?.source || null,
    sourcePath: readiness.sourcePath,
    indexFile: readiness.indexFile,
    pid: readiness.state?.pid || null,
    socketPath: readiness.state?.socketPath || null,
  };

  return {
    capabilityMapConfidence: "high",
    codegraphReadiness: {
      available: true,
      checkedAt: generatedAt,
      sourcePath: readiness.sourcePath,
      indexFile: readiness.indexFile,
      state: {
        source: readiness.state?.source || null,
        pid: readiness.state?.pid || null,
        socketPath: readiness.state?.socketPath || null,
      },
    },
    project_capability_map: {
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      confidence: "high",
      source: "codegraph",
      generatedAt,
      codegraph,
      summary: {
        fileCount: files.length,
        sourceFileCount: sourceFiles.length,
        testFileCount: testFiles.length,
        nodeCount: files.reduce((sum, file) => sum + Number(file.nodeCount || 0), 0),
        languages: languageSummary(files),
      },
      coreModules,
      testSurfaces,
      buildCommands: await packageScripts(readiness.sourcePath),
    },
    safety_boundary_map: {
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      confidence: "high",
      source: "codegraph",
      generatedAt,
      boundaries,
    },
    high_risk_area_map: {
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      confidence: "high",
      source: "codegraph",
      generatedAt,
      areas,
      files: [...new Set(areas.flatMap((area) => area.files))].slice(0, 50),
    },
  };
}
