import { isRecord, type LooseRecord } from "./types.js";
import path from "node:path";

export const WORKTREE_OWNERSHIP_VERSION = 2 as const;

export type WorktreeDirectoryIdentity = {
  dev: string;
  ino: string;
  birthtimeNs: string;
  mode: string;
  uid: string;
  gid: string;
};

export type PreparedWorktreeOwnership = {
  version: typeof WORKTREE_OWNERSHIP_VERSION;
  state: "prepared";
  ownerToken: string;
  baseBranch: string;
  baseCommit: string;
};

export type ReadyWorktreeOwnership = Omit<PreparedWorktreeOwnership, "state"> & {
  state: "ready";
  directory: WorktreeDirectoryIdentity;
};

export type WorktreeOwnership = PreparedWorktreeOwnership | ReadyWorktreeOwnership;

export type ManagedWorktreeContext = {
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  ownership: ReadyWorktreeOwnership;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/;

function contractError(message: string) {
  return Object.assign(new Error(message), { code: "WORKTREE_OWNERSHIP_CONTRACT_INVALID" });
}

function exactKeys(value: LooseRecord, expected: string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw contractError(`${label} has unexpected or missing fields`);
  }
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw contractError(`${field} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function directoryIdentity(value: unknown): WorktreeDirectoryIdentity {
  if (!isRecord(value)) throw contractError("worktree ownership directory must be an object");
  exactKeys(value, ["dev", "ino", "birthtimeNs", "mode", "uid", "gid"], "worktree ownership directory");
  const parsed: WorktreeDirectoryIdentity = {
    dev: requiredString(value.dev, "worktree ownership directory.dev"),
    ino: requiredString(value.ino, "worktree ownership directory.ino"),
    birthtimeNs: requiredString(value.birthtimeNs, "worktree ownership directory.birthtimeNs"),
    mode: requiredString(value.mode, "worktree ownership directory.mode"),
    uid: requiredString(value.uid, "worktree ownership directory.uid"),
    gid: requiredString(value.gid, "worktree ownership directory.gid"),
  };
  for (const [field, entry] of Object.entries(parsed)) {
    if (!UNSIGNED_INTEGER.test(entry)) {
      throw contractError(`worktree ownership directory.${field} must be an unsigned decimal integer`);
    }
  }
  if (parsed.ino === "0") throw contractError("worktree ownership directory.ino must be non-zero");
  return parsed;
}

export function parseWorktreeOwnership(
  value: unknown,
  { allowPrepared = false }: { allowPrepared?: boolean } = {},
): WorktreeOwnership {
  if (!isRecord(value)) throw contractError("worktree ownership must be an object");
  if (value.version !== WORKTREE_OWNERSHIP_VERSION) {
    throw contractError(`worktree ownership version must be ${WORKTREE_OWNERSHIP_VERSION}`);
  }
  const state = value.state;
  if (state !== "prepared" && state !== "ready") {
    throw contractError("worktree ownership state must be prepared or ready");
  }
  if (state === "prepared" && !allowPrepared) {
    throw contractError("worktree ownership is not ready");
  }
  const ownerToken = requiredString(value.ownerToken, "worktree ownership ownerToken");
  if (!UUID.test(ownerToken)) throw contractError("worktree ownership ownerToken must be a canonical random UUID");
  const baseBranch = requiredString(value.baseBranch, "worktree ownership baseBranch");
  const baseCommit = requiredString(value.baseCommit, "worktree ownership baseCommit");
  if (!COMMIT.test(baseCommit)) throw contractError("worktree ownership baseCommit must be a commit object id");

  if (state === "prepared") {
    exactKeys(value, ["version", "state", "ownerToken", "baseBranch", "baseCommit"], "prepared worktree ownership");
    return { version: WORKTREE_OWNERSHIP_VERSION, state, ownerToken, baseBranch, baseCommit };
  }

  exactKeys(value, ["version", "state", "ownerToken", "baseBranch", "baseCommit", "directory"], "ready worktree ownership");
  return {
    version: WORKTREE_OWNERSHIP_VERSION,
    state,
    ownerToken,
    baseBranch,
    baseCommit,
    directory: directoryIdentity(value.directory),
  };
}

export function parseManagedWorktreeContext(value: unknown): ManagedWorktreeContext {
  if (!isRecord(value)) throw contractError("managed worktree context must be an object");
  exactKeys(value, ["path", "branch", "baseBranch", "baseCommit", "ownership"], "managed worktree context");
  const ownership = parseWorktreeOwnership(value.ownership) as ReadyWorktreeOwnership;
  const context: ManagedWorktreeContext = {
    path: requiredString(value.path, "managed worktree path"),
    branch: requiredString(value.branch, "managed worktree branch"),
    baseBranch: requiredString(value.baseBranch, "managed worktree baseBranch"),
    baseCommit: requiredString(value.baseCommit, "managed worktree baseCommit"),
    ownership,
  };
  if (!path.isAbsolute(context.path) || path.resolve(context.path) !== context.path) {
    throw contractError("managed worktree path must be an absolute normalized path");
  }
  if (context.baseBranch !== ownership.baseBranch || context.baseCommit !== ownership.baseCommit) {
    throw contractError("managed worktree base branch/commit do not match ownership binding");
  }
  return context;
}

export function sameWorktreeDirectoryIdentity(
  left: WorktreeDirectoryIdentity,
  right: WorktreeDirectoryIdentity,
) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

export function sameReadyWorktreeOwnership(left: ReadyWorktreeOwnership, right: ReadyWorktreeOwnership) {
  return left.version === right.version
    && left.state === right.state
    && left.ownerToken === right.ownerToken
    && left.baseBranch === right.baseBranch
    && left.baseCommit === right.baseCommit
    && sameWorktreeDirectoryIdentity(left.directory, right.directory);
}
