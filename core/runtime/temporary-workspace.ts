import { AsyncLocalStorage } from "node:async_hooks";
import { execFile as execFileCb } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  sameWorktreeDirectoryIdentity,
  type WorktreeDirectoryIdentity,
} from "../contracts/worktree-ownership.js";

const execFile = promisify(execFileCb);
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_AUTHORITY_FILE_BYTES = 1024 * 1024;
const TEMPORARY_WORKSPACE_VERSION = 1 as const;

type DirectoryAuthority = {
  path: string;
  label: string;
  identity: WorktreeDirectoryIdentity;
  handle: Awaited<ReturnType<typeof open>>;
};

export type FileIdentity = WorktreeDirectoryIdentity & {
  size: string;
  mtimeNs: string;
};

type FileAuthority = {
  path: string;
  label: string;
  state: "missing";
} | {
  path: string;
  label: string;
  state: "file";
  identity: FileIdentity;
  sha256: string;
  handle: Awaited<ReturnType<typeof open>>;
};

export type GitWorktreeRegistration = {
  worktree: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: string | null;
  prunable: string | null;
};

type GitBinding = {
  worktree: DirectoryAuthority;
  admin: DirectoryAuthority;
  adminParent: DirectoryAuthority;
  worktreeGitFile: FileAuthority;
  adminGitdir: FileAuthority;
  adminCommondir: FileAuthority;
  adminHead: FileAuthority;
  adminConfig: FileAuthority;
  registration: GitWorktreeRegistration;
  expectedHead: string;
};

type WorkspaceState = {
  workspaceKind: "directory" | "git_worktree";
  rootPath: string;
  worktreePath: string | null;
  parent: DirectoryAuthority;
  root: DirectoryAuthority;
  gitBase: {
    source: DirectoryAuthority;
    common: DirectoryAuthority;
    commonConfig: FileAuthority;
  } | null;
  git: GitBinding | null;
  gitCoordinates: { sourcePath: string; commonDir: string; adminDir?: string } | null;
  env: NodeJS.ProcessEnv;
  hooks: TemporaryWorkspaceHooks;
  cleanupPromise: Promise<TemporaryWorkspaceCleanupProof> | null;
};

export type TemporaryWorkspaceRecoveryPaths = {
  canonicalRoot: string;
  canonicalWorktree?: string;
  quarantineContainer?: string;
  quarantineRoot?: string;
  quarantineWorktree?: string;
  source?: string;
  commonDir?: string;
  gitAdminDir?: string;
  quarantineGitAdminDir?: string;
};

export type TemporaryWorkspaceAuthorityEvidence = {
  parent: TemporaryWorkspaceDirectoryAuthorityEvidence;
  root: TemporaryWorkspaceDirectoryAuthorityEvidence;
  worktree?: TemporaryWorkspaceDirectoryAuthorityEvidence;
  source?: TemporaryWorkspaceDirectoryAuthorityEvidence;
  commonDir?: TemporaryWorkspaceDirectoryAuthorityEvidence;
  commonConfig?: TemporaryWorkspaceFileAuthorityEvidence;
  gitAdmin?: TemporaryWorkspaceDirectoryAuthorityEvidence;
  gitAdminParent?: TemporaryWorkspaceDirectoryAuthorityEvidence;
  gitFiles?: {
    worktreeGitFile: TemporaryWorkspaceFileAuthorityEvidence;
    adminGitdir: TemporaryWorkspaceFileAuthorityEvidence;
    adminCommondir: TemporaryWorkspaceFileAuthorityEvidence;
    adminHead: TemporaryWorkspaceFileAuthorityEvidence;
    adminConfig: TemporaryWorkspaceFileAuthorityEvidence;
  };
  registration?: GitWorktreeRegistration;
  dispositions: {
    parent: "preserved_unmodified";
    root: "canonical_retained" | "quarantined";
    worktree?: "canonical_retained" | "quarantined_with_root";
    source?: "preserved_unmodified";
    commonDir?: "preserved_unmodified";
    commonConfig?: "preserved_unmodified";
    gitAdmin?: "active" | "quarantined" | "unknown";
    gitAdminParent?: "preserved_unmodified";
  };
};

export type TemporaryWorkspaceDirectoryAuthorityEvidence = {
  path: string;
  identity: WorktreeDirectoryIdentity;
};

export type TemporaryWorkspaceFileAuthorityEvidence = {
  path: string;
  state: "missing" | "file";
  identity: FileIdentity | null;
  sha256: string | null;
};

export type TemporaryWorkspaceGitAdminDisposition = "not_applicable" | "active" | "quarantined" | "unknown";

export type TemporaryWorkspaceCleanupProof = {
  version: typeof TEMPORARY_WORKSPACE_VERSION;
  kind: "temporary_workspace_disposition";
  code: "TEMPORARY_WORKSPACE_QUARANTINED";
  message: string;
  workspaceKind: "directory" | "git_worktree";
  disposition: "quarantined";
  ok: true;
  cleanupVerified: true;
  committed: true;
  creationCommitted: boolean | null;
  canonicalPathRemoved: true;
  quarantinePreserved: true;
  successorPreserved: false;
  gitMetadataRetained: boolean;
  gitRegistrationActive: false | null;
  gitAdminMetadataDisposition: TemporaryWorkspaceGitAdminDisposition;
  gitAdminQuarantinePreserved: boolean | null;
  cleanupDeferred: true;
  recoveryPaths: TemporaryWorkspaceRecoveryPaths;
  authority: TemporaryWorkspaceAuthorityEvidence;
  completedAt: string;
};

export type TemporaryWorkspaceErrorDetails = {
  version: typeof TEMPORARY_WORKSPACE_VERSION;
  kind: "temporary_workspace_recovery";
  code: string;
  message: string;
  ok: false;
  workspaceKind: "directory" | "git_worktree";
  disposition: "retained" | "quarantined";
  cleanupVerified: boolean;
  committed: boolean;
  creationCommitted: boolean | null;
  canonicalPathRemoved: boolean | null;
  quarantinePreserved: boolean;
  successorPreserved: boolean | null;
  gitMetadataRetained: boolean;
  gitRegistrationActive: boolean | null;
  gitAdminMetadataDisposition: TemporaryWorkspaceGitAdminDisposition;
  gitAdminQuarantinePreserved: boolean | null;
  cleanupDeferred: true;
  recoveryPaths: TemporaryWorkspaceRecoveryPaths;
  authority: TemporaryWorkspaceAuthorityEvidence;
};

export type TemporaryWorkspaceRecovery = TemporaryWorkspaceCleanupProof | TemporaryWorkspaceErrorDetails;

export type TemporaryWorkspace = {
  rootPath: string;
  cleanup: () => Promise<TemporaryWorkspaceCleanupProof>;
};

export type TemporaryGitWorktree = TemporaryWorkspace & {
  worktreePath: string;
  sourcePath: string;
  commonDir: string;
  expectedHead: string;
  gitEnv: NodeJS.ProcessEnv;
};

export type TemporaryWorkspaceHooks = {
  afterOwnershipValidated?: (context: {
    rootPath: string;
    worktreePath: string | null;
    quarantineRoot: string;
  }) => void | Promise<void>;
  afterQuarantineRename?: (context: {
    rootPath: string;
    worktreePath: string | null;
    quarantineRoot: string;
  }) => void | Promise<void>;
  beforeQuarantineDirectorySync?: (context: {
    rootPath: string;
    quarantineRoot: string;
    parentPath: string;
  }) => void | Promise<void>;
  afterGitAdminQuarantine?: (context: {
    rootPath: string;
    worktreePath: string;
    gitAdminDir: string;
    quarantineGitAdminDir: string;
  }) => void | Promise<void>;
  beforeGitAdminDirectorySync?: (context: {
    quarantineRoot: string;
    gitAdminParent: string;
    quarantineGitAdminDir: string;
  }) => void | Promise<void>;
};

const hookStorage = new AsyncLocalStorage<TemporaryWorkspaceHooks>();

export function _internalWithTemporaryWorkspaceHooks<T>(
  hooks: TemporaryWorkspaceHooks,
  run: () => T,
): T {
  return hookStorage.run(hooks, run);
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function statsIdentity(info: {
  dev: number | bigint;
  ino: number | bigint;
  birthtimeNs?: bigint;
  birthtimeMs: number | bigint;
  mode: number | bigint;
  uid: number | bigint;
  gid: number | bigint;
}): WorktreeDirectoryIdentity {
  const birthtimeNs = info.birthtimeNs === undefined
    ? (typeof info.birthtimeMs === "bigint"
      ? info.birthtimeMs * 1_000_000n
      : BigInt(Math.trunc(info.birthtimeMs * 1_000_000)))
    : info.birthtimeNs;
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(birthtimeNs),
    mode: String(info.mode),
    uid: String(info.uid),
    gid: String(info.gid),
  };
}

function fileIdentity(info: {
  dev: number | bigint;
  ino: number | bigint;
  birthtimeNs?: bigint;
  birthtimeMs: number | bigint;
  mtimeNs?: bigint;
  mtimeMs: number | bigint;
  mode: number | bigint;
  uid: number | bigint;
  gid: number | bigint;
  size: number | bigint;
}): FileIdentity {
  const mtimeNs = info.mtimeNs === undefined
    ? (typeof info.mtimeMs === "bigint"
      ? info.mtimeMs * 1_000_000n
      : BigInt(Math.trunc(info.mtimeMs * 1_000_000)))
    : info.mtimeNs;
  return {
    ...statsIdentity(info),
    size: String(info.size),
    mtimeNs: String(mtimeNs),
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity) {
  return sameWorktreeDirectoryIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function strictDirectoryFlags() {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw Object.assign(new Error("strict no-follow directory opens are unavailable"), {
      code: "TEMPORARY_WORKSPACE_AUTHORITY_UNAVAILABLE",
    });
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
}

function strictFileFlags() {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw Object.assign(new Error("strict no-follow file opens are unavailable"), {
      code: "TEMPORARY_WORKSPACE_AUTHORITY_UNAVAILABLE",
    });
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
}

async function openDirectoryAuthority(directoryInput: string, label: string): Promise<DirectoryAuthority> {
  const directory = path.resolve(directoryInput);
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw Object.assign(new Error(`${label} is not a real directory: ${directory}`), {
      code: "TEMPORARY_WORKSPACE_AUTHORITY_UNAVAILABLE",
    });
  }
  const canonical = await realpath(directory);
  if (canonical !== directory) {
    throw Object.assign(new Error(`${label} is not canonical: ${directory}`), {
      code: "TEMPORARY_WORKSPACE_AUTHORITY_UNAVAILABLE",
    });
  }
  const handle = await open(directory, strictDirectoryFlags());
  try {
    const descriptor = await handle.stat({ bigint: true });
    const after = await lstat(directory, { bigint: true });
    const expected = statsIdentity(before);
    if (
      !descriptor.isDirectory()
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !sameWorktreeDirectoryIdentity(expected, statsIdentity(descriptor))
      || !sameWorktreeDirectoryIdentity(expected, statsIdentity(after))
    ) {
      throw Object.assign(new Error(`${label} changed while being pinned: ${directory}`), {
        code: "TEMPORARY_WORKSPACE_AUTHORITY_UNAVAILABLE",
      });
    }
    return { path: directory, label, identity: expected, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readAuthorityFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  label: string,
) {
  if (size > MAX_AUTHORITY_FILE_BYTES) {
    throw Object.assign(new Error(`${label} exceeds the authority snapshot limit`), {
      code: "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
    });
  }
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(data, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) {
    throw Object.assign(new Error(`${label} changed while being read`), {
      code: "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
    });
  }
  return data;
}

async function openFileAuthority(filePathInput: string, label: string, optional = false): Promise<FileAuthority> {
  const filePath = path.resolve(filePathInput);
  let before;
  try {
    before = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (optional && errorCode(error) === "ENOENT") return { path: filePath, label, state: "missing" };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw Object.assign(new Error(`${label} is not a no-follow regular file: ${filePath}`), {
      code: "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
    });
  }
  const handle = await open(filePath, strictFileFlags());
  try {
    const descriptor = await handle.stat({ bigint: true });
    const after = await lstat(filePath, { bigint: true });
    const expected = fileIdentity(before);
    if (
      !descriptor.isFile()
      || !after.isFile()
      || after.isSymbolicLink()
      || !sameFileIdentity(expected, fileIdentity(descriptor))
      || !sameFileIdentity(expected, fileIdentity(after))
    ) {
      throw Object.assign(new Error(`${label} changed while being pinned: ${filePath}`), {
        code: "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
      });
    }
    const data = await readAuthorityFile(handle, Number(descriptor.size), label);
    return {
      path: filePath,
      label,
      state: "file",
      identity: expected,
      sha256: createHash("sha256").update(data).digest("hex"),
      handle,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function observePath(candidate: string): Promise<"missing" | "present" | "unavailable"> {
  try {
    await lstat(candidate);
    return "present";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "unavailable";
  }
}

function directoryAuthorityEvidence(authority: DirectoryAuthority): TemporaryWorkspaceDirectoryAuthorityEvidence {
  return { path: authority.path, identity: { ...authority.identity } };
}

function fileAuthorityEvidence(authority: FileAuthority): TemporaryWorkspaceFileAuthorityEvidence {
  return authority.state === "missing"
    ? { path: authority.path, state: "missing", identity: null, sha256: null }
    : {
        path: authority.path,
        state: "file",
        identity: { ...authority.identity },
        sha256: authority.sha256,
      };
}

function authorityEvidence(
  state: WorkspaceState,
  rootDisposition: "canonical_retained" | "quarantined",
  gitAdminDisposition: "active" | "quarantined" | "unknown",
): TemporaryWorkspaceAuthorityEvidence {
  const evidence: TemporaryWorkspaceAuthorityEvidence = {
    parent: directoryAuthorityEvidence(state.parent),
    root: directoryAuthorityEvidence(state.root),
    dispositions: {
      parent: "preserved_unmodified",
      root: rootDisposition,
    },
  };
  if (state.gitBase) {
    evidence.source = directoryAuthorityEvidence(state.gitBase.source);
    evidence.commonDir = directoryAuthorityEvidence(state.gitBase.common);
    evidence.commonConfig = fileAuthorityEvidence(state.gitBase.commonConfig);
    evidence.dispositions.source = "preserved_unmodified";
    evidence.dispositions.commonDir = "preserved_unmodified";
    evidence.dispositions.commonConfig = "preserved_unmodified";
  }
  if (state.git) {
    evidence.worktree = directoryAuthorityEvidence(state.git.worktree);
    evidence.gitAdmin = directoryAuthorityEvidence(state.git.admin);
    evidence.gitAdminParent = directoryAuthorityEvidence(state.git.adminParent);
    evidence.gitFiles = {
      worktreeGitFile: fileAuthorityEvidence(state.git.worktreeGitFile),
      adminGitdir: fileAuthorityEvidence(state.git.adminGitdir),
      adminCommondir: fileAuthorityEvidence(state.git.adminCommondir),
      adminHead: fileAuthorityEvidence(state.git.adminHead),
      adminConfig: fileAuthorityEvidence(state.git.adminConfig),
    };
    evidence.registration = { ...state.git.registration };
    evidence.dispositions.worktree = rootDisposition === "quarantined"
      ? "quarantined_with_root"
      : "canonical_retained";
    evidence.dispositions.gitAdmin = gitAdminDisposition;
    evidence.dispositions.gitAdminParent = "preserved_unmodified";
  } else if (state.workspaceKind === "git_worktree") {
    evidence.dispositions.gitAdmin = gitAdminDisposition;
  }
  return evidence;
}

function recoveryPaths(
  state: WorkspaceState,
  quarantineRoot?: string,
  quarantineGitAdminDir?: string,
  quarantineContainer?: string,
): TemporaryWorkspaceRecoveryPaths {
  const paths: TemporaryWorkspaceRecoveryPaths = { canonicalRoot: state.rootPath };
  if (state.worktreePath) paths.canonicalWorktree = state.worktreePath;
  if (quarantineContainer) paths.quarantineContainer = quarantineContainer;
  if (quarantineRoot) {
    paths.quarantineRoot = quarantineRoot;
    if (state.worktreePath) paths.quarantineWorktree = path.join(quarantineRoot, path.basename(state.worktreePath));
  }
  if (state.gitCoordinates) {
    paths.source = state.gitCoordinates.sourcePath;
    paths.commonDir = state.gitCoordinates.commonDir;
    if (state.gitCoordinates.adminDir) paths.gitAdminDir = state.gitCoordinates.adminDir;
  }
  if (quarantineGitAdminDir) paths.quarantineGitAdminDir = quarantineGitAdminDir;
  return paths;
}

function recoveryDetails(
  state: WorkspaceState,
  code: string,
  message: string,
  truth: {
    committed: boolean;
    creationCommitted?: boolean | null;
    canonicalPathRemoved?: boolean | null;
    quarantinePreserved?: boolean;
    successorPreserved?: boolean | null;
    quarantineContainer?: string;
    quarantineRoot?: string;
    quarantineGitAdminDir?: string;
    cleanupVerified?: boolean;
    gitRegistrationActive?: boolean | null;
    gitAdminMetadataDisposition?: TemporaryWorkspaceGitAdminDisposition;
    gitAdminQuarantinePreserved?: boolean | null;
  },
): TemporaryWorkspaceErrorDetails {
  const gitAdminMetadataDisposition = state.workspaceKind === "directory"
    ? "not_applicable"
    : (truth.gitAdminMetadataDisposition ?? (state.git ? "active" : "unknown"));
  return {
    version: TEMPORARY_WORKSPACE_VERSION,
    kind: "temporary_workspace_recovery",
    code,
    message,
    ok: false,
    workspaceKind: state.workspaceKind,
    disposition: truth.committed ? "quarantined" : "retained",
    cleanupVerified: truth.cleanupVerified ?? false,
    committed: truth.committed,
    creationCommitted: truth.creationCommitted ?? null,
    canonicalPathRemoved: truth.canonicalPathRemoved ?? (truth.committed ? null : false),
    quarantinePreserved: truth.quarantinePreserved ?? false,
    successorPreserved: truth.successorPreserved ?? null,
    gitMetadataRetained: state.workspaceKind === "git_worktree",
    gitRegistrationActive: state.workspaceKind === "directory"
      ? null
      : (truth.gitRegistrationActive ?? (state.git ? true : null)),
    gitAdminMetadataDisposition,
    gitAdminQuarantinePreserved: state.workspaceKind === "directory"
      ? null
      : (truth.gitAdminQuarantinePreserved ?? false),
    cleanupDeferred: true,
    recoveryPaths: recoveryPaths(
      state,
      truth.quarantineRoot,
      truth.quarantineGitAdminDir,
      truth.quarantineContainer,
    ),
    authority: authorityEvidence(
      state,
      truth.committed ? "quarantined" : "canonical_retained",
      gitAdminMetadataDisposition === "not_applicable" ? "unknown" : gitAdminMetadataDisposition,
    ),
  };
}

function workspaceError(
  state: WorkspaceState,
  code: string,
  message: string,
  truth: Parameters<typeof recoveryDetails>[3],
  cause?: unknown,
) {
  const details = recoveryDetails(state, code, message, truth);
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    details,
    { temporaryWorkspaceRecovery: details },
  );
}

export function temporaryWorkspaceErrorDetails(value: unknown): TemporaryWorkspaceRecovery | null {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): TemporaryWorkspaceRecovery | null => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return null;
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (
      record.version === TEMPORARY_WORKSPACE_VERSION
      && (record.kind === "temporary_workspace_disposition" || record.kind === "temporary_workspace_recovery")
      && record.recoveryPaths
    ) {
      return candidate as TemporaryWorkspaceRecovery;
    }
    const direct = visit(record.temporaryWorkspaceRecovery);
    if (direct) return direct;
    if (candidate instanceof AggregateError) {
      for (const entry of candidate.errors) {
        const nested = visit(entry);
        if (nested) return nested;
      }
    }
    return visit(record.cause);
  };
  return visit(value);
}

async function validateDirectoryAuthorityAt(
  authority: DirectoryAuthority,
  currentPath: string,
  state: WorkspaceState,
) {
  let descriptor;
  let current;
  try {
    descriptor = await authority.handle.stat({ bigint: true });
    current = await lstat(currentPath, { bigint: true });
  } catch (cause) {
    const successorPreserved = await observePath(currentPath) === "present";
    throw workspaceError(
      state,
      "TEMPORARY_WORKSPACE_OWNERSHIP_CONFLICT",
      `${authority.label} authority became unavailable: ${currentPath}`,
      { committed: false, successorPreserved },
      cause,
    );
  }
  let canonical = "";
  try {
    canonical = await realpath(currentPath);
  } catch {
    canonical = "";
  }
  if (
    !descriptor.isDirectory()
    || !current.isDirectory()
    || current.isSymbolicLink()
    || canonical !== currentPath
    || !sameWorktreeDirectoryIdentity(authority.identity, statsIdentity(descriptor))
    || !sameWorktreeDirectoryIdentity(authority.identity, statsIdentity(current))
  ) {
    throw workspaceError(
      state,
      "TEMPORARY_WORKSPACE_OWNERSHIP_CONFLICT",
      `${authority.label} no longer matches its create-time authority: ${currentPath}`,
      { committed: false, successorPreserved: true },
    );
  }
}

async function validateFileAuthority(
  authority: FileAuthority,
  state: WorkspaceState,
  currentPath = authority.path,
) {
  if (authority.state === "missing") {
    if (await observePath(currentPath) !== "missing") {
      throw workspaceError(
        state,
        "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
        `${authority.label} appeared after worktree creation: ${currentPath}`,
        { committed: false, successorPreserved: true },
      );
    }
    return;
  }
  let descriptor;
  let current;
  try {
    descriptor = await authority.handle.stat({ bigint: true });
    current = await lstat(currentPath, { bigint: true });
  } catch (cause) {
    throw workspaceError(
      state,
      "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
      `${authority.label} became unavailable: ${currentPath}`,
      { committed: false, successorPreserved: await observePath(currentPath) === "present" },
      cause,
    );
  }
  if (
    !descriptor.isFile()
    || !current.isFile()
    || current.isSymbolicLink()
    || !sameFileIdentity(authority.identity, fileIdentity(descriptor))
    || !sameFileIdentity(authority.identity, fileIdentity(current))
  ) {
    throw workspaceError(
      state,
      "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
      `${authority.label} no longer matches its create-time authority: ${currentPath}`,
      { committed: false, successorPreserved: true },
    );
  }
  const data = await readAuthorityFile(authority.handle, Number(descriptor.size), authority.label);
  if (createHash("sha256").update(data).digest("hex") !== authority.sha256) {
    throw workspaceError(
      state,
      "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
      `${authority.label} content changed after worktree creation: ${currentPath}`,
      { committed: false, successorPreserved: true },
    );
  }
}

function safeGitEnv(
  input: NodeJS.ProcessEnv,
  checkoutConfigOverrides: Array<[key: string, value: string]> = [],
) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "HOMEDRIVE",
    "HOMEPATH",
  ]) {
    if (input[key] !== undefined) env[key] = input[key];
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_SYSTEM = nullDevice;
  env.GIT_CONFIG_GLOBAL = nullDevice;
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  const configOverrides: Array<[string, string]> = [
    ["core.hooksPath", nullDevice],
    ["core.fsmonitor", "false"],
    ...checkoutConfigOverrides,
  ];
  env.GIT_CONFIG_COUNT = String(configOverrides.length);
  for (const [index, [key, value]] of configOverrides.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return env;
}

async function checkoutFilterOverrides(cwd: string, env: NodeJS.ProcessEnv) {
  let raw = "";
  try {
    raw = await gitText(cwd, [
      "config",
      "--local",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ], env);
  } catch (error) {
    if (errorCode(error) === "1") return [];
    throw error;
  }
  const keys = [...new Set(raw.split("\0").map((entry) => entry.trim()).filter(Boolean))];
  const overrides: Array<[string, string]> = [];
  for (const key of keys) {
    const match = key.match(/^filter\.[a-z0-9][a-z0-9._-]*\.(clean|smudge|process|required)$/i);
    if (!match) {
      throw Object.assign(new Error(`temporary worktree refuses unsafe filter configuration key: ${key}`), {
        code: "TEMPORARY_WORKSPACE_UNSAFE_GIT_FILTER_CONFIG",
      });
    }
    overrides.push([key, match[1].toLowerCase() === "required" ? "false" : ""]);
  }
  return overrides;
}

async function gitText(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = await execFile("git", args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return String(result.stdout || "");
}

function resolveReportedPath(cwd: string, raw: string) {
  const value = raw.trim();
  if (!value || value.includes("\0")) throw new Error("Git returned an invalid path");
  return path.resolve(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function parseWorktreeRegistrations(raw: string): GitWorktreeRegistration[] {
  const tokens = raw.includes("\0") ? raw.split("\0") : raw.split(/\r?\n/);
  const registrations: GitWorktreeRegistration[] = [];
  let current: GitWorktreeRegistration | null = null;
  const finish = () => {
    if (current) registrations.push(current);
    current = null;
  };
  for (const token of tokens) {
    if (token === "") {
      finish();
      continue;
    }
    if (token.startsWith("worktree ")) {
      finish();
      current = {
        worktree: path.resolve(token.slice("worktree ".length)),
        head: null,
        branch: null,
        detached: false,
        locked: null,
        prunable: null,
      };
    } else if (current && token.startsWith("HEAD ")) {
      current.head = token.slice("HEAD ".length);
    } else if (current && token.startsWith("branch ")) {
      current.branch = token.slice("branch ".length);
    } else if (current && token === "detached") {
      current.detached = true;
    } else if (current && token.startsWith("locked")) {
      current.locked = token.slice("locked".length).trim();
    } else if (current && token.startsWith("prunable")) {
      current.prunable = token.slice("prunable".length).trim();
    }
  }
  finish();
  return registrations;
}

function sameRegistration(left: GitWorktreeRegistration, right: GitWorktreeRegistration) {
  return left.worktree === right.worktree
    && left.head === right.head
    && left.branch === right.branch
    && left.detached === right.detached
    && left.locked === right.locked
    && left.prunable === right.prunable;
}

async function registrationAt(source: string, worktreePath: string, env: NodeJS.ProcessEnv) {
  const registrations = await registrationsAt(source, worktreePath, env);
  if (registrations.length !== 1) {
    throw new Error(`temporary worktree is not uniquely registered: ${worktreePath}`);
  }
  return registrations[0];
}

async function registrationsAt(source: string, worktreePath: string, env: NodeJS.ProcessEnv) {
  return parseWorktreeRegistrations(
    await gitText(source, ["worktree", "list", "--porcelain", "-z"], env),
  ).filter((entry) => entry.worktree === worktreePath);
}

async function validateGitRegistrationAbsent(state: WorkspaceState) {
  const base = state.gitBase;
  if (!base || !state.worktreePath) return;
  const registrations = await registrationsAt(base.source.path, state.worktreePath, state.env);
  if (registrations.length !== 0) {
    throw workspaceError(
      state,
      "TEMPORARY_WORKSPACE_GIT_REGISTRATION_ACTIVE",
      `temporary worktree registration remains active: ${state.worktreePath}`,
      {
        committed: true,
        gitRegistrationActive: true,
        gitAdminMetadataDisposition: "active",
        gitAdminQuarantinePreserved: false,
      },
    );
  }
}

async function validateGitBinding(state: WorkspaceState) {
  const binding = state.git;
  const base = state.gitBase;
  if (!binding || !base || !state.worktreePath) return;
  await validateDirectoryAuthorityAt(binding.worktree, state.worktreePath, state);
  await validateDirectoryAuthorityAt(binding.admin, binding.admin.path, state);
  await validateDirectoryAuthorityAt(binding.adminParent, binding.adminParent.path, state);
  for (const authority of [
    binding.worktreeGitFile,
    binding.adminGitdir,
    binding.adminCommondir,
    binding.adminHead,
    binding.adminConfig,
  ]) {
    await validateFileAuthority(authority, state);
  }
  let observed: GitWorktreeRegistration;
  try {
    observed = await registrationAt(base.source.path, state.worktreePath, state.env);
  } catch (cause) {
    throw workspaceError(
      state,
      "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
      `temporary worktree registration could not be verified: ${state.worktreePath}`,
      { committed: false, successorPreserved: await observePath(state.worktreePath) === "present" },
      cause,
    );
  }
  if (!sameRegistration(binding.registration, observed)) {
    throw workspaceError(
      state,
      "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
      `temporary worktree registration changed: ${state.worktreePath}`,
      { committed: false, successorPreserved: true },
    );
  }

  try {
    const sourceTop = await realpath(resolveReportedPath(
      base.source.path,
      await gitText(base.source.path, ["rev-parse", "--show-toplevel"], state.env),
    ));
    const sourceCommon = await realpath(resolveReportedPath(
      base.source.path,
      await gitText(base.source.path, ["rev-parse", "--git-common-dir"], state.env),
    ));
    const worktreeTop = await realpath(resolveReportedPath(
      state.worktreePath,
      await gitText(state.worktreePath, ["rev-parse", "--show-toplevel"], state.env),
    ));
    const worktreeCommon = await realpath(resolveReportedPath(
      state.worktreePath,
      await gitText(state.worktreePath, ["rev-parse", "--git-common-dir"], state.env),
    ));
    const worktreeAdmin = await realpath(resolveReportedPath(
      state.worktreePath,
      await gitText(state.worktreePath, ["rev-parse", "--absolute-git-dir"], state.env),
    ));
    const head = (await gitText(state.worktreePath, ["rev-parse", "--verify", "HEAD"], state.env)).trim();
    if (
      sourceTop !== base.source.path
      || sourceCommon !== base.common.path
      || worktreeTop !== state.worktreePath
      || worktreeCommon !== base.common.path
      || worktreeAdmin !== binding.admin.path
      || head !== binding.expectedHead
    ) {
      throw new Error("temporary Git binding no longer matches its create-time paths or HEAD");
    }
  } catch (cause) {
    throw workspaceError(
      state,
      "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT",
      `temporary Git binding changed: ${state.worktreePath}`,
      { committed: false, successorPreserved: await observePath(state.worktreePath) === "present" },
      cause,
    );
  }
}

async function validateGitBase(state: WorkspaceState) {
  const base = state.gitBase;
  if (!base) return;
  await validateDirectoryAuthorityAt(base.source, base.source.path, state);
  await validateDirectoryAuthorityAt(base.common, base.common.path, state);
  await validateFileAuthority(base.commonConfig, state);
}

async function validateWorkspace(state: WorkspaceState) {
  await validateDirectoryAuthorityAt(state.parent, state.parent.path, state);
  await validateDirectoryAuthorityAt(state.root, state.rootPath, state);
  await validateGitBase(state);
  await validateGitBinding(state);
}

async function closeAuthorities(
  state: WorkspaceState,
  additionalDirectories: DirectoryAuthority[] = [],
) {
  const handles: Array<{ label: string; close: () => Promise<void> }> = [];
  if (state.git) {
    for (const authority of [
      state.git.worktreeGitFile,
      state.git.adminGitdir,
      state.git.adminCommondir,
      state.git.adminHead,
      state.git.adminConfig,
    ]) {
      if (authority.state === "file") handles.push({ label: authority.label, close: () => authority.handle.close() });
    }
    for (const authority of [state.git.admin, state.git.worktree, state.git.adminParent]) {
      handles.push({ label: authority.label, close: () => authority.handle.close() });
    }
  }
  if (state.gitBase) {
    const commonConfig = state.gitBase.commonConfig;
    if (commonConfig.state === "file") {
      handles.push({
        label: commonConfig.label,
        close: () => commonConfig.handle.close(),
      });
    }
    for (const authority of [state.gitBase.common, state.gitBase.source]) {
      handles.push({ label: authority.label, close: () => authority.handle.close() });
    }
  }
  handles.push({ label: state.root.label, close: () => state.root.handle.close() });
  handles.push({ label: state.parent.label, close: () => state.parent.handle.close() });
  for (const authority of additionalDirectories) {
    handles.push({ label: authority.label, close: () => authority.handle.close() });
  }
  const errors: unknown[] = [];
  const seen = new Set<() => Promise<void>>();
  for (const entry of handles) {
    if (seen.has(entry.close)) continue;
    seen.add(entry.close);
    try {
      await entry.close();
    } catch (error) {
      errors.push(Object.assign(new Error(`failed to close ${entry.label}`), { cause: error }));
    }
  }
  return errors;
}

async function refreshCommittedTruth(
  state: WorkspaceState,
  quarantineContainerAuthority: DirectoryAuthority | null,
  quarantineContainer: string,
  quarantineRoot: string,
  quarantineGitAdminDir: string | undefined,
  rootCommitted: boolean,
  gitAdminCommitted: boolean,
) {
  const canonicalState = await observePath(state.rootPath);
  let quarantineContainerPreserved = false;
  if (quarantineContainerAuthority) {
    try {
      await validateDirectoryAuthorityAt(
        quarantineContainerAuthority,
        quarantineContainer,
        state,
      );
      quarantineContainerPreserved = true;
    } catch {
      quarantineContainerPreserved = false;
    }
  }
  let quarantinePreserved = false;
  if (rootCommitted) {
    try {
      await validateDirectoryAuthorityAt(state.root, quarantineRoot, state);
      quarantinePreserved = true;
    } catch {
      quarantinePreserved = false;
    }
  }
  let gitRegistrationActive: boolean | null = null;
  if (state.workspaceKind === "git_worktree" && state.gitBase && state.worktreePath) {
    try {
      gitRegistrationActive = (await registrationsAt(
        state.gitBase.source.path,
        state.worktreePath,
        state.env,
      )).length > 0;
    } catch {
      gitRegistrationActive = null;
    }
  }
  let gitAdminQuarantinePreserved: boolean | null = null;
  let gitAdminMetadataDisposition: TemporaryWorkspaceGitAdminDisposition = "not_applicable";
  if (state.workspaceKind === "git_worktree") {
    gitAdminMetadataDisposition = state.git ? "active" : "unknown";
    gitAdminQuarantinePreserved = false;
    if (state.git && gitAdminCommitted && quarantineGitAdminDir) {
      try {
        await validateDirectoryAuthorityAt(state.git.admin, quarantineGitAdminDir, state);
        gitAdminQuarantinePreserved = true;
        gitAdminMetadataDisposition = "quarantined";
      } catch {
        gitAdminMetadataDisposition = "unknown";
      }
    } else if (state.git) {
      try {
        await validateDirectoryAuthorityAt(state.git.admin, state.git.admin.path, state);
        gitAdminMetadataDisposition = "active";
      } catch {
        gitAdminMetadataDisposition = "unknown";
      }
    }
  }
  return {
    canonicalPathRemoved: canonicalState === "missing" ? true : canonicalState === "present" ? false : null,
    successorPreserved: canonicalState === "present" ? true : canonicalState === "missing" ? false : null,
    quarantineContainerPreserved,
    quarantinePreserved,
    gitRegistrationActive,
    gitAdminMetadataDisposition,
    gitAdminQuarantinePreserved,
  };
}

async function cleanupWorkspace(state: WorkspaceState): Promise<TemporaryWorkspaceCleanupProof> {
  const quarantineContainer = `${state.rootPath}.quarantine-${Date.now()}-${randomUUID()}`;
  let quarantineContainerAuthority: DirectoryAuthority | null = null;
  let quarantineRoot: string | undefined;
  let quarantineGitAdminDir: string | undefined;
  let rootCommitted = false;
  let gitAdminCommitted = false;
  let primaryError: unknown = null;
  let proof: TemporaryWorkspaceCleanupProof | null = null;
  try {
    await validateWorkspace(state);
    if (state.workspaceKind === "git_worktree" && !state.git && state.gitBase && state.worktreePath) {
      const registrations = await registrationsAt(state.gitBase.source.path, state.worktreePath, state.env);
      if (registrations.length > 0) {
        throw workspaceError(
          state,
          "TEMPORARY_WORKSPACE_GIT_REGISTRATION_UNBOUND",
          `temporary worktree registration cannot be safely detached without its create-time admin authority: ${state.worktreePath}`,
          {
            committed: false,
            gitRegistrationActive: true,
            gitAdminMetadataDisposition: "active",
            gitAdminQuarantinePreserved: false,
          },
        );
      }
    }
    await state.hooks.afterOwnershipValidated?.({
      rootPath: state.rootPath,
      worktreePath: state.worktreePath,
      quarantineRoot: quarantineContainer,
    });
    await validateWorkspace(state);
    try {
      // mkdir is the no-clobber claim for the only destination exposed to
      // pre-commit hooks. Node's cross-platform rename API is not an atomic
      // no-replace primitive, so the owned root is never renamed onto this
      // attacker-visible path.
      await mkdir(quarantineContainer, { mode: 0o700 });
    } catch (cause) {
      if (errorCode(cause) === "EEXIST") {
        throw workspaceError(
          state,
          "TEMPORARY_WORKSPACE_QUARANTINE_CONFLICT",
          `temporary workspace quarantine destination is occupied: ${quarantineContainer}`,
          { committed: false, successorPreserved: true },
          cause,
        );
      }
      throw cause;
    }
    quarantineContainerAuthority = await openDirectoryAuthority(
      quarantineContainer,
      "temporary workspace quarantine container",
    );
    // This child name is generated only after the empty container has been
    // atomically claimed and is never exposed to a pre-commit hook. This is
    // intentionally different from assuming rename itself has no-replace
    // semantics (it does not on POSIX when the destination is empty).
    quarantineRoot = path.join(quarantineContainer, `.cpb-quarantined-root-${randomUUID()}`);
    quarantineGitAdminDir = state.git
      ? path.join(quarantineRoot, `.cpb-git-admin-${path.basename(state.git.admin.path)}-${randomUUID()}`)
      : undefined;
    if (await observePath(quarantineRoot) !== "missing") {
      throw workspaceError(
        state,
        "TEMPORARY_WORKSPACE_QUARANTINE_CONFLICT",
        `temporary workspace quarantine root is occupied: ${quarantineRoot}`,
        {
          committed: false,
          successorPreserved: true,
          quarantineContainer,
        },
      );
    }
    await validateWorkspace(state);
    await validateDirectoryAuthorityAt(
      quarantineContainerAuthority,
      quarantineContainer,
      state,
    );
    await rename(state.rootPath, quarantineRoot);
    rootCommitted = true;
    await state.hooks.afterQuarantineRename?.({
      rootPath: state.rootPath,
      worktreePath: state.worktreePath,
      quarantineRoot,
    });
    await state.hooks.beforeQuarantineDirectorySync?.({
      rootPath: state.rootPath,
      quarantineRoot,
      parentPath: state.parent.path,
    });
    await state.root.handle.sync();
    await quarantineContainerAuthority.handle.sync();
    await state.parent.handle.sync();
    await validateDirectoryAuthorityAt(state.parent, state.parent.path, state);
    await validateDirectoryAuthorityAt(
      quarantineContainerAuthority,
      quarantineContainer,
      state,
    );
    await validateDirectoryAuthorityAt(state.root, quarantineRoot, state);
    if (state.git && state.worktreePath) {
      if (!quarantineGitAdminDir) throw new Error("temporary Git admin quarantine path is unavailable");
      await validateGitBase(state);
      await validateDirectoryAuthorityAt(state.git.adminParent, state.git.adminParent.path, state);
      await validateDirectoryAuthorityAt(
        state.git.admin,
        state.git.admin.path,
        state,
      );
      await validateDirectoryAuthorityAt(
        state.git.worktree,
        path.join(quarantineRoot, path.basename(state.worktreePath)),
        state,
      );
      for (const authority of [
        state.git.adminGitdir,
        state.git.adminCommondir,
        state.git.adminHead,
        state.git.adminConfig,
      ]) {
        await validateFileAuthority(authority, state);
      }
      await validateFileAuthority(
        state.git.worktreeGitFile,
        state,
        path.join(quarantineRoot, path.basename(state.worktreePath), ".git"),
      );
      if (await observePath(quarantineGitAdminDir) !== "missing") {
        throw workspaceError(
          state,
          "TEMPORARY_WORKSPACE_GIT_ADMIN_QUARANTINE_CONFLICT",
          `temporary Git admin quarantine destination is occupied: ${quarantineGitAdminDir}`,
          {
            committed: true,
            quarantineRoot,
            gitRegistrationActive: true,
            gitAdminMetadataDisposition: "active",
            gitAdminQuarantinePreserved: false,
          },
        );
      }
      await validateDirectoryAuthorityAt(state.root, quarantineRoot, state);
      await validateDirectoryAuthorityAt(state.git.adminParent, state.git.adminParent.path, state);
      await validateDirectoryAuthorityAt(state.git.admin, state.git.admin.path, state);
      await rename(state.git.admin.path, quarantineGitAdminDir);
      gitAdminCommitted = true;
      await state.hooks.afterGitAdminQuarantine?.({
        rootPath: state.rootPath,
        worktreePath: state.worktreePath,
        gitAdminDir: state.git.admin.path,
        quarantineGitAdminDir,
      });
      await state.hooks.beforeGitAdminDirectorySync?.({
        quarantineRoot,
        gitAdminParent: state.git.adminParent.path,
        quarantineGitAdminDir,
      });
      await state.git.admin.handle.sync();
      await state.git.adminParent.handle.sync();
      await state.root.handle.sync();
      await validateDirectoryAuthorityAt(state.root, quarantineRoot, state);
      await validateDirectoryAuthorityAt(state.git.adminParent, state.git.adminParent.path, state);
      await validateDirectoryAuthorityAt(state.git.admin, quarantineGitAdminDir, state);
      for (const authority of [
        state.git.adminGitdir,
        state.git.adminCommondir,
        state.git.adminHead,
        state.git.adminConfig,
      ]) {
        await validateFileAuthority(
          authority,
          state,
          path.join(quarantineGitAdminDir, path.basename(authority.path)),
        );
      }
      await validateFileAuthority(
        state.git.worktreeGitFile,
        state,
        path.join(quarantineRoot, path.basename(state.worktreePath), ".git"),
      );
      await validateGitBase(state);
      await validateGitRegistrationAbsent(state);
    }
    const canonicalState = await observePath(state.rootPath);
    if (canonicalState !== "missing") {
      throw workspaceError(
        state,
        "TEMPORARY_WORKSPACE_SUCCESSOR_PRESERVED",
        `temporary workspace successor appeared after quarantine: ${state.rootPath}`,
        {
          committed: true,
          canonicalPathRemoved: false,
          quarantinePreserved: true,
          successorPreserved: canonicalState === "present" ? true : null,
          quarantineRoot,
        },
      );
    }
    await validateDirectoryAuthorityAt(
      quarantineContainerAuthority,
      quarantineContainer,
      state,
    );
    await validateDirectoryAuthorityAt(state.root, quarantineRoot, state);
    proof = {
      version: TEMPORARY_WORKSPACE_VERSION,
      kind: "temporary_workspace_disposition",
      code: "TEMPORARY_WORKSPACE_QUARANTINED",
      message: `temporary workspace quarantined at ${quarantineRoot}`,
      workspaceKind: state.workspaceKind,
      disposition: "quarantined",
      ok: true,
      cleanupVerified: true,
      committed: true,
      creationCommitted: state.workspaceKind === "git_worktree" ? true : null,
      canonicalPathRemoved: true,
      quarantinePreserved: true,
      successorPreserved: false,
      gitMetadataRetained: state.workspaceKind === "git_worktree",
      gitRegistrationActive: state.workspaceKind === "directory" ? null : false,
      gitAdminMetadataDisposition: state.workspaceKind === "directory"
        ? "not_applicable"
        : (state.git ? "quarantined" : "unknown"),
      gitAdminQuarantinePreserved: state.workspaceKind === "directory"
        ? null
        : (state.git ? true : false),
      cleanupDeferred: true,
      recoveryPaths: recoveryPaths(
        state,
        quarantineRoot,
        gitAdminCommitted ? quarantineGitAdminDir : undefined,
        quarantineContainer,
      ),
      authority: authorityEvidence(
        state,
        "quarantined",
        state.git ? "quarantined" : "unknown",
      ),
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    primaryError = error;
  }

  const primaryDetails = temporaryWorkspaceErrorDetails(primaryError);
  const observedTruth = await refreshCommittedTruth(
    state,
    quarantineContainerAuthority,
    quarantineContainer,
    quarantineRoot || quarantineContainer,
    quarantineGitAdminDir,
    rootCommitted,
    gitAdminCommitted,
  );
  const closeErrors = await closeAuthorities(
    state,
    quarantineContainerAuthority ? [quarantineContainerAuthority] : [],
  );
  if (primaryError || closeErrors.length > 0) {
    const causes = [primaryError, ...closeErrors].filter((entry) => entry !== null);
    const code = rootCommitted && observedTruth.quarantinePreserved
      ? "TEMPORARY_WORKSPACE_QUARANTINE_PRESERVED"
      : (!rootCommitted
        ? (primaryDetails?.code || "TEMPORARY_WORKSPACE_RECOVERY_REQUIRED")
        : "TEMPORARY_WORKSPACE_RECOVERY_REQUIRED");
    const message = rootCommitted && observedTruth.quarantinePreserved
      ? `temporary workspace quarantine committed; recovery retained at ${quarantineRoot}`
      : (rootCommitted
        ? "temporary workspace quarantine committed but its retained generation could not be revalidated"
        : `temporary workspace cleanup stopped before quarantine: ${primaryDetails?.message || "recovery state retained"}`);
    throw workspaceError(
      state,
      code,
      message,
      {
        committed: rootCommitted,
        canonicalPathRemoved: observedTruth.canonicalPathRemoved,
        quarantinePreserved: observedTruth.quarantinePreserved,
        successorPreserved: observedTruth.successorPreserved,
        quarantineContainer: observedTruth.quarantineContainerPreserved
          ? quarantineContainer
          : undefined,
        quarantineRoot: rootCommitted && observedTruth.quarantinePreserved
          ? quarantineRoot
          : undefined,
        quarantineGitAdminDir: gitAdminCommitted && observedTruth.gitAdminQuarantinePreserved
          ? quarantineGitAdminDir
          : undefined,
        gitRegistrationActive: observedTruth.gitRegistrationActive,
        gitAdminMetadataDisposition: observedTruth.gitAdminMetadataDisposition,
        gitAdminQuarantinePreserved: observedTruth.gitAdminQuarantinePreserved,
      },
      causes.length > 1 ? new AggregateError(causes, message) : causes[0],
    );
  }
  return proof as TemporaryWorkspaceCleanupProof;
}

async function createRoot(prefix: string, env: NodeJS.ProcessEnv): Promise<WorkspaceState> {
  if (!prefix || prefix.includes("\0") || path.basename(prefix) !== prefix || !prefix.startsWith("cpb-") || !prefix.endsWith("-")) {
    throw Object.assign(new Error("temporary workspace prefix must be a cpb-* basename ending in '-'"), {
      code: "TEMPORARY_WORKSPACE_PREFIX_INVALID",
    });
  }
  const parentPath = await realpath(tmpdir());
  const parent = await openDirectoryAuthority(parentPath, "temporary workspace parent");
  let root: DirectoryAuthority | null = null;
  try {
    const created = await mkdtemp(path.join(parentPath, prefix));
    const rootPath = await realpath(created);
    root = await openDirectoryAuthority(rootPath, "temporary workspace root");
    await validateDirectoryAuthorityAt(parent, parentPath, {
      workspaceKind: "directory",
      rootPath,
      worktreePath: null,
      parent,
      root,
      gitBase: null,
      git: null,
      gitCoordinates: null,
      env,
      hooks: hookStorage.getStore() || {},
      cleanupPromise: null,
    });
    return {
      workspaceKind: "directory",
      rootPath,
      worktreePath: null,
      parent,
      root,
      gitBase: null,
      git: null,
      gitCoordinates: null,
      env,
      hooks: { ...(hookStorage.getStore() || {}) },
      cleanupPromise: null,
    };
  } catch (error) {
    if (root) await root.handle.close().catch(() => undefined);
    await parent.handle.close().catch(() => undefined);
    throw error;
  }
}

function publicWorkspace(state: WorkspaceState): TemporaryWorkspace {
  return {
    rootPath: state.rootPath,
    cleanup() {
      if (!state.cleanupPromise) state.cleanupPromise = cleanupWorkspace(state);
      return state.cleanupPromise;
    },
  };
}

export async function createTemporaryWorkspace({
  prefix,
  env = process.env,
}: {
  prefix: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TemporaryWorkspace> {
  return publicWorkspace(await createRoot(prefix, { ...env }));
}

async function captureGitBinding(
  state: WorkspaceState,
  source: DirectoryAuthority,
  common: DirectoryAuthority,
  expectedHead: string,
): Promise<GitBinding> {
  if (!state.worktreePath) throw new Error("temporary worktree path is unavailable");
  const openedDirectories: DirectoryAuthority[] = [];
  const openedFiles: FileAuthority[] = [];
  try {
    const worktree = await openDirectoryAuthority(state.worktreePath, "temporary Git worktree");
    openedDirectories.push(worktree);
    const adminPath = await realpath(resolveReportedPath(
      state.worktreePath,
      await gitText(state.worktreePath, ["rev-parse", "--absolute-git-dir"], state.env),
    ));
    const relativeAdmin = path.relative(common.path, adminPath);
    if (
      relativeAdmin.startsWith("..")
      || path.isAbsolute(relativeAdmin)
      || path.dirname(relativeAdmin) !== "worktrees"
    ) {
      throw new Error(`temporary worktree Git admin directory is outside the common directory: ${adminPath}`);
    }
    const adminParentPath = path.dirname(adminPath);
    if (await realpath(adminParentPath) !== adminParentPath) {
      throw new Error(`temporary worktree Git admin parent is not canonical: ${adminParentPath}`);
    }
    const adminParent = await openDirectoryAuthority(adminParentPath, "temporary worktree Git admin parent");
    openedDirectories.push(adminParent);
    const admin = await openDirectoryAuthority(adminPath, "temporary worktree Git admin directory");
    openedDirectories.push(admin);
    const worktreeCommon = await realpath(resolveReportedPath(
      state.worktreePath,
      await gitText(state.worktreePath, ["rev-parse", "--git-common-dir"], state.env),
    ));
    const worktreeTop = await realpath(resolveReportedPath(
      state.worktreePath,
      await gitText(state.worktreePath, ["rev-parse", "--show-toplevel"], state.env),
    ));
    const head = (await gitText(state.worktreePath, ["rev-parse", "--verify", "HEAD"], state.env)).trim();
    if (worktreeCommon !== common.path || worktreeTop !== state.worktreePath || head !== expectedHead) {
      throw new Error("temporary worktree does not match its expected Git binding");
    }
    const registration = await registrationAt(source.path, state.worktreePath, state.env);
    if (!registration.detached || registration.branch !== null || registration.head !== expectedHead) {
      throw new Error("temporary worktree registration is not detached at the expected commit");
    }
    const authorities = [
      await openFileAuthority(path.join(state.worktreePath, ".git"), "temporary worktree .git file"),
      await openFileAuthority(path.join(adminPath, "gitdir"), "temporary worktree gitdir registration"),
      await openFileAuthority(path.join(adminPath, "commondir"), "temporary worktree commondir registration"),
      await openFileAuthority(path.join(adminPath, "HEAD"), "temporary worktree HEAD registration"),
      await openFileAuthority(path.join(adminPath, "config.worktree"), "temporary worktree config", true),
    ];
    openedFiles.push(...authorities);
    return {
      worktree,
      admin,
      adminParent,
      worktreeGitFile: authorities[0],
      adminGitdir: authorities[1],
      adminCommondir: authorities[2],
      adminHead: authorities[3],
      adminConfig: authorities[4],
      registration,
      expectedHead,
    };
  } catch (error) {
    for (const authority of openedFiles.reverse()) {
      if (authority.state === "file") await authority.handle.close().catch(() => undefined);
    }
    for (const authority of openedDirectories.reverse()) {
      await authority.handle.close().catch(() => undefined);
    }
    throw error;
  }
}

function mergeCreationFailure(
  state: WorkspaceState,
  cause: unknown,
  cleanup: TemporaryWorkspaceRecovery,
  creationCommitted: boolean | null,
) {
  const message = creationCommitted
    ? "temporary Git worktree creation committed but its command reported failure"
    : "temporary Git worktree creation failed";
  const details: TemporaryWorkspaceErrorDetails = {
    version: TEMPORARY_WORKSPACE_VERSION,
    kind: "temporary_workspace_recovery",
    code: "TEMPORARY_WORKSPACE_CREATE_FAILED",
    message,
    ok: false,
    workspaceKind: "git_worktree",
    disposition: cleanup.disposition,
    cleanupVerified: cleanup.cleanupVerified,
    committed: cleanup.committed,
    creationCommitted,
    canonicalPathRemoved: cleanup.canonicalPathRemoved,
    quarantinePreserved: cleanup.quarantinePreserved,
    successorPreserved: cleanup.successorPreserved,
    gitMetadataRetained: true,
    gitRegistrationActive: cleanup.gitRegistrationActive,
    gitAdminMetadataDisposition: cleanup.gitAdminMetadataDisposition,
    gitAdminQuarantinePreserved: cleanup.gitAdminQuarantinePreserved,
    cleanupDeferred: true,
    recoveryPaths: cleanup.recoveryPaths,
    authority: cleanup.authority,
  };
  return Object.assign(
    new AggregateError([cause], message, { cause }),
    details,
    { temporaryWorkspaceRecovery: details, workspaceState: state.workspaceKind },
  );
}

export async function createTemporaryGitWorktree({
  sourcePath,
  revision,
  prefix,
  noCheckout = false,
  env = process.env,
}: {
  sourcePath: string;
  revision: string;
  prefix: string;
  noCheckout?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<TemporaryGitWorktree> {
  const discoveryEnv = safeGitEnv(env);
  const sourceTop = await realpath(resolveReportedPath(
    sourcePath,
    await gitText(sourcePath, ["rev-parse", "--show-toplevel"], discoveryEnv),
  ));
  const gitEnv = safeGitEnv(env, await checkoutFilterOverrides(sourceTop, discoveryEnv));
  const commonPath = await realpath(resolveReportedPath(
    sourceTop,
    await gitText(sourceTop, ["rev-parse", "--git-common-dir"], gitEnv),
  ));
  const expectedHead = (await gitText(sourceTop, ["rev-parse", "--verify", `${revision}^{commit}`], gitEnv)).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(expectedHead)) throw new Error("temporary worktree revision is not a commit");

  const source = await openDirectoryAuthority(sourceTop, "temporary worktree source repository");
  let common: DirectoryAuthority | null = null;
  let commonConfig: FileAuthority | null = null;
  let state: WorkspaceState | null = null;
  try {
    common = await openDirectoryAuthority(commonPath, "temporary worktree Git common directory");
    commonConfig = await openFileAuthority(path.join(commonPath, "config"), "temporary worktree common Git config");
    state = await createRoot(prefix, gitEnv);
    state.workspaceKind = "git_worktree";
    state.worktreePath = path.join(state.rootPath, "worktree");
    state.gitCoordinates = { sourcePath: source.path, commonDir: common.path };
    state.gitBase = { source, common, commonConfig };
    if (await observePath(state.worktreePath) !== "missing") {
      throw new Error(`temporary worktree path already exists: ${state.worktreePath}`);
    }
    const before = parseWorktreeRegistrations(
      await gitText(source.path, ["worktree", "list", "--porcelain", "-z"], gitEnv),
    ).filter((entry) => entry.worktree === state?.worktreePath);
    if (before.length !== 0) throw new Error(`temporary worktree path is already registered: ${state.worktreePath}`);

    let addError: unknown = null;
    try {
      await gitText(source.path, [
        "worktree",
        "add",
        "--detach",
        ...(noCheckout ? ["--no-checkout"] : []),
        state.worktreePath,
        expectedHead,
      ], gitEnv);
    } catch (error) {
      addError = error;
    }

    let bindingError: unknown = null;
    try {
      await validateGitBase(state);
      state.git = await captureGitBinding(state, source, common, expectedHead);
      state.gitCoordinates.adminDir = state.git.admin.path;
      await validateWorkspace(state);
    } catch (error) {
      bindingError = error;
    }

    if (addError || bindingError) {
      if (!state.git) {
        // The exact root remains descriptor-bound even when Git's outcome is
        // ambiguous. Preserve its contents and any metadata for recovery.
        state.git = null;
      }
      const creationCommitted = state.git
        ? true
        : (await observePath(state.worktreePath) === "present" ? true : null);
      let cleanup: TemporaryWorkspaceRecovery;
      try {
        cleanup = await publicWorkspace(state).cleanup();
      } catch (cleanupError) {
        cleanup = temporaryWorkspaceErrorDetails(cleanupError)
          || recoveryDetails(state, "TEMPORARY_WORKSPACE_RECOVERY_REQUIRED", "temporary workspace recovery is required", {
            committed: false,
            creationCommitted,
          });
      }
      throw mergeCreationFailure(state, addError || bindingError, cleanup, creationCommitted);
    }

    const workspace = publicWorkspace(state);
    return {
      ...workspace,
      worktreePath: state.worktreePath,
      sourcePath: source.path,
      commonDir: common.path,
      expectedHead,
      gitEnv: { ...gitEnv },
    };
  } catch (error) {
    if (state?.cleanupPromise) throw error;
    if (state) {
      const observed = state.worktreePath ? await observePath(state.worktreePath) : "missing";
      const creationCommitted = observed === "present" ? true : observed === "missing" ? false : null;
      let cleanup: TemporaryWorkspaceRecovery;
      try {
        cleanup = await publicWorkspace(state).cleanup();
      } catch (cleanupError) {
        cleanup = temporaryWorkspaceErrorDetails(cleanupError)
          || recoveryDetails(state, "TEMPORARY_WORKSPACE_RECOVERY_REQUIRED", "temporary workspace recovery is required", {
            committed: false,
            creationCommitted,
          });
      }
      throw mergeCreationFailure(state, error, cleanup, creationCommitted);
    }
    const closeErrors: unknown[] = [];
    if (commonConfig?.state === "file") await commonConfig.handle.close().catch((entry) => closeErrors.push(entry));
    if (common) await common.handle.close().catch((entry) => closeErrors.push(entry));
    await source.handle.close().catch((entry) => closeErrors.push(entry));
    if (closeErrors.length > 0) {
      throw new AggregateError([error, ...closeErrors], "temporary worktree creation and authority close failed", { cause: error });
    }
    throw error;
  }
}
