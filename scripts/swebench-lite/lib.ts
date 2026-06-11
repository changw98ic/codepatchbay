import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type AnyRecord = Record<string, any>;
type ArgType = "boolean" | "number" | "list" | "string";
type ArgSpec = {
  defaults?: AnyRecord;
  types?: Record<string, ArgType>;
};
type ParsedArgs = AnyRecord & { _: any[]; help?: boolean };
type CommandResult = { code: number | null; stdout: string; stderr: string };

export function usageError(message: string): Error & { usage?: boolean } {
  const err = new Error(message) as Error & { usage?: boolean };
  err.usage = true;
  return err;
}

export function parseArgs(argv: string[], spec: ArgSpec = {}): ParsedArgs {
  const result: ParsedArgs = { _: [] };
  for (const [key, value] of Object.entries(spec.defaults || {})) {
    result[key] = value;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      result._.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const rawName = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const name = rawName.replace(/-([a-z])/g, (_: string, ch: string) => ch.toUpperCase());
    const type = spec.types?.[name] || "string";

    if (type === "boolean") {
      result[name] = eq === -1 ? true : parseBoolean(arg.slice(eq + 1), name);
      continue;
    }

    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw usageError(`--${rawName} requires a value`);
    if (type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw usageError(`--${rawName} must be a number`);
      result[name] = number;
    } else if (type === "list") {
      const parts = String(value).split(",").map((part) => part.trim()).filter(Boolean);
      result[name] = [...(result[name] || []), ...parts];
    } else {
      result[name] = value;
    }
  }

  return result;
}

export function parseBoolean(value: unknown, flagName = "flag"): boolean {
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw usageError(`--${flagName} must be true or false`);
}

export function slug(value: unknown, maxLength = 64): string {
  const cleaned = String(value)
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const trimmed = cleaned.slice(0, maxLength).replace(/-+$/g, "");
  return trimmed || "run";
}

export function shortHash(value: unknown, length = 8): string {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

export function projectIdForInstance(instanceId: string, { prefix = "swelite", runId = "run" }: AnyRecord = {}): string {
  const suffix = slug(instanceId, 36);
  const base = slug(`${prefix}-${runId}`, 22);
  const candidate = `${base}-${suffix}`;
  if (candidate.length <= 64) return candidate;
  return `${base}-${slug(instanceId, 32)}-${shortHash(instanceId, 6)}`.slice(0, 64).replace(/-+$/g, "");
}

export function queueIdToJobId(queueId: string | null | undefined): string | null {
  if (!queueId) return null;
  return queueId.startsWith("job-") ? queueId : `job-${queueId}`;
}

export function parseEnqueueOutput(stdout: string): AnyRecord | null {
  const match = String(stdout).match(/Enqueued\s+([^\s]+)\s+\(project=([^)]+)\)/);
  if (!match) return null;
  return {
    queueId: match[1],
    jobId: queueIdToJobId(match[1]),
    projectId: match[2],
  };
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJsonLines(filePath: string): Promise<any[]> {
  const text = await readFile(filePath, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function writeJsonLines(filePath: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(filePath, body ? `${body}\n` : "", "utf8");
}

export async function runCommand(command: string, args: string[], options: AnyRecord = {}): Promise<CommandResult> {
  const { cwd = repoRoot, env = process.env, input, quiet = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!quiet) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0) resolve(result);
      else {
        const err = new Error(`${command} ${args.join(" ")} exited with code ${code}`) as Error & { result?: CommandResult };
        err.result = result;
        reject(err);
      }
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function loadDatasetInstances(options: AnyRecord = {}): Promise<AnyRecord[]> {
  const {
    datasetPath,
    datasetName = "SWE-bench/SWE-bench_Lite",
    split = "test",
    limit = 0,
    instanceIds = [],
  } = options;

  let rows: AnyRecord[];
  if (datasetPath) {
    rows = await loadDatasetFile(datasetPath);
  } else {
    rows = await fetchHuggingFaceRows(datasetName, split, limit > 0 ? limit : Number.POSITIVE_INFINITY);
  }

  const wanted = new Set(instanceIds);
  if (wanted.size > 0) rows = rows.filter((row) => wanted.has(row.instance_id));
  if (limit > 0) rows = rows.slice(0, limit);

  return rows.map(normalizeInstanceRow);
}

async function loadDatasetFile(datasetPath: string): Promise<AnyRecord[]> {
  const text = await readFile(datasetPath, "utf8");
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function fetchHuggingFaceRows(datasetName: string, split: string, limit: number): Promise<AnyRecord[]> {
  const rows: AnyRecord[] = [];
  const pageSize = 100;
  for (let offset = 0; rows.length < limit; offset += pageSize) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", datasetName);
    url.searchParams.set("config", "default");
    url.searchParams.set("split", split);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(Math.min(pageSize, limit - rows.length)));
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`failed to fetch ${datasetName}/${split} rows: HTTP ${response.status}`);
    }
    const payload = await response.json() as AnyRecord;
    const page = (payload.rows || []).map((entry: AnyRecord) => entry.row || entry);
    rows.push(...page);
    const total = payload.num_rows_total || payload.num_rows;
    if (page.length === 0 || (total && rows.length >= total)) break;
  }
  return rows;
}

export function normalizeInstanceRow(row: AnyRecord): AnyRecord {
  const instance = {
    instanceId: row.instance_id,
    repo: row.repo,
    baseCommit: row.base_commit,
    problemStatement: row.problem_statement,
  };
  for (const [key, value] of Object.entries(instance)) {
    if (!value) throw new Error(`dataset row missing ${key}: ${JSON.stringify(row).slice(0, 200)}`);
  }
  return instance;
}

export function buildManifest({ runId, datasetName, split, runDir, instances }: AnyRecord): AnyRecord {
  return {
    schemaVersion: 1,
    runId,
    datasetName,
    split,
    runDir,
    createdAt: new Date().toISOString(),
    instances,
  };
}

export function terminalStatus(status: string): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function predictionFromBundle(bundle: AnyRecord, fallback: AnyRecord = {}): AnyRecord {
  const evidence = bundle?.evidence || {};
  const request = bundle?.request || {};
  return {
    instance_id: fallback.instanceId || request.instanceId || bundle?.instanceId,
    model_name_or_path: fallback.modelName || "cpb",
    model_patch: evidence.diff || evidence.uncommittedDiff || "",
  };
}

export function publicTraceFromBundle(bundle: AnyRecord, instance: AnyRecord = {}): string {
  const evidence = bundle?.evidence || {};
  const status = bundle?.status || {};
  const timeline = bundle?.timeline || [];
  const lines = [
    `# ${instance.instanceId || bundle?.jobId || "SWE-bench instance"} Trace`,
    "",
    "This trace contains public execution artifacts only: task text, phase timeline, changed files, and deliverable summary. It excludes private model reasoning.",
    "",
    `- Project: ${bundle?.project || instance.projectId || "-"}`,
    `- Job: ${bundle?.jobId || instance.jobId || "-"}`,
    `- Status: ${status.jobStatus || "-"}`,
    `- Completed phases: ${(status.completedPhases || []).join(", ") || "-"}`,
    "",
    "## Task",
    "",
    requestBlock(bundle?.request?.task || instance.problemStatement || ""),
    "",
    "## Timeline",
    "",
    ...timeline.map((event: AnyRecord) => `- ${event.ts || "-"} ${event.type || "event"}${event.phase ? ` phase=${event.phase}` : ""}${event.agent ? ` agent=${event.agent}` : ""}${event.status ? ` status=${event.status}` : ""}`),
    "",
    "## Changed Files",
    "",
    ...((evidence.changedFiles || []).length ? evidence.changedFiles.map((file) => `- ${file}`) : ["- None recorded"]),
    "",
    "## Diff Stat",
    "",
    "```text",
    evidence.diffStat || "",
    "```",
    "",
    "## Deliverable",
    "",
    requestBlock(evidence.deliverable || ""),
  ];
  return `${lines.join("\n")}\n`;
}

function requestBlock(text: unknown): string {
  return text ? String(text).trim() : "_Not recorded._";
}

export async function copyIfExists(source: string, target: string): Promise<boolean> {
  if (!(await pathExists(source))) return false;
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
  return true;
}

export function todayCompact(date = new Date()): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}
