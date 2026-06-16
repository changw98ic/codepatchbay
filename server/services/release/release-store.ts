// ── release-store ──
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertExecutorRoot, readExecutorPackage, REQUIRED_EXECUTOR_FILES } from "../setup.js";

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

export function resolveReleaseStoreRoot({ destRoot, env = process.env }: AnyRecord = {}) {
  if (destRoot) return path.resolve(destRoot);
  const cpbHome = env.CPB_HOME || path.join(
    process.env.HOME || "/tmp",
    ".cpb",
  );
  return path.join(cpbHome, "releases");
}

export function validateReleaseId(releaseId: any) {
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

export function releasePath(releaseStoreRoot: string, releaseId: string) {
  return path.join(path.resolve(releaseStoreRoot), releaseId);
}

export function manifestPathForRelease(installedPath: string) {
  return path.join(path.resolve(installedPath), "release", "manifest.json");
}

export async function readReleaseMetadata(installedPathOrManifestPath: string): Promise<AnyRecord> {
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

function formatTimestampId(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function generateDefaultReleaseId(codeVersion: any, now: any) {
  const stamp = formatTimestampId(now instanceof Date ? now : new Date());
  return `${codeVersion || "dev"}-${stamp}`;
}

function copyFilter(source: string) {
  const base = path.basename(source);
  if (EXCLUDED_COPY_NAMES.has(base)) return false;
  if (base === "target" && source.includes(`${path.sep}runtime${path.sep}`)) return false;
  return true;
}

function wikiProjectFilter(projectName: string) {
  return !EXCLUDED_WIKI_PROJECTS.has(projectName);
}

async function exists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function installRelease({ sourceRoot, destRoot, name, now = new Date(), env }: AnyRecord = {}) {
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

    const { QUEUE_VERSION } = await import("../hub/hub-queue.js");
    const { JOBS_EVENTS_FORMAT_VERSION } = await import("../event/event-store.js");
    const { LEASE_FORMAT_VERSION } = await import("../infra.js");
    const { PROCESS_REGISTRY_FORMAT_VERSION } = await import("../infra.js");

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

export function resolveCpbHome({ env = process.env }: AnyRecord = {}) {
  return env.CPB_HOME || path.join(env.HOME || "/tmp", ".cpb");
}

export function currentReleaseLinkPath({ env = process.env }: AnyRecord = {}) {
  return path.join(resolveCpbHome({ env }), "current");
}

export function currentReleaseStatePath({ env = process.env }: AnyRecord = {}) {
  return path.join(resolveCpbHome({ env }), "release", "current.json");
}

export async function supportedStateFormatVersions() {
  const { QUEUE_VERSION } = await import("../hub/hub-queue.js");
  const { JOBS_EVENTS_FORMAT_VERSION } = await import("../event/event-store.js");
  const { LEASE_FORMAT_VERSION } = await import("../infra.js");
  const { PROCESS_REGISTRY_FORMAT_VERSION } = await import("../infra.js");
  return {
    queue: [QUEUE_VERSION],
    jobsEvents: [JOBS_EVENTS_FORMAT_VERSION],
    leases: [LEASE_FORMAT_VERSION],
    processRegistry: [PROCESS_REGISTRY_FORMAT_VERSION],
    releaseMetadata: [RELEASE_METADATA_FORMAT_VERSION],
  };
}

export async function listReleases({ destRoot, env = process.env }: AnyRecord = {}) {
  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  let currentSelection = null;
  try {
    currentSelection = await readCurrentReleaseSelection({ env });
  } catch {}

  const releases: AnyRecord[] = [];
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

export async function readCurrentReleaseSelection({ env = process.env }: AnyRecord = {}) {
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

export async function inspectCurrentRelease({ env = process.env }: AnyRecord = {}) {
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

export async function checkReleaseCompatibility({ releaseId, destRoot, env = process.env }: AnyRecord = {}) {
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
  const failures: AnyRecord[] = [];

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
  failures: AnyRecord[];
  releaseId: string;

  constructor(failures: AnyRecord[], releaseId: string) {
    super(`Release '${releaseId}' is not compatible: ${failures.map(f => f.code).join(", ")}`);
    this.name = "ReleaseCompatibilityError";
    this.failures = failures;
    this.releaseId = releaseId;
  }
}

export async function selectRelease({ releaseId, destRoot, env = process.env, now }: AnyRecord = {}) {
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

// ── release-gc ──
import { lstat as lstatFn, readdir as readdirFn, readFile as readFileFn, rm as rmFn, stat as statFn } from "node:fs/promises";
import { AnyRecord } from "../../../shared/types.js";
import { listJobs } from "../job/job-store.js";

async function gcExists(p: string) {
  try { await statFn(p); return true; } catch { return false; }
}

function collectReleasePins(jobs: Record<string, any>[]) {
  const pins = new Map<string, any[]>();
  for (const job of jobs) {
    const ids = new Set<string>();
    if (job.executor?.releaseId) ids.add(job.executor.releaseId);
    if (job.lineage?.executorSelection?.selectedReleaseId) ids.add(job.lineage.executorSelection.selectedReleaseId);
    if (job.lineage?.executorSelection?.parentReleaseId) ids.add(job.lineage.executorSelection.parentReleaseId);
    for (const id of ids) {
      if (!pins.has(id)) pins.set(id, []);
      pins.get(id).push({ jobId: job.jobId, status: job.status, project: job.project });
    }
  }
  return pins;
}

async function collectProcessAndLeaseEvidence(cpbRoot: string, jobs: Record<string, any>[]) {
  const processReleaseIds = new Set<string>();
  const leaseReleaseIds = new Set<string>();

  const jobMap = new Map();
  for (const job of jobs) {
    if (job.jobId) jobMap.set(job.jobId, job);
  }

  try {
    const { listProcesses } = await import("../infra.js");
    const processes = await listProcesses(cpbRoot);
    for (const proc of processes) {
      if (proc.status === "running") {
        const job = jobMap.get(proc.jobId);
        if (job?.executor?.releaseId) processReleaseIds.add(job.executor.releaseId);
      }
    }
  } catch {}
  try {
    const { runtimeDataPath } = await import("../../../core/paths.js");
    const leasesDir = runtimeDataPath(cpbRoot, "leases");
    const files = await readdirFn(leasesDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const lease = JSON.parse(await readFileFn(path.join(leasesDir, f), "utf8"));
        if (lease.jobId) {
          const job = jobMap.get(lease.jobId);
          if (job?.executor?.releaseId) leaseReleaseIds.add(job.executor.releaseId);
        }
      } catch {}
    }
  } catch {}
  return { processReleaseIds, leaseReleaseIds };
}

export async function buildReleaseGcPlan({ cpbRoot, env = process.env, destRoot }: Record<string, any> = {}) {
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  const releaseList = await listReleases({ destRoot, env });
  const currentReleaseId = releaseList.current;

  let jobs;
  try {
    jobs = await listJobs(resolvedCpbRoot);
  } catch (err) {
    throw new Error(`Cannot build release GC plan: failed to read job inventory: ${(err as Error).message}`);
  }

  const jobPins = collectReleasePins(jobs);
  const { processReleaseIds, leaseReleaseIds } = await collectProcessAndLeaseEvidence(resolvedCpbRoot, jobs);

  const candidates = [];

  for (const release of releaseList.releases) {
    const releaseId = release.releaseId;
    const installedPath = release.installedPath;
    const reasons = [];
    let classification = "eligible";

    if (releaseId === currentReleaseId) {
      reasons.push("current");
      classification = "protected";
    }

    if (release.status === "invalid") {
      reasons.push("missing_metadata");
      classification = "unsafe";
    }

    const resolvedInstalled = path.resolve(installedPath);
    if (!resolvedInstalled.startsWith(storeRoot + path.sep) && resolvedInstalled !== storeRoot) {
      reasons.push("outside_release_root");
      classification = "unsafe";
    }

    try {
      const info = await lstatFn(installedPath);
      if (info.isSymbolicLink()) {
        reasons.push("symlinked");
        classification = "unsafe";
      }
    } catch {
      reasons.push("missing");
      classification = "unsafe";
    }

    const jobPin = jobPins.get(releaseId);
    if (jobPin) {
      const activeJobs = jobPin.filter((j: Record<string, any>) => !["completed", "failed", "blocked", "cancelled"].includes(j.status));
      if (activeJobs.length > 0) {
        reasons.push(`active_job:${activeJobs.length}`);
        classification = "protected";
      } else {
        reasons.push(`recent_job:${jobPin.length}`);
        classification = "protected";
      }
    }

    if (processReleaseIds.has(releaseId)) {
      reasons.push("process_alive");
      classification = "protected";
    }
    if (leaseReleaseIds.has(releaseId)) {
      reasons.push("lease_active");
      classification = "protected";
    }

    candidates.push({
      releaseId,
      installedPath,
      classification,
      reasons,
    });
  }

  const installedIds = new Set(releaseList.releases.map(r => r.releaseId));
  for (const [releaseId, jobs] of jobPins) {
    if (installedIds.has(releaseId)) continue;
    candidates.push({
      releaseId,
      installedPath: null,
      classification: "unsafe",
      reasons: ["unknown_reference", `${jobs.length}_job_pin(s)`],
    });
  }
  for (const releaseId of processReleaseIds) {
    if (installedIds.has(releaseId) || jobPins.has(releaseId)) continue;
    candidates.push({
      releaseId,
      installedPath: null,
      classification: "unsafe",
      reasons: ["unknown_reference", "process_alive"],
    });
  }
  for (const releaseId of leaseReleaseIds) {
    if (installedIds.has(releaseId) || jobPins.has(releaseId) || processReleaseIds.has(releaseId)) continue;
    candidates.push({
      releaseId,
      installedPath: null,
      classification: "unsafe",
      reasons: ["unknown_reference", "lease_active"],
    });
  }

  return {
    releaseStoreRoot: storeRoot,
    currentReleaseId,
    candidates,
    generatedAt: new Date().toISOString(),
  };
}

export async function executeReleaseGc(plan: Record<string, any>, { destRoot, env = process.env, cpbRoot }: Record<string, any> = {}) {
  const eligible = plan.candidates.filter((c: Record<string, any>) => c.classification === "eligible");
  const protected_ = plan.candidates.filter((c: Record<string, any>) => c.classification === "protected");
  const unsafe = plan.candidates.filter((c: Record<string, any>) => c.classification === "unsafe");

  const deleted = [];
  const skipped = [];
  const refused = [];

  const currentSelection = await inspectCurrentRelease({ env });
  const currentReleaseId = currentSelection?.metadata?.releaseId || currentSelection?.selector?.releaseId || plan.currentReleaseId || null;

  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  let liveJobPins;
  try {
    const jobs = await listJobs(resolvedCpbRoot);
    liveJobPins = collectReleasePins(jobs);
  } catch (err) {
    return {
      deleted: [],
      skipped: protected_.map((c: Record<string, any>) => ({ ...c, skipReason: "protected" })),
      refused: [
        ...eligible.map((c: Record<string, any>) => ({ ...c, refusalReason: `job_inventory_unreadable: ${(err as Error).message}` })),
        ...unsafe.map((c: Record<string, any>) => ({ ...c, refusalReason: "unsafe" })),
      ],
      executedAt: new Date().toISOString(),
    };
  }

  for (const candidate of eligible) {
    if (currentReleaseId && candidate.releaseId === currentReleaseId) {
      refused.push({ ...candidate, refusalReason: "current_release_revalidated" });
      continue;
    }

    if (liveJobPins.has(candidate.releaseId)) {
      refused.push({ ...candidate, refusalReason: "job_pinned_revalidated" });
      continue;
    }

    let liveMetadata;
    try {
      liveMetadata = await readReleaseMetadata(candidate.installedPath);
    } catch {
      refused.push({ ...candidate, refusalReason: "metadata_invalid_revalidated" });
      continue;
    }
    if (liveMetadata.releaseId !== candidate.releaseId) {
      refused.push({ ...candidate, refusalReason: `manifest_release_id_mismatch: expected '${candidate.releaseId}' found '${liveMetadata.releaseId}'` });
      continue;
    }

    const currentReleasePath = (currentSelection as Record<string, any> | null | undefined)?.linkTarget || currentSelection?.selector?.releasePath;
    if (currentReleasePath && path.resolve(candidate.installedPath) === path.resolve(currentReleasePath)) {
      refused.push({ ...candidate, refusalReason: "path_matches_current_release_revalidated" });
      continue;
    }

    try {
      const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
      const resolvedPath = path.resolve(candidate.installedPath);
      if (!resolvedPath.startsWith(storeRoot + path.sep) && resolvedPath !== storeRoot) {
        refused.push({ ...candidate, refusalReason: "path_escape_verified" });
        continue;
      }
      const info = await lstatFn(resolvedPath);
      if (info.isSymbolicLink()) {
        refused.push({ ...candidate, refusalReason: "symlink_verified" });
        continue;
      }
      await rmFn(resolvedPath, { recursive: true, force: true });
      deleted.push(candidate);
    } catch (err) {
      refused.push({ ...candidate, refusalReason: `delete_failed: ${err.message}` });
    }
  }

  for (const candidate of protected_) {
    skipped.push({ ...candidate, skipReason: "protected" });
  }
  for (const candidate of unsafe) {
    refused.push({ ...candidate, refusalReason: "unsafe" });
  }

  return {
    deleted,
    skipped,
    refused,
    executedAt: new Date().toISOString(),
  };
}

export function formatGcPlanHuman(plan: Record<string, any>) {
  const lines = [];
  lines.push("Release GC Plan:");
  lines.push(`  Store root: ${plan.releaseStoreRoot}`);
  lines.push(`  Current release: ${plan.currentReleaseId || "(none)"}`);
  lines.push("");

  for (const c of plan.candidates) {
    const marker = c.classification === "eligible" ? "E"
      : c.classification === "protected" ? "P"
      : "U";
    const color = c.classification === "eligible" ? "\x1b[0;32m"
      : c.classification === "protected" ? "\x1b[1;33m"
      : "\x1b[0;31m";
    const NC = "\x1b[0m";
    lines.push(`  ${color}${marker}${NC} ${c.releaseId}  ${c.reasons.join(", ") || "no issues"}`);
  }

  const counts = { eligible: 0, protected: 0, unsafe: 0 };
  for (const c of plan.candidates) counts[c.classification]++;
  lines.push("");
  lines.push(`  Eligible: ${counts.eligible}  Protected: ${counts.protected}  Unsafe: ${counts.unsafe}`);
  return lines.join("\n");
}

export function formatGcResultHuman(result: Record<string, any>) {
  const lines = [];
  lines.push("Release GC Result:");
  lines.push(`  Deleted: ${result.deleted.length}`);
  for (const d of result.deleted) lines.push(`    - ${d.releaseId}`);
  lines.push(`  Skipped (protected): ${result.skipped.length}`);
  for (const s of result.skipped) lines.push(`    - ${s.releaseId}: ${s.skipReason}`);
  lines.push(`  Refused (unsafe): ${result.refused.length}`);
  for (const r of result.refused) lines.push(`    - ${r.releaseId}: ${r.refusalReason}`);
  return lines.join("\n");
}

// ── version-identity ──
export async function buildVersionIdentityReport({ cpbRoot, executorRoot, codeVersion, env = process.env }: { cpbRoot: string; executorRoot: string; codeVersion: string; env?: NodeJS.ProcessEnv }) {
  const resolvedCpbRoot = path.resolve(cpbRoot);
  const resolvedExecutorRoot = path.resolve(executorRoot);

  const { resolveHubRoot } = await import("../hub/hub-registry.js");
  const hubRoot = resolveHubRoot(resolvedCpbRoot);

  let activeAppReleaseId = null;
  try {
    const manifestPath = path.join(resolvedExecutorRoot, "release", "manifest.json");
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    if (typeof manifest.releaseId === "string" && manifest.releaseId.length > 0) {
      activeAppReleaseId = manifest.releaseId;
    }
  } catch {}

  const { QUEUE_VERSION } = await import("../hub/hub-queue.js");
  const { JOBS_EVENTS_FORMAT_VERSION } = await import("../event/event-store.js");
  const { LEASE_FORMAT_VERSION } = await import("../infra.js");
  const { PROCESS_REGISTRY_FORMAT_VERSION } = await import("../infra.js");

  return {
    codeVersion,
    runtimeBackend: "node",
    runtimeBinaryPath: null,
    CPB_ROOT: resolvedCpbRoot,
    CPB_EXECUTOR_ROOT: resolvedExecutorRoot,
    hubRoot,
    activeAppReleaseId,
    stateFormatVersions: {
      queue: QUEUE_VERSION,
      jobsEvents: JOBS_EVENTS_FORMAT_VERSION,
      leases: LEASE_FORMAT_VERSION,
      processRegistry: PROCESS_REGISTRY_FORMAT_VERSION,
      releaseMetadata: RELEASE_METADATA_FORMAT_VERSION,
    },
  };
}
