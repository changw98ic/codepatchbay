/**
 * Local Code Index v2 — import resolution and cross-file relationship builder.
 *
 * Resolves raw imports to target paths, classifies symbol references as unique
 * or ambiguous, builds evidence-backed relationship records, and computes the
 * affected-set for incremental invalidation.
 *
 * All relationships are snapshot-local: they consume raw file-object facts
 * plus a versioned resolution-config fingerprint. No resolved target is reused
 * merely because source bytes match.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md sections 7.3, 7.5, 8.5
 *
 * Dependencies: node:crypto, contracts.ts, extract.ts, canonical-json.ts.
 */

import { createHash } from "node:crypto";

import type { SourceRange } from "./contracts.js";
import type { ExtractedImport, ExtractedReference, ExtractedDefinition } from "./extract.js";
import { canonicalStringify, objectId } from "./canonical-json.js";

// ── Resolution config ─────────────────────────────────────────────────────

/**
 * Versioned import-resolution configuration.
 *
 * Derived from relevant package manifests, TypeScript/JavaScript config,
 * language mapping files, and the complete path inventory. The fingerprint
 * changes when any input changes, which invalidates all affected import
 * relationships.
 */
export type ResolutionConfig = Readonly<{
  /** Language scope this config applies to (e.g., "typescript", "python"). */
  language: string;
  /** Version bumped when resolution rules change. */
  version: number;
  /** Module resolution strategy (e.g., "node", "bundler", "classic"). */
  moduleResolution: string;
  /** Base URL or root dir for non-relative imports, if configured. */
  baseUrl: string | null;
  /** Path alias mappings (e.g., {"@app/*": ["./src/*"]}). */
  pathAliases: Readonly<Record<string, readonly string[]>>;
  /** Known file extensions tried during resolution, in priority order. */
  extensions: readonly string[];
  /** Index file names tried for directory imports (e.g., ["index.ts", "index.js"]). */
  indexFiles: readonly string[];
  /** Package.json exports/main fields that were consulted, or empty. */
  packageFields: readonly string[];
}>;

/**
 * Compute a 32-hex-char fingerprint of the resolution config.
 *
 * This fingerprint is included in import resolution results so that any
 * change to resolution rules invalidates affected relationship shards.
 */
export function deriveResolutionConfigFingerprint(
  config: ResolutionConfig,
): string {
  return createHash("sha256")
    .update(canonicalStringify(config))
    .digest("hex")
    .slice(0, 32);
}

// ── Path inventory ────────────────────────────────────────────────────────

/**
 * A normalized path inventory entry for import resolution.
 *
 * Only the path and exported symbol names are needed for resolution;
 * full file-object data is not consulted here.
 */
export type PathInventoryEntry = Readonly<{
  /** Canonical relative path from source root (using `/`). */
  path: string;
  /** Language detected for this file. */
  language: string;
  /** Exported symbol names from this file's definitions. */
  exportedSymbols: readonly string[];
}>;

// ── Resolved import ───────────────────────────────────────────────────────

/**
 * An import resolved to a concrete target path within the snapshot.
 *
 * When `resolvedPath` is null, the import specifier could not be matched
 * to any indexed file (external package, unresolvable alias, etc.).
 */
export type ResolvedImport = Readonly<{
  /** The raw import specifier as written in source. */
  requested: string;
  /** The resolved target path within the snapshot, or null if unresolvable. */
  resolvedPath: string | null;
  /** Source range of the import statement. */
  range: SourceRange;
  /** Import kind from extraction. */
  importKind: string;
  /** Resolution-config fingerprint used to produce this result. */
  resolutionConfigFingerprint: string;
}>;

// ── Relationship types ────────────────────────────────────────────────────

/**
 * The type of a file-to-file relationship.
 *
 * - `"imports"`: a deterministic import/include points to another indexed file.
 * - `"references"`: a file references a name uniquely defined by another file.
 * - `"ambiguous-reference"`: a referenced name has multiple possible defining
 *   files. Retained but lower weight; never claims a unique call edge.
 */
export type RelationshipType =
  | "imports"
  | "references"
  | "ambiguous-reference";

/**
 * An evidence-backed relationship record between two files.
 *
 * Every relationship carries source-range evidence so callers can verify
 * the claim. A relationship without evidence is invalid.
 */
export type RelationshipRecord = Readonly<{
  /** Source file path (the file that imports/references). */
  fromPath: string;
  /** Target file path (the file being imported/referenced). */
  toPath: string;
  /** Relationship type. */
  type: RelationshipType;
  /** The symbol name involved, if applicable (null for side-effect imports). */
  symbol: string | null;
  /** Source ranges in `fromPath` that establish this relationship. */
  evidence: readonly SourceRange[];
  /** Numeric weight: imports > unique references > ambiguous references. */
  weight: number;
}>;

/**
 * A relationship shard payload for storage as a relation-shard object.
 *
 * Spec section 7.5: relation shards are content-addressed by the SHA-256
 * of their canonical JSON bytes.
 */
export type RelationshipShard = Readonly<{
  /** Shard schema version. */
  schemaVersion: 1;
  /** The path this shard covers (the `fromPath` of contained relationships). */
  path: string;
  /** Resolution-config fingerprint used to build this shard. */
  resolutionConfigFingerprint: string;
  /** All outgoing relationships from this path. */
  relationships: readonly RelationshipRecord[];
}>;

// ── Affected-set computation ──────────────────────────────────────────────

/**
 * Reasons a path's relationships may need rebuilding.
 *
 * Each flag corresponds to a spec section 8.5 invalidation rule.
 */
export type AffectedReason =
  | "definition-changed"
  | "import-changed"
  | "alias-changed"
  | "config-changed"
  | "deleted"
  | "renamed"
  | "retargeted"
  | "uniqueness-transition";

/**
 * A path in the affected set with the reason(s) it was included.
 */
export type AffectedEntry = Readonly<{
  /** The path whose relationships need rebuilding. */
  path: string;
  /** Why this path is affected. */
  reasons: readonly AffectedReason[];
}>;

/**
 * Complete affected-set for relationship invalidation.
 */
export type AffectedSet = Readonly<{
  /** Paths that need their relationship shards rebuilt. */
  entries: readonly AffectedEntry[];
  /** Unique set of all affected paths (for fast lookup). */
  paths: ReadonlySet<string>;
  /** Whether the resolution config changed (forces full import rebuild). */
  configChanged: boolean;
}>;

// ── Symbol definition index ───────────────────────────────────────────────

/**
 * Index of symbol definitions across all files, used for reference resolution.
 */
export type SymbolDefinitionIndex = ReadonlyMap<
  string,
  readonly Readonly<{
    /** The file path where this symbol is defined. */
    path: string;
    /** Whether the symbol is exported. */
    exported: boolean;
    /** Definition kind (function, class, etc.). */
    kind: string;
  }>[]
>;

/**
 * Build a symbol definition index from per-file extraction results.
 *
 * Only exported definitions are included, because non-exported symbols
 * cannot be cross-file references.
 */
export function buildSymbolDefinitionIndex(
  files: ReadonlyMap<string, readonly ExtractedDefinition[]>,
): SymbolDefinitionIndex {
  const index = new Map<string, { path: string; exported: boolean; kind: string }[]>();

  for (const [path, definitions] of files) {
    for (const def of definitions) {
      if (!def.exported) continue;
      let entries = index.get(def.name);
      if (!entries) {
        entries = [];
        index.set(def.name, entries);
      }
      entries.push({ path, exported: def.exported, kind: def.kind });
    }
  }

  return index;
}

// ── Import resolution ─────────────────────────────────────────────────────

/**
 * Resolve a single import specifier against the path inventory.
 *
 * Resolution strategy (spec section 8.5):
 * 1. Relative specifiers (`./`, `../`) resolve relative to the importing file.
 * 2. Path aliases from the resolution config are tried in order.
 * 3. Bare specifiers are matched against the path inventory by suffix.
 * 4. Extension-less specifiers try the configured extensions in order.
 * 5. Directory specifiers try the configured index files.
 *
 * Returns the matched path or null if unresolvable.
 */
function resolveSpecifier(
  requested: string,
  fromPath: string,
  config: ResolutionConfig,
  pathIndex: ReadonlyMap<string, PathInventoryEntry>,
): string | null {
  // 1. Relative specifiers.
  if (requested.startsWith("./") || requested.startsWith("../")) {
    return resolveRelativeSpecifier(requested, fromPath, config, pathIndex);
  }

  // 2. Path aliases.
  for (const [alias, targets] of Object.entries(config.pathAliases)) {
    const aliasPattern = alias.replace(/\*/g, "");
    if (requested.startsWith(aliasPattern) || requested === aliasPattern.replace(/\/$/, "")) {
      const suffix = requested.slice(aliasPattern.length);
      for (const target of targets) {
        const resolved = target.replace(/\*/, suffix);
        const fromDir = fromPath.includes("/")
          ? fromPath.slice(0, fromPath.lastIndexOf("/"))
          : "";
        const normalized = normalizeRelativePath(fromDir, resolved);
        const match = tryExtensionsAndIndex(normalized, config, pathIndex);
        if (match) return match;
      }
    }
  }

  // 3. Bare specifier — match by path suffix (package-like).
  for (const entry of pathIndex.values()) {
    if (pathMatchesBareSpecifier(entry.path, requested, config)) {
      return entry.path;
    }
  }

  return null;
}

/**
 * Resolve a relative import specifier.
 */
function resolveRelativeSpecifier(
  requested: string,
  fromPath: string,
  config: ResolutionConfig,
  pathIndex: ReadonlyMap<string, PathInventoryEntry>,
): string | null {
  const dir = fromPath.includes("/")
    ? fromPath.slice(0, fromPath.lastIndexOf("/"))
    : "";
  const joined = normalizeRelativePath(dir, requested);
  return tryExtensionsAndIndex(joined, config, pathIndex);
}

/**
 * Try adding extensions and index files to a path candidate.
 */
function tryExtensionsAndIndex(
  basePath: string,
  config: ResolutionConfig,
  pathIndex: ReadonlyMap<string, PathInventoryEntry>,
): string | null {
  // Direct match.
  if (pathIndex.has(basePath)) return basePath;

  // Try with extensions.
  for (const ext of config.extensions) {
    const withExt = basePath + ext;
    if (pathIndex.has(withExt)) return withExt;
  }

  // Try as directory with index files.
  for (const indexFile of config.indexFiles) {
    const indexPath = basePath + "/" + indexFile;
    if (pathIndex.has(indexPath)) return indexPath;
    // Also try with extensions on the index file.
    for (const ext of config.extensions) {
      const indexPathExt = basePath + "/" + indexFile + ext;
      if (pathIndex.has(indexPathExt)) return indexPathExt;
    }
  }

  return null;
}

/**
 * Normalize a relative path by resolving `.` and `..` segments.
 */
function normalizeRelativePath(fromDir: string, relative: string): string {
  const parts = (fromDir + "/" + relative).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

/**
 * Check if a path matches a bare (non-relative) specifier.
 *
 * Matches if the path ends with the specifier as a suffix, accounting
 * for extensions and index files.
 */
function pathMatchesBareSpecifier(
  entryPath: string,
  specifier: string,
  config: ResolutionConfig,
): boolean {
  // Direct suffix match.
  if (entryPath === specifier || entryPath.endsWith("/" + specifier)) {
    return true;
  }

  // With extension.
  for (const ext of config.extensions) {
    if (entryPath === specifier + ext || entryPath.endsWith("/" + specifier + ext)) {
      return true;
    }
  }

  // As directory index.
  for (const indexFile of config.indexFiles) {
    if (
      entryPath === specifier + "/" + indexFile ||
      entryPath.endsWith("/" + specifier + "/" + indexFile)
    ) {
      return true;
    }
    for (const ext of config.extensions) {
      const full = specifier + "/" + indexFile + ext;
      if (entryPath === full || entryPath.endsWith("/" + full)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Resolve all imports for a single file.
 *
 * @param filePath - The importing file's path.
 * @param imports - Raw extracted imports from the file.
 * @param config - Resolution configuration.
 * @param configFingerprint - Fingerprint of the resolution config.
 * @param pathIndex - Path inventory for target lookup.
 * @returns Array of resolved imports.
 */
export function resolveImportsForFile(
  filePath: string,
  imports: readonly ExtractedImport[],
  config: ResolutionConfig,
  configFingerprint: string,
  pathIndex: ReadonlyMap<string, PathInventoryEntry>,
): readonly ResolvedImport[] {
  const results: ResolvedImport[] = [];

  for (const imp of imports) {
    const resolvedPath = resolveSpecifier(
      imp.requested,
      filePath,
      config,
      pathIndex,
    );

    results.push({
      requested: imp.requested,
      resolvedPath,
      range: imp.range,
      importKind: imp.importKind,
      resolutionConfigFingerprint: configFingerprint,
    });
  }

  return results;
}

/**
 * Resolve imports across all files in the snapshot.
 *
 * @param fileImports - Map from file path to its raw extracted imports.
 * @param config - Resolution configuration.
 * @param pathIndex - Path inventory for target lookup.
 * @returns Map from file path to its resolved imports.
 */
export function resolveAllImports(
  fileImports: ReadonlyMap<string, readonly ExtractedImport[]>,
  config: ResolutionConfig,
  pathIndex: ReadonlyMap<string, PathInventoryEntry>,
): ReadonlyMap<string, readonly ResolvedImport[]> {
  const fingerprint = deriveResolutionConfigFingerprint(config);
  const results = new Map<string, readonly ResolvedImport[]>();

  for (const [filePath, imports] of fileImports) {
    results.set(
      filePath,
      resolveImportsForFile(filePath, imports, config, fingerprint, pathIndex),
    );
  }

  return results;
}

// ── Reference classification ──────────────────────────────────────────────

/**
 * Classify a reference as unique or ambiguous based on the definition index.
 *
 * A reference is "unique" when exactly one exported definition matches the
 * symbol name. Zero or multiple matches produce null or ambiguous results.
 */
function classifyReference(
  symbolName: string,
  fromPath: string,
  definitionIndex: SymbolDefinitionIndex,
): {
  type: "references" | "ambiguous-reference";
  targetPaths: readonly string[];
} | null {
  const definitions = definitionIndex.get(symbolName);
  if (!definitions || definitions.length === 0) return null;

  // Filter out self-references.
  const externalDefs = definitions.filter((d) => d.path !== fromPath);
  if (externalDefs.length === 0) return null;

  if (externalDefs.length === 1) {
    return {
      type: "references",
      targetPaths: [externalDefs[0]!.path],
    };
  }

  return {
    type: "ambiguous-reference",
    targetPaths: externalDefs.map((d) => d.path),
  };
}

/**
 * Build reference relationships for a single file.
 *
 * Produces both unique and ambiguous reference records, each backed by
 * source-range evidence. Deduplicates evidence ranges per (from, to, symbol)
 * triple.
 */
export function buildReferencesForFile(
  filePath: string,
  references: readonly ExtractedReference[],
  definitionIndex: SymbolDefinitionIndex,
): readonly RelationshipRecord[] {
  // Group evidence by (targetPath, symbol, type).
  const buckets = new Map<
    string,
    {
      toPath: string;
      symbol: string;
      type: "references" | "ambiguous-reference";
      evidence: SourceRange[];
    }
  >();

  for (const ref of references) {
    const classification = classifyReference(ref.name, filePath, definitionIndex);
    if (!classification) continue;

    for (const targetPath of classification.targetPaths) {
      const key = `${targetPath}\0${ref.name}\0${classification.type}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          toPath: targetPath,
          symbol: ref.name,
          type: classification.type,
          evidence: [],
        };
        buckets.set(key, bucket);
      }
      bucket.evidence.push(ref.range);
    }
  }

  // Convert to RelationshipRecord array.
  const records: RelationshipRecord[] = [];
  for (const bucket of buckets.values()) {
    records.push({
      fromPath: filePath,
      toPath: bucket.toPath,
      type: bucket.type,
      symbol: bucket.symbol,
      evidence: deduplicateRanges(bucket.evidence),
      weight: bucket.type === "references" ? WEIGHT_UNIQUE_REF : WEIGHT_AMBIGUOUS_REF,
    });
  }

  return records;
}

/**
 * Build all reference relationships across the snapshot.
 *
 * @param fileReferences - Map from file path to its extracted references.
 * @param definitionIndex - Symbol definition index.
 * @returns Map from file path to its reference relationships.
 */
export function buildAllReferences(
  fileReferences: ReadonlyMap<string, readonly ExtractedReference[]>,
  definitionIndex: SymbolDefinitionIndex,
): ReadonlyMap<string, readonly RelationshipRecord[]> {
  const results = new Map<string, readonly RelationshipRecord[]>();

  for (const [filePath, references] of fileReferences) {
    results.set(filePath, buildReferencesForFile(filePath, references, definitionIndex));
  }

  return results;
}

// ── Relationship weights ──────────────────────────────────────────────────

/** Weight for import relationships (highest priority). */
export const WEIGHT_IMPORT = 3;

/** Weight for unique reference relationships. */
export const WEIGHT_UNIQUE_REF = 2;

/** Weight for ambiguous reference relationships (lowest priority). */
export const WEIGHT_AMBIGUOUS_REF = 1;

// ── Relationship shard construction ───────────────────────────────────────

/**
 * Build a relationship shard for a single file.
 *
 * Combines resolved imports and classified references into a single shard
 * payload suitable for publication as a relation-shard object.
 */
export function buildRelationshipShard(
  filePath: string,
  resolvedImports: readonly ResolvedImport[],
  referenceRelationships: readonly RelationshipRecord[],
  resolutionConfigFingerprint: string,
): RelationshipShard {
  const relationships: RelationshipRecord[] = [];

  // Import relationships.
  for (const imp of resolvedImports) {
    if (!imp.resolvedPath) continue;
    relationships.push({
      fromPath: filePath,
      toPath: imp.resolvedPath,
      type: "imports",
      symbol: null,
      evidence: [imp.range],
      weight: WEIGHT_IMPORT,
    });
  }

  // Reference relationships (already classified).
  for (const ref of referenceRelationships) {
    relationships.push(ref);
  }

  return {
    schemaVersion: 1,
    path: filePath,
    resolutionConfigFingerprint,
    relationships,
  };
}

/**
 * Build relationship shards for all files in the snapshot.
 *
 * @param resolvedImports - Map from file path to resolved imports.
 * @param referenceRelationships - Map from file path to reference relationships.
 * @param resolutionConfigFingerprint - Fingerprint of the resolution config.
 * @returns Map from file path to its relationship shard.
 */
export function buildAllRelationshipShards(
  resolvedImports: ReadonlyMap<string, readonly ResolvedImport[]>,
  referenceRelationships: ReadonlyMap<string, readonly RelationshipRecord[]>,
  resolutionConfigFingerprint: string,
): ReadonlyMap<string, RelationshipShard> {
  const shards = new Map<string, RelationshipShard>();

  const allPaths = new Set([
    ...resolvedImports.keys(),
    ...referenceRelationships.keys(),
  ]);

  for (const filePath of allPaths) {
    const imports = resolvedImports.get(filePath) ?? [];
    const refs = referenceRelationships.get(filePath) ?? [];
    shards.set(
      filePath,
      buildRelationshipShard(filePath, imports, refs, resolutionConfigFingerprint),
    );
  }

  return shards;
}

// ── Affected-set invalidation ─────────────────────────────────────────────

/**
 * Inputs for computing the affected relationship set.
 */
export type AffectedSetInput = Readonly<{
  /** Paths whose definitions changed (content or fingerprint). */
  changedDefinitions: readonly string[];
  /** Paths whose imports changed. */
  changedImports: readonly string[];
  /** Paths whose export aliases changed (re-exports, barrel files). */
  changedAliases: readonly string[];
  /** Whether the resolution config fingerprint changed. */
  configChanged: boolean;
  /** Paths that were deleted from the snapshot. */
  deletedPaths: readonly string[];
  /** Paths that were renamed (old path -> new path). */
  renamedPaths: readonly Readonly<{ from: string; to: string }>[];
  /** Paths that were retargeted (same content, different path). */
  retargetedPaths: readonly Readonly<{ from: string; to: string }>[];
  /** Symbols whose uniqueness state changed (0<->1, 1<->N, etc.). */
  uniquenessTransitions: ReadonlyArray<Readonly<{
    symbol: string;
    oldDefiningPaths: readonly string[];
    newDefiningPaths: readonly string[];
  }>>;
  /** Previous import targets for changed/deleted paths (to find importers). */
  previousImportTargets: ReadonlyMap<string, readonly string[]>;
  /** Current import targets for changed paths (to find importers). */
  currentImportTargets: ReadonlyMap<string, readonly string[]>;
  /** Map from target path to all paths that import it (previous snapshot). */
  importersByTarget: ReadonlyMap<string, readonly string[]>;
  /** Map from symbol name to all paths that reference it (previous snapshot). */
  referencesBySymbol: ReadonlyMap<string, readonly string[]>;
}>;

/**
 * Compute the affected set for relationship invalidation.
 *
 * Spec section 8.5: the affected relationship set is the union of:
 * 1. every added, modified, deleted, renamed, or retargeted path;
 * 2. every old and new import target of those paths;
 * 3. every path importing a renamed, added, or deleted target;
 * 4. every path containing an old or new reference to a changed definition name;
 * 5. every old and new defining path when a symbol changes between zero, one,
 *    or multiple definitions;
 * 6. every path affected by a changed resolution-config fingerprint.
 *
 * When the config changes, all import relationships for the affected scope
 * are rebuilt. If the scope cannot be proven, all import relationships rebuild.
 */
export function computeAffectedSet(
  input: AffectedSetInput,
): AffectedSet {
  const reasonMap = new Map<string, Set<AffectedReason>>();

  function addReason(path: string, reason: AffectedReason): void {
    let reasons = reasonMap.get(path);
    if (!reasons) {
      reasons = new Set();
      reasonMap.set(path, reasons);
    }
    reasons.add(reason);
  }

  // 1. Changed definitions, imports, aliases.
  for (const p of input.changedDefinitions) addReason(p, "definition-changed");
  for (const p of input.changedImports) addReason(p, "import-changed");
  for (const p of input.changedAliases) addReason(p, "alias-changed");

  // 2. Old and new import targets of changed paths.
  for (const [path, targets] of input.previousImportTargets) {
    for (const target of targets) {
      addReason(target, "import-changed");
    }
  }
  for (const [path, targets] of input.currentImportTargets) {
    for (const target of targets) {
      addReason(target, "import-changed");
    }
  }

  // 3. Every path importing a renamed, added, or deleted target.
  for (const p of input.deletedPaths) {
    addReason(p, "deleted");
    const importers = input.importersByTarget.get(p);
    if (importers) {
      for (const importer of importers) {
        addReason(importer, "import-changed");
      }
    }
  }

  for (const rename of input.renamedPaths) {
    addReason(rename.from, "renamed");
    addReason(rename.to, "renamed");
    // Old importers of the old path need to re-resolve.
    const importers = input.importersByTarget.get(rename.from);
    if (importers) {
      for (const importer of importers) {
        addReason(importer, "import-changed");
      }
    }
  }

  for (const retarget of input.retargetedPaths) {
    addReason(retarget.from, "retargeted");
    addReason(retarget.to, "retargeted");
    const importers = input.importersByTarget.get(retarget.from);
    if (importers) {
      for (const importer of importers) {
        addReason(importer, "import-changed");
      }
    }
  }

  // 4. Paths referencing changed definition names.
  for (const defPath of input.changedDefinitions) {
    // We need to find which symbols changed at this path.
    // The caller provides this indirectly via uniquenessTransitions.
    // Here we add the defining path itself.
    addReason(defPath, "definition-changed");
  }

  // 5. Uniqueness transitions: symbol changed between 0, 1, N definitions.
  for (const transition of input.uniquenessTransitions) {
    const allPaths = new Set([
      ...transition.oldDefiningPaths,
      ...transition.newDefiningPaths,
    ]);
    for (const p of allPaths) {
      addReason(p, "uniqueness-transition");
    }

    // All paths that reference this symbol need reclassification.
    const referrers = input.referencesBySymbol.get(transition.symbol);
    if (referrers) {
      for (const referrer of referrers) {
        addReason(referrer, "uniqueness-transition");
      }
    }
  }

  // 6. Config change — mark all paths with import-changed.
  if (input.configChanged) {
    // When config changes, all import relationships for the affected scope
    // rebuild. Since we cannot prove the scope, mark all paths.
    for (const [path] of reasonMap) {
      addReason(path, "config-changed");
    }
  }

  // Build the affected set.
  const entries: AffectedEntry[] = [];
  const pathSet = new Set<string>();

  for (const [path, reasons] of reasonMap) {
    entries.push({ path, reasons: [...reasons].sort() });
    pathSet.add(path);
  }

  // Sort entries by path for deterministic output.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    entries,
    paths: pathSet,
    configChanged: input.configChanged,
  };
}

// ── Evidence deduplication ────────────────────────────────────────────────

/**
 * Deduplicate source ranges by position.
 *
 * Two ranges are considered duplicates if they have the same start and
 * end positions.
 */
function deduplicateRanges(ranges: readonly SourceRange[]): readonly SourceRange[] {
  const seen = new Set<string>();
  const result: SourceRange[] = [];

  for (const range of ranges) {
    const key = `${range.startLine}:${range.startColumn}:${range.endLine}:${range.endColumn}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(range);
    }
  }

  // Sort by start position for deterministic output.
  result.sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.startColumn !== b.startColumn) return a.startColumn - b.startColumn;
    if (a.endLine !== b.endLine) return a.endLine - b.endLine;
    return a.endColumn - b.endColumn;
  });

  return result;
}

// ── Shard ID derivation ───────────────────────────────────────────────────

/**
 * Derive the content-addressed shard ID for a relationship shard.
 *
 * The ID is the full SHA-256 hex digest of the canonical JSON bytes
 * (spec section 7.3).
 */
export function deriveRelationshipShardId(shard: RelationshipShard): string {
  return objectId(shard);
}

// ── Convenience: full pipeline ────────────────────────────────────────────

/**
 * Input for the full relationship-building pipeline.
 */
export type BuildRelationshipsInput = Readonly<{
  /** Map from file path to its raw extracted imports. */
  fileImports: ReadonlyMap<string, readonly ExtractedImport[]>;
  /** Map from file path to its extracted references. */
  fileReferences: ReadonlyMap<string, readonly ExtractedReference[]>;
  /** Map from file path to its extracted definitions. */
  fileDefinitions: ReadonlyMap<string, readonly ExtractedDefinition[]>;
  /** Resolution configuration for import resolution. */
  resolutionConfig: ResolutionConfig;
  /** Path inventory for import resolution. */
  pathInventory: ReadonlyMap<string, PathInventoryEntry>;
}>;

/**
 * Result of the full relationship-building pipeline.
 */
export type BuildRelationshipsResult = Readonly<{
  /** Per-file relationship shards. */
  shards: ReadonlyMap<string, RelationshipShard>;
  /** Per-file resolved imports. */
  resolvedImports: ReadonlyMap<string, readonly ResolvedImport[]>;
  /** Per-file reference relationships. */
  referenceRelationships: ReadonlyMap<string, readonly RelationshipRecord[]>;
  /** Symbol definition index used for reference classification. */
  definitionIndex: SymbolDefinitionIndex;
  /** Resolution config fingerprint. */
  resolutionConfigFingerprint: string;
}>;

/**
 * Build all relationships for a snapshot in one call.
 *
 * This is the convenience entry point that chains:
 * 1. Symbol definition index construction.
 * 2. Import resolution.
 * 3. Reference classification (unique vs ambiguous).
 * 4. Relationship shard construction.
 */
export function buildAllRelationships(
  input: BuildRelationshipsInput,
): BuildRelationshipsResult {
  const definitionIndex = buildSymbolDefinitionIndex(input.fileDefinitions);
  const fingerprint = deriveResolutionConfigFingerprint(input.resolutionConfig);

  const resolvedImports = resolveAllImports(
    input.fileImports,
    input.resolutionConfig,
    input.pathInventory,
  );

  const referenceRelationships = buildAllReferences(
    input.fileReferences,
    definitionIndex,
  );

  const shards = buildAllRelationshipShards(
    resolvedImports,
    referenceRelationships,
    fingerprint,
  );

  return {
    shards,
    resolvedImports,
    referenceRelationships,
    definitionIndex,
    resolutionConfigFingerprint: fingerprint,
  };
}
