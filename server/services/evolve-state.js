import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function evolveDir(flowRoot) {
  return path.join(flowRoot, "flow-task", "self-evolve");
}

function statePath(flowRoot, file) {
  return path.join(evolveDir(flowRoot), file);
}

async function readJSON(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function loadState(flowRoot) {
  return readJSON(statePath(flowRoot, "state.json"), {
    currentVersion: null,
    knownGoodCommit: null,
    status: "idle",
    round: 0,
    maxRounds: 20,
  });
}

export async function saveState(flowRoot, state) {
  await mkdir(evolveDir(flowRoot), { recursive: true });
  await writeFile(statePath(flowRoot, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function loadBacklog(flowRoot) {
  return readJSON(statePath(flowRoot, "backlog.json"), []);
}

export async function saveBacklog(flowRoot, backlog) {
  await mkdir(evolveDir(flowRoot), { recursive: true });
  await writeFile(statePath(flowRoot, "backlog.json"), JSON.stringify(backlog, null, 2) + "\n", "utf8");
}

export async function popIssue(flowRoot) {
  const backlog = await loadBacklog(flowRoot);
  const pending = backlog.filter((i) => i.status === "pending");
  if (pending.length === 0) return null;
  pending.sort((a, b) => (a.priority === "P0" ? 0 : a.priority === "P1" ? 1 : 2) - (b.priority === "P0" ? 0 : b.priority === "P1" ? 1 : 2));
  const issue = pending[0];
  issue.status = "in_progress";
  await saveBacklog(flowRoot, backlog);
  return { issue, backlog };
}

export async function pushIssues(flowRoot, issues) {
  const backlog = await loadBacklog(flowRoot);
  const existing = new Set(backlog.map((i) => i.description));
  for (const issue of issues) {
    if (!existing.has(issue.description)) {
      backlog.push({ ...issue, status: "pending", createdAt: new Date().toISOString() });
    }
  }
  await saveBacklog(flowRoot, backlog);
  return backlog.length;
}

export async function updateIssue(flowRoot, description, status, detail) {
  const backlog = await loadBacklog(flowRoot);
  const issue = backlog.find((i) => i.description === description);
  if (issue) {
    issue.status = status;
    if (detail) issue.detail = detail;
    issue.updatedAt = new Date().toISOString();
  }
  await saveBacklog(flowRoot, backlog);
}

export async function appendHistory(flowRoot, entry) {
  await mkdir(evolveDir(flowRoot), { recursive: true });
  const filePath = statePath(flowRoot, "history.jsonl");
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + "\n";
  await writeFile(filePath, line, { flag: "a", encoding: "utf8" });
}
