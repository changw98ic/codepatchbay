import { readFile } from "node:fs/promises";
import {
  isRecord,
  recordValue,
  text,
} from "./checklist-shared.js";
import type { LooseRecord } from "../contracts/types.js";

type ArtifactEntry = LooseRecord & {
  kind?: unknown;
  id?: unknown;
  attemptId?: unknown;
  phase?: unknown;
  exists?: unknown;
  broken?: unknown;
  reason?: unknown;
  sha256?: unknown;
  path?: unknown;
  createdAt?: unknown;
};

type ArtifactIndexInput = {
  artifactIndex?: unknown;
  attemptId?: unknown;
  requiredKinds?: unknown;
};

function artifactEntries(artifactIndex: unknown): ArtifactEntry[] {
  const entries = recordValue(artifactIndex).entries;
  return Array.isArray(entries) ? entries.filter(isRecord) : [];
}

function artifactKinds(requiredKinds: unknown): string[] {
  if (!Array.isArray(requiredKinds)) return ["acceptance-checklist"];
  const kinds = requiredKinds.map((kind) => text(kind)).filter(Boolean);
  return kinds.length > 0 ? kinds : ["acceptance-checklist"];
}

function display(value: unknown, fallback = "unknown") {
  return text(value) || fallback;
}

function nullableText(value: unknown) {
  return text(value) || null;
}

function artifactTimestamp(entry: ArtifactEntry) {
  const value = entry.createdAt;
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasReadablePath(entry: ArtifactEntry): entry is ArtifactEntry & { path: string } {
  return Boolean(entry.exists) && typeof entry.path === "string" && entry.path.length > 0;
}

/**
 * Read active checklist artifacts for the current attempt from the event-indexed
 * artifact store. This is the authoritative source for checklist authority --
 * sourceContext and phase diagnostics are transport hints, not completion facts.
 *
 * For V1, reads the latest artifact of each required kind whose attemptId
 * matches the active attempt (or is null/missing in a single-attempt job).
 *
 * FAIL-CLOSED: if any required artifact is broken, unreadable, or has
 * ambiguous attempt ownership, the function returns `{ ok: false, reason, ... }`
 * instead of silently skipping. The caller must treat this as artifact_invalid.
 *
 * IMPORTANT: The caller must pass `artifactIndex` (built by the server-layer
 * `buildArtifactIndex` function). This module lives in core/ and must NOT
 * import from server/.
 */
export async function readActiveChecklistArtifacts({
  artifactIndex,
  attemptId,
  requiredKinds = ["acceptance-checklist"],
}: ArtifactIndexInput) {
  const entries = artifactEntries(artifactIndex);
  const activeAttemptId = text(attemptId);
  const result: LooseRecord = {};

  for (const kind of artifactKinds(requiredKinds)) {
    // Collect ALL entries for this kind FIRST — do not filter on exists/path
    // before the broken/missing checks, or a required artifact that is broken
    // or absent gets silently dropped and the gate fails OPEN.
    const byKind = entries.filter((entry) => entry.kind === kind);

    // Detect broken entries — fail-closed rather than silently skipping.
    const brokenEntries = byKind.filter((entry) => entry.broken);
    if (brokenEntries.length > 0) {
      return {
        ok: false,
        outcome: "artifact_invalid",
        reason: `artifact ${kind} is marked broken: ${brokenEntries.map((entry) => display(entry.reason || entry.id)).join(", ")}`,
        kind,
      };
    }

    // Detect entries that are indexed but not present on disk — also fail-closed.
    const missingEntries = byKind.filter((entry) => !hasReadablePath(entry));
    if (missingEntries.length > 0 && missingEntries.length === byKind.length) {
      return {
        ok: false,
        outcome: "artifact_invalid",
        reason: `required artifact ${kind} is indexed but not present on disk: ${missingEntries.map((entry) => display(entry.id || entry.path)).join(", ")}`,
        kind,
      };
    }

    // Readable candidates: exists + has a path + not broken.
    const candidates = byKind.filter(hasReadablePath);

    // Sort candidates newest-first so duplicate artifacts within the same
    // scope (same attempt, or single-attempt jobs) always resolve to the
    // latest one. Event/index order is the authoritative tie-breaker because
    // multiple repair-loop artifacts can be emitted within the same
    // millisecond and therefore have identical createdAt values.
    const entryPosition = new Map(entries.map((entry, index) => [entry, index]));
    const sortedCandidates = [...candidates].sort((a, b) => {
      const ta = artifactTimestamp(a);
      const tb = artifactTimestamp(b);
      if (ta !== tb) return tb - ta; // descending
      return (entryPosition.get(b) ?? -1) - (entryPosition.get(a) ?? -1);
    });

    // For multi-attempt jobs, match attemptId strictly — fail-closed on ambiguity.
    let selected: (ArtifactEntry & { path: string }) | undefined;
    if (activeAttemptId) {
      const matched = sortedCandidates.find((entry) => entry.attemptId === activeAttemptId);
      if (!matched) {
        // attempt ownership ambiguous: artifact exists but doesn't match the active attempt
        return {
          ok: false,
          outcome: "artifact_invalid",
          reason: `artifact ${kind} has no entry matching attemptId=${activeAttemptId}; candidates have attemptIds: [${sortedCandidates.map((entry) => display(entry.attemptId, "null")).join(", ")}]`,
          kind,
        };
      }
      selected = matched;
    } else {
      // Single-attempt job: take the latest readable artifact (newest-first).
      selected = sortedCandidates[0];
    }

    let content;
    try {
      content = await readFile(selected.path, "utf8");
    } catch (err) {
      return {
        ok: false,
        outcome: "artifact_invalid",
        reason: `artifact ${kind} exists in index but is unreadable: ${err instanceof Error ? err.message : String(err)}`,
        kind,
      };
    }

    try {
      result[kind] = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        outcome: "artifact_invalid",
        reason: `artifact ${kind} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        kind,
      };
    }
  }

  return { ok: true, ...result };
}

export async function readChecklistArtifactHistory({
  artifactIndex,
}: {
  artifactIndex?: unknown;
}) {
  const entries = artifactEntries(artifactIndex);

  const history: LooseRecord = {};
  for (const entry of entries) {
    const kind = display(entry.kind, "unknown");
    if (!history[kind]) history[kind] = [];
    const kindHistory = Array.isArray(history[kind]) ? history[kind] : [];
    kindHistory.push({
      kind,
      name: nullableText(entry.id),
      attemptId: nullableText(entry.attemptId),
      phase: nullableText(entry.phase),
      exists: entry.exists,
      broken: entry.broken,
      reason: nullableText(entry.reason),
      sha256: nullableText(entry.sha256),
      path: nullableText(entry.path),
      createdAt: nullableText(entry.createdAt),
    });
    history[kind] = kindHistory;
  }

  return history;
}
