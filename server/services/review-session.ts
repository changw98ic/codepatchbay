import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const LOCK_MAX_ATTEMPTS = 10;
const LOCK_BASE_DELAY_MS = 10;
type AnyRecord = Record<string, any>;

async function withFileLock(lockDir, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lockDir, { recursive: false });
    } catch (err) {
      if (err.code === "EEXIST" && attempt < LOCK_MAX_ATTEMPTS) {
        const jitter = Math.random() * LOCK_BASE_DELAY_MS;
        await new Promise((r) => setTimeout(r, LOCK_BASE_DELAY_MS + jitter));
        continue;
      }
      if (err.code === "EEXIST") {
        throw new Error(
          `lock contention: failed to acquire ${lockDir} after ${LOCK_MAX_ATTEMPTS} attempts`,
        );
      }
      throw err;
    }
    try {
      return await fn();
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const VALID_TRANSITIONS = {
  idle: ["researching"],
  researching: ["planning", "expired"],
  planning: ["reviewing", "expired"],
  reviewing: ["revising", "user_review", "expired"],
  revising: ["reviewing", "expired"],
  user_review: ["dispatched", "expired", "merge_failed", "completed"],
  dispatched: ["merge_failed", "completed"],
  merge_failed: ["dispatched"],
  expired: [],
};

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("invalid sessionId: must be a non-empty string");
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
  return sessionId;
}

function controlDataRoot(cpbRoot, { dataRoot, hubRoot }: AnyRecord = {}) {
  const root = dataRoot || hubRoot || process.env.CPB_HUB_ROOT;
  return root ? path.resolve(root) : path.join(path.resolve(cpbRoot), "cpb-task");
}

function reviewsDir(cpbRoot, options: AnyRecord = {}) {
  return path.join(controlDataRoot(cpbRoot, options), "reviews");
}

function sessionFile(cpbRoot, sessionId, options: AnyRecord = {}) {
  const safeId = validateSessionId(sessionId);
  const base = path.resolve(reviewsDir(cpbRoot, options));
  const resolved = path.resolve(base, `${safeId}.json`);
  if (!resolved.startsWith(base + path.sep) && resolved !== path.join(base, `${safeId}.json`)) {
    throw new Error("sessionId escapes reviews directory");
  }
  return resolved;
}

export function makeSessionId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const suffix = randomBytes(3).toString("hex");
  return `rev-${ts}-${suffix}`;
}

export async function createSession(cpbRoot, { project, intent, dataRoot, hubRoot }: AnyRecord) {
  const storageOptions = { dataRoot, hubRoot };
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
    budget: {
      maxRounds: parseInt(process.env.CPB_REVIEW_MAX_ROUNDS || "5", 10),
      maxPromptBytes: parseInt(process.env.CPB_REVIEW_MAX_PROMPT_BYTES || "120000", 10),
      maxAcpCalls: parseInt(process.env.CPB_REVIEW_MAX_ACP_CALLS || "30", 10),
      usedAcpCalls: 0,
      usedPromptBytes: 0,
    },
    idempotency: {
      startKey: null,
      dispatchKey: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const dir = reviewsDir(cpbRoot, storageOptions);
  await mkdir(dir, { recursive: true });
  await writeFile(sessionFile(cpbRoot, session.sessionId, storageOptions), JSON.stringify(session, null, 2) + "\n", "utf8");
  return session;
}

export async function getSession(cpbRoot, sessionId, options: AnyRecord = {}) {
  validateSessionId(sessionId);
  try {
    const raw = await readFile(sessionFile(cpbRoot, sessionId, options), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessions(cpbRoot, options: AnyRecord = {}) {
  const dir = reviewsDir(cpbRoot, options);
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

export async function updateSession(cpbRoot, sessionId, patch, options: Record<string, any> = {}) {
  const safeId = validateSessionId(sessionId);
  const { skipTransitionCheck = false } = options;

  const dir = reviewsDir(cpbRoot, options);
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, `.lock-${safeId}`);
  return withFileLock(lockDir, async () => {
    const session = await getSession(cpbRoot, sessionId, options);
    if (!session) throw new Error(`review session not found: ${sessionId}`);

    if (!skipTransitionCheck && patch.status) {
      if (patch.status === session.status) {
        throw new Error(`already in status: ${session.status}`);
      }
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

    await writeFile(sessionFile(cpbRoot, sessionId, options), JSON.stringify(updated, null, 2) + "\n", "utf8");
    return updated;
  });
}

export async function cancelReviewSession(cpbRoot, sessionId, reason, options: AnyRecord = {}) {
  return updateSession(cpbRoot, sessionId, { status: "cancelled", detail: reason }, { ...options, skipTransitionCheck: true });
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

export async function startSessionResearch(cpbRoot, sessionId, key, options: AnyRecord = {}) {
  const safeId = validateSessionId(sessionId);
  const dir = reviewsDir(cpbRoot, options);
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, `.lock-start-${safeId}`);
  return withFileLock(lockDir, async () => {
    const session = await getSession(cpbRoot, sessionId, options);
    if (!session) throw new Error(`review session not found: ${sessionId}`);

    const existingKey = session.idempotency?.startKey;
    if (existingKey === key) return session; // idempotent

    if (existingKey !== null && existingKey !== undefined) {
      throw new Error(`idempotency conflict: session already started with key ${existingKey}`);
    }

    // Perform the idle → researching transition
    if (session.status !== "idle") {
      throw new Error(`invalid transition: ${session.status} → researching`);
    }

    const updated = {
      ...session,
      status: "researching",
      idempotency: { ...session.idempotency, startKey: key },
      updatedAt: new Date().toISOString(),
    };
    await writeFile(sessionFile(cpbRoot, sessionId, options), JSON.stringify(updated, null, 2) + "\n", "utf8");
    return updated;
  });
}

export async function noteReviewAcpCall(cpbRoot, sessionId, { agent, promptBytes }, options: AnyRecord = {}) {
  const safeId = validateSessionId(sessionId);
  const dir = reviewsDir(cpbRoot, options);
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, `.lock-${safeId}`);
  return withFileLock(lockDir, async () => {
    const session = await getSession(cpbRoot, sessionId, options);
    if (!session) throw new Error(`review session not found: ${sessionId}`);

    const budget = {
      ...session.budget,
      usedAcpCalls: (session.budget?.usedAcpCalls || 0) + 1,
      usedPromptBytes: (session.budget?.usedPromptBytes || 0) + (promptBytes || 0),
    };

    const updated = {
      ...session,
      budget,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(sessionFile(cpbRoot, sessionId, options), JSON.stringify(updated, null, 2) + "\n", "utf8");
    return updated;
  });
}

export function assertReviewBudget(session) {
  const budget = session.budget;
  if (!budget) return session;
  if (budget.usedAcpCalls >= budget.maxAcpCalls) {
    throw new Error(`budget exhausted: usedAcpCalls(${budget.usedAcpCalls}) >= maxAcpCalls(${budget.maxAcpCalls})`);
  }
  if (budget.usedPromptBytes >= budget.maxPromptBytes) {
    throw new Error(`budget exhausted: usedPromptBytes(${budget.usedPromptBytes}) >= maxPromptBytes(${budget.usedPromptBytes})`);
  }
  return session;
}
