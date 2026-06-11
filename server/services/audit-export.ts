import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readEventsReadOnly } from "./event-store.js";
import { buildArtifactIndex } from "./artifact-index.js";
import { redactSecrets } from "./secret-policy.js";
import { parseVerdictEnvelope } from "../../core/workflow/verdict.js";

export async function buildJobAuditExport(cpbRoot: string, project: string, jobId: string, { dataRoot, wikiDir }: { dataRoot?: string; wikiDir?: string } = {}) {
  const events = await readEventsReadOnly(cpbRoot, project, jobId, { dataRoot });

  const artifactIndex = await (buildArtifactIndex as any)(cpbRoot, project, jobId, {
    events,
    dataRoot,
    wikiDir,
    restrictToWiki: true,
  });
  delete artifactIndex.generatedAt;
  artifactIndex.brokenReferences = artifactIndex.brokenReferences.map((e) => ({ ...e }));

  let verdict = null;
  const verdictEntry = [...artifactIndex.entries].reverse().find((e) => e.kind === "verdict" && !e.broken);
  if (verdictEntry) {
    try {
      const content = await readFile(verdictEntry.path, "utf8");
      verdict = parseVerdictEnvelope(content);
    } catch {
      verdict = null;
    }
  }

  let pr = null;
  const prEvent = [...events].reverse().find((e) => e.type === "pr_opened");
  if (prEvent) {
    pr = {
      url: prEvent.prUrl || prEvent.pullRequestUrl || prEvent.url || null,
      number: prEvent.prNumber || prEvent.number || null,
      artifact: prEvent.artifact || null,
      openedAt: prEvent.ts || null,
    };
  }

  return redactSecrets({ schemaVersion: 1, project, jobId, eventLog: events, artifactIndex, verdict, pr });
}

export async function writeJobAuditExport(outputDir: string, auditPackage: Record<string, any>) {
  const safe = redactSecrets(auditPackage);
  const slug = `${auditPackage.project}-${auditPackage.jobId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(outputDir, `${slug}-audit.json`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(safe, null, 2), "utf8");
  return filePath;
}
