#!/usr/bin/env node
// e2e-npm-pack.mjs — One-shot E2E: pack → install → doctor → hub → enqueue → worker → verify
// Usage: node scripts/e2e-npm-pack.mjs [--keep-state] [--project flow]
import { execSync, spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const KEEP_STATE = args.includes("--keep-state");
const PROJECT = args.find((a) => !a.startsWith("--")) || "flow";
const ROOT = path.resolve(import.meta.dirname, "..");
const CPB_ROOT = ROOT;
const HUB_ROOT = path.join(homedir(), ".cpb");
const PKG_NAME = "codepatchbay";
const TGZ = `${PKG_NAME}-0.2.0.tgz`;
const GITHUB_REPO = "changw98ic/codepatchbay";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const YELLOW = "\x1b[0;33m";
const CYAN = "\x1b[0;36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function log(tag, msg) {
  console.log(`${CYAN}[${tag}]${RESET} ${msg}`);
}

function pass(msg) {
  console.log(`${GREEN}  PASS${RESET} ${msg}`);
}

function fail(msg) {
  console.log(`${RED}  FAIL${RESET} ${msg}`);
}

function run(cmd, opts = {}) {
  try {
    const result = execSync(cmd, {
      encoding: "utf8",
      cwd: opts.cwd || ROOT,
      timeout: opts.timeout || 120_000,
      stdio: opts.silent ? "pipe" : "inherit",
      env: { ...process.env, ...opts.env },
    });
    return { ok: true, stdout: result?.trim() || "" };
  } catch (e) {
    if (opts.allowFail) return { ok: false, stdout: e.stdout?.trim() || "", stderr: e.stderr?.trim() || "" };
    fail(`${cmd}`);
    if (e.stderr) console.error(e.stderr.substring(0, 500));
    if (opts.fatal !== false) process.exit(1);
    return { ok: false };
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Step 1: Stop everything ───────────────────────────────────────
function stepStop() {
  log("STOP", "Stopping hub, daemon, and coderag...");
  run("cpb hub stop", { allowFail: true, silent: true });
  run("cpb daemon stop", { allowFail: true, silent: true });
  run("cpb coderag stop", { allowFail: true, silent: true });
  // Kill leftover codex-acp processes from previous sessions
  try { execSync(`pkill -f "codex-acp.*plugins" 2>/dev/null || true`, { stdio: "pipe" }); } catch {}
  pass("Stopped all services");
}

// ─── Step 2: Clean state ───────────────────────────────────────────
function stepClean() {
  if (KEEP_STATE) {
    log("CLEAN", "Skipping state cleanup (--keep-state)");
    return;
  }
  log("CLEAN", "Resetting to fresh-install state...");

  const projectRuntime = path.join(HUB_ROOT, "projects", PROJECT);
  const dirs = [
    path.join(HUB_ROOT, "queue"),
    path.join(HUB_ROOT, "state"),
    path.join(projectRuntime, "events"),
    path.join(projectRuntime, "leases"),
    path.join(projectRuntime, "jobs"),
    path.join(projectRuntime, "agent-homes"),
    path.join(CPB_ROOT, "cpb-task", "daemon"),
    path.join(CPB_ROOT, "cpb-task", "event-sources"),
    path.join(CPB_ROOT, "cpb-task", "coderag-state.json"),
  ];
  const files = [
    path.join(CPB_ROOT, "cpb-task", "jobs-index.json"),
    path.join(HUB_ROOT, "github", "issues.json"),
  ];

  for (const d of dirs) {
    if (existsSync(d)) {
      rmSync(d, { recursive: true, force: true });
    }
  }
  for (const f of files) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
  pass("State cleaned");
}

// ─── Step 3: npm pack + global install ─────────────────────────────
function stepPack() {
  log("PACK", "Building and packing...");
  // Clean old tarball
  const tgzPath = path.join(ROOT, TGZ);
  if (existsSync(tgzPath)) rmSync(tgzPath, { force: true });

  run("npm pack --silent", { cwd: ROOT, timeout: 120_000 });
  if (!existsSync(tgzPath)) { fail("Tarball not found"); process.exit(1); }

  log("INSTALL", "Installing globally...");
  run(`npm install -g ${tgzPath}`, { cwd: ROOT, timeout: 120_000 });
  pass("Packed and installed globally");
}

// ─── Step 4: Doctor ────────────────────────────────────────────────
function stepDoctor() {
  log("DOCTOR", "Running health check...");
  const r = run("cpb doctor --json", { silent: true });
  if (!r.ok) {
    fail("Doctor check failed");
    console.log(r.stdout?.substring(0, 500));
    process.exit(1);
  }
  try {
    const data = JSON.parse(r.stdout);
    if (data.errors?.length > 0) {
      fail(`Doctor errors: ${data.errors.join(", ")}`);
      process.exit(1);
    }
  } catch {}
  pass("Doctor passed");
}

// ─── Step 5: Ensure project registered ─────────────────────────────
function stepProject() {
  log("PROJECT", `Ensuring project '${PROJECT}' is registered...`);
  run(`cpb attach ${ROOT} ${PROJECT}`, { allowFail: true, silent: true });
  pass("Project registered");
}

// ─── Step 5.5: Bind GitHub + configure automation ──────────────────
function stepGithub() {
  log("GITHUB", `Binding repo ${GITHUB_REPO} to project '${PROJECT}'...`);
  run(`cpb github bind ${PROJECT} ${GITHUB_REPO}`, { silent: true, allowFail: true });

  log("GITHUB", "Configuring automation (label: cpb)...");
  run(`cpb config ${PROJECT} --automation-enabled true`, { silent: true, allowFail: true });
  run(`cpb config ${PROJECT} --automation-rule 'match.labels=cpb;action.workflow=standard;action.priority=P2'`, { silent: true, allowFail: true });
  pass("GitHub bound and automation configured");
}

// ─── Step 6: Start hub ─────────────────────────────────────────────
async function stepHub() {
  log("HUB", "Starting hub...");
  run("cpb hub start", { timeout: 30_000 });
  await wait(3000);

  const r = run("cpb hub status", { silent: true });
  if (!r.ok || !r.stdout.includes("alive")) {
    fail("Hub not alive after start");
    process.exit(1);
  }
  pass("Hub started and alive");
}

// ─── Step 7: Sync and enqueue GitHub issues ────────────────────────
function stepEnqueue() {
  log("ENQUEUE", "Syncing GitHub issues...");
  const sync = run("cpb hub github-sync", { silent: true, allowFail: true });
  if (!sync.ok) {
    log("ENQUEUE", "GitHub sync skipped (no gh auth or no repo bound)");
    return false;
  }

  log("ENQUEUE", `Enqueueing issues for ${PROJECT}...`);
  const dry = run(`cpb hub enqueue-issues ${PROJECT} --sync-first --dry-run`, { silent: true, allowFail: true });
  if (dry.ok && dry.stdout) {
    log("ENQUEUE", `Dry run: ${dry.stdout.substring(0, 200)}`);
  }

  const enq = run(`cpb hub enqueue-issues ${PROJECT} --sync-first`, { silent: true, allowFail: true });
  if (!enq.ok) {
    fail("Enqueue failed");
    return false;
  }
  pass("Issues enqueued");
  return true;
}

// ─── Step 8: Start worker ──────────────────────────────────────────
async function stepWorker() {
  log("WORKER", "Starting worker daemon...");
  run("cpb daemon start --workers 1", { timeout: 30_000 });
  await wait(2000);

  const r = run("cpb hub status", { silent: true });
  if (r.ok) {
    const match = r.stdout.match(/(\d+)\s+online/);
    if (match && parseInt(match[1]) > 0) {
      pass(`Worker online (${match[1]})`);
      return;
    }
  }
  log("WORKER", `${YELLOW}Worker not yet detected, continuing...${RESET}`);
}

// ─── Step 9: Monitor pipeline ──────────────────────────────────────
async function stepMonitor() {
  log("MONITOR", "Waiting for pipeline to complete (max 15min)...");

  const deadline = Date.now() + 15 * 60 * 1000;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const r = run(`cpb status ${PROJECT}`, { silent: true, allowFail: true });
    const status = r.stdout || "";

    if (status !== lastStatus) {
      lastStatus = status;
      const lines = status.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        if (line.includes("Latest job")) {
          log("MONITOR", line.replace(/\x1b\[[0-9;]*m/g, "").trim());
        }
      }
    }

    // Check for completion
    if (status.includes("completed")) {
      pass("Pipeline completed!");
      return printSummary();
    }
    if (status.includes("failed")) {
      fail("Pipeline failed");
      return printSummary();
    }
    if (status.includes("blocked")) {
      fail("Pipeline blocked");
      return printSummary();
    }

    await wait(10000);
  }

  fail("Pipeline timed out after 15 minutes");
}

// ─── Summary ───────────────────────────────────────────────────────
function printSummary() {
  console.log("");
  log("SUMMARY", `${BOLD}E2E Test Results${RESET}`);

  // Check latest job
  const r = run(`cpb status ${PROJECT}`, { silent: true, allowFail: true });
  if (r.ok) console.log(r.stdout);

  // Check queue status
  const q = run("cpb hub queue-status", { silent: true, allowFail: true });
  if (q.ok) console.log(q.stdout);

  // Check latest session for MCP usage
  log("MCP", "Checking if Codex used MCP tools...");
  try {
    const sessionDir = path.join(homedir(), ".codex", "sessions");
    const { readdirSync, statSync } = await import("node:fs");
    let latestSession = null;
    let latestTime = 0;
    const today = new Date();
    const datePath = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}`;
    const dayDir = path.join(sessionDir, datePath);
    if (existsSync(dayDir)) {
      for (const f of readdirSync(dayDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const st = statSync(path.join(dayDir, f));
        if (st.mtimeMs > latestTime) {
          latestTime = st.mtimeMs;
          latestSession = path.join(dayDir, f);
        }
      }
    }
    if (latestSession) {
      const content = readFileSync(latestSession, "utf8");
      const mcpCalls = (content.match(/codebase_search/g) || []).length;
      const execCalls = (content.match(/"name":"exec_command"/g) || []).length;
      if (mcpCalls > 0) {
        pass(`Codex used codebase_search ${mcpCalls} time(s), exec_command ${execCalls} time(s)`);
      } else {
        fail(`Codex did NOT use codebase_search (exec_command: ${execCalls})`);
      }
    } else {
      log("MCP", "No recent Codex session found");
    }
  } catch (e) {
    log("MCP", `Could not check MCP usage: ${e.message}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`${BOLD}═══════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  CPB E2E Test: npm pack → pipeline${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════${RESET}`);
  console.log(`  Project: ${PROJECT}`);
  console.log(`  Root:    ${ROOT}`);
  console.log(`  Hub:     ${HUB_ROOT}`);
  console.log(`${BOLD}═══════════════════════════════════════════${RESET}\n`);

  const t0 = Date.now();

  stepStop();
  stepClean();
  stepPack();
  stepDoctor();
  stepProject();
  stepGithub();
  await stepHub();
  const hasIssues = stepEnqueue();
  if (!hasIssues) {
    log("SKIP", "No GitHub issues to enqueue. Pipeline cannot run without issues.");
    log("HINT", "Make sure the project has a GitHub repo bound and open issues with matching labels.");
    run("cpb hub stop", { silent: true, allowFail: true });
    process.exit(0);
  }
  await stepWorker();
  await stepMonitor();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n${BOLD}Total time: ${elapsed}s${RESET}`);

  // Cleanup
  log("TEARDOWN", "Stopping services...");
  run("cpb daemon stop", { silent: true, allowFail: true });
  run("cpb hub stop", { silent: true, allowFail: true });
}

main().catch((e) => {
  fail(`Unhandled: ${e.message}`);
  process.exit(1);
});
