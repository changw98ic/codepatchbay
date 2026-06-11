// @ts-nocheck
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readEvents } from "./event-store.js";

const SCHEMA_VERSION = 1;
const KNOWN_KINDS = new Set(["plan", "deliverable", "review", "verdict", "prompt", "diff", "tests", "risk", "pr"]);

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
  if (/^prompt-/i.test(name)) return "prompt";
  if (/^diff-/i.test(name) || /\.(?:patch|diff)$/i.test(name)) return "diff";
  if (/^tests-/i.test(name)) return "tests";
  if (/^risk-/i.test(name)) return "risk";
  if (/^pr-/i.test(name)) return "pr";

  if (event.phase === "plan") return "plan";
  if (event.phase === "execute") return "deliverable";
  if (event.phase === "review") return "review";
  if (event.phase === "verify") return "verdict";
  return "deliverable";
}

function artifactIdFor(artifact) {
  return withoutKnownExtension(basename(artifact));
}

function hasKnownExtension(fileName) {
  return /\.(?:md|patch|diff|txt|json)$/i.test(fileName);
}

function isInside(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function candidateArtifactPaths(cpbRoot, project, kind, artifact, wikiDir) {
  if (path.isAbsolute(artifact)) {
    return hasKnownExtension(artifact) ? [artifact] : [artifact, `${artifact}.md`];
  }
  const dir = kind === "plan" ? inboxDir(cpbRoot, project, wikiDir) : outputsDir(cpbRoot, project, wikiDir);
  const direct = path.resolve(dir, artifact);
  return hasKnownExtension(artifact) ? [direct] : [direct, `${direct}.md`];
}

function blockedWikiReference(cpbRoot, project, kind, artifact, wikiDir, restrictToWiki) {
  if (!restrictToWiki) return null;
  const dir = kind === "plan" ? inboxDir(cpbRoot, project, wikiDir) : outputsDir(cpbRoot, project, wikiDir);
  if (path.isAbsolute(artifact)) {
    return {
      path: basename(artifact) || "artifact",
      reason: "artifact reference outside project wiki",
    };
  }
  const candidates = candidateArtifactPaths(cpbRoot, project, kind, artifact, wikiDir);
  if (candidates.some((candidate) => !isInside(dir, candidate))) {
    return {
      path: basename(artifact) || "artifact",
      reason: "artifact reference outside project wiki",
    };
  }
  return null;
}

async function resolveArtifactPath(cpbRoot, project, kind, artifact, wikiDir) {
  const candidates = candidateArtifactPaths(cpbRoot, project, kind, artifact, wikiDir);
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {}
  }
  return candidates[0];
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

function artifactReferences(events) {
  const refs = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (typeof event.artifact === "string" && event.artifact.length > 0) {
      refs.push({ event, artifact: event.artifact, kind: inferKind(event, event.artifact) });
    }
    if (typeof event.promptArtifact === "string" && event.promptArtifact.length > 0) {
      refs.push({ event, artifact: event.promptArtifact, kind: "prompt" });
    }
  }
  return refs;
}

export async function buildArtifactIndex(cpbRoot, project, jobId, { events, dataRoot, wikiDir, restrictToWiki = false } = {}) {
  const sourceEvents = events || await readEvents(cpbRoot, project, jobId, { dataRoot });
  const entries = [];
  const seen = new Set();

  for (const ref of artifactReferences(sourceEvents)) {
    const { event, artifact, kind } = ref;
    const blocked = blockedWikiReference(cpbRoot, project, kind, artifact, wikiDir, restrictToWiki);
    if (blocked) {
      const key = `${kind}:${event.phase || ""}:${blocked.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: artifactIdFor(artifact),
        kind,
        phase: event.phase || null,
        path: blocked.path,
        sha256: null,
        createdAt: event.ts || null,
        producerAgent: event.agent || event.producerAgent || event.executor || null,
        exists: false,
        broken: true,
        reason: blocked.reason,
        eventType: event.type || null,
      });
      continue;
    }

    const artifactPath = await resolveArtifactPath(cpbRoot, project, kind, artifact, wikiDir);
    const key = `${kind}:${event.phase || ""}:${artifactPath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const inspected = await inspectArtifact(artifactPath);
    entries.push({
      id: artifactIdFor(artifact),
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
