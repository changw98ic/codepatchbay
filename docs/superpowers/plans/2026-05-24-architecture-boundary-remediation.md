# Architecture Boundary Remediation Implementation Plan

> **旧执行内核注释（2026-06-02）：** 本文中的 `bridges/run-phase.mjs`
> 引用属于已删除的旧执行内核。本文仅作历史方案参考；当前执行入口是
> `cpb hub-orch start`，执行内核是 Hub queue worker 调用 `runJob` / `runJobWithServices`。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate the highest-risk architecture defects found in the read-only review: unsafe ACP imports, ACP pool cross-root reuse, fragmented runtime roots, and weak boundary tests.

**Architecture:** Use a staged remediation instead of a broad rewrite. First make existing modules import-safe and root-isolated, then introduce a shared runtime-root query surface, then tighten architecture tests so the contract in `docs/architecture/runtime-boundaries.md` is mechanically enforced.

**Tech Stack:** Node.js ESM, `node:test`, existing Fastify/server services, existing `cpb-task` and Hub runtime-root model. No new dependencies.

---

## Requirements Summary

- Keep current CLI/API behavior compatible.
- Do not change event JSONL format.
- Do not remove legacy `cpb-task` fallback in the first pass.
- No new npm dependencies.
- Preserve current dirty worktree changes; do not revert unrelated edits.
- Lock each architectural remediation with regression tests before implementation.

## Current Evidence

- `server/services/acp-pool.js:5` imports `../../runtime/acp-client.mjs`.
- `runtime/acp-client.mjs:1051` performs a top-level `realpathSync(process.argv[1])` direct-run check; importing through `node -e` fails when `process.argv[1]` is absent.
- `server/services/acp-pool.js:717-732` keys managed pools by raw `hubRoot`, while many callers pass `hubRoot: undefined`.
- `server/services/event-store.js:48-50` resolves event roots through `dataRoot || CPB_PROJECT_RUNTIME_ROOT || legacy`.
- `server/services/job-run-report.js:21-30` scans only `listEventFiles(cpbRoot)` and misses Hub project runtime roots unless explicitly passed.
- `tests/architecture-boundaries.test.mjs:31-58` currently tests only a narrow subset of boundary rules.

## Acceptance Criteria

- Importing `server/services/acp-pool.js` from `node -e` exits 0.
- Two managed ACP pools created with different `cpbRoot` values do not share the same object or child-process environment.
- Job listing/report/projection APIs include jobs stored under registered Hub project runtime roots and legacy `cpb-task`.
- `phase-locator` and permission/read-observation helpers resolve event/checkpoint paths through the same runtime-root logic.
- Boundary tests fail if `core` imports outer layers, if executable CLI files execute on import, or if state readers silently ignore Hub runtime roots.
- Full `npm test` passes after each milestone.

## File Structure

- Modify `runtime/acp-client.mjs`: make CLI direct-run detection import-safe.
- Modify `server/services/acp-pool.js`: normalize pool runtime identity and avoid `undefined` singleton keys.
- Add `server/services/runtime-context.js`: shared runtime-root resolver for legacy + Hub project data roots.
- Modify `server/services/job-store.js`: expose root-complete job listing helper or route through runtime context.
- Modify `server/services/job-run-report.js`: include all relevant project runtime roots.
- Modify `server/services/job-projection.js`: remove local duplicate root scan and call the shared helper.
- Modify `server/services/phase-locator.js`: use shared runtime context for event/checkpoint/process paths.
- Modify `server/routes/tasks.js`: pass explicit runtime context into cancel/redirect/durable queries.
- Modify `tests/architecture-boundaries.test.mjs`: add import-safety and boundary contract tests.
- Add `tests/runtime-root-context.test.mjs`: regression coverage for legacy + Hub data root visibility.
- Modify `tests/acp-session-reuse.test.mjs`: add pool identity regression.

---

## Task 1: Lock ACP Import Safety

**Files:**
- Modify: `tests/architecture-boundaries.test.mjs`
- Modify: `runtime/acp-client.mjs`

- [ ] **Step 1: Add failing import-safety test**

Add this test to `tests/architecture-boundaries.test.mjs`:

```js
import { spawnSync } from "node:child_process";

test("server ACP pool imports without CLI argv side effects", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "await import('./server/services/acp-pool.js'); console.log('ok');",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});
```

- [ ] **Step 2: Verify the test fails before implementation**

Run:

```bash
node --test tests/architecture-boundaries.test.mjs
```

Expected before the fix: failure containing `ENOENT` and `process.argv[1]`/`undefined` path behavior.

- [ ] **Step 3: Make direct-run detection safe**

Replace the bottom direct-run check in `runtime/acp-client.mjs` with an import-safe helper:

```js
function isDirectRun(metaUrl, argvPath) {
  if (!argvPath) return false;
  try {
    return _realpathSync(_fileURLToPath(metaUrl)) === _realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Verify import safety passes**

Run:

```bash
node --test tests/architecture-boundaries.test.mjs
node --input-type=module -e "await import('./server/services/acp-pool.js'); console.log('ok')"
```

Expected: both commands exit 0.

---

## Task 2: Isolate Managed ACP Pool Identity

**Files:**
- Modify: `tests/acp-session-reuse.test.mjs`
- Modify: `server/services/acp-pool.js`

- [ ] **Step 1: Add failing singleton identity regression**

Add a test near the managed pool/reset tests:

```js
it("managed ACP pools are keyed by resolved cpbRoot and hubRoot", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const {
    getManagedAcpPool,
    resetManagedAcpPoolsForTests,
  } = await import("../server/services/acp-pool.js");

  const rootA = await mkdtemp(path.join(tmpdir(), "cpb-pool-a-"));
  const rootB = await mkdtemp(path.join(tmpdir(), "cpb-pool-b-"));

  resetManagedAcpPoolsForTests();
  const poolA = getManagedAcpPool({ cpbRoot: rootA, persistentProcesses: false });
  const poolB = getManagedAcpPool({ cpbRoot: rootB, persistentProcesses: false });

  assert.notEqual(poolA, poolB);
  assert.equal(poolA.cpbRoot, path.resolve(rootA));
  assert.equal(poolB.cpbRoot, path.resolve(rootB));
  resetManagedAcpPoolsForTests();
});
```

- [ ] **Step 2: Verify the test fails before implementation**

Run:

```bash
node --test tests/acp-session-reuse.test.mjs
```

Expected before the fix: `poolA` and `poolB` are the same object when callers omit `hubRoot`.

- [ ] **Step 3: Normalize pool runtime keys**

In `server/services/acp-pool.js`, add a helper close to `getPoolRuntime`:

```js
function resolvePoolRoots(hubRoot, cpbRoot) {
  const resolvedCpbRoot = path.resolve(cpbRoot || process.env.CPB_ROOT || path.join(__dirname, ".."));
  const resolvedHubRoot = path.resolve(hubRoot || resolveHubRoot(resolvedCpbRoot));
  return {
    cpbRoot: resolvedCpbRoot,
    hubRoot: resolvedHubRoot,
    key: `${resolvedHubRoot}\0${resolvedCpbRoot}`,
  };
}
```

Then update:

```js
export function getPoolRuntime(hubRoot, cpbRoot, opts = {}) {
  const roots = resolvePoolRoots(hubRoot, cpbRoot);
  if (!runtimes.has(roots.key)) {
    const persistentProcesses = opts.persistentProcesses ?? (
      opts.runner ? false : process.env.CPB_ACP_PERSISTENT_PROCESS !== "0"
    );
    runtimes.set(roots.key, new AcpPool({
      ...opts,
      cpbRoot: roots.cpbRoot,
      hubRoot: roots.hubRoot,
      persistentProcesses,
    }));
  }
  return runtimes.get(roots.key);
}

export function getManagedAcpPool({ cpbRoot, hubRoot, ...opts } = {}) {
  const roots = resolvePoolRoots(hubRoot, cpbRoot);
  const pool = getPoolRuntime(roots.hubRoot, roots.cpbRoot, opts);
  if (!managedViews.has(roots.key)) {
    managedViews.set(roots.key, managedView(pool));
  }
  return managedViews.get(roots.key);
}
```

Update `resetPoolRuntime` to accept either a raw key or a `{ cpbRoot, hubRoot }` object if existing callers need targeted reset. Keep `resetAllPoolRuntimes()` unchanged.

- [ ] **Step 4: Verify pool isolation**

Run:

```bash
node --test tests/acp-session-reuse.test.mjs
node --test tests/architecture-boundaries.test.mjs
```

Expected: all tests pass.

---

## Task 3: Introduce Shared Runtime Context

**Files:**
- Create: `server/services/runtime-context.js`
- Add: `tests/runtime-root-context.test.mjs`

- [ ] **Step 1: Write tests for legacy + Hub root discovery**

Create `tests/runtime-root-context.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("runtime context lists legacy and registered project data roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-runtime-context-"));
  const hubRoot = path.join(root, ".hub");
  const projectRuntimeRoot = path.join(root, ".hub", "projects", "demo");

  await mkdir(path.join(root, "cpb-task", "events", "demo"), { recursive: true });
  await mkdir(projectRuntimeRoot, { recursive: true });
  await writeFile(path.join(hubRoot, "projects.json"), JSON.stringify({
    version: 1,
    updatedAt: new Date(0).toISOString(),
    projects: {
      demo: {
        id: "demo",
        name: "demo",
        sourcePath: root,
        projectRoot: path.join(root, "cpb-task"),
        projectRuntimeRoot,
        enabled: true,
      },
    },
  }));

  const { listRuntimeDataRoots, resolveProjectDataRoot } = await import("../server/services/runtime-context.js");

  const roots = await listRuntimeDataRoots(root, { hubRoot });
  assert.deepEqual(roots.map((r) => r.dataRoot).sort(), [
    path.join(root, "cpb-task"),
    projectRuntimeRoot,
  ].sort());

  const demoRoot = await resolveProjectDataRoot(root, "demo", { hubRoot });
  assert.equal(demoRoot, projectRuntimeRoot);
});
```

- [ ] **Step 2: Verify the test fails because the module is missing**

Run:

```bash
node --test tests/runtime-root-context.test.mjs
```

Expected: module not found.

- [ ] **Step 3: Implement runtime context module**

Create `server/services/runtime-context.js`:

```js
import path from "node:path";
import { runtimeDataRoot } from "./runtime-root.js";
import { getProject, listProjects, resolveHubRoot } from "./hub-registry.js";

function uniqueRoots(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry?.dataRoot) continue;
    const dataRoot = path.resolve(entry.dataRoot);
    if (seen.has(dataRoot)) continue;
    seen.add(dataRoot);
    result.push({ ...entry, dataRoot });
  }
  return result;
}

export async function resolveProjectDataRoot(cpbRoot, project, { hubRoot, dataRoot } = {}) {
  if (dataRoot) return path.resolve(dataRoot);
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  try {
    const registered = await getProject(resolvedHubRoot, project);
    if (registered?.projectRuntimeRoot) return path.resolve(registered.projectRuntimeRoot);
  } catch {}
  return runtimeDataRoot(cpbRoot);
}

export async function listRuntimeDataRoots(cpbRoot, { hubRoot } = {}) {
  const entries = [{ kind: "legacy", dataRoot: runtimeDataRoot(cpbRoot), projectId: null }];
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  try {
    const projects = await listProjects(resolvedHubRoot);
    for (const project of projects) {
      if (project.projectRuntimeRoot) {
        entries.push({
          kind: "project",
          projectId: project.id,
          dataRoot: project.projectRuntimeRoot,
        });
      }
    }
  } catch {}
  return uniqueRoots(entries);
}
```

- [ ] **Step 4: Verify runtime context**

Run:

```bash
node --test tests/runtime-root-context.test.mjs
```

Expected: pass.

---

## Task 4: Make Job Queries Root-Complete

**Files:**
- Modify: `server/services/job-store.js`
- Modify: `server/services/job-run-report.js`
- Modify: `server/services/job-projection.js`
- Modify: `server/routes/tasks.js`
- Modify: `tests/runtime-root-context.test.mjs`

- [ ] **Step 1: Extend tests to prove Hub runtime jobs are visible**

In `tests/runtime-root-context.test.mjs`, add a second test that creates one legacy job and one project-runtime job, then asserts both are listed:

```js
test("job queries include legacy and Hub project runtime roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-runtime-jobs-"));
  const hubRoot = path.join(root, ".hub");
  const projectRuntimeRoot = path.join(hubRoot, "projects", "demo");
  const legacyEventDir = path.join(root, "cpb-task", "events", "demo");
  const hubEventDir = path.join(projectRuntimeRoot, "events", "demo");

  await mkdir(legacyEventDir, { recursive: true });
  await mkdir(hubEventDir, { recursive: true });
  await writeFile(path.join(hubRoot, "projects.json"), JSON.stringify({
    version: 1,
    updatedAt: new Date(0).toISOString(),
    projects: {
      demo: {
        id: "demo",
        name: "demo",
        sourcePath: root,
        projectRoot: path.join(root, "cpb-task"),
        projectRuntimeRoot,
        enabled: true,
      },
    },
  }));

  await writeFile(path.join(legacyEventDir, "job-20260524-000000-aaaaaa.jsonl"),
    JSON.stringify({ type: "job_created", jobId: "job-20260524-000000-aaaaaa", project: "demo", task: "legacy", workflow: "standard", ts: "2026-05-24T00:00:00Z" }) + "\n");
  await writeFile(path.join(hubEventDir, "job-20260524-000001-bbbbbb.jsonl"),
    JSON.stringify({ type: "job_created", jobId: "job-20260524-000001-bbbbbb", project: "demo", task: "hub", workflow: "standard", ts: "2026-05-24T00:00:01Z" }) + "\n");

  const { listJobsAcrossRuntimeRoots } = await import("../server/services/job-store.js");
  const jobs = await listJobsAcrossRuntimeRoots(root, { hubRoot });
  assert.deepEqual(jobs.map((j) => j.task).sort(), ["hub", "legacy"]);
});
```

- [ ] **Step 2: Implement shared cross-root job listing**

In `server/services/job-store.js`, import `listRuntimeDataRoots` and add:

```js
export async function listJobsAcrossRuntimeRoots(cpbRoot, options = {}) {
  const roots = await listRuntimeDataRoots(cpbRoot, options);
  const seen = new Set();
  const jobs = [];
  for (const root of roots) {
    const batch = await listJobs(cpbRoot, { dataRoot: root.kind === "legacy" ? undefined : root.dataRoot });
    for (const job of batch) {
      const key = `${job.project}/${job.jobId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
  }
  return jobs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
```

- [ ] **Step 3: Replace duplicate root scanning**

Update `server/services/job-projection.js`:

```js
import { listJobsAcrossRuntimeRoots } from "./job-store.js";

async function allJobs(cpbRoot) {
  return listJobsAcrossRuntimeRoots(cpbRoot);
}
```

Remove its local `listProjects`/`resolveHubRoot` scan once the shared helper is in place.

- [ ] **Step 4: Update durable task route**

In `server/services/executor.js`, replace:

```js
return listJobs(cpbRoot);
```

with:

```js
return listJobsAcrossRuntimeRoots(cpbRoot);
```

Adjust imports accordingly.

- [ ] **Step 5: Update report builder**

In `server/services/job-run-report.js`, either use `listJobsAcrossRuntimeRoots` directly or call `listEventFiles` once per runtime root from `listRuntimeDataRoots`. Preserve `eventLogPath` in `recentAnomalousJobs`.

- [ ] **Step 6: Verify root-complete job queries**

Run:

```bash
node --test tests/runtime-root-context.test.mjs
node --test tests/pipeline-contract.test.mjs
node --test tests/observer.test.mjs
```

Expected: all pass, and the new cross-root listing test sees both jobs.

---

## Task 5: Make Phase Locator and Permission Paths Runtime-Context Aware

**Files:**
- Modify: `server/services/phase-locator.js`
- Modify: `server/services/permission-matrix.js`
- Modify: `tests/phase-locator-contract.test.mjs`
- Modify: `tests/permission-react.test.mjs`

- [ ] **Step 1: Add locator regression for Hub project root**

Extend `tests/phase-locator-contract.test.mjs` with a case that registers a project runtime root and expects `locator.eventLogPath` to point into that root, not legacy `cpb-task`.

Expected assertion:

```js
assert.match(locator.eventLogPath, /projects\/test-proj\/events\/test-proj\/job-/);
```

- [ ] **Step 2: Update locator implementation**

In `server/services/phase-locator.js`, replace direct `runtimeDataRoot` and `runtimeDataPath` calls for job-specific paths with `resolveProjectDataRoot(cpbRoot, project, { hubRoot: process.env.CPB_HUB_ROOT })`.

For `eventLogPath`, compute:

```js
const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot: process.env.CPB_HUB_ROOT });
locator.eventLogPath = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
locator.processRegistryDir = path.join(dataRoot, "processes");
locator.stateFilePath = path.join(dataRoot, "state", `pipeline-${project}.json`);
```

- [ ] **Step 3: Update permission observation paths**

In `server/services/permission-matrix.js`, keep legacy paths allowed for compatibility, then add runtime-context-aware paths through a small optional context argument or explicit `dataRoot` parameter. Do not remove existing legacy allowances in this task.

- [ ] **Step 4: Verify locator and permission behavior**

Run:

```bash
node --test tests/phase-locator-contract.test.mjs
node --test tests/permission-react.test.mjs
```

Expected: all pass.

---

## Task 6: Tighten Architecture Boundary Tests

**Files:**
- Modify: `tests/architecture-boundaries.test.mjs`
- Modify: `docs/architecture/runtime-boundaries.md`

- [ ] **Step 1: Add import-contract tests**

Extend `tests/architecture-boundaries.test.mjs` to assert:

```js
test("CLI-style executable modules are import safe", async () => {
  const modules = [
    "./runtime/acp-client.mjs",
    "./bridges/run-phase.mjs",
    "./bridges/run-pipeline.mjs",
  ];

  for (const mod of modules) {
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(mod)}); console.log('ok')`,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `${mod}: ${result.stderr || result.stdout}`);
  }
});
```

- [ ] **Step 2: Add explicit exception list for layer imports**

Represent temporary exceptions in the test instead of leaving them implicit:

```js
const ALLOWED_SERVER_RUNTIME_IMPORTS = new Set([
  "server/services/acp-pool.js",
]);
```

Then fail any new `server/** -> runtime/**` import not in the set. Add a comment that this exception must be removed after ACP client/session split.

- [ ] **Step 3: Document the transition state**

Update `docs/architecture/runtime-boundaries.md` with a short "Current debt register" section:

```md
## Current Debt Register

- `server/services/acp-pool.js` still imports the ACP client implementation for managed in-process sessions. This is allowed only until ACP client core is split from the executable wrapper.
- Runtime-root reads must go through `server/services/runtime-context.js`; direct legacy-only `runtimeDataPath(cpbRoot, "events", ...)` reads are compatibility-only.
```

- [ ] **Step 4: Verify boundary tests**

Run:

```bash
node --test tests/architecture-boundaries.test.mjs
```

Expected: pass.

---

## Task 7: Split ACP Client Core From Executable Wrapper

**Files:**
- Create: `server/services/acp-client-core.js` or `runtime/acp-client-core.mjs`
- Modify: `runtime/acp-client.mjs`
- Modify: `server/services/acp-pool.js`
- Modify: `bridges/acp-client.mjs`
- Modify: `tests/architecture-boundaries.test.mjs`
- Modify: `tests/acp-session-reuse.test.mjs`

- [ ] **Step 1: Choose the split location**

Use `runtime/acp-client-core.mjs` if the team wants ACP client implementation to remain runtime-owned. Use `server/services/acp-client-core.js` if the managed pool is considered the owner of in-process ACP sessions. Make this decision once and record it in `docs/architecture/runtime-boundaries.md`.

Recommended choice for minimal churn: `runtime/acp-client-core.mjs`, then keep the temporary server-to-runtime exception explicit until a later adapter migration.

- [ ] **Step 2: Move exports without behavior changes**

Move `AcpClient`, `parseToolPolicy`, `resolveWriteAllowPaths`, and `resolveAgentCommand` into the core module. Leave `main()`, CLI parsing, stdin reading, and the direct-run guard in `runtime/acp-client.mjs`.

- [ ] **Step 3: Update import sites**

Update `server/services/acp-pool.js` to import from the new core module. Update `bridges/acp-client.mjs` to continue exporting the same public symbols from `runtime/acp-client.mjs` or directly from the core module.

- [ ] **Step 4: Verify no behavior changed**

Run:

```bash
node --test tests/acp-session-reuse.test.mjs
node --test tests/permission-react.test.mjs
node --test tests/architecture-boundaries.test.mjs
```

Expected: all pass.

---

## Task 8: Full Verification and Cleanup

**Files:**
- Modify only files touched by previous tasks.

- [ ] **Step 1: Run full Node test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Build web UI if package state changed**

Run only if package scripts or web-facing routes changed:

```bash
npm run build:web
```

Expected: build exits 0.

- [ ] **Step 3: Static scan for legacy-only root reads**

Run:

```bash
rg -n 'runtimeDataPath\\(cpbRoot, "events"|runtimeDataRoot\\(cpbRoot\\)' server runtime bridges cli core -g '*.js' -g '*.mjs'
```

Expected: remaining matches are either compatibility fallbacks, tests, or documented exceptions in `docs/architecture/runtime-boundaries.md`.

- [ ] **Step 4: Final architecture smoke probes**

Run:

```bash
node --input-type=module -e "await import('./server/services/acp-pool.js'); console.log('import-ok')"
node --input-type=module -e "const m = await import('./server/services/runtime-context.js'); console.log(Object.keys(m).sort().join(','))"
```

Expected: both commands exit 0.

---

## Risks and Mitigations

- **Risk:** Runtime-root changes hide legacy jobs.  
  **Mitigation:** Keep legacy `cpb-task` first-class in `listRuntimeDataRoots`; dedupe by `project/jobId`.

- **Risk:** ACP pool key change leaves existing persistent processes unmanaged.  
  **Mitigation:** Run `resetManagedAcpPoolsForTests()` in tests and keep production `resetAllPoolRuntimes()` semantics unchanged.

- **Risk:** Splitting `runtime/acp-client.mjs` accidentally changes CLI behavior.  
  **Mitigation:** Import-safety tests plus existing ACP session reuse tests must pass before and after the split.

- **Risk:** Boundary tests become too strict during migration.  
  **Mitigation:** Use a small named exception list with comments and remove entries only after the relevant task lands.

## Commit Sequence

1. `Prevent ACP client imports from executing CLI-only paths`
2. `Isolate managed ACP pools by resolved runtime roots`
3. `Centralize runtime root discovery for job state`
4. `Read jobs across legacy and Hub runtime roots`
5. `Resolve phase locator paths through runtime context`
6. `Enforce architecture boundary import contracts`
7. `Split ACP client core from executable wrapper`

Each commit should follow the repository Lore Commit Protocol with `Tested:` and `Not-tested:` trailers.

## Definition of Done

- `npm test` passes.
- `node --test tests/architecture-boundaries.test.mjs` passes.
- `node --test tests/runtime-root-context.test.mjs` passes.
- Import probe for `server/services/acp-pool.js` exits 0.
- Cross-root job listing sees both legacy and Hub jobs.
- `docs/architecture/runtime-boundaries.md` documents any remaining temporary exception.
