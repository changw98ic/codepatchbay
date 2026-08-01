/**
 * Local Code Index v2 — shard computation and incremental rebuild.
 *
 * Implements spec section 7.5 (Sharding):
 *
 *   - Symbol lookup keys are normalized with Unicode NFC and case preserved.
 *     Definitions and references are stored in shards selected by the first
 *     byte of SHA-256(symbol).
 *
 *   - File summaries and related-file records are stored in shards selected
 *     by the first byte of SHA-256(normalized path). This keeps cold-start
 *     publication bounded for repositories with thousands of files.
 *
 *   - Only touched shards are rebuilt during an incremental update.
 *     Untouched shard objects are reused by object ID.
 *
 *   - Shard object IDs are full SHA-256 digests of their canonical JSON
 *     bytes (spec section 7.3).
 *
 * This module provides:
 *
 *   1. Bucket computation: deterministic 1-byte symbol and 2-byte path
 *      bucket indices.
 *   2. NFC normalization for symbol keys.
 *   3. Path normalization (forward-slash, no leading ./ or trailing /).
 *   4. Shard data builders that aggregate items into typed shard payloads.
 *   5. Incremental rebuild logic that partitions items into touched vs
 *      untouched buckets, rebuilds only touched shards, and reuses
 *      untouched shard object IDs.
 *
 * Dependencies: node:crypto, canonical-json.ts.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md section 7.5
 */

import { createHash } from "node:crypto";

import { canonicalStringify, objectId } from "./canonical-json.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Total number of shard buckets.
 *
 * The first byte of a SHA-256 digest yields an 8-bit value (0–255).
 * Every key maps to exactly one of 256 buckets.
 */
export const SHARD_BUCKET_COUNT = 256;
export const PATH_SHARD_BUCKET_COUNT = 256;

/**
 * Pre-computed two-character hex strings for all 256 bucket indices.
 */
const SYMBOL_BUCKET_HEX: readonly string[] = buildBucketHexTable(
  SHARD_BUCKET_COUNT,
  2,
);
const PATH_BUCKET_HEX: readonly string[] = buildBucketHexTable(
  PATH_SHARD_BUCKET_COUNT,
  2,
);

function buildBucketHexTable(count: number, width: number): string[] {
  const table: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    table[i] = i.toString(16).padStart(width, "0");
  }
  return table;
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalize a symbol key with Unicode NFC, preserving case.
 *
 * Spec section 7.5: "Symbol lookup keys are normalized with Unicode NFC
 * and case preserved."
 *
 * NFC (Canonical Decomposition, followed by Canonical Composition) ensures
 * that canonically equivalent Unicode sequences are represented identically.
 * Case is intentionally preserved — the index does not perform case folding.
 *
 * @param symbol - Raw symbol name from parser output.
 * @returns NFC-normalized symbol string.
 */
export function normalizeSymbol(symbol: string): string {
  return symbol.normalize("NFC");
}

/**
 * Normalize a source-relative path for shard bucket selection.
 *
 * The normalization ensures deterministic bucket assignment:
 *
 *   1. Replace backslashes with forward slashes (Windows compatibility).
 *   2. Remove a leading "./" prefix if present.
 *   3. Remove a trailing "/" if present.
 *   4. Apply Unicode NFC normalization to the path string.
 *
 * The result is a forward-slash path without leading "./" or trailing "/"
 * suitable for consistent hashing.  This does not resolve ".." segments
 * or perform any filesystem-level canonicalization — those operations
 * belong to the source observation layer.
 *
 * @param path - Source-relative path from the file inventory.
 * @returns Normalized path string.
 */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
  return p.normalize("NFC");
}

// ── Bucket computation ───────────────────────────────────────────────────────

/**
 * Compute the shard bucket index for a symbol key.
 *
 * Formula (spec section 7.5):
 *   first byte of SHA-256(NFC-normalized symbol)
 *
 * The symbol is first NFC-normalized, then hashed. The first byte is used.
 *
 * @param symbol - Raw symbol name (will be NFC-normalized internally).
 * @returns Bucket index in [0, 255].
 */
export function symbolBucketIndex(symbol: string): number {
  const normalized = normalizeSymbol(symbol);
  const hash = createHash("sha256").update(normalized, "utf8").digest();
  return hash[0]!;
}

/**
 * Compute the shard bucket hex key for a symbol key.
 *
 * Returns the 2-character lowercase hex representation of the bucket index.
 *
 * @param symbol - Raw symbol name (will be NFC-normalized internally).
 * @returns 2-char lowercase hex bucket key.
 */
export function symbolBucketKey(symbol: string): string {
  return SYMBOL_BUCKET_HEX[symbolBucketIndex(symbol)]!;
}

/**
 * Compute the shard bucket index for a normalized path.
 *
 * Formula (spec section 7.5):
 *   first byte of SHA-256(normalized path)
 *
 * The path is first normalized (forward-slash, no leading "./", no
 * trailing "/", NFC), then hashed.
 *
 * @param path - Source-relative path (will be normalized internally).
 * @returns Bucket index in [0, 255].
 */
export function pathBucketIndex(path: string): number {
  const normalized = normalizePath(path);
  const hash = createHash("sha256").update(normalized, "utf8").digest();
  return hash[0]!;
}

/**
 * Compute the shard bucket hex key for a normalized path.
 *
 * @param path - Source-relative path (will be normalized internally).
 * @returns 2-char lowercase hex bucket key.
 */
export function pathBucketKey(path: string): string {
  return PATH_BUCKET_HEX[pathBucketIndex(path)]!;
}

// ── Shard payload types ──────────────────────────────────────────────────────

/**
 * A single symbol occurrence entry inside a symbol shard bucket.
 *
 * Each entry records the symbol name, kind, role, the file path where
 * it occurs, the source range, export status, and extraction coverage.
 */
export type ShardSymbolEntry = Readonly<{
  symbol: string;
  kind: string;
  role: "definition" | "reference";
  path: string;
  range: Readonly<{
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }>;
  exported: boolean;
  coverage: string;
}>;

/**
 * A symbol shard payload.
 *
 * The bucket key is the 2-char hex string for the shard index.
 * The entries array contains all symbol occurrences that hash to this
 * bucket, sorted deterministically for canonical serialization.
 *
 * The shard object ID is SHA-256 of the canonical JSON bytes of this
 * payload (spec section 7.3).
 */
export type SymbolShard = Readonly<{
  bucket: string;
  entries: readonly ShardSymbolEntry[];
}>;

/**
 * A single file summary entry inside a relation shard bucket.
 *
 * Contains the minimal file metadata needed for file-summary and
 * related-file queries.
 */
export type ShardFileSummaryEntry = Readonly<{
  path: string;
  language: string;
  size: number;
  contentId: string;
  coverage: string;
}>;

/**
 * A single relationship entry inside a relation shard bucket.
 */
export type ShardRelationshipEntry = Readonly<{
  fromPath: string;
  toPath: string;
  type: "imports" | "references" | "ambiguous-reference";
  symbol: string | null;
  weight: number;
}>;

/**
 * A relation shard payload.
 *
 * Contains file summaries and relationships that hash to this bucket.
 * The shard object ID is SHA-256 of the canonical JSON bytes.
 */
export type RelationShard = Readonly<{
  bucket: string;
  fileSummaries: readonly ShardFileSummaryEntry[];
  relationships: readonly ShardRelationshipEntry[];
}>;

// ── Shard sorting ────────────────────────────────────────────────────────────

/**
 * Comparison order for symbol shard entries.
 *
 * Spec section 5.2: "Exact definition and reference results sort by
 * normalized path, range start, range end, then symbol kind."
 */
function compareSymbolEntries(
  a: ShardSymbolEntry,
  b: ShardSymbolEntry,
): number {
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
  // 7. Symbol name (stable tie-breaker)
  if (a.symbol < b.symbol) return -1;
  if (a.symbol > b.symbol) return 1;
  return 0;
}

/**
 * Comparison order for file summary entries (by normalized path).
 */
function compareFileSummaryEntries(
  a: ShardFileSummaryEntry,
  b: ShardFileSummaryEntry,
): number {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

/**
 * Comparison order for relationship entries.
 *
 * Sorted by fromPath, toPath, type, then symbol for determinism.
 */
function compareRelationshipEntries(
  a: ShardRelationshipEntry,
  b: ShardRelationshipEntry,
): number {
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

// ── Shard construction ───────────────────────────────────────────────────────

/**
 * Build a symbol shard payload from a set of entries for one bucket.
 *
 * Entries are sorted deterministically before inclusion so that identical
 * input sets always produce the same canonical JSON and therefore the
 * same object ID.
 *
 * @param bucketKey - 2-char hex bucket key.
 * @param entries - Unsorted entries for this bucket.
 * @returns A deterministic symbol shard payload.
 */
export function buildSymbolShard(
  bucketKey: string,
  entries: readonly ShardSymbolEntry[],
): SymbolShard {
  const sorted = [...entries].sort(compareSymbolEntries);
  return { bucket: bucketKey, entries: sorted };
}

/**
 * Build a relation shard payload from file summaries and relationships
 * for one bucket.
 *
 * Both arrays are sorted deterministically before inclusion.
 *
 * @param bucketKey - 2-char hex bucket key.
 * @param fileSummaries - Unsorted file summary entries for this bucket.
 * @param relationships - Unsorted relationship entries for this bucket.
 * @returns A deterministic relation shard payload.
 */
export function buildRelationShard(
  bucketKey: string,
  fileSummaries: readonly ShardFileSummaryEntry[],
  relationships: readonly ShardRelationshipEntry[],
): RelationShard {
  const sortedSummaries = [...fileSummaries].sort(compareFileSummaryEntries);
  const sortedRelationships = [...relationships].sort(compareRelationshipEntries);
  return {
    bucket: bucketKey,
    fileSummaries: sortedSummaries,
    relationships: sortedRelationships,
  };
}

/**
 * Derive the object ID for a shard payload.
 *
 * Spec section 7.3: "Blob-map, symbol-shard, and relation-shard object
 * IDs are full SHA-256 digests of their canonical JSON bytes."
 *
 * Uses `objectId` from canonical-json.ts, which applies canonical
 * serialization (sorted keys, no whitespace, trailing newline) before
 * hashing.
 *
 * @param shard - A symbol shard or relation shard payload.
 * @returns 64-character lowercase hex SHA-256 digest.
 */
export function deriveShardObjectId(shard: SymbolShard | RelationShard): string {
  return objectId(shard);
}

// ── Distribution helpers ─────────────────────────────────────────────────────

/**
 * Distribute a collection of items into shard buckets by symbol key.
 *
 * Each item's symbol is NFC-normalized and hashed to determine its
 * bucket.  The returned map contains only non-empty buckets.
 *
 * @param items - Items with a `symbol` field.
 * @param getSymbol - Extracts the symbol string from an item.
 * @returns Map from 2-char hex bucket key to the items in that bucket.
 */
export function distributeBySymbol<T>(
  items: readonly T[],
  getSymbol: (item: T) => string,
): ReadonlyMap<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = symbolBucketKey(getSymbol(item));
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(item);
  }
  return buckets;
}

/**
 * Distribute a collection of items into shard buckets by normalized path.
 *
 * Each item's path is normalized and hashed to determine its bucket.
 * The returned map contains only non-empty buckets.
 *
 * @param items - Items with a `path` field.
 * @param getPath - Extracts the path string from an item.
 * @returns Map from 2-char hex bucket key to the items in that bucket.
 */
export function distributeByPath<T>(
  items: readonly T[],
  getPath: (item: T) => string,
): ReadonlyMap<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = pathBucketKey(getPath(item));
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(item);
  }
  return buckets;
}

// ── Incremental rebuild ──────────────────────────────────────────────────────

/**
 * Input for incremental shard rebuild.
 *
 * Describes what changed between the previous snapshot and the current
 * state, so that only affected shard buckets are rebuilt.
 */
export type ShardRebuildInput = Readonly<{
  /**
   * All symbol entries from the previous snapshot that are being
   * replaced or removed.  Used to determine which symbol shard
   * buckets are touched.
   */
  previousSymbolEntries: readonly ShardSymbolEntry[];

  /**
   * All symbol entries for the current snapshot.
   */
  currentSymbolEntries: readonly ShardSymbolEntry[];

  /**
   * All file summary entries from the previous snapshot.
   */
  previousFileSummaries: readonly ShardFileSummaryEntry[];

  /**
   * All file summary entries for the current snapshot.
   */
  currentFileSummaries: readonly ShardFileSummaryEntry[];

  /**
   * All relationship entries from the previous snapshot.
   */
  previousRelationships: readonly ShardRelationshipEntry[];

  /**
   * All relationship entries for the current snapshot.
   */
  currentRelationships: readonly ShardRelationshipEntry[];

  /**
   * Map from bucket key to the existing shard object ID from the
   * previous snapshot.  Buckets not present in this map are new.
   */
  previousSymbolShardIds: ReadonlyMap<string, string>;

  /**
   * Map from bucket key to the existing shard object ID from the
   * previous snapshot for relation shards.
   */
  previousRelationShardIds: ReadonlyMap<string, string>;

  /**
   * If provided, read the existing shard payload for a given object ID.
   * When a bucket is untouched and its object ID is known, the shard
   * is reused without reconstruction.
   *
   * This callback is optional — when absent, all touched shards are
   * rebuilt and untouched shards reuse their object IDs without
   * re-reading.
   */
  readExistingShard?: (
    objectId: string,
  ) => Promise<SymbolShard | RelationShard | null>;
}>;

/**
 * A single rebuilt or reused symbol shard.
 */
export type RebuiltSymbolShard = Readonly<{
  /** 2-char hex bucket key. */
  bucketKey: string;
  /** The shard payload (rebuilt from current entries). */
  shard: SymbolShard;
  /** The object ID (SHA-256 of canonical JSON bytes). */
  objectId: string;
  /** Whether this shard was newly built or reused. */
  status: "rebuilt" | "reused";
}>;

/**
 * A single rebuilt or reused relation shard.
 */
export type RebuiltRelationShard = Readonly<{
  /** 2-char hex bucket key. */
  bucketKey: string;
  /** The shard payload (rebuilt from current data). */
  shard: RelationShard;
  /** The object ID (SHA-256 of canonical JSON bytes). */
  objectId: string;
  /** Whether this shard was newly built or reused. */
  status: "rebuilt" | "reused";
}>;

/**
 * Result of an incremental shard rebuild.
 */
export type ShardRebuildResult = Readonly<{
  /** Rebuilt or reused symbol shards, keyed by bucket. */
  symbolShards: readonly RebuiltSymbolShard[];
  /** Rebuilt or reused relation shards, keyed by bucket. */
  relationShards: readonly RebuiltRelationShard[];
  /** Number of symbol shards that were rebuilt (not reused). */
  rebuiltSymbolShardCount: number;
  /** Number of relation shards that were rebuilt (not reused). */
  rebuiltRelationShardCount: number;
  /** Final map from bucket key to symbol shard object ID. */
  symbolShardIds: ReadonlyMap<string, string>;
  /** Final map from bucket key to relation shard object ID. */
  relationShardIds: ReadonlyMap<string, string>;
}>;

/**
 * Determine the set of shard bucket keys that are "touched" by a change.
 *
 * A bucket is touched when any item (previous or current) hashes to it
 * and the item set for that bucket differs between previous and current.
 *
 * @param previousItems - Items from the previous snapshot.
 * @param currentItems - Items for the current snapshot.
 * @param getKey - Extracts the hashable key (symbol or path) from an item.
 * @returns Set of touched bucket hex keys.
 */
function findTouchedBuckets<T>(
  previousItems: readonly T[],
  currentItems: readonly T[],
  getKey: (item: T) => string,
): ReadonlySet<string> {
  const touched = new Set<string>();

  // Distribute previous and current items into buckets.
  const prevBuckets = distributeBySymbolOrPath(previousItems, getKey);
  const currBuckets = distributeBySymbolOrPath(currentItems, getKey);

  // A bucket is touched if it appears in either set and differs.
  const allKeys = new Set([...prevBuckets.keys(), ...currBuckets.keys()]);
  for (const bucketKey of allKeys) {
    const prev = prevBuckets.get(bucketKey);
    const curr = currBuckets.get(bucketKey);

    // New bucket or removed bucket — always touched.
    if (!prev || !curr) {
      touched.add(bucketKey);
      continue;
    }

    // Same bucket — compare canonical JSON for equality.
    const prevJson = canonicalStringify(prev);
    const currJson = canonicalStringify(curr);
    if (prevJson !== currJson) {
      touched.add(bucketKey);
    }
  }

  return touched;
}

/**
 * Internal helper: distribute items by key using either symbol or path
 * bucket computation.
 */
function distributeBySymbolOrPath<T>(
  items: readonly T[],
  getKey: (item: T) => string,
): Map<string, T[]> {
  // Use symbol bucket for all items (the caller chooses which key to extract).
  // For path-based items, getKey returns the path; for symbol-based, the symbol.
  // We detect which normalization to apply based on a heuristic: if the key
  // looks like a path (contains /), use path bucketing; otherwise symbol.
  // But this is a private helper — the public API is distributeBySymbol
  // and distributeByPath.
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const rawKey = getKey(item);
    // Use symbol bucket (the distribution logic is the same SHA-256 prefix;
    // normalization differs, but we normalize the key before hashing).
    const key = symbolBucketKey(rawKey);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(item);
  }
  return buckets;
}

/**
 * Perform an incremental shard rebuild.
 *
 * This is the main entry point for shard construction during an
 * incremental update.  It:
 *
 *   1. Distributes current symbol entries and relation data into buckets.
 *   2. Identifies which buckets are touched by comparing with previous data.
 *   3. Rebuilds only touched shards from the current data.
 *   4. Reuses untouched shard object IDs from the previous snapshot.
 *   5. Returns the complete set of shard IDs for the new snapshot.
 *
 * The rebuild is deterministic: identical inputs always produce identical
 * shard payloads, object IDs, and output ordering.
 *
 * @param input - Previous and current shard data, plus previous shard IDs.
 * @returns Rebuilt shards, reuse counts, and final shard ID maps.
 */
export async function rebuildShards(
  input: ShardRebuildInput,
): Promise<ShardRebuildResult> {
  // ── 1. Distribute current entries into buckets ──────────────────────────
  const currentSymbolBuckets = distributeBySymbol(
    input.currentSymbolEntries,
    (e) => e.symbol,
  );
  const currentSummaryBuckets = distributeByPath(
    input.currentFileSummaries,
    (e) => e.path,
  );
  const currentRelationshipBuckets = distributeByPath(
    input.currentRelationships,
    (e) => e.fromPath,
  );

  // ── 2. Distribute previous entries into buckets ─────────────────────────
  const previousSymbolBuckets = distributeBySymbol(
    input.previousSymbolEntries,
    (e) => e.symbol,
  );
  const previousSummaryBuckets = distributeByPath(
    input.previousFileSummaries,
    (e) => e.path,
  );
  const previousRelationshipBuckets = distributeByPath(
    input.previousRelationships,
    (e) => e.fromPath,
  );

  // ── 3. Find touched symbol shard buckets ────────────────────────────────
  const touchedSymbolBuckets = findChangedBuckets(
    previousSymbolBuckets,
    currentSymbolBuckets,
  );

  // ── 4. Find touched relation shard buckets ──────────────────────────────
  // A relation shard bucket is touched if either its file summaries or
  // its relationships changed.
  const touchedSummaryBuckets = findChangedBuckets(
    previousSummaryBuckets,
    currentSummaryBuckets,
  );
  const touchedRelBuckets = findChangedBuckets(
    previousRelationshipBuckets,
    currentRelationshipBuckets,
  );
  const touchedRelationBuckets = new Set<string>([
    ...touchedSummaryBuckets,
    ...touchedRelBuckets,
  ]);

  // ── 5. Rebuild symbol shards ────────────────────────────────────────────
  const symbolShards: RebuiltSymbolShard[] = [];
  const symbolShardIds = new Map<string, string>();
  let rebuiltSymbolShardCount = 0;

  // Process all buckets that have current entries.
  const allSymbolBucketKeys = new Set([
    ...currentSymbolBuckets.keys(),
    ...input.previousSymbolShardIds.keys(),
  ]);

  for (const bucketKey of allSymbolBucketKeys) {
    const currEntries = currentSymbolBuckets.get(bucketKey);

    if (!currEntries || currEntries.length === 0) {
      // Bucket is empty in current state — skip (not included in new snapshot).
      continue;
    }

    if (touchedSymbolBuckets.has(bucketKey)) {
      // Rebuild this shard from current entries.
      const shard = buildSymbolShard(bucketKey, currEntries);
      const id = deriveShardObjectId(shard);
      symbolShards.push({ bucketKey, shard, objectId: id, status: "rebuilt" });
      symbolShardIds.set(bucketKey, id);
      rebuiltSymbolShardCount++;
    } else {
      // Reuse the existing shard object ID.
      const existingId = input.previousSymbolShardIds.get(bucketKey);
      if (existingId !== undefined) {
        symbolShardIds.set(bucketKey, existingId);
        // If the caller provides a reader, verify the shard still exists.
        if (input.readExistingShard) {
          const existing = await input.readExistingShard(existingId);
          if (existing) {
            symbolShards.push({
              bucketKey,
              shard: existing as SymbolShard,
              objectId: existingId,
              status: "reused",
            });
          } else {
            // Shard was garbage collected — rebuild.
            const shard = buildSymbolShard(bucketKey, currEntries);
            const id = deriveShardObjectId(shard);
            symbolShards.push({
              bucketKey,
              shard,
              objectId: id,
              status: "rebuilt",
            });
            symbolShardIds.set(bucketKey, id);
            rebuiltSymbolShardCount++;
          }
        } else {
          // No reader available — rebuild from current entries to
          // ensure the output array is complete, but mark as reused
          // since the shard content hasn't changed.
          const shard = buildSymbolShard(bucketKey, currEntries);
          symbolShards.push({ bucketKey, shard, objectId: existingId, status: "reused" });
        }
      } else {
        // New bucket not in previous — rebuild.
        const shard = buildSymbolShard(bucketKey, currEntries);
        const id = deriveShardObjectId(shard);
        symbolShards.push({
          bucketKey,
          shard,
          objectId: id,
          status: "rebuilt",
        });
        symbolShardIds.set(bucketKey, id);
        rebuiltSymbolShardCount++;
      }
    }
  }

  // ── 6. Rebuild relation shards ──────────────────────────────────────────
  const relationShards: RebuiltRelationShard[] = [];
  const relationShardIds = new Map<string, string>();
  let rebuiltRelationShardCount = 0;

  // Union all relation bucket keys from summaries and relationships.
  const allRelationBucketKeys = new Set([
    ...currentSummaryBuckets.keys(),
    ...currentRelationshipBuckets.keys(),
    ...input.previousRelationShardIds.keys(),
  ]);

  for (const bucketKey of allRelationBucketKeys) {
    const currSummaries = currentSummaryBuckets.get(bucketKey) ?? [];
    const currRels = currentRelationshipBuckets.get(bucketKey) ?? [];

    if (currSummaries.length === 0 && currRels.length === 0) {
      // Bucket is empty — skip.
      continue;
    }

    if (touchedRelationBuckets.has(bucketKey)) {
      // Rebuild.
      const shard = buildRelationShard(bucketKey, currSummaries, currRels);
      const id = deriveShardObjectId(shard);
      relationShards.push({
        bucketKey,
        shard,
        objectId: id,
        status: "rebuilt",
      });
      relationShardIds.set(bucketKey, id);
      rebuiltRelationShardCount++;
    } else {
      // Reuse.
      const existingId = input.previousRelationShardIds.get(bucketKey);
      if (existingId !== undefined) {
        relationShardIds.set(bucketKey, existingId);
        if (input.readExistingShard) {
          const existing = await input.readExistingShard(existingId);
          if (existing) {
            relationShards.push({
              bucketKey,
              shard: existing as RelationShard,
              objectId: existingId,
              status: "reused",
            });
          } else {
            const shard = buildRelationShard(
              bucketKey,
              currSummaries,
              currRels,
            );
            const id = deriveShardObjectId(shard);
            relationShards.push({
              bucketKey,
              shard,
              objectId: id,
              status: "rebuilt",
            });
            relationShardIds.set(bucketKey, id);
            rebuiltRelationShardCount++;
          }
        } else {
          // No reader available — rebuild from current entries to
          // ensure the output array is complete, but mark as reused
          // since the shard content hasn't changed.
          const shard = buildRelationShard(bucketKey, currSummaries, currRels);
          relationShards.push({ bucketKey, shard, objectId: existingId, status: "reused" });
        }
      } else {
        const shard = buildRelationShard(bucketKey, currSummaries, currRels);
        const id = deriveShardObjectId(shard);
        relationShards.push({
          bucketKey,
          shard,
          objectId: id,
          status: "rebuilt",
        });
        relationShardIds.set(bucketKey, id);
        rebuiltRelationShardCount++;
      }
    }
  }

  // ── 7. Sort output deterministically ────────────────────────────────────
  symbolShards.sort((a, b) => {
    if (a.bucketKey < b.bucketKey) return -1;
    if (a.bucketKey > b.bucketKey) return 1;
    return 0;
  });
  relationShards.sort((a, b) => {
    if (a.bucketKey < b.bucketKey) return -1;
    if (a.bucketKey > b.bucketKey) return 1;
    return 0;
  });

  return {
    symbolShards,
    relationShards,
    rebuiltSymbolShardCount,
    rebuiltRelationShardCount,
    symbolShardIds,
    relationShardIds,
  };
}

/**
 * Find bucket keys whose contents changed between two distributions.
 *
 * A bucket is "changed" if:
 *   - It exists in one distribution but not the other.
 *   - It exists in both but the canonical JSON of its items differs.
 *
 * @param previous - Previous bucket distribution.
 * @param current - Current bucket distribution.
 * @returns Set of changed bucket hex keys.
 */
function findChangedBuckets<T>(
  previous: ReadonlyMap<string, readonly T[]>,
  current: ReadonlyMap<string, readonly T[]>,
): ReadonlySet<string> {
  const changed = new Set<string>();
  const allKeys = new Set([...previous.keys(), ...current.keys()]);

  for (const key of allKeys) {
    const prev = previous.get(key);
    const curr = current.get(key);

    if (!prev || !curr) {
      changed.add(key);
      continue;
    }

    // Compare canonical JSON for byte equality.
    const prevJson = canonicalStringify(prev);
    const currJson = canonicalStringify(curr);
    if (prevJson !== currJson) {
      changed.add(key);
    }
  }

  return changed;
}
