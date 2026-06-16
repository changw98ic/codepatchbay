import { readFile } from "node:fs/promises";
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
export async function readActiveChecklistArtifacts({ artifactIndex, attemptId, requiredKinds = ["acceptance-checklist"], }) {
    const entries = artifactIndex?.entries || [];
    const result = {};
    for (const kind of requiredKinds) {
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
                reason: `artifact ${kind} is marked broken: ${brokenEntries.map((e) => e.reason || e.id || "unknown").join(", ")}`,
                kind,
            };
        }
        // Detect entries that are indexed but not present on disk — also fail-closed.
        const missingEntries = byKind.filter((entry) => !entry.exists || !entry.path);
        if (missingEntries.length > 0 && missingEntries.length === byKind.length) {
            return {
                ok: false,
                outcome: "artifact_invalid",
                reason: `required artifact ${kind} is indexed but not present on disk: ${missingEntries.map((e) => e.id || e.path || "unknown").join(", ")}`,
                kind,
            };
        }
        // Readable candidates: exists + has a path + not broken.
        const candidates = byKind.filter((entry) => entry.exists && entry.path);
        // Sort candidates newest-first so duplicate artifacts within the same
        // scope (same attempt, or single-attempt jobs) always resolve to the
        // latest one. Stable for equal/missing createdAt.
        const sortedCandidates = [...candidates].sort((a, b) => {
            const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
            const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
            if (ta !== tb)
                return tb - ta; // descending
            return 0;
        });
        // For multi-attempt jobs, match attemptId strictly — fail-closed on ambiguity.
        let selected;
        if (attemptId) {
            const matched = sortedCandidates.find((entry) => entry.attemptId === attemptId);
            if (!matched) {
                // attempt ownership ambiguous: artifact exists but doesn't match the active attempt
                return {
                    ok: false,
                    outcome: "artifact_invalid",
                    reason: `artifact ${kind} has no entry matching attemptId=${attemptId}; candidates have attemptIds: [${sortedCandidates.map((e) => e.attemptId || "null").join(", ")}]`,
                    kind,
                };
            }
            selected = matched;
        }
        else {
            // Single-attempt job: take the latest readable artifact (newest-first).
            selected = sortedCandidates[0];
        }
        let content;
        try {
            content = await readFile(selected.path, "utf8");
        }
        catch (err) {
            return {
                ok: false,
                outcome: "artifact_invalid",
                reason: `artifact ${kind} exists in index but is unreadable: ${err instanceof Error ? err.message : String(err)}`,
                kind,
            };
        }
        try {
            result[kind] = JSON.parse(content);
        }
        catch (err) {
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
export async function readChecklistArtifactHistory({ artifactIndex, }) {
    const entries = artifactIndex?.entries || [];
    const history = {};
    for (const entry of entries) {
        if (!entry)
            continue;
        const kind = entry.kind;
        if (!history[kind])
            history[kind] = [];
        history[kind].push({
            kind,
            name: entry.id || null,
            attemptId: entry.attemptId || null,
            phase: entry.phase || null,
            exists: entry.exists,
            broken: entry.broken,
            reason: entry.reason || null,
            sha256: entry.sha256 || null,
            path: entry.path || null,
            createdAt: entry.createdAt || null,
        });
    }
    return history;
}
