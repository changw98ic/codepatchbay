import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MIN_CODEGRAPH_DB_BYTES = 1024;

export class CodeGraphUnavailableError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = "CodeGraphUnavailableError";
    this.code = "codegraph_unavailable";
    this.details = details;
  }
}

function isAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function canonicalDir(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return await realpath(path.resolve(value));
  } catch {
    return null;
  }
}

async function firstUsableIndexFile(codebaseRoot) {
  const candidates = [
    path.join(codebaseRoot, ".codegraph", "codegraph.db"),
    path.join(codebaseRoot, ".codegraph", "index.sqlite"),
  ];
  for (const file of candidates) {
    try {
      const info = await stat(file);
      if (info.isFile() && info.size >= MIN_CODEGRAPH_DB_BYTES) return file;
    } catch {
      // Try the next known CodeGraph index filename.
    }
  }
  return null;
}

async function readDaemonState(sourceRoot) {
  const daemonPidFile = path.join(sourceRoot, ".codegraph", "daemon.pid");
  const state = await readJson(daemonPidFile);
  if (!state?.pid) return null;
  return {
    pid: state.pid,
    codebaseRoot: state.codebaseRoot || sourceRoot,
    socketPath: state.socketPath || null,
    source: state.source || "codegraph_daemon",
  };
}

export async function checkCodeGraphReady({ cpbRoot, sourcePath } = {}) {
  const sourceRoot = await canonicalDir(sourcePath);
  if (!sourceRoot) {
    throw new CodeGraphUnavailableError("sourcePath is required for CodeGraph readiness", {
      reason: "missing_source_path",
      sourcePath: sourcePath || null,
    });
  }

  const statePath = path.join(path.resolve(cpbRoot || sourceRoot), "cpb-task", "codegraph-state.json");
  const stateFile = await readJson(statePath);
  const daemonState = await readDaemonState(sourceRoot);
  let state = stateFile?.pid ? stateFile : daemonState;

  const indexFile = await firstUsableIndexFile(sourceRoot);
  if (!indexFile) {
    throw new CodeGraphUnavailableError("CodeGraph index is unavailable", {
      reason: "missing_codegraph_index",
      sourcePath: sourceRoot,
    });
  }

  if (!state?.pid) {
    throw new CodeGraphUnavailableError("CodeGraph readiness state is unavailable", {
      reason: "missing_codegraph_state",
      sourcePath: sourceRoot,
      indexFile,
    });
  }
  if (!isAlive(state.pid) && daemonState?.pid && isAlive(daemonState.pid)) {
    state = daemonState;
  }
  if (!isAlive(state.pid)) {
    throw new CodeGraphUnavailableError("CodeGraph process is not running", {
      reason: "dead_codegraph_process",
      pid: state.pid,
      sourcePath: sourceRoot,
    });
  }

  let stateRoot = await canonicalDir(state.codebaseRoot);
  if (stateRoot && stateRoot !== sourceRoot && daemonState?.pid && isAlive(daemonState.pid)) {
    const daemonRoot = await canonicalDir(daemonState.codebaseRoot);
    if (daemonRoot === sourceRoot) {
      state = daemonState;
      stateRoot = daemonRoot;
    }
  }
  if (!stateRoot || stateRoot !== sourceRoot) {
    throw new CodeGraphUnavailableError("CodeGraph state does not match sourcePath", {
      reason: "codegraph_root_mismatch",
      stateRoot,
      sourcePath: sourceRoot,
    });
  }

  return {
    available: true,
    sourcePath: sourceRoot,
    indexFile,
    state,
  };
}
