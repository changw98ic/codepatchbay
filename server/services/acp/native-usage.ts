import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { LooseRecord } from "../../../core/contracts/types.js";

const MAX_SESSION_FILES = 64;
const MAX_DIRECTORIES = 512;
const TOKEN_TAIL_BYTES = 256 * 1024;

type TokenCounter = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

type CursorFile = {
  existed: boolean;
  size: number;
  counter: TokenCounter | null;
};

export type NativeUsageCursor = {
  source: "codex_session_rollout_delta";
  sessionsRoot: string;
  files: Record<string, CursorFile>;
};

function finiteNonNegative(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function counterFromEvent(value: unknown): TokenCounter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as LooseRecord;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const payloadRecord = payload as LooseRecord;
  if (event.type !== "event_msg" || payloadRecord.type !== "token_count") return null;
  const info = payloadRecord.info;
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const total = (info as LooseRecord).total_token_usage;
  if (!total || typeof total !== "object" || Array.isArray(total)) return null;
  const usage = total as LooseRecord;
  const inputTokens = finiteNonNegative(usage.input_tokens);
  const cachedInputTokens = finiteNonNegative(usage.cached_input_tokens) ?? 0;
  const outputTokens = finiteNonNegative(usage.output_tokens);
  const reasoningOutputTokens = finiteNonNegative(usage.reasoning_output_tokens) ?? 0;
  const totalTokens = finiteNonNegative(usage.total_tokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function containedBy(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function codexSessionsRoot(env: NodeJS.ProcessEnv): string | null {
  const home = typeof env.HOME === "string" && env.HOME ? path.resolve(env.HOME) : null;
  if (!home) return null;
  const codexHome = path.resolve(
    typeof env.CODEX_HOME === "string" && env.CODEX_HOME
      ? env.CODEX_HOME
      : path.join(home, ".codex"),
  );
  // Native fallback must only inspect the isolated HOME owned by this ACP
  // process. An explicit shared/global CODEX_HOME is intentionally ignored.
  if (!containedBy(home, codexHome)) return null;
  return path.join(codexHome, "sessions");
}

async function sessionFiles(root: string) {
  const directories: string[] = [root];
  const files: Array<{ path: string; mtimeMs: number }> = [];
  let visitedDirectories = 0;

  while (directories.length > 0 && visitedDirectories < MAX_DIRECTORIES) {
    const directory = directories.pop() as string;
    visitedDirectories += 1;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const info = await stat(entryPath);
        files.push({ path: entryPath, mtimeMs: info.mtimeMs });
      } catch {
        // A concurrently rotated session file is simply absent from this snapshot.
      }
    }
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
    .slice(0, MAX_SESSION_FILES)
    .map((entry) => entry.path);
}

async function latestCounter(filePath: string): Promise<{ size: number; counter: TokenCounter | null }> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, TOKEN_TAIL_BYTES);
    if (length <= 0) return { size: info.size, counter: null };
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const counter = counterFromEvent(JSON.parse(line));
        if (counter) return { size: info.size, counter };
      } catch {
        // The first tail line can be partial; continue toward newer full lines.
      }
    }
    return { size: info.size, counter: null };
  } finally {
    await handle.close();
  }
}

export async function captureNativeUsageCursor(
  agent: string,
  env: NodeJS.ProcessEnv,
): Promise<NativeUsageCursor | null> {
  if (agent !== "codex") return null;
  const sessionsRoot = codexSessionsRoot(env);
  if (!sessionsRoot) return null;
  const files: Record<string, CursorFile> = {};
  for (const filePath of await sessionFiles(sessionsRoot)) {
    try {
      const snapshot = await latestCounter(filePath);
      files[filePath] = { existed: true, ...snapshot };
    } catch {
      // Telemetry remains optional; unreadable files do not affect execution.
    }
  }
  return { source: "codex_session_rollout_delta", sessionsRoot, files };
}

function delta(after: number, before: number) {
  return after >= before ? after - before : null;
}

export async function readNativeUsageDelta(
  cursor: NativeUsageCursor | null,
): Promise<LooseRecord | null> {
  if (!cursor) return null;
  const totals: TokenCounter = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  let changedFiles = 0;

  for (const filePath of await sessionFiles(cursor.sessionsRoot)) {
    let after;
    try {
      after = await latestCounter(filePath);
    } catch {
      continue;
    }
    if (!after.counter) continue;
    const beforeFile = cursor.files[filePath];
    if (beforeFile?.existed && beforeFile.counter === null) {
      // The baseline existed but was unreadable/absent; counting the cumulative
      // total as a prompt delta would over-report, so fail closed for this file.
      continue;
    }
    if (beforeFile && beforeFile.size === after.size) continue;
    const before = beforeFile?.counter || {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
    const values = {
      inputTokens: delta(after.counter.inputTokens, before.inputTokens),
      cachedInputTokens: delta(after.counter.cachedInputTokens, before.cachedInputTokens),
      outputTokens: delta(after.counter.outputTokens, before.outputTokens),
      reasoningOutputTokens: delta(after.counter.reasoningOutputTokens, before.reasoningOutputTokens),
      totalTokens: delta(after.counter.totalTokens, before.totalTokens),
    };
    if (Object.values(values).some((value) => value === null)) continue;
    if ((values.totalTokens || 0) <= 0) continue;
    totals.inputTokens += values.inputTokens || 0;
    totals.cachedInputTokens += values.cachedInputTokens || 0;
    totals.outputTokens += values.outputTokens || 0;
    totals.reasoningOutputTokens += values.reasoningOutputTokens || 0;
    totals.totalTokens += values.totalTokens || 0;
    changedFiles += 1;
  }

  if (changedFiles === 0 || totals.totalTokens <= 0) return null;
  return {
    ...totals,
    costUsd: null,
    toolCalls: null,
    functionCalls: null,
    events: changedFiles,
    tokenSource: cursor.source,
  };
}
