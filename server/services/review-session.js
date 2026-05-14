import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { runtimeDataPath } from "./runtime-root.js";

async function withFileLock(lockDir, fn) {
  await mkdir(lockDir, { recursive: false }).catch(() => {});
  try {
    return await fn();
  } finally {
    await rm(lockDir, { force: true }).catch(() => {});
  }
}

const VALID_TRANSITIONS = {
  idle: ["researching"],
  researching: ["planning", "expired"],
  planning: ["reviewing", "expired"],
  reviewing: ["revising", "user_review", "expired"],
  revising: ["reviewing", "expired"],
  user_review: ["dispatched", "expired"],
  dispatched: [],
  expired: [],
};

function reviewsDir(cpbRoot) {
  return runtimeDataPath(cpbRoot, "reviews");
}

function sessionFile(cpbRoot, sessionId) {
  return path.join(reviewsDir(cpbRoot), `${sessionId}.json`);
}

export function makeSessionId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const suffix = randomBytes(3).toString("hex");
  return `rev-${ts}-${suffix}`;
}

export async function createSession(cpbRoot, { project, intent }) {
  const session = {
    sessionId: makeSessionId(),
    project,
    intent,
    status: "idle",
    round: 0,
    research: { codex: null, claude: null },
    plan: null,
    reviews: [],
    userVerdict: null,
    jobId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const dir = reviewsDir(cpbRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(sessionFile(cpbRoot, session.sessionId), JSON.stringify(session, null, 2) + "\n", "utf8");
  return session;
}

export async function getSession(cpbRoot, sessionId) {
  try {
    const raw = await readFile(sessionFile(cpbRoot, sessionId), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessions(cpbRoot) {
  const dir = reviewsDir(cpbRoot);
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const sessions = [];
  for (const name of entries.filter(f => f.endsWith(".json")).sort().reverse()) {
    try {
      const raw = await readFile(path.join(dir, name), "utf8");
      sessions.push(JSON.parse(raw));
    } catch {}
  }
  return sessions;
}

export async function updateSession(cpbRoot, sessionId, patch, options = {}) {
  const { skipTransitionCheck = false } = options;

  const lockDir = path.join(reviewsDir(cpbRoot), `.lock-${sessionId}`);
  return withFileLock(lockDir, async () => {
    const session = await getSession(cpbRoot, sessionId);
    if (!session) throw new Error(`review session not found: ${sessionId}`);

    if (!skipTransitionCheck && patch.status && patch.status !== session.status) {
      const allowed = VALID_TRANSITIONS[session.status];
      if (!allowed || !allowed.includes(patch.status)) {
        throw new Error(`invalid transition: ${session.status} → ${patch.status}`);
      }
    }

    const updated = {
      ...session,
      ...patch,
      sessionId: session.sessionId, // immutable
      project: session.project,
      intent: session.intent,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await writeFile(sessionFile(cpbRoot, sessionId), JSON.stringify(updated, null, 2) + "\n", "utf8");
    return updated;
  });
}

export function parseIssues(text) {
  if (!text || typeof text !== "string") return [];
  const issues = [];
  const regex = /\[P([0-3])\]\s*(.*?)(?=\n\[P[0-3]\]|$)/gs;
  let match;
  while ((match = regex.exec(text)) !== null) {
    issues.push({
      severity: parseInt(match[1], 10),
      description: match[2].trim(),
    });
  }
  return issues;
}
