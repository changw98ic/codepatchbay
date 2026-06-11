import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { openSync, readSync, closeSync, writeSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createInterface } from "node:readline";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// Structured log line: 2025-01-01T00:00:00.000Z [info] [component] [traceId] message
const STRUCTURED_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[(\w+)\](?:\s+\[([^\]]*)\])?(?:\s+\[([^\]]*)\])?\s+(.*)/;

function parseLine(raw) {
  const line = raw.trimEnd();
  if (!line) return null;
  const m = line.match(STRUCTURED_RE);
  if (m) {
    return { ts: new Date(m[1]).getTime(), level: m[2].toLowerCase(), component: m[3] || "", traceId: m[4] || "", message: m[5], raw: line };
  }
  // Non-structured line — assign default level "info", no timestamp filtering
  return { ts: 0, level: "info", component: "", traceId: "", message: line, raw: line };
}

function parseSince(str) {
  if (!str) return 0;
  const m = str.match(/^(\d+)(m|h|d)$/);
  if (!m) return 0;
  const val = parseInt(m[1], 10);
  const unit = m[2];
  return val * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
}

function matchesFilters(parsed, { minLevel, workerId, jobId, sinceMs, now }) {
  if (!parsed) return false;
  if (minLevel > 0 && (LEVELS[parsed.level] ?? 1) < minLevel) return false;
  if (sinceMs > 0 && parsed.ts > 0 && parsed.ts < now - sinceMs) return false;
  if (workerId && !parsed.raw.includes(`worker-${workerId}`) && !parsed.component.includes(`worker-${workerId}`)) return false;
  if (jobId) {
    // Strip "job-" prefix for flexible matching: worker logs use entryId (e.g. "abc123")
    // while jobId is "job-abc123". Both should match when user passes either form.
    const jobIdBase = jobId.startsWith("job-") ? jobId.slice(4) : jobId;
    const matchesJob = parsed.raw.includes(jobId) || parsed.traceId === jobId
      || (jobIdBase !== jobId && (parsed.raw.includes(jobIdBase) || parsed.traceId === jobIdBase));
    if (!matchesJob) return false;
  }
  return true;
}

function collectLogFiles(hubRoot) {
  const files = [];
  for (const name of ["hub.log", "orchestrator.log", "quota-delegate.log"]) {
    files.push(path.join(hubRoot, name));
  }
  // Worker stderr logs — hubRoot/workers/*.log
  const workersDir = path.join(hubRoot, "workers");
  try {
    const entries = readdir(workersDir);
    // sync readdir not available; we'll handle async below
  } catch {}
  return files;
}

async function collectAllLogFiles(hubRoot, workerId, jobId, cpbRoot) {
  const files = [];
  for (const name of ["hub.log", "orchestrator.log", "quota-delegate.log"]) {
    const p = path.join(hubRoot, name);
    try { await stat(p); files.push(p); } catch {}
  }
  // Worker logs
  const logsDir = path.join(hubRoot, "logs");
  try {
    const entries = await readdir(logsDir);
    for (const e of entries) {
      if (!e.endsWith(".log")) continue;
      if (workerId && !e.includes(workerId)) continue;
      files.push(path.join(logsDir, e));
    }
  } catch {}
  // JSONL event files (use listEventFiles to cover all runtime roots)
  try {
    const { listEventFiles } = await import("../../server/services/event-store.js");
    const { listRuntimeDataRoots } = await import("../../server/services/runtime-context.js");
    const roots = await listRuntimeDataRoots(cpbRoot, { includeLegacy: false });
    for (const root of roots) {
      const eventFiles = await listEventFiles(cpbRoot, {
        dataRoot: root.dataRoot,
        includeLegacyFallback: false,
      });
      for (const ef of eventFiles) {
        if (jobId) {
          // Flexible match: try full jobId, then strip "job-" prefix
          const jobIdBase = jobId.startsWith("job-") ? jobId.slice(4) : jobId;
          const matchFull = ef.jobId.includes(jobId);
          const matchBase = jobIdBase !== jobId && ef.jobId.includes(jobIdBase);
          if (!matchFull && !matchBase) continue;
        }
        files.push(ef.file);
      }
    }
  } catch {}
  return files;
}

function makeFilterTransform(filters) {
  return new Transform({
    objectMode: true,
    transform(chunk, _encoding, cb) {
      const line = chunk.toString().trimEnd();
      if (!line) { cb(); return; }

      // Try JSONL event
      if (line.startsWith("{")) {
        try {
          const evt = JSON.parse(line);
          const ts = evt.timestamp ? new Date(evt.timestamp).getTime() : evt.ts ? new Date(evt.ts).getTime() : 0;
          const level = (evt.type || "").includes("fail") || (evt.type || "").includes("error") ? "warn" : "info";
          const entryId = evt.entryId || evt.jobId || "";
          const tsStr = evt.timestamp || evt.ts || "";
          const formatted = `${tsStr} [${level}] [event] [${entryId}] ${evt.type}${evt.reason ? ": " + evt.reason : ""}${evt.phase ? " phase=" + evt.phase : ""}`;
          const parsed = { ts, level, component: "event", traceId: entryId, message: formatted, raw: formatted };
          if (matchesFilters(parsed, filters)) {
            this.push(formatted + "\n");
          }
          cb();
          return;
        } catch {}
      }

      const parsed = parseLine(line);
      if (matchesFilters(parsed, filters)) {
        this.push(line.endsWith("\n") ? line : line + "\n");
      }
      cb();
    },
  });
}

async function dumpLogs(files, filters) {
  // Read all files, parse, filter, sort by timestamp, output
  const lines = [];
  const { readFile: readFileAsync } = await import("node:fs/promises");
  for (const file of files) {
    let content;
    try {
      content = await readFileAsync(file, "utf8");
    } catch { continue; }
    const isJsonl = file.endsWith(".jsonl");
    for (const raw of content.split("\n")) {
      if (isJsonl) {
        // Parse JSONL event as pseudo-log-line
        try {
          const evt = JSON.parse(raw);
          const ts = evt.timestamp ? new Date(evt.timestamp).getTime() : evt.ts ? new Date(evt.ts).getTime() : 0;
          const level = (evt.type || "").includes("fail") || (evt.type || "").includes("error") ? "warn" : "info";
          const entryId = evt.entryId || evt.jobId || "";
          const tsStr = evt.timestamp || evt.ts || "";
          const line = `${tsStr} [${level}] [event] [${entryId}] ${evt.type}${evt.reason ? ": " + evt.reason : ""}${evt.phase ? " phase=" + evt.phase : ""}`;
          const parsed = { ts, level, component: "event", traceId: entryId, message: line, raw: line };
          if (matchesFilters(parsed, filters)) lines.push({ ts, raw: line });
        } catch {}
      } else {
        const parsed = parseLine(raw);
        if (matchesFilters(parsed, filters)) {
          lines.push({ ts: parsed.ts, raw: parsed.raw });
        }
      }
    }
  }
  lines.sort((a, b) => a.ts - b.ts);
  for (const l of lines) {
    process.stdout.write(l.raw + "\n");
  }
}

async function followLogs(files, filters) {
  if (files.length === 0) {
    console.error("No log files found.");
    return;
  }
  // Use tail -f for real-time follow
  const args = ["-f", "-n", "0", ...files];
  const child = spawn("tail", args, { stdio: ["ignore", "pipe", "pipe"] });

  const filter = makeFilterTransform(filters);
  pipeline(child.stdout, filter, process.stdout).catch(() => {});
  pipeline(child.stderr, process.stdout).catch(() => {});

  // Forward signals
  const sigHandler = () => { child.kill(); process.exit(0); };
  process.on("SIGINT", sigHandler);
  process.on("SIGTERM", sigHandler);

  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
}

export async function run(args, { cpbRoot, executorRoot }) {
  const follow = args.includes("--follow") || args.includes("-f");
  const workerIdx = args.indexOf("--worker");
  const workerId = workerIdx >= 0 && args[workerIdx + 1] ? args[workerIdx + 1] : null;
  const jobIdx = args.indexOf("--job");
  const jobIdFilter = jobIdx >= 0 && args[jobIdx + 1] ? args[jobIdx + 1] : null;
  const levelIdx = args.indexOf("--level");
  const levelFilter = levelIdx >= 0 && args[levelIdx + 1] ? args[levelIdx + 1] : null;
  const sinceIdx = args.indexOf("--since");
  const sinceStr = sinceIdx >= 0 && args[sinceIdx + 1] ? args[sinceIdx + 1] : null;

  const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);

  const sinceMs = parseSince(sinceStr);
  const minLevel = levelFilter ? (LEVELS[levelFilter.toLowerCase()] ?? 0) : 0;
  const now = Date.now();

  const filters = { minLevel, workerId, jobId: jobIdFilter, sinceMs, now };
  const files = await collectAllLogFiles(hubRoot, workerId, jobIdFilter, cpbRoot);

  if (follow) {
    return followLogs(files, filters);
  }
  return dumpLogs(files, filters);
}
