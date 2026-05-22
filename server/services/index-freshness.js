import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export const INDEX_MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_INDEX_TTL_MS = 24 * 60 * 60 * 1000;

const CPB_RUNTIME_PREFIXES = ["cpb-task/", ".cpb/"];

function indexDir(rtRoot) {
  return path.join(rtRoot, "index");
}
function manifestFile(rtRoot) {
  return path.join(indexDir(rtRoot), "manifest.json");
}
function snapshotsDir(rtRoot) {
  return path.join(indexDir(rtRoot), "snapshots");
}
function snapshotFile(rtRoot, id) {
  return path.join(snapshotsDir(rtRoot), `${id}.json`);
}

function hashString(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function extractPath(line) {
  if (line.length >= 4 && line[2] === " ") return line.slice(3);
  return line;
}

function filterCpbPaths(lines) {
  return lines.filter((l) => {
    const p = extractPath(l.trim());
    return p && !CPB_RUNTIME_PREFIXES.some((pre) => p.startsWith(pre));
  });
}

async function git(args, cwd, { timeoutMs = 10_000 } = {}) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function worktreeStatusHash(sourcePath) {
  const raw = await git(["status", "--porcelain=v1", "--untracked-files=all"], sourcePath);
  return hashString(filterCpbPaths(raw.split("\n")).join("\n"));
}

async function fileInventoryHash(sourcePath) {
  const raw = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], sourcePath);
  return hashString(filterCpbPaths(raw.split("\0")).join("\n"));
}

async function gitHead(sourcePath) {
  return (await git(["rev-parse", "HEAD"], sourcePath)).trim();
}

async function gitBranch(sourcePath) {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], sourcePath)).trim();
}

async function importantConfigHash(project) {
  const resolvedSourcePath = await realpath(project.sourcePath).catch(() => project.sourcePath);
  const stable = {
    id: project.id,
    name: project.name,
    sourcePath: resolvedSourcePath,
    projectRoot: project.projectRoot,
    projectRuntimeRoot: project.projectRuntimeRoot,
    metadata: project.metadata || {},
  };
  return hashString(JSON.stringify(stable));
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

function generateSnapshotId() {
  return `idx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function checkIndexFreshness(project, opts = {}) {
  const { ttlMs = DEFAULT_INDEX_TTL_MS, now = Date.now() } = opts;
  const rtRoot = project.projectRuntimeRoot;
  const sourcePath = project.sourcePath;

  const result = {
    worktreeDirty: false,
    indexDirty: false,
    indexStale: false,
    dirtyReasons: [],
    manifest: null,
  };

  if (!sourcePath || !rtRoot) {
    result.indexDirty = true;
    result.dirtyReasons.push("missing_source_or_runtime_root");
    return result;
  }

  let existing;
  try {
    existing = JSON.parse(await readFile(manifestFile(rtRoot), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      result.indexDirty = true;
      result.dirtyReasons.push("missing_manifest");
      return result;
    }
    throw err;
  }
  result.manifest = existing;

  if ((existing.schemaVersion ?? 0) !== INDEX_MANIFEST_SCHEMA_VERSION) {
    result.indexDirty = true;
    result.dirtyReasons.push("schema_change");
  }

  if (existing.sourcePath !== await realpath(sourcePath).catch(() => sourcePath)) {
    result.indexDirty = true;
    result.dirtyReasons.push("source_path_mismatch");
    return result;
  }

  const [curHead, curBranch, curWt, curFi] = await Promise.all([
    gitHead(sourcePath),
    gitBranch(sourcePath),
    worktreeStatusHash(sourcePath),
    fileInventoryHash(sourcePath),
  ]);
  const curCfg = await importantConfigHash(project);

  if (curHead !== existing.gitHead) {
    result.indexDirty = true;
    result.dirtyReasons.push("head_change");
  }
  if (curWt !== existing.worktreeStatusHash) {
    result.worktreeDirty = true;
    result.indexDirty = true;
    result.dirtyReasons.push("worktree_status_change");
  }
  if (curFi !== existing.fileInventoryHash) {
    result.indexDirty = true;
    result.dirtyReasons.push("file_inventory_change");
  }
  if (curCfg !== existing.importantConfigHash) {
    result.indexDirty = true;
    result.dirtyReasons.push("project_config_change");
  }

  if (!result.indexDirty) {
    const indexedAt = existing.indexedAt ? new Date(existing.indexedAt).getTime() : 0;
    if (Number.isFinite(indexedAt) && now - indexedAt > ttlMs) {
      result.indexStale = true;
    }
  }

  return result;
}

export async function refreshIndexManifest(project, opts = {}) {
  const rtRoot = project.projectRuntimeRoot;
  const sourcePath = project.sourcePath;
  const resolvedSourcePath = await realpath(sourcePath).catch(() => sourcePath);
  const { now = new Date().toISOString() } = opts;

  const [head, branch, wtHash, fiHash] = await Promise.all([
    gitHead(sourcePath),
    gitBranch(sourcePath),
    worktreeStatusHash(sourcePath),
    fileInventoryHash(sourcePath),
  ]);
  const cfgHash = await importantConfigHash(project);

  const snapshotId = generateSnapshotId();
  const manifest = {
    schemaVersion: INDEX_MANIFEST_SCHEMA_VERSION,
    projectId: project.id,
    sourcePath: resolvedSourcePath,
    branch,
    gitHead: head,
    worktreeStatusHash: wtHash,
    fileInventoryHash: fiHash,
    importantConfigHash: cfgHash,
    indexedAt: now,
    indexSnapshotId: snapshotId,
  };

  await writeAtomic(manifestFile(rtRoot), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(snapshotsDir(rtRoot), { recursive: true });
  await writeAtomic(snapshotFile(rtRoot, snapshotId), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    available: true,
    indexDirty: false,
    indexStale: false,
    worktreeDirty: false,
    dirtyReasons: [],
    indexSnapshotId: snapshotId,
    sourceFingerprint: { gitHead: head, branch, worktreeStatusHash: wtHash, fileInventoryHash: fiHash, importantConfigHash: cfgHash },
    manifest,
  };
}

export async function ensureIndexFresh(project, opts = {}) {
  if (project.sourcePath) {
    const isGit = await git(["rev-parse", "--git-dir"], project.sourcePath).then(() => true).catch(() => false);
    if (!isGit) {
      try { await realpath(project.sourcePath); } catch {
        return { available: false, indexDirty: true, indexStale: false, worktreeDirty: false, dirtyReasons: ["missing_source_or_runtime_root"], indexSnapshotId: null, sourceFingerprint: null, error: "source path not found" };
      }
      return { available: true, indexDirty: false, indexStale: false, worktreeDirty: false, dirtyReasons: [], indexSnapshotId: null, sourceFingerprint: null };
    }
  }
  try {
    const check = await checkIndexFreshness(project, opts);

    if (!check.indexDirty && !check.indexStale && check.manifest?.indexSnapshotId) {
      const m = check.manifest;
      return {
        available: true,
        indexDirty: false,
        indexStale: false,
        worktreeDirty: check.worktreeDirty,
        dirtyReasons: [],
        indexSnapshotId: m.indexSnapshotId,
        sourceFingerprint: {
          gitHead: m.gitHead,
          branch: m.branch,
          worktreeStatusHash: m.worktreeStatusHash,
          fileInventoryHash: m.fileInventoryHash,
          importantConfigHash: m.importantConfigHash,
        },
        manifest: m,
      };
    }

    return await refreshIndexManifest(project, opts);
  } catch (err) {
    return {
      available: false,
      indexDirty: true,
      indexStale: false,
      worktreeDirty: false,
      dirtyReasons: [`refresh_failed: ${err.message}`],
      indexSnapshotId: null,
      sourceFingerprint: null,
      error: err.message,
    };
  }
}

export function parseEnvSnapshot(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.indexSnapshotId === "string" &&
      parsed.indexSnapshotId
    ) {
      return {
        indexSnapshot: {
          indexSnapshotId: parsed.indexSnapshotId,
          sourceFingerprint: parsed.sourceFingerprint ?? null,
        },
        indexFreshness: parsed.indexFreshness ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function snapshotForJob(result) {
  if (!result || !result.available) {
    return {
      indexSnapshotId: null,
      sourceFingerprint: null,
      indexFreshness: {
        available: false,
        indexDirty: result?.indexDirty ?? true,
        indexStale: result?.indexStale ?? false,
        worktreeDirty: result?.worktreeDirty ?? false,
        dirtyReasons: result?.dirtyReasons ?? ["index_unavailable"],
      },
    };
  }
  return {
    indexSnapshotId: result.indexSnapshotId,
    sourceFingerprint: result.sourceFingerprint,
    indexFreshness: {
      available: true,
      indexDirty: false,
      indexStale: false,
      worktreeDirty: result.worktreeDirty ?? false,
      dirtyReasons: [],
    },
  };
}
