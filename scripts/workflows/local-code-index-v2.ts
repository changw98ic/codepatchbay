export const meta = {
  name: 'local-code-index-v2',
  description: 'Implement the approved Local Code Index v2 deep module (12 phases, 22 files, replaces v1)',
  phases: [
    { title: 'Phase 0 — Contract lock and characterization' },
    { title: 'Phase 1 — Filesystem safety, identities, platform probe' },
    { title: 'Phase 2 — Socket-free repository and worktree locks' },
    { title: 'Phase 3 — Exact source observation' },
    { title: 'Phase 4 — Extraction and immutable repository objects' },
    { title: 'Phase 5 — Relationships, shards, snapshot identity' },
    { title: 'Phase 6 — Durable service, publication, status, GC' },
    { title: 'Phase 7 — Query engine and evidence consumers' },
    { title: 'Phase 8 — Runtime caller migration' },
    { title: 'Phase 9 — CLI and offline v1 state cleanup' },
    { title: 'Phase 10 — Delete v1 and close the release' },
    { title: 'Phase 11 — Repeatable performance evidence' },
  ],
};

// ─── Constants ───────────────────────────────────────────────────────────────

const SPEC_PATH = 'docs/architecture/local-code-index-v2-spec.md';
const PLAN_PATH = 'docs/architecture/local-code-index-v2-implementation-plan.md';
const MODULE_DIR = 'core/indexing/local-code-index';

const V1_SERVER = 'server/services/local-code-index.ts';
const V1_SNAPSHOT = 'core/indexing/local-code-index-snapshot.ts';
const V1_TEST = 'tests/local-code-index.test.ts';
const V1_SCRIPT = 'scripts/code-index.ts';

// Production files that import v1 (Phase 8 migration targets)
const V1_IMPORTERS = [
  'server/services/infra.ts',
  'server/services/project-capability-map.ts',
  'server/services/riskmap-service.ts',
  'server/orchestrator/scheduler.ts',
  'server/services/hub/hub-queue.ts',
  'server/services/hub/hub-registry.ts',
  'core/workflow/checklist-decomposer.ts',
  'core/engine/run-job-assurance.ts',
  'core/engine/run-job-prepare.ts',
  'cli/commands/init.ts',
  'scripts/code-index.ts',
  'scripts/queue-swebench-batch.ts',
  'scripts/run-swebench-product-validation.ts',
  'scripts/run-swebench-three-way.ts',
];

// ─── Phase 0: Contract lock and characterization ─────────────────────────────

phase('Phase 0 — Contract lock and characterization');

log('Creating public types, errors, limits in contracts.ts');
log('Creating index.ts with public type exports only');
log('Adding characterization tests for current v1 behavior');

const phase0Files = await parallel([
  // contracts.ts — public types, errors, limits
  () => agent(`Read the approved spec at ${SPEC_PATH} sections 5.1–5.3 and 12.
Create the file ${MODULE_DIR}/contracts.ts with:
1. All public types: LocalCodeIndexRef, LocalCodeIndexCoverage, LocalCodeIndexCoverageSummary, LocalCodeIndexToolState, LocalCodeIndexPhaseTimings, EnsureLocalCodeIndexOptions, LocalCodeIndexBuildStats, EnsureLocalCodeIndexResult, LocalCodeIndexStatus, SourceRange, SymbolOccurrence, FileRelationship, FileSummary, LocalCodeIndexQuery, LocalCodeIndexQueryResult.
2. The typed error class LocalCodeIndexUnavailableError with reason field.
3. All limits: default limit 50, max limit 500, max input paths 100, max input symbols 100, max symbol length 512.
4. Coverage ordering constant.
5. All error reason strings as a union type.
Use Readonly<> for all object types. Export everything. No runtime dependencies except node:crypto for any ID types.`, {
    label: 'phase0:contracts',
    phase: 'Phase 0 — Contract lock and characterization',
    isolation: 'worktree',
  }),

  // index.ts — public exports placeholder (no runtime functions yet)
  () => agent(`Create the file ${MODULE_DIR}/index.ts that:
1. Re-exports ONLY the public types from ./contracts.ts.
2. Does NOT export any runtime functions (ensureLocalCodeIndex, localCodeIndexStatus, queryLocalCodeIndex) — those are added in Phase 6.
3. Has a clear comment: "Runtime exports are added after service.ts exists (Phase 6)."
This file must compile with no errors.`, {
    label: 'phase0:index',
    phase: 'Phase 0 — Contract lock and characterization',
    isolation: 'worktree',
  }),

  // Compile-time contract tests
  () => agent(`Read the spec at ${SPEC_PATH} section 5.
Create tests/local-code-index-contract.test.ts with compile-time contract tests:
1. Prove that manifestPath, indexFile, and storage object types are NOT exported from the public module.
2. Prove that LocalCodeIndexRef has exactly the fields: schemaVersion, sourcePath, repositoryKey, worktreeKey, sourceKey, snapshotId.
3. Prove that LocalCodeIndexQuery discriminated union covers all 6 query kinds.
4. Prove that LocalCodeIndexUnavailableError has a reason field.
5. Prove limits are exported and correct (default 50, max 500).
Use Node test runner (node:test). Import from ${MODULE_DIR}/index.ts.`, {
    label: 'phase0:contract-test',
    phase: 'Phase 0 — Contract lock and characterization',
    isolation: 'worktree',
  }),

  // Characterization tests
  () => agent(`Read the current v1 code at ${V1_SERVER} and ${V1_SNAPSHOT}.
Create tests/local-code-index-caller-characterization.test.ts that records useful PRODUCT behavior of the current system (not v1 storage shape):
1. Test that ensureLocalCodeIndex produces an index with sourcePath, files array, tool info, and fingerprint.
2. Test that localCodeIndexStatus reports fresh/stale states.
3. Test that checkLocalCodeIndexReady returns readiness with indexFile and indexSnapshotId.
4. Test that the fallback when ast-grep is unavailable works (tool.available=false, fallback mode).
5. Test that taskSymbolCandidates extracts identifiers from task descriptions.
6. Test that buildLocalCodeIndexEvidence produces bounded text.
These tests document the BEHAVIOR that v2 must preserve. Use Node test runner. Use temp directories for isolation.`, {
    label: 'phase0:characterization',
    phase: 'Phase 0 — Contract lock and characterization',
    isolation: 'worktree',
  }),
]);

// Verify Phase 0 gate
log('Phase 0 gate: typecheck + build + tests');
await agent(`Run the Phase 0 gate verification:
1. Run: npm run typecheck
2. Run: npm run build:node && npm run build:tests
3. Run: node dist-tests/tests/local-code-index-contract.test.js
4. Run: node dist-tests/tests/local-code-index-caller-characterization.test.js
All must pass. Report the results.`, {
  label: 'phase0:gate',
  phase: 'Phase 0 — Contract lock and characterization',
});

// ─── Phase 1: Filesystem safety, identities, platform probe ──────────────────

phase('Phase 1 — Filesystem safety, identities, platform probe');

log('Implementing canonical JSON, paths, safe-files, platform probe');

const phase1Files = await parallel([
  // canonical-json.ts
  () => agent(`Create ${MODULE_DIR}/canonical-json.ts implementing:
1. canonicalStringify(value) — deterministic JSON serialization with sorted object keys, no insignificant whitespace, UTF-8, one trailing newline.
2. objectId(bytes: Uint8Array | string) — full SHA-256 hex digest.
3. Tests must prove byte-stable across insertion orders and nested structures.
No external dependencies. Use node:crypto for SHA-256.`, {
    label: 'phase1:canonical-json',
    phase: 'Phase 1 — Filesystem safety, identities, platform probe',
    isolation: 'worktree',
  }),

  // paths.ts
  () => agent(`Read spec section 7.1–7.2 for key derivation.
Create ${MODULE_DIR}/paths.ts implementing:
1. resolveStorageRoot(cpbRoot?, sourcePath) — canonical storage root resolution.
2. repositoryKey(commonGitDirOrSourcePath) — SHA-256 with prefix "cpb-local-index-v2-repository\\0", first 32 hex chars.
3. worktreeKey(canonicalSourcePath) — SHA-256 with prefix "cpb-local-index-v2-worktree\\0", first 32 hex chars.
4. sourceKey(repositoryKey, worktreeKey) — SHA-256 of concatenation.
5. validateSourcePath / validateStorageRoot — reject storage root inside source root.
6. All canonical path builders for the storage layout (objects, snapshots, locks, etc).
Use node:crypto, node:path, node:fs/promises.`, {
    label: 'phase1:paths',
    phase: 'Phase 1 — Filesystem safety, identities, platform probe',
    isolation: 'worktree',
  }),

  // safe-files.ts
  () => agent(`Create ${MODULE_DIR}/safe-files.ts implementing safe filesystem operations:
1. readBoundedFileNoFollow(path, maxBytes) — bounded no-follow regular-file read.
2. writeDurableFile(path, bytes) — write + FileHandle.sync() + close.
3. exclusiveCreateTemp(dir, prefix) — exclusive temporary file creation.
4. atomicRename(tempPath, finalPath) — atomic rename with fsync.
5. exclusiveHardLinkPublish(tempPath, finalPath) — exclusive same-filesystem hard link, unlink temp, fsync directory.
6. syncDirectory(dirPath) — fsync the directory.
7. pinnedIdentityRecheck(path, expected) — re-read and compare metadata identity.
All operations must use O_NOFOLLOW where possible. Use node:fs/promises and node:os.`, {
    label: 'phase1:safe-files',
    phase: 'Phase 1 — Filesystem safety, identities, platform probe',
    isolation: 'worktree',
  }),

  // platform.ts
  () => agent(`Create ${MODULE_DIR}/platform.ts implementing startup capability probe:
1. probePlatform() — tests device/inode stability, nanosecond timestamps, exclusive creation, same-filesystem hard links and rename, file sync, and directory sync.
2. Returns { supported: true } or { supported: false, reason: string }.
3. Must fail with "unsupported_platform" without leaving persistent state.
4. Use temporary directories for probes. Clean up on failure.
Test on macOS (darwin) assumptions: supports all capabilities.`, {
    label: 'phase1:platform',
    phase: 'Phase 1 — Filesystem safety, identities, platform probe',
    isolation: 'worktree',
  }),
]);

// Phase 1 tests
const phase1Tests = await parallel([
  () => agent(`Create tests/local-code-index-paths.test.ts testing:
1. repositoryKey and worktreeKey derivation are deterministic.
2. Storage root under source root is rejected.
3. Storage root equal to source root is rejected.
4. All canonical path builders produce correct paths.
5. sourceKey is SHA-256 of repository-key + "\\0" + worktree-key.`, {
    label: 'phase1:test-paths',
    phase: 'Phase 1 — Filesystem safety, identities, platform probe',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-safe-files.test.ts testing:
1. Path traversal attempts fail.
2. Symlink reads fail (no-follow).
3. Oversized input is rejected.
4. Identity recheck detects changes.
5. Exclusive creation prevents overwrites.
6. Atomic rename is durable.`, {
    label: 'phase1:test-safe-files',
    phase: 'Phase 1 — Filesystem safety, identities, platform probe',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-platform.test.ts testing:
1. Platform probe succeeds on supported systems.
2. Probe leaves no persistent state.
3. Injected filesystem failures are reported correctly.`, {
    label: 'phase1:test-platform',
    phase: 'Phase 1 — Filesystem safety, identities, platform probe',
    isolation: 'worktree',
  }),
]);

log('Phase 1 gate: verify canonical serialization stability, path safety, platform probe');
await agent(`Run Phase 1 gate:
1. npm run typecheck
2. npm run build:node && npm run build:tests
3. node dist-tests/tests/local-code-index-paths.test.js
4. node dist-tests/tests/local-code-index-safe-files.test.js
5. node dist-tests/tests/local-code-index-platform.test.js
Report results.`, {
  label: 'phase1:gate',
  phase: 'Phase 1 — Filesystem safety, identities, platform probe',
});

// ─── Phase 2: Socket-free locks ──────────────────────────────────────────────

phase('Phase 2 — Socket-free repository and worktree locks');

log('Implementing socket-free lock protocol');

const phase2Files = await parallel([
  // lock.ts
  () => agent(`Create ${MODULE_DIR}/lock.ts implementing the socket-free lock protocol:
1. Parameterized by canonicalLockDirectory, scopeKind ("repository-objects" | "worktree-publication"), scopeKey.
2. Atomic acquisition via exclusive directory/file creation.
3. Bounded wait with exponential backoff.
4. Exact release (owner-token verification before release).
5. Stale-owner election via recovery-elections/<owner-token-hash>/ directory.
6. Quarantine of stale lock files.
7. Orphan-election repair requiring exact pinned identities.
8. Process-incarnation probes for macOS and Linux (use node:child_process to run \`ps\` or read /proc/self/stat).
9. Lock order enforcement: repository objects first, then worktree publication.
10. Aggregate callback/release error handling.
Owner records contain scopeKind, scopeKey, pid, ownerToken, timestamp.
No network handles. No node:net imports.`, {
    label: 'phase2:lock',
    phase: 'Phase 2 — Socket-free repository and worktree locks',
    isolation: 'worktree',
  }),

  // management.ts (lock inspection/repair only at this phase)
  () => agent(`Create ${MODULE_DIR}/management.ts with typed internal operations:
1. inspectIndexLock(lockDir) — returns bounded identity descriptor (scopeKind, scopeKey, owner, age, state).
2. repairIndexLock(descriptor, lockDir) — accepts exact descriptor from inspection, never arbitrary paths.
3. Both operations work under the lock, not around it.
Test callers never parse owner/election files directly.`, {
    label: 'phase2:management',
    phase: 'Phase 2 — Socket-free repository and worktree locks',
    isolation: 'worktree',
  }),
]);

const phase2Tests = await parallel([
  () => agent(`Create tests/local-code-index-lock.test.ts testing:
1. Two-process acquisition has one owner.
2. Stale recovery cannot rename a successor.
3. Lock inspection and repair use typed module calls.
4. No index lock opens a network handle or imports node:net.
5. Fault injection covers every durable transition.`, {
    label: 'phase2:test-lock',
    phase: 'Phase 2 — Socket-free repository and worktree locks',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-lock-process.test.ts testing:
1. Simultaneous recovery elects one process.
2. Orphan repair requires exact pinned identities.
3. Process-incarnation probes work correctly.`, {
    label: 'phase2:test-lock-process',
    phase: 'Phase 2 — Socket-free repository and worktree locks',
    isolation: 'worktree',
  }),
]);

log('Phase 2 gate: concurrent lock tests, no network handles');
await agent(`Run Phase 2 gate:
1. npm run typecheck && npm run build:node && npm run build:tests
2. node dist-tests/tests/local-code-index-lock.test.js
3. node dist-tests/tests/local-code-index-lock-process.test.js
Report results.`, {
  label: 'phase2:gate',
  phase: 'Phase 2 — Socket-free repository and worktree locks',
});

// ─── Phase 3: Exact source observation ───────────────────────────────────────

phase('Phase 3 — Exact source observation');

log('Implementing Git and non-Git source observers');

const phase3Files = await parallel([
  // git-observer.ts
  () => agent(`Read spec section 8.1 for the exact Git inventory sequence.
Create ${MODULE_DIR}/git-observer.ts implementing:
1. Run the approved inventory sequence under fixed GIT_OPTIONAL_LOCKS=0, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null.
2. Execute in order: rev-parse (common dir, object format, HEAD), symbolic-ref, ls-files --stage, ls-files -v, ls-files -f, check-attr, ls-files --eol, config for filters, config for core settings, status porcelain v2.
3. Read local config without includes; reject include.path and includeIf.*.path with "unsupported_git_state".
4. Reject: unmerged entries, submodules, sparse/skip-worktree, assume-unchanged, FSMonitor-valid, command-backed filters, unsafe attributes, symlinks, special files.
5. Hash pinned worktree bytes (never blob bytes).
6. Produce deterministic source-state payload.
7. Repeat complete observation and compare canonical payload bytes.
8. Return { state: "clean" | "changed", payload: SourceStatePayload }.
Use node:child_process for git commands.`, {
    label: 'phase3:git-observer',
    phase: 'Phase 3 — Exact source observation',
    isolation: 'worktree',
  }),

  // directory-observer.ts
  () => agent(`Create ${MODULE_DIR}/directory-observer.ts implementing non-Git source observation:
1. Walk source tree under CPB ignore rules without following symlinks.
2. Hash every eligible file for exact status.
3. Treat metadata as planning information only.
4. Return deterministic source-state payload.
5. Produce same structure as git-observer for downstream compatibility.`, {
    label: 'phase3:directory-observer',
    phase: 'Phase 3 — Exact source observation',
    isolation: 'worktree',
  }),

  // change-plan.ts
  () => agent(`Create ${MODULE_DIR}/change-plan.ts implementing change planning:
1. Compare two source-state payloads (previous snapshot vs current observation).
2. Produce change plan with: reuse, compute, delete, retarget decisions.
3. Detect: additions, modifications, deletions, renames, branch changes, CRLF changes, encoding changes.
4. force=true bypasses reuse decisions but still performs both observations.
5. Returns deterministic change plan for downstream extraction.`, {
    label: 'phase3:change-plan',
    phase: 'Phase 3 — Exact source observation',
    isolation: 'worktree',
  }),
]);

const phase3Tests = await parallel([
  () => agent(`Create tests/local-code-index-git-observer.test.ts covering:
1. Clean, dirty, untracked, deleted, renamed, branch-switched states.
2. CRLF, encoding, ident, attributes handling.
3. Rejected filter/config states.
4. Same-size restored-mtime edits detected.
5. Descriptor replacement detected.
6. Observer proves zero persistent writes.`, {
    label: 'phase3:test-git-observer',
    phase: 'Phase 3 — Exact source observation',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-directory-observer.test.ts covering:
1. Non-Git directory walk produces correct file list.
2. Symlinks are not followed.
3. Ignore rules are respected.`, {
    label: 'phase3:test-dir-observer',
    phase: 'Phase 3 — Exact source observation',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-source-race.test.ts covering:
1. Late untracked files detected by second observation.
2. Metadata changes detected.
3. Changed-state result when first and second payloads differ.`, {
    label: 'phase3:test-source-race',
    phase: 'Phase 3 — Exact source observation',
    isolation: 'worktree',
  }),
]);

log('Phase 3 gate: observer correctness, no persistent writes');
await agent(`Run Phase 3 gate:
1. npm run typecheck && npm run build:node && npm run build:tests
2. node dist-tests/tests/local-code-index-git-observer.test.js
3. node dist-tests/tests/local-code-index-directory-observer.test.js
4. node dist-tests/tests/local-code-index-source-race.test.js
Report results.`, {
  label: 'phase3:gate',
  phase: 'Phase 3 — Exact source observation',
});

// ─── Phase 4: Extraction and immutable repository objects ────────────────────

phase('Phase 4 — Extraction and immutable repository objects');

log('Implementing ast-grep adapter, extractor, object store');

const phase4Files = await parallel([
  // ast-grep-adapter.ts
  () => agent(`Create ${MODULE_DIR}/ast-grep-adapter.ts implementing the sole ast-grep process adapter:
1. Invoke ast-grep outline --json=stream with argument arrays.
2. Fixed output bounds, timeout, abort signal support.
3. Version capture (ast-grep --version).
4. Stream validation of output.
5. Output validation: reject malformed JSON, validate symbol schema.
6. Return structured extraction results per file.
7. No direct ast-grep binary path hardcoding — accept from caller.`, {
    label: 'phase4:ast-grep',
    phase: 'Phase 4 — Extraction and immutable repository objects',
    isolation: 'worktree',
  }),

  // extract.ts
  () => agent(`Create ${MODULE_DIR}/extract.ts implementing path-independent file fact extraction:
1. CPB-owned versioned extraction rules by supported language (from spec).
2. Calculate language extractor fingerprints from parser version, rule bytes, symbol schema, language mapping, effective language, parser mode.
3. Produce definitions, references, raw imports, signatures, parser errors, truncation markers.
4. No path-dependent resolved targets — facts derivable from source bytes only.
5. Lexical and inventory-only fallback without claiming structural completeness.`, {
    label: 'phase4:extract',
    phase: 'Phase 4 — Extraction and immutable repository objects',
    isolation: 'worktree',
  }),

  // object-store.ts
  () => agent(`Read spec section 7.3 for object identity rules.
Create ${MODULE_DIR}/object-store.ts implementing:
1. File object ID: SHA-256("cpb-file-object-v2\\0" + language + "\\0" + parserMode + "\\0" + extractorFingerprint + "\\0" + sourceContentId).
2. Blob-map object ID: SHA-256 of canonical JSON bytes.
3. Publish objects under repository lock with synced temp files and exclusive hard links.
4. Existing objects: bounded-read and byte-compare.
5. Object identity collision fails with "object_identity_collision".`, {
    label: 'phase4:object-store',
    phase: 'Phase 4 — Extraction and immutable repository objects',
    isolation: 'worktree',
  }),

  // coverage.ts
  () => agent(`Create ${MODULE_DIR}/coverage.ts implementing deterministic coverage aggregation:
1. Calculate effective coverage (ast-grep-structural > lexical-reference-fallback > file-inventory-only).
2. Track partial, failedFiles, oversizedFiles.
3. Parser absence and per-file failure produce exact coverage summaries.`, {
    label: 'phase4:coverage',
    phase: 'Phase 4 — Extraction and immutable repository objects',
    isolation: 'worktree',
  }),

  // rules directory
  () => agent(`Create ${MODULE_DIR}/rules/ directory with versioned extraction rule assets for supported languages (TypeScript, JavaScript, Python, Go, Rust, Java, etc). Each rule file contains the language-specific symbol extraction patterns for ast-grep.`, {
    label: 'phase4:rules',
    phase: 'Phase 4 — Extraction and immutable repository objects',
    isolation: 'worktree',
  }),
]);

const phase4Tests = await parallel([
  () => agent(`Create tests/local-code-index-extract.test.ts testing:
1. Identical bytes with different language/parser/fingerprint cannot collide.
2. Parser absence produces exact coverage summaries.
3. force=true change plan hashes and parses every eligible file.
4. Extraction produces correct definitions, references, raw imports.`, {
    label: 'phase4:test-extract',
    phase: 'Phase 4 — Extraction and immutable repository objects',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-object-store.test.ts testing:
1. Equal objects are reused.
2. Unequal final bytes fail object_identity_collision.
3. Per-file failure produces correct coverage.`, {
    label: 'phase4:test-object-store',
    phase: 'Phase 4 — Extraction and immutable repository objects',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/fixtures/fake-ast-grep.ts — a fake executable adapter for testing that produces controlled output without invoking real ast-grep.`, {
    label: 'phase4:test-fixture',
    phase: 'Phase 4 — Extraction and immutable repository objects',
    isolation: 'worktree',
  }),
]);

log('Phase 4 gate: object identity, collision handling, coverage');
await agent(`Run Phase 4 gate:
1. npm run typecheck && npm run build:node && npm run build:tests
2. node dist-tests/tests/local-code-index-extract.test.js
3. node dist-tests/tests/local-code-index-object-store.test.js
Report results.`, {
  label: 'phase4:gate',
  phase: 'Phase 4 — Extraction and immutable repository objects',
});

// ─── Phase 5: Relationships, shards, snapshot identity ───────────────────────

phase('Phase 5 — Relationships, shards, snapshot identity');

log('Building relationship graph, shard construction, snapshot identity');

const phase5Files = await parallel([
  // relationships.ts
  () => agent(`Create ${MODULE_DIR}/relationships.ts implementing:
1. Resolve imports from raw facts and versioned resolution-config fingerprint.
2. Build unique and ambiguous reference relationships separately.
3. Affected-set invalidation for: changed definitions, imports, aliases, configs, delete, rename, retarget, uniqueness transitions.
4. Evidence-backed relationship records with SourceRange evidence.`, {
    label: 'phase5:relationships',
    phase: 'Phase 5 — Relationships, shards, snapshot identity',
    isolation: 'worktree',
  }),

  // shards.ts
  () => agent(`Read spec section 7.5 for sharding rules.
Create ${MODULE_DIR}/shards.ts implementing:
1. Symbol lookup shards: first 2 bytes of SHA-256(symbol), NFC normalized.
2. File summary/relation shards: first 2 bytes of SHA-256(normalized path).
3. Only touched shards rebuilt during incremental update.
4. Untouched shard objects reused by object ID.
5. Deterministic shard construction from canonical JSON bytes.`, {
    label: 'phase5:shards',
    phase: 'Phase 5 — Relationships, shards, snapshot identity',
    isolation: 'worktree',
  }),

  // snapshot-store.ts
  () => agent(`Read spec section 7.4 for snapshot identity rules.
Create ${MODULE_DIR}/snapshot-store.ts implementing:
1. identity.json — immutable canonical snapshot identity (schema, keys, source path, git info, fingerprint, inventory, shard IDs, tool state).
2. Snapshot ID: "idx2-" + first 24 hex chars of SHA-256(canonical identity.json bytes).
3. index-map.json — maps lookup buckets to immutable object IDs.
4. runs/<run-id>.json — creation time, mode, duration, reuse counts.
5. Repeated identical state produces same snapshot ID and bytes.
6. Snapshot identity collision detection.`, {
    label: 'phase5:snapshot-store',
    phase: 'Phase 5 — Relationships, shards, snapshot identity',
    isolation: 'worktree',
  }),
]);

const phase5Tests = await parallel([
  () => agent(`Create tests/local-code-index-relationships.test.ts testing import resolution and evidence graph construction.`, {
    label: 'phase5:test-relationships',
    phase: 'Phase 5 — Relationships, shards, snapshot identity',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-shards.test.ts testing deterministic shard construction and incremental rebuild.`, {
    label: 'phase5:test-shards',
    phase: 'Phase 5 — Relationships, shards, snapshot identity',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-snapshot-identity.test.ts testing:
1. Same state produces same snapshot ID.
2. Timestamps change only run reports, never snapshot IDs.
3. Snapshot identity collision detection.`, {
    label: 'phase5:test-snapshot-identity',
    phase: 'Phase 5 — Relationships, shards, snapshot identity',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-incremental-differential.test.ts testing:
1. One-file changes rebuild only required file/shard objects.
2. Rename reuses file facts but rebuilds path-dependent relationships.
3. Unique-to-ambiguous and ambiguous-to-unique transitions update all evidence.
4. Deterministic differential suite applies alias/config edits, addition, deletion, rename, retarget, and zero/one/many-definition transitions, then byte-compares all queryable incremental output with a forced full build.`, {
    label: 'phase5:test-incremental',
    phase: 'Phase 5 — Relationships, shards, snapshot identity',
    isolation: 'worktree',
  }),
]);

log('Phase 5 gate: incremental correctness, differential comparison');
await agent(`Run Phase 5 gate:
1. npm run typecheck && npm run build:node && npm run build:tests
2. Run all Phase 5 tests
3. Verify incremental output byte-matches forced full build
Report results.`, {
  label: 'phase5:gate',
  phase: 'Phase 5 — Relationships, shards, snapshot identity',
});

// ─── Phase 6: Durable service, publication, status, GC ───────────────────────

phase('Phase 6 — Durable service, publication, status, GC');

log('Assembling the three-entry service facade');

const phase6Files = await parallel([
  // service.ts
  () => agent(`Create ${MODULE_DIR}/service.ts implementing the three-entry orchestration facade:
1. ensureLocalCodeIndex(options) — in-process promise coalescing keyed by storage root + source key.
2. Hold repository then worktree locks through: object verification, second source observation, snapshot publication, run report, current publication.
3. Store current plus two previous snapshot IDs in current.json.
4. 16-step publication protocol from spec section 7.6.
5. Retry once on source mutation, fail on second change.
6. force=true performs full parse while retaining both observations and all publication checks.`, {
    label: 'phase6:service',
    phase: 'Phase 6 — Durable service, publication, status, GC',
    isolation: 'worktree',
  }),

  // service.ts continued — localCodeIndexStatus
  () => agent(`Extend ${MODULE_DIR}/service.ts with localCodeIndexStatus:
1. Exact, read-only status inspection.
2. Writes no persistent bytes.
3. Returns available/fresh/exact with ref, tool state, files, indexedBytes.`, {
    label: 'phase6:status',
    phase: 'Phase 6 — Durable service, publication, status, GC',
    isolation: 'worktree',
  }),

  // gc.ts
  () => agent(`Create ${MODULE_DIR}/gc.ts implementing:
1. Explicit GC under repository lock across every worktree namespace.
2. Retained-snapshot and object collection.
3. Cannot remove objects retained by a current snapshot.
4. Interruption cleanup for owner-scoped unpublished files only.`, {
    label: 'phase6:gc',
    phase: 'Phase 6 — Durable service, publication, status, GC',
    isolation: 'worktree',
  }),

  // Complete index.ts exports
  () => agent(`Update ${MODULE_DIR}/index.ts to add the three real runtime exports:
1. ensureLocalCodeIndex
2. localCodeIndexStatus
3. queryLocalCodeIndex (stub for now, completed in Phase 7)
Re-export all types from contracts.ts.`, {
    label: 'phase6:exports',
    phase: 'Phase 6 — Durable service, publication, status, GC',
    isolation: 'worktree',
  }),
]);

const phase6Tests = await parallel([
  () => agent(`Create tests/local-code-index-publication.test.ts testing:
1. Crash points before and after every sync/rename keep readable prior current.
2. Two worktrees have separate current pointers and shared equal objects.
3. Mutations between initial and final observation retry once then fail.
4. force=true performs full parse with all publication checks.
5. Unchanged ensure returns same snapshot and parsedFiles: 0.`, {
    label: 'phase6:test-publication',
    phase: 'Phase 6 — Durable service, publication, status, GC',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-gc.test.ts testing:
1. ensure/GC races cannot remove retained objects.
2. Old snapshots are collected after current advances.
3. Quarantine and recovery paths are preserved.`, {
    label: 'phase6:test-gc',
    phase: 'Phase 6 — Durable service, publication, status, GC',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-concurrency.test.ts testing:
1. Two worktrees share equal objects.
2. Concurrent ensure calls coalesce.
3. Lock ordering prevents deadlocks.`, {
    label: 'phase6:test-concurrency',
    phase: 'Phase 6 — Durable service, publication, status, GC',
    isolation: 'worktree',
  }),
]);

// Replace v1 test with v2 behavior tests
log('Replacing v1 test with v2 behavior tests');
await agent(`Replace ${V1_TEST} with new v2 behavior tests that:
1. Test ensureLocalCodeIndex produces correct ref with schemaVersion: 2.
2. Test localCodeIndexStatus reports available/fresh states.
3. Test incremental rebuild reuses objects.
4. Test publication is atomic.
Write the new file, preserving the same test file path.`, {
  label: 'phase6:replace-test',
  phase: 'Phase 6 — Durable service, publication, status, GC',
  isolation: 'worktree',
});

log('Phase 6 gate: publication atomicity, GC safety, concurrency');
await agent(`Run Phase 6 gate:
1. npm run typecheck && npm run build:node && npm run build:tests
2. Run all Phase 6 tests
Report results.`, {
  label: 'phase6:gate',
  phase: 'Phase 6 — Durable service, publication, status, GC',
});

// ─── Phase 7: Query engine and evidence consumers ────────────────────────────

phase('Phase 7 — Query engine and evidence consumers');

log('Implementing query interface and evidence helpers');

const phase7Files = await parallel([
  // query.ts
  () => agent(`Read spec section 5.2 for query interface.
Create ${MODULE_DIR}/query.ts implementing:
1. Exact/prefix definitions lookup.
2. Exact references lookup.
3. Imports query.
4. File summary query.
5. Related files with evidence and scoring.
6. Paginated inventory with cursors.
7. Validate cpbRoot, reference identities, snapshot, limits, symbols, paths, abort signals, cursor checksums.
8. Hold repository lock from snapshot validation through last object read.
9. Return deterministic ordering, evidence, truncation, timing, coverage.
10. Cursor integrity: unkeyed SHA-256 over schema version, snapshot ID, query kind, last key.`, {
    label: 'phase7:query',
    phase: 'Phase 7 — Query engine and evidence consumers',
    isolation: 'worktree',
  }),

  // evidence.ts
  () => agent(`Create ${MODULE_DIR}/evidence.ts implementing:
1. Task-symbol candidate extraction from task descriptions.
2. Evidence rendering from query results (not parsed manifests).
3. Bounded evidence pack for assurance.
4. Related-file score evidence formatting.
Migrate logic from ${V1_SNAPSHOT} taskSymbolCandidates, exactSymbolFiles, buildLocalCodeIndexEvidence to consume v2 query results.`, {
    label: 'phase7:evidence',
    phase: 'Phase 7 — Query engine and evidence consumers',
    isolation: 'worktree',
  }),
]);

const phase7Tests = await parallel([
  () => agent(`Create tests/local-code-index-query.test.ts testing:
1. Every query kind passes: empty, bounded, truncated, malformed, stale-ref, abort cases.
2. Old snapshot expiry fails before partial results.
3. Deterministic ordering.
4. Cursor validation.`, {
    label: 'phase7:test-query',
    phase: 'Phase 7 — Query engine and evidence consumers',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-query-security.test.ts testing:
1. Query/ensure/GC races return complete locked snapshot or fail before partial output.
2. No referenced object disappears mid-query.
3. Path traversal in queries is rejected.`, {
    label: 'phase7:test-query-security',
    phase: 'Phase 7 — Query engine and evidence consumers',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-evidence.test.ts testing:
1. Related-file scores always include evidence.
2. Ambiguous references never appear as exact call edges.
3. Evidence pack is bounded.`, {
    label: 'phase7:test-evidence',
    phase: 'Phase 7 — Query engine and evidence consumers',
    isolation: 'worktree',
  }),
]);

log('Phase 7 gate: query correctness, security, evidence');
await agent(`Run Phase 7 gate:
1. npm run typecheck && npm run build:node && npm run build:tests
2. Run all Phase 7 tests
Report results.`, {
  label: 'phase7:gate',
  phase: 'Phase 7 — Query engine and evidence consumers',
});

// ─── Phase 8: Runtime caller migration ───────────────────────────────────────

phase('Phase 8 — Runtime caller migration');

log('Migrating 14 production files from v1 to v2 LocalCodeIndexRef');

// Migrate callers in parallel batches
const phase8Migrations = await pipeline(
  V1_IMPORTERS,
  async (filePath) => {
    return agent(`Migrate ${filePath} from v1 local code index to v2:
1. Replace all v1 imports (checkLocalCodeIndexReady, readLocalCodeIndexFiles, readLocalCodeIndexSnapshot, localCodeIndexFileFromContext, exactSymbolFiles, buildLocalCodeIndexEvidence, LocalCodeIndex, LocalCodeIndexFile) with v2 imports from ${MODULE_DIR}/index.ts.
2. Replace indexFile path storage with LocalCodeIndexRef storage.
3. Replace direct manifest/shard reads with queryLocalCodeIndex calls.
4. Replace localCodeIndexReadiness.indexFile with LocalCodeIndexRef.
5. Ensure source context stores ref instead of indexFile.
6. Update any types that reference v1 schema.
7. Keep behavior equivalent — same product outcomes, different storage.`, {
      label: `phase8:migrate:${filePath.split('/').pop()}`,
      phase: 'Phase 8 — Runtime caller migration',
      isolation: 'worktree',
    });
  }
);

// Rewrite affected tests
log('Rewriting affected tests for v2');
const phase8TestUpdates = await parallel([
  () => agent(`Update tests/code-index-capability-map.test.ts for v2 API:
Replace v1 index file reads with v2 queryLocalCodeIndex calls.`, {
    label: 'phase8:test-capability-map',
    phase: 'Phase 8 — Runtime caller migration',
    isolation: 'worktree',
  }),
  () => agent(`Update tests/run-job-assurance.test.ts for v2 API:
Replace v1 snapshot reads with v2 evidence queries.`, {
    label: 'phase8:test-assurance',
    phase: 'Phase 8 — Runtime caller migration',
    isolation: 'worktree',
  }),
  () => agent(`Update tests/checklist-decomposer.test.ts and tests/checklist-decompose-integration.test.ts for v2 API:
Replace v1 symbol lookups with v2 definition queries.`, {
    label: 'phase8:test-checklist',
    phase: 'Phase 8 — Runtime caller migration',
    isolation: 'worktree',
  }),
  () => agent(`Update tests/riskmap-service.test.ts for v2 API:
Replace v1 readiness with v2 ref state.`, {
    label: 'phase8:test-riskmap',
    phase: 'Phase 8 — Runtime caller migration',
    isolation: 'worktree',
  }),
  () => agent(`Update tests/queue-orchestrator.test.ts and tests/scheduler-concurrency-cas.test.ts for v2 API.`, {
    label: 'phase8:test-queue',
    phase: 'Phase 8 — Runtime caller migration',
    isolation: 'worktree',
  }),
]);

log('Phase 8 gate: no direct snapshot/shard reads, ref in source context');
await agent(`Run Phase 8 gate:
1. npm run typecheck && npm run build:node && npm run build:tests
2. Verify no production TypeScript contains direct snapshot/shard reads
3. Verify source context and durable queue records contain valid v2 ref and no indexFile
4. Run all main-flow and integration tests
Report results.`, {
  label: 'phase8:gate',
  phase: 'Phase 8 — Runtime caller migration',
});

// ─── Phase 9: CLI and offline v1 state cleanup ───────────────────────────────

phase('Phase 9 — CLI and offline v1 state cleanup');

log('Creating CLI commands and offline migration');

const phase9Files = await parallel([
  // cli/commands/code-index.ts
  () => agent(`Create cli/commands/code-index.ts with subcommands:
1. build — invoke ensureLocalCodeIndex, print ref/stats.
2. status — invoke localCodeIndexStatus, print status.
3. query — invoke queryLocalCodeIndex with query kind and params.
4. inspect — invoke management.inspectIndexLock.
5. gc — invoke GC under repository lock.
6. inspect-lock — emit bounded identity descriptor.
7. repair-lock — accept descriptor JSON file + authorized cpbRoot + source path; reject free-form paths.
CLI code never parses current.json, lock owners, snapshots, or shards.`, {
    label: 'phase9:cli',
    phase: 'Phase 9 — CLI and offline v1 state cleanup',
    isolation: 'worktree',
  }),

  // cli/commands/migrate.ts
  () => agent(`Create cli/commands/migrate.ts with only:
local-code-index-v2 --cpb-root <absolute-path> operation.
Dry validation report before mutation. Sequential queue and registry operations.`, {
    label: 'phase9:migrate-cli',
    phase: 'Phase 9 — CLI and offline v1 state cleanup',
    isolation: 'worktree',
  }),

  // Migration module
  () => agent(`Create server/services/migration/local-code-index-v2.ts implementing:
1. Resolve hub root, inspect projects.json and queue/queue.json.
2. Dry validation report before mutation.
3. Locked queue migration entry point in hub-queue.ts.
4. Locked registry migration entry point in hub-registry.ts.
5. Each acquires lock, rereads, revalidates, writes backup, applies transform, commits.
6. Refuse mutation if active work found.
7. Idempotent rerun support.`, {
    label: 'phase9:migration',
    phase: 'Phase 9 — CLI and offline v1 state cleanup',
    isolation: 'worktree',
  }),

  // State gate
  () => agent(`Create server/services/hub/local-code-index-state-gate.ts with fail-closed validator:
1. Hub/orchestrator startup invokes against registry and queue state before dispatch.
2. Scheduler candidate selection invokes as defense in depth.
3. Dispatchable v1 state fails unsupported_index_schema with migration instructions.`, {
    label: 'phase9:state-gate',
    phase: 'Phase 9 — CLI and offline v1 state cleanup',
    isolation: 'worktree',
  }),

  // Update scripts/code-index.ts
  () => agent(`Replace ${V1_SCRIPT} with new version that invokes the same command parser/service as cli/commands/code-index.ts. Remove old check subcommand.`, {
    label: 'phase9:script',
    phase: 'Phase 9 — CLI and offline v1 state cleanup',
    isolation: 'worktree',
  }),

  // Register commands
  () => agent(`Update cli/cpb.ts to register the new code-index and migrate commands with help text.`, {
    label: 'phase9:register',
    phase: 'Phase 9 — CLI and offline v1 state cleanup',
    isolation: 'worktree',
  }),
]);

const phase9Tests = await parallel([
  () => agent(`Create tests/code-index-cli.test.ts testing all CLI subcommands.`, {
    label: 'phase9:test-cli',
    phase: 'Phase 9 — CLI and offline v1 state cleanup',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-v2-migration.test.ts testing:
1. Active-job refusal changes no bytes.
2. Successful cleanup is byte-idempotent on rerun.
3. Injected write failures preserve backups.
4. Pending migrated work cannot dispatch before v2 ensure.`, {
    label: 'phase9:test-migration',
    phase: 'Phase 9 — CLI and offline v1 state cleanup',
    isolation: 'worktree',
  }),
  () => agent(`Create tests/local-code-index-v2-release-scan.test.ts testing:
1. Runtime startup rejects remaining dispatchable v1 state.
2. Scheduler defense-in-depth rejects v1 state.`, {
    label: 'phase9:test-release-scan',
    phase: 'Phase 9 — CLI and offline v1 state cleanup',
    isolation: 'worktree',
  }),
]);

log('Phase 9 gate: idempotent migration, active-job refusal, state gate');
await agent(`Run Phase 9 gate:
1. npm run typecheck && npm run build:node && npm run build:tests
2. Run all Phase 9 tests
Report results.`, {
  label: 'phase9:gate',
  phase: 'Phase 9 — CLI and offline v1 state cleanup',
});

// ─── Phase 10: Delete v1 and close the release ──────────────────────────────

phase('Phase 10 — Delete v1 and close the release');

log('Removing v1 code after all callers migrated');

const phase10Changes = await parallel([
  // Delete v1 files
  () => agent(`Delete the following v1 files:
1. ${V1_SERVER}
2. ${V1_SNAPSHOT}
Remove v1 types, checkLocalCodeIndexReady, readLocalCodeIndexFiles, readLocalCodeIndexSnapshot, readiness indexFile, and schema-1 runtime branches from all remaining files.`, {
    label: 'phase10:delete-v1',
    phase: 'Phase 10 — Delete v1 and close the release',
    isolation: 'worktree',
  }),

  // Release scan script
  () => agent(`Create scripts/verify-local-code-index-v2-release.ts that scans:
1. TypeScript source for v1 references.
2. Emitted dist/ for v1 imports.
3. Persisted-state schemas/fixtures for v1 fields.
4. CLI registrations for old commands.
Reject: LOCAL_CODE_INDEX_SCHEMA_VERSION=1, checkLocalCodeIndexReady, readLocalCodeIndexFiles, readLocalCodeIndexSnapshot, indexFile in readiness, schema-1 readers/writers, dual schema branches, detached v1 fields.
Allow: named migration input fixtures, offline migration recognizer, reject-only state gate.`, {
    label: 'phase10:release-scan',
    phase: 'Phase 10 — Delete v1 and close the release',
    isolation: 'worktree',
  }),

  // Update verification scripts
  () => agent(`Update scripts/verify-p0-p1.ts, scripts/verify-release-gate.ts, scripts/verify-stabilization.ts, and scripts/run-node-tests.ts to include v2 release scan and required tests.`, {
    label: 'phase10:verify-scripts',
    phase: 'Phase 10 — Delete v1 and close the release',
    isolation: 'worktree',
  }),

  // CI workflow
  () => agent(`Update .github/workflows/test.yml with focused local-index platform jobs for macOS and Ubuntu on Node 20 and 22. These jobs run safe-file, lock, publication, Git-observer, race, and release-scan suites.`, {
    label: 'phase10:ci',
    phase: 'Phase 10 — Delete v1 and close the release',
    isolation: 'worktree',
  }),

  // Docs update
  () => agent(`Update AGENTS.md, README, developer docs, architecture docs, CLI help, and test profile lists to use cpb code-index instead of v1 references.`, {
    label: 'phase10:docs',
    phase: 'Phase 10 — Delete v1 and close the release',
    isolation: 'worktree',
  }),
]);

// Remove v1-specific fixtures
log('Removing v1-specific test fixtures');
await agent(`Remove or rewrite v1-specific test fixtures. Retain only clearly named migration input fixtures.`, {
  label: 'phase10:fixtures',
  phase: 'Phase 10 — Delete v1 and close the release',
  isolation: 'worktree',
});

log('Phase 10 gate: full verification suite');
await agent(`Run Phase 10 gate:
1. npm run typecheck
2. npm run test:main
3. npm run test:integration
4. npm run test:specialized
5. npm run verify:p0p1
6. npm run verify:stabilization
7. npm run verify:release-gate
8. Verify no v1 references remain in production code
Report results.`, {
  label: 'phase10:gate',
  phase: 'Phase 10 — Delete v1 and close the release',
});

// ─── Phase 11: Repeatable performance evidence ──────────────────────────────

phase('Phase 11 — Repeatable performance evidence');

log('Building benchmark harness and generating release evidence');

const phase11Files = await parallel([
  // Benchmark generator
  () => agent(`Create tests/benchmarks/local-code-index-v2/generate.ts with:
1. Fixed seed, deterministic Git identity/timestamps.
2. Inventory hash.
3. 1,000-file and 10,000-file fixtures.`, {
    label: 'phase11:generator',
    phase: 'Phase 11 — Repeatable performance evidence',
    isolation: 'worktree',
  }),

  // Benchmark harness
  () => agent(`Create scripts/bench-local-code-index-v2.ts with:
1. Disposable warm-ups.
2. Isolated child processes.
3. Pristine baseline copies.
4. Exact scenario setup.
5. 30 measured samples.
6. p95 calculation.
7. Normalized child maxRSS.`, {
    label: 'phase11:harness',
    phase: 'Phase 11 — Repeatable performance evidence',
    isolation: 'worktree',
  }),

  // Benchmark contract test
  () => agent(`Create tests/local-code-index-benchmark-contract.test.ts verifying benchmark preconditions and postconditions.`, {
    label: 'phase11:test',
    phase: 'Phase 11 — Repeatable performance evidence',
    isolation: 'worktree',
  }),

  // package.json script
  () => agent(`Add bench:local-code-index script to package.json.`, {
    label: 'phase11:package',
    phase: 'Phase 11 — Repeatable performance evidence',
    isolation: 'worktree',
  }),
]);

log('Phase 11 gate: benchmark execution');
await agent(`Run Phase 11 gate:
1. npm run build:node
2. node dist/scripts/bench-local-code-index-v2.js --output artifacts/bench/local-code-index-v2.json
3. Verify: generator hashes, environment preconditions, sample counts, parse counts, p95 values, RSS, and every Spec section 3.2 budget pass.
Report results.`, {
  label: 'phase11:gate',
  phase: 'Phase 11 — Repeatable performance evidence',
});

// ─── Final verification ─────────────────────────────────────────────────────

log('Running final release verification');

await agent(`Run the complete final verification:
1. npm run typecheck
2. npm run test:main
3. npm run test:integration
4. npm run test:specialized
5. npm run verify:p0p1
6. npm run verify:stabilization
7. npm run verify:release-gate
8. Verify release scan passes
9. Verify benchmark evidence exists
Report the complete results.`, {
  label: 'final:verification',
  phase: 'Phase 11 — Repeatable performance evidence',
});

return { status: 'complete', phases: 12 };
