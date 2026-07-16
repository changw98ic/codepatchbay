import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import type { LooseRecord } from "../../../shared/types.js";

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

type KnowledgeFs = Pick<typeof fs, "readdir" | "readFile">;

type KnowledgePathOptions = {
  hubRoot?: string | null;
  sourcePath?: string;
  dataRoot?: string | null;
  projectRuntimeRoot?: string | null;
  kind?: string;
  sessionId?: string;
  name?: string;
};

type RuntimeRootOptions = {
  dataRoot?: string | null;
  projectRuntimeRoot?: string | null;
};

type WritePromotionCandidateOptions = RuntimeRootOptions & {
  sourcePath?: string;
  sessionId?: string;
  title?: string;
  content?: unknown;
  sourceLinks?: unknown;
};

type PromoteKnowledgeOptions = RuntimeRootOptions & {
  hubRoot?: string | null;
  sourcePath?: string;
  sessionId?: string;
  candidateId?: string;
  targetKind?: string;
  title?: string;
  name?: string;
  content?: unknown;
  sourceLinks?: unknown;
  approved?: boolean;
};

function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function fsLike(value: unknown): KnowledgeFs {
  if (isRecord(value) && typeof value.readdir === "function" && typeof value.readFile === "function") {
    return value as KnowledgeFs;
  }
  return fs;
}

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

export function classifyKnowledgeKind(kind: string) {
  if (RUNTIME_STATE_KINDS.has(kind)) return "machine-state";
  if (kind === "session" || kind === "session-memory" || kind === "session-log") return "session";
  if (kind === "project-memory") return "project-memory";
  if (kind === "wiki" || kind === "adr" || kind === "runbook" || kind === "incident") return "wiki";
  if (GLOBAL_CONFIRM_KINDS.has(kind)) return "global-knowledge";
  return "unknown";
}

export function assertKnowledgeWriteAllowed(kind: string, { automatic = false, markdown = true } = {}) {
  const classification = classifyKnowledgeKind(kind);
  if (markdown && classification === "machine-state") {
    throw new Error(`${kind} is runtime state and must not be written to markdown knowledge files`);
  }
  if (automatic && classification === "global-knowledge") {
    throw new Error(`${kind} requires explicit confirmation before automatic writes`);
  }
  return { kind, classification, automatic, markdown };
}

export function resolveKnowledgePath({ hubRoot = null, sourcePath, dataRoot = null, projectRuntimeRoot = null, kind = "", sessionId = "session", name = "note" }: KnowledgePathOptions) {
  const classification = classifyKnowledgeKind(kind);
  if (classification === "machine-state") {
    throw new Error(`${kind} must use runtime state storage, not knowledge paths`);
  }
  if (classification === "global-knowledge") {
    const file = kind === "global-soul" ? "soul.md" : kind === "global-profile" ? "profile.md" : "memory.md";
    if (!hubRoot) throw new Error("hubRoot is required for global knowledge paths");
    return path.join(path.resolve(hubRoot), "profiles", name, file);
  }
  if (classification === "session") {
    return path.join(sessionPath(stringValue(sourcePath), sessionId, { dataRoot, projectRuntimeRoot }), `${name}.md`);
  }
  if (classification === "project-memory") {
    return path.join(path.resolve(stringValue(sourcePath)), ".cpb", "memory.md");
  }
  if (kind === "adr") {
    return path.join(path.resolve(stringValue(sourcePath)), ".cpb", "wiki", "decisions", `${name}.md`);
  }
  if (kind === "incident") {
    return path.join(path.resolve(stringValue(sourcePath)), ".cpb", "wiki", "incidents", `${name}.md`);
  }
  if (kind === "runbook") {
    return path.join(path.resolve(stringValue(sourcePath)), ".cpb", "wiki", "runbooks", `${name}.md`);
  }
  return path.join(path.resolve(stringValue(sourcePath)), ".cpb", "wiki", `${name}.md`);
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

export async function scanKnowledgeContamination(sourcePath: string, { fs: fsMod }: LooseRecord = {}) {
  const realFs = fsLike(fsMod);
  const src = path.resolve(sourcePath);
  const issues: LooseRecord[] = [];
  const wikiRoot = path.join(src, ".cpb", "wiki");
  const memoryFile = path.join(src, ".cpb", "memory.md");

  const machineStatePatterns = [
    /"leaseId"/, /"rateLimit"/, /"heartbeat"/, /"workerId"/,
    /"dispatchState"/, /"backlogEntry"/, /"eventLog"/,
  ];

  async function scanDir(dir: string, relBase: string) {
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

export async function findPromotionCandidates(sourcePath: string, { sessionId = null, fs: fsMod = null, projectRuntimeRoot = null, dataRoot = null }: LooseRecord = {}) {
  const realFs = fsLike(fsMod);
  const src = path.resolve(sourcePath);
  const candidates: Array<LooseRecord & { kind: string }> = [];

  const resolvedSessionId = stringValue(sessionId);
  if (resolvedSessionId) assertValidSessionId(resolvedSessionId);
  const runtimeRoot = requireSessionRuntimeRoot({ dataRoot: stringValue(dataRoot) || null, projectRuntimeRoot: stringValue(projectRuntimeRoot) || null });
  const sessionsDir = path.join(runtimeRoot, "sessions");
  const seen = new Set<string>();

  async function maybeAddSession(sessionName: string) {
    assertValidSessionId(sessionName);
    if (seen.has(sessionName)) return;
    seen.add(sessionName);
    const sessionBase = path.join(sessionsDir, sessionName);
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

  if (resolvedSessionId) {
    await maybeAddSession(resolvedSessionId);
  }

  try {
    const entries = await realFs.readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await maybeAddSession(entry.name);
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

function assertValidSessionId(sessionId: string) {
  if (!sessionId || sessionId.includes("..") || sessionId.includes("/") || sessionId.includes(path.sep)) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
}

function requireSessionRuntimeRoot(options: RuntimeRootOptions = {}) {
  const runtimeRoot = options.dataRoot || options.projectRuntimeRoot;
  if (!runtimeRoot) {
    throw new Error("projectRuntimeRoot or dataRoot is required for session knowledge paths");
  }
  return path.resolve(runtimeRoot);
}

export function projectWikiPath(sourcePath: string) {
  return path.join(path.resolve(sourcePath), ".cpb", "wiki");
}

export function projectMemoryPath(sourcePath: string) {
  return path.join(path.resolve(sourcePath), ".cpb", "memory.md");
}

export function sessionPath(sourcePath: string, sessionId: string, options: LooseRecord = {}) {
  assertValidSessionId(sessionId);
  return path.join(requireSessionRuntimeRoot(options), "sessions", sessionId);
}

export async function initProjectWikiPaths(sourcePath: string, _sessionId?: string, _options: LooseRecord = {}) {
  assertNoTraversal(sourcePath);
  const wikiRoot = projectWikiPath(sourcePath);
  await fs.mkdir(wikiRoot, { recursive: true });
  for (const sub of WIKI_SUBDIRS) {
    await fs.mkdir(path.join(wikiRoot, sub), { recursive: true });
  }
}

export async function initSessionPaths(sourcePath: string, sessionId: string, options: LooseRecord = {}) {
  assertNoTraversal(sourcePath);
  assertValidSessionId(sessionId);
  const sessDir = sessionPath(sourcePath, sessionId, options);
  await fs.mkdir(sessDir, { recursive: true });
}

export async function ensureKnowledgePaths(sourcePath: string, sessionId: string, options: LooseRecord = {}) {
  assertValidSessionId(sessionId);
  await initProjectWikiPaths(sourcePath, sessionId, options);
  await initSessionPaths(sourcePath, sessionId, options);
}

// ── knowledge-promotion ───────────────────────────────────────────────

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function nowIso() {
  return new Date().toISOString();
}

function slugifyPromo(value: unknown, fallback = "candidate") {
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

function candidateDir(sourcePath: string, sessionId: string, options: LooseRecord = {}) {
  assertSafeSessionId(sessionId);
  return path.join(sessionPath(sourcePath, sessionId, options), "promotion-candidates");
}

export function promotionCandidatePath(sourcePath: string, sessionId: string, candidateId: string, options: LooseRecord = {}) {
  if (!SAFE_SEGMENT.test(candidateId)) {
    throw new Error(`invalid candidateId: ${candidateId}`);
  }
  return path.join(candidateDir(sourcePath, sessionId, options), `${candidateId}.md`);
}

function renderCandidate({ title, content, sourceLinks = [] }: LooseRecord) {
  const lines = [`# ${title}`, "", String(content || "").trim(), ""];
  const links = stringArray(sourceLinks);
  if (links.length > 0) {
    lines.push("## Sources", ...links.map((link) => `- ${link}`), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

export async function writePromotionCandidate({
  sourcePath,
  sessionId,
  title = "Promotion Candidate",
  content,
  sourceLinks = [],
  dataRoot = null,
  projectRuntimeRoot = null,
}: WritePromotionCandidateOptions = {}) {
  if (!sourcePath) throw new Error("sourcePath is required");
  if (!sessionId) throw new Error("sessionId is required");
  if (!content || !String(content).trim()) throw new Error("content is required");
  assertKnowledgeWriteAllowed("session-memory", { automatic: true, markdown: true });

  const runtimeRoot = requireSessionRuntimeRoot({ dataRoot, projectRuntimeRoot });
  const candidateId = slugifyPromo(title);
  const filePath = promotionCandidatePath(sourcePath, sessionId, candidateId, { dataRoot: runtimeRoot, projectRuntimeRoot: runtimeRoot });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderCandidate({ title, content, sourceLinks }), "utf8");
  return {
    candidateId,
    filePath,
    sourcePath: path.resolve(sourcePath),
    sessionId,
    dataRoot: runtimeRoot,
    createdAt: nowIso(),
  };
}

async function readCandidateContent(sourcePath: string, sessionId: string, candidateId: string, options: LooseRecord = {}) {
  return await readFile(promotionCandidatePath(sourcePath, sessionId, candidateId, options), "utf8");
}

function renderPromotion({ title, content, sourceLinks = [] }: LooseRecord) {
  const lines = [`## ${title}`, "", String(content || "").trim(), "", `Promoted: ${nowIso()}`];
  const links = stringArray(sourceLinks);
  if (links.length > 0) {
    lines.push("", "Sources:", ...links.map((link) => `- ${link}`));
  }
  return `${lines.join("\n").trim()}\n\n`;
}

async function appendPromotionRecord(sourcePath: string, sessionId: string, record: LooseRecord, options: LooseRecord = {}) {
  const filePath = path.join(sessionPath(sourcePath, sessionId, options), "promotions.jsonl");
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
  dataRoot = null,
  projectRuntimeRoot = null,
}: PromoteKnowledgeOptions = {}) {
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

  const runtimeOptions = { dataRoot, projectRuntimeRoot };
  const runtimeRoot = requireSessionRuntimeRoot(runtimeOptions);
  const body = content !== undefined && content !== null ? String(content) : await readCandidateContent(sourcePath, sessionId, String(candidateId), runtimeOptions);
  const promotionTitle = title || name || candidateId || "Promoted Knowledge";
  const targetPath = resolveKnowledgePath({
    hubRoot,
    sourcePath,
    ...runtimeOptions,
    kind: targetKind,
    sessionId,
    name: slugifyPromo(name || title || candidateId || targetKind, targetKind),
  });
  await mkdir(path.dirname(targetPath), { recursive: true });

  const rendered = renderPromotion({
    title: promotionTitle,
    content: body,
    sourceLinks: stringArray(sourceLinks).length > 0 ? stringArray(sourceLinks) : candidateId ? [promotionCandidatePath(sourcePath, sessionId, candidateId, runtimeOptions)] : [],
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
    dataRoot: runtimeRoot,
  };
  await appendPromotionRecord(sourcePath, sessionId, record, runtimeOptions);
  return record;
}
