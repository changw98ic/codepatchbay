# Plan: GitHub issue #26: P0.9a: Move CPB runtime state out of source tree into project runtime roots

URL: https://github.com/changw98ic/codepatchbay/issues/26

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: GitHub issue #26: P0.9a runtime roots
- **Timestamp**: 2026-05-20T17:06:39+08:00

### Decided
- Use the GitHub issue body as the source of truth: new runtime writes must leave the CPB source checkout by default and land under per-project runtime roots.
- Preserve the existing agent handoff model, but relocate its storage: project wiki/handoff files should resolve through a canonical project runtime root, not through `CPB_ROOT/wiki/projects/<project>`.
- Add `projectRuntimeRoot` to each Hub registry project, defaulting to `~/.cpb/projects/<projectId>`.
- Keep root responsibilities separate:
  - `CPB_EXECUTOR_ROOT`: immutable or checkout-backed CPB app/release code.
  - `CPB_HUB_ROOT`: global Hub/control-plane data, defaulting under `~/.cpb/hub`.
  - `projectRuntimeRoot`: per-project task, event, checkpoint, artifact, log, index, and handoff state.
- Keep compatibility reads for legacy `cpb-task/` and `wiki/projects/` paths, but do not perform destructive automatic migration.
- Implement the migration command as a dry-run/report-first path that lists moves, conflicts, legacy reads, and quarantine candidates.

### Rejected
- Auto-moving existing `flow/wiki/projects` or `flow/cpb-task` data during normal startup: this is destructive and violates the issue's safe migration requirement.
- Continuing to scan `flow/wiki/projects` for `GET /api/projects`: that is the pollution source called out by the issue.
- Implementing a full release installer or immutable release lifecycle in this task: issue #26 requires runtime root separation, not a broader release-management rewrite.
- Introducing a new datastore dependency: use existing JSON/filesystem patterns and scoped service helpers.

### Files
- `cpb` - stop defaulting `CPB_ROOT` to the script/source checkout; pass executor, hub, and runtime roots explicitly to commands.
- `bridges/common.sh` - update project lookup, prompt locators, and compatibility helpers to resolve through Hub registry/project runtime roots.
- `bridges/init-project.sh` - stop creating primary runtime wiki data inside the CPB source checkout; attach/register and create runtime-root project state instead.
- `bridges/run-phase.mjs` - allocate plan/deliverable/verdict/review/repair files through project runtime locators.
- `bridges/run-pipeline.mjs` - create jobs/events/leases through project runtime roots and keep legacy read fallback.
- `bridges/project-worker.mjs` - propagate `CPB_EXECUTOR_ROOT`, `CPB_HUB_ROOT`, and project runtime roots into child pipeline runs.
- `bridges/migrate-runtime-root.mjs` - convert to dry-run/report-first migration for legacy `cpb-task/` and `wiki/projects/` data, including quarantine reporting.
- `server/index.js` - initialize separate executor/hub/runtime roots and expose them on requests without treating the source checkout as runtime state.
- `server/routes/projects.js` - make `/api/projects` and project detail routes read Hub registry plus project runtime roots instead of scanning `wiki/projects`.
- `server/routes/tasks.js` - spawn bridge commands with separated root environment and project runtime root context.
- `server/routes/hub.js` - return roots/report fields that distinguish executor root, hub root, and project runtime root.
- `server/services/runtime-root.js` - centralize CPB home, hub root, legacy runtime root, and project runtime root resolution.
- `server/services/hub-registry.js` - persist `projectRuntimeRoot`, default it to `~/.cpb/projects/<projectId>`, and preserve legacy `projectRoot` reads.
- `server/services/artifact-locator.js` - route inbox/output/log/dashboard artifact paths through project runtime roots with legacy fallback for reads.
- `server/services/project-loader.js` - load project context/tasks/decisions/log from runtime root first, then legacy `wiki/projects` paths.
- `server/services/job-store.js`, `server/services/runtime-events.js`, `server/services/lease-manager.js`, `server/services/jobs-index.js`, `server/services/event-store.js` - ensure new job/event/lease/index writes do not target the source checkout by default.
- `server/services/readiness-checks.js`, `server/services/diagnostics-bundle.js`, `server/services/observability.js` - report executor root, hub root, and project runtime roots separately.
- `web/src/pages/Dashboard.jsx` - consume `/api/projects` as Hub-registry-backed project data; remove legacy merge assumptions that depend on source-tree scans.
- `web/src/pages/Project.jsx` - keep existing UI behavior while relying on relocated project route data/file endpoints.
- `tests/*.mjs` and focused shell tests - add or update only tests required for root separation, compatibility reads, migration dry-run, and project list behavior.

### Evidence
- Issue #26 states the current problem: CPB defaults `CPB_ROOT` to the source checkout, so task history, checkpoints, wiki project data, events, jobs, and runtime state are written under `/Users/chengwen/dev/flow`.
- Issue #26 desired shape separates `~/.cpb/releases/<release-id>`, `~/.cpb/current`, `~/.cpb/hub`, and `~/.cpb/projects/<project-id>`.
- Issue #26 acceptance requires new external projects to write runtime data under `~/.cpb/projects/<projectId>`, project lists to come from Hub registry plus runtime state, compatible legacy reads/migration, tests preventing source-checkout runtime writes, and readiness/report output showing all roots separately.

### Risks
- `CPB_ROOT` is currently used as both executor root and runtime root in many paths. Fix this by adding narrowly named helpers first, then replacing call sites incrementally.
- Existing tests may assume `CPB_ROOT/wiki/projects`. Update production path resolution and then adapt focused tests to assert both new defaults and legacy fallback.
- Existing user data under `flow/wiki/projects` and `flow/cpb-task` must remain readable until migrated. Do not delete or move it outside an explicit migration command.
- Some Rust runtime registry paths may mirror JS registry schema. If touched, keep schema backward-compatible and verify JS remains the source of truth for this task.

### Scope

**Goal**: Implement issue #26 by moving default CPB runtime writes out of the source checkout and into canonical Hub/project runtime roots, while preserving compatible reads and adding a dry-run migration/report path.

**Implementation Steps**:
1. Add root-resolution primitives in `server/services/runtime-root.js`.
   - Add helpers for CPB home (`~/.cpb` by default), hub root (`CPB_HUB_ROOT` or `~/.cpb/hub`), legacy CPB root paths, default project runtime root (`~/.cpb/projects/<projectId>`), and project runtime subpaths.
   - Keep existing `runtimeDataRoot`/`runtimeDataPath` exports as compatibility wrappers where needed, but route new code through explicit hub/project helpers.

2. Update Hub registry project records.
   - In `server/services/hub-registry.js`, default `resolveHubRoot()` to `~/.cpb/hub` unless `CPB_HUB_ROOT` is set.
   - In `registerProject()` and `updateProject()`, persist `projectRuntimeRoot`.
   - If an existing registry entry only has `projectRoot`, treat it as a legacy alias for reads but write back `projectRuntimeRoot` on the next registry save.
   - Keep `sourcePath` as the managed source checkout, not a runtime storage root.

3. Move artifact and wiki/handoff path resolution behind project runtime locators.
   - In `server/services/artifact-locator.js`, make plan/deliverable/verdict/review/repair/log paths resolve under the project's runtime root.
   - Preserve legacy read fallback for `CPB_ROOT/wiki/projects/<project>/...`.
   - Use a stable runtime layout such as `<projectRuntimeRoot>/wiki/context.md`, `<projectRuntimeRoot>/wiki/inbox`, and `<projectRuntimeRoot>/wiki/outputs` for current handoff compatibility unless a narrower existing layout already supports the issue's `tasks/`, `artifacts/`, and `logs/` names.

4. Redirect jobs, events, checkpoints, leases, and indexes to project runtime roots.
   - Update `job-store`, `runtime-events`, `lease-manager`, `jobs-index`, `event-store`, and related helpers so new writes use `projectRuntimeRoot` when a project id is known.
   - Hub-global queue, worker, ACP pool, provider backoff, and hub liveness data must stay under `CPB_HUB_ROOT`.
   - Keep legacy read fallback for existing `CPB_ROOT/cpb-task/...` job/event/lease data.

5. Update CLI and bridge environment propagation.
   - In `cpb`, default `CPB_EXECUTOR_ROOT` to the script directory and default `CPB_HUB_ROOT` to `~/.cpb/hub`; do not default runtime storage to the script/source checkout.
   - Ensure `cmd_attach`, `cmd_hub`, `cmd_worker`, phase commands, `cmd_status`, `cmd_list`, `cmd_jobs`, and `cmd_report`/readiness flows pass both executor and hub roots.
   - In `bridges/common.sh`, make `require_project()` and `get_project_path()` consult the Hub registry/project runtime root first, then legacy wiki metadata.

6. Update server routes and UI data loading.
   - In `server/routes/projects.js`, build `/api/projects` from `listProjects(hubRoot)` and enrich each entry with runtime-root counts/recent log/pipeline state.
   - Update `/api/projects/:name`, `/inbox`, `/outputs`, and `/files/*` to resolve against the registered project runtime root with traversal protection and legacy read fallback.
   - Keep response shapes compatible with current `Dashboard.jsx` and `Project.jsx` where practical; simplify `Dashboard.jsx` so primary project lists no longer depend on scanning legacy wiki directories.

7. Add dry-run migration/report support.
   - Extend `bridges/migrate-runtime-root.mjs` with `--dry-run` and report mode.
   - Report, without moving by default, which legacy `wiki/projects/<project>` files and `cpb-task/` files would move to each `projectRuntimeRoot`, which files conflict, and which non-CPB leftovers would be quarantined.
   - Only perform a move when explicitly requested with a non-dry-run flag, and never delete conflicting legacy data automatically.

8. Update readiness/diagnostics output.
   - Update `cpb report`/doctor/readiness and `/api/hub/roots` or diagnostics output to show `executorRoot`, `hubRoot`, and per-project `projectRuntimeRoot` separately.
   - Ensure output no longer labels the source checkout as the runtime root unless explicitly configured that way.

9. Add focused tests.
   - Add tests proving `registerProject()` defaults `projectRuntimeRoot` to `~/.cpb/projects/<projectId>` when only source path/name are supplied.
   - Add tests proving plan/deliverable/job/event writes for a newly attached project go under project runtime root and not under the source checkout or CPB source checkout.
   - Add tests proving `/api/projects` uses Hub registry/runtime roots and does not need `flow/wiki/projects` scans.
   - Add tests proving legacy `wiki/projects` and `cpb-task` data can still be read when no runtime-root copy exists.
   - Add tests proving migration `--dry-run` reports planned moves/quarantine/conflicts and leaves legacy data untouched.
   - Add tests proving readiness/report output contains distinct executor, hub, and project runtime root fields.

10. Run verification and produce the execute handoff.
    - Run the focused tests added above first.
    - Run the existing Node test suite and shell tests relevant to CLI/hub/runtime behavior.
    - Record exact commands and results in `wiki/projects/flow/outputs/deliverable-127.md`.

**Notes**:
- Keep scope tight to issue #26. Do not refactor unrelated UI, agent execution, provider variant, workflow, or release code.
- Do not update fake/mock tests merely to hide production behavior changes. If a fake models old source-tree storage, update only the narrow fake expectation needed to reflect the new root contract.
- Treat source checkout writes as allowed only when explicitly configured by env/registry; default behavior must not write runtime data under `/Users/chengwen/dev/flow`.
- Prefer additive compatibility helpers and targeted call-site rewrites over a broad path-system replacement.

## Next-Action
Implement the scoped runtime-root separation above, run focused and relevant existing tests, then write `deliverable-127.md` with changed files, test evidence, migration/report behavior, and any remaining compatibility risks.

## Acceptance-Criteria
- [ ] A newly attached external project gets `projectRuntimeRoot` in the Hub registry, defaulting to `~/.cpb/projects/<projectId>`.
- [ ] New plan, execute, verify, job, event, checkpoint/artifact/log/index writes for a registered project use `projectRuntimeRoot` by default, not the CPB source checkout.
- [ ] `CPB_EXECUTOR_ROOT`, `CPB_HUB_ROOT`, and `projectRuntimeRoot` are distinct concepts in code and report/readiness output.
- [ ] `GET /api/projects` and the UI project list are backed by Hub registry plus project runtime roots, not by scanning `flow/wiki/projects`.
- [ ] Legacy `cpb-task/` and `wiki/projects/` data remains readable when runtime-root data has not yet been migrated.
- [ ] Migration/report command supports dry-run output showing planned moves, conflicts, and quarantine candidates without changing files.
- [ ] Focused tests prove no new runtime writes target `/Users/chengwen/dev/flow` unless explicitly configured.
- [ ] Relevant existing Node and shell tests pass, or any failures are documented as pre-existing/unrelated with evidence.
- [ ] Code style remains consistent with the existing filesystem/JSON service patterns.
