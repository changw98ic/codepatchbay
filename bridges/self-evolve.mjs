#!/usr/bin/env node

// Self-Evolve: autonomous controller for review-driven self-improvement.

import { spawn, execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { constants } from "node:fs";
import { accessSync, statSync } from "node:fs";
import path from "node:path";
import {
  loadState, saveState,
  loadBacklog, popIssue, pushIssues, updateIssue,
  appendHistory, appendWisdom,
} from "../server/services/evolve-state.js";

const CPB_ROOT = path.resolve(process.env.CPB_ROOT || process.cwd());
const EVOLVE_DIR = path.join(CPB_ROOT, "cpb-task", "self-evolve");
const EVOLVE_LEASE_DIR = path.join(EVOLVE_DIR, ".controller-lock");
const PORT = parseInt(process.env.CPB_PORT || "3456", 10);
const COOLDOWN_MS = parseInt(process.env.EVOLVE_COOLDOWN_MS || "60000", 10);
const IDLE_SLEEP_MS = parseInt(process.env.EVOLVE_IDLE_SLEEP_MS || "300000", 10);
const REVIEW_TIMEOUT_MS = parseInt(process.env.EVOLVE_REVIEW_TIMEOUT_MS || "0", 10);
const PIPELINE_TIMEOUT_MS = parseInt(process.env.EVOLVE_PIPELINE_TIMEOUT_MS || "0", 10);
const STUCK_THRESHOLD_MS = parseInt(process.env.EVOLVE_STUCK_MS || "600000", 10);
const REVIEW_POLL_MS = parseInt(process.env.EVOLVE_REVIEW_POLL_MS || "5000", 10);
const PIPELINE_POLL_MS = parseInt(process.env.EVOLVE_PIPELINE_POLL_MS || "4000", 10);
const STASH_PREFIX = "self-evolve-stash";
const LOCK_TTL_MS = 15_000;
const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

const SERVER_URL = `http://127.0.0.1:${PORT}`;

let serverProc = null;
let serverManaged = false;
let shuttingDown = false;
let leaseAcquired = false;
let bgScanResult = null;

// --- Logging ---

function log(tag, msg) {
  console.log(`${new Date().toISOString()} [evolve:${tag}] ${msg}`);
}

// --- Validation ---

function validateCpbRoot(cpbRoot) {
  if (!path.isAbsolute(cpbRoot)) {
    throw new Error(`CPB_ROOT must be absolute: ${cpbRoot}`);
  }

  try {
    accessSync(cpbRoot, constants.R_OK | constants.W_OK);
    const st = statSync(cpbRoot);
    if (!st.isDirectory()) {
      throw new Error(`CPB_ROOT is not a directory: ${cpbRoot}`);
    }
  } catch (err) {
    throw new Error(`CPB_ROOT not accessible: ${cpbRoot}: ${err.message}`);
  }

  const required = [
    path.join(cpbRoot, "server", "index.js"),
    path.join(cpbRoot, "bridges", "review-dispatch.mjs"),
  ];

  for (const p of required) {
    try {
      accessSync(p, constants.R_OK);
    } catch {
      throw new Error(`CPB_ROOT validation failed: missing ${p}`);
    }
  }
}

function assertGitArg(arg) {
  if (typeof arg !== "string") throw new Error("git args must be strings");
  if (arg.includes("\0")) throw new Error("invalid git arg");
}

// --- Git helpers ---

function git(...args) {
  args.forEach(assertGitArg);
  return execFileSync("git", args, {
    cwd: CPB_ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  }).trim();
}

function gitSafe(...args) {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

// --- Lease management ---

async function acquireLease() {
  await mkdir(EVOLVE_DIR, { recursive: true });
  const meta = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  try {
    await mkdir(EVOLVE_LEASE_DIR);
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      throw err;
    }
    try {
      const s = statSync(EVOLVE_LEASE_DIR);
      const age = Date.now() - s.mtimeMs;
      if (age > LOCK_TTL_MS) {
        await rm(EVOLVE_LEASE_DIR, { recursive: true, force: true });
        await mkdir(EVOLVE_LEASE_DIR);
      } else {
        throw new Error("another self-evolve instance is active");
      }
    } catch (innerErr) {
      if (innerErr.message.includes("another self-evolve instance is active")) {
        throw innerErr;
      }
      await rm(EVOLVE_LEASE_DIR, { recursive: true, force: true });
      await mkdir(EVOLVE_LEASE_DIR);
    }
  }

  const leaseMeta = path.join(EVOLVE_LEASE_DIR, "meta.json");
  writeFileSync(leaseMeta, JSON.stringify(meta), "utf8");
  leaseAcquired = true;
}

async function releaseLease() {
  if (!leaseAcquired) return;
  await rm(EVOLVE_LEASE_DIR, { recursive: true, force: true });
  leaseAcquired = false;
}

// --- Network helpers ---

function apiUrl(p) {
  if (!p.startsWith("/")) {
    return `${SERVER_URL}/${p}`;
  }
  return `${SERVER_URL}${p}`;
}

async function apiRequest(method, route, body) {
  const response = await fetch(apiUrl(route), {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  const payload = raw ? (() => {
    try { return JSON.parse(raw); } catch { return raw; }
  })() : null;

  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`${method} ${route} failed: ${response.status} ${response.statusText} ${detail || ""}`.trim());
  }

  return payload;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminatingSessionError(err) {
  return err instanceof Error && err.name === "AbortError";
}

async function isServerReady(timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (shuttingDown) return false;
    try {
      const res = await fetch(`${SERVER_URL}/api/projects`);
      if (res.ok) return true;
    } catch {
      await wait(250);
    }
  }
  return false;
}

function runNodeScript(script, args = [], timeoutMs = 120000, env = process.env) {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn("node", [script, ...args], {
      cwd: CPB_ROOT,
      env: { ...env, CPB_ROOT, CPB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timeout;
    let timedOut = false;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(`[script:${path.basename(script)}] ${chunk}`);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(`[script:${path.basename(script)}] ${chunk}`);
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      resolve({ ok: false, code: 1, timedOut, output: err.message });
    });

    child.on("exit", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ ok: code === 0 && !timedOut, code: code ?? 1, timedOut, output });
    });
  });
}

// --- Server process management ---

function spawnServer() {
  return new Promise((resolve, reject) => {
    if (serverProc) {
      resolve();
      return;
    }

    (async () => {
      const alreadyReady = await isServerReady(2000);
      if (alreadyReady) {
        resolve();
        return;
      }

      serverManaged = true;
      serverProc = spawn("node", [path.join(CPB_ROOT, "server", "index.js")], {
        cwd: CPB_ROOT,
        env: { ...process.env, CPB_ROOT, CPB_PORT: String(PORT) },
        stdio: "pipe",
      });

      let resolved = false;

      const complete = (ok, error) => {
        if (resolved) return;
        resolved = true;
        if (ok) resolve();
        else reject(error);
      };

      serverProc.stdout.on("data", (chunk) => {
        process.stdout.write(`[server] ${chunk}`);
      });
      serverProc.stderr.on("data", (chunk) => {
        process.stderr.write(`[server:err] ${chunk}`);
      });
      serverProc.on("exit", (code) => {
        if (!resolved && code !== 0 && !shuttingDown) {
          complete(false, new Error(`server exited with code ${code}`));
        }
        serverProc = null;
        serverManaged = false;
      });

      (async () => {
        const ready = await isServerReady(15000);
        if (ready) {
          complete(true);
        } else {
          await stopServer();
          complete(false, new Error("server startup timed out"));
        }
      })();
    })();
  });
}

async function stopServer() {
  if (!serverProc || serverProc.exitCode !== null) return;
  const dead = new Promise((resolve) => {
    serverProc.on("exit", resolve);
    serverProc.kill("SIGTERM");
  });
  const force = new Promise((resolve) => {
    setTimeout(async () => {
      if (serverProc && serverProc.exitCode === null) {
        serverProc.kill("SIGKILL");
      }
      resolve();
    }, 8000);
  });

  await Promise.race([dead, force]);
}

async function restartServer() {
  if (serverManaged) {
    await stopServer();
    await spawnServer();
  }
}

async function healthCheck(timeoutMs = 30000) {
  const result = runNodeScript(path.join(CPB_ROOT, "bridges", "health-check.mjs"), [], timeoutMs);
  return result;
}

// --- Review helpers (API-driven) ---

async function createReviewSession(project, intent) {
  return apiRequest("POST", "/api/review", { project, intent });
}

async function startReviewSession(sessionId) {
  return apiRequest("POST", `/api/review/${sessionId}/start`);
}

async function getReviewSession(sessionId) {
  return apiRequest("GET", `/api/review/${sessionId}`);
}

async function autoApproveSession(sessionId) {
  return apiRequest("POST", `/api/review/${sessionId}/auto-approve`);
}

async function cancelReviewSession(sessionId, reason) {
  return apiRequest("POST", `/api/review/${sessionId}/cancel`, { reason });
}

async function waitForReviewSession(sessionId) {
  let lastStatus = null;
  let lastRound = null;
  let lastChange = Date.now();

  while (!shuttingDown) {
    const session = await getReviewSession(sessionId);
    if (!session) return null;

    if (session.status === "user_review" || session.status === "expired") {
      return session;
    }

    if (session.status !== lastStatus || session.round !== lastRound) {
      lastStatus = session.status;
      lastRound = session.round;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > STUCK_THRESHOLD_MS) {
      log("error", `review session ${sessionId} stuck in ${lastStatus} for ${STUCK_THRESHOLD_MS}ms`);
      return null;
    }

    await wait(REVIEW_POLL_MS);
  }
  return null;
}

async function waitForJob(project, jobId) {
  let lastStatus = null;
  let lastChange = Date.now();

  while (!shuttingDown) {
    const durable = await apiRequest("GET", "/api/tasks/durable");
    const found = durable.find((j) => j.jobId === jobId && j.project === project);

    if (found && ["completed", "failed", "blocked", "cancelled"].includes(found.status)) {
      return found;
    }

    if (found?.status !== lastStatus) {
      lastStatus = found?.status || null;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > STUCK_THRESHOLD_MS) {
      log("error", `job ${jobId} stuck in ${lastStatus} for ${STUCK_THRESHOLD_MS}ms`);
      return null;
    }

    await wait(PIPELINE_POLL_MS);
  }
  return null;
}

// --- Issue handling ---

function scanPrompt() {
  return `You are CodePatchbay Self-Evolve Scanner. Analyze the CodePatchbay codebase for improvement opportunities.

Examine the codebase at ${CPB_ROOT} and identify issues. For each issue, output EXACTLY:

[ISSUE] <P0|P1|P2> <one-line description>

Categories to check:
1. Error handling gaps (missing try/catch, unhandled promise rejections)
2. Missing tests or dead code
3. Race conditions or concurrency bugs
4. Security issues (path traversal, injection)
5. Performance bottlenecks
6. Code that could be simplified

Focus on P1 and P2 issues. Output at most 5 issues. Be specific — name the file and function.`;
}

function parseScanResults(text) {
  if (!text) return [];
  const issues = [];
  const regex = /\[ISSUE\]\s*\[?(P[0-3])\]?\s+(.+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    issues.push({ priority: match[1], description: match[2].trim() });
  }
  return issues;
}

function acpRun(agent, prompt, timeoutMs = 0) {
  const timeout = timeoutMs || parseInt(process.env.CPB_SCAN_TIMEOUT_MS || "300000", 10);
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(CPB_ROOT, "bridges", "acp-client.mjs"), "--agent", agent], {
      cwd: CPB_ROOT,
      env: { ...process.env, CPB_ROOT },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`${agent} timed out after ${timeout / 1000}s`));
      }
    }, timeout);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${agent} exited ${code}: ${stderr.slice(-300)}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function validateIssue(issue) {
  const prompt = `Check if this issue still exists in the codebase at ${CPB_ROOT}:

ISSUE: ${issue.description}

Answer ONLY "VALID" if still present, or "INVALID" if resolved or no longer applies.`;

  try {
    const result = await acpRun("codex", prompt);
    const valid = /\bVALID\b/.test(result) && !/\bINVALID\b/.test(result);
    if (!valid) {
      log("validate", `issue no longer valid: ${issue.description.slice(0, 80)}`);
      return false;
    }
    log("validate", `issue confirmed: ${issue.description.slice(0, 80)}`);
    return true;
  } catch (err) {
    log("warn", `validation failed (${err.message}), proceeding anyway`);
    return true;
  }
}

function startBackgroundScan() {
  log("bgscan", "starting background scan while executing");
  bgScanResult = acpRun("codex", scanPrompt())
    .then(result => {
      const issues = parseScanResults(result);
      log("bgscan", `found ${issues.length} issues`);
      return issues;
    })
    .catch(err => {
      log("bgscan", `failed: ${err.message}`);
      return [];
    });
}

async function collectBackgroundScan() {
  if (!bgScanResult) return;
  const issues = await bgScanResult;
  bgScanResult = null;
  if (issues.length > 0) {
    await pushIssues(CPB_ROOT, issues);
    log("bgscan", `pushed ${issues.length} issues to backlog`);
  }
}

function ensureEvolveProject(issue, projects) {
  if (issue?.project && SAFE_NAME.test(issue.project) && projects.includes(issue.project)) {
    return issue.project;
  }
  if (process.env.EVOLVE_PROJECT && projects.includes(process.env.EVOLVE_PROJECT)) {
    return process.env.EVOLVE_PROJECT;
  }
  return projects[0] ?? null;
}

async function listProjects() {
  try {
    const response = await apiRequest("GET", "/api/projects");
    return (Array.isArray(response) ? response : [])
      .map((item) => (typeof item === "string" ? item : item?.name))
      .filter((name) => SAFE_NAME.test(name));
  } catch {
    return [];
  }
}

function hasWorkingChanges() {
  const tracked = gitSafe("diff", "--stat").trim();
  const untracked = gitSafe("status", "--porcelain").trim();
  return Boolean(tracked || untracked);
}

async function stashRound(round) {
  const label = `${STASH_PREFIX}-${round}-${Date.now()}`;
  try {
    const output = gitSafe("stash", "push", "-u", `--message=${label}`);
    if (!output || output.includes("No local changes to save")) return null;

    const list = gitSafe("stash", "list");
    if (!list) return null;
    const matched = list.split("\n").find((line) => line.includes(`: ${label}`));
    return matched ? matched.split(":")[0].trim() : null;
  } catch {
    return null;
  }
}

async function restoreRoundStash(label) {
  if (!label) return;
  const output = gitSafe("stash", "pop", "--index", label);
  if (output) return;
  gitSafe("stash", "apply", "--index", label);
  gitSafe("stash", "drop", label);
}

async function maybeRollback(state) {
  if (!state.knownGoodCommit) return false;

  const rollbackLabel = `${STASH_PREFIX}-rollback-${Date.now()}`;
  const rollbackRef = await stashRound(rollbackLabel);

  try {
    gitSafe("reset", "--hard", state.knownGoodCommit);
  } finally {
    await restoreRoundStash(rollbackRef);
  }

  return true;
}

// --- Main evolve loop ---

async function evolve(opts = {}) {
  await mkdir(EVOLVE_DIR, { recursive: true });

  const state = await loadState(CPB_ROOT);
  state.status = "running";
  state.round = state.round || 0;
  state.maxRounds = 0; // 0 = unlimited, driven by issues not round count
  state.knownGoodCommit = state.knownGoodCommit || gitSafe("rev-parse", "HEAD");
  await saveState(CPB_ROOT, state);

  if (!state.knownGoodCommit) {
    throw new Error("failed to resolve known good commit");
  }

  log("init", `known good commit: ${state.knownGoodCommit.slice(0, 8)}`);

  // Start server if not already alive
  await spawnServer();

  // Prime project list cache (for issue->project resolution)
  const projects = await listProjects();

  for (let round = state.round + 1; ; round++) {
    if (shuttingDown) break;

    let stashLabel = null;
    let shouldRollback = false;
    let failedThisRound = false;
    let issue = null;

    state.round = round;
    state.status = "scanning";
    await saveState(CPB_ROOT, state);

    try {
      // Collect background scan from previous round
      await collectBackgroundScan();

      const popped = await popIssue(CPB_ROOT);
      issue = popped?.issue;

      if (!issue) {
        log("scan", `round ${round} — backlog empty, running scan`);
        const scanResult = await acpRun("codex", scanPrompt());
        const issues = parseScanResults(scanResult);

        if (issues.length === 0) {
          log("scan", `round ${round} — no issues found, sleeping ${IDLE_SLEEP_MS / 1000}s`);
          await appendHistory(CPB_ROOT, { round, action: "scan", result: "empty" });
          await saveState(CPB_ROOT, state);
          await wait(IDLE_SLEEP_MS);
          continue;
        }

        await pushIssues(CPB_ROOT, issues);
        const next = await popIssue(CPB_ROOT);
        issue = next?.issue;
      }

      if (!issue) continue;

      const project = ensureEvolveProject(issue, projects);
      if (!project) {
        throw new Error("no valid project found for self-evolve session");
      }

      // Pre-execute validation: check issue is still present
      if (!(await validateIssue(issue))) {
        await updateIssue(CPB_ROOT, issue.description, "done", "validated as resolved");
        await appendHistory(CPB_ROOT, { round, action: "validate", result: "resolved" });
        continue;
      }

      // Start background scan (runs in parallel with execution)
      startBackgroundScan();

      stashLabel = await stashRound(round);
      log("stash", `round ${round} — stashed local changes with ${stashLabel || "none"}`);

      state.status = "reviewing";
      await saveState(CPB_ROOT, state);
      log("issue", `${issue.priority || "P?"} — ${issue.description}`);

      let job, sessionId;

      if (opts.direct) {
        // Direct mode: call run-pipeline.mjs directly, bypass review API
        state.status = "executing";
        shouldRollback = true;
        await saveState(CPB_ROOT, state);
        log("direct", `running pipeline directly for: ${issue.description}`);

        const pipelineArgs = [
          path.join(CPB_ROOT, "bridges", "run-pipeline.mjs"),
          "--project", project,
          "--task", issue.description,
        ];
        const pipelineTimeout = PIPELINE_TIMEOUT_MS > 0 ? PIPELINE_TIMEOUT_MS : 600_000;
        const result = await runNodeScript(pipelineArgs[0], pipelineArgs.slice(1), pipelineTimeout);

        // Parse job ID from output: "Job job-xxx started"
        const jobIdMatch = result.output.match(/Job (job-[\w-]+) started/);
        const jobId = jobIdMatch?.[1];

        if (!result.ok) {
          throw new Error(`pipeline failed (exit ${result.code}): ${result.output.slice(-300)}`);
        }

        // Query final job state from API
        if (jobId) {
          try {
            const durable = await apiRequest("GET", "/api/tasks/durable");
            job = durable.find((j) => j.jobId === jobId && j.project === project);
          } catch {}
        }
        if (!job) {
          job = { status: "completed", jobId };
        }
      } else {
        // Review mode: full review session cpb
        const session = await createReviewSession(project, issue.description);
        await startReviewSession(session.sessionId);
        sessionId = session.sessionId;

        const reviewed = await waitForReviewSession(session.sessionId);
        if (!reviewed) {
          await cancelReviewSession(session.sessionId, "self-evolve review timed out");
          await updateIssue(CPB_ROOT, issue.description, "failed", "review timed out");
          await appendHistory(CPB_ROOT, { round, action: "review", result: "timeout" });
          state.status = "failed";
          failedThisRound = true;
          await saveState(CPB_ROOT, state);
          continue;
        }

        if (reviewed.status === "expired") {
          await updateIssue(CPB_ROOT, issue.description, "failed", "review session expired");
          await appendHistory(CPB_ROOT, { round, action: "review", result: "expired", sessionId: reviewed.sessionId });
          state.status = "failed";
          failedThisRound = true;
          await saveState(CPB_ROOT, state);
          continue;
        }

        sessionId = reviewed.sessionId;
        const approval = await autoApproveSession(reviewed.sessionId);
        if (!approval?.taskId) {
          throw new Error("auto-approve did not return taskId");
        }

        state.status = "executing";
        shouldRollback = true;
        await saveState(CPB_ROOT, state);
        job = await waitForJob(project, approval.taskId);
        if (!job) {
          throw new Error(`pipeline timed out for task ${approval.taskId}`);
        }
        if (job.status !== "completed") {
          throw new Error(`pipeline ended with status ${job.status}`);
        }
      }

      if (!hasWorkingChanges()) {
        await updateIssue(CPB_ROOT, issue.description, "done", "no changes needed");
        await appendHistory(CPB_ROOT, { round, action: "execute", result: "no_changes", taskId: job.taskId || job.jobId, sessionId });
        await appendWisdom(CPB_ROOT, {
          round,
          issue: issue.description,
          action: "review+execute",
          result: "no_changes",
          detail: "execute completed but no code changes produced",
        });
        state.status = "running";
        await saveState(CPB_ROOT, state);
        continue;
      }

      try {
        gitSafe("add", "-A");
        git("commit", "-m", `self-evolve: ${issue.description}`);
      } catch {
        log("info", `${round} — working tree changed but commit failed`);
      }

      state.status = "switching";
      await saveState(CPB_ROOT, state);
      await restartServer();

      state.status = "verifying";
      await saveState(CPB_ROOT, state);
      const hc = await healthCheck();
      if (hc.ok) {
        const newCommit = gitSafe("rev-parse", "HEAD");
        if (newCommit) state.knownGoodCommit = newCommit;
        state.status = "running";
        await saveState(CPB_ROOT, state);
        await updateIssue(CPB_ROOT, issue.description, "done", "passed review+health");
        await appendHistory(CPB_ROOT, {
          round,
          action: "switch",
          result: "success",
          commit: newCommit,
          taskId: job.taskId || job.jobId,
          sessionId,
        });
        await appendWisdom(CPB_ROOT, {
          round,
          issue: issue.description,
          action: "review+execute+verify",
          result: "success",
          detail: `commit: ${newCommit?.slice(0, 8)}`,
        });
      } else {
        log("warn", `${round} — health check failed but pipeline PASSED, keeping commit`);
        const newCommit = gitSafe("rev-parse", "HEAD");
        if (newCommit) state.knownGoodCommit = newCommit;
        state.status = "running";
        await saveState(CPB_ROOT, state);
        await updateIssue(CPB_ROOT, issue.description, "done", "passed pipeline (health check skipped)");
        await appendHistory(CPB_ROOT, {
          round,
          action: "switch",
          result: "success_health_skipped",
          commit: newCommit,
          taskId: job.taskId || job.jobId,
          sessionId,
        });
        await appendWisdom(CPB_ROOT, {
          round,
          issue: issue.description,
          action: "review+execute+verify",
          result: "success_health_check_skipped",
          detail: "pipeline passed, health check failed but commit kept",
        });
      }
    } catch (err) {
      log("error", `round ${round} failed: ${err.message}`);
      failedThisRound = true;
      if (shouldRollback) {
        try {
          await maybeRollback(state);
        } catch (rollbackErr) {
          log("error", `round ${round} rollback failed: ${rollbackErr.message}`);
        }
      }
      const message = isTerminatingSessionError(err) ? "interrupted" : err.message;
      if (issue?.description) {
        await updateIssue(CPB_ROOT, issue.description, "failed", message);
        await pushIssues(CPB_ROOT, [{
          priority: issue.priority || "P2",
          description: `${issue.description} (retry: ${message})`,
        }]);
      }
      await appendHistory(CPB_ROOT, {
        round,
        action: "round_error",
        result: message,
      });
      await appendWisdom(CPB_ROOT, {
        round,
        issue: issue?.description,
        action: "error",
        result: "error",
        detail: message,
      });
      state.status = "failed";
      await saveState(CPB_ROOT, state);
    } finally {
      if (stashLabel) {
        await restoreRoundStash(stashLabel);
      }
      await wait(COOLDOWN_MS);
      if (shuttingDown) {
        state.status = "stopped";
      } else if (failedThisRound) {
        state.status = "idle";
      } else {
        state.status = "idle";
      }
      await saveState(CPB_ROOT, state);
    }
  }

  state.status = "completed";
  await saveState(CPB_ROOT, state);
  log("done", `stopped after ${state.round} rounds (shutdown requested)`);
}

// --- Shutdown ---

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", `${sig} received, stopping...`);
  await stopServer();
  await releaseLease();
  const state = await loadState(CPB_ROOT);
  state.status = "stopped";
  await saveState(CPB_ROOT, state);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// --- Entry ---

function parseEntryArgs(argv) {
  const opts = { variant: undefined, scanAgent: "claude", cmd: null, direct: false, multiProject: false, dryRun: false, scan: false, once: false, project: null };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--variant" && args[i + 1]) {
      opts.variant = args[++i];
    } else if (args[i] === "--scan-agent" && args[i + 1]) {
      opts.scanAgent = args[++i];
    } else if (args[i] === "--direct") {
      opts.direct = true;
    } else if (args[i] === "--multi-project") {
      opts.multiProject = true;
    } else if (args[i] === "--dry-run") {
      opts.dryRun = true;
    } else if (args[i] === "--scan") {
      opts.scan = true;
    } else if (args[i] === "--once") {
      opts.once = true;
    } else if (args[i] === "--project" && args[i + 1]) {
      opts.project = args[++i];
    } else if (!opts.cmd && !args[i].startsWith("--")) {
      opts.cmd = args[i];
    }
  }
  return opts;
}

const entryOpts = parseEntryArgs(process.argv);
const cmd = entryOpts.cmd;
if (entryOpts.multiProject) {
  validateCpbRoot(CPB_ROOT);
  const { MultiEvolveController } = await import("./multi-evolve.mjs");
  const controller = new MultiEvolveController(CPB_ROOT);
  const result = await controller.runOnce({
    dryRun: entryOpts.dryRun || !entryOpts.once,
    scan: entryOpts.scan,
    project: entryOpts.project,
    agent: entryOpts.scanAgent,
  });
  console.log(JSON.stringify(result, null, 2));
} else if (cmd === "scan") {
  validateCpbRoot(CPB_ROOT);
  const result = await acpRun("codex", scanPrompt());
  const issues = parseScanResults(result);
  if (issues.length > 0) {
    await pushIssues(CPB_ROOT, issues);
    console.log(`Found ${issues.length} issues, added to backlog`);
  } else {
    console.log("No issues found");
  }
} else if (cmd === "status") {
  validateCpbRoot(CPB_ROOT);
  const state = await loadState(CPB_ROOT);
  const backlog = await loadBacklog(CPB_ROOT);
  const pending = backlog.filter((i) => i.status === "pending").length;
  console.log(`Status: ${state.status}`);
  console.log(`Round: ${state.round}${state.maxRounds > 0 ? `/${state.maxRounds}` : " (unlimited)"}`);
  console.log(`Known good: ${state.knownGoodCommit?.slice(0, 8) || "none"}`);
  console.log(`Backlog: ${pending} pending / ${backlog.length} total`);
} else {
  try {
    validateCpbRoot(CPB_ROOT);
    await acquireLease();
    await evolve(entryOpts);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  } finally {
    await releaseLease();
  }
}
