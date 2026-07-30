# Local Code Index v2 Implementation Plan

Status: Approved after independent review (97/100)
Input specification: `docs/architecture/local-code-index-v2-spec.md` Revision 4
Required specification score: 95; achieved: 97/100
Compatibility policy: one canonical v2 path; no v1 runtime reader, writer,
adapter, alias, or dual-format period

Review history:

- Revision 1: 83/100, failed because several phase gates depended on later
  phases.
- Revision 2: makes every phase independently executable, adds lock management,
  exact queue migration concurrency, runtime v1 refusal, differential tests,
  full release scanning, and macOS/Linux CI.
- Revision 2 review: 97/100, passed; no automatic-failure condition remained.

## 1. Delivery outcome

Replace the current monolithic local index with the v2 deep module described by
the approved specification. The completed release shall:

- expose only `ensureLocalCodeIndex`, `localCodeIndexStatus`, and
  `queryLocalCodeIndex` to runtime callers;
- index materialized worktree bytes into immutable, content-addressed objects;
- refresh incrementally and publish durable snapshots;
- answer definitions, references, imports, summaries, inventory, and
  evidence-backed related-file queries;
- store `LocalCodeIndexRef`, never an index file path, in workflow state;
- remove every v1 production reader and direct storage consumer;
- provide one offline, one-way cleanup for persisted v1 references;
- ship repeatable correctness, race, migration, and performance evidence.

This plan does not authorize implementation yet. It defines the implementation
order, file ownership, tests, and release gates.

## 2. Resolved implementation decisions

These decisions remove the three low-severity ambiguities left by the Spec
review.

### 2.1 `force`

`force: false` performs the normal exact observation and reuses all valid
objects and shards.

`force: true` still performs both complete source observations and every
publication safety check, but bypasses the current snapshot, blob-map, file
object, and lookup-shard reuse decisions. Every eligible file is hashed and
every structurally supported file is parsed. Publishing canonical bytes may
reuse an already-existing equal immutable object because replacing it is
forbidden. A forced run reports `mode: "full"`.

### 2.2 Lock directory terminology

The lock primitive uses `canonicalLockDirectory` internally:

- repository object scope maps it to
  `repositories/<repository-key>/objects.lock`;
- worktree publication scope maps it to
  `worktrees/<worktree-key>/lock.lock`.

Owner records always contain `scopeKind` and `scopeKey`. Sync, quarantine,
recovery, and release operate on the canonical parent of the selected lock
directory, never on a hard-coded worktree parent.

### 2.3 Git config includes

Before commands that can materialize or compare content, the Git adapter reads
repository-local configuration without expanding includes. Any `include.path`
or `includeIf.*.path` entry fails with `unsupported_git_state`. System and
global config remain disabled. This release does not support external config
includes.

The raw local config file and any authorized attributes file are read through
bounded no-follow descriptors. Their identities and relevant values enter both
source-state observations.

## 3. Target module layout

The implementation creates this owned module:

```text
core/indexing/local-code-index/
  index.ts                 public exports only
  contracts.ts             public types, errors, limits
  service.ts               three-entry orchestration facade
  paths.ts                 canonical roots and identity keys
  platform.ts              filesystem capability probe
  canonical-json.ts        canonical serialization and object IDs
  safe-files.ts            bounded no-follow reads and durable writes
  lock.ts                  socket-free two-scope lock protocol
  git-observer.ts          exact Git inventory and second observation
  directory-observer.ts    exact non-Git inventory
  change-plan.ts           reuse/compute/delete/retarget decisions
  ast-grep-adapter.ts      executable boundary and output validation
  extract.ts               path-independent file facts
  object-store.ts          immutable object publication and lookup
  relationships.ts         import resolution and evidence graph
  shards.ts                symbol/relation shard construction
  snapshot-store.ts        identity, history, run report, current publication
  query.ts                 bounded typed queries and cursors
  coverage.ts              deterministic coverage aggregation
  gc.ts                    retained-snapshot and object collection
  management.ts            typed inspect/lock-repair administration
  evidence.ts              bounded assurance/checklist rendering helpers
  test-ports.ts            test-only dependency injection types
```

No file outside this directory may know shard paths or persisted JSON shapes.
`test-ports.ts` is compiled only for tests or exports internal constructors from
an explicitly internal path; production callers do not import it.

The old files are removed, not retained as wrappers:

- `server/services/local-code-index.ts`;
- `core/indexing/local-code-index-snapshot.ts`.

## 4. Execution sequence

Each phase ends in a green, reviewable state. A later phase must not be started
until the listed gate for its prerequisite phase passes.

### Phase 0 — Contract lock and characterization

Purpose: make the current boundary and new public contract explicit before
storage code changes.

Changes:

- Add `core/indexing/local-code-index/contracts.ts` with the approved public
  types, error reasons, limits, and coverage ordering.
- Add `core/indexing/local-code-index/index.ts` that initially exports only
  public types and the typed error. It must not contain placeholder runtime
  functions. Phase 6 adds the three real runtime exports after `service.ts`
  exists.
- Add compile-time contract tests proving that `manifestPath`, `indexFile`, and
  storage object types are not public.
- Add characterization tests around current scheduler, queue, capability-map,
  checklist, assurance, CLI, and fallback behavior. These tests record useful
  product behavior, not the v1 storage shape.
- Record all current v1 runtime references with a release-scan fixture so the
  deletion gate can prove they are gone later.

Files:

- add `core/indexing/local-code-index/contracts.ts`;
- add `core/indexing/local-code-index/index.ts`;
- add `tests/local-code-index-contract.test.ts`;
- add `tests/local-code-index-caller-characterization.test.ts`;
- update `tsconfig.strict-engine.json` only if the new core files need inclusion.

Gate:

```text
npm run typecheck
npm run build:node
npm run build:tests
node --test dist-tests/tests/local-code-index-contract.test.js
node --test dist-tests/tests/local-code-index-caller-characterization.test.js
```

### Phase 1 — Filesystem safety, identities, and platform probe

Purpose: establish reusable correctness primitives before indexing logic.

Changes:

- Implement canonical JSON exactly once and derive full SHA-256 IDs from its
  bytes.
- Implement canonical source/storage root validation and repository, worktree,
  and source keys.
- Reject a storage root equal to or below the source root.
- Implement bounded no-follow regular-file reads, pinned identity rechecks,
  exclusive temporary files, file sync, directory sync, atomic rename, and
  exclusive hard-link publication.
- Implement the startup probe for device/inode stability, nanosecond timestamps,
  exclusive creation, same-filesystem hard links and rename, file sync, and
  directory sync.
- Fail `unsupported_platform` without leaving persistent state.
- Reuse only socket-free scalar helpers whose source has been inspected, such as
  canonical JSON or directory-sync logic from `shared/hub-maintenance.ts`.
  Implement index safe-file and lock behavior in the v2 module. Do not import
  `core/runtime/durable-directory-lock.ts`,
  `shared/primitives/durable-directory-lock.ts`, or any module that imports
  `node:net`.

Files:

- add `canonical-json.ts`, `paths.ts`, `safe-files.ts`, `platform.ts`;
- add `tests/local-code-index-paths.test.ts`;
- add `tests/local-code-index-safe-files.test.ts`;
- add `tests/local-code-index-platform.test.ts`.

Gate:

- canonical serialization is byte-stable across insertion orders;
- path traversal, symlink, oversized input, storage-under-source, and identity
  replacement cases fail closed;
- injected file-sync and directory-sync failures preserve the last durable
  generation and report committed ambiguity where required.

### Phase 2 — Socket-free repository and worktree locks

Purpose: serialize shared objects and per-worktree publication before either
store exists.

Changes:

- Implement one parameterized lock protocol using
  `canonicalLockDirectory`, `scopeKind`, and `scopeKey`.
- Add exact process-incarnation probes for supported macOS and Linux runtimes.
- Implement atomic acquisition, bounded wait, exact release, stale-owner
  election, quarantine, orphan-election repair, and aggregate callback/release
  errors.
- Implement typed internal `inspectIndexLock` and `repairIndexLock` operations
  in `management.ts`. Inspection returns a bounded identity descriptor;
  repair accepts only that exact descriptor and never an arbitrary filesystem
  path.
- Retain election and quarantine evidence.
- Enforce lock order: repository objects, then worktree publication.
- Add test hooks only at filesystem/process-identity ports, not in production
  behavior branches.

Files:

- add `lock.ts`;
- add `management.ts` with lock inspection/repair only at this phase;
- add `tests/local-code-index-lock.test.ts`;
- add `tests/local-code-index-lock-process.test.ts`.

Gate:

- two-process acquisition has one owner;
- stale recovery cannot rename a successor;
- simultaneous recovery elects one process;
- orphan repair requires exact pinned identities;
- lock inspection and repair use typed module calls; the test caller never
  parses owner/election files;
- no index lock opens a network handle or imports `node:net`;
- fault injection covers every durable transition.

### Phase 3 — Exact source observation

Purpose: create one deterministic source-state payload used by status, ensure,
and final publication checks.

Git changes:

- Run the approved inventory sequence under fixed environment/config.
- Locate and read local config without includes before status/content work;
  reject `include.path` and `includeIf.*.path`.
- Reject unmerged entries, submodules, sparse/skip-worktree,
  assume-unchanged, FSMonitor-valid entries, command-backed filters, unsafe
  attributes files, symlinks, and special files.
- Read effective materialization attributes and core settings.
- Hash pinned worktree bytes; never use blob bytes as source content.
- Persist metadata identities and a worktree-materialization fingerprint.
- Repeat the complete observation and compare canonical payload bytes.

Non-Git changes:

- Walk the source tree under CPB ignore rules without following symlinks.
- Hash every eligible file for exact status.
- Treat metadata as planning information only.

Files:

- add `git-observer.ts`, `directory-observer.ts`, `change-plan.ts`;
- add `tests/local-code-index-git-observer.test.ts`;
- add `tests/local-code-index-directory-observer.test.ts`;
- add `tests/local-code-index-source-race.test.ts`.

Gate:

- tests cover clean, dirty, untracked, deleted, renamed, branch-switched,
  CRLF, encoding, ident, attributes, and rejected filter/config states;
- same-size restored-mtime edits and descriptor replacement are detected;
- the observer returns a deterministic changed-state result when its first and
  second canonical payloads differ, including late untracked files and metadata
  changes;
- observer tests prove zero persistent writes. Retry and current-publication
  behavior are deferred to the Phase 6 service gate.

### Phase 4 — Extraction and immutable repository objects

Purpose: build path-independent facts once and safely reuse them.

Changes:

- Implement the sole ast-grep process adapter with argument arrays, fixed output
  bounds, timeout, abort, version capture, and stream validation.
- Add CPB-owned versioned extraction rules by supported language.
- Calculate language extractor fingerprints from parser version, rule bytes,
  symbol schema, language mapping, effective language, and parser mode.
- Produce definitions, references, raw imports, signatures, parser errors, and
  truncation markers with no path-dependent resolved target.
- Implement file object and blob-map IDs exactly as specified.
- Publish objects under the repository lock with synced temp files and
  exclusive hard links. Existing objects are bounded-read and byte-compared.
- Define lexical and inventory-only fallback without claiming structural
  completeness.

Files:

- add `ast-grep-adapter.ts`, `extract.ts`, `object-store.ts`, `coverage.ts`;
- add `core/indexing/local-code-index/rules/` with versioned rule assets;
- add `tests/local-code-index-extract.test.ts`;
- add `tests/local-code-index-object-store.test.ts`;
- add `tests/fixtures/fake-ast-grep.ts`.

Gate:

- identical bytes with different language/parser/fingerprint cannot collide;
- equal objects are reused and unequal final bytes fail
  `object_identity_collision`;
- parser absence and per-file failure produce exact coverage summaries;
- extraction tests prove the `force: true` change plan hashes and parses every
  eligible structurally supported file. End-to-end publication safety for force
  is deferred to Phase 6.

### Phase 5 — Relationships, shards, and snapshot identity

Purpose: turn reusable file facts into snapshot-local lookup structures.

Changes:

- Resolve imports from raw facts and the versioned resolution-config
  fingerprint.
- Build unique and ambiguous reference relationships separately.
- Implement affected-set invalidation for changed definitions, imports,
  aliases, configs, delete, rename, retarget, and uniqueness transitions.
- Build deterministic symbol and relation shards from canonical JSON bytes.
- Build `identity.json` and `index-map.json`; keep run data in
  `runs/<run-id>.json`.
- Make repeated identical state produce the same snapshot ID and bytes.

Files:

- add `relationships.ts`, `shards.ts`, `snapshot-store.ts`;
- add `tests/local-code-index-relationships.test.ts`;
- add `tests/local-code-index-shards.test.ts`;
- add `tests/local-code-index-snapshot-identity.test.ts`.
- add `tests/local-code-index-incremental-differential.test.ts`.

Gate:

- one-file changes rebuild only required file/shard objects;
- rename reuses file facts but rebuilds path-dependent relationships;
- unique-to-ambiguous and ambiguous-to-unique transitions update all evidence;
- timestamps and timings change only run reports, never snapshot IDs;
- a deterministic differential suite applies alias/config edits, addition,
  deletion, rename, retarget, and zero/one/many-definition transitions, then
  byte-compares all queryable incremental output with a forced full build.

### Phase 6 — Durable service, publication, status, and GC

Purpose: assemble observation, extraction, storage, and locking behind the
three-entry service.

Changes:

- Implement `ensureLocalCodeIndex` with in-process promise coalescing keyed by
  storage root plus source key.
- Hold repository then worktree locks through object verification, second source
  observation, snapshot publication, run report, and current publication.
- Store current plus two previous snapshot IDs in `current.json`.
- Implement exact, read-only `localCodeIndexStatus`.
- Implement explicit GC under the repository lock across every worktree
  namespace.
- Add interruption cleanup for owner-scoped unpublished files only.
- Preserve and report ambiguous committed states instead of guessing rollback.

Files:

- add `service.ts`, `gc.ts`;
- complete public exports in `index.ts`;
- replace the existing `tests/local-code-index.test.ts` with v2 behavior tests;
- add `tests/local-code-index-publication.test.ts`;
- add `tests/local-code-index-gc.test.ts`;
- add `tests/local-code-index-concurrency.test.ts`.

Gate:

- crash points before and after every sync/rename keep a readable prior current
  or report the exact committed snapshot;
- two worktrees have separate current pointers and shared equal objects;
- exact `localCodeIndexStatus` writes no persistent byte;
- mutations between the initial and final observation retry once, then fail
  without replacing current;
- `force: true` performs a full parse while retaining both exact observations
  and every durable publication check;
- ensure/GC races cannot remove an object retained by a current snapshot;
- unchanged ensure returns the same snapshot and `parsedFiles: 0`;
- one-file edit reports exactly one parse unless its complete object already
  exists.

### Phase 7 — Query engine and evidence consumers

Purpose: prove callers can obtain all required information without storage
knowledge.

Changes:

- Implement exact/prefix definitions, exact references, imports, file summary,
  related files, and paginated inventory.
- Validate `cpbRoot`, reference identities, snapshot, limits, symbols, paths,
  abort signals, and cursor checksums.
- Hold the repository lock from snapshot validation through the last object
  read.
- Return deterministic ordering, evidence, truncation, timing, and searched-scope
  coverage.
- Move task-symbol candidate and evidence rendering logic into `evidence.ts`;
  make it consume query results instead of parsed manifests.

Files:

- add `query.ts`, `evidence.ts`;
- add `tests/local-code-index-query.test.ts`;
- add `tests/local-code-index-query-security.test.ts`;
- add `tests/local-code-index-evidence.test.ts`.

Gate:

- every query kind passes empty, bounded, truncated, malformed, stale-ref, and
  abort cases;
- old snapshot expiry fails before partial results;
- query/ensure/GC process races either return a complete locked snapshot or fail
  before partial output; no referenced object disappears mid-query;
- related-file scores always include evidence;
- ambiguous references never appear as exact call edges.

### Phase 8 — Runtime caller migration

Purpose: switch all production behavior to `LocalCodeIndexRef` in one canonical
source contract.

Caller changes:

- `cli/commands/init.ts`: call v2 ensure and print ref/stats without storage
  paths.
- `server/orchestrator/scheduler.ts`: ensure before dispatch and persist
  `{available, ref, tool, coverage}`; no `indexFile`.
- `server/services/hub/hub-queue.ts`: replace readiness types and queue
  preparation with v2 ref state.
- `server/services/hub/hub-registry.ts`: generate project capability maps from
  paginated v2 inventory; update attention/error projections.
- `server/services/riskmap-service.ts`: return and persist a v2 ref, then use
  query results for evidence.
- `server/services/project-capability-map.ts`: use paginated inventory and file
  summaries; delete direct index-file reads.
- `core/engine/run-job-prepare.ts`: pass the v2 ref in source context.
- `core/engine/run-job-assurance.ts`: query definitions and related files, then
  render a bounded evidence pack.
- `core/workflow/checklist-decomposer.ts`: query exact definitions for task
  symbols; preserve explicit fallback when structural coverage is insufficient.
- `server/services/infra.ts`: remove v1 re-exports; callers import the core
  module.
- SWE-bench scripts: use the public v2 module and store only refs/stats.

Exact production inventory:

- `cli/commands/init.ts`;
- `core/engine/run-job-assurance.ts`;
- `core/engine/run-job-prepare.ts`;
- `core/workflow/checklist-decomposer.ts`;
- `scripts/queue-swebench-batch.ts`;
- `scripts/run-swebench-product-validation.ts`;
- `scripts/run-swebench-three-way.ts`;
- `server/orchestrator/scheduler.ts`;
- `server/services/hub/hub-queue.ts`;
- `server/services/hub/hub-registry.ts`;
- `server/services/infra.ts`;
- `server/services/project-capability-map.ts`;
- `server/services/riskmap-service.ts`.

Tests to rewrite or extend:

- `tests/code-index-capability-map.test.ts`;
- `tests/run-job-assurance.test.ts`;
- `tests/checklist-decomposer.test.ts`;
- `tests/checklist-decompose-integration.test.ts`;
- `tests/riskmap-service.test.ts`;
- `tests/queue-orchestrator.test.ts`;
- `tests/scheduler-concurrency-cas.test.ts`;
- affected SWE-bench script tests.

Gate:

- production TypeScript contains no direct snapshot/shard read;
- source context and durable queue records contain a valid v2 ref and no
  `indexFile`;
- main-flow and integration tests prove prepare, scheduling, assurance,
  checklist, capability-map, and risk-map behavior.

### Phase 9 — Canonical CLI and offline v1 state cleanup

Purpose: expose v2 operations and make the replacement release safe without a
runtime compatibility path.

CLI changes:

- Add `cli/commands/code-index.ts` for `build`, `status`, `query`, `inspect`,
  `gc`, `inspect-lock`, and `repair-lock`.
- `inspect-lock` emits a bounded identity descriptor. `repair-lock` accepts that
  descriptor as a JSON file plus the authorized `cpbRoot` and source path; it
  rejects free-form lock paths, owner tokens, or partial identities.
- CLI inspect, GC, and lock repair call typed internal management operations.
  CLI code never parses `current.json`, lock owners, snapshots, or shards.
- Add `cli/commands/migrate.ts` with only the
  `local-code-index-v2 --cpb-root <absolute-path>` operation.
- Register both commands and help text in `cli/cpb.ts`.
- Make `scripts/code-index.ts` invoke the same command parser/service.
- Remove the old `check` subcommand; it is not an alias.

Migration changes:

- Add `server/services/migration/local-code-index-v2.ts`.
- Resolve the hub root, inspect `projects.json` and `queue/queue.json`, and
  produce a dry validation report before mutation.
- Add one schema-specific migration operation inside `hub-queue.ts` and one
  inside `hub-registry.ts`. Each operation acquires its existing normal lock,
  rereads current state, revalidates the dry-report input generation, applies
  active ownership checks, writes and syncs a bounded backup while still
  holding the lock, applies the pure transform, and commits through the
  existing locked writer.
- Registry generation is its numeric `revision`. Queue generation is SHA-256 of
  the exact canonical queue bytes read under lock because current queue state
  has no numeric revision. The locked operation recomputes and compares the
  appropriate generation.
- Refuse mutation if the locked reread finds an affected queue entry running,
  claimed, or externally owned. This check occurs before backup creation. A
  stale dry report never authorizes mutation.
- If the pure transform has no changes, return without backup creation or writer
  invocation so a successful rerun leaves bytes unchanged.
- The coordinator invokes queue and registry operations sequentially and never
  nests their locks. It never writes around existing locks or revisions.
- Remove v1 path/snapshot/tool fields from schema-defined project, queue,
  metadata, and source-context positions.
- Mark affected pending work `needs-v2-prepare`.
- Invalidate v1-derived capability/risk/safety maps for normal regeneration.
- Commit queue and registry transformations independently and idempotently;
  report partial completion so rerun can finish safely.
- Discover deletion candidates only from validated removed v1 references.
  Require each candidate to be a bounded regular file under an authorized CPB
  index root, rename it to identity-named quarantine, sync the parent, and
  report recovery paths.
- Keep backup and quarantine data non-dispatchable. The v2 runtime never imports
  this migration module.
- Add `server/services/hub/local-code-index-state-gate.ts` containing only a
  fail-closed validator, not a translator. Hub/orchestrator startup invokes it
  against registry and queue state before dispatch begins, and scheduler
  candidate selection invokes it again as defense in depth. Dispatchable v1
  state fails `unsupported_index_schema` with instructions to run the offline
  migration.

Files:

- add `cli/commands/code-index.ts`;
- add `cli/commands/migrate.ts`;
- replace `scripts/code-index.ts`;
- add `server/services/migration/local-code-index-v2.ts`;
- add `server/services/hub/local-code-index-state-gate.ts`;
- update `server/services/hub/hub-queue.ts` with the locked queue migration
  entry point;
- update `server/services/hub/hub-registry.ts` with the locked registry
  migration entry point;
- update `server/services/hub/hub-registry.ts::startHubControlPlane`,
  `server/orchestrator/hub-orchestrator.ts::start`, and
  `server/orchestrator/scheduler.ts` candidate selection to invoke the v1 state
  gate;
- add `tests/code-index-cli.test.ts`;
- add `tests/local-code-index-v2-migration.test.ts`;
- add `tests/local-code-index-v2-release-scan.test.ts`.

Gate:

- active-job refusal changes no bytes;
- successful cleanup is byte-idempotent on rerun;
- injected registry/queue write failures preserve backups and v1 artifacts;
- pending migrated work cannot dispatch before a successful v2 ensure;
- runtime startup rejects remaining dispatchable v1 state;
- scheduler defense-in-depth rejects v1 state even when startup validation was
  bypassed in a test or embedded call;
- no broad glob or recursive deletion is used.

### Phase 10 — Delete v1 and close the release

Purpose: remove the old contract only after every caller and persisted-state
test has moved.

Changes:

- Delete `server/services/local-code-index.ts`.
- Delete `core/indexing/local-code-index-snapshot.ts`.
- Remove v1 types, `checkLocalCodeIndexReady`, `readLocalCodeIndexFiles`,
  `readLocalCodeIndexSnapshot`, readiness `indexFile`, and schema-1 runtime
  branches.
- Remove or rewrite v1-specific fixtures; retain only clearly named migration
  input fixtures.
- Update `AGENTS.md`, README, developer docs, architecture docs, CLI help, and
  test profile lists to use `cpb code-index`.
- Add `scripts/verify-local-code-index-v2-release.ts`. It scans TypeScript
  source, emitted `dist`, maintained persisted-state schemas/fixtures, and CLI
  registrations. It parses imports/exports and relevant object fields instead
  of relying only on one exact text spelling.
- Add the release scan and required v2 tests to
  `scripts/verify-p0-p1.ts`, `scripts/verify-release-gate.ts`,
  `scripts/verify-stabilization.ts`, and the profiles in
  `scripts/run-node-tests.ts`.
- Update `.github/workflows/test.yml` with focused local-index platform jobs for
  macOS and Ubuntu on Node 20 and 22. These jobs run safe-file, lock,
  publication, Git-observer, race, and release-scan suites.

Release scan rejects production or built output containing any of:

```text
LOCAL_CODE_INDEX_SCHEMA_VERSION = 1
checkLocalCodeIndexReady
readLocalCodeIndexFiles
readLocalCodeIndexSnapshot
localCodeIndexReadiness.indexFile
cpb code-index check
imports or re-exports of server/services/local-code-index
imports or re-exports of core/indexing/local-code-index-snapshot
schema-1 local-code index readers or writers
dual schema read/write branches
runtime fields named indexFile in local-index readiness/source context
detached v1 indexSnapshotId/tool/fallback fields in queue or registry schemas
```

The scanner structurally checks local-index readiness types, queue/registry
normalizers, source-context projection, and dispatch code for aliases and
pass-through fields. Allowed matches are path-and-symbol-specific entries for
named migration input fixtures, the offline migration recognizer, and the
runtime reject-only state gate. Any unclassified match fails.

Files explicitly changed in this phase:

- `scripts/verify-local-code-index-v2-release.ts`;
- `scripts/verify-p0-p1.ts`;
- `scripts/verify-release-gate.ts`;
- `scripts/verify-stabilization.ts`;
- `scripts/run-node-tests.ts`;
- `.github/workflows/test.yml`;
- relevant docs and CLI help.

Gate:

```text
npm run typecheck
npm run test:main
npm run test:integration
npm run test:specialized
npm run verify:p0p1
npm run verify:stabilization
npm run verify:release-gate
```

The four-platform focused workflow must pass before release evidence is
accepted. A Linux-only local run is not sufficient for lock or publication
approval.

No v1 file is deleted before the caller migration and offline cleanup tests are
green in the same branch.

### Phase 11 — Repeatable performance evidence

Purpose: validate the approved performance claims after correctness gates pass.

Changes:

- Add `tests/benchmarks/local-code-index-v2/generate.ts` with the fixed seed,
  deterministic Git identity/timestamps, inventory hash, and 1,000/10,000-file
  fixtures.
- Add `scripts/bench-local-code-index-v2.ts` with disposable warm-ups, isolated
  child processes, pristine baseline copies, exact scenario setup, 30 measured
  samples, p95 calculation, and normalized child `maxRSS`.
- Add `bench:local-code-index` to `package.json`.
- Add benchmark contract tests to the specialized profile.
- Store release evidence at
  `artifacts/bench/local-code-index-v2.json`; do not commit machine-specific
  results unless release policy explicitly requires it.

Files:

- add benchmark generator and harness;
- add `tests/local-code-index-benchmark-contract.test.ts`;
- update `package.json`;
- update `scripts/run-node-tests.ts` specialized profile.

Gate:

```text
npm run build:node
node dist/scripts/bench-local-code-index-v2.js \
  --output artifacts/bench/local-code-index-v2.json
```

The result is valid only if generator hashes, environment preconditions, sample
counts, parse counts, p95 values, RSS, and every Spec section 3.2 budget pass.

## 5. Dependency and commit order

Use this order to keep each change reviewable:

1. contracts and characterization;
2. safe files, paths, canonical JSON, and platform probe;
3. socket-free lock;
4. source observers and change planner;
5. extractor and repository object store;
6. relationships, shards, and snapshot store;
7. service/status/GC;
8. query and evidence helpers;
9. production callers;
10. CLI and offline migration;
11. v1 deletion and release scan;
12. benchmark harness and release evidence.

Do not combine caller migration with storage internals in one commit. Do not
delete v1 before the v2 service and all caller tests pass. Do not run the
destructive artifact-cleanup mode until its dry report has been reviewed.

## 6. Verification matrix

| Requirement | Primary tests | Release evidence |
|---|---|---|
| Exact freshness | Git/directory observer and race tests | full main + integration |
| Incremental reuse | change-plan, object-store, service tests | benchmark parse counts |
| Durable publication | safe-files, lock, publication fault tests | integration crash matrix |
| Worktree isolation | concurrency and snapshot tests | two-worktree integration |
| Query correctness | query, evidence, relationship tests | caller integration |
| Explicit fallback | extractor, coverage, caller tests | no-ast-grep test run |
| No direct storage reads | contract and release-scan tests | source + `dist` scan |
| No v1 runtime | migration and release-scan tests | startup refusal test |
| No daemon/socket/MCP | import/process/network tests | source + process audit |
| Performance | benchmark contract test | canonical 30-sample JSON |

## 7. Failure handling and rollback

This is a replacement release, so rollback means restoring the previous package
and the durable backups produced by the offline migration. It does not mean
adding a v1 reader to v2.

- Before migration, stop or drain affected jobs and preserve the migration dry
  report.
- If queue migration commits but registry migration fails, leave the committed
  queue state, report partial completion, repair the external failure, and rerun
  the idempotent command.
- If current publication is ambiguous, use the typed internal management
  inspection operation under the index locks. Operators and CLI code do not
  parse `current.json`; they do not guess or overwrite.
- If object/snapshot cleanup is ambiguous, preserve quarantine and recovery
  paths.
- If performance misses its budget, keep correctness-complete v2 unreleased and
  optimize behind the same public contract. Do not weaken exactness or restore
  v1.

## 8. Risks requiring focused review

- Git behavior varies with object format, attributes, config, and filesystem;
  all supported combinations need real-repository tests.
- Directory sync and process-incarnation details differ between macOS and
  Linux; CI must cover both before release.
- Repository-level locking can serialize simultaneous worktrees; benchmark
  uncontended and contended cases before considering finer locks.
- Relationship invalidation is the largest correctness surface; the Phase 5
  differential gate compares incremental output with a forced full build.
- Queue and registry migration spans two independently durable files; every
  partial commit must be observable and rerunnable.
- A 10,000-file benchmark can create large temporary trees; harness cleanup must
  target only its validated temporary root.

## 9. Plan review rubric

Independent review scores 100 points:

- complete coverage of the approved Spec: 25;
- dependency order and executable phase gates: 15;
- file-level actionability and module boundaries: 20;
- correctness, race, and performance verification: 20;
- one-way migration and v1 deletion: 10;
- failure handling, rollback, and operational safety: 10.

Passing score: 95.

Automatic failure regardless of numeric score:

- any Spec automatic-failure condition is reintroduced;
- a phase requires direct shard/manifest reads outside the index module;
- v1 is needed at runtime during or after rollout;
- v1 deletion can precede migrated caller and persisted-state evidence;
- the migration can mutate active work or delete an unvalidated path;
- performance acceptance lacks isolated repeatable samples;
- the plan cannot be executed in ordered, independently testable increments.
