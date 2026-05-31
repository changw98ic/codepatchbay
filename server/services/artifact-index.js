import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readEvents } from "./event-store.js";

const SCHEMA_VERSION = 2;
const KNOWN_KINDS = new Set(["plan", "deliverable", "review", "verdict", "diff", "tests", "risk", "pr", "context-pack"]);

function wikiProjectDir(cpbRoot, project, wikiDir) {
  if (wikiDir) return path.resolve(wikiDir);
  return path.join(path.resolve(cpbRoot), "wiki", "projects", project);
}

function inboxDir(cpbRoot, project, wikiDir) {
  return path.join(wikiProjectDir(cpbRoot, project, wikiDir), "inbox");
}

function outputsDir(cpbRoot, project, wikiDir) {
  return path.join(wikiProjectDir(cpbRoot, project, wikiDir), "outputs");
}

function basename(value) {
  return path.basename(String(value || ""));
}

function withoutKnownExtension(fileName) {
  return fileName.replace(/\.(?:md|patch|diff|txt|json)$/i, "");
}

function inferKind(event, artifact) {
  if (KNOWN_KINDS.has(event.kind)) return event.kind;
  if (KNOWN_KINDS.has(event.artifactKind)) return event.artifactKind;
  if (event.type === "pr_opened" || event.prUrl || event.pullRequestUrl) return "pr";

  const name = basename(artifact);
  if (/^plan-/i.test(name)) return "plan";
  if (/^deliverable-/i.test(name)) return "deliverable";
  if (/^review-/i.test(name)) return "review";
  if (/^verdict-/i.test(name)) return "verdict";
  if (/^diff-/i.test(name) || /\.(?:patch|diff)$/i.test(name)) return "diff";
  if (/^tests-/i.test(name)) return "tests";
  if (/^risk-/i.test(name)) return "risk";
  if (/^pr-/i.test(name)) return "pr";
  if (/^context-pack-/i.test(name)) return "context-pack";

  if (event.phase === "plan") return "plan";
  if (event.phase === "execute") return "deliverable";
  if (event.phase === "review") return "review";
  if (event.phase === "verify") return "verdict";
  return "deliverable";
}

function artifactIdFor(artifact) {
  return withoutKnownExtension(basename(artifact));
}

function contextPackDir(cpbRoot, project, wikiDir) {
  return path.join(wikiProjectDir(cpbRoot, project, wikiDir), "context-packs");
}

function resolveArtifactPath(cpbRoot, project, kind, artifact, wikiDir) {
  if (path.isAbsolute(artifact)) return artifact;
  if (kind === "plan") return path.join(inboxDir(cpbRoot, project, wikiDir), artifact);
  if (kind === "context-pack") return path.join(contextPackDir(cpbRoot, project, wikiDir), artifact);
  return path.join(outputsDir(cpbRoot, project, wikiDir), artifact);
}

async function inspectArtifact(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return { exists: false, broken: true, sha256: null, reason: "artifact path is not a file" };
    }
    const content = await readFile(filePath);
    return {
      exists: true,
      broken: false,
      sha256: createHash("sha256").update(content).digest("hex"),
      reason: null,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, broken: true, sha256: null, reason: "artifact file missing" };
    }
    return { exists: false, broken: true, sha256: null, reason: error.message || "artifact unreadable" };
  }
}

function artifactEvents(events) {
  return events.filter((event) => {
    return event && typeof event === "object" && typeof event.artifact === "string" && event.artifact.length > 0;
  });
}

export async function buildArtifactIndex(cpbRoot, project, jobId, { events, dataRoot, wikiDir } = {}) {
  const sourceEvents = events || await readEvents(cpbRoot, project, jobId, { dataRoot });
  const entries = [];
  const seen = new Set();

  for (const event of artifactEvents(sourceEvents)) {
    const kind = inferKind(event, event.artifact);
    const artifactPath = resolveArtifactPath(cpbRoot, project, kind, event.artifact, wikiDir);
    const key = `${kind}:${event.phase || ""}:${artifactPath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const inspected = await inspectArtifact(artifactPath);
    entries.push({
      id: artifactIdFor(event.artifact),
      kind,
      phase: event.phase || null,
      path: artifactPath,
      sha256: inspected.sha256,
      createdAt: event.ts || null,
      producerAgent: event.agent || event.producerAgent || event.executor || null,
      exists: inspected.exists,
      broken: inspected.broken,
      reason: inspected.reason,
      eventType: event.type || null,
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    project,
    jobId,
    generatedAt: new Date().toISOString(),
    entries,
    brokenReferences: entries.filter((entry) => entry.broken),
  };
}
