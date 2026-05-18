# CPB Executable App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn CPB from "scripts inside the project repo" into a versioned executable app whose running jobs are not affected by branch switches, merges, or source edits in the project repo.

**Architecture:** Keep two roots. `CPB_EXECUTOR_ROOT` points to an installed, versioned CPB app release. `CPB_ROOT` points to project state such as queue data, logs, worktrees, leases, and project wiki. Running jobs keep using the executor version they started with; the supervisor can auto-upgrade safely only between jobs.

**Tech Stack:** Bash CLI launcher, Node.js ESM services, npm package installation, git worktrees, tmux supervisors, existing CPB hub/job/event stores.

---

## Human Version

Current problem:

```text
/Users/chengwen/dev/flow
  project code
  CPB scripts
  CPB server code
  task queue
  logs
  worktrees
```

This is risky because changing branches or merging code can change the CPB engine while tasks are running.

Target shape:

```text
~/.cpb/releases/0.2.0-20260518T101500Z
  cpb
  bridges/
  server/
  profiles/
  templates/
  wiki/system/
  release-manifest.json

~/.cpb/current -> ~/.cpb/releases/0.2.0-20260518T101500Z
~/.local/bin/cpb -> ~/.cpb/current/cpb

/Users/chengwen/dev/flow
  project code
  cpb-task/
  wiki/projects/flow/
```

Plain rule:

```text
CPB app lives in ~/.cpb.
Project data lives in the project.
Running jobs do not change engines mid-flight.
New jobs can use the newest engine after a safe checkpoint.
```

## Safety Contract

- A release directory is treated as immutable after build.
- `CPB_EXECUTOR_ROOT` is for CPB program files.
- `CPB_ROOT` is for project runtime state.
- A job records the executor release that created it.
- Recovery and retry default to the job's recorded executor.
- Auto-upgrade is allowed only after the current job reaches a terminal state and before the next job is claimed.
- Auto-upgrade should restart or re-exec the supervisor instead of hot-swapping modules in-process.
- Release garbage collection must not delete a release used by an active supervisor or in-progress job.

## File Structure

Create:

- `server/services/release-store.js`: release paths, manifest read/write, current symlink management, release listing, release usage checks.
- `bridges/install-bin.mjs`: installs a stable `cpb` launcher into a bin directory.
- `tests/executable-app.test.mjs`: release build, launcher, current switching, supervisor pinning, and auto-upgrade boundary tests.
- `docs/cpb-executable-app.md`: user-facing operating guide.

Modify:

- `bridges/install-release.mjs`: evolve from copy-only install into release build with dependency installation and manifest checks.
- `server/services/executor-root.js`: expose release manifest validation helpers.
- `bridges/supervisor-loop.mjs`: support pinned executor and safe upgrade checkpoint.
- `server/services/supervisor.js`: stop claiming new jobs when a release upgrade is pending.
- `bridges/project-worker.mjs`: keep passing explicit executor root to every pipeline run.
- `bridges/run-pipeline.mjs`: keep job executor metadata deterministic and avoid surprising global env mutation where possible.
- `server/services/job-store.js`: preserve executor metadata on `job_created`.
- `server/services/event-store.js`: materialize executor metadata for old and new jobs.
- `cpb`: add `release build`, `install-bin`, `releases list`, `current`, `use`, `release doctor`, and `release gc`.

## Task 1: Release Store Helpers

**Files:**
- Create: `server/services/release-store.js`
- Modify: `server/services/executor-root.js`
- Test: `tests/executable-app.test.mjs`

- [ ] **Step 1: Write tests for release path and manifest behavior**

Add tests covering:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  releaseRootFor,
  validateReleaseId,
  writeReleaseManifest,
  readReleaseManifest,
  setCurrentRelease,
  getCurrentRelease,
} from "../server/services/release-store.js";

test("release ids reject path traversal", () => {
  assert.equal(validateReleaseId("0.2.0-20260518"), "0.2.0-20260518");
  assert.throws(() => validateReleaseId("../main"), /Invalid release id/);
  assert.throws(() => validateReleaseId("bad/name"), /Invalid release id/);
});

test("current release resolves to the selected release realpath", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-releases-"));
  const releaseRoot = releaseRootFor(root, "0.2.0-test");
  await writeReleaseManifest(releaseRoot, {
    id: "0.2.0-test",
    version: "0.2.0",
    gitCommit: "abc123",
    builtAt: "2026-05-18T00:00:00Z",
    sourceRoot: "/src",
  });

  await setCurrentRelease(root, "0.2.0-test");
  const current = await getCurrentRelease(root);
  assert.equal(current.id, "0.2.0-test");
  assert.equal(current.releaseRoot, releaseRoot);

  const manifest = await readReleaseManifest(releaseRoot);
  assert.equal(manifest.gitCommit, "abc123");
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
node --test tests/executable-app.test.mjs
```

Expected:

```text
not ok ... Cannot find module '../server/services/release-store.js'
```

- [ ] **Step 3: Implement `release-store.js`**

Implement these exported functions:

```javascript
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

export function validateReleaseId(id) {
  if (!/^[a-zA-Z0-9._-]+$/.test(String(id || ""))) {
    throw new Error(`Invalid release id: ${id}`);
  }
  return id;
}

export function releaseRootFor(releasesRoot, id) {
  return path.join(path.resolve(releasesRoot), "releases", validateReleaseId(id));
}

export async function writeReleaseManifest(releaseRoot, manifest) {
  await mkdir(releaseRoot, { recursive: true });
  const normalized = {
    id: validateReleaseId(manifest.id),
    version: manifest.version || null,
    gitCommit: manifest.gitCommit || null,
    builtAt: manifest.builtAt || new Date().toISOString(),
    sourceRoot: manifest.sourceRoot || null,
  };
  await writeFile(path.join(releaseRoot, "release-manifest.json"), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function readReleaseManifest(releaseRoot) {
  const raw = await readFile(path.join(path.resolve(releaseRoot), "release-manifest.json"), "utf8");
  return JSON.parse(raw);
}

export async function setCurrentRelease(releasesRoot, id) {
  const root = path.resolve(releasesRoot);
  const target = releaseRootFor(root, id);
  const current = path.join(root, "current");
  const next = path.join(root, `.current-${process.pid}-${Date.now()}`);
  await symlink(target, next);
  await rm(current, { force: true, recursive: true });
  await rename(next, current);
  return target;
}

export async function getCurrentRelease(releasesRoot) {
  const currentLink = path.join(path.resolve(releasesRoot), "current");
  const releaseRoot = await realpath(currentLink);
  return {
    releaseRoot,
    ...(await readReleaseManifest(releaseRoot)),
  };
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
node --test tests/executable-app.test.mjs
```

Expected:

```text
# pass 2
# fail 0
```

## Task 2: Build Immutable Release

**Files:**
- Modify: `bridges/install-release.mjs`
- Modify: `cpb`
- Test: `tests/executable-app.test.mjs`

- [ ] **Step 1: Add a failing test that build excludes project state and includes server deps**

Extend `tests/executable-app.test.mjs` with a test that:

```javascript
import { access, mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";

test("release build copies executor assets without project runtime state", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-app-build-"));
  const result = spawnSync("./cpb", [
    "release",
    "build",
    "--name",
    "test-release",
    "--dest-root",
    tmp,
    "--json",
  ], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.releaseRoot, /test-release$/);

  await access(path.join(payload.releaseRoot, "cpb"));
  await access(path.join(payload.releaseRoot, "bridges", "run-pipeline.mjs"));
  await access(path.join(payload.releaseRoot, "server"));
  await access(path.join(payload.releaseRoot, "release-manifest.json"));

  await assert.rejects(() => stat(path.join(payload.releaseRoot, "cpb-task")));
  await assert.rejects(() => stat(path.join(payload.releaseRoot, ".omx")));
  await assert.rejects(() => stat(path.join(payload.releaseRoot, "omx_wiki")));
});
```

- [ ] **Step 2: Run the test and confirm it fails on missing `release build`**

Run:

```bash
node --test tests/executable-app.test.mjs
```

Expected:

```text
not ok ... unknown release command: build
```

- [ ] **Step 3: Rename command behavior from install to build while keeping install as alias**

In `cpb`, route both commands:

```bash
cmd_release() {
  local sub="${1:-}"
  [ $# -gt 0 ] && shift || true
  case "$sub" in
    build|install) CPB_ROOT="$CPB_ROOT" CPB_EXECUTOR_ROOT="$CPB_EXECUTOR_ROOT" node "$CPB_EXECUTOR_ROOT/bridges/install-release.mjs" "$@" ;;
    *) echo "unknown release command: $sub"; return 1 ;;
  esac
}
```

- [ ] **Step 4: Make `install-release.mjs` build a release directory**

Keep the existing copy filters. Add manifest fields:

```javascript
{
  id,
  version: packageJson.version || null,
  gitCommit,
  builtAt: new Date().toISOString(),
  sourceRoot,
  releaseRoot,
  appLayoutVersion: 1
}
```

Keep excluding:

```text
.git
node_modules
cpb-task
.omx
omx_wiki
wiki/projects except wiki/projects/_template
```

- [ ] **Step 5: Install server dependencies during build**

After copying `server/`, run:

```javascript
import { spawnSync } from "node:child_process";

const npm = spawnSync("npm", ["install", "--silent", "--omit=dev"], {
  cwd: path.join(releaseRoot, "server"),
  encoding: "utf8",
});
if (npm.status !== 0) {
  throw new Error(`npm install failed in release server: ${npm.stderr || npm.stdout}`);
}
```

If `server/package-lock.json` is reliable, prefer:

```javascript
spawnSync("npm", ["ci", "--silent", "--omit=dev"], ...)
```

- [ ] **Step 6: Run release build tests**

Run:

```bash
node --test tests/executable-app.test.mjs tests/executor-release.test.mjs
```

Expected:

```text
# fail 0
```

## Task 3: Stable Launcher Install

**Files:**
- Create: `bridges/install-bin.mjs`
- Modify: `cpb`
- Test: `tests/executable-app.test.mjs`

- [ ] **Step 1: Add a failing launcher test**

Add:

```javascript
test("installed launcher executes the current release with separate CPB_ROOT", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-launcher-"));
  const binDir = path.join(tmp, "bin");
  const appRoot = path.join(tmp, "app");
  const projectRoot = path.join(tmp, "project");
  await mkdir(binDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const build = spawnSync("./cpb", [
    "release",
    "build",
    "--name",
    "launcher-release",
    "--dest-root",
    appRoot,
    "--json",
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const install = spawnSync("./cpb", [
    "install-bin",
    "--bin-dir",
    binDir,
    "--app-root",
    appRoot,
    "--json",
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const launcher = path.join(binDir, "cpb");
  const result = spawnSync(launcher, ["current", "--json"], {
    cwd: projectRoot,
    env: { ...process.env, CPB_ROOT: projectRoot },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.current.id, "launcher-release");
});
```

- [ ] **Step 2: Run the launcher test and confirm it fails**

Run:

```bash
node --test tests/executable-app.test.mjs
```

Expected:

```text
not ok ... unknown command: install-bin
```

- [ ] **Step 3: Implement `bridges/install-bin.mjs`**

Create a launcher script like:

```bash
#!/usr/bin/env bash
set -euo pipefail
CPB_APP_ROOT="${CPB_APP_ROOT:-$HOME/.cpb}"
CPB_CURRENT="$CPB_APP_ROOT/current"
if [ ! -e "$CPB_CURRENT/cpb" ]; then
  echo "CPB current release not found: $CPB_CURRENT" >&2
  exit 1
fi
export CPB_EXECUTOR_ROOT="$(cd "$CPB_CURRENT" && pwd -P)"
export CPB_ROOT="${CPB_ROOT:-$PWD}"
exec "$CPB_EXECUTOR_ROOT/cpb" "$@"
```

`install-bin.mjs` should:

- parse `--bin-dir`
- parse `--app-root`
- write executable `cpb` into the bin dir
- return JSON with `binPath`, `appRoot`, and `current`

- [ ] **Step 4: Add `cpb install-bin` command**

In `cpb`:

```bash
cmd_install_bin() {
  CPB_ROOT="$CPB_ROOT" CPB_EXECUTOR_ROOT="$CPB_EXECUTOR_ROOT" node "$CPB_EXECUTOR_ROOT/bridges/install-bin.mjs" "$@"
}
```

Route:

```bash
install-bin) shift; cmd_install_bin "$@" ;;
```

- [ ] **Step 5: Run launcher tests**

Run:

```bash
node --test tests/executable-app.test.mjs
```

Expected:

```text
# fail 0
```

## Task 4: Current, Use, And List Commands

**Files:**
- Modify: `cpb`
- Modify: `server/services/release-store.js`
- Test: `tests/executable-app.test.mjs`

- [ ] **Step 1: Add tests for current release switching**

Add:

```javascript
test("cpb use switches current release for future commands", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-use-"));

  for (const name of ["v1", "v2"]) {
    const build = spawnSync("./cpb", [
      "release",
      "build",
      "--name",
      name,
      "--dest-root",
      tmp,
      "--json",
    ], { cwd: path.resolve("."), encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr || build.stdout);
  }

  const use = spawnSync("./cpb", ["use", "v2", "--app-root", tmp, "--json"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.equal(use.status, 0, use.stderr || use.stdout);

  const current = spawnSync("./cpb", ["current", "--app-root", tmp, "--json"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.equal(current.status, 0, current.stderr || current.stdout);
  assert.equal(JSON.parse(current.stdout).current.id, "v2");
});
```

- [ ] **Step 2: Implement release listing and current helpers**

Add exports:

```javascript
export async function listReleases(releasesRoot) {
  const dir = path.join(path.resolve(releasesRoot), "releases");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const releases = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const releaseRoot = path.join(dir, entry.name);
    releases.push({ releaseRoot, ...(await readReleaseManifest(releaseRoot)) });
  }
  return releases.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
```

- [ ] **Step 3: Add CLI commands**

Add these commands:

```bash
cpb current [--app-root DIR] [--json]
cpb use <release-id> [--app-root DIR] [--json]
cpb releases list [--app-root DIR] [--json]
```

Behavior:

- `current` prints selected release.
- `use` atomically switches `current`.
- `releases list` prints all manifests.

- [ ] **Step 4: Run command tests**

Run:

```bash
node --test tests/executable-app.test.mjs
```

Expected:

```text
# fail 0
```

## Task 5: Supervisor Auto-Upgrade Boundary

**Files:**
- Modify: `bridges/supervisor-loop.mjs`
- Modify: `server/services/supervisor.js`
- Modify: `server/services/job-store.js`
- Modify: `server/services/event-store.js`
- Test: `tests/executable-app.test.mjs`

- [ ] **Step 1: Add a test for "upgrade after current job, before next job"**

The test should model this sequence:

```text
1. supervisor starts with release v1
2. job A is claimed and records v1
3. current switches to v2 while job A is running
4. supervisor finishes job A with v1
5. supervisor notices v2 before claiming job B
6. supervisor exits with a documented restart-needed code or re-execs using v2
7. job B records v2
```

Represent the behavior with a unit-level helper first:

```javascript
test("supervisor upgrade checkpoint waits until no job is active", async () => {
  const active = { inProgress: 1, supervisorExecutorRoot: "/app/v1", currentExecutorRoot: "/app/v2" };
  const idle = { inProgress: 0, supervisorExecutorRoot: "/app/v1", currentExecutorRoot: "/app/v2" };

  assert.equal(shouldUpgradeSupervisor(active), false);
  assert.equal(shouldUpgradeSupervisor(idle), true);
});
```

- [ ] **Step 2: Implement checkpoint helper**

Add a helper in `server/services/supervisor.js`:

```javascript
export function shouldUpgradeSupervisor({ inProgress, supervisorExecutorRoot, currentExecutorRoot }) {
  return Number(inProgress || 0) === 0
    && Boolean(supervisorExecutorRoot)
    && Boolean(currentExecutorRoot)
    && path.resolve(supervisorExecutorRoot) !== path.resolve(currentExecutorRoot);
}
```

- [ ] **Step 3: Add supervisor behavior**

At the top of each claim loop:

```text
if no active job for this supervisor/project
and current release differs from this supervisor's executorRoot
then do not claim another job
then exit/re-exec with a clear upgrade event
```

Prefer exit/restart over hot-swapping:

```text
exit code 75 means "restart supervisor on current release"
```

- [ ] **Step 4: Record upgrade event**

Write an event similar to:

```json
{
  "type": "supervisor_upgrade_checkpoint",
  "fromExecutorRoot": "/app/v1",
  "toExecutorRoot": "/app/v2",
  "reason": "current_release_changed_between_jobs"
}
```

- [ ] **Step 5: Run supervisor tests**

Run:

```bash
node --test tests/executable-app.test.mjs tests/supervisor.test.mjs tests/job-store.test.mjs
```

Expected:

```text
# fail 0
```

## Task 6: Retry And Recovery Executor Policy

**Files:**
- Modify: `cpb`
- Modify: `server/services/supervisor.js`
- Modify: `bridges/run-pipeline.mjs`
- Test: `tests/executable-app.test.mjs`

- [ ] **Step 1: Add tests for retry default and opt-in upgrade**

Required behavior:

```text
cpb retry flow job-123
  uses job-123 recorded executor

cpb retry flow job-123 --use-current-executor
  records an explicit executor override event
  uses current release for the retry
```

Test with assertions against materialized job state:

```javascript
assert.equal(defaultRetry.executor.root, oldReleaseRoot);
assert.equal(upgradedRetry.executor.root, newReleaseRoot);
assert.equal(upgradedRetry.executorOverride.reason, "use_current_executor");
```

- [ ] **Step 2: Implement CLI flag parsing**

Add `--use-current-executor` only to retry/recover paths. Do not apply it to an already running phase.

- [ ] **Step 3: Persist override event**

Use an event shape:

```json
{
  "type": "executor_override_requested",
  "jobId": "job-123",
  "fromExecutorRoot": "/app/v1",
  "toExecutorRoot": "/app/v2",
  "reason": "use_current_executor"
}
```

- [ ] **Step 4: Run retry/recovery tests**

Run:

```bash
node --test tests/executable-app.test.mjs tests/job-store.test.mjs tests/run-pipeline-boundary.test.mjs
```

Expected:

```text
# fail 0
```

## Task 7: Release Doctor And Garbage Collection

**Files:**
- Modify: `cpb`
- Modify: `server/services/release-store.js`
- Test: `tests/executable-app.test.mjs`

- [ ] **Step 1: Add doctor tests**

`cpb release doctor <release-id>` should fail if required files are missing:

```text
cpb
bridges/common.sh
bridges/run-pipeline.mjs
server/services/job-store.js
package.json
release-manifest.json
```

- [ ] **Step 2: Implement doctor command**

The command should return JSON:

```json
{
  "ok": true,
  "release": {
    "id": "v1",
    "releaseRoot": "/Users/chengwen/.cpb/releases/v1"
  },
  "missing": []
}
```

- [ ] **Step 3: Add dry-run GC tests**

`cpb release gc --dry-run` should:

- keep current release
- keep releases referenced by in-progress jobs
- keep releases referenced by live supervisors
- report old unused releases as removable

Expected JSON:

```json
{
  "wouldRemove": ["old-unused-release"],
  "kept": [
    { "id": "current-release", "reason": "current" },
    { "id": "active-job-release", "reason": "in_progress_job" }
  ]
}
```

- [ ] **Step 4: Run release maintenance tests**

Run:

```bash
node --test tests/executable-app.test.mjs
```

Expected:

```text
# fail 0
```

## Task 8: User-Facing Docs

**Files:**
- Create: `docs/cpb-executable-app.md`

- [ ] **Step 1: Write the operating guide**

The guide must include:

````markdown
# CPB Executable App

CPB is installed as a versioned app under `~/.cpb`. Projects keep their own data under `CPB_ROOT`.

## Install

```bash
./cpb release build --name 0.2.0-local --dest-root ~/.cpb --json
./cpb install-bin --bin-dir ~/.local/bin --app-root ~/.cpb --json
cpb use 0.2.0-local
```

## Start

```bash
cd /Users/chengwen/dev/flow
cpb supervisor
```

## Upgrade

```bash
./cpb release build --name 0.2.1-local --dest-root ~/.cpb --json
cpb use 0.2.1-local
```

The running job finishes on its original release. The supervisor upgrades between jobs.

## Rollback

```bash
cpb use 0.2.0-local
```

Restart the supervisor if immediate rollback is needed before the next job.
````

- [ ] **Step 2: Include failure recovery**

Document:

- `cpb current --json`
- `cpb releases list --json`
- `cpb release doctor <release-id>`
- `cpb release gc --dry-run`
- `git worktree prune` if a merge preview is killed by `SIGKILL`

## Task 9: Final Verification

**Files:**
- All touched implementation and test files

- [ ] **Step 1: Syntax checks**

Run:

```bash
node --check bridges/install-release.mjs
node --check bridges/install-bin.mjs
node --check server/services/release-store.js
node --check server/services/executor-root.js
bash -n cpb
```

Expected: all commands exit `0`.

- [ ] **Step 2: Focused tests**

Run:

```bash
node --test tests/executable-app.test.mjs tests/executor-release.test.mjs tests/project-worker.test.mjs tests/supervisor.test.mjs tests/job-store.test.mjs
```

Expected:

```text
# fail 0
```

- [ ] **Step 3: Existing regression tests**

Run:

```bash
node --test tests/*.mjs
bash tests/cpb-jobs.test.sh
bash tests/cpb-bridges.test.sh
bash tests/cpb-variant-env.test.sh
```

Expected:

```text
all tests pass
```

- [ ] **Step 4: Manual smoke test**

Run:

```bash
tmp="$(mktemp -d)"
./cpb release build --name smoke-app --dest-root "$tmp/app" --json
./cpb install-bin --bin-dir "$tmp/bin" --app-root "$tmp/app" --json
CPB_ROOT="$tmp/project" "$tmp/bin/cpb" current --json
CPB_ROOT="$tmp/project" "$tmp/bin/cpb" knowledge policy --json
```

Expected:

```text
current release is smoke-app
knowledge policy command succeeds
```

- [ ] **Step 5: Diff hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected:

```text
git diff --check exits 0
status shows only intended files plus pre-existing unrelated dirty files
```

## Execution Notes

- Keep the current `cpb release install` as an alias for `cpb release build` during transition.
- Do not delete or move existing `cpb-task` data.
- Do not change active queue state during this implementation.
- Do not make supervisor hot-swap code in the same Node process.
- Prefer exit/restart at the between-job checkpoint.
- Keep all release commands JSON-capable for automation.

## Self-Review

Spec coverage:

- Executable app shape: covered by Tasks 2, 3, and 4.
- Project/app separation: covered by Tasks 1, 2, 3, and 9.
- Current job safety: covered by Task 5.
- Retry/recover policy: covered by Task 6.
- Upgrade and rollback: covered by Tasks 4, 5, and 8.
- Release cleanup: covered by Task 7.
- Verification: covered by Task 9.

Placeholder scan:

- No unresolved placeholder markers.
- No unresolved implementation-detail stubs.
- Every command has expected behavior.

Type consistency:

- `releaseRoot`, `releasesRoot`, `executorRoot`, and `CPB_EXECUTOR_ROOT` are used consistently.
- `current` always means selected release symlink, not current project root.
