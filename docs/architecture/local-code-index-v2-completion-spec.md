# Local Code Index v2 Completion Specification

Status: Approved after independent review (97/100)
Parent specification: `docs/architecture/local-code-index-v2-spec.md`
(`Revision 4, approved 97/100`)
Scope: only the work still required after the 2026-07-30 implementation
re-acceptance
Compatibility policy: one canonical v2 runtime; no v1 local-code-index reader,
writer, alias, detached snapshot copy, or dual-schema path

Review history:

- Revision 1: 84/100, failed because exact status and benchmark evidence were
  not closed.
- Revision 2: adds exact status observations, pre-Git config authorization,
  per-user cache authority, and independently verified two-fixture benchmark
  evidence.
- Revision 2 review: 92/100, failed because ambient Git environment injection
  remained possible.
- Revision 3: allowlists the Git subprocess environment, places per-user cache
  authority directly below sticky tmp, and records operation-specific
  benchmark outcomes.
- Revision 3 review: 94/100, failed because temporary-root trust conditions,
  non-Git environment isolation, parent storage-layout consistency, and
  benchmark query-result identity were not fully explicit.
- Revision 4: pins exact temporary-root authority rules, removes ambient
  process-level config discovery, restores the parent storage layout, and
  makes query benchmark results independently reproducible by hash.
- Revision 4 review: 97/100, passed; no automatic-failure condition remained.

## 1. Acceptance baseline

The completion work starts from this measured state:

- TypeScript typecheck passes.
- Node and test builds pass.
- Local-code-index focused suite: 831 tests, 819 pass, 12 fail.
- Ten failures are in Git observation, including deleted paths, staged rename,
  materialization config, command-backed filters, config includes, and submodule
  setup.
- Two failures are platform-probe test-fixture cleanup failures.
- The release scan reports 76 findings across 15 files, but mixes real v1
  findings with unrelated repository-snapshot and candidate-artifact contracts.
- `cpb code-index status .` reports `unsafe_storage_root` and exits zero.
- The existing benchmark artifact has 60 files, Node 24, unknown storage, zero
  successful full-build samples, and does not implement the approved benchmark
  result schema.
- Generated `.js` and `.d.ts` files exist inside
  `core/indexing/local-code-index/`.
- Main, integration, specialized, stabilization, and release gates were not
  eligible to run because mandatory focused gates failed.

This baseline is evidence, not an accepted waiver.

## 2. Completion outcome

The implementation is complete only when:

1. exact Git observation handles all approved states without stale or
   path-corrupt results;
2. unsupported filters, includes, submodules, and special index states fail
   closed before content comparison;
3. platform capability tests are deterministic on macOS and Linux;
4. the canonical CLI works with its normal CPB invocation and returns truthful
   exit codes;
5. the release scanner rejects only actual local-code-index v1 contracts and
   reports zero production violations;
6. redundant detached local-code-index snapshot fields are removed;
7. the approved 1,000/10,000-file benchmark produces valid passing evidence;
8. all focused, main, integration, specialized, stabilization, and release
   gates pass.

The existing three-entry runtime module interface remains unchanged:

```ts
ensureLocalCodeIndex(options)
localCodeIndexStatus(options)
queryLocalCodeIndex(ref, query, options)
```

All completion behavior stays behind this seam. No new runtime caller-facing
index interface is introduced.

## 3. Non-goals

This completion release does not:

- redesign the approved object, snapshot, shard, query, or lock formats;
- add a daemon, socket, MCP server, watcher, or source-tree index directory;
- reintroduce v1 to make migration easier;
- delete or reinterpret the separate repository-snapshot freshness subsystem;
- treat a test-fixture failure as permission to weaken production checks;
- accept reduced-size benchmark evidence as release proof;
- preserve the temporary development workflow or generated source artifacts.

## 4. Contract ownership and naming

Three different contracts currently use similar words and must not be confused.

### 4.1 Local Code Index v2

Owned by `core/indexing/local-code-index/`.

Its durable caller reference is only:

```ts
LocalCodeIndexRef {
  schemaVersion: 2;
  sourcePath: string;
  repositoryKey: string;
  worktreeKey: string;
  sourceKey: string;
  snapshotId: string;
}
```

Queue, scheduler, capability, risk, checklist, assurance, and benchmark code
store or pass the complete ref. They do not copy `ref.snapshotId` into a
detached `indexSnapshotId` field.

### 4.2 Repository snapshot freshness

`ensureIndexFresh`, its manifest, `indexSnapshot`, `indexSnapshotId`,
`indexFreshness`, and `sourceFingerprint` describe a separate repository/job
snapshot contract. They are not local-code-index v1 merely because their names
contain “index”.

This subsystem remains supported. The completion release must not delete it or
silently substitute `LocalCodeIndexRef` for it.

### 4.3 Candidate artifact schema

`CandidateArtifact.schemaVersion === 1` in verification describes the candidate
artifact contract, not local-code-index v1. It remains valid unless changed by
its own specification.

### 4.4 Redundant local-index copies

The following are actual completion findings and must change:

- SWE-bench setup helpers return `ref` only, plus independent counts/tool state
  when needed; they do not also return `indexSnapshotId: ref.snapshotId`.
- Checklist diagnostics carry `localCodeIndexRef` or
  `localCodeIndexRef.snapshotId` under an explicitly local-code-index name; they
  do not use generic `indexSnapshotId`.
- Any queue or source context that describes local-index readiness stores
  `{ available, ref, tool?, coverage? }`, not detached snapshot/tool/fallback
  fields.

No adapter reads both old detached fields and the ref.

## 5. Exact Git observation completion

### 5.1 Porcelain-v2 parsing

`git status --porcelain=v2 -z` is parsed as a NUL-framed byte protocol, not by
splitting an entire record on spaces.

The Git adapter captures porcelain output as bytes. It finds NUL frames and
ASCII header separators before decoding paths. Paths must decode as strict
UTF-8; invalid encoding fails `unsupported_git_state`.

For an ordinary `1` record, the parser consumes the eight fixed header fields
after the record kind, then treats the remaining bytes as the path. Spaces,
tabs, valid non-ASCII UTF-8, and leading status-like characters remain path
data.

For a rename/copy `2` record, the parser consumes the nine fixed header fields
after the record kind, including `<X><score>`, then treats the remaining bytes
as the destination path. The next NUL frame is the original path.

Unmerged `u` records fail `unsupported_git_state`. Unknown or malformed record
kinds fail closed; they are never skipped.

Acceptance fixtures include:

- modified and deleted tracked files;
- staged and unstaged rename;
- destination and original paths containing spaces;
- non-ASCII paths;
- malformed/truncated records.

### 5.2 Missing worktree paths

The source-state inventory represents presence explicitly:

```ts
type ObservedPathState = Readonly<{
  path: string;
  present: boolean;
  metadata: PinnedMetadata | null;
  stage: StageEntry | null;
  porcelain: PorcelainEntry | null;
  attributes: PathAttributes;
  eolInfo: string;
}>;
```

A tracked deletion has `present: false`, `metadata: null`, and its stage and
porcelain evidence. The observer does not call `lstat` or read content for a
path Git proves absent.

If a supposedly present path disappears during pinning, observation returns a
changed-state result and retries through the service once. It does not omit the
path or publish a mixed snapshot.

Change planning treats `present: false` as delete. Extraction receives only
present, pinned regular files.

### 5.3 Git index flags

`git ls-files -v -z` and `git ls-files -f -z` are status-tag protocols, not
untracked-file inventories.

- `-v` lowercases the status tag for assume-unchanged entries.
- `-f` lowercases the status tag for FSMonitor-valid entries.
- `S` identifies skip-worktree.
- untracked files come from porcelain `?` records.

Both outputs are parsed as NUL frames with the exact one-character tag, one
separator, and remaining path bytes. Malformed entries fail closed.

Any assume-unchanged, FSMonitor-valid, or skip-worktree path fails
`unsupported_git_state`. The observer never adds all `ls-files -f` paths to an
“untracked” set.

Acceptance independently creates and detects each supported special flag. If
the installed Git cannot set FSMonitor-valid state in a fixture, the test uses a
captured raw protocol fixture and reports the Git limitation.

### 5.4 Repository config sources

This preflight overrides the command order in parent Spec section 8.1.

Before starting any Git subprocess, the observer resolves the repository
metadata through bounded no-follow filesystem reads:

1. require a `.git` directory or parse the exact `gitdir: <path>` form of a
   `.git` regular file;
2. resolve a linked worktree's `commondir` regular file beneath the authorized
   Git directory;
3. pin the canonical Git common directory and worktree Git directory;
4. bounded-read the common config and, when enabled, worktree config;
5. reject every `include.path` and `includeIf.*.path` declaration;
6. validate any `core.attributesFile` path and pin its authorized identity.

Bare repositories, malformed `.git`/`commondir` files, symlinks, paths outside
the source/Git authority, and ambiguous config sources fail
`unsupported_git_state`.

Only after this preflight may Git commands run. Commands that read config use
includes-disabled mode. Filter commands are rejected before `git status` or any
operation that compares or materializes worktree content. `check-attr` may run
only after the authorized attributes-file path has been validated.

Git subprocesses inherit no ambient Git authority or configuration variables.
The adapter constructs a new allowlisted environment. It carries only the
minimum non-Git process variables required to launch the resolved executable.
It does not carry ambient `HOME`, `XDG_CONFIG_HOME`, `PREFIX`, `LD_*`, or
`DYLD_*` variables. `HOME` and `XDG_CONFIG_HOME` are either absent or set to a
pinned, empty, mode-`0700`, current-user-owned private directory created for
the observation. The adapter sets these Git values itself:

```text
GIT_OPTIONAL_LOCKS=0
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=<platform-null-device>
GIT_ATTR_NOSYSTEM=1
GIT_TERMINAL_PROMPT=0
LC_ALL=C
LANG=C
```

Every ambient variable whose name starts with `GIT_` is removed before the
allowlisted values are added. This includes `GIT_CONFIG_COUNT`,
`GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, `GIT_CONFIG_PARAMETERS`,
`GIT_CONFIG`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
`GIT_COMMON_DIR`, and config/attribute discovery overrides.

Acceptance injects an environment-backed include, command filter,
`core.attributesFile`, alternate index, worktree, Git directory, object
directory, and alternate object directory. None may affect observation or
execute a command.

Every `check-attr` invocation explicitly sets `core.attributesFile` to the
preflight-authorized pinned path, or to the platform null device when the
canonical value is `null`. Acceptance also injects user attributes through
ambient `HOME` and `XDG_CONFIG_HOME`; neither source may affect path
attributes.

The pinned config identities and content hashes enter the source-state payload.
Every later Git config read has system/global config and includes disabled.

Missing config files are allowed only when Git confirms the corresponding
scope is absent. A read, parse, identity, or source-origin ambiguity fails
`unsupported_git_state`.

Linked worktrees use the common config plus an authorized worktree config. A
config path outside the Git common directory or worktree Git directory is
unsupported.

### 5.5 Materialization values

The observer reads and preserves effective values for:

- `core.autocrlf`, canonical default `false`;
- `core.eol`, canonical default `native`;
- `core.attributesFile`, canonical default `null`;
- every `filter.<name>.clean`;
- every `filter.<name>.smudge`;
- every `filter.<name>.process`;
- every `filter.<name>.required`.

The adapter parses the exact NUL framing emitted by the supported Git versions.
Parser tests use captured byte fixtures and real Git subprocess tests on macOS
and Linux. A no-match exit is distinct from malformed output or command failure.

Any non-empty clean, smudge, or process filter command fails
`unsupported_git_state` before status/content work, whether or not the current
path selects that filter. `required` without a command does not make an empty
filter executable.

The complete effective values, origins, config hashes, path attributes, and EOL
information enter both exact observations and the materialization fingerprint.

### 5.6 Submodules and object formats

Mode `160000` and any reported submodule state fail
`unsupported_git_state`.

The integration fixture creates a local submodule with:

```text
git -c protocol.file.allow=always submodule add <source> <path>
```

Production Git environment does not enable file transport.

Observer and blob-map tests run with Git SHA-1 and Git SHA-256 repositories when
the installed Git supports both. Unsupported SHA-256 test setup is explicitly
skipped with the Git version reported; production accepts only the two formats.

### 5.7 Exact status and observation boundaries

`localCodeIndexStatus` does not infer freshness from `current.json`, snapshot
identity, or equality between a reference and the pointer from which that
reference was constructed.

For Git sources it performs two complete exact source observations A and B
using sections 5.1–5.6. It returns `exact: true` only when A and B are
byte-identical canonical payloads.

- If A equals the source-state identity stored by the current snapshot, status
  returns `available: true, fresh: true, exact: true`.
- If A and B are stable but A differs from stored source state, status returns
  `available: true, fresh: false, exact: true` with
  `reason: "local_code_index_stale"`.
- If A and B differ, status returns `available: false, fresh: false,
  exact: false` with `reason: "source_changed_during_index"`.

Non-Git status applies the same rule using complete content hashes.

Ensure performs one initial observation before planning and one final
observation after candidate snapshot durability verification but before
`current.json` publication. The two payloads must match. Helper functions do
not hide both observations inside a call made only before candidate
construction.

`source_changed_during_index` is included in the unavailable status reason
union.

Acceptance modifies, deletes, renames, and adds an untracked file after a
successful build and proves status never reports the old snapshot fresh.

## 6. Platform probe testability

The production `probePlatform` and `probePlatformSync` behavior remains
unchanged. Their implementation gains one internal seam for filesystem probe
operations or temporary-root creation. Production uses the Node filesystem
adapter; tests inject deterministic failures.

Tests do not rely on chmod-based unwritability, current user privileges,
environment mutation after module import, or child-process timeout as the
primary assertion.

Required failure tests inject:

- async temporary-directory creation failure;
- sync temporary-directory creation failure;
- file sync failure;
- directory sync failure;
- hard-link failure;
- rename failure.

Each test has exactly one cleanup owner. Cleanup is idempotent and cannot chmod
or remove an already-removed parent twice.

The real adapter still runs once on macOS and Linux to prove actual platform
capabilities and zero leaked probe directories.

## 7. Storage-root and CLI completion

### 7.1 Storage resolution

Storage resolution has two modes:

1. If the supplied CPB root is canonical and outside the source root, use
   `<cpbRoot>/indexes/local-code/v2`.
2. If the supplied CPB root is equal to or inside the source root, or no CPB
   root is supplied, use
   `<canonical-os.tmpdir()>/cpb-local-code-index-uid-<numeric-uid>` as the
   per-user CPB authority and store index data at
   `<authority>/indexes/local-code/v2`.

The unsafe candidate is never created or written. The selected storage root
must itself be outside the source root.

An explicitly supplied command flag `--cpb-root` takes precedence over the
router-provided CPB root. It follows the same safe-selection rule.

Source selection precedence is:

1. explicit `--source`/`-s`;
2. one optional positional path after the subcommand;
3. current working directory.

Therefore `cpb code-index build .` and
`cpb code-index build --source .` are equivalent. More than one positional
source or a positional source combined with `--source` is a syntax error.

Resolution validates the nearest existing ancestor without creating state.
`localCodeIndexStatus` remains read-only when the final cache/index directories
do not exist.

There is no fallback under `.cpb-local-index` or any other source-tree path.

On supported macOS and Linux, `process.getuid()` supplies the numeric user ID.
Absence of an exact numeric UID fails `unsupported_platform`.

Build creates `cpb-local-code-index-uid-<numeric-uid>` directly beneath the
canonical temporary root, exclusively with mode `0700`, then verifies owner
UID, mode, device/inode, no-follow path identity, and canonical containment
before use. A pre-existing symlink, wrong owner, group/world-accessible
authority directory, or changed authority generation fails
`unsafe_storage_root`.

The canonical system temporary root must be an actual directory whose owner,
mode, device, inode, no-follow identity, and canonical path are pinned and
revalidated. It is trusted only when either:

- it is owned by the current numeric UID and `(mode & 0o077) === 0`; or
- it is owned by UID `0` and its sticky bit is set.

Every other owner/mode combination fails `unsafe_storage_root`. A shared
temporary root is only the pinned parent; the directly nested
`cpb-local-code-index-uid-<numeric-uid>` directory remains the mode-`0700`,
current-user-owned authority. Status validates the nearest existing ancestor
and every existing authority component but creates no directory.

### 7.2 CLI result and exit codes

Canonical commands:

```text
cpb code-index build
cpb code-index status
cpb code-index query
cpb code-index inspect
cpb code-index gc
cpb code-index inspect-lock
cpb code-index repair-lock
cpb code-index evidence
```

Exit codes:

- `0`: requested operation completed and the reported index is available and
  exact where availability is required;
- `1`: unavailable, stale, unsafe, invalid, failed, or repair refused;
- `2`: command syntax or argument error.

Human and JSON status output report the same `available`, `fresh`, `exact`, and
reason values. An unavailable status never exits zero.

Argument helpers return a typed parse result; they do not call `process.exit`
inside the command module.

Acceptance runs the CLI through `dist/cli/cpb.js` from the repository root with
no special environment and proves:

- status on a missing index is read-only and exits 1;
- build uses the external cache and exits 0;
- status then reports exact/fresh and exits 0;
- an explicit safe external `--cpb-root` wins over the router root;
- no source-tree index state appears.

## 8. Release scanner completion

### 8.1 Semantic finding rule

The release scanner identifies contract ownership before applying a rule.

It rejects:

- imports/re-exports of the deleted v1 local-index modules;
- `checkLocalCodeIndexReady`, `readLocalCodeIndexFiles`,
  `readLocalCodeIndexSnapshot`, and v1 local-index types;
- local-index readiness/source-context fields named `indexFile`;
- detached local-index `indexSnapshotId`, tool, or fallback fields when their
  enclosing contract is local-code-index readiness or setup output;
- local-index objects with schema version 1;
- runtime branches that accept both local-index schema 1 and 2;
- emitted `dist` equivalents of those contracts;
- the old `code-index check` alias.

It does not reject:

- the repository-snapshot freshness contract in section 4.2;
- candidate-artifact schema version 1;
- generic words in comments, test names, or unrelated modules;
- migration recognizer fixtures and the reject-only state gate under an exact
  path-and-symbol allowlist.

A bare field name such as `indexSnapshotId` is insufficient evidence by itself.

### 8.2 Scanner implementation and performance

The scanner traverses explicit production roots, emitted `dist`, maintained
schema files, and named migration fixtures. It skips `.git`, `node_modules`,
`dist-tests`, artifacts, temporary roots, and unrelated generated trees.

Source findings use TypeScript syntax/context or an equivalent deterministic
owner classifier. String scanning is allowed for emitted JavaScript and CLI
help.

The scan:

- exits zero only with zero real findings;
- exits nonzero on unreadable in-scope files or classification ambiguity;
- prints counts by owner and reason;
- completes within 30 seconds on this repository on the reference local SSD;
- has positive and negative fixtures for every rule.

The current 76 findings must be triaged into:

1. real local-index v1 or detached local-index copies, which are removed;
2. repository-snapshot fields, which remain;
3. candidate-artifact fields, which remain;
4. scanner/test text, which is handled only by exact allowlists.

Broad file-level exemptions are forbidden.

## 9. Source-tree hygiene

The following generated files are removed from the source module:

```text
core/indexing/local-code-index/ast-grep-adapter.js
core/indexing/local-code-index/ast-grep-adapter.d.ts
core/indexing/local-code-index/contracts.js
core/indexing/local-code-index/contracts.d.ts
```

All emitted JavaScript and declaration output belongs under `dist` or
`dist-tests`.

Release verification rejects `.js`, `.d.ts`, source maps, benchmark output,
lock state, snapshots, or object shards under
`core/indexing/local-code-index/`, except intentional checked-in rule assets.

## 10. Benchmark evidence completion

The only canonical harness is:

```text
scripts/bench-local-code-index-v2.ts
```

`scripts/bench-local-code-index.ts` and command aliases are removed.

The harness and result implement parent Spec section 15.6 exactly:

- deterministic 1,000 and 10,000 eligible-file repositories;
- fixed language/content distribution and seed;
- Git and non-Git cases;
- full build, exact status, unchanged ensure, one-file edit, 100-file edit,
  branch switch, definitions, references, related files, and non-Git status;
- five disposable warmups and 30 isolated measured samples per scenario;
- pristine storage roots/baselines;
- child-process high-water RSS;
- exact p95 formula and parse-count assertions;
- supported Node 20 or 22;
- qualifying local SSD with known filesystem/storage reporting.

This section refines the parent result shape so one artifact can represent both
required fixture sizes. The artifact contains exactly two fixture records:

```ts
type BenchmarkFixture = Readonly<{
  eligibleFiles: 1000 | 10000;
  generatorSha256: string;
  generatedInventorySha256: string;
  eligibleBytes: number;
  gitObjectFormat: "sha1" | "sha256";
  commits: Readonly<{ base: string; branchA: string; branchB: string }>;
}>;

type BenchmarkSample = Readonly<{
  durationMs: number;
  peakRssBytes: number;
  mode: "reused" | "incremental" | "full" | null;
  discoveredFiles: number | null;
  parsedFiles: number | null;
  outcome:
    | Readonly<{
        kind: "status";
        available: true;
        fresh: true;
        exact: true;
      }>
    | Readonly<{
        kind: "ensure";
        available: true;
        snapshotId: string;
      }>
    | Readonly<{
        kind: "query";
        resultKind:
          | "definitions"
          | "references"
          | "imports"
          | "file-summary"
          | "related-files"
          | "inventory";
        snapshotId: string;
        requestSha256: string;
        resultSha256: string;
        resultCount: number;
      }>;
}>;

type BenchmarkScenario = Readonly<{
  name: string;
  fixtureSize: 1000 | 10000;
  repositoryKind: "git" | "non-git";
  warmupCount: 5;
  samples: readonly BenchmarkSample[];
  p95Ms: number;
  peakRssBytes: number;
}>;
```

`LocalCodeIndexBenchmarkResult` contains `fixtures: readonly
BenchmarkFixture[]` and the scenario records above instead of one ambiguous
top-level fixture identity.

The expected matrix is exactly 20 scenarios: all ten parent-spec scenarios for
both fixture sizes. Every scenario has five disposable warmups and exactly 30
successful measured samples. Every sample proves operation success and records
build mode, discovered files, and parsed files when those values apply.
Status samples prove `available/fresh/exact`; ensure samples prove a non-empty
snapshot identity. Query samples prove result kind, snapshot binding, result
count, `requestSha256`, and `resultSha256`. The request hash covers the
canonical query kind and all normalized query parameters. The result hash
covers the ordered semantic result fields and excludes duration, memory, and
all other timing/environment measurements.

The result must contain:

- `passed: true`;
- `failures: []`;
- exact scenario/sample counts;
- generator and inventory hashes;
- environment and Git commit identity;
- all parent performance budgets passing.

An artifact with zero successful samples, reduced fixture size, unsupported
Node, unknown storage, missing `passed`, or any scenario error is invalid and
must not be retained as release evidence.

The canonical benchmark command exits nonzero unless its artifact has
`passed: true`, `failures: []`, and passes an independent strict-schema
validator.

The implementation adds
`scripts/verify-local-code-index-v2-benchmark.ts`. Release verification invokes
this validator independently of the harness. It:

- rejects unknown or missing fields;
- recalculates p95 as sorted sample
  `ceil(0.95 * sampleCount) - 1`;
- checks every parse-count, mode, fixture, environment, and performance budget;
- validates every operation-specific outcome against its scenario;
- derives the expected canonical query requests and ordered semantic results
  from the checked-in fixture generator and scenario definitions, then checks
  `requestSha256` and `resultSha256`; result count alone never proves query
  correctness;
- validates generator/inventory hashes and commits;
- rejects evidence based only on file existence or the harness-provided
  `passed` value;
- exits nonzero for any invalidity.

`npm run bench:local-code-index` invokes only:

```text
node dist/scripts/bench-local-code-index-v2.js \
  --output artifacts/bench/local-code-index-v2.json
```

The existing 60-file artifact is deleted or moved to a non-release diagnostic
location with an explicit invalid label.

## 11. Acceptance tests

### 11.1 Focused correctness

All `tests/local-code-index*.test.ts` tests pass with zero skips except the
conditional Git SHA-256 setup described in section 5.6.

Required regression coverage includes:

- deleted path and staged rename;
- paths with spaces and non-ASCII text;
- config values and includes;
- clean/smudge/process filters;
- linked worktree config;
- submodule rejection;
- deterministic platform failure injection;
- default and explicit CLI storage;
- semantic release-scan positive/negative fixtures;
- source-tree generated-artifact rejection.
- build-then-modify, delete, rename, and add-untracked exact-status checks;
- benchmark strict-schema and tamper rejection.

### 11.2 Full gates

Run in this order:

```text
npm run typecheck
npm run build:node
npm run build:tests
node --test <all dist-tests/tests/local-code-index*.test.js>
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
```

Any failure stops acceptance. A later passing gate cannot waive an earlier
failure.

The focused platform jobs pass on:

- Ubuntu, Node 20;
- Ubuntu, Node 22;
- macOS, Node 20;
- macOS, Node 22.

### 11.3 Runtime smoke

From the repository root, without a custom environment:

1. `cpb code-index status .` reports missing and exits 1 without writing;
2. `cpb code-index build .` succeeds outside the source tree;
3. `cpb code-index status .` reports available, exact, and fresh;
4. every query kind returns a structurally valid result;
5. GC and lock inspection use typed module management operations;
6. no daemon, socket, MCP, PID, or source-tree index state exists.

## 12. Errors and observability

Existing typed local-index errors remain canonical. Completion may add internal
diagnostic details but no untyped public failure path.

Git observation errors include a bounded stage label:

```text
config_include_check
config_materialization_parse
porcelain_parse
metadata_pin
submodule_rejected
```

No error logs source contents, filter command bodies, environment values, or
unbounded Git output.

CLI JSON output and benchmark JSON are machine-readable. Human output states
the concrete result and reason.

## 13. Removal policy

This completion is a replacement:

- remove generated source artifacts;
- remove the noncanonical benchmark harness;
- remove detached local-index snapshot copies;
- remove actual v1 runtime paths found by semantic scan;
- keep distinct repository-snapshot and candidate-artifact contracts;
- do not add aliases, adapters, dual writes, or runtime conversion.

Offline migration remains the only code allowed to recognize persisted v1
local-index fields. Runtime state gate may reject them but not translate them.

## 14. Independent review rubric

Independent review scores 100 points:

- exact Git observation and stale-source prevention: 25;
- storage-root and CLI correctness: 15;
- contract ownership and release-scan precision: 20;
- deterministic platform testing: 10;
- benchmark and release evidence: 15;
- migration/removal with no compatibility path: 10;
- testability and operational diagnostics: 5.

Passing score: 95.

Automatic failure regardless of numeric score:

- stale or mixed source can be reported exact/fresh;
- a command-backed filter or external config include can execute during
  observation;
- deleted/renamed paths can corrupt inventory identity;
- normal CLI invocation selects source-tree storage or exits zero while
  unavailable;
- release scanning requires deleting a distinct non-local-index contract;
- actual local-index v1 remains accepted at runtime;
- benchmark evidence can pass with errors, reduced fixtures, unsupported
  runtime, unknown storage, or missing samples;
- focused or release gates may fail while completion is declared.
