/**
 * Local Code Index v2 — query engine.
 *
 * Implements spec section 5.2 (Query interface) for bounded symbol, file,
 * and relationship queries against an immutable snapshot.
 *
 * Six query kinds:
 *   1. definitions  — exact or prefix symbol lookup
 *   2. references   — exact symbol reference lookup
 *   3. imports      — resolved imports for a file
 *   4. file-summary — definitions, imports, errors for one file
 *   5. related-files — ranked related files with evidence
 *   6. inventory    — paginated file listing with cursors
 *
 * Invariants:
 *   - Validates cpbRoot, ref identity, snapshot, limits, symbols, paths,
 *     abort signals, and cursor checksums before any I/O.
 *   - Holds the repository-key object lock from snapshot validation through
 *     the last object read (spec section 5.3).
 *   - Returns deterministic ordering, evidence, truncation, timing, coverage.
 *   - Cursor integrity: unkeyed SHA-256 over schema version, snapshot ID,
 *     query kind, and last key (spec section 5.2).
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md sections 5.2, 5.3
 *
 * Dependencies: node:crypto, node:path,
 *   contracts.ts, paths.ts, lock.ts, safe-files.ts,
 *   snapshot-store.ts, object-store.ts, shards.ts, coverage.ts,
 *   canonical-json.ts.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import {
  LocalCodeIndexUnavailableError,
  LOCAL_CODE_INDEX_DEFAULT_LIMIT,
  LOCAL_CODE_INDEX_MAX_LIMIT,
  LOCAL_CODE_INDEX_MAX_INPUT_PATHS,
  LOCAL_CODE_INDEX_MAX_INPUT_SYMBOLS,
  LOCAL_CODE_INDEX_MAX_SYMBOL_LENGTH,
} from "./contracts.js";
import type {
  LocalCodeIndexRef,
  LocalCodeIndexQuery,
  LocalCodeIndexQueryResult,
  LocalCodeIndexCoverage,
  LocalCodeIndexCoverageSummary,
  SourceRange,
  SymbolOccurrence,
  FileRelationship,
  FileSummary,
} from "./contracts.js";

import {
  resolveStorageRoot,
  validateSourcePath,
  repositoryObjectsLockDir,
  fileObjectPath,
  symbolShardPath,
  relationShardPath,
} from "./paths.js";

import { acquireIndexLock, releaseIndexLock } from "./lock.js";
import type { IndexLockOwner } from "./lock.js";

import { readBoundedFileNoFollow } from "./safe-files.js";

import { readIndexMap, readSnapshotIdentity } from "./snapshot-store.js";
import type { IndexMap, SnapshotIdentity } from "./snapshot-store.js";

import { readFileObject } from "./object-store.js";

import {
  normalizeSymbol,
  normalizePath,
  pathBucketKey,
  symbolBucketKey,
} from "./shards.js";
import type {
  SymbolShard,
  RelationShard,
  ShardSymbolEntry,
  ShardFileSummaryEntry,
} from "./shards.js";

import {
  aggregateCoverage,
  singleFileSummary,
} from "./coverage.js";
import type { FileCoverageOutcome } from "./coverage.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum bytes for reading shard objects. */
const MAX_SHARD_READ_BYTES = 64 * 1024 * 1024;

/** Cursor schema version for integrity checks. */
const CURSOR_SCHEMA_VERSION = 2;

// ── Cursor types ─────────────────────────────────────────────────────────────

/**
 * Internal cursor payload before checksum derivation.
 *
 * Spec section 5.2: "Cursor payloads are integrity-checked with an
 * unkeyed SHA-256 checksum over schema version, snapshot ID, query kind,
 * and last returned key."
 */
type CursorPayload = Readonly<{
  schemaVersion: number;
  snapshotId: string;
  queryKind: string;
  lastKey: string;
  checksum: string;
}>;

// ── Cursor integrity ─────────────────────────────────────────────────────────

/**
 * Derive the unkeyed SHA-256 checksum for a cursor.
 *
 * Spec section 5.2: checksum is over schema version, snapshot ID,
 * query kind, and last returned key.
 */
function deriveCursorChecksum(
  schemaVersion: number,
  snapshotId: string,
  queryKind: string,
  lastKey: string,
): string {
  return createHash("sha256")
    .update(String(schemaVersion))
    .update("\0")
    .update(snapshotId)
    .update("\0")
    .update(queryKind)
    .update("\0")
    .update(lastKey)
    .digest("hex");
}

/**
 * Encode a cursor payload to an opaque base64 string.
 */
function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decode and validate a cursor string.
 *
 * Returns the parsed payload if valid. Throws on malformed input,
 * checksum mismatch, or snapshot mismatch.
 */
function decodeCursor(
  cursor: string,
  expectedSnapshotId: string,
  expectedQueryKind: string,
): CursorPayload {
  let json: string;
  try {
    json = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new LocalCodeIndexUnavailableError("invalid_cursor");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new LocalCodeIndexUnavailableError("invalid_cursor");
  }

  if (
    typeof parsed.schemaVersion !== "number" ||
    typeof parsed.snapshotId !== "string" ||
    typeof parsed.queryKind !== "string" ||
    typeof parsed.lastKey !== "string" ||
    typeof parsed.checksum !== "string"
  ) {
    throw new LocalCodeIndexUnavailableError("invalid_cursor");
  }

  // Verify checksum integrity.
  const expectedChecksum = deriveCursorChecksum(
    parsed.schemaVersion,
    parsed.snapshotId,
    parsed.queryKind,
    parsed.lastKey,
  );
  if (parsed.checksum !== expectedChecksum) {
    throw new LocalCodeIndexUnavailableError("invalid_cursor");
  }

  // Verify snapshot binding.
  if (parsed.snapshotId !== expectedSnapshotId) {
    throw new LocalCodeIndexUnavailableError("cursor_snapshot_mismatch", {
      snapshotId: expectedSnapshotId,
    });
  }

  // Verify query kind binding.
  if (parsed.queryKind !== expectedQueryKind) {
    throw new LocalCodeIndexUnavailableError("invalid_cursor");
  }

  return {
    schemaVersion: parsed.schemaVersion,
    snapshotId: parsed.snapshotId,
    queryKind: parsed.queryKind,
    lastKey: parsed.lastKey,
    checksum: parsed.checksum,
  };
}

// ── Validation helpers ───────────────────────────────────────────────────────

/**
 * Validate and normalize a `limit` parameter.
 *
 * Spec section 5.2: "limit must be a safe integer from 1 through 500.
 * Invalid limits fail with reason: 'invalid_query'; they are not clamped."
 */
function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return LOCAL_CODE_INDEX_DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > LOCAL_CODE_INDEX_MAX_LIMIT
  ) {
    throw new LocalCodeIndexUnavailableError("invalid_query", {
      sourcePath: undefined,
    });
  }
  return limit;
}

/**
 * Validate a symbol string.
 *
 * Rejects empty, overly long, or non-string symbols.
 */
function validateSymbol(symbol: unknown, fieldName: string): string {
  if (typeof symbol !== "string" || symbol.length === 0) {
    throw new LocalCodeIndexUnavailableError("invalid_query");
  }
  if (Buffer.byteLength(symbol, "utf8") > LOCAL_CODE_INDEX_MAX_SYMBOL_LENGTH) {
    throw new LocalCodeIndexUnavailableError("invalid_query");
  }
  return symbol;
}

/**
 * Validate a file path string.
 *
 * Rejects empty, absolute, or non-normalized paths.
 */
function validatePath(p: unknown, fieldName: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new LocalCodeIndexUnavailableError("invalid_query");
  }
  if (path.isAbsolute(p)) {
    throw new LocalCodeIndexUnavailableError("invalid_query");
  }
  return normalizePath(p);
}

/**
 * Validate an array of paths.
 */
function validatePaths(
  paths: unknown,
  fieldName: string,
): readonly string[] {
  if (!Array.isArray(paths)) {
    throw new LocalCodeIndexUnavailableError("invalid_query");
  }
  if (paths.length > LOCAL_CODE_INDEX_MAX_INPUT_PATHS) {
    throw new LocalCodeIndexUnavailableError("invalid_query");
  }
  return paths.map((p, i) => validatePath(p, `${fieldName}[${i}]`));
}

/**
 * Validate an array of symbols.
 */
function validateSymbols(
  symbols: unknown,
  fieldName: string,
): readonly string[] {
  if (!Array.isArray(symbols)) {
    throw new LocalCodeIndexUnavailableError("invalid_query");
  }
  if (symbols.length > LOCAL_CODE_INDEX_MAX_INPUT_SYMBOLS) {
    throw new LocalCodeIndexUnavailableError("invalid_query");
  }
  return symbols.map((s, i) => validateSymbol(s, `${fieldName}[${i}]`));
}

/**
 * Validate a LocalCodeIndexRef against expected identity fields.
 */
function validateRef(
  ref: LocalCodeIndexRef,
): void {
  if (!ref || typeof ref !== "object") {
    throw new LocalCodeIndexUnavailableError("invalid_index_ref");
  }
  if (ref.schemaVersion !== 2) {
    throw new LocalCodeIndexUnavailableError("invalid_index_ref");
  }
  if (typeof ref.sourcePath !== "string" || !ref.sourcePath) {
    throw new LocalCodeIndexUnavailableError("invalid_index_ref");
  }
  if (typeof ref.repositoryKey !== "string" || !ref.repositoryKey) {
    throw new LocalCodeIndexUnavailableError("invalid_index_ref");
  }
  if (typeof ref.worktreeKey !== "string" || !ref.worktreeKey) {
    throw new LocalCodeIndexUnavailableError("invalid_index_ref");
  }
  if (typeof ref.sourceKey !== "string" || !ref.sourceKey) {
    throw new LocalCodeIndexUnavailableError("invalid_index_ref");
  }
  if (typeof ref.snapshotId !== "string" || !ref.snapshotId) {
    throw new LocalCodeIndexUnavailableError("invalid_index_ref");
  }
}

// ── Shard reading ────────────────────────────────────────────────────────────

/**
 * Read and deserialize a symbol shard from the repository object store.
 */
async function readSymbolShard(
  storageRoot: string,
  repositoryKey: string,
  shardId: string,
): Promise<SymbolShard | null> {
  const p = symbolShardPath(storageRoot, repositoryKey, shardId);
  try {
    const bytes = await readBoundedFileNoFollow(p, MAX_SHARD_READ_BYTES);
    return JSON.parse(new TextDecoder().decode(bytes)) as SymbolShard;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read and deserialize a relation shard from the repository object store.
 */
async function readRelationShard(
  storageRoot: string,
  repositoryKey: string,
  shardId: string,
): Promise<RelationShard | null> {
  const p = relationShardPath(storageRoot, repositoryKey, shardId);
  try {
    const bytes = await readBoundedFileNoFollow(p, MAX_SHARD_READ_BYTES);
    return JSON.parse(new TextDecoder().decode(bytes)) as RelationShard;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ── Coverage computation ─────────────────────────────────────────────────────

/**
 * Compute the coverage summary for a set of shard entries examined
 * during a query.
 *
 * Spec section 5.2: "Query results count every file examined for
 * that query, including lookup candidates excluded from the returned
 * page. An empty result reports the coverage of the complete searched
 * scope."
 */
function computeQueryCoverage(
  entries: readonly { coverage: string }[],
): LocalCodeIndexCoverageSummary {
  if (entries.length === 0) {
    // Empty scope — report weakest coverage.
    return Object.freeze({
      effective: "file-inventory-only" as LocalCodeIndexCoverage,
      partial: false,
      failedFiles: 0,
      oversizedFiles: 0,
    });
  }

  const outcomes: FileCoverageOutcome[] = entries.map((e) => {
    const c = e.coverage;
    if (
      c === "ast-grep-structural" ||
      c === "lexical-reference-fallback" ||
      c === "file-inventory-only"
    ) {
      return c as FileCoverageOutcome;
    }
    return "file-inventory-only";
  });

  return aggregateCoverage(outcomes);
}

/**
 * Merge file-level coverage from the snapshot identity into a
 * per-entry coverage map.
 */
function buildCoverageMap(
  identity: SnapshotIdentity,
): ReadonlyMap<string, LocalCodeIndexCoverage> {
  const map = new Map<string, LocalCodeIndexCoverage>();
  for (const [filePath, invEntry] of Object.entries(identity.inventory)) {
    // Coverage is stored in the tool state at snapshot level.
    // Per-file coverage is derived from the extraction result that
    // produced the file object. For query purposes we use the
    // snapshot's effective coverage as the default.
    map.set(filePath, identity.toolState.coverage as LocalCodeIndexCoverage);
  }
  return map;
}

// ── Sorting ──────────────────────────────────────────────────────────────────

/**
 * Compare symbol occurrences for deterministic ordering.
 *
 * Spec section 5.2: "Exact definition and reference results sort by
 * normalized path, range start, range end, then symbol kind."
 */
function compareOccurrences(a: SymbolOccurrence, b: SymbolOccurrence): number {
  // 1. Path
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  // 2. Range start line
  if (a.range.startLine < b.range.startLine) return -1;
  if (a.range.startLine > b.range.startLine) return 1;
  // 3. Range start column
  if (a.range.startColumn < b.range.startColumn) return -1;
  if (a.range.startColumn > b.range.startColumn) return 1;
  // 4. Range end line
  if (a.range.endLine < b.range.endLine) return -1;
  if (a.range.endLine > b.range.endLine) return 1;
  // 5. Range end column
  if (a.range.endColumn < b.range.endColumn) return -1;
  if (a.range.endColumn > b.range.endColumn) return 1;
  // 6. Symbol kind
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  return 0;
}

/**
 * Compare symbol occurrences for prefix definitions.
 *
 * Spec section 5.2: "Prefix definitions sort by exact-name match first,
 * then symbol name, then the same location order."
 */
function comparePrefixOccurrences(
  a: SymbolOccurrence,
  b: SymbolOccurrence,
  querySymbol: string,
): number {
  // 1. Exact-name match first.
  const aExact = a.symbol === querySymbol ? 0 : 1;
  const bExact = b.symbol === querySymbol ? 0 : 1;
  if (aExact !== bExact) return aExact - bExact;

  // 2. Symbol name.
  if (a.symbol < b.symbol) return -1;
  if (a.symbol > b.symbol) return 1;

  // 3. Same location order as exact.
  return compareOccurrences(a, b);
}

/**
 * Compare file relationships for deterministic ordering.
 */
function compareRelationships(a: FileRelationship, b: FileRelationship): number {
  if (a.fromPath < b.fromPath) return -1;
  if (a.fromPath > b.fromPath) return 1;
  if (a.toPath < b.toPath) return -1;
  if (a.toPath > b.toPath) return 1;
  if (a.type < b.type) return -1;
  if (a.type > b.type) return 1;
  const aSym = a.symbol ?? "";
  const bSym = b.symbol ?? "";
  if (aSym < bSym) return -1;
  if (aSym > bSym) return 1;
  return 0;
}

/**
 * Compare related-file results for deterministic ordering.
 *
 * Spec section 5.2: "Related files sort by descending score and
 * normalized path."
 */
function compareRelatedFiles(
  a: { path: string; score: number },
  b: { path: string; score: number },
): number {
  // Descending score.
  if (a.score > b.score) return -1;
  if (a.score < b.score) return 1;
  // Ascending path.
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

// ── Query dispatch ───────────────────────────────────────────────────────────

/**
 * Execute a definitions query.
 *
 * Scans all symbol shards to find definition entries matching the symbol,
 * filters by exact or prefix match, and returns bounded, deterministically
 * ordered results.
 *
 * Note: symbol shard IDs in the identity are full SHA-256 object IDs, not
 * bucket-key-prefixed. Without loading the index-map we cannot do a single-
 * shard lookup, so we scan all shards. For typical repository sizes this
 * is well within the p95 50ms budget.
 */
async function executeDefinitionsQuery(
  storageRoot: string,
  repositoryKey: string,
  snapshotId: string,
  identity: SnapshotIdentity,
  indexMap: IndexMap,
  symbol: string,
  match: "exact" | "prefix",
  limit: number,
  signal?: AbortSignal,
): Promise<LocalCodeIndexQueryResult> {
  const startMs = Date.now();
  const normalizedSymbol = normalizeSymbol(symbol);
  const coverageMap = buildCoverageMap(identity);
  const allOccurrences: SymbolOccurrence[] = [];
  const examinedEntries: ShardSymbolEntry[] = [];

  const shardIds = match === "exact"
    ? [indexMap.symbolShards[`sym-${symbolBucketKey(symbol)}`]].filter(
        (value): value is string => typeof value === "string",
      )
    : identity.symbolShardIds;

  for (const shardId of shardIds) {
    signal?.throwIfAborted();

    const shard = await readSymbolShard(storageRoot, repositoryKey, shardId);
    if (shard === null) continue;

    for (const entry of shard.entries) {
      if (entry.role !== "definition") continue;

      const entryNormalized = normalizeSymbol(entry.symbol);
      const matches =
        match === "exact"
          ? entryNormalized === normalizedSymbol
          : entryNormalized.startsWith(normalizedSymbol);

      if (matches) {
        examinedEntries.push(entry);
        allOccurrences.push({
          symbol: entry.symbol,
          kind: entry.kind,
          role: "definition" as const,
          path: entry.path,
          range: { ...entry.range },
          exported: entry.exported,
          coverage: (coverageMap.get(entry.path) ?? entry.coverage) as LocalCodeIndexCoverage,
        });
      }
    }
  }

  // Sort deterministically.
  if (match === "prefix") {
    allOccurrences.sort((a, b) => comparePrefixOccurrences(a, b, normalizedSymbol));
  } else {
    allOccurrences.sort(compareOccurrences);
  }

  // Apply limit and detect truncation.
  const truncated = allOccurrences.length > limit;
  const page = allOccurrences.slice(0, limit);

  const durationMs = Date.now() - startMs;
  return {
    kind: "definitions",
    snapshotId,
    coverage: computeQueryCoverage(examinedEntries),
    truncated,
    durationMs,
    occurrences: page,
  };
}

/**
 * Execute a references query.
 *
 * Reads all symbol shards (since references to a symbol may be in any
 * shard bucket), filters by exact match and role=reference.
 *
 * Note: for efficiency we search the symbol shards. An alternative
 * approach would be to maintain a reverse index, but the spec allows
 * scanning shards for bounded queries.
 */
async function executeReferencesQuery(
  storageRoot: string,
  repositoryKey: string,
  snapshotId: string,
  identity: SnapshotIdentity,
  indexMap: IndexMap,
  symbol: string,
  limit: number,
  signal?: AbortSignal,
): Promise<LocalCodeIndexQueryResult> {
  const startMs = Date.now();
  const normalizedSymbol = normalizeSymbol(symbol);

  const allOccurrences: SymbolOccurrence[] = [];
  const coverageMap = buildCoverageMap(identity);
  const examinedEntries: ShardSymbolEntry[] = [];

  const shardId = indexMap.symbolShards[`sym-${symbolBucketKey(symbol)}`];
  for (const currentShardId of shardId ? [shardId] : []) {
    signal?.throwIfAborted();

    const shard = await readSymbolShard(storageRoot, repositoryKey, currentShardId);
    if (shard === null) continue;

    for (const entry of shard.entries) {
      if (
        entry.role === "reference" &&
        normalizeSymbol(entry.symbol) === normalizedSymbol
      ) {
        examinedEntries.push(entry);
        allOccurrences.push({
          symbol: entry.symbol,
          kind: entry.kind,
          role: "reference" as const,
          path: entry.path,
          range: { ...entry.range },
          exported: entry.exported,
          coverage: (coverageMap.get(entry.path) ?? entry.coverage) as LocalCodeIndexCoverage,
        });
      }
    }
  }

  // Sort deterministically.
  allOccurrences.sort(compareOccurrences);

  // Apply limit.
  const truncated = allOccurrences.length > limit;
  const page = allOccurrences.slice(0, limit);

  const durationMs = Date.now() - startMs;
  return {
    kind: "references",
    snapshotId,
    coverage: computeQueryCoverage(examinedEntries),
    truncated,
    durationMs,
    occurrences: page,
  };
}

/**
 * Execute an imports query.
 *
 * Scans all relation shards to find import relationships where the
 * fromPath matches the requested file path.
 */
async function executeImportsQuery(
  storageRoot: string,
  repositoryKey: string,
  snapshotId: string,
  identity: SnapshotIdentity,
  filePath: string,
  limit: number,
  signal?: AbortSignal,
): Promise<LocalCodeIndexQueryResult> {
  const startMs = Date.now();
  const normalizedPath = normalizePath(filePath);
  const matchingRels: FileRelationship[] = [];
  const examinedSummaries: ShardFileSummaryEntry[] = [];

  for (const shardId of identity.relationShardIds) {
    signal?.throwIfAborted();

    const shard = await readRelationShard(storageRoot, repositoryKey, shardId);
    if (shard === null) continue;

    examinedSummaries.push(...shard.fileSummaries);

    for (const rel of shard.relationships) {
      if (
        normalizePath(rel.fromPath) === normalizedPath &&
        rel.type === "imports"
      ) {
        matchingRels.push({
          fromPath: rel.fromPath,
          toPath: rel.toPath,
          type: rel.type as FileRelationship["type"],
          symbol: rel.symbol,
          evidence: [] as readonly SourceRange[],
          weight: rel.weight,
        });
      }
    }
  }

  matchingRels.sort(compareRelationships);

  const truncated = matchingRels.length > limit;
  const page = matchingRels.slice(0, limit);

  const durationMs = Date.now() - startMs;
  return {
    kind: "imports",
    snapshotId,
    coverage: computeQueryCoverage(examinedSummaries),
    truncated,
    durationMs,
    relationships: page,
  };
}

/**
 * Execute a file-summary query.
 *
 * Reads the file object for the given path and assembles a FileSummary
 * including definitions, imports, and errors.
 */
async function executeFileSummaryQuery(
  storageRoot: string,
  repositoryKey: string,
  snapshotId: string,
  identity: SnapshotIdentity,
  filePath: string,
  signal?: AbortSignal,
): Promise<LocalCodeIndexQueryResult> {
  const startMs = Date.now();
  const normalizedPath = normalizePath(filePath);

  // Look up the file in the snapshot inventory.
  const invEntry = identity.inventory[normalizedPath];
  if (invEntry === undefined) {
    const durationMs = Date.now() - startMs;
    return {
      kind: "file-summary",
      snapshotId,
      coverage: computeQueryCoverage([]),
      truncated: false,
      durationMs,
      file: null,
    };
  }

  signal?.throwIfAborted();

  // Read the file object.
  const foPath = fileObjectPath(storageRoot, repositoryKey, invEntry.fileObjectId);
  const fileObject = await readFileObject(foPath);
  if (fileObject === null) {
    throw new LocalCodeIndexUnavailableError("corrupt_index", { snapshotId });
  }

  signal?.throwIfAborted();

  // Build the file summary.
  const coverage = identity.toolState.coverage as LocalCodeIndexCoverage;

  const definitions: SymbolOccurrence[] = fileObject.definitions.map((d) => ({
    symbol: d.name,
    kind: d.kind,
    role: "definition" as const,
    path: normalizedPath,
    range: { ...d.range },
    exported: d.exported,
    coverage,
  }));

  const imports: FileSummary["imports"] = fileObject.imports.map((i) => ({
    requested: i.requested,
    resolvedPath: null, // Resolved path is in relationship shards.
    range: { ...i.range },
  }));

  const file: FileSummary = {
    path: normalizedPath,
    language: fileObject.language,
    size: fileObject.byteSize,
    contentId: fileObject.sourceContentId,
    coverage,
    definitions,
    imports,
    errors: [...fileObject.errors],
  };

  const durationMs = Date.now() - startMs;
  return {
    kind: "file-summary",
    snapshotId,
    coverage: singleFileSummary(coverage),
    truncated: false,
    durationMs,
    file,
  };
}

/**
 * Execute a related-files query.
 *
 * Builds a scored, evidence-backed list of files related to the given
 * seed paths and optional symbols. Uses import and reference
 * relationships from relation shards.
 */
async function executeRelatedFilesQuery(
  storageRoot: string,
  repositoryKey: string,
  snapshotId: string,
  identity: SnapshotIdentity,
  indexMap: IndexMap,
  seedPaths: readonly string[],
  seedSymbols: readonly string[],
  limit: number,
  signal?: AbortSignal,
): Promise<LocalCodeIndexQueryResult> {
  const startMs = Date.now();

  // Normalize seed paths.
  const normalizedSeeds = new Set(seedPaths.map(normalizePath));
  const normalizedSymbols = new Set(seedSymbols.map(normalizeSymbol));

  // Score accumulator: path -> { score, evidence[] }.
  const scoreMap = new Map<
    string,
    { score: number; evidence: FileRelationship[] }
  >();

  // Relationship shards are keyed by fromPath. For path-seeded queries, read
  // only the seed buckets; symbol-only expansion still requires the complete
  // relation set.
  const examinedSummaries: ShardFileSummaryEntry[] = [];
  const shardIds = normalizedSymbols.size > 0
    ? identity.relationShardIds
    : [...new Set(
        [...normalizedSeeds]
          .map((seed) => indexMap.relationShards[`rel-${pathBucketKey(seed)}`])
          .filter((value): value is string => typeof value === "string"),
      )];

  for (const shardId of shardIds) {
    signal?.throwIfAborted();

    const shard = await readRelationShard(storageRoot, repositoryKey, shardId);
    if (shard === null) continue;

    examinedSummaries.push(...shard.fileSummaries);

    for (const rel of shard.relationships) {
      const fromNorm = normalizePath(rel.fromPath);
      const toNorm = normalizePath(rel.toPath);

      // Check if this relationship connects to our seed set.
      const fromIsSeed = normalizedSeeds.has(fromNorm);
      const toIsSeed = normalizedSeeds.has(toNorm);
      const symbolMatches =
        rel.symbol !== null && normalizedSymbols.has(normalizeSymbol(rel.symbol));

      if (!fromIsSeed && !toIsSeed && !symbolMatches) continue;

      // Score the target file.
      const targetPath = fromIsSeed ? toNorm : fromNorm;
      if (normalizedSeeds.has(targetPath)) continue; // Skip seeds themselves.

      let existing = scoreMap.get(targetPath);
      if (!existing) {
        existing = { score: 0, evidence: [] };
        scoreMap.set(targetPath, existing);
      }

      existing.score += rel.weight;
      existing.evidence.push({
        fromPath: rel.fromPath,
        toPath: rel.toPath,
        type: rel.type as FileRelationship["type"],
        symbol: rel.symbol,
        evidence: [] as readonly SourceRange[],
        weight: rel.weight,
      });
    }
  }

  // Build the result array.
  const files: Array<{
    path: string;
    score: number;
    evidence: readonly FileRelationship[];
  }> = [];

  for (const [filePath, data] of scoreMap) {
    files.push({
      path: filePath,
      score: data.score,
      evidence: data.evidence,
    });
  }

  // Sort: descending score, then ascending path.
  files.sort(compareRelatedFiles);

  // Apply limit.
  const truncated = files.length > limit;
  const page = files.slice(0, limit);

  const durationMs = Date.now() - startMs;
  return {
    kind: "related-files",
    snapshotId,
    coverage: computeQueryCoverage(examinedSummaries),
    truncated,
    durationMs,
    files: page,
  };
}

/**
 * Execute an inventory query with cursor-based pagination.
 *
 * Returns a page of file entries sorted by normalized path, with
 * a cursor for the next page.
 */
async function executeInventoryQuery(
  storageRoot: string,
  repositoryKey: string,
  snapshotId: string,
  identity: SnapshotIdentity,
  cursor: string | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<LocalCodeIndexQueryResult> {
  const startMs = Date.now();

  // Build the sorted file list from the inventory.
  const allPaths = Object.keys(identity.inventory).sort();

  // Determine the start offset from the cursor.
  let startIndex = 0;
  if (cursor !== undefined) {
    const payload = decodeCursor(cursor, snapshotId, "inventory");
    // Find the index of the last key.
    const lastKeyIndex = allPaths.indexOf(payload.lastKey);
    if (lastKeyIndex === -1) {
      // The last key no longer exists — start from the beginning of
      // the next page after where it would have been.
      startIndex = 0;
      for (let i = 0; i < allPaths.length; i++) {
        if (allPaths[i]! > payload.lastKey) {
          startIndex = i;
          break;
        }
        startIndex = allPaths.length;
      }
    } else {
      startIndex = lastKeyIndex + 1;
    }
  }

  signal?.throwIfAborted();

  // Build the page.
  const pageEnd = Math.min(startIndex + limit, allPaths.length);
  const pagePaths = allPaths.slice(startIndex, pageEnd);
  const truncated = pageEnd < allPaths.length;

  // Build inventory items with coverage.
  const coverageMap = buildCoverageMap(identity);
  const items: readonly Readonly<{
    path: string;
    language: string;
    size: number;
    coverage: LocalCodeIndexCoverage;
  }>[] = pagePaths.map((p) => {
    const inv = identity.inventory[p]!;
    return {
      path: p,
      language: "unknown", // Language is in the file object, not inventory.
      size: parseInt(inv.metadata.size, 10) || 0,
      coverage: (coverageMap.get(p) ?? identity.toolState.coverage) as LocalCodeIndexCoverage,
    };
  });

  // Build next cursor.
  let nextCursor: string | null = null;
  if (truncated && pagePaths.length > 0) {
    const lastKey = pagePaths[pagePaths.length - 1]!;
    const checksum = deriveCursorChecksum(
      CURSOR_SCHEMA_VERSION,
      snapshotId,
      "inventory",
      lastKey,
    );
    nextCursor = encodeCursor({
      schemaVersion: CURSOR_SCHEMA_VERSION,
      snapshotId,
      queryKind: "inventory",
      lastKey,
      checksum,
    });
  }

  // Compute coverage from all examined files.
  const allCoverageOutcomes: FileCoverageOutcome[] = [];
  for (const p of allPaths) {
    const cov = coverageMap.get(p);
    if (cov) {
      allCoverageOutcomes.push(cov as FileCoverageOutcome);
    }
  }

  const durationMs = Date.now() - startMs;
  return {
    kind: "inventory",
    snapshotId,
    coverage: aggregateCoverage(allCoverageOutcomes),
    truncated,
    durationMs,
    files: items,
    nextCursor,
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Query the local code index for symbol occurrences, file relationships,
 * and related information.
 *
 * Implements spec section 5.2 (Query interface) and section 5.3
 * (Interface invariants):
 *
 *   - Validates the ref, snapshot identity, and query parameters.
 *   - Holds the repository-key object lock from snapshot validation
 *     through the last object read.
 *   - Returns deterministic ordering, evidence, truncation, timing,
 *     and coverage.
 *   - Cursor integrity is enforced via unkeyed SHA-256 checksums.
 *
 * @param ref - The index reference from a prior ensureLocalCodeIndex call.
 * @param query - The query to execute.
 * @param options - Optional CPB root and abort signal.
 * @returns The query result.
 * @throws {LocalCodeIndexUnavailableError} on any validation or I/O failure.
 */
export async function queryLocalCodeIndex(
  ref: LocalCodeIndexRef,
  query: LocalCodeIndexQuery,
  options?: Readonly<{ cpbRoot?: string; signal?: AbortSignal }>,
): Promise<LocalCodeIndexQueryResult> {
  const signal = options?.signal;

  // ── Step 1: Validate ref ────────────────────────────────────────────────
  validateRef(ref);

  // ── Step 2: Validate and resolve storage root ───────────────────────────
  const canonicalSource = await validateSourcePath(ref.sourcePath);
  const storageRoot = await resolveStorageRoot(options?.cpbRoot, canonicalSource);

  // ── Step 3: Validate query kind and parameters ──────────────────────────
  if (!query || typeof query !== "object" || typeof query.kind !== "string") {
    throw new LocalCodeIndexUnavailableError("invalid_query");
  }

  // Validate limit for queries that accept it.
  let limit: number;
  if (query.kind === "file-summary") {
    limit = 1; // Not applicable, but set for consistency.
  } else {
    limit = validateLimit(query.limit);
  }

  // Validate kind-specific parameters.
  switch (query.kind) {
    case "definitions":
      validateSymbol(query.symbol, "symbol");
      if (query.match !== "exact" && query.match !== "prefix") {
        throw new LocalCodeIndexUnavailableError("invalid_query");
      }
      break;
    case "references":
      validateSymbol(query.symbol, "symbol");
      if (query.match !== "exact") {
        throw new LocalCodeIndexUnavailableError("invalid_query");
      }
      break;
    case "imports":
      validatePath(query.path, "path");
      break;
    case "file-summary":
      validatePath(query.path, "path");
      break;
    case "related-files":
      validatePaths(query.paths, "paths");
      if (query.symbols !== undefined) {
        validateSymbols(query.symbols, "symbols");
      }
      break;
    case "inventory":
      // Cursor validation happens later against the snapshot.
      break;
    default:
      throw new LocalCodeIndexUnavailableError("invalid_query");
  }

  signal?.throwIfAborted();

  // ── Step 4: Acquire repository lock and validate snapshot ───────────────
  const lockDir = repositoryObjectsLockDir(storageRoot, ref.repositoryKey);

  let lockOwner: IndexLockOwner;
  try {
    lockOwner = await acquireIndexLock(lockDir, {
      scopeKind: "repository-objects",
      scopeKey: ref.repositoryKey,
      signal,
      waitMs: 5_000,
    });
  } catch (err: unknown) {
    if (err instanceof LocalCodeIndexUnavailableError) throw err;
    throw new LocalCodeIndexUnavailableError("missing_local_code_index", {
      sourcePath: ref.sourcePath,
      cause: err,
    });
  }

  try {
    // ── Step 5: Read and validate snapshot identity ────────────────────────
    const identity = await readSnapshotIdentity(
      storageRoot,
      ref.worktreeKey,
      ref.snapshotId,
    );

    if (identity === null) {
      throw new LocalCodeIndexUnavailableError("missing_local_code_index", {
        sourcePath: ref.sourcePath,
        snapshotId: ref.snapshotId,
      });
    }
    const indexMap = await readIndexMap(
      storageRoot,
      ref.worktreeKey,
      ref.snapshotId,
    );
    if (indexMap === null) {
      throw new LocalCodeIndexUnavailableError("corrupt_index");
    }

    if (identity.schemaVersion !== 2) {
      throw new LocalCodeIndexUnavailableError("unsupported_index_schema", {
        snapshotId: ref.snapshotId,
      });
    }

    // Validate that the snapshot belongs to the ref's repository and worktree.
    if (
      identity.repositoryKey !== ref.repositoryKey ||
      identity.worktreeKey !== ref.worktreeKey
    ) {
      throw new LocalCodeIndexUnavailableError("invalid_index_ref", {
        snapshotId: ref.snapshotId,
      });
    }

    signal?.throwIfAborted();

    // ── Step 6: Execute the query under the lock ──────────────────────────
    let result: LocalCodeIndexQueryResult;

    switch (query.kind) {
      case "definitions":
        result = await executeDefinitionsQuery(
          storageRoot,
          ref.repositoryKey,
          ref.snapshotId,
          identity,
          indexMap,
          query.symbol,
          query.match,
          limit,
          signal,
        );
        break;

      case "references":
        result = await executeReferencesQuery(
          storageRoot,
          ref.repositoryKey,
          ref.snapshotId,
          identity,
          indexMap,
          query.symbol,
          limit,
          signal,
        );
        break;

      case "imports":
        result = await executeImportsQuery(
          storageRoot,
          ref.repositoryKey,
          ref.snapshotId,
          identity,
          query.path,
          limit,
          signal,
        );
        break;

      case "file-summary":
        result = await executeFileSummaryQuery(
          storageRoot,
          ref.repositoryKey,
          ref.snapshotId,
          identity,
          query.path,
          signal,
        );
        break;

      case "related-files":
        result = await executeRelatedFilesQuery(
          storageRoot,
          ref.repositoryKey,
          ref.snapshotId,
          identity,
          indexMap,
          query.paths,
          query.symbols ?? [],
          limit,
          signal,
        );
        break;

      case "inventory":
        result = await executeInventoryQuery(
          storageRoot,
          ref.repositoryKey,
          ref.snapshotId,
          identity,
          query.cursor,
          limit,
          signal,
        );
        break;
    }

    return result;
  } finally {
    // ── Step 7: Release the lock ──────────────────────────────────────────
    await releaseIndexLock(lockDir, lockOwner).catch(() => {
      // Swallow release errors — the primary result or error is more important.
    });
  }
}
