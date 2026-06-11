import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";

// ── knowledge-policy ──────────────────────────────────────────────────

export const PROMPT_COMPOSITION_ORDER = Object.freeze([
  "global-soul-profile",
  "global-provider-runtime-policy",
  "project-context",
  "project-wiki-excerpts",
  "project-memory",
  "session-memory",
  "current-task",
]);

const RUNTIME_STATE_KINDS = new Set([
  "registry",
  "state",
  "queue",
  "lease",
  "rate-limit",
  "worker-heartbeat",
  "provider-state",
]);

const GLOBAL_CONFIRM_KINDS = new Set([
  "global-memory",
  "global-profile",
  "global-soul",
]);

export function classifyKnowledgeKind(kind) {
  if (RUNTIME_STATE_KINDS.has(kind)) return "machine-state";
  if (kind === "session" || kind === "session-memory" || kind === "session-log") return "session";
  if (kind === "project-memory") return "project-memory";
  if (kind === "wiki" || kind === "adr" || kind === "runbook" || kind === "incident") return "wiki";
  if (GLOBAL_CONFIRM_KINDS.has(kind)) return "global-knowledge";
  return "unknown";
}

export function assertKnowledgeWriteAllowed(kind, { automatic = false, markdown = true } = {}) {
  const classification = classifyKnowledgeKind(kind);
  if (markdown && classification === "machine-state") {
    throw new Error(`${kind} is runtime state and must not be written to markdown knowledge files`);
  }
  if (automatic && classification === "global-knowledge") {
    throw new Error(`${kind} requires explicit confirmation before automatic writes`);
  }
  return { kind, classification, automatic, markdown };
}

export function resolveKnowledgePath({ hubRoot, sourcePath, kind, sessionId = "session", name = "note" }) {
  const classification = classifyKnowledgeKind(kind);
  if (classification === "machine-state") {
    throw new Error(`${kind} must use runtime state storage, not knowledge paths`);
  }
  if (classification === "global-knowledge") {
    const file = kind === "global-soul" ? "soul.md" : kind === "global-profile" ? "profile.md" : "memory.md";
    return path.join(path.resolve(hubRoot), "profiles", name, file);
  }
  if (classification === "session") {
    return path.join(path.resolve(sourcePath), "cpb-task", "sessions", sessionId, `${name}.md`);
  }
  if (classification === "project-memory") {
    return path.join(path.resolve(sourcePath), ".cpb", "memory.md");
  }
  if (kind === "adr") {
    return path.join(path.resolve(sourcePath), ".cpb", "wiki", "decisions", `${name}.md`);
  }
  if (kind === "incident") {
    return path.join(path.resolve(sourcePath), ".cpb", "wiki", "incidents", `${name}.md`);
  }
  if (kind === "runbook") {
    return path.join(path.resolve(sourcePath), ".cpb", "wiki", "runbooks", `${name}.md`);
  }
  return path.join(path.resolve(sourcePath), ".cpb", "wiki", `${name}.md`);
}

export function knowledgePolicySummary() {
  return {
    promptCompositionOrder: [...PROMPT_COMPOSITION_ORDER],
    automaticWrites: ["session", "session-memory", "session-log"],
    semiAutomaticWrites: ["project-memory", "incident", "adr"],
    explicitConfirmationWrites: [...GLOBAL_CONFIRM_KINDS],
    forbiddenMarkdownState: [...RUNTIME_STATE_KINDS],
  };
}

export async function scanKnowledgeContamination(sourcePath, { fs: fsMod }: Record<string, any> = {}) {
  const realFs = fsMod || await import("node:fs/promises");
  const src = path.resolve(sourcePath);
  const issues = [];
  const wikiRoot = path.join(src, ".cpb", "wiki");
  const memoryFile = path.join(src, ".cpb", "memory.md");

  const machineStatePatterns = [
    /"leaseId"/, /"rateLimit"/, /"heartbeat"/, /"workerId"/,
    /"dispatchState"/, /"backlogEntry"/, /"eventLog"/,
  ];

  async function scanDir(dir, relBase) {
    let entries;
    try { entries = await realFs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.join(relBase, entry.name);
      if (entry.isDirectory()) {
        await scanDir(full, rel);
      } else if (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")) {
        issues.push({ path: rel, reason: "non-markdown state file in wiki directory" });
      }
    }
  }

  await scanDir(wikiRoot, ".cpb/wiki");

  try {
    const content = await realFs.readFile(memoryFile, "utf8");
    for (const pattern of machineStatePatterns) {
      if (pattern.test(content)) {
        issues.push({ path: ".cpb/memory.md", reason: `machine-state pattern ${pattern} found in project memory` });
        break;
      }
    }
  } catch {}

  return issues;
}

export async function findPromotionCandidates(sourcePath, { sessionId = null, fs = null } = {}) {
  const realFs = fs || await import("node:fs/promises");
  const src = path.resolve(sourcePath);
  const candidates = [];

  const sessionBase = sessionId
    ? path.join(src, "cpb-task", "sessions", sessionId)
    : null;

  if (sessionBase) {
    const memFile = path.join(sessionBase, "memory.md");
    try {
      const content = await realFs.readFile(memFile, "utf8");
      if (content.trim().length > 0) {
        candidates.push({
          from: memFile,
          kind: "session-memory",
          targetKind: "project-memory",
          targetPath: path.join(src, ".cpb", "memory.md"),
          reason: "session memory contains insights promotable to project memory",
          size: content.length,
        });
      }
    } catch {}
  }

  const sessionsDir = path.join(src, "cpb-task", "sessions");
  try {
    const entries = await realFs.readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (sessionId && entry.name === sessionId) continue;
      const memFile = path.join(sessionsDir, entry.name, "memory.md");
      try {
        const content = await realFs.readFile(memFile, "utf8");
        if (content.trim().length > 0) {
          candidates.push({
            from: memFile,
            kind: "session-memory",
            targetKind: "project-memory",
            targetPath: path.join(src, ".cpb", "memory.md"),
            reason: `session ${entry.name} memory contains insights`,
            session: entry.name,
            size: content.length,
          });
        }
      } catch {}
    }
  } catch {}

  // Ensure no machine-state candidates
  return candidates.filter((c) => classifyKnowledgeKind(c.kind) !== "machine-state");
}

// ── knowledge-paths ───────────────────────────────────────────────────

const WIKI_SUBDIRS = ["decisions", "incidents", "features", "agents"];

function assertNoTraversal(raw: string) {
  if (typeof raw === "string" && raw.includes("..")) {
    throw new Error(`path traversal detected in: ${raw}`);
  }
}

export function projectWikiPath(sourcePath: string) {
  return path.join(path.resolve(sourcePath), ".cpb", "wiki");
}

export function projectMemoryPath(sourcePath: string) {
  return path.join(path.resolve(sourcePath), ".cpb", "memory.md");
}

export function sessionPath(sourcePath: string, sessionId: string) {
  return path.join(path.resolve(sourcePath), "cpb-task", "sessions", sessionId);
}

export async function initProjectWikiPaths(sourcePath: string) {
  assertNoTraversal(sourcePath);
  const wikiRoot = projectWikiPath(sourcePath);
  await fs.mkdir(wikiRoot, { recursive: true });
  for (const sub of WIKI_SUBDIRS) {
    await fs.mkdir(path.join(wikiRoot, sub), { recursive: true });
  }
}

export async function initSessionPaths(sourcePath: string, sessionId: string) {
  assertNoTraversal(sourcePath);
  assertNoTraversal(sessionId);
  if (sessionId.includes("/") || sessionId.includes(path.sep)) {
    throw new Error(`path traversal detected in sessionId: ${sessionId}`);
  }
  const sessDir = sessionPath(sourcePath, sessionId);
  await fs.mkdir(sessDir, { recursive: true });
}

export async function ensureKnowledgePaths(sourcePath: string, sessionId: string) {
  await initProjectWikiPaths(sourcePath);
  await initSessionPaths(sourcePath, sessionId);
}

// ── knowledge-promotion ───────────────────────────────────────────────

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
type AnyRecord = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function slugifyPromo(value: any, fallback = "candidate") {
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

function candidateDir(sourcePath: string, sessionId: string) {
  assertSafeSessionId(sessionId);
  return path.join(path.resolve(sourcePath), "cpb-task", "sessions", sessionId, "promotion-candidates");
}

export function promotionCandidatePath(sourcePath: string, sessionId: string, candidateId: string) {
  if (!SAFE_SEGMENT.test(candidateId)) {
    throw new Error(`invalid candidateId: ${candidateId}`);
  }
  return path.join(candidateDir(sourcePath, sessionId), `${candidateId}.md`);
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
  sessionId,
  title = "Promotion Candidate",
  content,
  sourceLinks = [],
}: AnyRecord = {}) {
  if (!sourcePath) throw new Error("sourcePath is required");
  if (!sessionId) throw new Error("sessionId is required");
  if (!content || !String(content).trim()) throw new Error("content is required");
  assertKnowledgeWriteAllowed("session-memory", { automatic: true, markdown: true });

  const candidateId = slugifyPromo(title);
  const filePath = promotionCandidatePath(sourcePath, sessionId, candidateId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderCandidate({ title, content, sourceLinks }), "utf8");
  return {
    candidateId,
    filePath,
    sourcePath: path.resolve(sourcePath),
    sessionId,
    createdAt: nowIso(),
  };
}

async function readCandidateContent(sourcePath: string, sessionId: string, candidateId: string) {
  return await readFile(promotionCandidatePath(sourcePath, sessionId, candidateId), "utf8");
}

function renderPromotion({ title, content, sourceLinks = [] }: AnyRecord) {
  const lines = [`## ${title}`, "", String(content || "").trim(), "", `Promoted: ${nowIso()}`];
  if (sourceLinks.length > 0) {
    lines.push("", "Sources:", ...sourceLinks.map((link) => `- ${link}`));
  }
  return `${lines.join("\n").trim()}\n\n`;
}

async function appendPromotionRecord(sourcePath: string, sessionId: string, record: AnyRecord) {
  const filePath = path.join(path.resolve(sourcePath), "cpb-task", "sessions", sessionId, "promotions.jsonl");
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export async function promoteKnowledge({
  hubRoot,
  sourcePath,
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

  const classification = classifyKnowledgeKind(targetKind);
  if (classification === "machine-state") {
    throw new Error(`${targetKind} cannot be promoted into markdown knowledge`);
  }
  assertKnowledgeWriteAllowed(targetKind, { automatic: false, markdown: true });

  const body = content || await readCandidateContent(sourcePath, sessionId, candidateId);
  const promotionTitle = title || name || candidateId || "Promoted Knowledge";
  const targetPath = resolveKnowledgePath({
    hubRoot,
    sourcePath,
    kind: targetKind,
    sessionId,
    name: slugifyPromo(name || title || candidateId || targetKind, targetKind),
  });
  await mkdir(path.dirname(targetPath), { recursive: true });

  const rendered = renderPromotion({
    title: promotionTitle,
    content: body,
    sourceLinks: sourceLinks.length > 0 ? sourceLinks : candidateId ? [promotionCandidatePath(sourcePath, sessionId, candidateId)] : [],
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
  await appendPromotionRecord(sourcePath, sessionId, record);
  return record;
}
