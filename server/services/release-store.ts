// @ts-nocheck
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertExecutorRoot, readExecutorPackage, REQUIRED_EXECUTOR_FILES } from "./executor-root.js";

export const RELEASE_METADATA_FORMAT_VERSION = 1;

const REQUIRED_METADATA_FIELDS = [
  "metadataVersion", "releaseId", "sourcePath", "installedPath",
  "createdAt", "codeVersion", "packageName", "stateFormatVersions",
];

const STATE_FORMAT_KEYS = [
  "queue", "jobsEvents", "leases", "processRegistry", "releaseMetadata",
];

const ALLOWED_ASSETS = [
  "bridges",
  "cli",
  "core",
  "shared",
  "runtime",
  "server",
  "profiles",
  "skills",
  "templates",
  "scripts",
  "web",
  "package.json",
  "package-lock.json",
  "cpb",
];

const EXCLUDED_COPY_NAMES = new Set([
  "node_modules",
  ".git",
  "cpb-task",
  ".omx",
  ".omc",
  "omx_wiki",
  "providers",
]);

const EXCLUDED_WIKI_PROJECTS = new Set([
  "flow",
]);

export function resolveReleaseStoreRoot({ destRoot, env = process.env } = {}) {
  if (destRoot) return path.resolve(destRoot);
  const cpbHome = env.CPB_HOME || path.join(
    process.env.HOME || "/tmp",
    ".cpb",
  );
  return path.join(cpbHome, "releases");
}

export function validateReleaseId(releaseId) {
  if (typeof releaseId !== "string" || releaseId.length === 0) {
    throw new Error("release id must be a non-empty string");
  }
  if (releaseId.includes("/")) {
    throw new Error(`release id must not contain slashes: ${releaseId}`);
  }
  if (releaseId === "." || releaseId === "..") {
    throw new Error(`invalid release id: ${releaseId}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(releaseId)) {
    throw new Error(`invalid release id: ${releaseId}`);
  }
}

export function releasePath(releaseStoreRoot, releaseId) {
  return path.join(path.resolve(releaseStoreRoot), releaseId);
}

export function manifestPathForRelease(installedPath) {
  return path.join(path.resolve(installedPath), "release", "manifest.json");
}

export async function readReleaseMetadata(installedPathOrManifestPath) {
  const resolved = path.resolve(installedPathOrManifestPath);
  let manifestFile;
  try {
    const info = await stat(resolved);
    manifestFile = info.isDirectory()
      ? path.join(resolved, "release", "manifest.json")
      : resolved;
  } catch {
    manifestFile = resolved;
  }
  const raw = await readFile(manifestFile, "utf8");
  return JSON.parse(raw);
}

function formatTimestampId(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function generateDefaultReleaseId(codeVersion, now) {
  const stamp = formatTimestampId(now instanceof Date ? now : new Date());
  return `${codeVersion || "dev"}-${stamp}`;
}

function copyFilter(source) {
  const base = path.basename(source);
  if (EXCLUDED_COPY_NAMES.has(base)) return false;
  if (base === "target" && source.includes(`${path.sep}runtime${path.sep}`)) return false;
  return true;
}

function wikiProjectFilter(projectName) {
  return !EXCLUDED_WIKI_PROJECTS.has(projectName);
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function installRelease({ sourceRoot, destRoot, name, now = new Date(), env } = {}) {
  const resolvedSource = await assertExecutorRoot(sourceRoot);
  const pkg = await readExecutorPackage(resolvedSource);

  const releaseId = name
    ? name
    : generateDefaultReleaseId(pkg.version, now);
  validateReleaseId(releaseId);

  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  const installedPath = path.join(storeRoot, releaseId);

  if (!installedPath.startsWith(storeRoot + path.sep) && installedPath !== storeRoot) {
    throw new Error(`release id resolves outside the release store root: ${releaseId}`);
  }

  if (await exists(installedPath)) {
    throw new Error(`release already exists: ${installedPath}`);
  }

  const tmpPath = `${installedPath}.tmp-${Date.now()}`;
  try {
    await mkdir(tmpPath, { recursive: true });

    for (const item of ALLOWED_ASSETS) {
      const sourcePath = path.join(resolvedSource, item);
      if (!(await exists(sourcePath)) && item === "package-lock.json") {
        continue;
      }
      await cp(
        sourcePath,
        path.join(tmpPath, item),
        { recursive: true, verbatimSymlinks: true, filter: copyFilter },
      );
    }

    await mkdir(path.join(tmpPath, "wiki"), { recursive: true });
    const wikiSystemDir = path.join(resolvedSource, "wiki", "system");
    if (await exists(wikiSystemDir)) {
      await cp(
        wikiSystemDir,
        path.join(tmpPath, "wiki", "system"),
        { recursive: true, verbatimSymlinks: true, filter: copyFilter },
      );
    }
    await mkdir(path.join(tmpPath, "wiki", "projects"), { recursive: true });

    const templateDir = path.join(resolvedSource, "wiki", "projects", "_template");
    if (await exists(templateDir)) {
      await cp(
        templateDir,
        path.join(tmpPath, "wiki", "projects", "_template"),
        { recursive: true, verbatimSymlinks: true, filter: copyFilter },
      );
    }

    try { await chmod(path.join(tmpPath, "cpb"), 0o755); } catch {}

    const { QUEUE_VERSION } = await import("./hub-queue.js");
    const { JOBS_EVENTS_FORMAT_VERSION } = await import("./event-store.js");
    const { LEASE_FORMAT_VERSION } = await import("./lease-manager.js");
    const { PROCESS_REGISTRY_FORMAT_VERSION } = await import("./process-registry.js");

    const manifest = {
      metadataVersion: RELEASE_METADATA_FORMAT_VERSION,
      releaseId,
      sourcePath: resolvedSource,
      installedPath,
      createdAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
      codeVersion: pkg.version,
      packageName: pkg.name,
      stateFormatVersions: {
        queue: QUEUE_VERSION,
        jobsEvents: JOBS_EVENTS_FORMAT_VERSION,
        leases: LEASE_FORMAT_VERSION,
        processRegistry: PROCESS_REGISTRY_FORMAT_VERSION,
        releaseMetadata: RELEASE_METADATA_FORMAT_VERSION,
      },
    };

    await mkdir(path.join(tmpPath, "release"), { recursive: true });
    await writeFile(
      path.join(tmpPath, "release", "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    await rename(tmpPath, installedPath);
    return manifest;
  } catch (err) {
    await rm(tmpPath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export function resolveCpbHome({ env = process.env } = {}) {
  return env.CPB_HOME || path.join(env.HOME || "/tmp", ".cpb");
}

export function currentReleaseLinkPath({ env = process.env } = {}) {
  return path.join(resolveCpbHome({ env }), "current");
}

export function currentReleaseStatePath({ env = process.env } = {}) {
  return path.join(resolveCpbHome({ env }), "release", "current.json");
}

export async function supportedStateFormatVersions() {
  const { QUEUE_VERSION } = await import("./hub-queue.js");
  const { JOBS_EVENTS_FORMAT_VERSION } = await import("./event-store.js");
  const { LEASE_FORMAT_VERSION } = await import("./lease-manager.js");
  const { PROCESS_REGISTRY_FORMAT_VERSION } = await import("./process-registry.js");
  return {
    queue: [QUEUE_VERSION],
    jobsEvents: [JOBS_EVENTS_FORMAT_VERSION],
    leases: [LEASE_FORMAT_VERSION],
    processRegistry: [PROCESS_REGISTRY_FORMAT_VERSION],
    releaseMetadata: [RELEASE_METADATA_FORMAT_VERSION],
  };
}

export async function listReleases({ destRoot, env = process.env } = {}) {
  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  let currentSelection = null;
  try {
    currentSelection = await readCurrentReleaseSelection({ env });
  } catch {}

  const releases = [];
  let entries;
  try {
    entries = await readdir(storeRoot, { withFileTypes: true });
  } catch {
    return { releaseStoreRoot: storeRoot, current: currentSelection?.selector?.releaseId || null, releases };
  }

  const dirEntries = entries.filter(e => e.isDirectory()).map(e => e.name);
  for (const name of dirEntries) {
    try {
      const manifest = await readReleaseMetadata(path.join(storeRoot, name));
      releases.push({
        releaseId: manifest.releaseId || name,
        installedPath: path.join(storeRoot, name),
        createdAt: manifest.createdAt,
        codeVersion: manifest.codeVersion,
        packageName: manifest.packageName,
        metadataVersion: manifest.metadataVersion,
        stateFormatVersions: manifest.stateFormatVersions,
        current: currentSelection?.selector?.releaseId === (manifest.releaseId || name),
        status: "valid",
      });
    } catch (err) {
      releases.push({
        releaseId: name,
        installedPath: path.join(storeRoot, name),
        status: "invalid",
        error: err.message,
      });
    }
  }

  releases.sort((a, b) => {
    const ta = a.createdAt || "";
    const tb = b.createdAt || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.releaseId || "").localeCompare(b.releaseId || "");
  });

  return {
    releaseStoreRoot: storeRoot,
    current: currentSelection?.selector?.releaseId || null,
    releases,
  };
}

export async function readCurrentReleaseSelection({ env = process.env } = {}) {
  const statePath = currentReleaseStatePath({ env });
  let selector = null;
  try {
    const raw = await readFile(statePath, "utf8");
    selector = JSON.parse(raw);
  } catch {}

  const linkPath = currentReleaseLinkPath({ env });
  let linkTarget = null;
  try {
    const { realpath } = await import("node:fs/promises");
    linkTarget = await realpath(linkPath);
  } catch {}

  if (!selector && !linkTarget) return null;
  return { selector, linkTarget };
}

export async function inspectCurrentRelease({ env = process.env } = {}) {
  const selection = await readCurrentReleaseSelection({ env });
  if (!selection) return null;

  const releaseDir = selection.linkTarget || selection.selector?.releasePath;
  if (!releaseDir) return null;

  try {
    const metadata = await readReleaseMetadata(releaseDir);
    return { selector: selection.selector, metadata };
  } catch {
    return { selector: selection.selector, metadata: null };
  }
}

export async function checkReleaseCompatibility({ releaseId, destRoot, env = process.env } = {}) {
  try {
    validateReleaseId(releaseId);
  } catch (err) {
    return {
      ok: false,
      releaseId: String(releaseId),
      releasePath: null,
      metadata: null,
      failures: [{ code: "release_path_invalid", message: err.message, releaseId: String(releaseId) }],
    };
  }

  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  const rPath = releasePath(storeRoot, releaseId);
  const failures = [];

  const resolvedStoreRoot = path.resolve(storeRoot);
  const resolvedRPath = path.resolve(rPath);
  if (!resolvedRPath.startsWith(resolvedStoreRoot + path.sep) && resolvedRPath !== resolvedStoreRoot) {
    return {
      ok: false,
      releaseId,
      releasePath: rPath,
      metadata: null,
      failures: [{ code: "release_path_invalid", message: "Release path resolves outside release store root", path: rPath }],
    };
  }

  if (!await exists(rPath)) {
    failures.push({ code: "missing_release", message: `Release not found: ${releaseId}`, path: rPath, remediation: "Install the release first with cpb release install" });
    return { ok: false, releaseId, releasePath: rPath, metadata: null, failures };
  }

  let info;
  try {
    info = await lstat(rPath);
    if (info.isSymbolicLink()) {
      return {
        ok: false,
        releaseId,
        releasePath: rPath,
        metadata: null,
        failures: [{ code: "release_path_invalid", message: "Release directory must not be a symlink", path: rPath }],
      };
    }
  } catch {
    return {
      ok: false,
      releaseId,
      releasePath: rPath,
      metadata: null,
      failures: [{ code: "release_path_invalid", message: `Cannot stat release path: ${rPath}`, path: rPath }],
    };
  }

  const manifestFile = manifestPathForRelease(rPath);
  let manifest;
  let raw;
  try {
    raw = await readFile(manifestFile, "utf8");
  } catch (err) {
    failures.push({ code: "manifest_missing", message: `Cannot read manifest: ${err.message}`, path: manifestFile, remediation: "Ensure release/manifest.json exists and is readable" });
    return { ok: false, releaseId, releasePath: rPath, metadata: null, failures };
  }

  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    failures.push({ code: "manifest_malformed", message: `Manifest JSON is malformed: ${err.message}`, path: manifestFile, remediation: "Ensure release/manifest.json contains valid JSON" });
    return { ok: false, releaseId, releasePath: rPath, metadata: null, failures };
  }

  if (typeof manifest !== "object" || manifest === null) {
    failures.push({ code: "manifest_malformed", message: "Manifest is not a JSON object", path: manifestFile });
  }

  const missing = REQUIRED_METADATA_FIELDS.filter(f => manifest[f] === undefined || manifest[f] === null);
  if (missing.length > 0) {
    failures.push({ code: "metadata_incomplete", message: `Missing required metadata fields: ${missing.join(", ")}`, path: manifestFile, fields: missing });
  }

  if (manifest.releaseId && manifest.releaseId !== releaseId) {
    failures.push({ code: "release_id_mismatch", message: `Manifest releaseId '${manifest.releaseId}' does not match requested '${releaseId}'`, path: manifestFile, field: "releaseId" });
  }

  const { access: accessFn, constants: { R_OK, X_OK } } = await import("node:fs/promises");
  const requiredFiles = ["cpb", ...REQUIRED_EXECUTOR_FILES];
  for (const relPath of requiredFiles) {
    const fullPath = path.join(rPath, relPath);
    const mustExec = relPath === "cpb";
    try {
      await accessFn(fullPath, mustExec ? R_OK | X_OK : R_OK);
    } catch {
      failures.push({
        code: "missing_required_file",
        message: mustExec
          ? `Required executable not accessible: ${relPath}`
          : `Required file not readable: ${relPath}`,
        path: fullPath,
        remediation: mustExec
          ? `Ensure ${relPath} is present and executable (chmod +x) in the release`
          : `Restore ${relPath} in the release or reinstall`,
      });
    }
  }

  if (manifest.stateFormatVersions) {
    const supported = await supportedStateFormatVersions();
    for (const key of STATE_FORMAT_KEYS) {
      const version = manifest.stateFormatVersions[key];
      if (version !== undefined && !supported[key]?.includes(version)) {
        failures.push({
          code: "unsupported_state_format",
          message: `Unsupported state format version for '${key}': ${version} (supported: ${supported[key]?.join(", ")})`,
          path: manifestFile,
          field: `stateFormatVersions.${key}`,
          format: version,
        });
      }
    }
  }

  return {
    ok: failures.length === 0,
    releaseId,
    releasePath: rPath,
    metadata: manifest,
    failures,
  };
}

export class ReleaseCompatibilityError extends Error {
  constructor(failures, releaseId) {
    super(`Release '${releaseId}' is not compatible: ${failures.map(f => f.code).join(", ")}`);
    this.name = "ReleaseCompatibilityError";
    this.failures = failures;
    this.releaseId = releaseId;
  }
}

export async function selectRelease({ releaseId, destRoot, env = process.env, now } = {}) {
  const compat = await checkReleaseCompatibility({ releaseId, destRoot, env });
  if (!compat.ok) {
    throw new ReleaseCompatibilityError(compat.failures, releaseId);
  }

  const selectedAt = (now || new Date()).toISOString();
  const cpbHome = resolveCpbHome({ env });
  const selector = {
    stateVersion: 1,
    releaseId,
    releasePath: compat.releasePath,
    selectedAt,
    compatibility: { ok: true, checkedAt: selectedAt, failures: [] },
  };

  const stateDir = path.dirname(currentReleaseStatePath({ env }));
  await mkdir(stateDir, { recursive: true });

  const tmpState = path.join(stateDir, `.current.json.tmp-${Date.now()}`);
  await writeFile(tmpState, `${JSON.stringify(selector, null, 2)}\n`, "utf8");
  await rename(tmpState, currentReleaseStatePath({ env }));

  const linkPath = currentReleaseLinkPath({ env });
  const tmpLink = path.join(path.dirname(linkPath), `.current.tmp-${Date.now()}`);
  try { await symlink(compat.releasePath, tmpLink); } catch (err) {
    await rm(tmpLink, { force: true }).catch(() => {});
    throw err;
  }
  await rename(tmpLink, linkPath);

  return {
    selector,
    metadata: compat.metadata,
    compatibility: compat,
  };
}
