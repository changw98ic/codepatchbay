# Local Code Index v2 Completion Implementation Plan

Status: Approved after independent review (96/100)
Input specification:
`docs/architecture/local-code-index-v2-completion-spec.md` Revision 4,
approved 97/100
Parent specification: `docs/architecture/local-code-index-v2-spec.md`
Revision 4, approved 97/100
Required plan score: 95/100
Compatibility policy: one canonical v2 path; remove obsolete paths instead of
supporting them

Review history:

- Revision 1 review: 96/100, passed; no automatic-failure condition or
  implementation-blocking plan defect remained.

## 1. Delivery outcome

This plan completes only the gaps found by the 2026-07-30 re-acceptance. It
does not redesign the approved v2 module and does not repeat work that already
passes.

Completion means:

- the focused local-code-index suite passes with no skipped required behavior;
- Git source observation is byte-correct, config-isolated, and safe for
  deleted and renamed paths;
- exact status and ensure cannot publish or report a mixed source generation;
- platform failure tests are deterministic;
- default storage is external and follows the parent v2 layout;
- CLI source/root precedence and exit codes match the contract;
- the release scanner rejects only local-index v1 ownership and preserves
  unrelated contracts;
- generated JavaScript and declarations are absent from TypeScript source
  directories;
- the canonical 1,000/10,000-file benchmark produces independently validated
  evidence;
- all focused, main, integration, specialized, stabilization, release,
  packaging, and macOS/Linux gates pass in order.

No implementation phase may claim completion from a document review score.
The approved Spec and plan authorize work; the executable gates prove it.

## 2. Measured starting point

The implementation starts from these observed facts:

- `npm run typecheck` passes.
- `npm run build:node && npm run build:tests` passes.
- Focused local-code-index tests report 831 tests, 819 passes, and 12 failures.
- Ten failures are in Git observation and two are unreliable platform failure
  fixtures.
- `cpb code-index status .` selects an unsafe source-tree candidate and exits
  zero.
- the release scanner reports 76 findings across 15 files and confuses
  local-index ownership with repository-snapshot and candidate-artifact
  ownership;
- the retained benchmark evidence is structurally invalid;
- generated `.js` and `.d.ts` siblings exist in
  `core/indexing/local-code-index/`;
- the repository has no discoverable Beads database at planning time.

The dirty worktree contains broad user changes. Every implementation phase must
limit edits to its declared files and inspect overlapping diffs before writing.
Unrelated changes must not be reverted, reformatted, or included as cleanup.

## 3. Execution controls

### 3.1 Tracking

Before implementation starts, run:

```text
bd where
bd prime
bd ready
```

If the repository still has no Beads workspace, record that fact in the
implementation handoff and ask the repository owner to initialize or reconnect
the intended database. Do not create markdown task lists as a substitute and
do not silently initialize a new project database.

Once Beads is available, create one parent completion issue and one child issue
for each phase. Claim a phase before editing and close it only after its gate
passes.

### 3.2 Change isolation

Before every phase:

1. inspect `git status --short`;
2. inspect the current diff for every file the phase will touch;
3. record the starting focused-test result in the Beads issue;
4. stop if an overlapping user edit cannot be preserved safely.

No phase may modify fakes, fixtures, snapshots, or expected values merely to
hide production behavior.

### 3.3 Gate discipline

Phases run in dependency order. A failed phase gate blocks all later phases.
The executor fixes the earliest failing contract instead of weakening a later
gate.

Build products are generated only through repository build commands. Source
cleanup deletes accidental generated siblings; it does not hand-edit them.

## 4. Resolved implementation details

These details turn the approved Spec's non-blocking review notes into
implementation-ready rules.

### 4.1 Benchmark hash encoding

Use `canonicalJson` from the v2 module and UTF-8 bytes:

```text
requestSha256 =
  SHA-256(
    "cpb-local-index-benchmark-request-v1\0" +
    canonicalJson(normalizedRequest)
  )

resultSha256 =
  SHA-256(
    "cpb-local-index-benchmark-result-v1\0" +
    canonicalJson(semanticResult)
  )
```

`normalizedRequest` contains every field in the corresponding
`LocalCodeIndexQuery` after applying the production default limit and
normalizing paths and ordered input arrays exactly as the query API does.

`semanticResult` excludes `durationMs` and contains:

- definitions/references: kind, snapshot ID, coverage, truncated, and ordered
  occurrences;
- imports: kind, snapshot ID, coverage, truncated, and ordered relationships;
- file-summary: kind, snapshot ID, coverage, truncated, and file;
- related-files: kind, snapshot ID, coverage, truncated, and ordered files with
  ordered evidence;
- inventory: kind, snapshot ID, coverage, truncated, ordered files, and next
  cursor.

The validator derives these values independently from the checked-in fixture
generator and scenario table. It must not call a harness helper that returns
the expected hash.

### 4.2 Benchmark commands

The standalone canonical command remains:

```text
npm run build:node && node dist/scripts/bench-local-code-index-v2.js \
  --output artifacts/bench/local-code-index-v2.json
```

`npm run bench:local-code-index` invokes only the built harness:

```text
node dist/scripts/bench-local-code-index-v2.js \
  --output artifacts/bench/local-code-index-v2.json
```

In the ordered release gate, the preceding successful `npm run build:node`
satisfies its build prerequisite. Outside that gate, use the standalone
build-plus-run command above.

### 4.3 Safe-environment port

Git execution receives a fully constructed environment object from one
internal helper. Tests may inspect that object or invoke a captured fake Git
executable. They do not add production-only conditionals.

Allowed launch variables are enumerated in code. There is no spread of
`process.env`. Ambient `HOME`, `XDG_CONFIG_HOME`, `PREFIX`, `LD_*`, `DYLD_*`,
and unapproved `GIT_*` keys are absent. If a private empty HOME/XDG directory
is needed, its pinned identity is part of the observation lifetime and cleanup
has one owner.

## 5. Phase sequence

### Phase 0 — Baseline lock and test matrix

Purpose: freeze the measured failure set and assign each assertion to the phase
that will make it pass, without committing an intentionally red test state.

Changes:

- record the exact failing test names, commands, and observed diagnostics in the
  Beads parent issue;
- map every existing failure and every approved missing assertion to
  Phases 1–6;
- verify that typecheck and both builds still pass before implementation;
- inspect every planned write path for overlapping user changes;
- do not edit production or test files in this phase.

Files:

- no repository file changes;
- Beads issue records only.

Gate:

```text
npm run typecheck
npm run build:node
npm run build:tests
node dist-tests/scripts/run-node-tests.js --main --list
```

The known failing focused command is rerun separately as a diagnostic and its
nonzero result is recorded, but it is not called a passing gate. If its failure
set differs from the measured baseline, investigate the drift before Phase 1.
Phase 0 closes only when every command in the gate above exits zero.

### Phase 1 — Exact and isolated Git observation

Purpose: make one complete Git observation correct before status or publication
depends on it.

Changes:

- add raw NUL-byte fixtures for ordinary entries, type-2 rename/copy records,
  spaces, tabs, newlines, and malformed frames before changing each parser;
- add explicit deletion, staged rename, assume-unchanged, FSMonitor-valid,
  skip-worktree, config include, command filter, attributes, EOL, submodule,
  and environment-injection assertions;
- replace string-splitting of porcelain v2 and `ls-files` output with bounded
  byte parsers;
- parse type-2 rename/copy records as one header plus two NUL-delimited paths;
- represent tracked deletion as `present: false` with null metadata;
- never `lstat` or extract a Git-proven absent path;
- parse `ls-files -v -z` and `-f -z` as tag protocols and reject
  assume-unchanged, FSMonitor-valid, and skip-worktree states;
- preflight `.git`, `gitdir`, `commondir`, common config, worktree config, and
  `core.attributesFile` using bounded no-follow reads before launching Git;
- reject config includes and non-empty clean/smudge/process filter commands;
- preserve effective autocrlf, EOL, attributes, filters, origins, and config
  hashes in the source payload;
- build the child environment from an allowlist with no ambient config or
  loader injection;
- pass an explicit authorized `core.attributesFile` or null device to every
  `check-attr`;
- keep SHA-1 and SHA-256 support and reject mode `160000` or reported submodule
  state.

Files:

- update `core/indexing/local-code-index/git-observer.ts`;
- update `core/indexing/local-code-index/contracts.ts` only if the approved
  absent-path representation is not already expressible;
- update `core/indexing/local-code-index/change-plan.ts`;
- update `core/indexing/local-code-index/extract.ts` only to exclude absent
  entries at its typed boundary;
- update `tests/local-code-index-git-observer.test.ts`;
- update `tests/local-code-index-incremental-differential.test.ts`.

Required negative matrix:

- ambient Git config count/parameters/config file;
- alternate index, Git directory, worktree, common directory, object directory,
  and alternate object directories;
- ambient HOME/XDG config and attributes;
- ambient PREFIX, `LD_*`, and `DYLD_*`;
- local and worktree config include declarations;
- clean, smudge, and process filter commands;
- malformed `.git`, `commondir`, config, attributes, and every byte protocol;
- disappearing present path;
- local submodule created with fixture-only
  `-c protocol.file.allow=always`.

Gate:

```text
npm run typecheck
npm run build:node
npm run build:tests
node --test \
  dist-tests/tests/local-code-index-git-observer.test.js \
  dist-tests/tests/local-code-index-incremental-differential.test.js
```

Exit condition: all Git observer cases pass on the current platform; no fixture
can execute an injected command.

### Phase 2 — Exact status and publication observation boundaries

Purpose: ensure correct one-shot observations cannot still be combined into a
stale or mixed result.

Changes:

- make `localCodeIndexStatus` perform complete observations A and B;
- compare canonical payload bytes, not references derived from `current.json`;
- report stable mismatch as stale/exact and A/B mismatch as
  `source_changed_during_index`, unavailable, and non-exact;
- apply the same two-complete-hash rule to non-Git sources;
- make ensure observe once before planning and once after candidate durability
  verification but before current-pointer publication;
- refuse publication when the two payloads differ;
- ensure current snapshot publication and status stay read-only or durable at
  their approved boundaries.

Files:

- update `core/indexing/local-code-index/service.ts`;
- update `core/indexing/local-code-index/directory-observer.ts` if it does not
  expose a complete canonical observation;
- update `core/indexing/local-code-index/contracts.ts` for the approved reason
  union only;
- update `tests/local-code-index-source-race.test.ts`;
- update `tests/local-code-index-snapshot-identity.test.ts`;
- update `tests/local-code-index-publication.test.ts`;
- update `tests/local-code-index-directory-observer.test.ts`.

Gate:

```text
npm run typecheck
npm run build:node
npm run build:tests
node --test \
  dist-tests/tests/local-code-index-source-race.test.js \
  dist-tests/tests/local-code-index-snapshot-identity.test.js \
  dist-tests/tests/local-code-index-publication.test.js \
  dist-tests/tests/local-code-index-directory-observer.test.js
```

Exit condition: modify, delete, rename, add-untracked, branch-switch, and
non-Git mutation races never report the old generation fresh and never publish
a mixed snapshot.

### Phase 3 — Deterministic platform probes

Purpose: keep production capability checks while removing unreliable
permission and cleanup fixtures.

Changes:

- replace privilege-dependent platform failure assertions before changing the
  production probe;
- introduce one internal filesystem-probe adapter used by async and sync
  platform probes;
- use the real Node adapter in production;
- inject temporary-directory, file-sync, directory-sync, hard-link, and rename
  failures in tests;
- give each probe directory one idempotent cleanup owner;
- retain one real-adapter run on macOS and Linux and assert no leaked probe
  directory.

Files:

- update `core/indexing/local-code-index/platform.ts`;
- update `tests/local-code-index-platform.test.ts`.

Gate:

```text
npm run typecheck
npm run build:node
npm run build:tests
node --test dist-tests/tests/local-code-index-platform.test.js
```

Exit condition: every required failure is deterministically injected, async
and sync paths agree, and the real adapter leaves no temporary state.

### Phase 4 — External storage authority and CLI contract

Purpose: make the default command usable without writing into the source tree
and make machine-visible outcomes truthful.

Changes:

- add CLI assertions for positional source, explicit source conflict,
  `--cpb-root` precedence, read-only missing status, and exit codes 0/1/2
  before changing command behavior;
- resolve a safe explicit CPB authority to
  `<cpbRoot>/indexes/local-code/v2`;
- otherwise resolve
  `<canonical-tmp>/cpb-local-code-index-uid-<uid>` as the authority and append
  `indexes/local-code/v2`;
- pin and revalidate temporary-root and authority owner, mode, device, inode,
  canonical path, and no-follow identity;
- isolate the metadata/identity checks behind one internal filesystem authority
  adapter so owner, mode, sticky-bit, device/inode, and replacement failures
  are deterministic in tests while production uses real Node filesystem calls;
- accept private tmp only for current UID with no group/world bits and shared
  tmp only for UID 0 with sticky bit;
- exclusively create the per-user authority as mode `0700`;
- keep status read-only by validating only existing ancestors/components;
- make explicit `--cpb-root` override the router root;
- implement source precedence and reject ambiguous source arguments;
- return typed parse/outcome results from command helpers;
- return exit 1 for unavailable/stale/unsafe/failed status and exit 2 for
  syntax errors.

Files:

- update `core/indexing/local-code-index/paths.ts`;
- update `core/indexing/local-code-index/service.ts` only where storage status
  must remain read-only;
- update `cli/commands/code-index.ts`;
- update `cli/cpb.ts` only if router return-code propagation requires it;
- update `scripts/code-index.ts` to use the same command contract;
- update `tests/local-code-index-paths.test.ts`;
- update `tests/code-index-cli.test.ts`;
- update `tests/local-code-index-management.test.ts`.

Required storage negative matrix:

- private tmp wrong owner, group/world bits, symlink, and generation change;
- shared tmp non-root owner, missing sticky bit, symlink, and generation change;
- authority pre-existing symlink, wrong owner/mode, and replacement after pin;
- source equal to or above the requested storage candidate;
- missing-index status under every unsafe case performs zero writes.

Gate:

```text
npm run typecheck
npm run build:node
npm run build:tests
node --test \
  dist-tests/tests/local-code-index-paths.test.js \
  dist-tests/tests/code-index-cli.test.js \
  dist-tests/tests/local-code-index-management.test.js
```

The CLI test harness invokes `dist/cli/cpb.js`: status before the first build
must exit 1 without creating source-tree state, then build/status in a
disposable repository must exit 0/0.

Exit condition: default and explicit-safe storage work, every unsafe authority
fails closed, and CLI human/JSON values and exit codes agree.

### Phase 5 — Contract-owned release scan and source hygiene

Purpose: remove real v1/local build pollution without deleting fields owned by
other contracts.

Changes:

- add scanner classification fixtures for all three schema owners before
  changing the scanner;
- replace broad line regexes with rules scoped by owning type, import, module,
  persisted schema, or explicitly named migration fixture;
- treat `LocalCodeIndexRef` as the only local-index runtime state;
- preserve repository-snapshot fields `ensureIndexFresh`,
  `indexSnapshotId`, `indexFreshness`, and `sourceFingerprint`;
- preserve `CandidateArtifact.schemaVersion === 1`;
- remove detached local-index snapshot copies and make callers carry the full
  `LocalCodeIndexRef`;
- retain v1 recognition only in the offline migration input and reject-only
  runtime state gate;
- delete accidental generated `.js`, `.d.ts`, and source maps from TypeScript
  source directories;
- remove the noncanonical benchmark harness and stale workflow script copies;
- make release scan cover source, built output, schemas, fixtures, CLI
  registration, and source-tree pollution.

Files:

- update `scripts/verify-local-code-index-v2-release.ts`;
- update `tests/local-code-index-v2-release-scan.test.ts`;
- update `tests/local-code-index-v2-migration.test.ts`;
- update `core/workflow/checklist-decomposer.ts`;
- update `scripts/queue-swebench-batch.ts`;
- update `scripts/run-swebench-product-validation.ts`;
- update any other scanner-confirmed detached local-index owner;
- delete `core/indexing/local-code-index/ast-grep-adapter.js`;
- delete `core/indexing/local-code-index/ast-grep-adapter.d.ts`;
- delete `core/indexing/local-code-index/contracts.js`;
- delete `core/indexing/local-code-index/contracts.d.ts`;
- delete `scripts/bench-local-code-index.ts`;
- remove obsolete `scripts/workflows/local-code-index-v2-fixed.js` and other
  scanner-proven noncanonical generated copies;
- update `.gitignore`, `tsconfig.node.json`, and `tsconfig.tests.json` only as
  needed to prevent recurrence without hiding tracked pollution.

Gate:

```text
npm run typecheck
npm run build:node
npm run build:tests
node --test \
  dist-tests/tests/local-code-index-v2-release-scan.test.js \
  dist-tests/tests/local-code-index-v2-migration.test.js \
  dist-tests/tests/local-code-index-contract.test.js
node dist/scripts/verify-local-code-index-v2-release.js
git status --short
```

Exit condition: scan has zero findings; tests prove all three contract owners
are classified correctly; source directories contain no emitted siblings; no
runtime v1 reader, alias, or dual-schema path remains.

### Phase 6 — Canonical benchmark and independent validator

Purpose: replace invalid performance evidence with repeatable correctness and
resource evidence.

Changes:

- add validator tamper fixtures for missing samples, errors, malformed
  environment measurements, wrong hashes, and falsified `passed` before
  changing the harness;
- make the checked-in generator the only fixture source;
- generate deterministic 1,000 and 10,000 eligible-file fixtures with fixed
  seed, inventory hash, bytes, object format, and commit identities;
- define one checked-in 20-scenario table covering all ten scenarios at both
  sizes;
- execute five disposable warmups and 30 isolated measured samples per
  scenario;
- collect child-process high-water RSS, duration, mode, discovered/parsed
  counts, and operation-specific outcomes;
- add request/result domain-separated hashes for every query sample;
- record exact Node, Git, OS, CPU, memory, filesystem, and storage identity;
- reject sample errors, malformed fields, reduced fixtures, or missing metrics;
- add an independent strict-schema validator that recalculates p95, checks all
  counts and observations, and reconstructs query hashes without trusting
  harness helpers;
- write the artifact only after validation and remove invalid prior evidence;
- point the package script only at the built canonical v2 harness; keep the
  build step explicit in the standalone command and ordered release gate.

Files:

- rewrite `scripts/bench-local-code-index-v2.ts`;
- add `scripts/verify-local-code-index-v2-benchmark.ts`;
- update `tests/benchmarks/local-code-index-v2/generate.ts`;
- add `tests/benchmarks/local-code-index-v2/scenarios.ts`;
- update `tests/local-code-index-benchmark-contract.test.ts`;
- update `tests/local-code-index-benchmark-validator.test.ts`;
- update `package.json` so the benchmark script invokes only the built v2
  harness;
- replace `artifacts/bench/local-code-index-v2.json` only with passing evidence.

Gate:

```text
npm run typecheck
npm run build:node
npm run build:tests
node --test \
  dist-tests/tests/local-code-index-benchmark-contract.test.js \
  dist-tests/tests/local-code-index-benchmark-validator.test.js
npm run bench:local-code-index
node dist/scripts/verify-local-code-index-v2-benchmark.js \
  artifacts/bench/local-code-index-v2.json
node dist/scripts/verify-local-code-index-v2-release.js
```

Exit condition: the artifact has exactly two fixtures, exactly 20 scenarios,
exactly 30 successful measured samples per scenario, no errors, reproducible
query hashes, `passed: true`, and `failures: []`.

### Phase 7 — Full regression, cross-platform, and package acceptance

Purpose: prove the completion changes do not break CPB runtime callers or
release packaging.

Run in this exact order:

```text
npm run typecheck
npm run build:node
npm run build:tests
node --test $(find dist-tests/tests -maxdepth 1 \
  -name 'local-code-index*.test.js' -print | sort)
node dist/scripts/verify-local-code-index-v2-release.js
npm run test:main
npm run test:integration
npm run test:specialized
npm run verify:p0p1
npm run verify:stabilization
npm run bench:local-code-index
node dist/scripts/verify-local-code-index-v2-benchmark.js \
  artifacts/bench/local-code-index-v2.json
npm run verify:release-gate
npm pack --dry-run
```

CI requirements:

- run focused Git observer, platform, path, CLI, source-race, scanner, and
  validator tests on Ubuntu Node 20, Ubuntu Node 22, macOS Node 20, and macOS
  Node 22;
- report Git version and explicitly skip SHA-256 fixture setup only when the
  installed Git lacks support;
- run the real platform adapter and prove no probe-directory leak;
- do not rerun the expensive benchmark on generic hosted CI unless the runner
  meets the local-SSD qualification; always validate the checked-in artifact;
- fail on any source-tree emitted sibling or unapproved v1 runtime path.

Files:

- update `.github/workflows/test.yml`;
- update `package.json` only for final gate scripts;
- update release documentation only to state commands that actually passed.

Exit condition: every command passes in order on a clean implementation
worktree, macOS/Linux focused CI is green, package contents contain no runtime
state or source pollution, and the release evidence validator passes.

## 6. Phase dependency map

```text
Phase 0 characterization
  -> Phase 1 Git one-shot observation
    -> Phase 2 status/publication boundaries

Phase 0 characterization
  -> Phase 3 platform test seam
    -> Phase 4 storage/CLI

Phase 1 + Phase 2 + Phase 4
  -> Phase 5 semantic release scan and hygiene
    -> Phase 6 benchmark and validator
      -> Phase 7 full acceptance
```

Phase 3 may run in parallel with Phases 1–2 only in a separate worktree with a
disjoint write set. Phase 4 depends on the platform authority rules from
Phase 3. Phases 5–7 remain sequential because each consumes the preceding
canonical surface.

## 7. Review boundaries

Each phase review must answer:

- Did production behavior change only within the phase contract?
- Are errors typed and machine-readable?
- Can any stale or mixed generation be reported exact/fresh?
- Can untrusted Git config, attributes, environment, or filters execute?
- Can status create state?
- Can storage resolve under the source tree?
- Did the scanner delete or rename a field owned by another contract?
- Is any runtime v1 compatibility path present?
- Does evidence prove operation success rather than file existence?
- Are user-owned unrelated worktree changes untouched?

Phase 1, Phase 2, Phase 4, and Phase 6 require a security/correctness review
before their Beads issue closes. Phase 7 requires one independent final review
against both approved specifications.

## 8. Rollback and failure handling

There is no runtime v1 rollback. If a phase fails:

- keep the last passing v2 generation;
- do not publish a candidate snapshot or benchmark artifact;
- revert only the failing phase's isolated changes through a normal,
  reviewable patch;
- preserve failure evidence in the Beads issue;
- resume from the earliest failed gate.

Offline v1 cleanup input remains recoverable until the one-way cleanup command
finishes. After completion, runtime still refuses v1 state; it never falls back
to an old reader.

If a benchmark run is interrupted or invalid, delete only its explicitly
resolved temporary fixture/storage directories and do not replace the last
valid checked-in artifact.

## 9. Completion evidence

The implementation handoff must include:

- Beads parent and phase issue IDs, or the recorded missing-workspace blocker;
- exact commit and dirty-worktree statement;
- focused test total with zero failures;
- main, integration, specialized, stabilization, and package results;
- macOS and Linux focused CI links or logs;
- release-scanner zero-finding output;
- benchmark artifact path, SHA-256, environment qualification, scenario/sample
  counts, and independent-validator output;
- explicit statement that no compatibility path was added;
- explicit list of deleted generated/noncanonical files;
- remaining risks, if any, without calling the release complete.

## 10. Independent plan review rubric

An independent reviewer scores 100 points:

- traceability to every completion-Spec requirement: 20;
- phase order and dependency correctness: 15;
- file-level actionability and bounded ownership: 15;
- executable tests, gates, and stop conditions: 20;
- Git/storage/security negative coverage: 10;
- benchmark and release evidence reproducibility: 10;
- no-compatibility migration and rollback correctness: 5;
- dirty-worktree, Beads, and handoff safety: 5.

Passing requires at least 95/100.

Automatic failure applies if the plan:

- allows a phase to claim completion while its required gate is red;
- schedules status/publication work before one-shot Git observation is correct;
- permits ambient Git/config/loader authority or source-tree storage;
- treats broad field-name regexes as contract ownership;
- introduces a v1 runtime reader, fallback, alias, or dual schema;
- accepts benchmark evidence from counts or `passed` without independent
  semantic validation;
- replaces unrelated dirty-worktree changes;
- places the benchmark before correctness and release-scan gates.

Below 95/100 requires revision and a new independent review. Implementation
must not start until the reviewed plan reaches the threshold.
