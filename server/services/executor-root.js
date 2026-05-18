import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

const REQUIRED_EXECUTOR_FILES = [
  "bridges/common.sh",
  "bridges/run-pipeline.mjs",
  "bridges/project-worker.mjs",
  "bridges/job-runner.mjs",
  "server/services/job-store.js",
];

export function resolveExecutorRoot({ env = process.env, fallbackRoot = process.cwd() } = {}) {
  return path.resolve(env.CPB_EXECUTOR_ROOT || fallbackRoot);
}

export function executorEnv(env = process.env, { cpbRoot, executorRoot } = {}) {
  return {
    ...env,
    CPB_ROOT: path.resolve(cpbRoot || env.CPB_ROOT || process.cwd()),
    CPB_EXECUTOR_ROOT: path.resolve(executorRoot || env.CPB_EXECUTOR_ROOT || cpbRoot || process.cwd()),
  };
}

export async function assertExecutorRoot(executorRoot) {
  const root = path.resolve(executorRoot);
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new Error(`executor root is not a directory: ${root}`);
  }

  for (const relativePath of REQUIRED_EXECUTOR_FILES) {
    try {
      await access(path.join(root, relativePath));
    } catch {
      throw new Error(`executor root is missing ${relativePath}: ${root}`);
    }
  }

  return root;
}

export async function readExecutorPackage(executorRoot) {
  try {
    const raw = await readFile(path.join(path.resolve(executorRoot), "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return {
      name: parsed.name || null,
      version: parsed.version || null,
    };
  } catch {
    return {
      name: null,
      version: null,
    };
  }
}

export async function executorMetadata(executorRoot) {
  const root = await assertExecutorRoot(executorRoot);
  const pkg = await readExecutorPackage(root);
  return {
    root,
    packageName: pkg.name,
    version: pkg.version,
  };
}
