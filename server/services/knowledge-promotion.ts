import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertKnowledgeWriteAllowed,
  classifyKnowledgeKind,
  resolveKnowledgePath,
} from "./knowledge-policy.js";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
type AnyRecord = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function slugify(value: any, fallback = "candidate") {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return SAFE_SEGMENT.test(slug) ? slug : fallback;
}

function assertSafeSessionId(sessionId: string) {
  if (!SAFE_SEGMENT.test(sessionId)) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
}

function resolvePromotionDataRoot({ projectRuntimeRoot, dataRoot }: AnyRecord = {}) {
  const root = projectRuntimeRoot || dataRoot;
  if (!root || !String(root).trim()) {
    throw new Error("projectRuntimeRoot or dataRoot is required");
  }
  return path.resolve(String(root));
}

function candidateDir(dataRoot: string, sessionId: string) {
  assertSafeSessionId(sessionId);
  return path.join(path.resolve(dataRoot), "sessions", sessionId, "promotion-candidates");
}

export function promotionCandidatePath(dataRoot: string, sessionId: string, candidateId: string) {
  if (!SAFE_SEGMENT.test(candidateId)) {
    throw new Error(`invalid candidateId: ${candidateId}`);
  }
  return path.join(candidateDir(dataRoot, sessionId), `${candidateId}.md`);
}

function renderCandidate({ title, content, sourceLinks = [] }: AnyRecord) {
  const lines = [`# ${title}`, "", String(content || "").trim(), ""];
  if (sourceLinks.length > 0) {
    lines.push("## Sources", ...sourceLinks.map((link) => `- ${link}`), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

export async function writePromotionCandidate({
  sourcePath,
  projectRuntimeRoot,
  dataRoot,
  sessionId,
  title = "Promotion Candidate",
  content,
  sourceLinks = [],
}: AnyRecord = {}) {
  if (!sourcePath) throw new Error("sourcePath is required");
  if (!sessionId) throw new Error("sessionId is required");
  if (!content || !String(content).trim()) throw new Error("content is required");
  const resolvedDataRoot = resolvePromotionDataRoot({ projectRuntimeRoot, dataRoot });
  assertKnowledgeWriteAllowed("session-memory", { automatic: true, markdown: true });

  const candidateId = slugify(title);
  const filePath = promotionCandidatePath(resolvedDataRoot, sessionId, candidateId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderCandidate({ title, content, sourceLinks }), "utf8");
  return {
    candidateId,
    filePath,
    sourcePath: path.resolve(sourcePath),
    dataRoot: resolvedDataRoot,
    sessionId,
    createdAt: nowIso(),
  };
}

async function readCandidateContent(dataRoot: string, sessionId: string, candidateId: string) {
  return await readFile(promotionCandidatePath(dataRoot, sessionId, candidateId), "utf8");
}

function renderPromotion({ title, content, sourceLinks = [] }: AnyRecord) {
  const lines = [`## ${title}`, "", String(content || "").trim(), "", `Promoted: ${nowIso()}`];
  if (sourceLinks.length > 0) {
    lines.push("", "Sources:", ...sourceLinks.map((link) => `- ${link}`));
  }
  return `${lines.join("\n").trim()}\n\n`;
}

async function appendPromotionRecord(dataRoot: string, sessionId: string, record: AnyRecord) {
  assertSafeSessionId(sessionId);
  const filePath = path.join(path.resolve(dataRoot), "sessions", sessionId, "promotions.jsonl");
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export async function promoteKnowledge({
  hubRoot,
  sourcePath,
  projectRuntimeRoot,
  dataRoot,
  sessionId,
  candidateId,
  targetKind = "project-memory",
  title,
  name,
  content,
  sourceLinks = [],
  approved = false,
}: AnyRecord = {}) {
  if (!approved) {
    throw new Error("knowledge promotion requires explicit approval");
  }
  if (!sourcePath) throw new Error("sourcePath is required");
  if (!sessionId) throw new Error("sessionId is required");
  assertSafeSessionId(sessionId);
  const resolvedDataRoot = resolvePromotionDataRoot({ projectRuntimeRoot, dataRoot });

  const classification = classifyKnowledgeKind(targetKind);
  if (classification === "machine-state") {
    throw new Error(`${targetKind} cannot be promoted into markdown knowledge`);
  }
  assertKnowledgeWriteAllowed(targetKind, { automatic: false, markdown: true });

  const body = content || await readCandidateContent(resolvedDataRoot, sessionId, candidateId);
  const promotionTitle = title || name || candidateId || "Promoted Knowledge";
  const targetPath = resolveKnowledgePath({
    hubRoot,
    sourcePath,
    kind: targetKind,
    sessionId,
    name: slugify(name || title || candidateId || targetKind, targetKind),
  });
  await mkdir(path.dirname(targetPath), { recursive: true });

  const rendered = renderPromotion({
    title: promotionTitle,
    content: body,
    sourceLinks: sourceLinks.length > 0 ? sourceLinks : candidateId ? [promotionCandidatePath(resolvedDataRoot, sessionId, candidateId)] : [],
  });
  if (targetKind === "project-memory") {
    await appendFile(targetPath, rendered, "utf8");
  } else {
    await writeFile(targetPath, rendered, "utf8");
  }

  const record = {
    promotedAt: nowIso(),
    targetKind,
    targetPath,
    candidateId: candidateId || null,
    title: promotionTitle,
  };
  await appendPromotionRecord(resolvedDataRoot, sessionId, record);
  return record;
}
