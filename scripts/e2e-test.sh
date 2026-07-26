#!/bin/sh
# Canonical manual E2E entrypoint. All local-state and GitHub write authority
# checks live in scripts/e2e-npm-pack.ts so shell and Node paths cannot drift.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
COMPILED_ENTRY="${SOURCE_ROOT}/dist/scripts/e2e-npm-pack.js"

if [ "$#" -ne 0 ]; then
  echo "Positional targets are forbidden. Set CPB_E2E_GITHUB_REPO, CPB_E2E_ISSUE_NUMBER, CPB_E2E_LABEL, and the exact ACK environment instead." >&2
  exit 2
fi

if [ "${CPB_E2E_ALLOW_DESTRUCTIVE:-}" != "1" ]; then
  echo "Set CPB_E2E_ALLOW_DESTRUCTIVE=1 only for a dedicated disposable Hub root"
  exit 1
fi

cd "${SOURCE_ROOT}"
unset NODE_OPTIONS NODE_PATH
NODE_COMMAND="$(command -v node)"
NODE_REAL="$("${NODE_COMMAND}" -e 'process.stdout.write(require("node:fs").realpathSync(process.execPath))')"

exec "${NODE_REAL}" --input-type=module - "${SOURCE_ROOT}" "${COMPILED_ENTRY}" <<'NODE_BOOTSTRAP'
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const sourceRoot = realpathSync(process.argv[2]);
const compiledEntry = path.resolve(process.argv[3]);
const inheritedPath = process.env.PATH;
const clean = { ...process.env };
for (const key of Object.keys(clean)) {
  const upper = key.toUpperCase();
  if (
    /^NPM_CONFIG_/i.test(key)
    || /^CPB_BUILD_/i.test(key)
    || ["BASH_ENV", "ENV", "SHELLOPTS", "CDPATH", "GLOBIGNORE", "NODE_OPTIONS", "NODE_PATH"].includes(upper)
  ) {
    delete clean[key];
  }
}

const bootstrapRoot = mkdtempSync(path.join(os.tmpdir(), "cpb-e2e-bootstrap-"));
const buildLocks = path.join(bootstrapRoot, "build-locks");
mkdirSync(buildLocks, { mode: 0o700 });
const buildEnv = {
  ...clean,
  PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
  CPB_BUILD_LOCK_ROOT: buildLocks,
};
const build = spawnSync(process.execPath, [path.join(sourceRoot, "scripts", "build-output.mjs"), "node"], {
  cwd: sourceRoot,
  env: buildEnv,
  stdio: "inherit",
});

let cleanupError = null;
try {
  rmdirSync(buildLocks);
  rmdirSync(bootstrapRoot);
} catch (error) {
  cleanupError = error;
}
if (build.error || build.status !== 0 || cleanupError) {
  if (cleanupError) {
    console.error(`E2E bootstrap cleanup failed; recovery path preserved: ${bootstrapRoot}`);
    console.error(cleanupError);
  }
  if (build.error) console.error(build.error);
  process.exit(build.status || 1);
}

const e2eEnv = { ...clean };
if (inheritedPath === undefined) delete e2eEnv.PATH;
else e2eEnv.PATH = inheritedPath;
const e2e = spawnSync(process.execPath, [compiledEntry], {
  cwd: sourceRoot,
  env: e2eEnv,
  stdio: "inherit",
});
if (e2e.error) throw e2e.error;
if (e2e.signal) {
  console.error(`E2E terminated by signal ${e2e.signal}`);
  process.exit(1);
}
process.exit(e2e.status || 0);
NODE_BOOTSTRAP
