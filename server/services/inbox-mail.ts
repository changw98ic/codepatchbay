import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type AnyRecord = Record<string, any>;

const SCHEMA = "cpb.inbox-mail.v1";
const VALID_STATUSES = new Set(["pending", "acknowledged", "completed"]);
const VALID_TRANSITIONS = {
  pending: "acknowledged",
  acknowledged: "completed",
};

function nowIso() {
  return new Date().toISOString();
}

function inboxDir(cpbRoot, project) {
  return path.join(cpbRoot, "wiki", "projects", project, "inbox");
}

function safeId(id) {
  if (!id || typeof id !== "string") return false;
  if (id.includes("..") || id.includes("/") || id.includes(path.sep) || id.includes("\\")) return false;
  if (!/^msg-\d{8}-\d{6}-[0-9a-f]{4,}$/.test(id)) return false;
  return true;
}

function safeMessagePath(cpbRoot, project, id) {
  const dir = inboxDir(cpbRoot, project);
  const resolved = path.resolve(dir, `${id}.md`);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error("invalid message id: path escape");
  }
  return resolved;
}

let _seq = 0;
const _pidHex = process.pid.toString(16).padStart(4, "0");
function generateId() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const seq = String(++_seq).padStart(6, "0");
  return `msg-${y}${m}${d}-${seq}-${_pidHex}`;
}

function serializeFrontmatter(meta) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) {
      lines.push(`${key}: ""`);
    } else if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function parseFrontmatter(raw) {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("---", 3);
  if (end === -1) return null;

  const fmText = raw.slice(3, end).trim();
  const content = raw.slice(end + 3).trimStart();
  const meta: AnyRecord = {};

  for (const line of fmText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    try {
      meta[key] = JSON.parse(value);
    } catch {
      meta[key] = value.replace(/^"|"$/g, "");
    }
  }

  return { meta, content };
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

async function withLock(cpbRoot, project, callback) {
  const dir = inboxDir(cpbRoot, project);
  const lockDir = `${dir}.lock`;
  await mkdir(dir, { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      // Check staleness (30s)
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs >= 30_000) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Race: someone else removed it, retry
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  if (!acquired) {
    throw new Error(`inbox lock busy for project: ${project}`);
  }

  try {
    return await callback();
  } finally {
    try {
      await rm(lockDir, { recursive: true, force: true });
    } catch {
      // Already cleaned up
    }
  }
}

function messageToOutput(meta) {
  return { ...meta };
}

export async function writeInboxMessage(cpbRoot, project, input) {
  const id = generateId();
  const now = nowIso();

  const meta = {
    schema: SCHEMA,
    id,
    type: input.type || "plan",
    project,
    jobId: input.jobId || "",
    phase: input.phase || input.type || "plan",
    from: input.from || "",
    to: input.to || "",
    status: "pending",
    owner: "",
    locator: input.locator || {},
    createdAt: now,
    updatedAt: now,
  };

  const content = input.content || "";
  const fileContent = `${serializeFrontmatter(meta)}\n${content}\n`;
  const filePath = safeMessagePath(cpbRoot, project, id);

  await withLock(cpbRoot, project, async () => {
    await writeAtomic(filePath, fileContent);
  });

  return messageToOutput(meta);
}

export async function listInboxMessages(cpbRoot, project, filters: AnyRecord = {}) {
  const dir = inboxDir(cpbRoot, project);
  let files;
  try {
    files = (await readdir(dir))
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }

  const messages = [];
  for (const f of files) {
    try {
      const raw = await readFile(path.join(dir, f), "utf8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;

      const msg = parsed.meta;

      if (filters.type && msg.type !== filters.type) continue;
      if (filters.status && msg.status !== filters.status) continue;
      if (filters.to && msg.to !== filters.to) continue;
      if (filters.owner && msg.owner !== filters.owner) continue;
      if (filters.jobId && msg.jobId !== filters.jobId) continue;

      messages.push(messageToOutput(msg));
    } catch {
      // Skip unreadable files
    }
  }

  // Sort by createdAt to guarantee creation order (filename hex suffix is random)
  messages.sort((a, b) => a.id.localeCompare(b.id));
  return messages;
}

export async function readInboxMessage(cpbRoot, project, id) {
  if (!safeId(id)) return null;
  const filePath = safeMessagePath(cpbRoot, project, id);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;
    return { ...messageToOutput(parsed.meta), content: parsed.content };
  } catch {
    return null;
  }
}

export async function ackInboxMessage(cpbRoot, project, id, { owner }: AnyRecord = {}) {
  if (!safeId(id)) return null;
  return withLock(cpbRoot, project, async () => {
    const filePath = safeMessagePath(cpbRoot, project, id);
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return null;
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    const currentStatus = parsed.meta.status;
    const expected = VALID_TRANSITIONS[currentStatus];
    if (expected !== "acknowledged") {
      throw new Error(`invalid transition: ${currentStatus} -> acknowledged`);
    }

    parsed.meta.status = "acknowledged";
    parsed.meta.owner = owner || "";
    parsed.meta.updatedAt = nowIso();

    const fileContent = `${serializeFrontmatter(parsed.meta)}\n${parsed.content}\n`;
    await writeAtomic(filePath, fileContent);

    return messageToOutput(parsed.meta);
  });
}

export async function completeInboxMessage(cpbRoot, project, id) {
  if (!safeId(id)) return null;
  return withLock(cpbRoot, project, async () => {
    const filePath = safeMessagePath(cpbRoot, project, id);
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return null;
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    const currentStatus = parsed.meta.status;
    const expected = VALID_TRANSITIONS[currentStatus];
    if (expected !== "completed") {
      throw new Error(`invalid transition: ${currentStatus} -> completed`);
    }

    parsed.meta.status = "completed";
    parsed.meta.updatedAt = nowIso();

    const fileContent = `${serializeFrontmatter(parsed.meta)}\n${parsed.content}\n`;
    await writeAtomic(filePath, fileContent);

    return messageToOutput(parsed.meta);
  });
}
