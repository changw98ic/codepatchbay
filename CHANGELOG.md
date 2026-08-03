# Changelog

All notable changes to **CodePatchbay (cpb)** are documented here.
Entries are derived from the commit log (`v0.4.1..HEAD`); no entries are invented.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

## [0.5.0] — 2026-08-02

120 commits, 748 files changed (+310,382 / −21,719) since `v0.4.1`. This is a **minor
(pre-1.0) release** that carries several backwards-incompatible contract changes; see
*Changed* and *Removed*. Projects upgrading from 0.4.1 should re-run `cpb init` and
consult `docs/product/dw08-migration-runbook.md`.

### Added
- Agent **provider capability registry** + registry onboarding / catalog alignment
  (`557c6e4e`, `38a2fe8a`).
- Agent envelope **schemaVersion negotiation** with published schemas and guide
  (`95a909e0`).
- `cpb fix` / `cpb task` **product entry** with a read-only `TaskView` projection, now
  surfacing the completed / verified / `deliveryReady` distinction
  (`1e68b706`, `fd9fab10`).
- Trace now **exposes agent stats** and renders the routing decision (`e24c7aef`).
- **Provider lease scope** exposed in ACP status (`070f9a4e`).
- GitHub **draft-PR finalizer is dry-run by default** (`028fa433`).
- `verify:p0p1` gate extended and a new **`verify:release-gate` runner** added
  (`d18f23bf`); release-gate scripts wired into build/CI (`f9e2624b`).
- A3 **characterization tests** for agent blind spots (`b94ad282`).

### Changed
> These are breaking for 0.4.1 consumers. No automatic migration command is provided;
> runtime contracts are enforced canonically (`05d96de6`).

- **Redis retired entirely** + `ProjectWorker` cleanup — cpb is now a pure filesystem /
  single-runtime-dependency (`chokidar`) tool (`554fd4e5`).
- **All agent compatibility / rollback paths stripped** (`3c3b20c5`, `e28da9e3`);
  retired compatibility references cleaned.
- **Profile config blocks dropped** — vestigial fields removed, reviewer prompt moved to
  English, `deny_tools` is read-only (`8e08c89b`).
- **codex-acp migrated to `@agentclientprotocol`** with phase-policy env wiring
  (`f1f16278`).
- **`PhaseResult` unified at the `runPhase` contract boundary** — zero local aliases
  remain (`cdadc968`, `ffd56624`).
- **Provider configuration + local code-index workflow migrated** (`b5614e18`,
  `50f43a9c`).
- **`run-job.ts` decomposed** into phase / dag-node / completion / provider /
  poisoned-session / runtime / scope helpers and brought under the strict-engine gate
  (`278b91dee`, `c444466d`, `dce48fa6`, `d995281c`, `6b31d2e2`, `831a85f7`,
  `057c4e77`).
- `RunJobContext` mutable writes routed through a **bookkeeping holder**; `runDagNode`
  split into decision / attempt / outcome coordinator; worker-assignment
  failure-classification seam extracted (`0dc46c77`, `1c341446`, `69c2bd21`).
- `TaskView` / exit-code contracts **frozen and pinned** (`7eadcdf6`); `run-job`
  bookkeeping covered by the strict-engine gate (`bb7807fc`).
- **Type-debt cleanup**: bare `any` eliminated from 1386 → 0 (including a centralized
  `AnyRecord` alias that removes 52 duplicate local definitions) (`0b6c1d42`, `65c19430`,
  `6bfda609`, `b6506ca0`, `20e73276`, `dfbcef2f`, `25e580f0`, `ef4a4116`).
- GLM quota handoffs now **route to MiMo** without weakening agent policy (`5bdde0e0`);
  provider admission coordinated across isolated workers (`e55942d5`).

### Removed
- Redis dependency and `ProjectWorker` (`554fd4e5`).
- Local-index reference type debt (`b1ccdb8c`).
- Redundant integration smoke tests (`ed6604b6`).
- `dist-baseline/` build artifact untracked and added to `.gitignore` (`9c8d355f`).

### Fixed
- Routing falls back to `defaultAgentForRole` when no explicit agent source is supplied
  (`64a9df79`); agent registry loaded at worker startup for routing + auth + isolation
  (`dfc6ff06`); registry loaded in `createAgentHome` so codex/claude auth is inherited
  (`4f5a86b1`).
- Hub now propagates broker URL, worktree codegraph env, `CPB_CODEGRAPH_INDEX_ONLY_OK`
  and `CPB_WORKER_DISPATCH_ENABLED` to the orchestrator; worktree index synced
  (`e249f14d`, `c1fc79ee`, `9aad5bd4`).
- `cpb init` now indexes codegraph, generates a capability map, and stops polluting
  source (`6e878ce2`).
- Panic-recovery semantics restored after the strict migration (`184d0607`);
  `prepareTask` throws normalized internally (`8b607704`).
- Durable-runtime recovery edges hardened (`962e0a33`, `b952c61a`); transient
  jobs-index / publication-successor / scheduler-timing lock races handled
  (`9da154f4`, `7dca93cf`, `d01ae48d`, `9c64260c`).
- ACP lifecycle: terminal results no longer outrun settlement; peer conversations kept
  alive through terminal settlement (`253eec87`, `80a642b6`).
- Daemon stale-crash and managed-worker test flake stability (`95790b1f`); macOS
  build-lock retries and CI runner stabilized (`335762bb`).
- Finalizer-recovery and fast-path unit-test failures resolved
  (`4e5789ca`, `dc3fd0c0`).
- SWE-bench: symbolic branch checkout for managed worktrees and `projectRuntimeRoot`
  carried into the high-assurance inbox (`619232ab`, `d0dbdcb7`, `bc9f1874`).

### Testing / CI
- Strict-engine type gate and broad-`any` type-debt guard added (`565c842d`).
- 67 slow / E2E unit files moved out of the `--unit` fast path (≈298s → ≈13s)
  (`d123a179`); slow CI unit tests serialized and isolated in fresh processes
  (`23fd9261`, `d7c5e735`, `36aea980`).
- Index-service suite runs in a dedicated CI matrix (`99327d80`); pre-aborted index
  builds rejected before spawn (`6fa40e7c`).
- Linux CI made to own its declared shell dependency and hardened sandbox readiness
  (`ff0fa5c1`, `d997904d`, `fb104aa2`, `9e4c8800`).

[0.5.0]: https://github.com/changw98ic/codepatchbay/releases/tag/v0.5.0
