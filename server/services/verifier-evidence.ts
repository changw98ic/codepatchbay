import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readEvents } from "./event-store.js";
import { reconstructJobState } from "./phase-locator.js";
import { contextPath, decisionsPath, outputsDir } from "./phase-locator.js";
import { CPB_RUNTIME_ENV, RUNTIME_BASICS } from "./secret-policy.js";

const execFileAsync = promisify(execFile);

function buildVerifierCommandEnv(parentEnv = process.env) {
  const allowed = new Set([...RUNTIME_BASICS, ...CPB_RUNTIME_ENV]);
  const env = {};
  for (const [key, value] of Object.entries(parentEnv || {})) {
    if (allowed.has(key)) env[key] = value;
  }
  return env;
}

export async function collectCurrentDiff(sourcePath, { maxLines = 200 } = {}) {
  if (!sourcePath) return { available: false, reason: "no source path" };

  try {
    const { stdout } = await execFileAsync("git", ["diff", "--stat", "HEAD"], {
      cwd: sourcePath,
      env: buildVerifierCommandEnv(),
      maxBuffer: 1024 * 1024,
    });
    return { available: true, diff: stdout.slice(0, maxLines * 200) };
  } catch {
    return { available: false, reason: "git diff failed or not a git repo" };
  }
}

export async function collectUncommittedDiff(sourcePath, { maxLines = 200 } = {}) {
  if (!sourcePath) return { available: false, reason: "no source path" };

  try {
    const { stdout } = await execFileAsync("git", ["diff"], {
      cwd: sourcePath,
      env: buildVerifierCommandEnv(),
      maxBuffer: 1024 * 1024,
    });
    const truncated = stdout.split("\n").slice(0, maxLines).join("\n");
    return { available: true, diff: truncated };
  } catch {
    return { available: false, reason: "git diff failed" };
  }
}

export async function collectTestResults(sourcePath, { timeout = 30_000 } = {}) {
  if (!sourcePath) return { available: false, reason: "no source path" };

  try {
    const pkgPath = path.join(sourcePath, "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    const testScript = pkg.scripts?.test;
    if (!testScript) return { available: false, reason: "no test script" };

    const { stdout, stderr } = await execFileAsync("npm", ["test"], {
      cwd: sourcePath,
      env: buildVerifierCommandEnv(),
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { available: true, stdout: stdout.slice(-5000), stderr: stderr.slice(-5000) };
  } catch (err) {
    const stdout = err.stdout?.slice(-5000) || "";
    const stderr = err.stderr?.slice(-5000) || "";
    return { available: true, exitCode: err.code || 1, stdout, stderr };
  }
}

export async function collectEventLog(cpbRoot, project, jobId, { maxEvents = 50 } = {}) {
  try {
    const events = await readEvents(cpbRoot, project, jobId);
    if (events.length === 0) {
      return { available: false, reason: "event log is empty or missing" };
    }
    const recent = events.slice(-maxEvents);
    return { available: true, eventCount: events.length, events: recent };
  } catch {
    return { available: false, reason: "event log not found" };
  }
}

export async function collectProjectContext(cpbRoot, project) {
  const ctx = await readFile(contextPath(cpbRoot, project), "utf8").catch(() => null);
  const decisions = await readFile(decisionsPath(cpbRoot, project), "utf8").catch(() => null);

  return {
    available: Boolean(ctx || decisions),
    context: ctx,
    decisions,
  };
}

export async function collectDeliverable(cpbRoot, project, deliverableId) {
  if (!deliverableId) return { available: false, reason: "no deliverable ID" };

  const file = path.join(outputsDir(cpbRoot, project), `deliverable-${deliverableId}.md`);
  try {
    const content = await readFile(file, "utf8");
    return { available: true, content, path: file };
  } catch {
    return { available: false, reason: `deliverable file not found: ${file}` };
  }
}

export async function collectVerifierEvidence(cpbRoot, project, jobId, { sourcePath, deliverableId }: Record<string, any> = {}) {
  const jobState = await reconstructJobState(cpbRoot, project, jobId);

  const evidence = {
    jobState,
    deliverable: null,
    diff: null,
    uncommittedDiff: null,
    eventLog: null,
    projectContext: null,
    testResults: null,
    diagnostics: [],
  };

  const resolvedSourcePath = sourcePath || jobState?.worktree || null;

  const [deliverable, diff, uncommittedDiff, eventLog, projectContext, testResults] = await Promise.all([
    collectDeliverable(cpbRoot, project, deliverableId).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectCurrentDiff(resolvedSourcePath).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectUncommittedDiff(resolvedSourcePath).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectEventLog(cpbRoot, project, jobId).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectProjectContext(cpbRoot, project).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectTestResults(resolvedSourcePath).catch((err) => ({
      available: false,
      reason: err.message,
    })),
  ]);

  evidence.deliverable = deliverable;
  evidence.diff = diff;
  evidence.uncommittedDiff = uncommittedDiff;
  evidence.eventLog = eventLog;
  evidence.projectContext = projectContext;
  evidence.testResults = testResults;

  if (!deliverable.available) {
    evidence.diagnostics.push({
      level: "info",
      message: `deliverable not available: ${deliverable.reason}`,
    });
  }
  if (!diff.available) {
    evidence.diagnostics.push({
      level: "info",
      message: `diff not available: ${diff.reason}`,
    });
  }
  if (!eventLog.available) {
    evidence.diagnostics.push({
      level: "warning",
      message: `event log not available: ${eventLog.reason}`,
    });
  }

  return evidence;
}
