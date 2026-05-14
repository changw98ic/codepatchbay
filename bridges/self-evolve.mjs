#!/usr/bin/env node

// Self-Evolve: immutable controller for autonomous self-improvement.
//
// This file must NEVER be modified by agents. It is the trust anchor.
// Version management: git commits. Process management: child_process.spawn.
// No external dependencies (no pm2, no systemd).

import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  loadState, saveState,
  loadBacklog, popIssue, pushIssues, updateIssue,
  appendHistory,
} from "../server/services/evolve-state.js";

const FLOW_ROOT = path.resolve(process.env.FLOW_ROOT || ".");
const EVOLVE_DIR = path.join(FLOW_ROOT, "flow-task", "self-evolve");
const ACP_CLIENT = path.join(FLOW_ROOT, "bridges", "acp-client.mjs");
const HEALTH_CHECK = path.join(FLOW_ROOT, "bridges", "health-check.mjs");
const PORT = parseInt(process.env.FLOW_PORT || "3456", 10);
const COOLDOWN_MS = parseInt(process.env.EVOLVE_COOLDOWN_MS || "60000", 10);
const MAX_ROUNDS = parseInt(process.env.EVOLVE_MAX_ROUNDS || "50", 10);

let serverProc = null;
let shuttingDown = false;

// --- Logging ---

function log(tag, msg) {
  console.log(`${new Date().toISOString()} [evolve:${tag}] ${msg}`);
}

// --- Git helpers ---

function git(...args) {
  return execFileSync("git", args, { cwd: FLOW_ROOT, encoding: "utf8" }).trim();
}

function gitSafe(...args) {
  try { return git(...args); } catch { return null; }
}

// --- ACP agent calls ---

function acpRun(agent, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [ACP_CLIENT, "--agent", agent], {
      cwd: FLOW_ROOT,
      env: { ...process.env, FLOW_ROOT },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${agent} exited ${code}: ${stderr.slice(-300)}`));
    });
    child.on("error", reject);
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// --- Server process management ---

function spawnServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn("node", [path.join(FLOW_ROOT, "server", "index.js")], {
      cwd: FLOW_ROOT,
      env: { ...process.env, FLOW_ROOT, FLOW_PORT: String(PORT) },
      stdio: "pipe",
    });
    let started = false;
    serverProc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[server] ${text}`);
      if (!started && text.includes("Flow UI server running")) {
        started = true;
        resolve();
      }
    });
    serverProc.stderr.on("data", (chunk) => process.stderr.write(`[server:err] ${chunk}`));
    serverProc.on("exit", (code) => {
      log("server", `exited with code ${code}`);
      serverProc = null;
    });
    // Timeout fallback — server may already be running on this port
    setTimeout(() => {
      if (!started) { started = true; resolve(); }
    }, 8000);
  });
}

async function stopServer() {
  if (!serverProc || serverProc.exitCode !== null) return;
  log("server", "stopping...");
  const dead = new Promise((resolve) => {
    serverProc.on("exit", resolve);
    serverProc.kill("SIGTERM");
  });
  const force = new Promise((resolve) => {
    setTimeout(() => {
      if (serverProc && serverProc.exitCode === null) serverProc.kill("SIGKILL");
      resolve();
    }, 10000);
  });
  await Promise.race([dead, force]);
}

async function restartServer() {
  await stopServer();
  await spawnServer();
}

// --- Health check ---

async function healthCheck(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/projects`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function runFullTests() {
  return new Promise((resolve) => {
    const child = spawn("node", ["--test", "tests/*.mjs"], {
      cwd: FLOW_ROOT, stdio: "pipe",
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("exit", (code) => resolve({ pass: code === 0, output }));
  });
}

async function buildFrontend() {
  return new Promise((resolve) => {
    const child = spawn("npx", ["vite", "build"], {
      cwd: path.join(FLOW_ROOT, "web"), stdio: "pipe",
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("exit", (code) => resolve({ pass: code === 0, output }));
  });
}

// --- Prompts ---

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

function fixPrompt(issue) {
  return `You are Flow Self-Evolve Fixer. Fix this issue in the Flow codebase at ${FLOW_ROOT}.

Issue: ${issue.description}
Priority: ${issue.priority}

Rules:
1. Only modify files directly related to the issue
2. Keep changes minimal and focused
3. Follow existing code patterns and conventions
4. Do NOT modify bridges/self-evolve.mjs or bridges/health-check.mjs
5. Do NOT add new dependencies
6. Write clean, simple code — no over-engineering

Make the fix now.`;
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

// --- Main evolve loop ---

async function evolve() {
  await mkdir(EVOLVE_DIR, { recursive: true });

  const state = await loadState(FLOW_ROOT);
  state.status = "starting";
  state.knownGoodCommit = state.knownGoodCommit || git("rev-parse", "HEAD");
  await saveState(FLOW_ROOT, state);
  log("init", `known good commit: ${state.knownGoodCommit.slice(0, 8)}`);

  // Start server
  log("server", "spawning...");
  await spawnServer();

  // Main loop
  for (let round = state.round + 1; round <= MAX_ROUNDS; round++) {
    if (shuttingDown) break;

    state.round = round;
    state.status = "scanning";
    await saveState(FLOW_ROOT, state);
    log("round", `${round}/${MAX_ROUNDS} — scanning for issues`);

    // Get next issue
    let { issue, backlog } = await popIssue(FLOW_ROOT);
    if (!issue) {
      log("scan", "backlog empty, running Codex scan");
      try {
        const scanResult = await acpRun("codex", scanPrompt());
        const issues = parseScanResults(scanResult);
        if (issues.length === 0) {
          log("scan", "no issues found, cooling down");
          await appendHistory(FLOW_ROOT, { round, action: "scan", result: "empty" });
          await new Promise((r) => setTimeout(r, COOLDOWN_MS));
          continue;
        }
        await pushIssues(FLOW_ROOT, issues);
        log("scan", `found ${issues.length} issues`);
        const popped = await popIssue(FLOW_ROOT);
        issue = popped.issue;
      } catch (err) {
        log("error", `scan failed: ${err.message}`);
        await appendHistory(FLOW_ROOT, { round, action: "scan", result: "error", error: err.message });
        await new Promise((r) => setTimeout(r, COOLDOWN_MS));
        continue;
      }
    }

    if (!issue) continue;
    log("fix", `${issue.priority} — ${issue.description}`);

    // Fix
    state.status = "fixing";
    await saveState(FLOW_ROOT, state);

    try {
      await acpRun("claude", fixPrompt(issue));
    } catch (err) {
      log("error", `fix failed: ${err.message}`);
      gitSafe("checkout", ".");
      await updateIssue(FLOW_ROOT, issue.description, "failed", err.message);
      await appendHistory(FLOW_ROOT, { round, action: "fix", result: "agent_error", error: err.message });
      continue;
    }

    // Test
    state.status = "testing";
    await saveState(FLOW_ROOT, state);

    const testResult = await runFullTests();
    if (!testResult.pass) {
      log("warn", "tests failed, discarding changes");
      gitSafe("checkout", ".");
      await updateIssue(FLOW_ROOT, issue.description, "failed", testResult.output.slice(-500));
      await appendHistory(FLOW_ROOT, { round, action: "test", result: "failed", output: testResult.output.slice(-500) });
      continue;
    }

    const buildResult = await buildFrontend();
    if (!buildResult.pass) {
      log("warn", "build failed, discarding changes");
      gitSafe("checkout", ".");
      await updateIssue(FLOW_ROOT, issue.description, "failed", buildResult.output.slice(-500));
      await appendHistory(FLOW_ROOT, { round, action: "build", result: "failed" });
      continue;
    }

    // Commit new version
    gitSafe("add", "-A");
    const commitMsg = `self-evolve: ${issue.description}`;
    try {
      git("commit", "-m", commitMsg);
    } catch {
      // Nothing to commit
      log("info", "no changes to commit");
      await updateIssue(FLOW_ROOT, issue.description, "done", "no changes needed");
      await appendHistory(FLOW_ROOT, { round, action: "commit", result: "no_changes" });
      continue;
    }

    const newCommit = git("rev-parse", "HEAD");
    log("commit", `new version at ${newCommit.slice(0, 8)}`);

    // Restart server with new code
    state.status = "switching";
    await saveState(FLOW_ROOT, state);

    await restartServer();

    // Health check
    state.status = "verifying";
    await saveState(FLOW_ROOT, state);

    log("health", "checking new version...");
    const healthy = await healthCheck(30000);

    if (healthy) {
      // Success — update known good
      state.knownGoodCommit = newCommit;
      state.status = "running";
      await saveState(FLOW_ROOT, state);
      await updateIssue(FLOW_ROOT, issue.description, "done");
      await appendHistory(FLOW_ROOT, { round, action: "switch", result: "success", commit: newCommit });
      log("success", `round ${round} — now at ${newCommit.slice(0, 8)}`);
    } else {
      // Rollback
      log("error", "health check failed — rolling back");
      await stopServer();
      git("reset", "--hard", state.knownGoodCommit);
      await spawnServer();

      // Verify rollback
      const rollbackOk = await healthCheck(15000);
      if (!rollbackOk) {
        log("critical", "rollback also failed — manual intervention needed");
        state.status = "broken";
        await saveState(FLOW_ROOT, state);
        break;
      }

      state.status = "running";
      await saveState(FLOW_ROOT, state);

      // Add rollback issue to backlog
      await pushIssues(FLOW_ROOT, [{
        priority: "P0",
        description: `[rollback] health check failed after: ${issue.description}`,
        source: "rollback",
      }]);

      await appendHistory(FLOW_ROOT, {
        round,
        action: "rollback",
        result: "health_check_failed",
        revertedCommit: newCommit,
      });

      log("rollback", `reverted to ${state.knownGoodCommit.slice(0, 8)}, issue re-queued`);
    }

    // Cooldown
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
  }

  // Loop ended
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
  // One-shot scan
  const result = await acpRun("codex", scanPrompt());
  const issues = parseScanResults(result);
  if (issues.length > 0) {
    await pushIssues(FLOW_ROOT, issues);
    console.log(`Found ${issues.length} issues, added to backlog`);
  } else {
    console.log("No issues found");
  }
  process.exit(0);
} else if (cmd === "status") {
  const state = await loadState(FLOW_ROOT);
  const backlog = await loadBacklog(FLOW_ROOT);
  const pending = backlog.filter((i) => i.status === "pending").length;
  console.log(`Status: ${state.status}`);
  console.log(`Round: ${state.round}/${state.maxRounds}`);
  console.log(`Known good: ${state.knownGoodCommit?.slice(0, 8) || "none"}`);
  console.log(`Backlog: ${pending} pending / ${backlog.length} total`);
  process.exit(0);
} else {
  // Full self-evolve loop
  evolve().catch((err) => {
    log("fatal", err.message);
    process.exit(1);
  });
}
