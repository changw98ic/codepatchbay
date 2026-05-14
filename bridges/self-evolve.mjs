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
  appendHistory,
} from "../server/services/evolve-state.js";

const FLOW_ROOT = path.resolve(process.env.FLOW_ROOT || process.cwd());
const EVOLVE_DIR = path.join(FLOW_ROOT, "flow-task", "self-evolve");
const EVOLVE_LEASE_DIR = path.join(EVOLVE_DIR, ".controller-lock");
const PORT = parseInt(process.env.FLOW_PORT || "3456", 10);
const COOLDOWN_MS = parseInt(process.env.EVOLVE_COOLDOWN_MS || "60000", 10);
const MAX_ROUNDS = parseInt(process.env.EVOLVE_MAX_ROUNDS || "50", 10);
const REVIEW_TIMEOUT_MS = parseInt(process.env.EVOLVE_REVIEW_TIMEOUT_MS || "1800000", 10);
const PIPELINE_TIMEOUT_MS = parseInt(process.env.EVOLVE_PIPELINE_TIMEOUT_MS || "600000", 10);
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

// --- Logging ---

function log(tag, msg) {
  console.log(`${new Date().toISOString()} [evolve:${tag}] ${msg}`);
}

// --- Validation ---

function validateFlowRoot(flowRoot) {
  if (!path.isAbsolute(flowRoot)) {
    throw new Error(`FLOW_ROOT must be absolute: ${flowRoot}`);
  }

  try {
    accessSync(flowRoot, constants.R_OK | constants.W_OK);
    const st = statSync(flowRoot);
    if (!st.isDirectory()) {
      throw new Error(`FLOW_ROOT is not a directory: ${flowRoot}`);
    }
  } catch (err) {
    throw new Error(`FLOW_ROOT not accessible: ${flowRoot}: ${err.message}`);
  }

  const required = [
    path.join(flowRoot, "server", "index.js"),
    path.join(flowRoot, "bridges", "review-dispatch.mjs"),
  ];

  for (const p of required) {
    try {
      accessSync(p, constants.R_OK);
    } catch {
      throw new Error(`FLOW_ROOT validation failed: missing ${p}`);
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
    cwd: FLOW_ROOT,
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
      cwd: FLOW_ROOT,
      env: { ...env, FLOW_ROOT, FLOW_PORT: String(PORT) },
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
      serverProc = spawn("node", [path.join(FLOW_ROOT, "server", "index.js")], {
        cwd: FLOW_ROOT,
        env: { ...process.env, FLOW_ROOT, FLOW_PORT: String(PORT) },
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
  const result = runNodeScript(path.join(FLOW_ROOT, "bridges", "health-check.mjs"), [], timeoutMs);
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

async function waitForReviewSession(sessionId, timeoutMs = REVIEW_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return null;
    const session = await getReviewSession(sessionId);
    if (session.status === "user_review" || session.status === "expired") {
      return session;
    }
    await wait(REVIEW_POLL_MS);
  }
  return null;
}

async function waitForJob(project, jobId, timeoutMs = PIPELINE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return null;

    const durable = await apiRequest("GET", "/api/tasks/durable");
    const found = durable.find((j) => j.jobId === jobId && j.project === project);
    if (found && ["completed", "failed", "blocked", "cancelled"].includes(found.status)) {
      return found;
    }
    await wait(PIPELINE_POLL_MS);
  }
  return null;
}

// --- Issue handling ---

function scanPrompt() {
  return `You are Flow Self-Evolve Scanner. Analyze the Flow codebase for improvement opportunities.

Examine the codebase at ${FLOW_ROOT} and identify issues. For each issue, output EXACTLY:

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

function acpRun(agent, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(FLOW_ROOT, "bridges", "acp-client.mjs"), "--agent", agent], {
      cwd: FLOW_ROOT,
      env: { ...process.env, FLOW_ROOT },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${agent} exited ${code}: ${stderr.slice(-300)}`));
    });
    child.on("error", reject);

    child.stdin.write(prompt);
    child.stdin.end();
  });
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

async function evolve() {
  await mkdir(EVOLVE_DIR, { recursive: true });

  const state = await loadState(FLOW_ROOT);
  state.status = "running";
  state.round = state.round || 0;
  state.maxRounds = MAX_ROUNDS;
  state.knownGoodCommit = state.knownGoodCommit || gitSafe("rev-parse", "HEAD");
  await saveState(FLOW_ROOT, state);

  if (!state.knownGoodCommit) {
    throw new Error("failed to resolve known good commit");
  }

  log("init", `known good commit: ${state.knownGoodCommit.slice(0, 8)}`);

  // Start server if not already alive
  await spawnServer();

  // Prime project list cache (for issue->project resolution)
  const projects = await listProjects();

  for (let round = state.round + 1; round <= MAX_ROUNDS; round++) {
    if (shuttingDown) break;

    let stashLabel = null;
    let shouldRollback = false;
    let failedThisRound = false;
    let issue = null;

    state.round = round;
    state.status = "scanning";
    await saveState(FLOW_ROOT, state);

    try {
      const popped = await popIssue(FLOW_ROOT);
      issue = popped?.issue;

      if (!issue) {
        log("scan", `round ${round} — backlog empty, running scan`);
        const scanResult = await acpRun("codex", scanPrompt());
        const issues = parseScanResults(scanResult);

        if (issues.length === 0) {
          log("scan", `round ${round} — no issues found`);
          await appendHistory(FLOW_ROOT, { round, action: "scan", result: "empty" });
          await saveState(FLOW_ROOT, state);
          await wait(COOLDOWN_MS);
          continue;
        }

        await pushIssues(FLOW_ROOT, issues);
        const next = await popIssue(FLOW_ROOT);
        issue = next?.issue;
      }

      if (!issue) continue;

      const project = ensureEvolveProject(issue, projects);
      if (!project) {
        throw new Error("no valid project found for self-evolve session");
      }

      stashLabel = await stashRound(round);
      log("stash", `${round}/${MAX_ROUNDS} — stashed local changes with ${stashLabel || "none"}`);

      state.status = "reviewing";
      await saveState(FLOW_ROOT, state);
      log("issue", `${issue.priority || "P?"} — ${issue.description}`);

      const session = await createReviewSession(project, issue.description);
      await startReviewSession(session.sessionId);

      const reviewed = await waitForReviewSession(session.sessionId);
      if (!reviewed) {
        await updateIssue(FLOW_ROOT, issue.description, "failed", "review timed out");
        await appendHistory(FLOW_ROOT, { round, action: "review", result: "timeout" });
        state.status = "failed";
        failedThisRound = true;
        await saveState(FLOW_ROOT, state);
        continue;
      }

      if (reviewed.status === "expired") {
        await updateIssue(FLOW_ROOT, issue.description, "failed", "review session expired");
        await appendHistory(FLOW_ROOT, { round, action: "review", result: "expired", sessionId: reviewed.sessionId });
        state.status = "failed";
        failedThisRound = true;
        await saveState(FLOW_ROOT, state);
        continue;
      }

      const approval = await autoApproveSession(reviewed.sessionId);
      if (!approval?.taskId) {
        throw new Error("auto-approve did not return taskId");
      }

      state.status = "executing";
      shouldRollback = true;
      await saveState(FLOW_ROOT, state);
      const job = await waitForJob(project, approval.taskId);
      if (!job) {
        throw new Error(`pipeline timed out for task ${approval.taskId}`);
      }
      if (job.status !== "completed") {
        throw new Error(`pipeline ended with status ${job.status}`);
      }

      if (!hasWorkingChanges()) {
        await updateIssue(FLOW_ROOT, issue.description, "done", "no changes needed");
        await appendHistory(FLOW_ROOT, { round, action: "execute", result: "no_changes", taskId: job.taskId || job.jobId, sessionId: reviewed.sessionId });
        state.status = "running";
        await saveState(FLOW_ROOT, state);
        continue;
      }

      try {
        gitSafe("add", "-A");
        git("commit", "-m", `self-evolve: ${issue.description}`);
      } catch {
        log("info", `${round} — working tree changed but commit failed`);
      }

      state.status = "switching";
      await saveState(FLOW_ROOT, state);
      await restartServer();

      state.status = "verifying";
      await saveState(FLOW_ROOT, state);
      const hc = await healthCheck();
      if (hc.ok) {
        const newCommit = gitSafe("rev-parse", "HEAD");
        if (newCommit) state.knownGoodCommit = newCommit;
        state.status = "running";
        await saveState(FLOW_ROOT, state);
        await updateIssue(FLOW_ROOT, issue.description, "done", "passed review+health");
        await appendHistory(FLOW_ROOT, {
          round,
          action: "switch",
          result: "success",
          commit: newCommit,
          taskId: job.taskId || job.jobId,
          sessionId: reviewed.sessionId,
        });
      } else {
        state.status = "rolling_back";
        await saveState(FLOW_ROOT, state);
        await maybeRollback(state);
        await updateIssue(FLOW_ROOT, issue.description, "failed", "health check failed, rolled back");
        await appendHistory(FLOW_ROOT, {
          round,
          action: "rollback",
          result: "health_check_failed",
          commit: state.knownGoodCommit,
          taskId: job.taskId || job.jobId,
          sessionId: reviewed.sessionId,
        });
        state.status = "idle";
        await restartServer();
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
        await updateIssue(FLOW_ROOT, issue.description, "failed", message);
      }
      await appendHistory(FLOW_ROOT, {
        round,
        action: "round_error",
        result: message,
      });
      state.status = "failed";
      await saveState(FLOW_ROOT, state);
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
      await saveState(FLOW_ROOT, state);
    }
  }

  state.status = "completed";
  await saveState(FLOW_ROOT, state);
  log("done", `completed ${state.round} rounds`);
}

// --- Shutdown ---

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", `${sig} received, stopping...`);
  await stopServer();
  await releaseLease();
  const state = await loadState(FLOW_ROOT);
  state.status = "stopped";
  await saveState(FLOW_ROOT, state);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// --- Entry ---

const cmd = process.argv[2];
if (cmd === "scan") {
  validateFlowRoot(FLOW_ROOT);
  const result = await acpRun("codex", scanPrompt());
  const issues = parseScanResults(result);
  if (issues.length > 0) {
    await pushIssues(FLOW_ROOT, issues);
    console.log(`Found ${issues.length} issues, added to backlog`);
  } else {
    console.log("No issues found");
  }
} else if (cmd === "status") {
  validateFlowRoot(FLOW_ROOT);
  const state = await loadState(FLOW_ROOT);
  const backlog = await loadBacklog(FLOW_ROOT);
  const pending = backlog.filter((i) => i.status === "pending").length;
  console.log(`Status: ${state.status}`);
  console.log(`Round: ${state.round}/${state.maxRounds}`);
  console.log(`Known good: ${state.knownGoodCommit?.slice(0, 8) || "none"}`);
  console.log(`Backlog: ${pending} pending / ${backlog.length} total`);
} else {
  try {
    validateFlowRoot(FLOW_ROOT);
    await acquireLease();
    await evolve();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  } finally {
    await releaseLease();
  }
}
