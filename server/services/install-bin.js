import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertExecutorRoot } from "./executor-root.js";

export function shellQuoteSingle(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function renderLauncher({ executorRoot, runtimeRootDefault }) {
  const quotedRoot = shellQuoteSingle(executorRoot);
  const escapedDefault = runtimeRootDefault;

  return `#!/bin/sh
set -euo pipefail

: "\${CPB_HOME:=\$HOME/.cpb}"
: "\${CPB_ROOT:=${escapedDefault}}"
export CPB_ROOT

if [ -z "\${CPB_EXECUTOR_ROOT:-}" ]; then
  CPB_EXECUTOR_ROOT=${quotedRoot}
  export CPB_EXECUTOR_ROOT
fi

if [ ! -x "\${CPB_EXECUTOR_ROOT}/cpb" ]; then
  echo "cpb: executor not found at \${CPB_EXECUTOR_ROOT}/cpb" >&2
  exit 127
fi

exec "\${CPB_EXECUTOR_ROOT}/cpb" "$@"
`;
}

export async function resolveInstallBinExecutorRoot({ executorRootOption, scriptRoot, env }) {
  if (executorRootOption && executorRootOption !== "current") {
    return assertExecutorRoot(executorRootOption);
  }

  if (executorRootOption === "current") {
    const cpbHome = env.CPB_HOME || path.join(env.HOME || "/tmp", ".cpb");
    const currentLink = path.join(cpbHome, "current");
    let resolved;
    try {
      resolved = await stat(currentLink);
    } catch {
      throw new Error(
        `No current CPB release selected at ${currentLink}. Install or select a release before using --executor-root current.`,
      );
    }
    let realPath;
    try {
      const { realpath } = await import("node:fs/promises");
      realPath = await realpath(currentLink);
    } catch {
      throw new Error(
        `No current CPB release selected at ${currentLink}. Install or select a release before using --executor-root current.`,
      );
    }
    return assertExecutorRoot(realPath);
  }

  if (env.CPB_EXECUTOR_ROOT) {
    return assertExecutorRoot(env.CPB_EXECUTOR_ROOT);
  }

  return assertExecutorRoot(scriptRoot);
}

export async function installBin({ target, executorRoot }) {
  const resolvedExecutorRoot = await assertExecutorRoot(executorRoot);
  const resolvedTarget = path.resolve(target);
  const cpbHome = process.env.CPB_HOME || path.join(process.env.HOME || "/tmp", ".cpb");
  const runtimeRootDefault = `\${CPB_HOME:-\$HOME/.cpb}`;

  const launcherContent = renderLauncher({
    executorRoot: resolvedExecutorRoot,
    runtimeRootDefault,
  });

  const targetDir = path.dirname(resolvedTarget);
  await mkdir(targetDir, { recursive: true });

  const tmpFile = path.join(targetDir, `.cpb-launcher.tmp-${Date.now()}-${process.pid}`);
  await writeFile(tmpFile, launcherContent, "utf8");
  await chmod(tmpFile, 0o755);
  await rename(tmpFile, resolvedTarget);

  return {
    target: resolvedTarget,
    executorRoot: resolvedExecutorRoot,
    runtimeRootDefault,
    launcherVersion: 1,
  };
}
