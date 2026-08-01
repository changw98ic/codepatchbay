/**
 * Local Code Index v2 — public barrel.
 *
 * Re-exports all public types, constants, errors, key-derivation helpers,
 * and canonical path builders.  Runtime exports (ensure/status/query) are
 * stubs until service.ts is complete (Phase 6); query is completed in Phase 7.
 */

export {
  // ── Limits ───────────────────────────────────────────────────────────────
  LOCAL_CODE_INDEX_DEFAULT_LIMIT,
  LOCAL_CODE_INDEX_MAX_LIMIT,
  LOCAL_CODE_INDEX_MAX_INPUT_PATHS,
  LOCAL_CODE_INDEX_MAX_INPUT_SYMBOLS,
  LOCAL_CODE_INDEX_MAX_SYMBOL_LENGTH,

  // ── Coverage ordering ────────────────────────────────────────────────────
  LOCAL_CODE_INDEX_COVERAGE_ORDER,

  // ── Error class ──────────────────────────────────────────────────────────
  LocalCodeIndexUnavailableError,
} from "./contracts.js";

// ── Canonical JSON ───────────────────────────────────────────────────────────
export { canonicalStringify, objectId } from "./canonical-json.js";

// ── Storage root, keys, and path builders ────────────────────────────────────
export {
  resolveStorageRoot,
  validateSourcePath,
  validateStorageRoot,
  deriveRepositoryKey,
  deriveWorktreeKey,
  deriveSourceKey,
  computeKeys,
  objectPrefix,
  // Repository namespace
  repositoryDir,
  repositoryObjectsLockDir,
  repositoryObjectsLockOwner,
  repositoryRecoveryElectionsDir,
  repositoryRecoveryElectionDir,
  repositoryObjectsDir,
  repositoryReusableSnapshotPath,
  fileObjectPath,
  blobMapObjectPath,
  symbolShardPath,
  relationShardPath,
  // Worktree namespace
  worktreeDir,
  worktreeCurrentPointer,
  worktreeLockDir,
  worktreeLockOwner,
  worktreeRecoveryElectionsDir,
  worktreeRecoveryElectionDir,
  snapshotsDir,
  snapshotDir,
  snapshotIdentityPath,
  snapshotIndexMapPath,
  runsDir,
  runReportPath,
  // Temp helpers
  tempFileName,
  // Base
  storageBase,
} from "./paths.js";

export type {
  // ── Error reasons ────────────────────────────────────────────────────────
  LocalCodeIndexErrorReason,

  // ── Coverage ─────────────────────────────────────────────────────────────
  LocalCodeIndexCoverage,
  LocalCodeIndexCoverageSummary,

  // ── Ref / identity ───────────────────────────────────────────────────────
  LocalCodeIndexRef,

  // ── Tool state / timings / build stats ───────────────────────────────────
  LocalCodeIndexToolState,
  LocalCodeIndexPhaseTimings,
  LocalCodeIndexBuildStats,

  // ── Ensure options / result ──────────────────────────────────────────────
  EnsureLocalCodeIndexOptions,
  EnsureLocalCodeIndexResult,

  // ── Status ───────────────────────────────────────────────────────────────
  LocalCodeIndexStatus,

  // ── Query types ──────────────────────────────────────────────────────────
  SourceRange,
  SymbolOccurrence,
  FileRelationship,
  FileSummary,
  LocalCodeIndexQuery,
  LocalCodeIndexQueryResult,
} from "./contracts.js";

// ── Safe filesystem operations ────────────────────────────────────────────────

export {
  // ── Error classes ─────────────────────────────────────────────────────────
  FileSizeExceededError,
  SymlinkFollowError,
  ExclusiveCreateConflictError,
  IdentityMismatchError,

  // ── Operations ────────────────────────────────────────────────────────────
  readBoundedFileNoFollow,
  writeDurableFile,
  exclusiveCreateTemp,
  atomicRename,
  exclusiveHardLinkPublish,
  syncDirectory,
  pinnedIdentityRecheck,
} from "./safe-files.js";

export type {
  // ── Types ─────────────────────────────────────────────────────────────────
  FileIdentity,
} from "./safe-files.js";

// ── Socket-free lock protocol ──────────────────────────────────────────────

export {
  // ── Error class ──────────────────────────────────────────────────────────
  IndexLockError,

  // ── Acquisition / release ────────────────────────────────────────────────
  acquireIndexLock,
  releaseIndexLock,
  withIndexLock,

  // ── Ordered acquisition (repository then worktree) ───────────────────────
  acquireOrderedIndexLocks,
  withOrderedIndexLocks,

  // ── Inspection and repair ────────────────────────────────────────────────
  inspectIndexLock,
  repairIndexLock,

  // ── Validation ───────────────────────────────────────────────────────────
  validateLockDirectoryPath,
} from "./lock.js";

export type {
  IndexLockScopeKind,
  IndexLockOwner,
  AcquireIndexLockOptions,
  IndexLockErrorCode,
  IndexLockInspectResult,
  RepairIndexLockOptions,
  RepairIndexLockResult,
} from "./lock.js";

// ── Git source observation ────────────────────────────────────────────────────

export { observeGitSourceState } from "./git-observer.js";

export type {
  PinnedMetadata,
  StageEntry,
  PathAttributes,
  GitMaterializationConfig,
  FilterConfigEntry,
  PorcelainEntry,
  InventoryEntry,
  SourceStatePayload,
  GitObservationResult,
} from "./git-observer.js";

// ── Non-Git source observation ─────────────────────────────────────────────────

export {
  observeDirectory,
  areSourceStatesEqual,
  computeDirectorySourceKey,
  isPathIgnored,
} from "./directory-observer.js";

export type {
  DirectoryFileMetadata,
  DirectorySourceState,
  ObserveDirectoryOptions,
} from "./directory-observer.js";

// ── Change planning ──────────────────────────────────────────────────────────

export {
  // ── Plan builder ─────────────────────────────────────────────────────────
  buildChangePlan,

  // ── Plan inspection ──────────────────────────────────────────────────────
  isChangePlanEmpty,
  getComputeEntries,
  getDeleteEntries,
  getRetargetEntries,
  getReuseEntries,
} from "./change-plan.js";

export type {
  // ── Source state types ────────────────────────────────────────────────────
  PinnedFileMetadata,
  SourceStateEntry,
  RepositoryIdentity,
  SourceState,

  // ── Change plan types ────────────────────────────────────────────────────
  ChangeDecision,
  ChangePlanEntry,
  ChangeClassification,
  ChangePlan,
  ChangePlanOptions,
} from "./change-plan.js";

// ── Coverage aggregation ─────────────────────────────────────────────────────

export {
  aggregateCoverage,
  parserAbsentSummary,
  singleFileSummary,
  mergeCoverageSummaries,
  countOutcomes,
  coverageDegradationReason,
} from "./coverage.js";

export type {
  FileCoverageOutcome,
  CoverageOutcomeCounts,
} from "./coverage.js";

// ── ast-grep process adapter ─────────────────────────────────────────────────

export { AstGrepAdapter } from "./ast-grep-adapter.js";

export type {
  AstGrepRange,
  AstGrepSymbol,
  AstGrepFileResult,
  AstGrepExtractionResult,
  AstGrepAdapterOptions,
} from "./ast-grep-adapter.js";

// ── Path-independent file fact extraction ────────────────────────────────────

export {
  // ── Constants ─────────────────────────────────────────────────────────────
  EXTRACTION_RULE_SCHEMA_VERSION,
  MAX_INDEX_FILE_SIZE_BYTES,
  MAX_SYMBOLS_PER_FILE,
  MAX_REFERENCES_PER_FILE,
  MAX_SIGNATURE_SIZE_BYTES,
  MAX_PARSER_OUTPUT_BYTES,
  MAX_PARSER_BATCH_SIZE,
  SYMBOL_SCHEMA_VERSION,

  // ── Language mapping ──────────────────────────────────────────────────────
  languageForExtension,
  languageForFile,

  // ── Fingerprint derivation ────────────────────────────────────────────────
  computeLanguageExtractorFingerprint,
  computeFileObjectId,
  computeSourceContentId,

  // ── Extraction entry points ───────────────────────────────────────────────
  extractFileFacts,
  extractLexical,
  extractInventoryOnly,

  // ── Aggregate coverage ────────────────────────────────────────────────────
  computeAggregateCoverage,
} from "./extract.js";

export type {
  // ── Language and mode ─────────────────────────────────────────────────────
  SupportedLanguage,
  ParserMode,

  // ── Extraction rules ──────────────────────────────────────────────────────
  ExtractionRule,
  LanguageRuleSet,

  // ── Extraction output ─────────────────────────────────────────────────────
  ExtractedDefinition,
  ExtractedReference,
  ExtractedImport,
  ExtractedParserError,
  ExtractedTruncationMarker,
  FileExtractionResult,

  // ── Batch extraction ──────────────────────────────────────────────────────
  BatchExtractionResult,

  // ── Ast-grep adapter types ────────────────────────────────────────────────
  AstGrepParseResult,
  AstGrepNode,
} from "./extract.js";

// ── Immutable object publication and lookup ──────────────────────────────────

export {
  // ── ID derivation ─────────────────────────────────────────────────────────
  deriveFileObjectId,
  deriveBlobMapObjectId,

  // ── Publication ───────────────────────────────────────────────────────────
  publishObjects,
  publishFileObject,
  publishBlobMapEntry,
  publishSymbolShard,
  publishRelationShard,

  // ── Serialization ─────────────────────────────────────────────────────────
  serializeFileObject,
  serializeBlobMapEntry,
  serializeShard,

  // ── Path helpers ──────────────────────────────────────────────────────────
  fileObjectPublishPath,
  blobMapObjectPublishPath,
  symbolShardPublishPath,
  relationShardPublishPath,

  // ── Lookup ────────────────────────────────────────────────────────────────
  readStoredObject,
  verifyStoredObject,
  readFileObject,
  readBlobMapEntry,
} from "./object-store.js";

export type {
  ObjectDefinition,
  ObjectReference,
  ObjectImport,
  FileObject,
  BlobMapEntry,
  PublishObjectsOptions,
  PublishObjectResult,
  PublishBatchResult,
} from "./object-store.js";

// ── Snapshot identity, index-map, and run reports ────────────────────────────

export {
  // ── ID and run ID derivation ─────────────────────────────────────────────
  deriveSnapshotId,
  generateRunId,

  // ── Serialization ────────────────────────────────────────────────────────
  serializeIdentity,
  serializeIndexMap,
  serializeRunReport,

  // ── Publication ──────────────────────────────────────────────────────────
  publishSnapshot,
  writeRunReport,

  // ── Reading ──────────────────────────────────────────────────────────────
  readSnapshotIdentity,
  readIndexMap,
  readRunReport,

  // ── Listing ──────────────────────────────────────────────────────────────
  listSnapshotIds,
  listRunIds,

  // ── Verification ─────────────────────────────────────────────────────────
  verifySnapshotIdentity,
  verifyIndexMap,
} from "./snapshot-store.js";

export type {
  SnapshotPinnedMetadata,
  SnapshotInventoryEntry,
  GitIdentity,
  SnapshotToolState,
  SnapshotIdentity,
  IndexMap,
  RunReport,
  PublishSnapshotOptions,
  PublishSnapshotResult,
  WriteRunReportOptions,
} from "./snapshot-store.js";

// ── Import resolution and cross-file relationships ────────────────────────

export {
  // ── Resolution config ────────────────────────────────────────────────────
  deriveResolutionConfigFingerprint,

  // ── Symbol definition index ──────────────────────────────────────────────
  buildSymbolDefinitionIndex,

  // ── Import resolution ────────────────────────────────────────────────────
  resolveImportsForFile,
  resolveAllImports,

  // ── Reference classification ─────────────────────────────────────────────
  buildReferencesForFile,
  buildAllReferences,

  // ── Relationship shard construction ──────────────────────────────────────
  buildRelationshipShard,
  buildAllRelationshipShards,
  deriveRelationshipShardId,

  // ── Affected-set invalidation ────────────────────────────────────────────
  computeAffectedSet,

  // ── Full pipeline ────────────────────────────────────────────────────────
  buildAllRelationships,

  // ── Weights ──────────────────────────────────────────────────────────────
  WEIGHT_IMPORT,
  WEIGHT_UNIQUE_REF,
  WEIGHT_AMBIGUOUS_REF,
} from "./relationships.js";

export type {
  ResolutionConfig,
  PathInventoryEntry,
  ResolvedImport,
  RelationshipType,
  RelationshipRecord,
  RelationshipShard,
  AffectedReason,
  AffectedEntry,
  AffectedSet,
  AffectedSetInput,
  SymbolDefinitionIndex,
  BuildRelationshipsInput,
  BuildRelationshipsResult,
} from "./relationships.js";

// ── Garbage collection ─────────────────────────────────────────────────────

export {
  garbageCollect,
} from "./gc.js";

export type {
  CurrentPointer,
  GarbageCollectOptions,
  GarbageCollectResult,
} from "./gc.js";

// ── Evidence rendering (v2 query results) ─────────────────────────────────────

export {
  taskSymbolCandidates,
  exactSymbolFilesFromQuery,
  buildLocalCodeIndexEvidence,
  formatRelatedFileScores,
} from "./evidence.js";

// ── Runtime service (Phase 6 implementation in service.ts) ───────────────────

export { ensureLocalCodeIndex, localCodeIndexStatus } from "./service.js";

// ── Query engine (Phase 7) ────────────────────────────────────────────────────

export { queryLocalCodeIndex } from "./query.js";
