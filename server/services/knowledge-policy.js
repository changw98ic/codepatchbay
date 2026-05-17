import path from "node:path";

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
