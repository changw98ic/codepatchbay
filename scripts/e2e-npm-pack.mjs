#!/usr/bin/env node
// e2e-npm-pack.mjs — One-shot E2E: pack → install → doctor → hub → enqueue → worker → verify
// Usage: node scripts/e2e-npm-pack.mjs [--keep-state] [--project flow]
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
const AUTOMATION_LABEL = process.env.CPB_E2E_LABEL || "cpb";
const TARGET_ISSUE_NUMBER = process.env.CPB_E2E_ISSUE_NUMBER
  ? String(process.env.CPB_E2E_ISSUE_NUMBER).replace(/^#/, "")
  : "";
const AGENT_MODE = (process.env.CPB_E2E_AGENT_MODE || "codex").toLowerCase();
const FINALIZER_MODE = process.env.CPB_E2E_FINALIZER_MODE || "remote";
const ACP_PHASE_TIMEOUT_MS = Number(process.env.CPB_E2E_ACP_PHASE_TIMEOUT_MS || 15 * 60 * 1000);
const DEFAULT_MONITOR_TIMEOUT_MS = Math.max(90 * 60 * 1000, ACP_PHASE_TIMEOUT_MS * 5 + 15 * 60 * 1000);
const MONITOR_TIMEOUT_MS = Number(process.env.CPB_E2E_MONITOR_TIMEOUT_MS || DEFAULT_MONITOR_TIMEOUT_MS);

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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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

function configureAgentRoute() {
  if (AGENT_MODE === "codex") {
    log("GITHUB", "Configuring deterministic ACP agent route (codex all phases)...");
    run(`cpb config ${PROJECT} --agent codex`, { silent: true });
    return { description: "codex all phases", expected: ["default: codex"] };
  }

  if (AGENT_MODE === "claude" || AGENT_MODE === "cc") {
    log("GITHUB", "Configuring deterministic ACP agent route (Claude Code all phases)...");
    run(`cpb config ${PROJECT} --agent claude`, { silent: true });
    return { description: "claude all phases", expected: ["default: claude"] };
  }

  if (AGENT_MODE === "mixed") {
    log("GITHUB", "Configuring deterministic ACP agent route (Codex plan/verify, Claude Code execute)...");
    run(`cpb config ${PROJECT} --unset-agent`, { silent: true });
    run(`cpb config ${PROJECT} --plan-agent codex`, { silent: true });
    run(`cpb config ${PROJECT} --execute-agent claude`, { silent: true });
    run(`cpb config ${PROJECT} --verify-agent codex`, { silent: true });
    run(`cpb config ${PROJECT} --review-agent codex`, { silent: true });
    return {
      description: "mixed codex/claude",
      expected: ["plan: codex", "execute: claude", "verify: codex", "review: codex"],
    };
  }

  if (AGENT_MODE === "default") {
    log("GITHUB", "Clearing project agent overrides (registry defaults)...");
    run(`cpb config ${PROJECT} --unset-agent`, { silent: true });
    return { description: "registry defaults", expected: ["No agent overrides"] };
  }

  fail(`Unsupported CPB_E2E_AGENT_MODE '${AGENT_MODE}'. Use codex, mixed, claude, cc, or default.`);
  process.exit(1);
}

// ─── Step 1: Stop everything ───────────────────────────────────────
function stepStop() {
  log("STOP", "Stopping hub, daemon, and codegraph...");
  run("cpb hub stop", { allowFail: true, silent: true });
  run("cpb daemon stop", { allowFail: true, silent: true });
  run("cpb codegraph stop", { allowFail: true, silent: true });
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
    path.join(projectRuntime, "worktrees"),
    path.join(projectRuntime, "context-packs"),
    path.join(projectRuntime, "graph"),
    path.join(CPB_ROOT, "cpb-task", "daemon"),
    path.join(CPB_ROOT, "cpb-task", "event-sources"),
    path.join(CPB_ROOT, "cpb-task", "codegraph-state.json"),
    path.join(CPB_ROOT, "cpb-task", "worktrees"),
  ];
  const files = [
    path.join(CPB_ROOT, "cpb-task", "jobs-index.json"),
    path.join(projectRuntime, "jobs-index.json"),
    path.join(HUB_ROOT, "github", "issues.json"),
    path.join(ROOT, TGZ),
  ];

  for (const d of dirs) {
    if (existsSync(d)) {
      rmSync(d, { recursive: true, force: true });
    }
  }
  for (const f of files) {
    if (existsSync(f)) rmSync(f, { force: true });
  }

  // Prune stale git worktrees so branches can be reused
  run("git worktree prune", { silent: true, allowFail: true });
  // Remove leftover cpb/ branches from previous pipeline runs
  try {
    const branches = execSync("git branch --list 'cpb/*'", { encoding: "utf8", cwd: ROOT }).trim();
    if (branches) {
      for (const b of branches.split("\n").map((l) => l.trim().replace("* ", ""))) {
        if (b) run(`git branch -D "${b}"`, { silent: true, allowFail: true });
      }
    }
  } catch {}

  pass("State cleaned");
}

// ─── Step 3: npm pack + global install ─────────────────────────────
function stepPack() {
  log("PACK", "Building and packing...");
  const oldRootTgz = path.join(ROOT, TGZ);
  if (existsSync(oldRootTgz)) rmSync(oldRootTgz, { force: true });

  const packDir = mkdtempSync(path.join(tmpdir(), "cpb-e2e-pack-"));
  const tgzPath = path.join(packDir, TGZ);
  run(`npm pack --silent --pack-destination ${shellQuote(packDir)}`, { cwd: ROOT, timeout: 120_000 });
  if (!existsSync(tgzPath)) { fail("Tarball not found"); process.exit(1); }

  log("INSTALL", "Installing globally...");
  run(`npm install -g ${shellQuote(tgzPath)}`, { cwd: ROOT, timeout: 120_000 });
  pass("Packed and installed globally");
}

// ─── Step 4: Doctor ────────────────────────────────────────────────
function stepDoctor() {
  log("DOCTOR", "Running health check...");
  const r = run("cpb doctor --json", { silent: true, allowFail: true });
  try {
    const data = JSON.parse(r.stdout || "{}");
    const agentErrors = (data.checks || []).filter(
      (c) => c.status === "error" && c.category === "agents"
    );
    if (agentErrors.length > 0) {
      fail(`Critical agent errors: ${agentErrors.map((c) => c.message).join(", ")}`);
      process.exit(1);
    }
    const summary = data.summary || {};
    log("DOCTOR", `ok: ${summary.ok || 0}, warn: ${summary.warn || 0}, error: ${summary.error || 0}`);
  } catch (e) {
    log("DOCTOR", `Could not parse doctor output: ${e.message}`);
  }
  pass("Doctor passed (non-critical issues allowed)");
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
  run(`cpb github bind ${PROJECT} ${GITHUB_REPO}`, { silent: true });

  log("GITHUB", `Configuring automation (label: ${AUTOMATION_LABEL})...`);
  run(`cpb config ${PROJECT} --automation-enabled true`, { silent: true });
  run(`cpb config ${PROJECT} --automation-clear-rules`, { silent: true });
  const rule = `match.labels=${AUTOMATION_LABEL};action.workflow=standard;action.priority=P2`;
  run(`cpb config ${PROJECT} --automation-rule ${shellQuote(rule)}`, { silent: true });

  const route = configureAgentRoute();
  const agents = run(`cpb config ${PROJECT} --agents`, { silent: true });
  const missing = route.expected.filter((needle) => !agents.stdout.includes(needle));
  if (missing.length > 0) {
    fail(`Project agent route '${route.description}' was not applied; missing ${missing.join(", ")}`);
    if (agents.stdout) log("GITHUB", agents.stdout);
    process.exit(1);
  }
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
  log("ENQUEUE", `Syncing + enqueueing issues for ${PROJECT} (label: ${AUTOMATION_LABEL})...`);

  const dry = run(`cpb hub enqueue-issues ${PROJECT} --sync-first --dry-run`, { silent: true, allowFail: true });
  if (dry.ok && dry.stdout) {
    log("ENQUEUE", `Dry run: ${dry.stdout.substring(0, 200)}`);
  }

  const enq = run(`cpb hub enqueue-issues ${PROJECT} --sync-first`, { silent: true, allowFail: true });
  if (!enq.ok) {
    fail("Enqueue failed");
    if (enq.stderr) log("ENQUEUE", enq.stderr.substring(0, 300));
    return false;
  }
  pass("Issues enqueued");
  if (TARGET_ISSUE_NUMBER) {
    const entry = latestGithubQueueEntry();
    if (!entry) {
      fail(`No queue entry found for target issue #${TARGET_ISSUE_NUMBER}`);
      return false;
    }
    pass(`Target issue #${TARGET_ISSUE_NUMBER} queued as ${entry.id}`);
  }
  return true;
}

// ─── Step 8: Start worker ──────────────────────────────────────────
async function stepWorker() {
  log("WORKER", "Starting worker daemon...");
  run("cpb daemon start --workers 1", {
    timeout: 30_000,
    env: {
      CPB_AUTOFINALIZER_MODE: FINALIZER_MODE,
      CPB_ACP_PHASE_TIMEOUT_MS: String(ACP_PHASE_TIMEOUT_MS),
      CPB_ACP_TIMEOUT_MS: String(ACP_PHASE_TIMEOUT_MS),
    },
  });
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

function readQueue() {
  const file = path.join(HUB_ROOT, "queue", "queue.json");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function latestGithubQueueEntry() {
  return [...(readQueue().entries || [])]
    .filter((entry) => entry.projectId === PROJECT && (entry.type === "github_issue" || entry.metadata?.source === "github"))
    .filter((entry) => !TARGET_ISSUE_NUMBER || String(entry.metadata?.issueNumber || "") === TARGET_ISSUE_NUMBER)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

function remoteFinalizerComplete(entry) {
  const finalizer = entry?.metadata?.finalizer;
  return Boolean(
    finalizer?.ok === true
    && finalizer.status === "finalized"
    && finalizer.mode === FINALIZER_MODE
    && finalizer.pushed === true
    && finalizer.closed === true
    && finalizer.commit
  );
}

// ─── Step 9: Monitor pipeline ──────────────────────────────────────
async function stepMonitor() {
  const maxMinutes = Math.round(MONITOR_TIMEOUT_MS / 60_000);
  log("MONITOR", `Waiting for pipeline + remote finalizer to complete (max ${maxMinutes}min)...`);

  const deadline = Date.now() + MONITOR_TIMEOUT_MS;
  let lastStatus = "";
  let lastQueueStatus = "";

  while (Date.now() < deadline) {
    const entry = latestGithubQueueEntry();
    if (entry) {
      const finalizer = entry.metadata?.finalizer;
      const queueStatus = `${entry.id}:${entry.status}:${finalizer?.status || "no-finalizer"}:${finalizer?.commit || ""}`;
      if (queueStatus !== lastQueueStatus) {
        lastQueueStatus = queueStatus;
        log("MONITOR", `Queue ${entry.id}: ${entry.status}${finalizer ? ` finalizer=${finalizer.status} pushed=${finalizer.pushed} closed=${finalizer.closed}` : ""}`);
      }

      if (entry.status === "completed") {
        if (remoteFinalizerComplete(entry)) {
          pass(`Pipeline completed, pushed ${entry.metadata.finalizer.commit}, merged, and closed issue`);
          await printSummary();
          return "completed";
        }
        fail(`Queue completed without remote finalizer success: ${JSON.stringify(finalizer || null)}`);
        await printSummary();
        return "failed";
      }
      if (entry.status === "failed" || entry.status === "cancelled") {
        fail(`Queue ${entry.status}`);
        await printSummary();
        return entry.status;
      }
    }

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

    if (status.includes("failed")) {
      fail("Pipeline failed");
      await printSummary();
      return "failed";
    }
    if (status.includes("blocked")) {
      fail("Pipeline blocked");
      await printSummary();
      return "blocked";
    }

    // Also check queue status for failures (cpb status may not reflect queue state)
    const q = run("cpb hub queue-status", { silent: true, allowFail: true });
    if (q.ok && q.stdout.includes("failed:") && !q.stdout.includes("failed:0")) {
      fail("Queue reports failed entry");
      log("MONITOR", q.stdout.replace(/\x1b\[[0-9;]*m/g, "").trim());
      await printSummary();
      return "failed";
    }

    await wait(10000);
  }

  fail(`Pipeline still running after ${maxMinutes} minutes (services left running)`);
  await printSummary();
  return "timeout";
}

// ─── Summary ───────────────────────────────────────────────────────
async function printSummary() {
  console.log("");
  log("SUMMARY", `${BOLD}E2E Test Results${RESET}`);

  // Check latest job
  const r = run(`cpb status ${PROJECT}`, { silent: true, allowFail: true });
  if (r.ok) console.log(r.stdout);

  // Check queue status
  const q = run("cpb hub queue-status", { silent: true, allowFail: true });
  if (q.ok) console.log(q.stdout);

  // Check latest session for MCP usage when Codex participates in the route.
  if (AGENT_MODE === "claude" || AGENT_MODE === "cc") {
    log("MCP", "Pure Claude Code mode; skipping Codex MCP usage check.");
    return;
  }

  log("MCP", "Checking if Codex used MCP tools...");
  try {
    const sessionDir = path.join(homedir(), ".codex", "sessions");
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
  console.log(`  Label:   ${AUTOMATION_LABEL}`);
  console.log(`  Agent:   ${AGENT_MODE}`);
  if (TARGET_ISSUE_NUMBER) console.log(`  Issue:   #${TARGET_ISSUE_NUMBER}`);
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
  const result = await stepMonitor();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n${BOLD}Total time: ${elapsed}s${RESET}`);

  if (result === "timeout") {
    log("TEARDOWN", "Pipeline still running — leaving services up. Use 'cpb hub stop' when done.");
  } else {
    log("TEARDOWN", "Stopping services...");
    run("cpb daemon stop", { silent: true, allowFail: true });
    run("cpb hub stop", { silent: true, allowFail: true });
  }
}

main().catch((e) => {
  fail(`Unhandled: ${e.message}`);
  process.exit(1);
});
