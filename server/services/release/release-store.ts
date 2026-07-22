// ── release-store ──
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  readdir,
  rename,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import type { LooseRecord } from "../../../core/contracts/types.js";
import {
  readBoundedRegularFileNoFollow,
  withDurableDirectoryLock,
  type BoundedRegularFileReadHooks,
} from "../../../core/runtime/durable-directory-lock.js";
import { fsyncDirectory } from "../../../shared/hub-maintenance.js";
import { assertExecutorRoot, readExecutorPackage, REQUIRED_EXECUTOR_FILES } from "../executor-root.js";

export const RELEASE_METADATA_FORMAT_VERSION = 1;
export const RELEASE_METADATA_MAX_BYTES = 256 * 1024;

const RELEASE_SELECTION_STATE_MAX_BYTES = 256 * 1024;
const RELEASE_COMMIT_FORMAT_VERSION = 1;
const RELEASE_COMMIT_MAX_BYTES = 64 * 1024;
const RELEASE_GENERATIONS_DIRECTORY = ".release-generations";
const RELEASE_COMMIT_FILE = ".cpb-release-commit.json";

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

type ReleaseEnv = NodeJS.ProcessEnv;

type ReleaseStoreOptions = {
  destRoot?: string;
  env?: ReleaseEnv;
};

type InstallReleaseOptions = ReleaseStoreOptions & {
  sourceRoot?: string;
  name?: string;
  now?: Date | string;
  hooksForTest?: {
    beforePublication?: (context: { stagePath: string; installedPath: string }) => void | Promise<void>;
    syncDirectory?: (context: {
      directory: string;
      phase: "generation-root" | "generation-commit" | "pointer-publication";
    }) => void | Promise<void>;
  };
};

type ReadReleaseMetadataOptions = {
  hooksForTest?: BoundedRegularFileReadHooks;
  validateShape?: boolean;
};

type ReleaseSelectionSyncPhase =
  | "generation-root"
  | "generation-directory"
  | "state-stage"
  | "link-stage"
  | "state-isolation"
  | "link-isolation"
  | "link-publication"
  | "state-publication"
  | "selection-complete";

type SelectReleaseHooks = {
  beforeStateIsolation?: (context: ReleaseSelectionContext) => void | Promise<void>;
  beforeLinkIsolation?: (context: ReleaseSelectionContext) => void | Promise<void>;
  beforeLinkPublication?: (context: ReleaseSelectionContext) => void | Promise<void>;
  afterLinkPublication?: (context: ReleaseSelectionContext) => void | Promise<void>;
  beforeStatePublication?: (context: ReleaseSelectionContext) => void | Promise<void>;
  afterStatePublication?: (context: ReleaseSelectionContext) => void | Promise<void>;
  syncDirectory?: (context: { directory: string; phase: ReleaseSelectionSyncPhase }) => void | Promise<void>;
};

type SelectReleaseOptions = ReleaseStoreOptions & {
  releaseId?: string;
  now?: Date;
  hooksForTest?: SelectReleaseHooks;
};

type ReleaseSelectionContext = {
  operationId: string;
  operationDir: string;
  statePath: string;
  linkPath: string;
  stateStagePath: string;
  linkStagePath: string;
  previousStatePath: string;
  previousLinkPath: string;
  releasePath: string;
};

type ReleaseManifest = LooseRecord & {
  metadataVersion?: number;
  releaseId?: string;
  sourcePath?: string;
  installedPath?: string;
  createdAt?: string;
  codeVersion?: string;
  packageName?: string;
  stateFormatVersions?: Record<string, number>;
  generationPath?: string;
};

type ReleaseCommitMarker = {
  commitVersion: typeof RELEASE_COMMIT_FORMAT_VERSION;
  releaseId: string;
  canonicalPath: string;
  generationPath: string;
  manifestSha256: string;
  committedAt: string;
};

type CommittedRelease = {
  kind: "legacy-directory" | "generation-pointer";
  releaseId: string;
  canonicalPath: string;
  resolvedPath: string;
  metadata: ReleaseManifest;
  canonicalAuthority: SelectionAuthority;
  generationAuthority: SelectionAuthority;
  commitMarker?: ReleaseCommitMarker;
};

type ReleaseSelector = LooseRecord & {
  stateVersion?: number;
  releaseId?: string;
  releasePath?: string;
  selectedAt?: string;
};

type CurrentReleaseSelection = {
  selector: ReleaseSelector | null;
  linkTarget: string | null;
};

type ReleaseListItem = ReleaseManifest & {
  releaseId: string;
  installedPath: string;
  status: "valid" | "invalid";
  current?: boolean;
  error?: string;
  generationPath?: string;
};

type ReleaseFailure = LooseRecord & {
  code: string;
  message?: string;
  path?: string | null;
  releaseId?: string;
};

type ReleaseCompatibility = {
  ok: boolean;
  releaseId: string;
  releasePath: string | null;
  metadata: ReleaseManifest | null;
  failures: ReleaseFailure[];
  canonicalPath?: string | null;
};

type ReleaseJobRecord = LooseRecord & {
  jobId?: string;
  status?: string;
  project?: string;
  executor?: { releaseId?: string };
  lineage?: {
    executorSelection?: LooseRecord & {
      selectedReleaseId?: string;
      parentReleaseId?: string;
    };
  };
};

type ReleasePin = {
  jobId?: string;
  status?: string;
  project?: string;
};

type ReleaseGcCandidate = {
  releaseId: string;
  installedPath: string | null;
  classification: "eligible" | "protected" | "unsafe";
  reasons: string[];
  skipReason?: string;
  refusalReason?: string;
  quarantinePath?: string;
  recoveryPaths?: { canonical?: string; quarantine?: string };
  attemptedPaths?: { canonical: string; quarantine?: string };
  successorPaths?: { canonical: string };
  originalEvidence?: "verified" | "unknown";
};

type ReleaseGcPlan = {
  releaseStoreRoot: string;
  currentReleaseId: string | null;
  candidates: ReleaseGcCandidate[];
  generatedAt: string;
};

type ReleaseGcResult = {
  deleted: ReleaseGcCandidate[];
  quarantined: ReleaseGcCandidate[];
  skipped: ReleaseGcCandidate[];
  refused: ReleaseGcCandidate[];
  executedAt: string;
};

type ReleaseGcOptions = ReleaseStoreOptions & {
  cpbRoot?: string;
};

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err || "");
}

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PathGeneration = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
  gid: bigint;
  rdev: bigint;
  size: bigint;
  blksize: bigint;
  blocks: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
};

type DirectoryBinding = {
  directory: string;
  generation: PathGeneration;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function pathGeneration(info: BigIntStats): PathGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    uid: info.uid,
    gid: info.gid,
    rdev: info.rdev,
    size: info.size,
    blksize: info.blksize,
    blocks: info.blocks,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    birthtimeNs: info.birthtimeNs,
  };
}

function samePathIdentity(left: PathGeneration, right: PathGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.rdev === right.rdev
    && left.size === right.size
    && left.blksize === right.blksize
    && left.blocks === right.blocks
    && left.birthtimeNs === right.birthtimeNs;
}

function sameDirectoryIdentity(left: PathGeneration, right: PathGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.rdev === right.rdev
    && left.birthtimeNs === right.birthtimeNs;
}

function samePathGeneration(left: PathGeneration, right: PathGeneration) {
  return samePathIdentity(left, right)
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function releaseMetadataError(message: string, code: "BOUNDED_FILE_UNSAFE" | "BOUNDED_FILE_CHANGED") {
  return Object.assign(new Error(message), { code });
}

async function captureDirectoryBindings(filePath: string) {
  const directories: string[] = [];
  const requestedParent = path.dirname(path.resolve(filePath));
  let cursor = await realpath(requestedParent);
  while (true) {
    directories.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  directories.reverse();

  const bindings: DirectoryBinding[] = [];
  for (const directory of directories) {
    const info = await lstat(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw releaseMetadataError(`release metadata path contains an unsafe directory: ${directory}`, "BOUNDED_FILE_UNSAFE");
    }
    bindings.push({ directory, generation: pathGeneration(info) });
  }
  if (path.resolve(requestedParent) !== path.resolve(directories[directories.length - 1])) {
    const requestedInfo = await lstat(requestedParent, { bigint: true });
    if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) {
      throw releaseMetadataError(`release metadata path has an unsafe parent: ${requestedParent}`, "BOUNDED_FILE_UNSAFE");
    }
    const canonicalParentBinding = bindings[bindings.length - 1];
    if (!sameDirectoryIdentity(pathGeneration(requestedInfo), canonicalParentBinding.generation)) {
      throw releaseMetadataError(`release metadata parent changed while resolving: ${requestedParent}`, "BOUNDED_FILE_CHANGED");
    }
    bindings.push({ directory: requestedParent, generation: pathGeneration(requestedInfo) });
  }
  return bindings;
}

async function verifyDirectoryBindings(bindings: DirectoryBinding[]) {
  for (const binding of bindings) {
    let current: BigIntStats;
    try {
      current = await lstat(binding.directory, { bigint: true });
    } catch (cause) {
      throw Object.assign(
        releaseMetadataError(`release metadata directory disappeared: ${binding.directory}`, "BOUNDED_FILE_CHANGED"),
        { cause },
      );
    }
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || !sameDirectoryIdentity(binding.generation, pathGeneration(current))
    ) {
      throw releaseMetadataError(`release metadata directory generation changed: ${binding.directory}`, "BOUNDED_FILE_CHANGED");
    }
  }
}

export function resolveReleaseStoreRoot({ destRoot, env = process.env }: ReleaseStoreOptions = {}) {
  if (destRoot) return path.resolve(destRoot);
  const cpbHome = env.CPB_HOME || path.join(
    process.env.HOME || "/tmp",
    ".cpb",
  );
  return path.join(cpbHome, "releases");
}

export function validateReleaseId(releaseId: unknown) {
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

function releaseGenerationRoot(releaseStoreRoot: string) {
  return path.join(path.resolve(releaseStoreRoot), RELEASE_GENERATIONS_DIRECTORY);
}

function releaseCommitMarkerPath(generationPath: string) {
  return path.join(path.resolve(generationPath), RELEASE_COMMIT_FILE);
}

export async function readReleaseMetadata(
  installedPathOrManifestPath: string,
  { hooksForTest, validateShape = true }: ReadReleaseMetadataOptions = {},
): Promise<ReleaseManifest> {
  const resolved = path.resolve(installedPathOrManifestPath);
  const requestedInfo = await lstat(resolved, { bigint: true });
  if (requestedInfo.isSymbolicLink() || (!requestedInfo.isDirectory() && !requestedInfo.isFile())) {
    throw releaseMetadataError(`release metadata input must be a real directory or regular file: ${resolved}`, "BOUNDED_FILE_UNSAFE");
  }
  const canonicalInput = await realpath(resolved);
  const canonicalInfo = await lstat(canonicalInput, { bigint: true });
  const requestedGeneration = pathGeneration(requestedInfo);
  const canonicalGeneration = pathGeneration(canonicalInfo);
  if (
    requestedInfo.isDirectory() !== canonicalInfo.isDirectory()
    || requestedInfo.isFile() !== canonicalInfo.isFile()
    || !samePathGeneration(requestedGeneration, canonicalGeneration)
  ) {
    throw releaseMetadataError(`release metadata input changed while resolving: ${resolved}`, "BOUNDED_FILE_CHANGED");
  }

  const manifestFile = requestedInfo.isDirectory()
    ? path.join(canonicalInput, "release", "manifest.json")
    : canonicalInput;
  const directoryBindings = await captureDirectoryBindings(manifestFile);
  const verifyInputBinding = async () => {
    await verifyDirectoryBindings(directoryBindings);
    const currentInput = await lstat(canonicalInput, { bigint: true });
    if (
      currentInput.isSymbolicLink()
      || !samePathGeneration(canonicalGeneration, pathGeneration(currentInput))
    ) {
      throw releaseMetadataError(`release metadata input generation changed: ${resolved}`, "BOUNDED_FILE_CHANGED");
    }
  };

  await verifyInputBinding();
  const raw = await readBoundedRegularFileNoFollow(manifestFile, {
    maxBytes: RELEASE_METADATA_MAX_BYTES,
    hooks: {
      afterOpen: async (context) => {
        await hooksForTest?.afterOpen?.(context);
        await verifyInputBinding();
      },
      afterChunk: hooksForTest?.afterChunk,
      beforePathGenerationCheck: async (context) => {
        await hooksForTest?.beforePathGenerationCheck?.(context);
        await verifyInputBinding();
      },
    },
  });
  await verifyInputBinding();
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw Object.assign(new Error(`release metadata must be a JSON object: ${manifestFile}`), {
      code: "RELEASE_METADATA_INVALID",
      path: manifestFile,
    });
  }
  const manifest = parsed as ReleaseManifest;
  if (validateShape) {
    const invalidFields: string[] = [];
    if (!Number.isSafeInteger(manifest.metadataVersion) || Number(manifest.metadataVersion) <= 0) {
      invalidFields.push("metadataVersion");
    }
    for (const field of ["releaseId", "sourcePath", "installedPath", "createdAt", "codeVersion", "packageName"] as const) {
      if (typeof manifest[field] !== "string" || manifest[field]!.length === 0) invalidFields.push(field);
    }
    if (!isRecord(manifest.stateFormatVersions)) {
      invalidFields.push("stateFormatVersions");
    } else {
      for (const [key, version] of Object.entries(manifest.stateFormatVersions)) {
        if (!Number.isSafeInteger(version) || Number(version) <= 0) invalidFields.push(`stateFormatVersions.${key}`);
      }
    }
    if (typeof manifest.releaseId === "string") {
      try {
        validateReleaseId(manifest.releaseId);
      } catch {
        invalidFields.push("releaseId");
      }
    }
    if (requestedInfo.isDirectory() && typeof manifest.installedPath === "string") {
      try {
        const manifestInstalledPath = path.resolve(manifest.installedPath);
        const manifestInstalledCanonical = await realpath(manifestInstalledPath);
        const manifestInstalledInfo = await lstat(manifestInstalledCanonical, { bigint: true });
        if (
          manifestInstalledCanonical !== canonicalInput
          || !manifestInstalledInfo.isDirectory()
          || manifestInstalledInfo.isSymbolicLink()
          || !samePathGeneration(canonicalGeneration, pathGeneration(manifestInstalledInfo))
        ) {
          invalidFields.push("installedPath");
        }
      } catch {
        invalidFields.push("installedPath");
      }
    }
    if (invalidFields.length > 0) {
      throw Object.assign(new Error(`release metadata has invalid fields: ${[...new Set(invalidFields)].join(", ")}`), {
        code: "RELEASE_METADATA_INVALID",
        path: manifestFile,
        fields: [...new Set(invalidFields)],
      });
    }
  }
  await verifyInputBinding();
  return manifest;
}

type StrictDirectoryAuthority = {
  requestedPath: string;
  canonicalPath: string;
  generation: PathGeneration;
  canonicalBindings: DirectoryBinding[];
  requestedParent: DirectoryBinding;
};

async function captureStrictDirectoryAuthority(directory: string, code: string): Promise<StrictDirectoryAuthority> {
  const requestedPath = path.resolve(directory);
  let requestedInfo: BigIntStats;
  try {
    requestedInfo = await lstat(requestedPath, { bigint: true });
  } catch (cause) {
    throw Object.assign(new Error(`required directory is unavailable: ${requestedPath}`, { cause }), { code });
  }
  if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) {
    throw Object.assign(new Error(`required directory must be a real directory: ${requestedPath}`), { code });
  }
  const canonicalPath = await realpath(requestedPath);
  const canonicalInfo = await lstat(canonicalPath, { bigint: true });
  if (
    !canonicalInfo.isDirectory()
    || canonicalInfo.isSymbolicLink()
    || !sameDirectoryIdentity(pathGeneration(requestedInfo), pathGeneration(canonicalInfo))
  ) {
    throw Object.assign(new Error(`directory changed while resolving: ${requestedPath}`), { code });
  }
  const requestedParentPath = path.dirname(requestedPath);
  let requestedParentInfo: BigIntStats;
  try {
    requestedParentInfo = await lstat(requestedParentPath, { bigint: true });
  } catch (cause) {
    throw Object.assign(new Error(`directory parent is unavailable: ${requestedParentPath}`, { cause }), { code });
  }
  if (!requestedParentInfo.isDirectory() || requestedParentInfo.isSymbolicLink()) {
    throw Object.assign(new Error(`directory has an unsafe requested parent: ${requestedParentPath}`), { code });
  }
  const canonicalBindings = await captureDirectoryBindings(path.join(canonicalPath, ".cpb-directory-authority"));
  return {
    requestedPath,
    canonicalPath,
    generation: pathGeneration(requestedInfo),
    canonicalBindings,
    requestedParent: {
      directory: requestedParentPath,
      generation: pathGeneration(requestedParentInfo),
    },
  };
}

async function verifyStrictDirectoryAuthority(authority: StrictDirectoryAuthority, code: string) {
  await verifyDirectoryBindings(authority.canonicalBindings);
  let requestedInfo: BigIntStats;
  try {
    requestedInfo = await lstat(authority.requestedPath, { bigint: true });
  } catch (cause) {
    throw Object.assign(new Error(`directory authority disappeared: ${authority.requestedPath}`, { cause }), { code });
  }
  if (
    !requestedInfo.isDirectory()
    || requestedInfo.isSymbolicLink()
    || !sameDirectoryIdentity(authority.generation, pathGeneration(requestedInfo))
  ) {
    throw Object.assign(new Error(`directory authority changed: ${authority.requestedPath}`), { code });
  }
  let requestedParentInfo: BigIntStats;
  try {
    requestedParentInfo = await lstat(authority.requestedParent.directory, { bigint: true });
  } catch (cause) {
    throw Object.assign(new Error(`directory parent authority disappeared: ${authority.requestedParent.directory}`, { cause }), { code });
  }
  if (
    !requestedParentInfo.isDirectory()
    || requestedParentInfo.isSymbolicLink()
    || !sameDirectoryIdentity(authority.requestedParent.generation, pathGeneration(requestedParentInfo))
  ) {
    throw Object.assign(new Error(`directory parent authority changed: ${authority.requestedParent.directory}`), { code });
  }
}

function releaseCommitMarker(value: unknown, markerPath: string): ReleaseCommitMarker {
  if (!isRecord(value)) {
    throw Object.assign(new Error(`release commit marker must be a JSON object: ${markerPath}`), {
      code: "RELEASE_COMMIT_INVALID",
    });
  }
  const marker = value as unknown as ReleaseCommitMarker;
  if (
    marker.commitVersion !== RELEASE_COMMIT_FORMAT_VERSION
    || typeof marker.releaseId !== "string"
    || typeof marker.canonicalPath !== "string"
    || typeof marker.generationPath !== "string"
    || typeof marker.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(marker.manifestSha256)
    || typeof marker.committedAt !== "string"
    || !Number.isFinite(Date.parse(marker.committedAt))
  ) {
    throw Object.assign(new Error(`release commit marker is malformed: ${markerPath}`), {
      code: "RELEASE_COMMIT_INVALID",
    });
  }
  return marker;
}

async function readReleaseCommitMarker(generationPath: string) {
  const markerPath = releaseCommitMarkerPath(generationPath);
  const directoryBindings = await captureDirectoryBindings(markerPath);
  await verifyDirectoryBindings(directoryBindings);
  const raw = await readBoundedRegularFileNoFollow(markerPath, {
    maxBytes: RELEASE_COMMIT_MAX_BYTES,
    hooks: {
      afterOpen: async () => verifyDirectoryBindings(directoryBindings),
      beforePathGenerationCheck: async () => verifyDirectoryBindings(directoryBindings),
    },
  });
  await verifyDirectoryBindings(directoryBindings);
  return releaseCommitMarker(JSON.parse(raw), markerPath);
}

function isPathInside(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ""
    && !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`);
}

async function resolveCommittedRelease(
  releaseStoreRoot: string,
  releaseId: string,
): Promise<CommittedRelease> {
  validateReleaseId(releaseId);
  const storeAuthority = await captureStrictDirectoryAuthority(releaseStoreRoot, "RELEASE_STORE_UNSAFE");
  const canonicalPath = releasePath(storeAuthority.requestedPath, releaseId);
  const canonicalInfo = await lstat(canonicalPath, { bigint: true });

  if (canonicalInfo.isDirectory() && !canonicalInfo.isSymbolicLink()) {
    const canonicalAuthority = {
      generation: pathGeneration(canonicalInfo),
      kind: "directory",
    } satisfies SelectionAuthority;
    const metadata = await readReleaseMetadata(canonicalPath);
    if (metadata.releaseId !== releaseId) {
      throw Object.assign(new Error(`legacy release id mismatch: ${canonicalPath}`), {
        code: "RELEASE_COMMIT_INVALID",
      });
    }
    await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_STORE_CHANGED");
    const generationAuthority = await assertSelectionAuthority(canonicalPath, canonicalAuthority);
    return {
      kind: "legacy-directory",
      releaseId,
      canonicalPath,
      resolvedPath: canonicalPath,
      metadata,
      canonicalAuthority,
      generationAuthority,
    };
  }

  if (!canonicalInfo.isSymbolicLink()) {
    throw Object.assign(new Error(`release canonical entry is not committed: ${canonicalPath}`), {
      code: "RELEASE_NOT_COMMITTED",
    });
  }
  const canonicalAuthority = await captureSelectionAuthority(canonicalPath, "symlink");
  if (!canonicalAuthority?.linkTarget) {
    throw Object.assign(new Error(`release pointer authority is unavailable: ${canonicalPath}`), {
      code: "RELEASE_COMMIT_INVALID",
    });
  }
  const generationPath = path.resolve(path.dirname(canonicalPath), canonicalAuthority.linkTarget);
  const generationRoot = releaseGenerationRoot(storeAuthority.requestedPath);
  const generationRootAuthority = await captureStrictDirectoryAuthority(generationRoot, "RELEASE_GENERATION_ROOT_UNSAFE");
  if (!isPathInside(generationPath, generationRootAuthority.requestedPath)) {
    throw Object.assign(new Error(`release pointer escapes its generation root: ${canonicalPath}`), {
      code: "RELEASE_COMMIT_INVALID",
    });
  }
  const relativeGeneration = path.relative(generationRootAuthority.requestedPath, generationPath);
  if (relativeGeneration.includes(path.sep) || !path.basename(generationPath).startsWith(`${releaseId}-`)) {
    throw Object.assign(new Error(`release pointer target is not an owned generation: ${generationPath}`), {
      code: "RELEASE_COMMIT_INVALID",
    });
  }
  const generationAuthority = await captureSelectionAuthority(generationPath, "directory");
  if (!generationAuthority) {
    throw Object.assign(new Error(`release generation is missing: ${generationPath}`), {
      code: "RELEASE_NOT_COMMITTED",
    });
  }
  const markerPath = releaseCommitMarkerPath(generationPath);
  const markerAuthority = await captureSelectionAuthority(markerPath, "file");
  if (!markerAuthority) {
    throw Object.assign(new Error(`release commit marker is missing: ${markerPath}`), {
      code: "RELEASE_COMMIT_INVALID",
    });
  }
  const marker = await readReleaseCommitMarker(generationPath);
  const manifestPath = manifestPathForRelease(generationPath);
  const manifestAuthority = await captureSelectionAuthority(manifestPath, "file");
  if (!manifestAuthority) {
    throw Object.assign(new Error(`committed release manifest is missing: ${manifestPath}`), {
      code: "RELEASE_COMMIT_INVALID",
    });
  }
  const metadata = await readReleaseMetadata(generationPath);
  const manifestRaw = await readBoundedRegularFileNoFollow(manifestPath, { maxBytes: RELEASE_METADATA_MAX_BYTES });
  await assertSelectionAuthority(manifestPath, manifestAuthority);
  if (
    marker.releaseId !== releaseId
    || path.resolve(marker.canonicalPath) !== canonicalPath
    || path.resolve(marker.generationPath) !== generationPath
    || createHash("sha256").update(manifestRaw).digest("hex") !== marker.manifestSha256
    || metadata.releaseId !== releaseId
    || path.resolve(String(metadata.installedPath || "")) !== canonicalPath
    || path.resolve(String(metadata.generationPath || "")) !== generationPath
  ) {
    throw Object.assign(new Error(`release commit marker does not bind its generation: ${canonicalPath}`), {
      code: "RELEASE_COMMIT_INVALID",
    });
  }
  await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_STORE_CHANGED");
  await verifyStrictDirectoryAuthority(generationRootAuthority, "RELEASE_GENERATION_ROOT_CHANGED");
  await assertSelectionAuthority(markerPath, markerAuthority);
  await assertSelectionAuthority(manifestPath, manifestAuthority);
  await assertSelectionAuthority(canonicalPath, canonicalAuthority);
  await assertSelectionAuthority(generationPath, generationAuthority);
  return {
    kind: "generation-pointer",
    releaseId,
    canonicalPath,
    resolvedPath: generationPath,
    metadata,
    canonicalAuthority,
    generationAuthority,
    commitMarker: marker,
  };
}

function formatTimestampId(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function generateDefaultReleaseId(codeVersion: string | undefined, now: Date) {
  const stamp = formatTimestampId(now instanceof Date ? now : new Date());
  return `${codeVersion || "dev"}-${stamp}`;
}

function copyFilter(source: string) {
  const base = path.basename(source);
  if (EXCLUDED_COPY_NAMES.has(base)) return false;
  if (base === "target" && source.includes(`${path.sep}runtime${path.sep}`)) return false;
  return true;
}

async function exists(targetPath: string) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

type ReleaseTreeBinding = {
  path: string;
  generation: PathGeneration;
  kind: "directory" | "file" | "symlink";
  linkTarget?: string;
};

async function writeExclusiveDurableReleaseFile(
  filePath: string,
  content: string,
  maxBytes: number,
  unsafeCode: string,
) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw Object.assign(new Error(`O_NOFOLLOW is unavailable for release file: ${filePath}`), {
      code: unsafeCode,
    });
  }
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw Object.assign(new Error(`release file exceeds ${maxBytes} bytes: ${filePath}`), {
      code: unsafeCode,
    });
  }
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let primary: unknown = null;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    primary = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primary) {
      throw new AggregateError([primary, closeError], `release file write and close failed: ${filePath}`, {
        cause: primary,
      });
    }
    throw closeError;
  }
  if (primary) throw primary;
  const authority = await captureSelectionAuthority(filePath, "file");
  if (!authority) {
    throw Object.assign(new Error(`durable release file disappeared: ${filePath}`), { code: unsafeCode });
  }
  return authority;
}

async function syncReleaseGenerationTree(root: string) {
  const visit = async (entryPath: string): Promise<void> => {
    const before = await lstat(entryPath, { bigint: true });
    if (before.isSymbolicLink()) return;
    if (before.isFile()) {
      if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
        throw Object.assign(new Error(`O_NOFOLLOW is unavailable for release payload: ${entryPath}`), {
          code: "RELEASE_INSTALL_UNSAFE",
        });
      }
      const handle = await open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let primary: unknown = null;
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || !samePathGeneration(pathGeneration(before), pathGeneration(opened))) {
          throw Object.assign(new Error(`release payload changed before durability sync: ${entryPath}`), {
            code: "RELEASE_INSTALL_STAGE_CHANGED",
          });
        }
        await handle.sync();
      } catch (error) {
        primary = error;
      }
      try {
        await handle.close();
      } catch (closeError) {
        if (primary) throw new AggregateError([primary, closeError], `release payload sync and close failed: ${entryPath}`);
        throw closeError;
      }
      if (primary) throw primary;
      const after = await lstat(entryPath, { bigint: true });
      if (!after.isFile() || !samePathGeneration(pathGeneration(before), pathGeneration(after))) {
        throw Object.assign(new Error(`release payload changed during durability sync: ${entryPath}`), {
          code: "RELEASE_INSTALL_STAGE_CHANGED",
        });
      }
      return;
    }
    if (!before.isDirectory()) {
      throw Object.assign(new Error(`release payload contains an unsupported entry: ${entryPath}`), {
        code: "RELEASE_INSTALL_UNSAFE",
      });
    }
    const entries = await readdir(entryPath, { withFileTypes: true });
    for (const entry of entries) await visit(path.join(entryPath, entry.name));
    await fsyncDirectory(entryPath);
    const after = await lstat(entryPath, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameDirectoryIdentity(pathGeneration(before), pathGeneration(after))) {
      throw Object.assign(new Error(`release payload directory changed during durability sync: ${entryPath}`), {
        code: "RELEASE_INSTALL_STAGE_CHANGED",
      });
    }
  };
  await visit(path.resolve(root));
}

async function captureReleaseGenerationTree(root: string) {
  const bindings: ReleaseTreeBinding[] = [];
  const visit = async (entryPath: string): Promise<void> => {
    const before = await lstat(entryPath, { bigint: true });
    const kind = before.isSymbolicLink()
      ? "symlink"
      : before.isDirectory()
        ? "directory"
        : before.isFile()
          ? "file"
          : null;
    if (!kind) {
      throw Object.assign(new Error(`release generation contains an unsupported entry: ${entryPath}`), {
        code: "RELEASE_INSTALL_UNSAFE",
      });
    }
    const linkTarget = kind === "symlink" ? await readlink(entryPath) : undefined;
    if (kind === "directory") {
      const entries = await readdir(entryPath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) await visit(path.join(entryPath, entry.name));
    }
    const after = await lstat(entryPath, { bigint: true });
    if (!samePathGeneration(pathGeneration(before), pathGeneration(after))) {
      throw Object.assign(new Error(`release generation changed while capturing authority: ${entryPath}`), {
        code: "RELEASE_INSTALL_STAGE_CHANGED",
      });
    }
    bindings.push({
      path: entryPath,
      generation: pathGeneration(after),
      kind,
      ...(linkTarget === undefined ? {} : { linkTarget }),
    });
  };
  await visit(path.resolve(root));
  return bindings;
}

async function verifyReleaseGenerationTree(
  root: string,
  expected: ReleaseTreeBinding[],
  {
    expectedRoot = root,
    rootAcrossRename = false,
  }: { expectedRoot?: string; rootAcrossRename?: boolean } = {},
) {
  const current = await captureReleaseGenerationTree(root);
  if (current.length !== expected.length) {
    throw Object.assign(new Error(`release generation entry set changed: ${root}`), {
      code: "RELEASE_INSTALL_STAGE_CHANGED",
    });
  }
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = current[index];
    const expectedRelativePath = path.relative(path.resolve(expectedRoot), left.path);
    const currentRelativePath = path.relative(path.resolve(root), right.path);
    const sameGeneration = rootAcrossRename && expectedRelativePath === ""
      ? samePathIdentity(left.generation, right.generation)
      : samePathGeneration(left.generation, right.generation);
    if (
      expectedRelativePath !== currentRelativePath
      || left.kind !== right.kind
      || left.linkTarget !== right.linkTarget
      || !sameGeneration
    ) {
      throw Object.assign(new Error(`release generation changed before publication: ${left.path}`), {
        code: "RELEASE_INSTALL_STAGE_CHANGED",
      });
    }
  }
}

type ReleasePointerTargetBinding = {
  generationPath: string;
  generationAuthority: SelectionAuthority;
  tree: ReleaseTreeBinding[];
  commitMarker: ReleaseCommitMarker;
};

async function verifyReleasePointerTargetBinding(binding: ReleasePointerTargetBinding) {
  await assertSelectionAuthority(binding.generationPath, binding.generationAuthority);
  await verifyReleaseGenerationTree(binding.generationPath, binding.tree);
  const marker = await readReleaseCommitMarker(binding.generationPath);
  const manifestRaw = await readBoundedRegularFileNoFollow(
    manifestPathForRelease(binding.generationPath),
    { maxBytes: RELEASE_METADATA_MAX_BYTES },
  );
  if (
    marker.commitVersion !== binding.commitMarker.commitVersion
    || marker.releaseId !== binding.commitMarker.releaseId
    || path.resolve(marker.canonicalPath) !== path.resolve(binding.commitMarker.canonicalPath)
    || path.resolve(marker.generationPath) !== binding.generationPath
    || marker.manifestSha256 !== binding.commitMarker.manifestSha256
    || marker.committedAt !== binding.commitMarker.committedAt
    || createHash("sha256").update(manifestRaw).digest("hex") !== marker.manifestSha256
  ) {
    throw Object.assign(new Error(`release generation commit binding changed: ${binding.generationPath}`), {
      code: "RELEASE_COMMIT_INVALID",
    });
  }
  await verifyReleaseGenerationTree(binding.generationPath, binding.tree);
  await assertSelectionAuthority(binding.generationPath, binding.generationAuthority);
}

async function captureReleasePointerTargetBinding(
  storeRoot: string,
  releaseId: string,
  canonicalPath: string,
  canonicalAuthority: SelectionAuthority,
) {
  const committed = await resolveCommittedRelease(storeRoot, releaseId);
  if (
    committed.kind !== "generation-pointer"
    || committed.canonicalPath !== canonicalPath
    || !committed.commitMarker
  ) {
    throw Object.assign(new Error(`release pointer is not a committed generation: ${canonicalPath}`), {
      code: "RELEASE_COMMIT_INVALID",
    });
  }
  await assertSelectionAuthority(canonicalPath, canonicalAuthority);
  const binding: ReleasePointerTargetBinding = {
    generationPath: committed.resolvedPath,
    generationAuthority: committed.generationAuthority,
    tree: await captureReleaseGenerationTree(committed.resolvedPath),
    commitMarker: committed.commitMarker,
  };
  await verifyReleasePointerTargetBinding(binding);
  await assertSelectionAuthority(canonicalPath, canonicalAuthority);
  return binding;
}

export async function installRelease({
  sourceRoot,
  destRoot,
  name,
  now = new Date(),
  env,
  hooksForTest,
}: InstallReleaseOptions = {}) {
  const resolvedSource = await assertExecutorRoot(sourceRoot);
  const pkg = await readExecutorPackage(resolvedSource);
  const releaseDate = now instanceof Date ? now : new Date(now);

  const releaseId = name
    ? name
    : generateDefaultReleaseId(pkg.version, releaseDate);
  validateReleaseId(releaseId);

  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  const installedPath = path.join(storeRoot, releaseId);

  if (!installedPath.startsWith(storeRoot + path.sep) && installedPath !== storeRoot) {
    throw new Error(`release id resolves outside the release store root: ${releaseId}`);
  }

  try {
    await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw Object.assign(new Error(`release store cannot be created safely: ${storeRoot}`, { cause }), {
      code: "RELEASE_INSTALL_UNSAFE",
    });
  }
  const storeAuthority = await captureStrictDirectoryAuthority(storeRoot, "RELEASE_INSTALL_UNSAFE");
  await fsyncDirectory(path.dirname(storeAuthority.canonicalPath));

  const generationRoot = releaseGenerationRoot(storeRoot);
  try {
    await mkdir(generationRoot, { recursive: false, mode: 0o700 });
  } catch (cause) {
    if (errnoCode(cause) !== "EEXIST") {
      throw Object.assign(new Error(`release generation root cannot be created safely: ${generationRoot}`, { cause }), {
        code: "RELEASE_INSTALL_UNSAFE",
      });
    }
  }
  const generationRootAuthority = await captureStrictDirectoryAuthority(generationRoot, "RELEASE_INSTALL_UNSAFE");
  await hooksForTest?.syncDirectory?.({ directory: storeRoot, phase: "generation-root" });
  await fsyncDirectory(storeRoot);

  const generationPath = path.join(generationRoot, `${releaseId}-${randomUUID()}`);
  let published = false;
  let stageAuthority: ReleaseTreeBinding[] | null = null;
  try {
    await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_INSTALL_STAGE_CHANGED");
    await verifyStrictDirectoryAuthority(generationRootAuthority, "RELEASE_INSTALL_STAGE_CHANGED");
    await mkdir(generationPath, { recursive: false, mode: 0o700 });

    for (const item of ALLOWED_ASSETS) {
      const sourcePath = path.join(resolvedSource, item);
      if (!(await exists(sourcePath)) && item === "package-lock.json") {
        continue;
      }
      await cp(
        sourcePath,
        path.join(generationPath, item),
        { recursive: true, verbatimSymlinks: true, filter: copyFilter },
      );
    }

    await mkdir(path.join(generationPath, "wiki"), { recursive: true });
    const wikiSystemDir = path.join(resolvedSource, "wiki", "system");
    if (await exists(wikiSystemDir)) {
      await cp(
        wikiSystemDir,
        path.join(generationPath, "wiki", "system"),
        { recursive: true, verbatimSymlinks: true, filter: copyFilter },
      );
    }
    await mkdir(path.join(generationPath, "wiki", "projects"), { recursive: true });

    const templateDir = path.join(resolvedSource, "wiki", "projects", "_template");
    if (await exists(templateDir)) {
      await cp(
        templateDir,
        path.join(generationPath, "wiki", "projects", "_template"),
        { recursive: true, verbatimSymlinks: true, filter: copyFilter },
      );
    }

    try { await chmod(path.join(generationPath, "cpb"), 0o755); } catch {}

    const { QUEUE_VERSION } = await import("../hub/hub-queue.js");
    const { JOBS_EVENTS_FORMAT_VERSION } = await import("../event/event-store.js");
    const { LEASE_FORMAT_VERSION } = await import("../infra.js");
    const { PROCESS_REGISTRY_FORMAT_VERSION } = await import("../infra.js");

    const manifest = {
      metadataVersion: RELEASE_METADATA_FORMAT_VERSION,
      releaseId,
      sourcePath: resolvedSource,
      installedPath,
      generationPath,
      createdAt: releaseDate.toISOString(),
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

    const releaseDirectory = path.join(generationPath, "release");
    await mkdir(releaseDirectory, { recursive: true });
    const manifestPath = path.join(releaseDirectory, "manifest.json");
    const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeExclusiveDurableReleaseFile(
      manifestPath,
      manifestRaw,
      RELEASE_METADATA_MAX_BYTES,
      "RELEASE_INSTALL_UNSAFE",
    );
    await syncReleaseGenerationTree(generationPath);

    const commitMarker: ReleaseCommitMarker = {
      commitVersion: RELEASE_COMMIT_FORMAT_VERSION,
      releaseId,
      canonicalPath: installedPath,
      generationPath,
      manifestSha256: createHash("sha256").update(manifestRaw).digest("hex"),
      committedAt: releaseDate.toISOString(),
    };
    await writeExclusiveDurableReleaseFile(
      releaseCommitMarkerPath(generationPath),
      `${JSON.stringify(commitMarker, null, 2)}\n`,
      RELEASE_COMMIT_MAX_BYTES,
      "RELEASE_INSTALL_UNSAFE",
    );
    await fsyncDirectory(generationPath);
    await hooksForTest?.syncDirectory?.({ directory: generationRoot, phase: "generation-commit" });
    await fsyncDirectory(generationRoot);

    stageAuthority = await captureReleaseGenerationTree(generationPath);
    await hooksForTest?.beforePublication?.({ stagePath: generationPath, installedPath });
    await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_INSTALL_STAGE_CHANGED");
    await verifyStrictDirectoryAuthority(generationRootAuthority, "RELEASE_INSTALL_STAGE_CHANGED");
    await verifyReleaseGenerationTree(generationPath, stageAuthority);
    const marker = await readReleaseCommitMarker(generationPath);
    const currentManifestRaw = await readBoundedRegularFileNoFollow(manifestPath, {
      maxBytes: RELEASE_METADATA_MAX_BYTES,
    });
    if (
      marker.releaseId !== releaseId
      || path.resolve(marker.canonicalPath) !== installedPath
      || path.resolve(marker.generationPath) !== generationPath
      || createHash("sha256").update(currentManifestRaw).digest("hex") !== marker.manifestSha256
    ) {
      throw Object.assign(new Error(`release generation commit changed before publication: ${generationPath}`), {
        code: "RELEASE_INSTALL_STAGE_CHANGED",
      });
    }
    await verifyReleaseGenerationTree(generationPath, stageAuthority);

    try {
      await symlink(generationPath, installedPath);
    } catch (cause) {
      if (errnoCode(cause) === "EEXIST") {
        throw Object.assign(new Error(`release successor preserved during publication: ${installedPath}`, { cause }), {
          code: "RELEASE_INSTALL_SUCCESSOR_PRESERVED",
          committed: false,
          successorPreserved: true,
          attemptedPaths: [installedPath, generationPath, releaseCommitMarkerPath(generationPath)],
        });
      }
      throw cause;
    }
    published = true;
    const pointerAuthority = await captureSelectionAuthority(installedPath, "symlink");
    if (!pointerAuthority || path.resolve(path.dirname(installedPath), pointerAuthority.linkTarget!) !== generationPath) {
      throw Object.assign(new Error(`published release pointer does not bind its generation: ${installedPath}`), {
        code: "RELEASE_INSTALL_COMMITTED_AMBIGUOUS",
      });
    }
    await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_INSTALL_COMMITTED_AMBIGUOUS");
    await verifyStrictDirectoryAuthority(generationRootAuthority, "RELEASE_INSTALL_COMMITTED_AMBIGUOUS");
    await resolveCommittedRelease(storeRoot, releaseId);
    await assertSelectionAuthority(installedPath, pointerAuthority);
    await hooksForTest?.syncDirectory?.({ directory: storeRoot, phase: "pointer-publication" });
    await fsyncDirectory(storeRoot);
    await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_INSTALL_COMMITTED_AMBIGUOUS");
    await verifyStrictDirectoryAuthority(generationRootAuthority, "RELEASE_INSTALL_COMMITTED_AMBIGUOUS");
    await assertSelectionAuthority(installedPath, pointerAuthority);
    return manifest;
  } catch (err) {
    const primary = err instanceof Error ? err : new Error(String(err));
    const primaryRecord = primary as Error & {
      code?: string;
      successorPreserved?: boolean;
    };
    const attemptedPaths = [installedPath, generationPath, releaseCommitMarkerPath(generationPath)];
    const recoveryPaths: string[] = [];
    if (stageAuthority) {
      try {
        await verifyReleaseGenerationTree(generationPath, stageAuthority);
        recoveryPaths.push(generationPath);
      } catch {
        // The original generation was moved or replaced. The lexical stage
        // path is only an attempted location and must not be advertised as
        // preserved evidence for the original generation.
      }
    }
    let verifiedCommittedPath: string | undefined;
    if (published && recoveryPaths.includes(generationPath)) {
      try {
        const committed = await resolveCommittedRelease(storeRoot, releaseId);
        if (committed.resolvedPath === generationPath && committed.canonicalPath === installedPath) {
          verifiedCommittedPath = installedPath;
          recoveryPaths.unshift(installedPath);
        }
      } catch {
        // Publication happened, but the canonical path no longer proves which
        // generation is present. Keep it in attemptedPaths only.
      }
    }
    const originalEvidence = recoveryPaths.includes(generationPath) ? "verified" : "unknown";
    throw Object.assign(new Error(
      published
        ? `release installation committed with durability or generation ambiguity: ${installedPath}`
        : originalEvidence === "verified"
          ? `release installation failed; committed generation retained for recovery: ${generationPath}`
          : `release installation failed; original generation evidence location is unknown: ${generationPath}`,
      { cause: primary },
    ), {
      code: published ? "RELEASE_INSTALL_COMMITTED_AMBIGUOUS" : primaryRecord.code || "RELEASE_INSTALL_RECOVERY_REQUIRED",
      committed: published,
      ...(verifiedCommittedPath ? { committedPath: verifiedCommittedPath } : {}),
      ...(primaryRecord.successorPreserved === undefined
        ? {}
        : { successorPreserved: primaryRecord.successorPreserved }),
      originalEvidence,
      recoveryPaths,
      attemptedPaths,
    });
  }
}

export function resolveCpbHome({ env = process.env }: { env?: ReleaseEnv } = {}) {
  return env.CPB_HOME || path.join(env.HOME || "/tmp", ".cpb");
}

export function currentReleaseLinkPath({ env = process.env }: { env?: ReleaseEnv } = {}) {
  return path.join(resolveCpbHome({ env }), "current");
}

export function currentReleaseStatePath({ env = process.env }: { env?: ReleaseEnv } = {}) {
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

export async function listReleases({ destRoot, env = process.env }: ReleaseStoreOptions = {}) {
  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  let currentSelection = null;
  try {
    currentSelection = await readCurrentReleaseSelection({ env });
  } catch {}

  const releases: ReleaseListItem[] = [];
  let entries;
  try {
    entries = await readdir(storeRoot, { withFileTypes: true });
  } catch {
    return { releaseStoreRoot: storeRoot, current: currentSelection?.selector?.releaseId || null, releases };
  }

  const committedEntries = entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  for (const name of committedEntries) {
    try {
      const committed = await resolveCommittedRelease(storeRoot, name);
      const manifest = committed.metadata;
      releases.push({
        releaseId: manifest.releaseId || name,
        installedPath: committed.canonicalPath,
        generationPath: committed.resolvedPath,
        createdAt: manifest.createdAt,
        codeVersion: manifest.codeVersion,
        packageName: manifest.packageName,
        metadataVersion: manifest.metadataVersion,
        stateFormatVersions: manifest.stateFormatVersions,
        current: currentSelection?.selector?.releaseId === (manifest.releaseId || name),
        status: "valid",
      });
    } catch (error) {
      releases.push({
        releaseId: name,
        installedPath: path.join(storeRoot, name),
        current: currentSelection?.selector?.releaseId === name,
        status: "invalid",
        error: errorMessage(error),
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

async function readReleaseSelectorState(statePath: string): Promise<ReleaseSelector> {
  const directoryBindings = await captureDirectoryBindings(statePath);
  await verifyDirectoryBindings(directoryBindings);
  const raw = await readBoundedRegularFileNoFollow(statePath, {
    maxBytes: RELEASE_SELECTION_STATE_MAX_BYTES,
    hooks: {
      afterOpen: async () => verifyDirectoryBindings(directoryBindings),
      beforePathGenerationCheck: async () => verifyDirectoryBindings(directoryBindings),
    },
  });
  await verifyDirectoryBindings(directoryBindings);
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw Object.assign(new Error(`release selector must be a JSON object: ${statePath}`), {
      code: "RELEASE_SELECTION_INVALID",
      path: statePath,
    });
  }
  return parsed;
}

async function readExactReleaseLinkTarget(linkPath: string) {
  const directoryBindings = await captureDirectoryBindings(linkPath);
  await verifyDirectoryBindings(directoryBindings);
  const before = await lstat(linkPath, { bigint: true });
  if (!before.isSymbolicLink()) {
    throw Object.assign(new Error(`current release link must be a symbolic link: ${linkPath}`), {
      code: "RELEASE_SELECTION_UNSAFE",
      path: linkPath,
    });
  }
  const target = await readlink(linkPath);
  await verifyDirectoryBindings(directoryBindings);
  const after = await lstat(linkPath, { bigint: true });
  if (!after.isSymbolicLink() || !samePathGeneration(pathGeneration(before), pathGeneration(after))) {
    throw Object.assign(new Error(`current release link changed while reading: ${linkPath}`), {
      code: "RELEASE_SELECTION_CHANGED",
      path: linkPath,
    });
  }
  const resolvedTarget = path.resolve(path.dirname(linkPath), target);
  const targetInfo = await lstat(resolvedTarget, { bigint: true });
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw Object.assign(new Error(`current release link target must be a real directory: ${resolvedTarget}`), {
      code: "RELEASE_SELECTION_UNSAFE",
      path: linkPath,
      target: resolvedTarget,
    });
  }
  await verifyDirectoryBindings(directoryBindings);
  return resolvedTarget;
}

export async function readCurrentReleaseSelection({ env = process.env }: { env?: ReleaseEnv } = {}): Promise<CurrentReleaseSelection | null> {
  const statePath = currentReleaseStatePath({ env });
  let selector = null;
  try {
    selector = await readReleaseSelectorState(statePath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }

  const linkPath = currentReleaseLinkPath({ env });
  let linkTarget = null;
  try {
    linkTarget = await readExactReleaseLinkTarget(linkPath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }

  if (!selector && !linkTarget) return null;
  if (
    selector
    && linkTarget
    && (
      typeof selector.releasePath !== "string"
      || path.resolve(selector.releasePath) !== linkTarget
    )
  ) {
    throw Object.assign(new Error(`current release state and link disagree: ${statePath}; ${linkPath}`), {
      code: "RELEASE_SELECTION_INCONSISTENT",
      recoveryPaths: [statePath, linkPath],
    });
  }
  return { selector, linkTarget };
}

export async function inspectCurrentRelease({ env = process.env }: { env?: ReleaseEnv } = {}) {
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

export async function checkReleaseCompatibility({ releaseId, destRoot, env = process.env }: ReleaseStoreOptions & { releaseId?: string } = {}): Promise<ReleaseCompatibility> {
  try {
    validateReleaseId(releaseId);
  } catch (err) {
    return {
      ok: false,
      releaseId: String(releaseId),
      releasePath: null,
      metadata: null,
      failures: [{ code: "release_path_invalid", message: errorMessage(err), releaseId: String(releaseId) }],
    };
  }

  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  const canonicalPath = releasePath(storeRoot, releaseId);
  const failures: ReleaseFailure[] = [];

  const resolvedStoreRoot = path.resolve(storeRoot);
  const resolvedRPath = path.resolve(canonicalPath);
  if (!resolvedRPath.startsWith(resolvedStoreRoot + path.sep) && resolvedRPath !== resolvedStoreRoot) {
    return {
      ok: false,
      releaseId,
      releasePath: canonicalPath,
      canonicalPath,
      metadata: null,
      failures: [{ code: "release_path_invalid", message: "Release path resolves outside release store root", path: canonicalPath }],
    };
  }

  if (!await exists(canonicalPath)) {
    failures.push({ code: "missing_release", message: `Release not found: ${releaseId}`, path: canonicalPath, remediation: "Install the release first with cpb release install" });
    return { ok: false, releaseId, releasePath: canonicalPath, canonicalPath, metadata: null, failures };
  }

  let committed: CommittedRelease;
  try {
    committed = await resolveCommittedRelease(storeRoot, releaseId);
  } catch (err) {
    const code = errnoCode(err);
    const failureCode = code === "ENOENT"
      ? "missing_release"
      : code === "RELEASE_NOT_COMMITTED" || code === "RELEASE_COMMIT_INVALID"
        ? "release_not_committed"
        : code === "RELEASE_METADATA_INVALID" || err instanceof SyntaxError
          ? "manifest_malformed"
          : "release_path_invalid";
    return {
      ok: false,
      releaseId,
      releasePath: canonicalPath,
      canonicalPath,
      metadata: null,
      failures: [{
        code: failureCode,
        message: `Release is not safely committed: ${errorMessage(err)}`,
        path: canonicalPath,
        remediation: "Install the release again and publish its canonical release pointer",
      }],
    };
  }

  const rPath = committed.resolvedPath;
  const manifestFile = manifestPathForRelease(rPath);
  const manifest = committed.metadata;

  const missing = REQUIRED_METADATA_FIELDS.filter(f => manifest[f] === undefined || manifest[f] === null);
  if (missing.length > 0) {
    failures.push({ code: "metadata_incomplete", message: `Missing required metadata fields: ${missing.join(", ")}`, path: manifestFile, fields: missing });
  }

  if (manifest.releaseId && manifest.releaseId !== releaseId) {
    failures.push({ code: "release_id_mismatch", message: `Manifest releaseId '${manifest.releaseId}' does not match requested '${releaseId}'`, path: manifestFile, field: "releaseId" });
  }
  if (
    typeof manifest.installedPath === "string"
    && path.resolve(manifest.installedPath) !== path.resolve(canonicalPath)
  ) {
    failures.push({
      code: "installed_path_mismatch",
      message: `Manifest installedPath '${manifest.installedPath}' does not match canonical path '${canonicalPath}'`,
      path: manifestFile,
      field: "installedPath",
    });
  }
  if (
    manifest.metadataVersion !== undefined
    && manifest.metadataVersion !== RELEASE_METADATA_FORMAT_VERSION
  ) {
    failures.push({
      code: "unsupported_metadata_format",
      message: `Unsupported release metadata version: ${manifest.metadataVersion} (supported: ${RELEASE_METADATA_FORMAT_VERSION})`,
      path: manifestFile,
      field: "metadataVersion",
      format: manifest.metadataVersion,
    });
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
    canonicalPath,
    metadata: manifest,
    failures,
  };
}

export class ReleaseCompatibilityError extends Error {
  failures: ReleaseFailure[];
  releaseId: string;

  constructor(failures: ReleaseFailure[], releaseId: string) {
    super(`Release '${releaseId}' is not compatible: ${failures.map(f => f.code).join(", ")}`);
    this.name = "ReleaseCompatibilityError";
    this.failures = failures;
    this.releaseId = releaseId;
  }
}

type SelectionAuthority = {
  generation: PathGeneration;
  kind: "file" | "symlink" | "directory";
  linkTarget?: string;
};

let releaseSelectionProcessTail: Promise<void> = Promise.resolve();

async function withReleaseSelectionProcessMutex<T>(callback: () => Promise<T>) {
  const predecessor = releaseSelectionProcessTail;
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  releaseSelectionProcessTail = predecessor.then(() => current, () => current);
  await predecessor.catch(() => undefined);
  try {
    return await callback();
  } finally {
    release();
  }
}

type SelectionRecoveryBinding = {
  authority: SelectionAuthority;
  acrossLink?: boolean;
};

function selectionPaths(context: ReleaseSelectionContext) {
  return [
    context.operationDir,
    context.stateStagePath,
    context.linkStagePath,
    context.previousStatePath,
    context.previousLinkPath,
    context.statePath,
    context.linkPath,
  ];
}

async function releaseSelectionRecoveryEvidence(
  context: ReleaseSelectionContext,
  bindings: Map<string, SelectionRecoveryBinding>,
) {
  const recoveryPaths: string[] = [];
  for (const candidate of selectionPaths(context)) {
    const binding = bindings.get(candidate);
    if (!binding) continue;
    try {
      await assertSelectionAuthority(candidate, binding.authority, {
        acrossLink: binding.acrossLink,
      });
      recoveryPaths.push(candidate);
    } catch {
      // Lexical pathnames are not recovery evidence. Only advertise a path
      // whose captured generation still occupies that exact pathname.
    }
  }
  const verified = new Set(recoveryPaths);
  return {
    recoveryPaths,
    attemptedPaths: selectionPaths(context).filter((candidate) => !verified.has(candidate)),
    originalEvidence: recoveryPaths.length > 0 ? "verified" as const : "unknown" as const,
  };
}

function releaseSelectionError(
  message: string,
  code: string,
  context: ReleaseSelectionContext,
  options: {
    cause?: unknown;
    committed?: boolean;
    committedPath?: string;
    successorPreserved?: boolean;
    recoveryPaths?: string[];
    attemptedPaths?: string[];
    originalEvidence?: "verified" | "unknown";
  } = {},
) {
  return Object.assign(
    new Error(message, options.cause === undefined ? undefined : { cause: options.cause }),
    {
      code,
      committed: options.committed ?? false,
      ...(options.committedPath ? { committedPath: options.committedPath } : {}),
      ...(options.successorPreserved === undefined ? {} : { successorPreserved: options.successorPreserved }),
      recoveryPaths: options.recoveryPaths || [],
      attemptedPaths: options.attemptedPaths || selectionPaths(context),
      originalEvidence: options.originalEvidence || "unknown",
    },
  );
}

function releaseSelectionFailureMetadata(error: unknown) {
  const queue: unknown[] = [error];
  const visited = new Set<unknown>();
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;
    visited.add(candidate);
    const record = candidate as {
      code?: unknown;
      committed?: unknown;
      committedPath?: unknown;
      recoveryPaths?: unknown;
      attemptedPaths?: unknown;
      originalEvidence?: unknown;
      successorPreserved?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof record.code === "string" && Array.isArray(record.recoveryPaths)) {
      return {
        code: record.code,
        ...(typeof record.committed === "boolean" ? { committed: record.committed } : {}),
        ...(typeof record.committedPath === "string" ? { committedPath: record.committedPath } : {}),
        recoveryPaths: record.recoveryPaths,
        ...(Array.isArray(record.attemptedPaths) ? { attemptedPaths: record.attemptedPaths } : {}),
        ...(record.originalEvidence === "verified" || record.originalEvidence === "unknown"
          ? { originalEvidence: record.originalEvidence }
          : {}),
        ...(typeof record.successorPreserved === "boolean"
          ? { successorPreserved: record.successorPreserved }
          : {}),
      };
    }
    queue.push(record.cause);
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }
  return null;
}

async function ensureReleaseSelectionDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Object.assign(new Error(`release selection requires a real directory: ${directory}`), {
      code: "RELEASE_SELECTION_UNSAFE",
      path: directory,
    });
  }
}

async function syncReleaseSelectionDirectory(
  directory: string,
  phase: ReleaseSelectionSyncPhase,
  hooksForTest?: SelectReleaseHooks,
) {
  await hooksForTest?.syncDirectory?.({ directory, phase });
  await fsyncDirectory(directory);
}

async function writeReleaseSelectionStateStage(filePath: string, selector: ReleaseSelector) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw Object.assign(new Error(`O_NOFOLLOW is unavailable for release selection state: ${filePath}`), {
      code: "RELEASE_SELECTION_UNSAFE",
    });
  }
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let primary: unknown = null;
  try {
    const content = `${JSON.stringify(selector, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > RELEASE_SELECTION_STATE_MAX_BYTES) {
      throw Object.assign(new Error(`release selection state exceeds ${RELEASE_SELECTION_STATE_MAX_BYTES} bytes`), {
        code: "RELEASE_SELECTION_TOO_LARGE",
      });
    }
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    primary = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primary) {
      throw new AggregateError([primary, closeError], `release selection state write and close failed: ${filePath}`, {
        cause: primary,
      });
    }
    throw closeError;
  }
  if (primary) throw primary;
  const info = await lstat(filePath, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw Object.assign(new Error(`release selection state stage is unsafe: ${filePath}`), {
      code: "RELEASE_SELECTION_UNSAFE",
    });
  }
  return { generation: pathGeneration(info), kind: "file" } satisfies SelectionAuthority;
}

async function captureSelectionAuthority(
  filePath: string,
  expectedKind: "file" | "symlink" | "directory",
): Promise<SelectionAuthority | null> {
  let info: BigIntStats;
  try {
    info = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  const kind = info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : info.isDirectory() ? "directory" : null;
  if (kind !== expectedKind) {
    throw Object.assign(new Error(`release selection path has unsafe type: ${filePath}`), {
      code: "RELEASE_SELECTION_UNSAFE",
      path: filePath,
    });
  }
  const linkTarget = kind === "symlink" ? await readlink(filePath) : undefined;
  const after = await lstat(filePath, { bigint: true });
  if (!samePathGeneration(pathGeneration(info), pathGeneration(after))) {
    throw Object.assign(new Error(`release selection path changed while capturing authority: ${filePath}`), {
      code: "RELEASE_SELECTION_CHANGED",
      path: filePath,
    });
  }
  return { generation: pathGeneration(after), kind, ...(linkTarget === undefined ? {} : { linkTarget }) };
}

async function selectionPathPresent(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertSelectionAuthority(
  filePath: string,
  expected: SelectionAuthority,
  { acrossLink = false }: { acrossLink?: boolean } = {},
) {
  let current: SelectionAuthority | null;
  try {
    current = await captureSelectionAuthority(filePath, expected.kind);
  } catch (cause) {
    throw Object.assign(new Error(`release selection authority changed: ${filePath}`, { cause }), {
      code: "RELEASE_SELECTION_CHANGED",
      path: filePath,
    });
  }
  if (
    !current
    || !(acrossLink
      ? samePathIdentity(expected.generation, current.generation)
      : samePathGeneration(expected.generation, current.generation))
    || expected.linkTarget !== current.linkTarget
  ) {
    throw Object.assign(new Error(`release selection authority changed: ${filePath}`), {
      code: "RELEASE_SELECTION_CHANGED",
      path: filePath,
    });
  }
  return current;
}

async function assertSelectionDirectoryIdentity(filePath: string, expected: SelectionAuthority) {
  const current = await captureSelectionDirectoryIdentity(filePath);
  if (!current || !sameDirectoryIdentity(expected.generation, current.generation)) {
    throw Object.assign(new Error(`release selection directory identity changed: ${filePath}`), {
      code: "RELEASE_SELECTION_PARENT_CHANGED",
      path: filePath,
    });
  }
}

async function captureSelectionDirectoryIdentity(filePath: string): Promise<SelectionAuthority | null> {
  let info: BigIntStats;
  try {
    info = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Object.assign(new Error(`release selection directory is unsafe: ${filePath}`), {
      code: "RELEASE_SELECTION_UNSAFE",
      path: filePath,
    });
  }
  return { generation: pathGeneration(info), kind: "directory" };
}

export async function selectRelease({
  releaseId,
  destRoot,
  env = process.env,
  now,
  hooksForTest,
}: SelectReleaseOptions = {}) {
  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  let committedBefore: CommittedRelease | null = null;
  if (releaseId) {
    try {
      committedBefore = await resolveCommittedRelease(storeRoot, releaseId);
    } catch {
      // Compatibility below returns the stable public error shape for missing,
      // malformed, unsafe, and not-yet-published generations.
    }
  }
  const compat = await checkReleaseCompatibility({ releaseId, destRoot, env });
  if (!compat.ok) {
    throw new ReleaseCompatibilityError(compat.failures, releaseId);
  }
  if (
    !compat.releasePath
    || !compat.canonicalPath
    || !committedBefore
    || path.resolve(compat.releasePath) !== committedBefore.resolvedPath
    || path.resolve(compat.canonicalPath) !== committedBefore.canonicalPath
  ) {
    throw Object.assign(new Error(`release selection target authority is unavailable: ${releaseId}`), {
      code: "RELEASE_SELECTION_TARGET_CHANGED",
      releaseId,
    });
  }
  const targetBefore = committedBefore.generationAuthority;
  const canonicalBefore = committedBefore.canonicalAuthority;
  try {
    await assertSelectionAuthority(compat.releasePath, targetBefore);
    await assertSelectionAuthority(compat.canonicalPath, canonicalBefore);
  } catch (cause) {
    throw Object.assign(new Error(`release selection target changed during compatibility checks: ${compat.releasePath}`, { cause }), {
      code: "RELEASE_SELECTION_TARGET_CHANGED",
      releaseId,
      path: compat.releasePath,
    });
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

  const statePath = currentReleaseStatePath({ env });
  const stateDir = path.dirname(statePath);
  const linkPath = currentReleaseLinkPath({ env });
  const generationRoot = path.join(stateDir, ".selection-generations");
  let activeContext: ReleaseSelectionContext | null = null;
  let activeRecoveryBindings: Map<string, SelectionRecoveryBinding> | null = null;
  let activeCommittedCandidates: string[] = [];
  let callbackSucceeded = false;
  try {
  return await withReleaseSelectionProcessMutex(async () => {
    await ensureReleaseSelectionDirectory(cpbHome);
    await ensureReleaseSelectionDirectory(stateDir);
    await ensureReleaseSelectionDirectory(generationRoot);
    await syncReleaseSelectionDirectory(stateDir, "generation-root", hooksForTest);
    const cpbHomeAuthority = await captureSelectionDirectoryIdentity(cpbHome);
    const stateDirAuthority = await captureSelectionDirectoryIdentity(stateDir);
    const generationRootAuthority = await captureSelectionDirectoryIdentity(generationRoot);
    if (!cpbHomeAuthority || !stateDirAuthority || !generationRootAuthority) {
      throw Object.assign(new Error("release selection directory authority is unavailable"), {
        code: "RELEASE_SELECTION_PARENT_CHANGED",
        recoveryPaths: [],
        attemptedPaths: [cpbHome, stateDir, generationRoot],
        originalEvidence: "unknown",
      });
    }
    return withDurableDirectoryLock(path.join(stateDir, ".selection.lock"), async () => {
    const operationId = randomUUID();
    const operationDir = path.join(generationRoot, operationId);
    const context: ReleaseSelectionContext = {
      operationId,
      operationDir,
      statePath,
      linkPath,
      stateStagePath: path.join(operationDir, "next-state.json"),
      linkStagePath: path.join(operationDir, "next-link"),
      previousStatePath: path.join(operationDir, "previous-state.json"),
      previousLinkPath: path.join(operationDir, "previous-link"),
      releasePath: compat.releasePath,
    };
    activeContext = context;
    let mutationCommitted = false;
    const recoveryBindings = new Map<string, SelectionRecoveryBinding>();
    const committedCandidates: string[] = [];
    activeRecoveryBindings = recoveryBindings;
    activeCommittedCandidates = committedCandidates;
    const registerRecovery = (
      candidate: string,
      authority: SelectionAuthority,
      acrossLink = false,
    ) => recoveryBindings.set(candidate, { authority, ...(acrossLink ? { acrossLink } : {}) });
    const unregisterRecovery = (candidate: string) => recoveryBindings.delete(candidate);
    const registerCommit = (candidate: string) => {
      const existing = committedCandidates.indexOf(candidate);
      if (existing >= 0) committedCandidates.splice(existing, 1);
      committedCandidates.unshift(candidate);
    };
    const fail = async (
      message: string,
      code: string,
      cause?: unknown,
      options: { successorPreserved?: boolean; stableCommittedPaths?: string[] } = {},
    ) => {
      const evidence = await releaseSelectionRecoveryEvidence(context, recoveryBindings);
      const committedPath = mutationCommitted
        ? [
            ...(options.stableCommittedPaths || []),
            ...committedCandidates,
          ].find((candidate, index, candidates) => (
            candidates.indexOf(candidate) === index
            && evidence.recoveryPaths.includes(candidate)
          ))
        : undefined;
      const effectiveCode = mutationCommitted && !committedPath
        ? "RELEASE_SELECTION_COMMITTED_AMBIGUOUS"
        : code;
      return releaseSelectionError(message, effectiveCode, context, {
        cause,
        committed: mutationCommitted,
        ...(committedPath ? { committedPath } : {}),
        successorPreserved: options.successorPreserved,
        ...evidence,
      });
    };

    try {
    const assertSelectionDirectories = async () => {
      try {
        await assertSelectionDirectoryIdentity(cpbHome, cpbHomeAuthority);
        await assertSelectionDirectoryIdentity(stateDir, stateDirAuthority);
        await assertSelectionDirectoryIdentity(generationRoot, generationRootAuthority);
      } catch (cause) {
        throw await fail(
          `release selection parent generation changed: ${cpbHome}`,
          "RELEASE_SELECTION_PARENT_CHANGED",
          cause,
        );
      }
    };

    const assertTarget = async () => {
      await assertSelectionDirectories();
      try {
        await assertSelectionAuthority(compat.releasePath!, targetBefore!);
        await assertSelectionAuthority(compat.canonicalPath!, canonicalBefore);
      } catch (cause) {
        throw await fail(
          `release selection target changed before commit: ${compat.releasePath}`,
          "RELEASE_SELECTION_TARGET_CHANGED",
          cause,
        );
      }
    };

    const syncOrAmbiguous = async (
      directory: string,
      phase: ReleaseSelectionSyncPhase,
      stableCommittedPath?: string,
    ) => {
      try {
        await assertSelectionDirectories();
        await syncReleaseSelectionDirectory(directory, phase, hooksForTest);
        await assertSelectionDirectories();
      } catch (cause) {
        throw await fail(
          `release selection mutation committed but ${phase} durability is ambiguous: ${directory}`,
          "RELEASE_SELECTION_COMMITTED_DURABILITY_AMBIGUOUS",
          cause,
          { stableCommittedPaths: stableCommittedPath ? [stableCommittedPath] : [] },
        );
      }
    };

    // Capture the canonical predecessor before any asynchronous stage work.
    // A path that appears or changes after this point is a successor and must
    // be preserved, not silently adopted as the predecessor to replace.
    await assertSelectionDirectories();
    const previousState = await captureSelectionAuthority(statePath, "file");
    const previousLink = await captureSelectionAuthority(linkPath, "symlink");
    if (previousState) registerRecovery(statePath, previousState);
    if (previousLink) registerRecovery(linkPath, previousLink);
    if (previousState && previousLink) {
      try {
        const previousSelector = await readReleaseSelectorState(statePath);
        const previousTarget = path.resolve(path.dirname(linkPath), previousLink.linkTarget!);
        if (
          typeof previousSelector.releasePath !== "string"
          || path.resolve(previousSelector.releasePath) !== previousTarget
        ) {
          throw new Error("existing state and link target disagree");
        }
        await assertSelectionAuthority(statePath, previousState);
        await assertSelectionAuthority(linkPath, previousLink);
      } catch (cause) {
        throw await fail(
          `existing release selection is inconsistent and was preserved: ${statePath}; ${linkPath}`,
          "RELEASE_SELECTION_EXISTING_INCONSISTENT",
          cause,
          { successorPreserved: true },
        );
      }
    }

    await mkdir(operationDir, { recursive: false, mode: 0o700 });
    await syncReleaseSelectionDirectory(generationRoot, "generation-directory", hooksForTest);
    const stateStage = await writeReleaseSelectionStateStage(context.stateStagePath, selector);
    registerRecovery(context.stateStagePath, stateStage);
    await syncReleaseSelectionDirectory(operationDir, "state-stage", hooksForTest);
    await symlink(compat.releasePath, context.linkStagePath);
    const linkStage = await captureSelectionAuthority(context.linkStagePath, "symlink");
    if (!linkStage || linkStage.linkTarget !== compat.releasePath) {
      throw await fail(
        `release selection link stage does not bind the requested target: ${context.linkStagePath}`,
        "RELEASE_SELECTION_TARGET_CHANGED",
      );
    }
    registerRecovery(context.linkStagePath, linkStage);
    await syncReleaseSelectionDirectory(operationDir, "link-stage", hooksForTest);
    await assertTarget();

    const isolate = async (
      canonicalPath: string,
      recoveryPath: string,
      authority: SelectionAuthority | null,
      phase: "state-isolation" | "link-isolation",
      beforeHook?: (context: ReleaseSelectionContext) => void | Promise<void>,
    ) => {
      await beforeHook?.(context);
      if (!authority) {
        if (await selectionPathPresent(canonicalPath)) {
          throw await fail(
            `release selection successor appeared before ${phase}: ${canonicalPath}`,
            "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
            undefined,
            { successorPreserved: true },
          );
        }
        return;
      }
      try {
        await assertSelectionAuthority(canonicalPath, authority);
      } catch (cause) {
        throw await fail(
          `release selection predecessor changed before ${phase}: ${canonicalPath}`,
          "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
          cause,
          { successorPreserved: true },
        );
      }
      try {
        await assertSelectionDirectories();
        await rename(canonicalPath, recoveryPath);
      } catch (cause) {
        throw await fail(`release selection ${phase} failed: ${canonicalPath}`, "RELEASE_SELECTION_ISOLATION_FAILED", cause);
      }
      mutationCommitted = true;
      registerCommit(recoveryPath);
      unregisterRecovery(canonicalPath);
      registerRecovery(recoveryPath, authority, true);
      await assertSelectionDirectories();
      let isolatedAuthority: SelectionAuthority;
      try {
        isolatedAuthority = await assertSelectionAuthority(recoveryPath, authority, { acrossLink: true });
      } catch (cause) {
        throw await fail(
          `release selection quarantine retained after ${phase} generation mismatch: ${recoveryPath}`,
          "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
          cause,
          { successorPreserved: true, stableCommittedPaths: [recoveryPath] },
        );
      }
      registerRecovery(recoveryPath, isolatedAuthority);
      await syncOrAmbiguous(path.dirname(canonicalPath), phase, recoveryPath);
      await syncOrAmbiguous(operationDir, phase, recoveryPath);
      try {
        await assertSelectionAuthority(recoveryPath, isolatedAuthority);
      } catch (cause) {
        throw await fail(
          `release selection quarantine changed after ${phase}: ${recoveryPath}`,
          "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
          cause,
          { successorPreserved: true, stableCommittedPaths: [recoveryPath] },
        );
      }
      if (await selectionPathPresent(canonicalPath)) {
        throw await fail(
          `release selection successor appeared during ${phase}: ${canonicalPath}`,
          "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
          undefined,
          { successorPreserved: true, stableCommittedPaths: [recoveryPath] },
        );
      }
    };

    await isolate(statePath, context.previousStatePath, previousState, "state-isolation", hooksForTest?.beforeStateIsolation);
    await isolate(linkPath, context.previousLinkPath, previousLink, "link-isolation", hooksForTest?.beforeLinkIsolation);
    await assertTarget();

    await hooksForTest?.beforeLinkPublication?.(context);
    try {
      await assertSelectionDirectories();
      // POSIX symlink creation is itself exclusive. Publishing a fresh symlink
      // at the absent canonical path avoids rename-overwrite semantics, while
      // the staged symlink remains immutable recovery evidence. Hard-linking a
      // symlink is not portable (macOS rejects it with EPERM).
      await symlink(compat.releasePath, linkPath);
    } catch (cause) {
      if (errnoCode(cause) === "EEXIST") {
        throw await fail(
          `release selection link successor preserved: ${linkPath}`,
          "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
          cause,
          { successorPreserved: true },
        );
      }
      throw await fail(`release selection link publication failed: ${linkPath}`, "RELEASE_SELECTION_PUBLICATION_FAILED", cause);
    }
    mutationCommitted = true;
    registerCommit(linkPath);
    await assertSelectionDirectories();
    let publishedLink: SelectionAuthority | null = null;
    try {
      publishedLink = await captureSelectionAuthority(linkPath, "symlink");
    } catch (cause) {
      throw await fail(
        `release selection link was replaced during publication: ${linkPath}`,
        "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
        cause,
        { successorPreserved: true, stableCommittedPaths: [context.linkStagePath] },
      );
    }
    if (!publishedLink || publishedLink.linkTarget !== compat.releasePath) {
      throw await fail(
        `release selection link does not bind the requested target: ${linkPath}`,
        "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
        undefined,
        { successorPreserved: true, stableCommittedPaths: [context.linkStagePath] },
      );
    }
    registerRecovery(linkPath, publishedLink);
    await hooksForTest?.afterLinkPublication?.(context);
    try {
      await assertSelectionAuthority(linkPath, publishedLink);
    } catch (cause) {
      throw await fail(
        `release selection link was replaced after publication: ${linkPath}`,
        "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
        cause,
        { successorPreserved: true, stableCommittedPaths: [context.linkStagePath] },
      );
    }
    await syncOrAmbiguous(path.dirname(linkPath), "link-publication", linkPath);
    await assertTarget();
    try {
      await assertSelectionAuthority(linkPath, publishedLink);
    } catch (cause) {
      throw await fail(
        `release selection link changed before state commit: ${linkPath}`,
        "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
        cause,
        { successorPreserved: true, stableCommittedPaths: [context.linkStagePath] },
      );
    }

    await hooksForTest?.beforeStatePublication?.(context);
    try {
      await assertSelectionDirectories();
      await link(context.stateStagePath, statePath);
    } catch (cause) {
      if (errnoCode(cause) === "EEXIST") {
        throw await fail(
          `release selection state successor preserved: ${statePath}`,
          "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
          cause,
          { successorPreserved: true, stableCommittedPaths: [linkPath] },
        );
      }
      throw await fail(`release selection state publication failed: ${statePath}`, "RELEASE_SELECTION_PUBLICATION_FAILED", cause);
    }
    registerCommit(statePath);
    await assertSelectionDirectories();
    let publishedState: SelectionAuthority;
    let linkedStateStage: SelectionAuthority;
    try {
      publishedState = await assertSelectionAuthority(statePath, stateStage, { acrossLink: true });
      linkedStateStage = await assertSelectionAuthority(context.stateStagePath, publishedState, { acrossLink: true });
      registerRecovery(statePath, publishedState);
      registerRecovery(context.stateStagePath, linkedStateStage);
    } catch (cause) {
      throw await fail(
        `release selection state publication could not be bound to its stage: ${statePath}`,
        "RELEASE_SELECTION_COMMITTED_INCONSISTENT",
        cause,
        { stableCommittedPaths: [linkPath] },
      );
    }
    await hooksForTest?.afterStatePublication?.(context);
    try {
      await assertSelectionAuthority(statePath, publishedState);
      await assertSelectionAuthority(context.stateStagePath, linkedStateStage);
    } catch (cause) {
      throw await fail(
        `release selection state was replaced after publication: ${statePath}`,
        "RELEASE_SELECTION_SUCCESSOR_PRESERVED",
        cause,
        { successorPreserved: true, stableCommittedPaths: [context.stateStagePath, linkPath] },
      );
    }
    await syncOrAmbiguous(stateDir, "state-publication", statePath);
    await syncOrAmbiguous(operationDir, "selection-complete", operationDir);
    await assertTarget();

    try {
      await assertSelectionAuthority(linkPath, publishedLink);
      await assertSelectionAuthority(statePath, publishedState);
      await assertSelectionAuthority(context.stateStagePath, linkedStateStage);
      const publishedSelector = await readReleaseSelectorState(statePath);
      const publishedTarget = await readExactReleaseLinkTarget(linkPath);
      if (
        publishedSelector.releaseId !== releaseId
        || typeof publishedSelector.releasePath !== "string"
        || path.resolve(publishedSelector.releasePath) !== publishedTarget
        || publishedTarget !== path.resolve(compat.releasePath)
      ) {
        throw new Error("published release selection does not bind the requested target");
      }
    } catch (cause) {
      throw await fail(
        `release selection committed with inconsistent state/link binding: ${statePath}; ${linkPath}`,
        "RELEASE_SELECTION_COMMITTED_INCONSISTENT",
        cause,
        { stableCommittedPaths: [statePath, linkPath] },
      );
    }

    const operationAuthority = await captureSelectionAuthority(operationDir, "directory");
    if (!operationAuthority) {
      throw await fail(
        `release selection operation generation disappeared before completion: ${operationDir}`,
        "RELEASE_SELECTION_COMMITTED_INCONSISTENT",
      );
    }
    registerRecovery(operationDir, operationAuthority);
    const successEvidence = await releaseSelectionRecoveryEvidence(context, recoveryBindings);
    if (
      !successEvidence.recoveryPaths.includes(operationDir)
      || !successEvidence.recoveryPaths.includes(context.stateStagePath)
      || !successEvidence.recoveryPaths.includes(context.linkStagePath)
      || !successEvidence.recoveryPaths.includes(statePath)
      || !successEvidence.recoveryPaths.includes(linkPath)
    ) {
      throw await fail(
        `release selection recovery evidence changed before completion: ${operationDir}`,
        "RELEASE_SELECTION_COMMITTED_INCONSISTENT",
      );
    }
    callbackSucceeded = true;
    return {
      selector,
      metadata: compat.metadata,
      compatibility: compat,
      committed: true,
      committedPath: statePath,
      ...successEvidence,
    };
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && Array.isArray((error as { recoveryPaths?: unknown }).recoveryPaths)
      ) {
        throw error;
      }
      throw await fail(
        mutationCommitted
          ? `release selection committed with ambiguous recovery state: ${statePath}; ${linkPath}`
          : `release selection failed; private generation retained for recovery: ${operationDir}`,
        mutationCommitted
          ? "RELEASE_SELECTION_COMMITTED_AMBIGUOUS"
          : "RELEASE_SELECTION_RECOVERY_REQUIRED",
        error,
      );
    }
    });
  });
  } catch (error) {
    const metadata = releaseSelectionFailureMetadata(error);
    if (metadata) {
      if (error && typeof error === "object") Object.assign(error, metadata);
      throw error;
    }
    if (callbackSucceeded && activeContext) {
      const evidence = activeRecoveryBindings
        ? await releaseSelectionRecoveryEvidence(activeContext, activeRecoveryBindings)
        : {
            recoveryPaths: [] as string[],
            attemptedPaths: selectionPaths(activeContext),
            originalEvidence: "unknown" as const,
          };
      const verifiedCommittedPath = activeCommittedCandidates.find((candidate) => (
        evidence.recoveryPaths.includes(candidate)
      ));
      throw releaseSelectionError(
        `release selection committed but lock release durability is ambiguous: ${statePath}; ${linkPath}`,
        verifiedCommittedPath
          ? "RELEASE_SELECTION_COMMITTED_DURABILITY_AMBIGUOUS"
          : "RELEASE_SELECTION_COMMITTED_AMBIGUOUS",
        activeContext,
        {
          cause: error,
          committed: true,
          ...(verifiedCommittedPath ? { committedPath: verifiedCommittedPath } : {}),
          ...evidence,
        },
      );
    }
    throw error;
  }
}

// ── release-gc ──
import { listJobs } from "../job/job-store.js";

type ReleaseQuarantineHooks = {
  beforeRename?: (context: { installedPath: string }) => void | Promise<void>;
  afterRename?: (context: { installedPath: string; quarantinePath: string }) => void | Promise<void>;
  beforeFinalGenerationCheck?: (context: { installedPath: string; quarantinePath: string }) => void | Promise<void>;
  syncDirectory?: (context: {
    directory: string;
    phase: "quarantine-root" | "canonical-isolation" | "quarantine-isolation";
  }) => void | Promise<void>;
};

async function quarantineReleaseDirectory(
  releaseStoreRoot: string,
  installedPath: string,
  releaseId: string,
  hooks: ReleaseQuarantineHooks = {},
) {
  const canonical = path.resolve(installedPath);
  const storeRoot = path.resolve(releaseStoreRoot);
  validateReleaseId(releaseId);
  if (canonical !== releasePath(storeRoot, releaseId)) {
    throw Object.assign(new Error(`release GC source is not the canonical store entry: ${canonical}`), {
      code: "RELEASE_GC_SOURCE_UNSAFE",
      committed: false,
      originalEvidence: "unknown",
      attemptedPaths: { canonical },
    });
  }

  const storeAuthority = await captureStrictDirectoryAuthority(storeRoot, "RELEASE_GC_QUARANTINE_UNSAFE");
  const quarantineRoot = path.join(storeRoot, ".gc-quarantine");
  try {
    await mkdir(quarantineRoot, { recursive: false, mode: 0o700 });
  } catch (cause) {
    if (errnoCode(cause) !== "EEXIST") {
      throw Object.assign(new Error(`release GC quarantine root cannot be created safely: ${quarantineRoot}`, { cause }), {
        code: "RELEASE_GC_QUARANTINE_UNSAFE",
        committed: false,
        originalEvidence: "unknown",
        attemptedPaths: { canonical },
      });
    }
  }
  const quarantineAuthority = await captureStrictDirectoryAuthority(quarantineRoot, "RELEASE_GC_QUARANTINE_UNSAFE");
  await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_GC_QUARANTINE_UNSAFE");
  await verifyStrictDirectoryAuthority(quarantineAuthority, "RELEASE_GC_QUARANTINE_UNSAFE");
  await hooks.syncDirectory?.({ directory: storeRoot, phase: "quarantine-root" });
  await fsyncDirectory(storeRoot);

  const beforeInfo = await lstat(canonical, { bigint: true });
  const sourceKind = beforeInfo.isSymbolicLink()
    ? "symlink"
    : beforeInfo.isDirectory()
      ? "directory"
      : null;
  if (!sourceKind) {
    throw Object.assign(new Error(`release GC source must be a directory or committed pointer: ${canonical}`), {
      code: "RELEASE_GC_SOURCE_UNSAFE",
      committed: false,
      originalEvidence: "unknown",
      attemptedPaths: { canonical },
    });
  }
  const expected = await captureSelectionAuthority(canonical, sourceKind);
  if (!expected) {
    throw Object.assign(new Error(`release GC source disappeared before isolation: ${canonical}`), {
      code: "RELEASE_GC_SOURCE_CHANGED",
      committed: false,
      originalEvidence: "unknown",
      attemptedPaths: { canonical },
    });
  }
  let sourceTreeAuthority: ReleaseTreeBinding[] | null = null;
  let pointerTargetAuthority: ReleasePointerTargetBinding | null = null;
  try {
    if (sourceKind === "directory") {
      sourceTreeAuthority = await captureReleaseGenerationTree(canonical);
    } else {
      pointerTargetAuthority = await captureReleasePointerTargetBinding(
        storeRoot,
        releaseId,
        canonical,
        expected,
      );
    }
  } catch (cause) {
    throw Object.assign(new Error(`release GC source binding is unavailable: ${canonical}`, { cause }), {
      code: "RELEASE_GC_SOURCE_CHANGED",
      committed: false,
      originalEvidence: "unknown",
      attemptedPaths: { canonical },
    });
  }
  const assertOriginalAt = async (
    candidatePath: string,
    authority: SelectionAuthority,
    { acrossRename = false }: { acrossRename?: boolean } = {},
  ) => {
    await assertSelectionAuthority(candidatePath, authority, { acrossLink: acrossRename });
    if (sourceTreeAuthority) {
      await verifyReleaseGenerationTree(candidatePath, sourceTreeAuthority, {
        expectedRoot: canonical,
        rootAcrossRename: acrossRename || candidatePath !== canonical,
      });
    }
    if (pointerTargetAuthority) {
      await verifyReleasePointerTargetBinding(pointerTargetAuthority);
    }
  };
  await hooks.beforeRename?.({ installedPath: canonical });
  try {
    await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_GC_SOURCE_CHANGED");
    await verifyStrictDirectoryAuthority(quarantineAuthority, "RELEASE_GC_SOURCE_CHANGED");
    await assertOriginalAt(canonical, expected);
  } catch (cause) {
    throw Object.assign(new Error(`release GC source changed before isolation: ${canonical}`), {
      code: "RELEASE_GC_SOURCE_CHANGED",
      committed: false,
      successorPreserved: true,
      originalEvidence: "unknown",
      attemptedPaths: { canonical },
      cause,
    });
  }

  // Generate the private destination only after all caller-controlled hooks
  // have completed, then invoke rename without another asynchronous gap. This
  // keeps the non-portable rename-overwrite surface limited to an unguessable
  // UUID rather than exposing the destination during the verification window.
  const quarantinePath = path.join(quarantineRoot, `${releaseId}-${Date.now()}-${randomUUID()}`);
  try {
    await rename(canonical, quarantinePath);
  } catch (cause) {
    let sourceVerified = false;
    try {
      await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_GC_SOURCE_CHANGED");
      await verifyStrictDirectoryAuthority(quarantineAuthority, "RELEASE_GC_SOURCE_CHANGED");
      await assertOriginalAt(canonical, expected);
      sourceVerified = true;
    } catch {}
    throw Object.assign(new Error(`release GC source could not be isolated: ${canonical}`, { cause }), {
      code: "RELEASE_GC_ISOLATION_FAILED",
      committed: false,
      originalEvidence: sourceVerified ? "verified" : "unknown",
      ...(sourceVerified ? { recoveryPaths: { canonical } } : {}),
      attemptedPaths: { canonical, quarantine: quarantinePath },
    });
  }
  const committedQuarantineFailure = async (
    message: string,
    cause: unknown,
    authority: SelectionAuthority,
    {
      acrossRename = false,
      verifiedCode = "RELEASE_GC_QUARANTINE_PRESERVED",
    }: { acrossRename?: boolean; verifiedCode?: string } = {},
  ) => {
    let quarantineVerified = false;
    try {
      await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_GC_QUARANTINE_PRESERVED");
      await verifyStrictDirectoryAuthority(quarantineAuthority, "RELEASE_GC_QUARANTINE_PRESERVED");
      await assertOriginalAt(quarantinePath, authority, { acrossRename });
      quarantineVerified = true;
    } catch {
      // A committed rename occurred, but the attempted quarantine pathname no
      // longer proves where the original release resides.
    }
    return Object.assign(new Error(message, { cause }), {
      code: quarantineVerified
        ? verifiedCode
        : "RELEASE_GC_QUARANTINE_COMMITTED_AMBIGUOUS",
      committed: true,
      ...(quarantineVerified ? { committedPath: quarantinePath } : {}),
      quarantinePreserved: quarantineVerified,
      originalEvidence: quarantineVerified ? "verified" : "unknown",
      ...(quarantineVerified ? { recoveryPaths: { quarantine: quarantinePath } } : {}),
      attemptedPaths: { canonical, quarantine: quarantinePath },
    });
  };
  let moved: SelectionAuthority;
  try {
    await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_GC_QUARANTINE_PRESERVED");
    await verifyStrictDirectoryAuthority(quarantineAuthority, "RELEASE_GC_QUARANTINE_PRESERVED");
    await assertOriginalAt(quarantinePath, expected, { acrossRename: true });
    moved = await assertSelectionAuthority(quarantinePath, expected, { acrossLink: true });
  } catch (cause) {
    throw await committedQuarantineFailure(
      `release GC quarantine state is ambiguous after verification failure: ${quarantinePath}`,
      cause,
      expected,
      { acrossRename: true },
    );
  }

  try {
    await hooks.afterRename?.({ installedPath: canonical, quarantinePath });
    await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_GC_QUARANTINE_PRESERVED");
    await verifyStrictDirectoryAuthority(quarantineAuthority, "RELEASE_GC_QUARANTINE_PRESERVED");
    await assertOriginalAt(quarantinePath, moved, { acrossRename: true });
  } catch (cause) {
    throw await committedQuarantineFailure(
      `release GC quarantine state is ambiguous after isolation: ${quarantinePath}`,
      cause,
      moved,
    );
  }
  try {
    await hooks.syncDirectory?.({ directory: storeRoot, phase: "canonical-isolation" });
    await fsyncDirectory(storeRoot);
    await hooks.syncDirectory?.({ directory: quarantineRoot, phase: "quarantine-isolation" });
    await fsyncDirectory(quarantineRoot);
  } catch (cause) {
    throw await committedQuarantineFailure(
      `release GC isolation committed with ambiguous durability: ${quarantinePath}`,
      cause,
      moved,
      { verifiedCode: "RELEASE_GC_QUARANTINE_COMMITTED_DURABILITY_AMBIGUOUS" },
    );
  }
  try {
    await hooks.beforeFinalGenerationCheck?.({ installedPath: canonical, quarantinePath });
    await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_GC_QUARANTINE_PRESERVED");
    await verifyStrictDirectoryAuthority(quarantineAuthority, "RELEASE_GC_QUARANTINE_PRESERVED");
    await assertOriginalAt(quarantinePath, moved, { acrossRename: true });
  } catch (cause) {
    throw await committedQuarantineFailure(
      `release GC quarantine state is ambiguous after final verification failure: ${quarantinePath}`,
      cause,
      moved,
    );
  }

  if (await selectionPathPresent(canonical)) {
    try {
      await verifyStrictDirectoryAuthority(storeAuthority, "RELEASE_GC_QUARANTINE_PRESERVED");
      await verifyStrictDirectoryAuthority(quarantineAuthority, "RELEASE_GC_QUARANTINE_PRESERVED");
      await assertOriginalAt(quarantinePath, moved, { acrossRename: true });
    } catch (cause) {
      throw await committedQuarantineFailure(
        `release GC canonical successor exists but original quarantine location is ambiguous: ${canonical}`,
        cause,
        moved,
      );
    }
    throw Object.assign(new Error(`release GC canonical successor preserved after isolation: ${canonical}`), {
      code: "RELEASE_GC_SUCCESSOR_PRESERVED",
      committed: true,
      committedPath: quarantinePath,
      quarantinePreserved: true,
      successorPreserved: true,
      originalEvidence: "verified",
      recoveryPaths: { quarantine: quarantinePath },
      attemptedPaths: { canonical, quarantine: quarantinePath },
      successorPaths: { canonical },
    });
  }
  return quarantinePath;
}

export const _quarantineReleaseDirectoryForTests = quarantineReleaseDirectory;

function collectReleasePins(jobs: ReleaseJobRecord[]) {
  const pins = new Map<string, ReleasePin[]>();
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

async function collectProcessEvidence(cpbRoot: string, jobs: ReleaseJobRecord[]) {
  // Lease records only reference jobs, and collectReleasePins already protects
  // every release selected by those jobs. Re-reading lease files here added no
  // independent authority while exposing GC planning to unsafe path reads.
  const processReleaseIds = new Set<string>();

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
  return processReleaseIds;
}

export async function buildReleaseGcPlan({ cpbRoot, env = process.env, destRoot }: ReleaseGcOptions = {}): Promise<ReleaseGcPlan> {
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  const releaseList = await listReleases({ destRoot, env });
  const currentReleaseId = releaseList.current;

  let jobs;
  try {
    jobs = await listJobs(resolvedCpbRoot);
  } catch (err) {
    throw new Error(`Cannot build release GC plan: failed to read job inventory: ${err.message}`);
  }

  const jobPins = collectReleasePins(jobs);
  const processReleaseIds = await collectProcessEvidence(resolvedCpbRoot, jobs);

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
      const committed = await resolveCommittedRelease(storeRoot, releaseId);
      if (committed.canonicalPath !== resolvedInstalled) {
        reasons.push("canonical_path_mismatch");
        classification = "unsafe";
      }
    } catch {
      reasons.push("missing");
      classification = "unsafe";
    }

    const jobPin = jobPins.get(releaseId);
    if (jobPin) {
      const activeJobs = jobPin.filter((j) => !["completed", "failed", "blocked", "cancelled"].includes(j.status || ""));
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

  return {
    releaseStoreRoot: storeRoot,
    currentReleaseId,
    candidates,
    generatedAt: new Date().toISOString(),
  };
}

export async function executeReleaseGc(plan: ReleaseGcPlan, { destRoot, env = process.env, cpbRoot }: ReleaseGcOptions = {}): Promise<ReleaseGcResult> {
  const eligible = plan.candidates.filter((c) => c.classification === "eligible");
  const protected_ = plan.candidates.filter((c) => c.classification === "protected");
  const unsafe = plan.candidates.filter((c) => c.classification === "unsafe");

  const deleted = [];
  const quarantined = [];
  const skipped = [];
  const refused = [];

  const currentSelection = await inspectCurrentRelease({ env });
  const currentReleaseId = currentSelection?.metadata?.releaseId || currentSelection?.selector?.releaseId || plan.currentReleaseId || null;
  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });

  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  let liveJobPins;
  try {
    const jobs = await listJobs(resolvedCpbRoot);
    liveJobPins = collectReleasePins(jobs);
  } catch (err) {
    return {
      deleted: [],
      quarantined: [],
      skipped: protected_.map((c) => ({ ...c, skipReason: "protected" })),
      refused: [
        ...eligible.map((c) => ({ ...c, refusalReason: `job_inventory_unreadable: ${errorMessage(err)}` })),
        ...unsafe.map((c) => ({ ...c, refusalReason: "unsafe" })),
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

    let committedRelease: CommittedRelease;
    try {
      committedRelease = await resolveCommittedRelease(storeRoot, candidate.releaseId);
    } catch {
      refused.push({ ...candidate, refusalReason: "metadata_invalid_revalidated" });
      continue;
    }
    const liveMetadata = committedRelease.metadata;
    if (liveMetadata.releaseId !== candidate.releaseId) {
      refused.push({ ...candidate, refusalReason: `manifest_release_id_mismatch: expected '${candidate.releaseId}' found '${liveMetadata.releaseId}'` });
      continue;
    }

    // retain: dynamic field access — inspectCurrentRelease's typed shape omits linkTarget,
    // but defensively probe for it before falling back to selector.releasePath (runtime-identical).
    const currentSelectionWithLink = currentSelection as (typeof currentSelection & { linkTarget?: string | null });
    const currentReleasePath = currentSelectionWithLink?.linkTarget || currentSelection?.selector?.releasePath;
    if (
      currentReleasePath
      && (
        committedRelease.canonicalPath === path.resolve(currentReleasePath)
        || committedRelease.resolvedPath === path.resolve(currentReleasePath)
      )
    ) {
      refused.push({ ...candidate, refusalReason: "path_matches_current_release_revalidated" });
      continue;
    }

    try {
      const resolvedPath = path.resolve(candidate.installedPath);
      if (!resolvedPath.startsWith(storeRoot + path.sep) && resolvedPath !== storeRoot) {
        refused.push({ ...candidate, refusalReason: "path_escape_verified" });
        continue;
      }
      if (resolvedPath !== committedRelease.canonicalPath) {
        refused.push({ ...candidate, refusalReason: "canonical_path_mismatch_revalidated" });
        continue;
      }
      const quarantinePath = await quarantineReleaseDirectory(storeRoot, resolvedPath, candidate.releaseId);
      quarantined.push({
        ...candidate,
        quarantinePath,
        originalEvidence: "verified",
        recoveryPaths: { quarantine: quarantinePath },
        attemptedPaths: { canonical: resolvedPath, quarantine: quarantinePath },
      });
    } catch (err) {
      const failure = isRecord(err) ? err : null;
      const recovery = failure && isRecord(failure.recoveryPaths)
        ? failure.recoveryPaths
        : null;
      const attempted = failure && isRecord(failure.attemptedPaths)
        ? failure.attemptedPaths
        : null;
      const successor = failure && isRecord(failure.successorPaths)
        ? failure.successorPaths
        : null;
      refused.push({
        ...candidate,
        refusalReason: `isolation_failed: ${errorMessage(err)}`,
        ...(recovery && typeof recovery.quarantine === "string"
          ? {
            quarantinePath: recovery.quarantine,
            recoveryPaths: { quarantine: recovery.quarantine },
          }
          : {}),
        ...(attempted && typeof attempted.canonical === "string"
          ? {
            attemptedPaths: {
              canonical: attempted.canonical,
              ...(typeof attempted.quarantine === "string" ? { quarantine: attempted.quarantine } : {}),
            },
          }
          : {}),
        ...(successor && typeof successor.canonical === "string"
          ? { successorPaths: { canonical: successor.canonical } }
          : {}),
        ...(failure?.originalEvidence === "verified" || failure?.originalEvidence === "unknown"
          ? { originalEvidence: failure.originalEvidence }
          : {}),
      });
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
    quarantined,
    skipped,
    refused,
    executedAt: new Date().toISOString(),
  };
}

export function formatGcPlanHuman(plan: ReleaseGcPlan) {
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

export function formatGcResultHuman(result: ReleaseGcResult) {
  const lines = [];
  lines.push("Release GC Result:");
  lines.push(`  Deleted: ${result.deleted.length}`);
  for (const d of result.deleted) lines.push(`    - ${d.releaseId}`);
  lines.push(`  Quarantined (recoverable): ${result.quarantined.length}`);
  for (const q of result.quarantined) lines.push(`    - ${q.releaseId}: ${q.quarantinePath}`);
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
    const manifest = await readReleaseMetadata(manifestPath);
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
