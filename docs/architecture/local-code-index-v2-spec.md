# Local Code Index v2 Specification

Status: Approved after independent review (97/100)
Target: CodePatchBay 0.5 canonical index contract
Decision owner: CPB maintainers
Compatibility policy: replace v1; no dual read, dual write, alias, or migration runtime

Review history:

- Revision 1: 62/100, failed with three automatic-failure findings.
- Revision 2: resolves Git special-state handling, object identity, worktree
  namespace separation, path-dependent relationships, snapshot durability,
  socket-free locking, complete public types, and reproducible benchmarks.
- Revision 2 review: 76/100, failed with two automatic-failure findings.
- Revision 3: binds exact freshness to materialized worktree bytes, serializes
  shared-object publication and GC, closes all object identities and query
  roots, makes coverage explicit, isolates benchmark runs, and completes
  release-state cleanup.
- Revision 3 review: 93/100, failed because the final Git observation still
  referenced the shorter Revision 2 inventory.
- Revision 4: repeats the complete exact inventory, defines coverage
  aggregation, closes materialization config inputs, and generalizes locking.
- Revision 4 review: 97/100, passed; no automatic-failure condition remained.

## 1. Summary

Local Code Index v2 replaces the monolithic v1 JSON snapshot with an incremental,
content-addressed, file-backed index. It remains a local library: it starts no
daemon, opens no socket, injects no MCP server, and writes no state into the
source tree.

The module has three entry points:

1. `ensureLocalCodeIndex` creates or refreshes an exact snapshot.
2. `localCodeIndexStatus` inspects the last published snapshot without changing
   it.
3. `queryLocalCodeIndex` answers bounded symbol, file, and relationship queries
   through the module interface.

Callers do not parse index files directly. Storage layout, sharding, cache reuse,
Git inspection, parser invocation, locking, and publication are hidden inside
the module.

The design borrows four proven ideas:

- Continue: metadata-first change planning, content-addressed reuse, explicit
  compute/delete operations, and completion recorded only after artifact
  publication.
- Aider RepoMap: definitions and references form a useful file-relationship
  graph even without a language-server-grade call graph.
- Zoekt: immutable file shards and query-time selection avoid loading the whole
  index.
- SCIP: occurrences, symbol information, and relationships are separate data
  concepts.

No source code is copied from those projects.

## 1.1 Supported runtime

- Node.js 20 and 22 are the required runtime versions.
- Canonical durable publication is supported on macOS and Linux local
  filesystems that provide stable device/inode identity, nanosecond timestamps,
  exclusive creation, atomic same-filesystem hard-link publication and rename,
  regular-file sync, and directory sync.
- Windows and filesystems that cannot prove those capabilities fail with
  `reason: "unsupported_platform"`. They do not silently weaken no-follow,
  identity, locking, or durability guarantees.
- A startup capability probe runs before the first mutation and leaves no
  persistent state when it fails.

## 2. Problem

The v1 implementation is correct for small repositories but has four structural
limits:

1. Freshness inspection reads and hashes every indexed file.
2. A refresh reads files for fingerprinting, then reads them again for parsing.
3. Any change rebuilds every file outline.
4. Callers read the monolithic JSON shape directly, so changing storage requires
   coordinated edits across workflow code.

The v1 index also provides definitions but not a first-class query interface for
references, imports, related files, or ranked task scope.

## 3. Goals

### 3.1 Required outcomes

v2 shall:

- reparse only files whose content object is not already indexed;
- reuse indexed content across branches and worktrees of the same canonical
  repository;
- detect additions, modifications, deletions, renames, branch changes, dirty
  tracked files, and untracked files;
- publish immutable snapshots atomically;
- provide exact definition lookup, bounded reference lookup, file summaries,
  import relationships, and ranked related-file lookup;
- preserve an explicit fallback when ast-grep is unavailable or rejects a file;
- keep all persistent index data outside the source tree;
- remain usable without a long-running process;
- expose build and query statistics sufficient to verify performance claims;
- fail closed when freshness, ownership, publication, or parser coverage cannot
  be established.

### 3.2 Performance outcomes

On a local SSD and a warm operating-system file cache:

- a no-change exact check over 1,000 tracked files: p95 at or below 250 ms;
- a no-change exact check over 10,000 tracked files: p95 at or below 2 seconds;
- a one-file TypeScript refresh in a 10,000-file repository: p95 at or below
  1 second;
- exact symbol lookup in a 10,000-file repository: p95 at or below 50 ms;
- related-file lookup with a 100-result limit: p95 at or below 150 ms;
- peak resident memory during a 10,000-file refresh: below 256 MiB;
- unchanged content shall report `parsedFiles: 0`;
- a one-file content edit shall report `parsedFiles: 1`, unless the same content
  object already exists, in which case it shall report `parsedFiles: 0`.

Benchmarks must report repository size, indexed bytes, operating system, storage
type, Node version, ast-grep version, cold/warm state, and at least 30 measured
runs. A single timing is not acceptance evidence.

## 4. Non-goals

v2 does not:

- claim a complete cross-language call graph;
- run language servers or compilers;
- provide vector embeddings or semantic retrieval;
- replace `rg` for arbitrary full-text or regular-expression search;
- index files ignored by Git in a Git repository;
- follow symbolic links outside the canonical source root;
- preserve or read the v1 schema;
- expose storage shards as a public query contract;
- start a watcher, daemon, MCP server, HTTP server, or background scheduler.

## 5. Module and seam

The canonical module lives under `core/indexing/local-code-index/`. Its interface
is the only supported seam for index creation, inspection, and querying.

The current implementations in `server/services/local-code-index.ts` and
`core/indexing/local-code-index-snapshot.ts` are replaced, not wrapped.

### 5.1 Public interface

```ts
export type LocalCodeIndexRef = Readonly<{
  schemaVersion: 2;
  sourcePath: string;
  repositoryKey: string;
  worktreeKey: string;
  sourceKey: string;
  snapshotId: string;
}>;

export type LocalCodeIndexCoverage =
  | "ast-grep-structural"
  | "lexical-reference-fallback"
  | "file-inventory-only";

export type LocalCodeIndexCoverageSummary = Readonly<{
  effective: LocalCodeIndexCoverage;
  partial: boolean;
  failedFiles: number;
  oversizedFiles: number;
}>;

export type LocalCodeIndexToolState = Readonly<{
  name: "ast-grep";
  version: string | null;
  extractorFingerprint: string;
  available: boolean;
  coverage: LocalCodeIndexCoverageSummary;
  errors: readonly string[];
}>;

export type LocalCodeIndexPhaseTimings = Readonly<{
  inventoryMs: number;
  hashingMs: number;
  parsingMs: number;
  astGrepMs: number;
  fileReadMs: number;
  fileFactExtractionMs: number;
  fileObjectPublicationMs: number;
  relationshipMs: number;
  shardPublicationMs: number;
  snapshotPublicationMs: number;
  lookupMs: number;
  publicationMs: number;
}>;

export type EnsureLocalCodeIndexOptions = Readonly<{
  cpbRoot?: string;
  sourcePath: string;
  force?: boolean;
  signal?: AbortSignal;
}>;

export type LocalCodeIndexBuildStats = Readonly<{
  mode: "reused" | "incremental" | "full";
  discoveredFiles: number;
  reusedFiles: number;
  hashedFiles: number;
  parsedFiles: number;
  deletedFiles: number;
  oversizedFiles: number;
  rebuiltSymbolShards: number;
  rebuiltRelationShards: number;
  bytesRead: number;
  bytesWritten: number;
  coverage: LocalCodeIndexCoverageSummary;
  parserVersion: string | null;
  timings: LocalCodeIndexPhaseTimings;
  durationMs: number;
}>;

export type EnsureLocalCodeIndexResult = Readonly<{
  available: true;
  ref: LocalCodeIndexRef;
  tool: LocalCodeIndexToolState;
  stats: LocalCodeIndexBuildStats;
}>;

export type LocalCodeIndexStatus =
  | Readonly<{
      available: false;
      fresh: false;
      exact: false;
      reason:
        | "missing_source_path"
        | "missing_local_code_index"
        | "unsupported_index_schema"
        | "unsafe_source_path"
        | "unsafe_storage_root"
        | "unsupported_platform"
        | "unsupported_git_state"
        | "corrupt_index";
      sourcePath: string | null;
    }>
  | Readonly<{
      available: true;
      fresh: boolean;
      exact: true;
      reason: null | "local_code_index_stale";
      ref: LocalCodeIndexRef;
      tool: LocalCodeIndexToolState;
      files: number;
      indexedBytes: number;
    }>;

export function ensureLocalCodeIndex(
  options: EnsureLocalCodeIndexOptions,
): Promise<EnsureLocalCodeIndexResult>;

export function localCodeIndexStatus(
  options: Readonly<{ cpbRoot?: string; sourcePath: string }>,
): Promise<LocalCodeIndexStatus>;

export function queryLocalCodeIndex(
  ref: LocalCodeIndexRef,
  query: LocalCodeIndexQuery,
  options?: Readonly<{ cpbRoot?: string; signal?: AbortSignal }>,
): Promise<LocalCodeIndexQueryResult>;
```

### 5.2 Query interface

```ts
export type SourceRange = Readonly<{
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}>;

export type SymbolOccurrence = Readonly<{
  symbol: string;
  kind: string;
  role: "definition" | "reference";
  path: string;
  range: SourceRange;
  exported: boolean;
  coverage: LocalCodeIndexCoverage;
}>;

export type FileRelationship = Readonly<{
  fromPath: string;
  toPath: string;
  type: "imports" | "references" | "ambiguous-reference";
  symbol: string | null;
  evidence: readonly SourceRange[];
  weight: number;
}>;

export type FileSummary = Readonly<{
  path: string;
  language: string;
  size: number;
  contentId: string;
  coverage: LocalCodeIndexCoverage;
  definitions: readonly SymbolOccurrence[];
  imports: readonly Readonly<{
    requested: string;
    resolvedPath: string | null;
    range: SourceRange;
  }>[];
  errors: readonly string[];
}>;

export type LocalCodeIndexQuery =
  | {
      kind: "definitions";
      symbol: string;
      match: "exact" | "prefix";
      limit?: number;
    }
  | {
      kind: "references";
      symbol: string;
      match: "exact";
      limit?: number;
    }
  | {
      kind: "imports";
      path: string;
      limit?: number;
    }
  | {
      kind: "file-summary";
      path: string;
    }
  | {
      kind: "related-files";
      paths: string[];
      symbols?: string[];
      limit?: number;
    }
  | {
      kind: "inventory";
      cursor?: string;
      limit?: number;
    };

export type LocalCodeIndexQueryResult =
  | Readonly<{
      kind: "definitions" | "references";
      snapshotId: string;
      coverage: LocalCodeIndexCoverageSummary;
      truncated: boolean;
      durationMs: number;
      occurrences: readonly SymbolOccurrence[];
    }>
  | Readonly<{
      kind: "imports";
      snapshotId: string;
      coverage: LocalCodeIndexCoverageSummary;
      truncated: boolean;
      durationMs: number;
      relationships: readonly FileRelationship[];
    }>
  | Readonly<{
      kind: "file-summary";
      snapshotId: string;
      coverage: LocalCodeIndexCoverageSummary;
      truncated: false;
      durationMs: number;
      file: FileSummary | null;
    }>
  | Readonly<{
      kind: "related-files";
      snapshotId: string;
      coverage: LocalCodeIndexCoverageSummary;
      truncated: boolean;
      durationMs: number;
      files: readonly Readonly<{
        path: string;
        score: number;
        evidence: readonly FileRelationship[];
      }>[];
    }>
  | Readonly<{
      kind: "inventory";
      snapshotId: string;
      coverage: LocalCodeIndexCoverageSummary;
      truncated: boolean;
      durationMs: number;
      files: readonly Readonly<{
        path: string;
        language: string;
        size: number;
        coverage: LocalCodeIndexCoverage;
      }>[];
      nextCursor: string | null;
    }>;
```

Limits:

- default result limit: 50;
- maximum result limit: 500;
- maximum input paths: 100;
- maximum input symbols: 100;
- maximum symbol length: 512 UTF-8 bytes;
- cursor values are opaque and snapshot-bound.

`limit` must be a safe integer from 1 through 500. Invalid limits fail with
`reason: "invalid_query"`; they are not clamped. Exact definition and reference
results sort by normalized path, range start, range end, then symbol kind.
Prefix definitions sort by exact-name match first, then symbol name, then the
same location order. Related files sort by descending score and normalized path.
Inventory sorts by normalized path.

Cursor payloads are integrity-checked with an unkeyed SHA-256 checksum over
schema version, snapshot ID, query kind, and last returned key. This detects
accidental damage but is not an authentication boundary. A malformed cursor
fails with `invalid_cursor`; a well-formed cursor for another snapshot fails
with `cursor_snapshot_mismatch`.

A query result always includes `snapshotId`, `coverage`, `truncated`, and
`durationMs`. Per-file coverage is retained in occurrences and inventory items.
A fallback result is never presented as a complete symbol graph.

`LocalCodeIndexCoverageSummary.effective` is the weakest guaranteed coverage
across files relevant to the operation, ordered from strongest to weakest as
`ast-grep-structural`, `lexical-reference-fallback`, then
`file-inventory-only`. `partial` is true when relevant files have mixed
coverage, `failedFiles > 0`, or `oversizedFiles > 0`. Ensure and tool-state
results count the whole snapshot. Query results count every file examined for
that query, including lookup candidates excluded from the returned page. An
empty result reports the coverage of the complete searched scope; it never
assumes structural success merely because no occurrence was returned.

### 5.3 Interface invariants

- `LocalCodeIndexRef` contains identities only. The module derives every storage
  path from the trusted CPB storage root plus repository and worktree keys.
- `ensureLocalCodeIndex`, `localCodeIndexStatus`, and `queryLocalCodeIndex` use
  the same `cpbRoot` resolution and canonicalization rules. When a non-default
  root was used to create a reference, its consumer must pass that authorized
  root to query; absence or mismatch fails with `invalid_index_ref`.
- The source path is canonicalized again at query time. A caller cannot use a
  constructed reference to authorize an arbitrary manifest path.
- `queryLocalCodeIndex` rejects a reference whose manifest, source key, schema,
  or snapshot ID does not match.
- A query holds the repository-key object lock from snapshot validation through
  its final object read. Garbage collection therefore either expires an old
  snapshot before the query starts, producing `missing_local_code_index`, or
  waits until the query completes; it cannot remove an object mid-query.
- Results contain only normalized source-relative paths using `/`.
- Callers never open the manifest or shard files themselves.
- Cancellation stops new work, closes opened file handles, removes unpublished
  temporary generations, and leaves the previous snapshot current.
- Cancellation fails with `local_code_index_unavailable` and
  `reason: "operation_aborted"`.
- All errors use `local_code_index_unavailable` with a reason listed in
  section 12.

## 6. Dependency classification

- Hashing, change planning, shard construction, ranking, and querying are
  in-process dependencies.
- Filesystem and Git are local-substitutable dependencies tested through
  temporary repositories.
- ast-grep is a true external executable. The implementation invokes it through
  one internal process adapter. Tests use a fake executable adapter.

These are internal seams. They are not exposed through the public interface.

## 7. Storage contract

### 7.1 Location

```text
<storage-root>/indexes/local-code/v2/
  repositories/
    <repository-key>/
      objects.lock/
        owner.json
      recovery-elections/
        <owner-token-hash>/
      objects/
        files/<object-prefix>/<file-object-id>.json
        blob-map/<object-prefix>/<blob-map-object-id>.json
        symbol-shards/<object-prefix>/<symbol-shard-id>.json
        relation-shards/<object-prefix>/<relation-shard-id>.json
  worktrees/
    <worktree-key>/
      current.json
      lock.lock/
        owner.json
      recovery-elections/
        <owner-token-hash>/
      snapshots/
        <snapshot-id>/
          identity.json
          index-map.json
      runs/
        <run-id>.json
```

`storage-root` is:

1. the configured CPB root when it is outside the canonical source root; or
2. the CPB local index cache root.

The implementation rejects a storage root inside the canonical source root. It
does not silently choose a source-tree directory.

### 7.2 Repository, worktree, and source keys

`repository-key` is the first 32 hexadecimal characters of:

```text
SHA-256("cpb-local-index-v2-repository\0" +
       canonical-common-git-dir-or-source-path)
```

`worktree-key` is the first 32 hexadecimal characters of:

```text
SHA-256("cpb-local-index-v2-worktree\0" + canonical-source-path)
```

`source-key` is:

```text
SHA-256(repository-key + "\0" + worktree-key)
```

Git worktrees sharing a common Git directory reuse repository objects but have
separate current pointers, locks, snapshots, and run reports. One worktree can
never replace another worktree's current pointer.

Non-Git directories use the canonical source path for both key inputs while
retaining the same two-namespace layout.

### 7.3 File object

A source content ID is `SHA-256(source bytes)`.

A file object ID is:

```text
SHA-256(
  "cpb-file-object-v2\0" +
  effective-language + "\0" +
  parser-mode + "\0" +
  language-extractor-fingerprint + "\0" +
  source-content-id
)
```

A file object is immutable and contains:

- source content ID, language extractor fingerprint, and byte size;
- language and parser mode;
- definitions with name, kind, range, export status, and optional signature;
- references with name, range, and reference kind;
- raw import/include requests with syntax range and import kind;
- parser errors and truncation markers;
- extractor version and rule-set fingerprint.

The object contains no absolute path, source-relative path, resolved import
target, package-resolution result, or repository configuration. It stores only
facts derivable from the source bytes and extractor fingerprint.

Path-dependent import resolution and all cross-file relationships belong to
snapshot relationship shards.

For clean tracked files, an immutable blob-map object records:

```text
(
  git-object-format,
  git-blob-id,
  worktree-materialization-fingerprint,
  effective-language,
  parser-mode,
  language-extractor-fingerprint
)
  -> (source-content-id, file-object-id)
```

The first encounter with a Git blob and materialization fingerprint reads and
hashes the pinned canonical worktree file, not raw blob bytes. Later worktrees
and branches may reuse the mapping only when every key field matches. A Git blob
ID is never treated as if it were a source SHA-256.

Blob-map, symbol-shard, and relation-shard object IDs are full SHA-256 digests
of their canonical JSON bytes. Canonical serialization follows the
`identity.json` rules. A stored object whose bytes do not match its object ID is
corrupt.

### 7.4 Snapshot identity and run report

`identity.json` is the immutable canonical snapshot identity. It contains only:

- schema version `2`;
- repository, worktree, and source keys;
- canonical source path;
- Git common directory, HEAD, branch, and object format when applicable;
- worktree state fingerprint;
- file inventory mapping normalized path to source content ID, file object ID,
  and pinned metadata identity;
- object extractor fingerprint;
- symbol and relationship lookup shard object IDs;
- tool state and explicit fallback coverage;

The snapshot ID is:

```text
idx2-<first 24 hex characters of SHA-256(canonical identity.json bytes)>
```

Canonical JSON uses UTF-8, sorted object keys, sorted path and shard maps, no
insignificant whitespace, and one trailing newline. Rebuilding identical source
and extractor state produces byte-identical `identity.json` and the same
snapshot ID.

If a directory for the same snapshot ID already exists, the implementation
reads and byte-compares both immutable files. Exact equality reuses it. Any
difference fails with `snapshot_identity_collision`; it never overwrites.

`index-map.json` is also part of canonical snapshot identity. `identity.json`
stores its SHA-256 and byte length. It maps lookup buckets to immutable object
IDs and contains no timestamps or runtime statistics.

Creation time, mode, duration, reuse counts, bytes, and phase timings are stored
in a separate immutable `runs/<run-id>.json`. `run-id` includes a random UUID.
Run reports never affect snapshot identity.

### 7.5 Sharding

Symbol lookup keys are normalized with Unicode NFC and case preserved.
Definitions and references are stored in one of 256 shards selected by the
first byte of `SHA-256(symbol)`.

File summaries and related-file records use the first byte of
`SHA-256(normalized path)`, yielding the same bounded 256-way layout as symbol
shards. This keeps full cold-start publication from becoming one durable object
per file while retaining deterministic, narrow incremental updates.

Only touched shards are rebuilt during an incremental update. Untouched shard
objects are reused by object ID.

### 7.6 Publication

Every operation that creates, verifies, replaces, or removes repository objects
acquires the socket-free repository-key object lock. Ensure acquires locks in
one global order: repository-key object lock, then worktree-key lock. It retains
both through current-pointer publication. Garbage collection acquires the same
repository lock and scans retained snapshots from every worktree namespace
before deleting an object. No code acquires these locks in reverse order.

Publication order is:

1. acquire the repository-key object lock, then the worktree-key durable lock;
2. exclusively create each missing object temporary file;
3. write, `FileHandle.sync()`, close, and identity-check each temporary file;
4. atomically publish each absent final object path with an exclusive
   same-filesystem hard link from the synced temporary file, unlink the
   temporary name, and fsync every modified object directory before the
   publication batch reports success;
5. exclusively create a temporary snapshot directory;
6. exclusively create `index-map.json`, write canonical bytes, sync the file,
   close it, and verify its hash and length;
7. exclusively create `identity.json`, write canonical bytes, sync the file,
   close it, and verify its hash-derived snapshot ID;
8. fsync the temporary snapshot directory;
9. atomically rename the temporary directory to
   `snapshots/<snapshot-id>` and fsync `snapshots/`;
10. reopen both snapshot files with bounded no-follow reads and verify their
    exact shape, hashes, lengths, IDs, and referenced immutable objects;
11. re-observe exact source state;
12. exclusively create a run-report temporary file, write, sync, close, rename,
    and fsync `runs/`;
13. exclusively create a `current.json` temporary file containing worktree key,
    snapshot ID, identity hash, publication owner token, and a deduplicated
    newest-first list of the two previously current snapshot IDs;
14. write, sync, close, and identity-check the current temporary file;
15. atomically rename it over `current.json` and fsync the worktree namespace;
16. release the lock only if the owner token and lock directory identity still
    match, in reverse order.

Directory sync never substitutes for syncing regular-file contents.

An immutable final object path is never replaced. If exclusive publication
reports that it already exists, the implementation performs a bounded no-follow
byte comparison against the canonical expected bytes and reuses it only on
exact equality. A mismatch fails with `object_identity_collision`.

If source state changes before step 13, the candidate snapshot is not published.
The operation retries once from a new inventory. A second change fails with
`reason: "source_changed_during_index"`.

The previous current snapshot remains readable throughout.

An error after step 15 reports `index_publication_ambiguous` with
`committed: true`, the expected snapshot ID, and recovery paths. It never reports
the previous snapshot as current without re-reading `current.json`.

## 8. Freshness and incremental algorithm

### 8.1 Git repositories

Every Git command uses an explicit environment and configuration:

```text
GIT_OPTIONAL_LOCKS=0
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=<platform-null-device>
git
  -c core.fsmonitor=false
  -c core.untrackedCache=false
  -c core.ignoreStat=false
  -c core.trustctime=true
  -c core.checkStat=default
  -c diff.external=
```

The inventory captures, in this order:

1. `git rev-parse --path-format=absolute --git-common-dir`;
2. `git rev-parse --show-object-format`;
3. `git rev-parse --verify HEAD`;
4. `git symbolic-ref --quiet --short HEAD`;
5. `git ls-files --stage -z`;
6. `git ls-files -v -z`;
7. `git ls-files -f -z`;
8. `git check-attr -z --stdin filter ident working-tree-encoding text eol` for
   every eligible tracked path;
9. `git ls-files --eol -z`;
10. `git config --null --show-origin --get-regexp
    '^filter\..*\.(clean|smudge|process|required)$'`;
11. `git config --null --show-origin --get-regexp
    '^(core\.autocrlf|core\.eol|core\.attributesFile)$'`;
12. `git status --porcelain=v2 -z --untracked-files=all
   --ignore-submodules=none`;
13. pinned filesystem metadata for every eligible path.

The implementation rejects the inventory with
`reason: "unsupported_git_state"` when it finds:

- more than one non-zero stage for a path;
- mode `160000` or any submodule state;
- `assume-unchanged`;
- `skip-worktree` or sparse-index entries;
- FSMonitor-valid entries;
- a command-backed clean, smudge, or process filter;
- an attribute or materialization configuration that cannot be parsed exactly;
- an external diff requirement;
- a path outside the canonical worktree;
- an untracked symbolic link or unsupported special file.

A tracked symbolic link (Git mode `120000`) remains in the Git state
observation but is not materialized, read, or sent to ast-grep. Its Git stage
and status remain part of the source-state fingerprint, so a link change still
invalidates the snapshot without allowing the indexer to follow its target.

Repository configuration is not trusted to weaken these checks. If Git output
cannot be parsed exactly, the index does not fall back to a clean classification.
Missing `core.autocrlf` and `core.eol` values use Git's documented canonical
defaults. An effective `core.attributesFile` outside the canonical worktree or
Git common directory fails with `unsupported_git_state`; CPB never follows it
into an unauthorized root. All three effective values and their origins are
included in the source-state payload.

The worktree-materialization fingerprint canonically includes the effective
`filter`, `ident`, `working-tree-encoding`, `text`, and `eol` attributes;
`core.autocrlf` and `core.eol`; Git object format; and the absence of
command-backed filters. Global and system Git configuration are disabled.
Repository-local materialization configuration is read as data, and no filter
command is executed by CPB.

A source content ID always hashes bytes visible at the canonical worktree path,
never untransformed Git blob bytes. Line-ending, encoding, ident, or other
materialization differences therefore cannot make blob contents stand in for
worktree source.

Each persisted path includes a pinned metadata identity:

```ts
{
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  mode: number;
}
```

Clean tracked files reuse a blob-map object only when:

- Git reports the path clean under the fixed configuration;
- stage 0 identifies the expected blob;
- the effective language, language extractor fingerprint, and complete
  worktree-materialization fingerprint match the blob-map key;
- current device, inode, size, mtime, ctime, and mode exactly match the previous
  snapshot;
- the platform capability probe established nanosecond precision.

If any condition differs, the worktree file is opened with no-follow flags,
hashed from a pinned descriptor, and revalidated after reading. Thus a same-size
rewrite with restored mtime is detected by ctime or inode; if those signals are
not trustworthy, the file is hashed.

The first encounter with a Git blob and materialization fingerprint reads and
hashes the pinned worktree file once and publishes the blob map only after the
file object is durable.

Dirty tracked and untracked files are always read and hashed. A changed or
replaced path restarts the inventory once, then fails closed.

After building candidate objects and before publishing current, the
implementation repeats inventory steps 1 through 13 under the same fixed Git
environment and configuration. It reconstructs the complete canonical
source-state payload, including repository and HEAD identity, stage entries,
attributes, materialization configuration and origins, porcelain status,
untracked paths, and pinned filesystem metadata, and byte-compares it with the
initial payload. Any difference restarts the operation once. A second
difference fails with `source_changed_during_index`. This complete second
observation prevents publication from a mixed inventory.

### 8.2 Non-Git directories

Non-Git directories use a recursive inventory respecting CPB ignore rules.
Because no trusted content-addressed source exists, exact freshness hashes all
eligible files. Metadata may plan likely changes, but metadata alone never
produces `fresh: true`.

### 8.3 Change plan

The planner classifies each path as:

- `reuse`: content object and extractor fingerprint already exist;
- `compute`: content object is absent or extractor fingerprint changed;
- `delete`: path existed in the previous snapshot but not the new inventory;
- `retarget`: path now names a content object already present under another path.

Only `compute` files invoke ast-grep.

### 8.4 Extractor changes

Parser version, ast-grep version, structural rule-set fingerprint, symbol schema,
and language mapping form the extractor fingerprint. Any extractor fingerprint
change invalidates affected file objects and cannot silently reuse old symbol
data.

### 8.5 Relationship construction

Relationships are evidence-backed and typed:

- `imports`: a deterministic import/include points to another indexed file;
- `references`: a file references a name uniquely defined by another file;
- `ambiguous-reference`: a referenced name has multiple possible defining
  files.

Ambiguous references are retained but carry lower weight and never claim a
unique call edge.

Related-file ranking uses:

1. explicit import weight;
2. unique symbol reference weight;
3. ambiguous symbol reference weight;
4. caller-provided seed path and symbol boosts;
5. deterministic weighted graph ranking;
6. stable path order as the final tie-breaker.

The result explains each returned file with contributing paths, symbols, edge
types, source ranges, and score. A score without evidence is invalid.

Import resolution is snapshot-local. It consumes raw import facts plus a
versioned resolution configuration fingerprint derived from relevant package
manifests, TypeScript/JavaScript config, language mapping files, and the complete
path inventory. No resolved target is reused merely because source bytes match.

The affected relationship set is the union of:

1. every added, modified, deleted, renamed, or retargeted path;
2. every old and new import target of those paths;
3. every path importing a renamed, added, or deleted target;
4. every path containing an old or new reference to a changed definition name;
5. every old and new defining path when a symbol changes between zero, one, or
   multiple definitions;
6. every path affected by a changed resolution-configuration fingerprint.

For each affected symbol, the old and new definition and reference shards are
read and unioned before relationship buckets are selected. For each affected
import, old and new resolved targets are unioned. Changed resolution
configuration rebuilds all import relationships for the affected language or
package scope; if the scope cannot be proven, all import relationships rebuild.

Rename and retarget operations never reuse path-dependent relationship records.
Only the path-independent file object is reused.

## 9. Parsing and coverage

### 9.1 Structural extraction

ast-grep is the primary extractor. CPB-owned, versioned rule files identify:

- definitions;
- references;
- imports/includes;
- exports;
- signatures where structurally available.

Rules are grouped by language and included in the extractor fingerprint.

### 9.2 Fallback

If ast-grep is unavailable:

- file inventory remains available;
- symbol, reference, and relationship queries return
  `coverage: "file-inventory-only"`;
- readiness may satisfy file-level scheduling only;
- symbol-scoped fast paths are disabled.

If one language or file fails:

- other successful files remain indexed;
- the manifest records per-file parser errors;
- queries return explicit partial coverage;
- a caller requiring complete structural coverage fails closed.

Lexical reference fallback may supplement definitions-only languages. It is
labeled and ranked below structural references.

### 9.3 Bounded inputs

- maximum indexed file size: 5 MiB by default;
- maximum symbols per file: 10,000;
- maximum references per file: 100,000;
- maximum signature size: 16 KiB;
- maximum parser output per process: 64 MiB;
- maximum parser batch: 120 files;
- oversized files remain in inventory with
  `coverage: "file-inventory-only"`.

## 10. Concurrency and recovery

One durable object lock exists per repository key and one durable publication
lock exists per worktree key. Both use the protocol below, are specific to the
index module, and do not use the repository's socket-backed general lock
primitive. Each lock owner records:

```ts
{
  scopeKind: "repository-objects" | "worktree-publication";
  scopeKey: string;
}
```

The repository lock uses its repository key; the publication lock uses its
worktree key.

### 10.1 Acquisition

1. Generate an unpredictable 128-bit owner token.
2. Capture exact process identity for the current platform.
3. Atomically create `lock.lock` with `mkdir`.
4. Exclusively create an owner temporary file inside that directory.
5. Write the exact lock path, owner token, process identity, scope kind, scope
   key, and acquisition time; sync and close the file.
6. Rename it to `owner.json`, sync `lock.lock`, and re-read both owner and lock
   directory identity.
7. The lock is acquired only after the re-read matches.

An existing directory with no valid owner is incomplete, not automatically
owned by the observer.

Concurrent callers in one process share one promise. Concurrent processes wait
for the owner or reuse the snapshot it publishes.

### 10.2 Liveness

Liveness uses exact process incarnation, never PID alone. An inaccessible,
coarse, malformed, or unsupported identity is indeterminate and cannot be
reclaimed automatically.

### 10.3 Stale recovery without socket or ABA deletion

For a valid owner proven dead:

1. Derive `owner-token-hash = SHA-256(owner token)`.
2. Atomically create
   `recovery-elections/<owner-token-hash>` with `mkdir`.
3. Only the process that created that election directory may continue.
4. Re-read and identity-check `lock.lock/owner.json`.
5. Require the same owner token, process identity, lock path, scope kind, scope
   key, and lock directory identity observed before election.
6. Rename `lock.lock` once to an exclusive quarantine path containing the owner
   token hash and random UUID.
7. Sync the canonical parent namespace containing that lock.
8. Never touch the canonical lock path again during that recovery.

The election directory is retained as evidence. A second recoverer for the same
owner token cannot rename a successor because it cannot win the already
published election. A new owner uses a new token and a newly created canonical
lock directory.

Incomplete locks without a valid owner are not automatically reclaimed. They
fail with `index_lock_repair_required`. An explicit repair command accepts the
observed lock directory identity, creates an election keyed by that identity,
renames the incomplete directory once, and never touches a successor.

The explicit repair command also handles an orphaned recovery election. It
requires pinned identities for the stale lock, dead owner, and election
directory; proves the election owner dead or unavailable; creates a new repair
election over that exact tuple; and quarantines the old election and stale lock.
It never touches a canonical lock or election whose generation differs from the
pinned input, and never touches a successor owner.

### 10.4 Release

Release:

1. re-reads and verifies owner token and directory identity;
2. renames the owned lock directory to an exclusive released quarantine;
3. syncs the canonical parent namespace containing that lock;
4. never recursively removes the canonical lock path.

A changed owner or directory generation fails with `index_lock_lost`. Callback
and release failures are aggregated.

### 10.5 Deadlines and cleanup

- Waiters have a bounded deadline and receive `index_lock_timeout`.
- Temporary object and snapshot generations are owner-token scoped.
- Cleanup removes only a pinned unpublished generation.
- Cleanup never removes an unverified path, recovery election, quarantine, or
  successor generation.
- No lock operation opens a listening socket or network handle.

Garbage collection is a separate explicit operation behind the same module. It
holds the repository object lock while enumerating every worktree namespace,
retains each current snapshot and the two previous IDs recorded by its durable
current pointer, and removes an object only when no retained snapshot manifest
references it. It may then quarantine older snapshot directories. A query for
an expired ref fails before returning partial results. Garbage collection never
runs in a task readiness check.

## 11. Security requirements

- Canonicalize source and storage roots before use.
- Reject a storage root equal to or nested under the source root.
- Reject source paths whose required ancestor authority changes during an
  operation.
- Do not follow source, manifest, shard, current-pointer, lock, or temporary-file
  symlinks.
- Read bounded regular files through pinned descriptors.
- Revalidate identity after reading and before publishing.
- Execute ast-grep directly with an argument array; never use a shell.
- Execute Git directly with the fixed environment and configuration in
  section 8.1; repository aliases, hooks, external diff, text conversion,
  FSMonitor, and optional locks cannot change inventory semantics.
- Treat repository content, parser output, and persisted index files as
  untrusted input.
- Reject unknown manifest fields where exact shape is required.
- Derive storage paths internally and verify every ancestor remains beneath the
  trusted storage root; caller-provided references contain no path authority.
- Never include secrets, environment variables, source contents, or absolute
  paths in logs beyond the canonical source path already authorized by the
  caller.

## 12. Errors

All externally visible failures use:

```ts
{
  code: "local_code_index_unavailable",
  reason:
    | "missing_source_path"
    | "unsafe_source_path"
    | "unsafe_storage_root"
    | "missing_local_code_index"
    | "unsupported_index_schema"
    | "corrupt_index"
    | "invalid_index_ref"
    | "invalid_query"
    | "invalid_cursor"
    | "cursor_snapshot_mismatch"
    | "operation_aborted"
    | "unsupported_platform"
    | "unsupported_git_state"
    | "index_lock_timeout"
    | "index_lock_lost"
    | "index_lock_repair_required"
    | "source_changed_during_index"
    | "parser_unavailable"
    | "parser_output_invalid"
    | "index_publication_failed"
    | "index_publication_ambiguous"
    | "object_identity_collision"
    | "snapshot_identity_collision"
    | "index_cleanup_ambiguous";
  sourcePath?: string;
  committed?: boolean;
  snapshotId?: string;
  recoveryPaths?: string[];
}
```

Unknown schemas are rejected. v1 is neither read nor upgraded at runtime. The
next successful ensure operation builds v2 from source and publishes it as the
only current snapshot.

## 13. Observability

Every ensure result reports:

- mode;
- discovered, reused, hashed, parsed, deleted, and oversized file counts;
- rebuilt lookup shard counts;
- bytes read and bytes written;
- inventory, hashing, parsing, lookup, and publication durations;
- parser version and coverage;
- snapshot ID.

No metric depends on a background collector. CLI JSON output is the canonical
diagnostic surface.

The CLI supports:

```text
cpb code-index build <path>
cpb code-index status <path>
cpb code-index query <path> --definitions <symbol>
cpb code-index query <path> --references <symbol>
cpb code-index query <path> --related-file <path>
cpb code-index inspect <path> --json
cpb code-index gc <path>
```

There is one canonical command name: `code-index`. The standalone development
script uses the same module and argument contract.

## 14. Caller changes

- Queue, scheduler, risk mapping, task preparation, and capability mapping store
  `LocalCodeIndexRef`, not a loose readiness record with a directly readable
  path.
- Checklist decomposition uses `queryLocalCodeIndex` for exact symbol scope.
- Assurance uses `queryLocalCodeIndex` for evidence and related files.
- Capability maps use paginated inventory queries.
- No caller imports storage types or reads index JSON.
- `readLocalCodeIndexFiles` and `readLocalCodeIndexSnapshot` are deleted.

## 15. Acceptance tests

### 15.1 Interface behavior

- first build publishes a full snapshot;
- unchanged ensure reuses the same snapshot ID;
- exact status is read-only;
- definitions, references, summaries, relationships, and inventory are queried
  only through the module interface;
- cursors cannot be reused with a different snapshot.

### 15.2 Incremental behavior

- one modified file reparses only that file;
- identical content under a renamed path reuses the content object;
- deletion removes path and relationship results;
- branch switch reuses matching content objects;
- two worktrees sharing one Git common directory have different `current.json`
  pointers while reusing repository objects;
- a Git SHA-1 or SHA-256 blob ID is mapped to, but never substituted for, the
  source-content SHA-256;
- the same source bytes under a different extractor fingerprint produce a
  different file-object ID;
- extractor fingerprint change reparses affected languages;
- changing an import target, path alias, package manifest, or language
  resolution config rebuilds every affected import relationship;
- rename, retarget, and unique-to-ambiguous definition transitions rebuild both
  old and new relationship buckets;
- definition removal rebuilds every affected relationship shard;
- concurrent ensure calls publish one current snapshot.

### 15.3 Freshness and races

- same-size rewrite with restored mtime is detected for dirty and untracked
  files;
- path replacement after open is rejected;
- source change during parsing retries once;
- a second source change fails without replacing current;
- mutations introduced after initial inventory but before final observation are
  independently detected through changed porcelain status, new untracked
  paths, and changed pinned metadata;
- `assume-unchanged`, `skip-worktree`, FSMonitor-valid, unmerged, and submodule
  states fail closed with `unsupported_git_state`;
- CRLF, `working-tree-encoding`, `ident`, and non-command materialization
  attributes index pinned worktree bytes and produce distinct materialization
  fingerprints where their effective behavior differs;
- command-backed clean, smudge, and process filters are rejected before
  `git status` can execute them;
- non-Git exact status hashes content;
- ignored and symbolic-link paths are excluded.

### 15.4 Durability and recovery

- crash before pointer publication leaves previous current readable;
- crash after immutable snapshot publication but before pointer publication is
  recoverable;
- every regular snapshot file is synced before its directory and current
  pointer are published;
- canonical snapshot identity is byte-identical across runs while timestamps
  and timings differ only in run reports;
- stale lock recovery preserves a successor owner;
- two simultaneous stale-lock recovery attempts elect only one recovery owner;
- an incomplete lock owner record fails with `index_lock_repair_required`;
- an orphaned recovery election can be quarantined only by the explicit
  identity-pinned repair flow;
- concurrent worktree publication and repository GC cannot replace or remove a
  referenced immutable object;
- an existing final object with unequal bytes fails with
  `object_identity_collision` instead of being replaced;
- post-rename directory sync failure reports committed ambiguity;
- garbage collection retains every referenced object;
- malformed and oversized manifests or shards fail closed.

### 15.5 Coverage

- ast-grep absence is explicit;
- one-language parser failure does not claim complete coverage;
- lexical fallback is labeled;
- oversized files remain inventory-visible but structurally unavailable;
- ambiguous definitions do not become unique relationship edges.

### 15.6 Performance

The implementation must add a versioned benchmark harness at
`scripts/bench-local-code-index-v2.ts` and a generator at
`tests/benchmarks/local-code-index-v2/generate.ts`. Both are production review
artifacts, not ad hoc local scripts.

The generator contract is:

- seed: unsigned 64-bit integer `0x4350424944585632`;
- sizes: exactly 1,000 and 10,000 eligible source files;
- languages: 70% TypeScript, 20% JavaScript, and 10% JSON, assigned by
  `fileNumber mod 10`;
- source files: UTF-8, LF, 4 KiB nominal payload with a deterministic
  `moduleNNNNN` definition, eight local references, two resolvable imports, and
  one deliberately ambiguous reference;
- JSON files: deterministic 4 KiB package/config fixtures that participate in
  import resolution but contain no structural symbol claims;
- directory fan-out: 100 files per directory;
- Git case: initialized repository with one base commit plus two branches whose
  100-file deterministic edit sets overlap by 50 files;
- Git author, committer, author date, committer date, default branch, object
  format, and all repository configuration are fixed by the generator so commit
  IDs are reproducible;
- non-Git case: byte-identical working tree with `.git` removed;
- no generated file is ignored, symbolic, sparse, submodule-backed, or larger
  than the configured index limit.

The checked-in generator's SHA-256, seed, generated inventory SHA-256, total
eligible byte count, Git object format, and base/branch commit IDs are recorded
in every result. A result whose generated inventory differs from the expected
hash emitted by the generator is invalid.

The canonical command is:

```text
npm run build:node && node dist/scripts/bench-local-code-index-v2.js \
  --output artifacts/bench/local-code-index-v2.json
```

The harness creates its fixture under an explicitly reported temporary
directory on the same filesystem as the index root. It runs these scenarios for
both sizes where applicable:

1. full build;
2. unchanged exact status;
3. unchanged ensure;
4. one-file content edit;
5. deterministic 100-file edit;
6. branch switch;
7. exact definition lookup for `module00500` or `module05000`;
8. exact reference lookup for the same symbol;
9. related-file lookup with `limit: 100`;
10. non-Git exact status.

Each timing scenario has five unreported warm-up runs followed by 30 measured
runs. Every individual run executes in a dedicated child process:

- every full build receives a newly created empty storage root;
- every one-file, 100-file, and branch-switch refresh starts from a
  byte-identical reflink/copy of a pristine baseline index that contains none of
  the post-change file objects;
- fixture restoration and baseline copying happen before the timer starts;
- unchanged status/ensure and query runs receive a copy of the same complete
  pristine baseline;
- acceptance rejects a one-file refresh unless `parsedFiles === 1` and rejects
  a full build unless its mode and counts prove an empty starting index.

Warm-ups use disposable roots under the same rules, so they warm only operating
system caches and cannot populate a measured run's object store. Query scenarios
open the same logical snapshot but an isolated storage copy. Runs are
sequential; no other CPB worker is started. The machine must have at least 2 GiB
free RAM and less than 20% aggregate CPU use during a 10-second preflight.
Failure of either precondition invalidates the run.

Durations use `process.hrtime.bigint()`. Each child reports
`process.resourceUsage().maxRSS` after the operation and immediately before
exit; the harness normalizes the platform-specific unit to bytes. OS-level peak
RSS may be recorded as a cross-check, but timer sampling is diagnostic only and
is not acceptance evidence. For 30 sorted measurements, p95 is item
`ceil(0.95 * 30) - 1`, zero-based. No outlier is discarded. Warm
operating-system cache is established only by the disposable warm-ups and is
explicitly labeled; full-build results additionally report the first unwarmed
run but it has no section 3.2 threshold.

The output is canonical JSON with:

```ts
type LocalCodeIndexBenchmarkResult = Readonly<{
  schemaVersion: 1;
  harnessCommit: string;
  generatorSha256: string;
  seed: string;
  generatedInventorySha256: string;
  eligibleFiles: number;
  eligibleBytes: number;
  gitObjectFormat: "sha1" | "sha256";
  commits: Readonly<{ base: string; branchA: string; branchB: string }>;
  environment: Readonly<{
    os: string;
    architecture: string;
    cpuModel: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
    storageType: "local-ssd";
    filesystem: string;
    nodeVersion: string;
    astGrepVersion: string | null;
  }>;
  scenarios: readonly Readonly<{
    name: string;
    repositoryKind: "git" | "non-git";
    samplesMs: readonly number[];
    p95Ms: number;
    peakRssBytes: number;
    stats: LocalCodeIndexBuildStats | null;
  }>[];
  passed: boolean;
  failures: readonly string[];
}>;
```

Acceptance requires all section 3.2 budgets, exact sample count, expected
`parsedFiles`, supported environment, and zero harness validation failures.
CI may preserve this JSON without enforcing hardware timing thresholds; release
evidence must come from a qualifying local-SSD machine and retain the exact
result artifact.

### 15.7 Replacement release

- runtime startup rejects persisted dispatchable records containing a v1 index
  reference;
- the offline cleanup refuses to change state while an affected job is active;
- cleanup removes v1 references from pending records, marks them for v2
  preparation, and invalidates derived capability maps;
- rerunning cleanup after success is byte-idempotent;
- an injected write or sync failure preserves v1 artifacts and reports durable
  backup paths;
- new source and built output contain no runtime v1 reader, v1 writer, dual
  format adapter, or legacy command alias;
- after cleanup, pending work cannot dispatch until a successful v2 ensure has
  produced a `LocalCodeIndexRef`.

## 16. Removal and migration

This is a replacement release:

- schema version becomes `2`;
- v1 readers and types are deleted;
- v1 snapshots are rejected as unsupported;
- the first v2 ensure rebuilds from source;
- no environment variable enables v1;
- no code path writes both formats;
- no adapter translates v1 query results;
- documentation describes only v2 after release.

The release contains one offline, one-way state cleanup command:

```text
cpb migrate local-code-index-v2 --cpb-root <absolute-path>
```

It is not imported by the v2 runtime and does not translate index contents. It
acquires the normal hub mutation lock, makes a durable backup of each bounded
registry or queue record it will change, and then:

1. removes persisted `localCodeIndexReadiness.indexFile`,
   `indexSnapshotId`, v1 tool/fallback details, and any v1 snapshot path;
2. marks affected pending work `localCodeIndexState: "needs-v2-prepare"` so the
   normal scheduler calls `ensureLocalCodeIndex` before dispatch;
3. invalidates persisted capability maps derived from v1 and requires normal
   regeneration through v2 queries;
4. refuses to proceed while any affected job is running, claimed, or otherwise
   externally owned;
5. emits a bounded JSON report naming changed record IDs, backups, and every
   v1 artifact eligible for later deletion.

The command is idempotent: records already free of v1 fields remain
byte-unchanged. Any write or sync failure stops before v1 artifacts are deleted.
Operators must drain or stop affected active jobs and rerun it. New runtime
startup fails with `unsupported_index_schema` when persisted dispatchable state
still contains a v1 index reference; it never repairs that state implicitly.

After successful state cleanup, the same command may delete only the explicitly
reported, unreferenced v1 artifact files using identity-checked rename to a
quarantine directory followed by directory sync. It reports recovery paths.
There is no broad directory glob deletion.

The implementation change set must remove or migrate every production caller in
this inventory:

- `cli/commands/init.ts`;
- `core/engine/run-job-assurance.ts`;
- `core/engine/run-job-prepare.ts`;
- `core/indexing/local-code-index-snapshot.ts`;
- `core/workflow/checklist-decomposer.ts`;
- `scripts/code-index.ts`;
- `scripts/queue-swebench-batch.ts`;
- `scripts/run-swebench-product-validation.ts`;
- `scripts/run-swebench-three-way.ts`;
- `server/orchestrator/scheduler.ts`;
- `server/services/hub/hub-queue.ts`;
- `server/services/hub/hub-registry.ts`;
- `server/services/infra.ts`;
- `server/services/local-code-index.ts`;
- `server/services/project-capability-map.ts`;
- `server/services/riskmap-service.ts`.

Tests and release preflight must also scan persisted schemas and production
source for direct readers, type declarations, pass-through fields, error
explanations, and dispatch logic involving `localCodeIndexReadiness.indexFile`,
`readLocalCodeIndexFiles`, `readLocalCodeIndexSnapshot`, or schema version `1`.
Any runtime occurrence is a release failure. Fixture-only occurrences must be
explicitly named as migration input tests.

## 17. Review rubric

Independent review scores 100 points:

- correctness and freshness: 20;
- incremental algorithm and performance: 20;
- module depth and interface quality: 15;
- storage durability and concurrency: 15;
- query capability and evidence quality: 10;
- security: 10;
- testability and acceptance evidence: 5;
- migration with no compatibility path: 5.

Passing score: 95.

Any of the following is an automatic failure regardless of numeric score:

- a daemon, socket, MCP server, or source-tree index state is required;
- stale source can be reported as exactly fresh;
- callers must parse storage files;
- publication can replace current before the snapshot is durable;
- v1 remains a supported runtime path;
- ambiguous references are presented as exact call relationships;
- performance claims have no repeatable benchmark definition.

## 18. Source references

- Continue incremental indexing:
  <https://github.com/continuedev/continue/blob/main/core/indexing/README.md>
- Continue change planner:
  <https://github.com/continuedev/continue/blob/main/core/indexing/refreshIndex.ts>
- Aider RepoMap:
  <https://github.com/Aider-AI/aider/blob/main/aider/repomap.py>
- Zoekt design:
  <https://github.com/sourcegraph/zoekt/blob/main/doc/design.md>
- SCIP schema:
  <https://github.com/scip-code/scip/blob/main/scip.proto>
