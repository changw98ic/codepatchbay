import { readFile } from "node:fs/promises";
import { parseVerdictEnvelope } from "../../core/workflow/verdict.js";
import { buildArtifactIndex } from "./artifact-index.js";

function warningForBrokenArtifact(entry: Record<string, any>) {
  const name = entry.path ? entry.path.split(/[\\/]/).pop() : entry.id || entry.kind || "artifact";
  return {
    kind: entry.kind || "artifact",
    id: entry.id || null,
    path: entry.path || null,
    message: `Artifact ${name} is ${entry.reason || "unavailable"}.`,
  };
}

async function parseVerdictEntry(entry: Record<string, any> | null | undefined) {
  if (!entry || entry.broken || !entry.path) return null;
  try {
    const envelope = parseVerdictEnvelope(await readFile(entry.path, "utf8"));
    return {
      status: envelope.status,
      confidence: envelope.confidence ?? null,
      reason: envelope.reason || null,
      blockingCount: Array.isArray(envelope.blocking) ? envelope.blocking.length : 0,
      fixScope: Array.isArray(envelope.fix_scope) ? envelope.fix_scope : [],
      path: entry.path,
      artifactId: entry.id,
      source: envelope.source || null,
    };
  } catch (err: any) {
    return {
      status: "inconclusive",
      confidence: null,
      reason: `verdict unreadable: ${err.message}`,
      blockingCount: 0,
      fixScope: [],
      path: entry.path,
      artifactId: entry.id,
      source: "error",
    };
  }
}

export async function buildJobArtifactDetail(cpbRoot: string, project: string, jobId: string, { dataRoot, wikiDir }: { dataRoot?: string; wikiDir?: string } = {}) {
  const artifactIndex = await (buildArtifactIndex as any)(cpbRoot, project, jobId, { dataRoot, wikiDir });
  const verdictEntry = [...artifactIndex.entries].reverse().find((entry) => entry.kind === "verdict");
  const verdict = await parseVerdictEntry(verdictEntry);
  const warnings = artifactIndex.entries
    .filter((entry) => entry.broken)
    .map(warningForBrokenArtifact);

  return {
    project,
    jobId,
    artifactIndex,
    verdict,
    warnings,
  };
}
