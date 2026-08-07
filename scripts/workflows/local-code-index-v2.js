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

var SPEC_PATH = 'docs/architecture/local-code-index-v2-spec.md';
var PLAN_PATH = 'docs/architecture/local-code-index-v2-implementation-plan.md';
var MODULE_DIR = 'core/indexing/local-code-index';

var V1_SERVER = 'server/services/local-code-index.ts';
var V1_SNAPSHOT = 'core/indexing/local-code-index-snapshot.ts';
var V1_TEST = 'tests/local-code-index.test.ts';
var V1_SCRIPT = 'scripts/code-index.ts';

var V1_IMPORTERS = [
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

// ─── Phase 0 ─────────────────────────────────────────────────────────────────

phase('Phase 0 — Contract lock and characterization');
log('Creating public types, errors, limits in contracts.ts and index.ts');

var phase0Files = await parallel([
  function() {
    return agent(
      'Read the approved spec at ' + SPEC_PATH + ' sections 5.1-5.3 and 12.\n' +
      'Create the file ' + MODULE_DIR + '/contracts.ts with:\n' +
      '1. All public types: LocalCodeIndexRef, LocalCodeIndexCoverage, LocalCodeIndexCoverageSummary, LocalCodeIndexToolState, LocalCodeIndexPhaseTimings, EnsureLocalCodeIndexOptions, LocalCodeIndexBuildStats, EnsureLocalCodeIndexResult, LocalCodeIndexStatus, SourceRange, SymbolOccurrence, FileRelationship, FileSummary, LocalCodeIndexQuery, LocalCodeIndexQueryResult.\n' +
      '2. The typed error class LocalCodeIndexUnavailableError with reason field.\n' +
      '3. All limits: default limit 50, max limit 500, max input paths 100, max input symbols 100, max symbol length 512.\n' +
      '4. Coverage ordering constant.\n' +
      '5. All error reason strings as a union type.\n' +
      'Use Readonly<> for all object types. Export everything. No runtime dependencies except node:crypto for any ID types.',
      { label: 'phase0:contracts', phase: 'Phase 0 — Contract lock and characterization', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create the file ' + MODULE_DIR + '/index.ts that:\n' +
      '1. Re-exports ONLY the public types from ./contracts.ts.\n' +
      '2. Does NOT export any runtime functions (ensureLocalCodeIndex, localCodeIndexStatus, queryLocalCodeIndex) - those are added in Phase 6.\n' +
      '3. Has a clear comment: "Runtime exports are added after service.ts exists (Phase 6)."\n' +
      'This file must compile with no errors.',
      { label: 'phase0:index', phase: 'Phase 0 — Contract lock and characterization', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Read the spec at ' + SPEC_PATH + ' section 5.\n' +
      'Create tests/local-code-index-contract.test.ts with compile-time contract tests:\n' +
      '1. Prove that manifestPath, indexFile, and storage object types are NOT exported from the public module.\n' +
      '2. Prove that LocalCodeIndexRef has exactly the fields: schemaVersion, sourcePath, repositoryKey, worktreeKey, sourceKey, snapshotId.\n' +
      '3. Prove that LocalCodeIndexQuery discriminated union covers all 6 query kinds.\n' +
      '4. Prove that LocalCodeIndexUnavailableError has a reason field.\n' +
      '5. Prove limits are exported and correct (default 50, max 500).\n' +
      'Use Node test runner (node:test). Import from ' + MODULE_DIR + '/index.ts.',
      { label: 'phase0:contract-test', phase: 'Phase 0 — Contract lock and characterization', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Read the current v1 code at ' + V1_SERVER + ' and ' + V1_SNAPSHOT + '.\n' +
      'Create tests/local-code-index-caller-characterization.test.ts that records useful PRODUCT behavior of the current system (not v1 storage shape):\n' +
      '1. Test that ensureLocalCodeIndex produces an index with sourcePath, files array, tool info, and fingerprint.\n' +
      '2. Test that localCodeIndexStatus reports fresh/stale states.\n' +
      '3. Test that checkLocalCodeIndexReady returns readiness with indexFile and indexSnapshotId.\n' +
      '4. Test that the fallback when ast-grep is unavailable works (tool.available=false, fallback mode).\n' +
      '5. Test that taskSymbolCandidates extracts identifiers from task descriptions.\n' +
      '6. Test that buildLocalCodeIndexEvidence produces bounded text.\n' +
      'These tests document the BEHAVIOR that v2 must preserve. Use Node test runner. Use temp directories for isolation.',
      { label: 'phase0:characterization', phase: 'Phase 0 — Contract lock and characterization', isolation: 'worktree' }
    );
  },
]);

log('Phase 0 gate: typecheck + build + tests');
await agent(
  'Run the Phase 0 gate verification:\n' +
  '1. Run: npm run typecheck\n' +
  '2. Run: npm run build:node && npm run build:tests\n' +
  '3. Run: node dist-tests/tests/local-code-index-contract.test.js\n' +
  '4. Run: node dist-tests/tests/local-code-index-caller-characterization.test.js\n' +
  'All must pass. Report the results.',
  { label: 'phase0:gate', phase: 'Phase 0 — Contract lock and characterization' }
);

// ─── Phase 1 ─────────────────────────────────────────────────────────────────

phase('Phase 1 — Filesystem safety, identities, platform probe');
log('Implementing canonical JSON, paths, safe-files, platform probe');

var phase1Files = await parallel([
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/canonical-json.ts implementing:\n' +
      '1. canonicalStringify(value) - deterministic JSON serialization with sorted object keys, no insignificant whitespace, UTF-8, one trailing newline.\n' +
      '2. objectId(bytes) - full SHA-256 hex digest.\n' +
      '3. Tests must prove byte-stable across insertion orders and nested structures.\n' +
      'No external dependencies. Use node:crypto for SHA-256.',
      { label: 'phase1:canonical-json', phase: 'Phase 1 — Filesystem safety, identities, platform probe', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Read spec section 7.1-7.2 for key derivation.\n' +
      'Create ' + MODULE_DIR + '/paths.ts implementing:\n' +
      '1. resolveStorageRoot(cpbRoot, sourcePath) - canonical storage root resolution.\n' +
      '2. repositoryKey(commonGitDirOrSourcePath) - SHA-256 with prefix "cpb-local-index-v2-repository\\0", first 32 hex chars.\n' +
      '3. worktreeKey(canonicalSourcePath) - SHA-256 with prefix "cpb-local-index-v2-worktree\\0", first 32 hex chars.\n' +
      '4. sourceKey(repositoryKey, worktreeKey) - SHA-256 of concatenation.\n' +
      '5. validateSourcePath / validateStorageRoot - reject storage root inside source root.\n' +
      '6. All canonical path builders for the storage layout (objects, snapshots, locks, etc).\n' +
      'Use node:crypto, node:path, node:fs/promises.',
      { label: 'phase1:paths', phase: 'Phase 1 — Filesystem safety, identities, platform probe', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/safe-files.ts implementing safe filesystem operations:\n' +
      '1. readBoundedFileNoFollow(path, maxBytes) - bounded no-follow regular-file read.\n' +
      '2. writeDurableFile(path, bytes) - write + FileHandle.sync() + close.\n' +
      '3. exclusiveCreateTemp(dir, prefix) - exclusive temporary file creation.\n' +
      '4. atomicRename(tempPath, finalPath) - atomic rename with fsync.\n' +
      '5. exclusiveHardLinkPublish(tempPath, finalPath) - exclusive same-filesystem hard link, unlink temp, fsync directory.\n' +
      '6. syncDirectory(dirPath) - fsync the directory.\n' +
      '7. pinnedIdentityRecheck(path, expected) - re-read and compare metadata identity.\n' +
      'All operations must use O_NOFOLLOW where possible. Use node:fs/promises and node:os.',
      { label: 'phase1:safe-files', phase: 'Phase 1 — Filesystem safety, identities, platform probe', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/platform.ts implementing startup capability probe:\n' +
      '1. probePlatform() - tests device/inode stability, nanosecond timestamps, exclusive creation, same-filesystem hard links and rename, file sync, and directory sync.\n' +
      '2. Returns { supported: true } or { supported: false, reason: string }.\n' +
      '3. Must fail with "unsupported_platform" without leaving persistent state.\n' +
      '4. Use temporary directories for probes. Clean up on failure.',
      { label: 'phase1:platform', phase: 'Phase 1 — Filesystem safety, identities, platform probe', isolation: 'worktree' }
    );
  },
]);

var phase1Tests = await parallel([
  function() {
    return agent(
      'Create tests/local-code-index-paths.test.ts testing:\n' +
      '1. repositoryKey and worktreeKey derivation are deterministic.\n' +
      '2. Storage root under source root is rejected.\n' +
      '3. Storage root equal to source root is rejected.\n' +
      '4. All canonical path builders produce correct paths.\n' +
      '5. sourceKey is SHA-256 of repository-key + "\\0" + worktree-key.',
      { label: 'phase1:test-paths', phase: 'Phase 1 — Filesystem safety, identities, platform probe', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-safe-files.test.ts testing:\n' +
      '1. Path traversal attempts fail.\n' +
      '2. Symlink reads fail (no-follow).\n' +
      '3. Oversized input is rejected.\n' +
      '4. Identity recheck detects changes.\n' +
      '5. Exclusive creation prevents overwrites.\n' +
      '6. Atomic rename is durable.',
      { label: 'phase1:test-safe-files', phase: 'Phase 1 — Filesystem safety, identities, platform probe', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-platform.test.ts testing:\n' +
      '1. Platform probe succeeds on supported systems.\n' +
      '2. Probe leaves no persistent state.\n' +
      '3. Injected filesystem failures are reported correctly.',
      { label: 'phase1:test-platform', phase: 'Phase 1 — Filesystem safety, identities, platform probe', isolation: 'worktree' }
    );
  },
]);

log('Phase 1 gate: verify canonical serialization stability, path safety, platform probe');
await agent(
  'Run Phase 1 gate:\n' +
  '1. npm run typecheck\n' +
  '2. npm run build:node && npm run build:tests\n' +
  '3. node dist-tests/tests/local-code-index-paths.test.js\n' +
  '4. node dist-tests/tests/local-code-index-safe-files.test.js\n' +
  '5. node dist-tests/tests/local-code-index-platform.test.js\n' +
  'Report results.',
  { label: 'phase1:gate', phase: 'Phase 1 — Filesystem safety, identities, platform probe' }
);

// ─── Phase 2 ─────────────────────────────────────────────────────────────────

phase('Phase 2 — Socket-free repository and worktree locks');
log('Implementing socket-free lock protocol');

var phase2Files = await parallel([
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/lock.ts implementing the socket-free lock protocol:\n' +
      '1. Parameterized by canonicalLockDirectory, scopeKind (repository-objects or worktree-publication), scopeKey.\n' +
      '2. Atomic acquisition via exclusive directory/file creation.\n' +
      '3. Bounded wait with exponential backoff.\n' +
      '4. Exact release (owner-token verification before release).\n' +
      '5. Stale-owner election via recovery-elections/<owner-token-hash>/ directory.\n' +
      '6. Quarantine of stale lock files.\n' +
      '7. Orphan-election repair requiring exact pinned identities.\n' +
      '8. Process-incarnation probes for macOS and Linux.\n' +
      '9. Lock order enforcement: repository objects first, then worktree publication.\n' +
      '10. Aggregate callback/release error handling.\n' +
      'Owner records contain scopeKind, scopeKey, pid, ownerToken, timestamp.\n' +
      'No network handles. No node:net imports.',
      { label: 'phase2:lock', phase: 'Phase 2 — Socket-free repository and worktree locks', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/management.ts with typed internal operations:\n' +
      '1. inspectIndexLock(lockDir) - returns bounded identity descriptor (scopeKind, scopeKey, owner, age, state).\n' +
      '2. repairIndexLock(descriptor, lockDir) - accepts exact descriptor from inspection, never arbitrary paths.\n' +
      '3. Both operations work under the lock, not around it.\n' +
      'Test callers never parse owner/election files directly.',
      { label: 'phase2:management', phase: 'Phase 2 — Socket-free repository and worktree locks', isolation: 'worktree' }
    );
  },
]);

var phase2Tests = await parallel([
  function() {
    return agent(
      'Create tests/local-code-index-lock.test.ts testing:\n' +
      '1. Two-process acquisition has one owner.\n' +
      '2. Stale recovery cannot rename a successor.\n' +
      '3. Lock inspection and repair use typed module calls.\n' +
      '4. No index lock opens a network handle or imports node:net.\n' +
      '5. Fault injection covers every durable transition.',
      { label: 'phase2:test-lock', phase: 'Phase 2 — Socket-free repository and worktree locks', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-lock-process.test.ts testing:\n' +
      '1. Simultaneous recovery elects one process.\n' +
      '2. Orphan repair requires exact pinned identities.\n' +
      '3. Process-incarnation probes work correctly.',
      { label: 'phase2:test-lock-process', phase: 'Phase 2 — Socket-free repository and worktree locks', isolation: 'worktree' }
    );
  },
]);

log('Phase 2 gate: concurrent lock tests, no network handles');
await agent(
  'Run Phase 2 gate:\n' +
  '1. npm run typecheck && npm run build:node && npm run build:tests\n' +
  '2. node dist-tests/tests/local-code-index-lock.test.js\n' +
  '3. node dist-tests/tests/local-code-index-lock-process.test.js\n' +
  'Report results.',
  { label: 'phase2:gate', phase: 'Phase 2 — Socket-free repository and worktree locks' }
);

// ─── Phase 3 ─────────────────────────────────────────────────────────────────

phase('Phase 3 — Exact source observation');
log('Implementing Git and non-Git source observers');

var phase3Files = await parallel([
  function() {
    return agent(
      'Read spec section 8.1 for the exact Git inventory sequence.\n' +
      'Create ' + MODULE_DIR + '/git-observer.ts implementing:\n' +
      '1. Run the approved inventory sequence under fixed GIT_OPTIONAL_LOCKS=0, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null.\n' +
      '2. Execute in order: rev-parse (common dir, object format, HEAD), symbolic-ref, ls-files --stage, ls-files -v, ls-files -f, check-attr, ls-files --eol, config for filters, config for core settings, status porcelain v2.\n' +
      '3. Read local config without includes; reject include.path and includeIf.*.path with unsupported_git_state.\n' +
      '4. Reject: unmerged entries, submodules, sparse/skip-worktree, assume-unchanged, FSMonitor-valid, command-backed filters, unsafe attributes, symlinks, special files.\n' +
      '5. Hash pinned worktree bytes (never blob bytes).\n' +
      '6. Produce deterministic source-state payload.\n' +
      '7. Repeat complete observation and compare canonical payload bytes.\n' +
      '8. Return { state: clean or changed, payload: SourceStatePayload }.\n' +
      'Use node:child_process for git commands.',
      { label: 'phase3:git-observer', phase: 'Phase 3 — Exact source observation', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/directory-observer.ts implementing non-Git source observation:\n' +
      '1. Walk source tree under CPB ignore rules without following symlinks.\n' +
      '2. Hash every eligible file for exact status.\n' +
      '3. Treat metadata as planning information only.\n' +
      '4. Return deterministic source-state payload.\n' +
      '5. Produce same structure as git-observer for downstream compatibility.',
      { label: 'phase3:directory-observer', phase: 'Phase 3 — Exact source observation', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/change-plan.ts implementing change planning:\n' +
      '1. Compare two source-state payloads (previous snapshot vs current observation).\n' +
      '2. Produce change plan with: reuse, compute, delete, retarget decisions.\n' +
      '3. Detect: additions, modifications, deletions, renames, branch changes, CRLF changes, encoding changes.\n' +
      '4. force=true bypasses reuse decisions but still performs both observations.\n' +
      '5. Returns deterministic change plan for downstream extraction.',
      { label: 'phase3:change-plan', phase: 'Phase 3 — Exact source observation', isolation: 'worktree' }
    );
  },
]);

var phase3Tests = await parallel([
  function() {
    return agent(
      'Create tests/local-code-index-git-observer.test.ts covering:\n' +
      '1. Clean, dirty, untracked, deleted, renamed, branch-switched states.\n' +
      '2. CRLF, encoding, ident, attributes handling.\n' +
      '3. Rejected filter/config states.\n' +
      '4. Same-size restored-mtime edits detected.\n' +
      '5. Descriptor replacement detected.\n' +
      '6. Observer proves zero persistent writes.',
      { label: 'phase3:test-git-observer', phase: 'Phase 3 — Exact source observation', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-directory-observer.test.ts covering:\n' +
      '1. Non-Git directory walk produces correct file list.\n' +
      '2. Symlinks are not followed.\n' +
      '3. Ignore rules are respected.',
      { label: 'phase3:test-dir-observer', phase: 'Phase 3 — Exact source observation', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-source-race.test.ts covering:\n' +
      '1. Late untracked files detected by second observation.\n' +
      '2. Metadata changes detected.\n' +
      '3. Changed-state result when first and second payloads differ.',
      { label: 'phase3:test-source-race', phase: 'Phase 3 — Exact source observation', isolation: 'worktree' }
    );
  },
]);

log('Phase 3 gate: observer correctness, no persistent writes');
await agent(
  'Run Phase 3 gate:\n' +
  '1. npm run typecheck && npm run build:node && npm run build:tests\n' +
  '2. node dist-tests/tests/local-code-index-git-observer.test.js\n' +
  '3. node dist-tests/tests/local-code-index-directory-observer.test.js\n' +
  '4. node dist-tests/tests/local-code-index-source-race.test.js\n' +
  'Report results.',
  { label: 'phase3:gate', phase: 'Phase 3 — Exact source observation' }
);

// ─── Phase 4 ─────────────────────────────────────────────────────────────────

phase('Phase 4 — Extraction and immutable repository objects');
log('Implementing ast-grep adapter, extractor, object store');

var phase4Files = await parallel([
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/ast-grep-adapter.ts implementing the sole ast-grep process adapter:\n' +
      '1. Invoke ast-grep outline --json=stream with argument arrays.\n' +
      '2. Fixed output bounds, timeout, abort signal support.\n' +
      '3. Version capture (ast-grep --version).\n' +
      '4. Stream validation of output.\n' +
      '5. Output validation: reject malformed JSON, validate symbol schema.\n' +
      '6. Return structured extraction results per file.\n' +
      '7. No hardcoding of ast-grep binary path.',
      { label: 'phase4:ast-grep', phase: 'Phase 4 — Extraction and immutable repository objects', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/extract.ts implementing path-independent file fact extraction:\n' +
      '1. CPB-owned versioned extraction rules by supported language.\n' +
      '2. Calculate language extractor fingerprints from parser version, rule bytes, symbol schema, language mapping, effective language, parser mode.\n' +
      '3. Produce definitions, references, raw imports, signatures, parser errors, truncation markers.\n' +
      '4. No path-dependent resolved targets.\n' +
      '5. Lexical and inventory-only fallback without claiming structural completeness.',
      { label: 'phase4:extract', phase: 'Phase 4 — Extraction and immutable repository objects', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Read spec section 7.3 for object identity rules.\n' +
      'Create ' + MODULE_DIR + '/object-store.ts implementing:\n' +
      '1. File object ID: SHA-256("cpb-file-object-v2\\0" + language + "\\0" + parserMode + "\\0" + extractorFingerprint + "\\0" + sourceContentId).\n' +
      '2. Blob-map object ID: SHA-256 of canonical JSON bytes.\n' +
      '3. Publish objects under repository lock with synced temp files and exclusive hard links.\n' +
      '4. Existing objects: bounded-read and byte-compare.\n' +
      '5. Object identity collision fails with object_identity_collision.',
      { label: 'phase4:object-store', phase: 'Phase 4 — Extraction and immutable repository objects', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/coverage.ts implementing deterministic coverage aggregation:\n' +
      '1. Calculate effective coverage (ast-grep-structural > lexical-reference-fallback > file-inventory-only).\n' +
      '2. Track partial, failedFiles, oversizedFiles.\n' +
      '3. Parser absence and per-file failure produce exact coverage summaries.',
      { label: 'phase4:coverage', phase: 'Phase 4 — Extraction and immutable repository objects', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/rules/ directory with versioned extraction rule assets for supported languages (TypeScript, JavaScript, Python, Go, Rust, Java). Each rule file contains the language-specific symbol extraction patterns.',
      { label: 'phase4:rules', phase: 'Phase 4 — Extraction and immutable repository objects', isolation: 'worktree' }
    );
  },
]);

var phase4Tests = await parallel([
  function() {
    return agent(
      'Create tests/local-code-index-extract.test.ts testing:\n' +
      '1. Identical bytes with different language/parser/fingerprint cannot collide.\n' +
      '2. Parser absence produces exact coverage summaries.\n' +
      '3. force=true change plan hashes and parses every eligible file.\n' +
      '4. Extraction produces correct definitions, references, raw imports.',
      { label: 'phase4:test-extract', phase: 'Phase 4 — Extraction and immutable repository objects', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-object-store.test.ts testing:\n' +
      '1. Equal objects are reused.\n' +
      '2. Unequal final bytes fail object_identity_collision.\n' +
      '3. Per-file failure produces correct coverage.',
      { label: 'phase4:test-object-store', phase: 'Phase 4 — Extraction and immutable repository objects', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/fixtures/fake-ast-grep.ts - a fake executable adapter for testing that produces controlled output without invoking real ast-grep.',
      { label: 'phase4:test-fixture', phase: 'Phase 4 — Extraction and immutable repository objects', isolation: 'worktree' }
    );
  },
]);

log('Phase 4 gate: object identity, collision handling, coverage');
await agent(
  'Run Phase 4 gate:\n' +
  '1. npm run typecheck && npm run build:node && npm run build:tests\n' +
  '2. node dist-tests/tests/local-code-index-extract.test.js\n' +
  '3. node dist-tests/tests/local-code-index-object-store.test.js\n' +
  'Report results.',
  { label: 'phase4:gate', phase: 'Phase 4 — Extraction and immutable repository objects' }
);

// ─── Phase 5 ─────────────────────────────────────────────────────────────────

phase('Phase 5 — Relationships, shards, snapshot identity');
log('Building relationship graph, shard construction, snapshot identity');

var phase5Files = await parallel([
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/relationships.ts implementing:\n' +
      '1. Resolve imports from raw facts and versioned resolution-config fingerprint.\n' +
      '2. Build unique and ambiguous reference relationships separately.\n' +
      '3. Affected-set invalidation for: changed definitions, imports, aliases, configs, delete, rename, retarget, uniqueness transitions.\n' +
      '4. Evidence-backed relationship records with SourceRange evidence.',
      { label: 'phase5:relationships', phase: 'Phase 5 — Relationships, shards, snapshot identity', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Read spec section 7.5 for sharding rules.\n' +
      'Create ' + MODULE_DIR + '/shards.ts implementing:\n' +
      '1. Symbol lookup shards: first 2 bytes of SHA-256(symbol), NFC normalized.\n' +
      '2. File summary/relation shards: first 2 bytes of SHA-256(normalized path).\n' +
      '3. Only touched shards rebuilt during incremental update.\n' +
      '4. Untouched shard objects reused by object ID.\n' +
      '5. Deterministic shard construction from canonical JSON bytes.',
      { label: 'phase5:shards', phase: 'Phase 5 — Relationships, shards, snapshot identity', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Read spec section 7.4 for snapshot identity rules.\n' +
      'Create ' + MODULE_DIR + '/snapshot-store.ts implementing:\n' +
      '1. identity.json - immutable canonical snapshot identity (schema, keys, source path, git info, fingerprint, inventory, shard IDs, tool state).\n' +
      '2. Snapshot ID: "idx2-" + first 24 hex chars of SHA-256(canonical identity.json bytes).\n' +
      '3. index-map.json - maps lookup buckets to immutable object IDs.\n' +
      '4. runs/<run-id>.json - creation time, mode, duration, reuse counts.\n' +
      '5. Repeated identical state produces same snapshot ID and bytes.\n' +
      '6. Snapshot identity collision detection.',
      { label: 'phase5:snapshot-store', phase: 'Phase 5 — Relationships, shards, snapshot identity', isolation: 'worktree' }
    );
  },
]);

var phase5Tests = await parallel([
  function() {
    return agent(
      'Create tests/local-code-index-relationships.test.ts testing import resolution and evidence graph construction.',
      { label: 'phase5:test-relationships', phase: 'Phase 5 — Relationships, shards, snapshot identity', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-shards.test.ts testing deterministic shard construction and incremental rebuild.',
      { label: 'phase5:test-shards', phase: 'Phase 5 — Relationships, shards, snapshot identity', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-snapshot-identity.test.ts testing:\n' +
      '1. Same state produces same snapshot ID.\n' +
      '2. Timestamps change only run reports, never snapshot IDs.\n' +
      '3. Snapshot identity collision detection.',
      { label: 'phase5:test-snapshot-identity', phase: 'Phase 5 — Relationships, shards, snapshot identity', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-incremental-differential.test.ts testing:\n' +
      '1. One-file changes rebuild only required file/shard objects.\n' +
      '2. Rename reuses file facts but rebuilds path-dependent relationships.\n' +
      '3. Unique-to-ambiguous and ambiguous-to-unique transitions update all evidence.\n' +
      '4. Deterministic differential suite applies alias/config edits, addition, deletion, rename, retarget, and zero/one/many-definition transitions, then byte-compares all queryable incremental output with a forced full build.',
      { label: 'phase5:test-incremental', phase: 'Phase 5 — Relationships, shards, snapshot identity', isolation: 'worktree' }
    );
  },
]);

log('Phase 5 gate: incremental correctness, differential comparison');
await agent(
  'Run Phase 5 gate:\n' +
  '1. npm run typecheck && npm run build:node && npm run build:tests\n' +
  '2. Run all Phase 5 tests\n' +
  '3. Verify incremental output byte-matches forced full build\n' +
  'Report results.',
  { label: 'phase5:gate', phase: 'Phase 5 — Relationships, shards, snapshot identity' }
);

// ─── Phase 6 ─────────────────────────────────────────────────────────────────

phase('Phase 6 — Durable service, publication, status, GC');
log('Assembling the three-entry service facade');

var phase6Files = await parallel([
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/service.ts implementing the three-entry orchestration facade:\n' +
      '1. ensureLocalCodeIndex(options) - in-process promise coalescing keyed by storage root + source key.\n' +
      '2. Hold repository then worktree locks through: object verification, second source observation, snapshot publication, run report, current publication.\n' +
      '3. Store current plus two previous snapshot IDs in current.json.\n' +
      '4. 16-step publication protocol from spec section 7.6.\n' +
      '5. Retry once on source mutation, fail on second change.\n' +
      '6. force=true performs full parse while retaining both observations and all publication checks.\n' +
      '7. Also implement localCodeIndexStatus - exact, read-only status inspection that writes no persistent bytes.',
      { label: 'phase6:service', phase: 'Phase 6 — Durable service, publication, status, GC', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/gc.ts implementing:\n' +
      '1. Explicit GC under repository lock across every worktree namespace.\n' +
      '2. Retained-snapshot and object collection.\n' +
      '3. Cannot remove objects retained by a current snapshot.\n' +
      '4. Interruption cleanup for owner-scoped unpublished files only.',
      { label: 'phase6:gc', phase: 'Phase 6 — Durable service, publication, status, GC', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Update ' + MODULE_DIR + '/index.ts to add the three real runtime exports:\n' +
      '1. ensureLocalCodeIndex\n' +
      '2. localCodeIndexStatus\n' +
      '3. queryLocalCodeIndex (stub for now, completed in Phase 7)\n' +
      'Re-export all types from contracts.ts.',
      { label: 'phase6:exports', phase: 'Phase 6 — Durable service, publication, status, GC', isolation: 'worktree' }
    );
  },
]);

var phase6Tests = await parallel([
  function() {
    return agent(
      'Create tests/local-code-index-publication.test.ts testing:\n' +
      '1. Crash points before and after every sync/rename keep readable prior current.\n' +
      '2. Two worktrees have separate current pointers and shared equal objects.\n' +
      '3. Mutations between initial and final observation retry once then fail.\n' +
      '4. force=true performs full parse with all publication checks.\n' +
      '5. Unchanged ensure returns same snapshot and parsedFiles: 0.',
      { label: 'phase6:test-publication', phase: 'Phase 6 — Durable service, publication, status, GC', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-gc.test.ts testing:\n' +
      '1. ensure/GC races cannot remove retained objects.\n' +
      '2. Old snapshots are collected after current advances.\n' +
      '3. Quarantine and recovery paths are preserved.',
      { label: 'phase6:test-gc', phase: 'Phase 6 — Durable service, publication, status, GC', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-concurrency.test.ts testing:\n' +
      '1. Two worktrees share equal objects.\n' +
      '2. Concurrent ensure calls coalesce.\n' +
      '3. Lock ordering prevents deadlocks.',
      { label: 'phase6:test-concurrency', phase: 'Phase 6 — Durable service, publication, status, GC', isolation: 'worktree' }
    );
  },
]);

log('Replacing v1 test with v2 behavior tests');
await agent(
  'Replace ' + V1_TEST + ' with new v2 behavior tests that:\n' +
  '1. Test ensureLocalCodeIndex produces correct ref with schemaVersion: 2.\n' +
  '2. Test localCodeIndexStatus reports available/fresh states.\n' +
  '3. Test incremental rebuild reuses objects.\n' +
  '4. Test publication is atomic.\n' +
  'Write the new file, preserving the same test file path.',
  { label: 'phase6:replace-test', phase: 'Phase 6 — Durable service, publication, status, GC', isolation: 'worktree' }
);

log('Phase 6 gate: publication atomicity, GC safety, concurrency');
await agent(
  'Run Phase 6 gate:\n' +
  '1. npm run typecheck && npm run build:node && npm run build:tests\n' +
  '2. Run all Phase 6 tests\n' +
  'Report results.',
  { label: 'phase6:gate', phase: 'Phase 6 — Durable service, publication, status, GC' }
);

// ─── Phase 7 ─────────────────────────────────────────────────────────────────

phase('Phase 7 — Query engine and evidence consumers');
log('Implementing query interface and evidence helpers');

var phase7Files = await parallel([
  function() {
    return agent(
      'Read spec section 5.2 for query interface.\n' +
      'Create ' + MODULE_DIR + '/query.ts implementing:\n' +
      '1. Exact/prefix definitions lookup.\n' +
      '2. Exact references lookup.\n' +
      '3. Imports query.\n' +
      '4. File summary query.\n' +
      '5. Related files with evidence and scoring.\n' +
      '6. Paginated inventory with cursors.\n' +
      '7. Validate cpbRoot, reference identities, snapshot, limits, symbols, paths, abort signals, cursor checksums.\n' +
      '8. Hold repository lock from snapshot validation through last object read.\n' +
      '9. Return deterministic ordering, evidence, truncation, timing, coverage.\n' +
      '10. Cursor integrity: unkeyed SHA-256 over schema version, snapshot ID, query kind, last key.',
      { label: 'phase7:query', phase: 'Phase 7 — Query engine and evidence consumers', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create ' + MODULE_DIR + '/evidence.ts implementing:\n' +
      '1. Task-symbol candidate extraction from task descriptions.\n' +
      '2. Evidence rendering from query results (not parsed manifests).\n' +
      '3. Bounded evidence pack for assurance.\n' +
      '4. Related-file score evidence formatting.\n' +
      'Migrate logic from ' + V1_SNAPSHOT + ' taskSymbolCandidates, exactSymbolFiles, buildLocalCodeIndexEvidence to consume v2 query results.',
      { label: 'phase7:evidence', phase: 'Phase 7 — Query engine and evidence consumers', isolation: 'worktree' }
    );
  },
]);

var phase7Tests = await parallel([
  function() {
    return agent(
      'Create tests/local-code-index-query.test.ts testing:\n' +
      '1. Every query kind passes: empty, bounded, truncated, malformed, stale-ref, abort cases.\n' +
      '2. Old snapshot expiry fails before partial results.\n' +
      '3. Deterministic ordering.\n' +
      '4. Cursor validation.',
      { label: 'phase7:test-query', phase: 'Phase 7 — Query engine and evidence consumers', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-query-security.test.ts testing:\n' +
      '1. Query/ensure/GC races return complete locked snapshot or fail before partial output.\n' +
      '2. No referenced object disappears mid-query.\n' +
      '3. Path traversal in queries is rejected.',
      { label: 'phase7:test-query-security', phase: 'Phase 7 — Query engine and evidence consumers', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-evidence.test.ts testing:\n' +
      '1. Related-file scores always include evidence.\n' +
      '2. Ambiguous references never appear as exact call edges.\n' +
      '3. Evidence pack is bounded.',
      { label: 'phase7:test-evidence', phase: 'Phase 7 — Query engine and evidence consumers', isolation: 'worktree' }
    );
  },
]);

log('Phase 7 gate: query correctness, security, evidence');
await agent(
  'Run Phase 7 gate:\n' +
  '1. npm run typecheck && npm run build:node && npm run build:tests\n' +
  '2. Run all Phase 7 tests\n' +
  'Report results.',
  { label: 'phase7:gate', phase: 'Phase 7 — Query engine and evidence consumers' }
);

// ─── Phase 8 ─────────────────────────────────────────────────────────────────

phase('Phase 8 — Runtime caller migration');
log('Migrating 14 production files from v1 to v2 LocalCodeIndexRef');

var phase8Migrations = await pipeline(
  V1_IMPORTERS,
  function(filePath) {
    return agent(
      'Migrate ' + filePath + ' from v1 local code index to v2:\n' +
      '1. Replace all v1 imports (checkLocalCodeIndexReady, readLocalCodeIndexFiles, readLocalCodeIndexSnapshot, localCodeIndexFileFromContext, exactSymbolFiles, buildLocalCodeIndexEvidence) with v2 imports from ' + MODULE_DIR + '/index.ts.\n' +
      '2. Replace indexFile path storage with LocalCodeIndexRef storage.\n' +
      '3. Replace direct manifest/shard reads with queryLocalCodeIndex calls.\n' +
      '4. Replace localCodeIndexReadiness.indexFile with LocalCodeIndexRef.\n' +
      '5. Ensure source context stores ref instead of indexFile.\n' +
      '6. Keep behavior equivalent - same product outcomes, different storage.',
      { label: 'phase8:migrate:' + filePath.split('/').pop(), phase: 'Phase 8 — Runtime caller migration', isolation: 'worktree' }
    );
  }
);

log('Rewriting affected tests for v2');
var phase8TestUpdates = await parallel([
  function() {
    return agent(
      'Update tests/code-index-capability-map.test.ts for v2 API: Replace v1 index file reads with v2 queryLocalCodeIndex calls.',
      { label: 'phase8:test-capability-map', phase: 'Phase 8 — Runtime caller migration', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Update tests/run-job-assurance.test.ts for v2 API: Replace v1 snapshot reads with v2 evidence queries.',
      { label: 'phase8:test-assurance', phase: 'Phase 8 — Runtime caller migration', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Update tests/checklist-decomposer.test.ts and tests/checklist-decompose-integration.test.ts for v2 API: Replace v1 symbol lookups with v2 definition queries.',
      { label: 'phase8:test-checklist', phase: 'Phase 8 — Runtime caller migration', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Update tests/riskmap-service.test.ts for v2 API: Replace v1 readiness with v2 ref state.',
      { label: 'phase8:test-riskmap', phase: 'Phase 8 — Runtime caller migration', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Update tests/queue-orchestrator.test.ts and tests/scheduler-concurrency-cas.test.ts for v2 API.',
      { label: 'phase8:test-queue', phase: 'Phase 8 — Runtime caller migration', isolation: 'worktree' }
    );
  },
]);

log('Phase 8 gate: no direct snapshot/shard reads, ref in source context');
await agent(
  'Run Phase 8 gate:\n' +
  '1. npm run typecheck && npm run build:node && npm run build:tests\n' +
  '2. Verify no production TypeScript contains direct snapshot/shard reads\n' +
  '3. Verify source context and durable queue records contain valid v2 ref and no indexFile\n' +
  '4. Run all main-flow and integration tests\n' +
  'Report results.',
  { label: 'phase8:gate', phase: 'Phase 8 — Runtime caller migration' }
);

// ─── Phase 9 ─────────────────────────────────────────────────────────────────

phase('Phase 9 — CLI and offline v1 state cleanup');
log('Creating CLI commands and offline migration');

var phase9Files = await parallel([
  function() {
    return agent(
      'Create cli/commands/code-index.ts with subcommands:\n' +
      '1. build - invoke ensureLocalCodeIndex, print ref/stats.\n' +
      '2. status - invoke localCodeIndexStatus, print status.\n' +
      '3. query - invoke queryLocalCodeIndex with query kind and params.\n' +
      '4. inspect - invoke management.inspectIndexLock.\n' +
      '5. gc - invoke GC under repository lock.\n' +
      '6. inspect-lock - emit bounded identity descriptor.\n' +
      '7. repair-lock - accept descriptor JSON file + authorized cpbRoot + source path; reject free-form paths.\n' +
      'CLI code never parses current.json, lock owners, snapshots, or shards.',
      { label: 'phase9:cli', phase: 'Phase 9 — CLI and offline v1 state cleanup', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create cli/commands/migrate.ts with only: local-code-index-v2 --cpb-root <absolute-path> operation. Dry validation report before mutation. Sequential queue and registry operations.',
      { label: 'phase9:migrate-cli', phase: 'Phase 9 — CLI and offline v1 state cleanup', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create server/services/migration/local-code-index-v2.ts implementing:\n' +
      '1. Resolve hub root, inspect projects.json and queue/queue.json.\n' +
      '2. Dry validation report before mutation.\n' +
      '3. Locked queue migration entry point in hub-queue.ts.\n' +
      '4. Locked registry migration entry point in hub-registry.ts.\n' +
      '5. Each acquires lock, rereads, revalidates, writes backup, applies transform, commits.\n' +
      '6. Refuse mutation if active work found.\n' +
      '7. Idempotent rerun support.',
      { label: 'phase9:migration', phase: 'Phase 9 — CLI and offline v1 state cleanup', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create server/services/hub/local-code-index-state-gate.ts with fail-closed validator:\n' +
      '1. Hub/orchestrator startup invokes against registry and queue state before dispatch.\n' +
      '2. Scheduler candidate selection invokes as defense in depth.\n' +
      '3. Dispatchable v1 state fails unsupported_index_schema with migration instructions.',
      { label: 'phase9:state-gate', phase: 'Phase 9 — CLI and offline v1 state cleanup', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Replace ' + V1_SCRIPT + ' with new version that invokes the same command parser/service as cli/commands/code-index.ts. Remove old check subcommand.',
      { label: 'phase9:script', phase: 'Phase 9 — CLI and offline v1 state cleanup', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Update cli/cpb.ts to register the new code-index and migrate commands with help text.',
      { label: 'phase9:register', phase: 'Phase 9 — CLI and offline v1 state cleanup', isolation: 'worktree' }
    );
  },
]);

var phase9Tests = await parallel([
  function() {
    return agent(
      'Create tests/code-index-cli.test.ts testing all CLI subcommands.',
      { label: 'phase9:test-cli', phase: 'Phase 9 — CLI and offline v1 state cleanup', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-v2-migration.test.ts testing:\n' +
      '1. Active-job refusal changes no bytes.\n' +
      '2. Successful cleanup is byte-idempotent on rerun.\n' +
      '3. Injected write failures preserve backups.\n' +
      '4. Pending migrated work cannot dispatch before v2 ensure.',
      { label: 'phase9:test-migration', phase: 'Phase 9 — CLI and offline v1 state cleanup', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-v2-release-scan.test.ts testing:\n' +
      '1. Runtime startup rejects remaining dispatchable v1 state.\n' +
      '2. Scheduler defense-in-depth rejects v1 state.',
      { label: 'phase9:test-release-scan', phase: 'Phase 9 — CLI and offline v1 state cleanup', isolation: 'worktree' }
    );
  },
]);

log('Phase 9 gate: idempotent migration, active-job refusal, state gate');
await agent(
  'Run Phase 9 gate:\n' +
  '1. npm run typecheck && npm run build:node && npm run build:tests\n' +
  '2. Run all Phase 9 tests\n' +
  'Report results.',
  { label: 'phase9:gate', phase: 'Phase 9 — CLI and offline v1 state cleanup' }
);

// ─── Phase 10 ────────────────────────────────────────────────────────────────

phase('Phase 10 — Delete v1 and close the release');
log('Removing v1 code after all callers migrated');

var phase10Changes = await parallel([
  function() {
    return agent(
      'Delete the following v1 files:\n' +
      '1. ' + V1_SERVER + '\n' +
      '2. ' + V1_SNAPSHOT + '\n' +
      'Remove v1 types, checkLocalCodeIndexReady, readLocalCodeIndexFiles, readLocalCodeIndexSnapshot, readiness indexFile, and schema-1 runtime branches from all remaining files.',
      { label: 'phase10:delete-v1', phase: 'Phase 10 — Delete v1 and close the release', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create scripts/verify-local-code-index-v2-release.ts that scans:\n' +
      '1. TypeScript source for v1 references.\n' +
      '2. Emitted dist/ for v1 imports.\n' +
      '3. Persisted-state schemas/fixtures for v1 fields.\n' +
      '4. CLI registrations for old commands.\n' +
      'Reject: LOCAL_CODE_INDEX_SCHEMA_VERSION=1, checkLocalCodeIndexReady, readLocalCodeIndexFiles, readLocalCodeIndexSnapshot, indexFile in readiness, schema-1 readers/writers, dual schema branches, detached v1 fields.\n' +
      'Allow: named migration input fixtures, offline migration recognizer, reject-only state gate.',
      { label: 'phase10:release-scan', phase: 'Phase 10 — Delete v1 and close the release', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Update scripts/verify-p0-p1.ts, scripts/verify-release-gate.ts, scripts/verify-stabilization.ts, and scripts/run-node-tests.ts to include v2 release scan and required tests.',
      { label: 'phase10:verify-scripts', phase: 'Phase 10 — Delete v1 and close the release', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Update .github/workflows/test.yml with focused local-index platform jobs for macOS and Ubuntu on Node 20 and 22. These jobs run safe-file, lock, publication, Git-observer, race, and release-scan suites.',
      { label: 'phase10:ci', phase: 'Phase 10 — Delete v1 and close the release', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Update AGENTS.md, README, developer docs, architecture docs, CLI help, and test profile lists to use cpb code-index instead of v1 references.',
      { label: 'phase10:docs', phase: 'Phase 10 — Delete v1 and close the release', isolation: 'worktree' }
    );
  },
]);

log('Removing v1-specific test fixtures');
await agent(
  'Remove or rewrite v1-specific test fixtures. Retain only clearly named migration input fixtures.',
  { label: 'phase10:fixtures', phase: 'Phase 10 — Delete v1 and close the release', isolation: 'worktree' }
);

log('Phase 10 gate: full verification suite');
await agent(
  'Run Phase 10 gate:\n' +
  '1. npm run typecheck\n' +
  '2. npm run test:main\n' +
  '3. npm run test:integration\n' +
  '4. npm run test:specialized\n' +
  '5. npm run verify:p0p1\n' +
  '6. npm run verify:stabilization\n' +
  '7. npm run verify:release-gate\n' +
  '8. Verify no v1 references remain in production code\n' +
  'Report results.',
  { label: 'phase10:gate', phase: 'Phase 10 — Delete v1 and close the release' }
);

// ─── Phase 11 ────────────────────────────────────────────────────────────────

phase('Phase 11 — Repeatable performance evidence');
log('Building benchmark harness and generating release evidence');

var phase11Files = await parallel([
  function() {
    return agent(
      'Create tests/benchmarks/local-code-index-v2/generate.ts with:\n' +
      '1. Fixed seed, deterministic Git identity/timestamps.\n' +
      '2. Inventory hash.\n' +
      '3. 1,000-file and 10,000-file fixtures.',
      { label: 'phase11:generator', phase: 'Phase 11 — Repeatable performance evidence', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create scripts/bench-local-code-index-v2.ts with:\n' +
      '1. Disposable warm-ups.\n' +
      '2. Isolated child processes.\n' +
      '3. Pristine baseline copies.\n' +
      '4. Exact scenario setup.\n' +
      '5. 30 measured samples.\n' +
      '6. p95 calculation.\n' +
      '7. Normalized child maxRSS.',
      { label: 'phase11:harness', phase: 'Phase 11 — Repeatable performance evidence', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Create tests/local-code-index-benchmark-contract.test.ts verifying benchmark preconditions and postconditions.',
      { label: 'phase11:test', phase: 'Phase 11 — Repeatable performance evidence', isolation: 'worktree' }
    );
  },
  function() {
    return agent(
      'Add bench:local-code-index script to package.json.',
      { label: 'phase11:package', phase: 'Phase 11 — Repeatable performance evidence', isolation: 'worktree' }
    );
  },
]);

log('Phase 11 gate: benchmark execution');
await agent(
  'Run Phase 11 gate:\n' +
  '1. npm run build:node\n' +
  '2. node dist/scripts/bench-local-code-index-v2.js --output artifacts/bench/local-code-index-v2.json\n' +
  '3. Verify: generator hashes, recorded environment measurements, sample counts, parse counts, p95 values, RSS, and operation results. Performance values are observations, not release budgets.\n' +
  'Report results.',
  { label: 'phase11:gate', phase: 'Phase 11 — Repeatable performance evidence' }
);

// ─── Final ───────────────────────────────────────────────────────────────────

log('Running final release verification');
await agent(
  'Run the complete final verification:\n' +
  '1. npm run typecheck\n' +
  '2. npm run test:main\n' +
  '3. npm run test:integration\n' +
  '4. npm run test:specialized\n' +
  '5. npm run verify:p0p1\n' +
  '6. npm run verify:stabilization\n' +
  '7. npm run verify:release-gate\n' +
  '8. Verify release scan passes\n' +
  '9. Verify benchmark evidence exists\n' +
  'Report the complete results.',
  { label: 'final:verification', phase: 'Phase 11 — Repeatable performance evidence' }
);

return { status: 'complete', phases: 12 };
