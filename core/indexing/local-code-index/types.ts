// core/indexing/local-code-index/types.ts — shared types for local code index v2

export type AuthoritySource = "explicit" | "tmp-private" | "tmp-shared";

export type PinnedIdentity = {
  dev: bigint;
  ino: bigint;
  canonicalPath: string;
};

export type StorageErrorCode =
  | "UNSAFE_TMP_OWNER"
  | "UNSAFE_TMP_MODE"
  | "UNSAFE_TMP_SYMLINK"
  | "UNSAFE_TMP_MISSING"
  | "STALE_TMP_GENERATION"
  | "UNSAFE_AUTHORITY_SYMLINK"
  | "UNSAFE_AUTHORITY_OWNER"
  | "UNSAFE_AUTHORITY_MODE"
  | "STALE_AUTHORITY_GENERATION"
  | "SOURCE_ABOVE_AUTHORITY"
  | "SOURCE_EQUAL_AUTHORITY"
  | "EXPLICIT_ROOT_MISSING"
  | "NO_SAFE_TMP"
  | "AUTHORITY_CREATE_FAILED"
  | "AMBIGUOUS_SOURCE"
  | "MISSING_SOURCE";

export type StorageOk = {
  ok: true;
  authority: string;
  source: AuthoritySource;
  pinned: PinnedIdentity;
};

export type StorageFail = {
  ok: false;
  reason: string;
  code: StorageErrorCode;
};

export type StorageResult = StorageOk | StorageFail;
