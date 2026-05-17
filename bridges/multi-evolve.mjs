#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpPool, RateLimitError } from "./acp-pool.mjs";
import { listProjects, resolveHubRoot } from "../server/services/hub-registry.js";
import {
  appendHistory,
  claimIssue,
  completeIssue,
  loadBacklog,
  loadProjectState,
  pushIssues,
} from "../server/services/multi-evolve-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPB_ROOT = path.resolve(process.env.CPB_ROOT || path.join(__dirname, ".."));

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    once: false,
    scan: false,
    continuous: false,
    intervalMs: Number(process.env.CPB_MULTI_EVOLVE_INTERVAL_MS || 60_000),
    maxRounds: Number(process.env.CPB_MULTI_EVOLVE_MAX_ROUNDS || 0),
    project: null,
    agent: process.env.CPB_MULTI_EVOLVE_AGENT || "codex",
    timeoutMs: Number(process.env.CPB_MULTI_EVOLVE_TIMEOUT_MS || 300_000),
    workflow: process.env.CPB_MULTI_EVOLVE_WORKFLOW || "standard",
    explicitDryRun: false,
  };
  const args = argv.slice(2);
  const valueAfter = (index, flag) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
      opts.explicitDryRun = true;
    }
    else if (arg === "--once") opts.once = true;
    else if (arg === "--scan") opts.scan = true;
    else if (arg === "--continuous") opts.continuous = true;
    else if (arg === "--interval") opts.intervalMs = Number(valueAfter(i++, arg));
    else if (arg === "--max-rounds") opts.maxRounds = Number(valueAfter(i++, arg));
    else if (arg === "--project") opts.project = valueAfter(i++, arg);
    else if (arg === "--agent") opts.agent = valueAfter(i++, arg);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(valueAfter(i++, arg));
    else if (arg === "--workflow") opts.workflow = valueAfter(i++, arg);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["standard", "blocked"].includes(opts.workflow)) {
    throw new Error(`invalid workflow: ${opts.workflow}`);
  }
  if (!opts.once) {
    opts.dryRun = true;
  } else if (!opts.explicitDryRun) {
    opts.dryRun = false;
  }
  return opts;
}

function usage() {
  return `Usage: node bridges/multi-evolve.mjs [--dry-run] [--scan] [--once] [--continuous] [--interval <ms>] [--max-rounds <n>] [--project <id>] [--agent codex|claude] [--workflow standard|blocked]\n\nModes:\n  Default (no flags)  dry-run read of existing backlogs\n  --scan              refresh backlogs through the global ACP pool\n  --once              execute one issue then exit (defaults to live execution)\n  --continuous        run in a loop until max-rounds or signal\n                      defaults to dry-run; add --once or use with --workflow blocked for safe execution\n\nOptions:\n  --interval <ms>     sleep between continuous rounds (default: 60000)\n  --max-rounds <n>    stop after N rounds in continuous mode (default: 0 = unlimited)\n  --project <id>      restrict to a single project\n  --workflow standard|blocked  execution workflow`;
}

function scanPrompt(project) {
  return `You are CPB Multi-Evolve Scanner. Analyze this project for concrete improvement opportunities.\n\nProject: ${project.id}\nSource path: ${project.sourcePath}\n\nOutput at most 5 lines in this exact format:\n[ISSUE] <P0|P1|P2> <one-line description>\n\nFocus on real, actionable issues. Do not modify files.`;
}

export function parseScanResults(text) {
  const issues = [];
  const regex = /\[ISSUE\]\s*\[?(P[0-3])\]?\s+(.+)/g;
  let match;
  while ((match = regex.exec(text || "")) !== null) {
    issues.push({ priority: match[1], description: match[2].trim(), status: "pending" });
  }
  return issues;
}

function priorityScore(priority) {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  return 3;
}

function ageScore(issue) {
  const ts = Date.parse(issue.createdAt || "");
  if (!Number.isFinite(ts)) return 1;
  return Math.max(1, Date.now() - ts);
}

export class CrossProjectPriorityQueue {
  constructor(projects) {
    this.projects = projects;
  }

  async candidates() {
    const candidates = [];
    for (const project of this.projects) {
      if (project.rateLimitedUntil && Date.now() < project.rateLimitedUntil) continue;
      const backlog = await loadBacklog(project.sourcePath, project.id);
      for (const issue of backlog.filter((item) => item.status === "pending")) {
        candidates.push({ ...issue, project: project.id, sourcePath: project.sourcePath, weight: project.weight || 1 });
      }
    }
    candidates.sort((a, b) => {
      const pa = priorityScore(a.priority);
      const pb = priorityScore(b.priority);
      if (pa !== pb) return pa - pb;
      return (b.weight * ageScore(b)) - (a.weight * ageScore(a));
    });
    return candidates;
  }

  async dequeue() {
    const list = await this.candidates();
    return list[0] || null;
  }
}

export class MultiEvolveController {
  constructor(cpbRoot = CPB_ROOT, opts = {}) {
    this.cpbRoot = path.resolve(cpbRoot);
    this.hubRoot = path.resolve(opts.hubRoot || resolveHubRoot(cpbRoot));
    this.pool = opts.pool || new AcpPool({ cpbRoot: this.cpbRoot, hubRoot: this.hubRoot });
    this.projects = [];
    this._stopRequested = false;
  }

  requestStop() {
    this._stopRequested = true;
  }

  async init({ project } = {}) {
    const projects = await listProjects(this.hubRoot, { enabledOnly: true });
    this.projects = project ? projects.filter((item) => item.id === project || item.name === project) : projects;
    return this.projects;
  }

  async scanProject(project, { agent = "codex", timeoutMs = 300_000 } = {}) {
    const fixture = process.env.CPB_MULTI_EVOLVE_SCAN_FIXTURE;
    const output = fixture || await this.pool.execute(agent, scanPrompt(project), project.sourcePath, timeoutMs);
    const issues = parseScanResults(output);
    const result = await pushIssues(project.sourcePath, project.id, issues);
    await appendHistory(project.sourcePath, project.id, { action: "scan", issues: issues.length, agent });
    return { project: project.id, issues, ...result };
  }

  async scanAll(opts = {}) {
    const results = [];
    for (const project of this.projects) {
      try {
        results.push(await this.scanProject(project, opts));
      } catch (error) {
        const rateLimited = error instanceof RateLimitError;
        project.rateLimitedUntil = rateLimited ? error.untilTs : null;
        await appendHistory(project.sourcePath, project.id, {
          action: "scan_failed",
          error: error.message,
          rateLimited,
          rateLimitedUntil: project.rateLimitedUntil,
        });
        results.push({ project: project.id, error: error.message, rateLimited, rateLimitedUntil: project.rateLimitedUntil });
      }
    }
    return results;
  }

  async status() {
    const rows = [];
    for (const project of this.projects) {
      const [state, backlog] = await Promise.all([
        loadProjectState(project.sourcePath, project.id),
        loadBacklog(project.sourcePath, project.id),
      ]);
      rows.push({
        id: project.id,
        name: project.name,
        sourcePath: project.sourcePath,
        enabled: project.enabled !== false,
        state,
        backlog: {
          total: backlog.length,
          pending: backlog.filter((issue) => issue.status === "pending").length,
          inProgress: backlog.filter((issue) => issue.status === "in_progress").length,
        },
      });
    }
    return rows;
  }

  async pickNextIssue() {
    return new CrossProjectPriorityQueue(this.projects).dequeue();
  }

  executeIssue(issue, { workflow = "standard" } = {}) {
    return new Promise((resolve) => {
      const stream = process.env.CPB_MULTI_EVOLVE_STREAM === "1";
      const child = spawn(process.execPath, [
        path.join(this.cpbRoot, "bridges", "run-pipeline.mjs"),
        "--project", issue.project,
        "--task", issue.description,
        "--source-path", issue.sourcePath,
        "--workflow", workflow,
      ], {
        cwd: this.cpbRoot,
        env: { ...process.env, CPB_ROOT: this.cpbRoot, CPB_PROJECT_PATH_OVERRIDE: issue.sourcePath, CPB_ACP_CWD: issue.sourcePath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stream) process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stream) process.stderr.write(chunk);
      });
      child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
      child.on("error", (error) => resolve({ ok: false, code: 1, error: error.message, stdout, stderr }));
    });
  }

  async runOnce(opts = {}) {
    await this.init(opts);
    if (opts.scan) await this.scanAll(opts);
    const queue = new CrossProjectPriorityQueue(this.projects);
    const candidates = await queue.candidates();
    const next = candidates[0] || null;
    if (opts.dryRun || !next) {
      return { dryRun: Boolean(opts.dryRun), projects: await this.status(), candidates, next };
    }
    const identity = next.id || next.description;
    const claimed = await claimIssue(next.sourcePath, next.project, identity);
    if (!claimed) {
      return { skipped: true, reason: "issue_not_pending", next };
    }
    const issue = { ...next, ...claimed.issue, sourcePath: next.sourcePath };
    await appendHistory(issue.sourcePath, issue.project, { action: "execute_started", issue: issue.description });
    const result = await this.executeIssue(issue, { workflow: opts.workflow || "standard" });
    await completeIssue(issue.sourcePath, issue.project, issue.id || issue.description, result);
    await appendHistory(issue.sourcePath, issue.project, {
      action: result.ok ? "execute_completed" : "execute_failed",
      issue: issue.description,
      exitCode: result.code ?? null,
      error: result.error || null,
    });
    return { next: issue, result };
  }

  async runContinuous(opts = {}) {
    const { maxRounds = 0, intervalMs = 60_000, scan = false, execute = false } = opts;
    this._stopRequested = false;

    await this.init(opts);

    let totalRounds = 0;
    let issuesExecuted = 0;
    let rateLimitedSkipped = 0;

    while (!this._stopRequested) {
      if (maxRounds > 0 && totalRounds >= maxRounds) break;

      totalRounds++;

      if (scan) {
        for (const project of this.projects) {
          if (project.rateLimitedUntil && Date.now() < project.rateLimitedUntil) {
            rateLimitedSkipped++;
            continue;
          }
          try {
            await this.scanProject(project, opts);
          } catch (error) {
            if (error instanceof RateLimitError) {
              project.rateLimitedUntil = error.untilTs;
              rateLimitedSkipped++;
            }
          }
        }
      }

      const queue = new CrossProjectPriorityQueue(this.projects);
      const candidates = await queue.candidates();
      const next = candidates[0] || null;

      if (!execute || !next) {
        for (const project of this.projects) {
          await appendHistory(project.sourcePath, project.id, {
            action: "continuous_round",
            round: totalRounds,
            dryRun: !execute,
            candidates: candidates.length,
            executed: false,
          });
        }
        if (intervalMs > 0 && !this._stopRequested && (maxRounds === 0 || totalRounds < maxRounds)) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        continue;
      }

      const identity = next.id || next.description;
      const claimed = await claimIssue(next.sourcePath, next.project, identity);
      if (!claimed) {
        continue;
      }

      const issue = { ...next, ...claimed.issue, sourcePath: next.sourcePath };
      await appendHistory(issue.sourcePath, issue.project, { action: "continuous_round", round: totalRounds, dryRun: false, issue: issue.description });

      const result = await this.executeIssue(issue, { workflow: opts.workflow || "standard" });
      await completeIssue(issue.sourcePath, issue.project, issue.id || issue.description, result);
      issuesExecuted++;

      if (intervalMs > 0 && !this._stopRequested && (maxRounds === 0 || totalRounds < maxRounds)) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    return {
      dryRun: !execute,
      totalRounds,
      issuesExecuted,
      rateLimitedSkipped,
      stopped: this._stopRequested,
    };
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  const controller = new MultiEvolveController(CPB_ROOT);

  if (opts.continuous) {
    const execute = opts.once;
    const onSignal = (sig) => {
      process.stderr.write(`[multi-evolve] ${sig} received, stopping after current round\n`);
      controller.requestStop();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const result = await controller.runContinuous({
      maxRounds: opts.maxRounds,
      intervalMs: opts.intervalMs,
      scan: opts.scan,
      execute,
      project: opts.project,
      agent: opts.agent,
      timeoutMs: opts.timeoutMs,
      workflow: opts.workflow,
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const result = await controller.runOnce(opts);
  console.log(JSON.stringify(result, null, 2));
  return result.result && !result.result.ok ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main().catch((error) => {
    console.error(error.message);
    return 1;
  });
}
