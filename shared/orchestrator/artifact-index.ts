import type { LooseRecord } from "../types.js";

export type BrokerArtifactEntry = LooseRecord & {
  id?: string | null;
  kind: string;
  phase?: string | null;
  path?: string | null;
  sha256?: string | null;
  createdAt?: string | number | null;
  producerAgent?: string | null;
  exists?: boolean;
  broken?: boolean;
  reason?: string | null;
  eventType?: string | null;
  attemptId?: string | null;
  artifactKind?: string | null;
};

function nullableString(value: unknown): value is string | null | undefined {
  return value === undefined || typeof value === "string" || value === null;
}

function nullableTimestamp(value: unknown): value is string | number | null | undefined {
  return value === undefined
    || value === null
    || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)));
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

export function isBrokerArtifactEntry(value: unknown): value is BrokerArtifactEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as LooseRecord;
  return typeof entry.kind === "string" && entry.kind.length > 0
    && nullableString(entry.id)
    && nullableString(entry.phase)
    && nullableString(entry.path)
    && nullableString(entry.sha256)
    && nullableTimestamp(entry.createdAt)
    && nullableString(entry.producerAgent)
    && optionalBoolean(entry.exists)
    && optionalBoolean(entry.broken)
    && nullableString(entry.reason)
    && nullableString(entry.eventType)
    && nullableString(entry.attemptId)
    && nullableString(entry.artifactKind);
}

export type BrokerArtifactIndex = {
  schemaVersion?: number;
  entries?: BrokerArtifactEntry[];
  brokenReferences?: BrokerArtifactEntry[];
  [key: string]: unknown;
};

export function isBrokerArtifactIndex(value: unknown): value is BrokerArtifactIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const index = value as LooseRecord;
  if (index.entries !== undefined
    && (!Array.isArray(index.entries) || !index.entries.every(isBrokerArtifactEntry))) {
    return false;
  }
  if (index.brokenReferences !== undefined
    && (!Array.isArray(index.brokenReferences) || !index.brokenReferences.every(isBrokerArtifactEntry))) {
    return false;
  }
  return nullableTimestamp(index.generatedAt);
}

export function assertBrokerArtifactIndex(value: unknown, context = "artifact index"): BrokerArtifactIndex {
  if (!isBrokerArtifactIndex(value)) {
    throw Object.assign(new Error(`${context} violates the artifact index contract`), {
      code: "ARTIFACT_INDEX_CONTRACT_INVALID",
    });
  }
  return value;
}
