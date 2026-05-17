#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpPool, RateLimitError } from "./acp-pool.mjs";
import { ProjectWorker } from "./project-worker.mjs";
import { getManagedAcpPool } from "../server/services/acp-pool-runtime.js";
import { listProjects, resolveHubRoot } from "../server/services/hub-registry.js";
import {
  appendHistory,
  claimIssue,
  completeIssue,
  loadBacklog,
  loadProjectState,
  pushIssues,
  updateIssueStatus,
} from "../server/services/multi-evolve-state.js";
import { checkPolicy } from "../server/services/evolve-policy.js";
import { closeBudget, consume, createBudget } from "../server/services/evolve-budget.js";
import {
  enqueue as hubEnqueue,
  listQueue as hubListQueue,
  queueStatus as hubQueueStatus,
  syncBacklogResult,
} from "../server/services/hub-queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPB_ROOT = path.resolve(process.env.CPB_ROOT || path.join(__dirname, ".."));

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    once: false,
    scan: false,
    continuous: false,
    guardedRepair: false,
    intervalMs: Number(process.env.CPB_MULTI_EVOLVE_INTERVAL_MS || 60_000),
    explicitInterval: false,
    maxRounds: Number(process.env.CPB_MULTI_EVOLVE_MAX_ROUNDS || 0),
    maxIssues: Number(process.env.CPB_MULTI_EVOLVE_MAX_ISSUES || 0),
    allowlist: [],
    noCleanCheck: false,
    project: null,
    agent: process.env.CPB_MULTI_EVOLVE_AGENT || "codex",
    timeoutMs: Number(process.env.CPB_MULTI_EVOLVE_TIMEOUT_MS || 300_000),
    workflow: process.env.CPB_MULTI_EVOLVE_WORKFLOW || "standard",
    localAcpPool: false,
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
    else if (arg === "--guarded-repair") opts.guardedRepair = true;
    else if (arg === "--interval") {
      opts.intervalMs = Number(valueAfter(i++, arg));
      opts.explicitInterval = true;
    }
    else if (arg === "--max-rounds") opts.maxRounds = Number(valueAfter(i++, arg));
    else if (arg === "--max-issues") opts.maxIssues = Number(valueAfter(i++, arg));
    else if (arg === "--allowlist") opts.allowlist = valueAfter(i++, arg).split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--no-clean-check") opts.noCleanCheck = true;
    else if (arg === "--project") opts.project = valueAfter(i++, arg);
    else if (arg === "--agent") opts.agent = valueAfter(i++, arg);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(valueAfter(i++, arg));
    else if (arg === "--workflow") opts.workflow = valueAfter(i++, arg);
    else if (arg === "--local-acp-pool") opts.localAcpPool = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["standard", "blocked"].includes(opts.workflow)) {
    throw new Error(`invalid workflow: ${opts.workflow}`);
  }
  if (opts.guardedRepair) {
    opts.dryRun = false;
    opts.once = false;
    opts.continuous = false;
    if (!opts.explicitInterval) opts.intervalMs = 0;
  } else if (!opts.once) {
    opts.dryRun = true;
  } else if (!opts.explicitDryRun) {
    opts.dryRun = false;
  }
  return opts;
}

function usage() {
  return `Usage: node bridges/multi-evolve.mjs [mode] [options]

Modes:
  (default)           dry-run read of existing backlogs
  --scan              refresh backlogs through the global ACP pool
  --once              execute one issue then exit (defaults to live execution)
  --continuous        run in a loop until max-rounds or signal
                      defaults to dry-run; add --once for live execution
  --guarded-repair    policy-gated loop: each issue must pass safety checks
                      before execution. Always live (never dry-run).
                      Stops on budget exhaustion or signal.

Options:
  --interval <ms>     sleep between rounds
  --max-rounds <n>    stop after N rounds in loop modes (0 = unlimited)
  --max-issues <n>    budget ceiling for guarded-repair (0 = unlimited)
  --allowlist <a,b>   comma-separated project IDs allowed in guarded-repair
  --no-clean-check    skip dirty-worktree check in guarded-repair
  --project <id>      restrict to a single project
  --agent codex|claude
  --workflow standard|blocked
  --timeout-ms <n>    per-agent timeout (default: 300000)
  --local-acp-pool    bypass Hub managed pool for isolated debugging`;
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
  constructor(projects, hubRoot = null) {
    this.projects = projects;
    this.hubRoot = hubRoot;
  }

  async candidates() {
    const candidates = [];
    const seen = new Set();

    for (const project of this.projects) {
      if (project.rateLimitedUntil && Date.now() < project.rateLimitedUntil) continue;
      const backlog = await loadBacklog(project.sourcePath, project.id);
      for (const issue of backlog.filter((item) => item.status === "pending")) {
        const key = `${project.id}::${issue.description}`;
        seen.add(key);
        candidates.push({ ...issue, project: project.id, sourcePath: project.sourcePath, weight: project.weight || 1 });
      }
    }

    if (this.hubRoot) {
      try {
        const hubEntries = await hubListQueue(this.hubRoot, { status: "pending" });
        for (const entry of hubEntries) {
          const key = `${entry.projectId}::${entry.description}`;
          if (seen.has(key)) continue;
          const project = this.projects.find((p) => p.id === entry.projectId);
          if (!project) continue;
          if (project.rateLimitedUntil && Date.now() < project.rateLimitedUntil) continue;
          seen.add(key);
          candidates.push({
            id: entry.id,
            priority: entry.priority,
            description: entry.description,
            status: "pending",
            createdAt: entry.createdAt,
            project: entry.projectId,
            sourcePath: entry.sourcePath || project.sourcePath,
            weight: project.weight || 1,
            _source: "hub_queue",
          });
        }
      } catch { /* hub queue read failure must not block candidate selection */ }
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
    this.pool = opts.pool || (opts.localAcpPool
      ? new AcpPool({ cpbRoot: this.cpbRoot, hubRoot: this.hubRoot })
      : getManagedAcpPool({ cpbRoot: this.cpbRoot, hubRoot: this.hubRoot }));
    this.projects = [];
    this.workerRunner = opts.workerRunner || null;
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

    if (this.hubRoot && issues.length > 0) {
      const sessionId = process.env.CPB_SESSION_ID || "";
      const executionBoundary = process.env.CPB_EXECUTION_BOUNDARY || "source";
      for (const issue of issues) {
        try {
          await hubEnqueue(this.hubRoot, {
            projectId: project.id,
            sourcePath: project.sourcePath,
            sessionId,
            executionBoundary,
            priority: issue.priority,
            description: issue.description,
            type: "candidate",
          });
        } catch { /* hub queue write failure must not block scan */ }
      }
    }

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
    return new CrossProjectPriorityQueue(this.projects, this.hubRoot).dequeue();
  }

  async runProjectWorker(issue, { workflow, queueEntry } = {}) {
    if (this.workerRunner) {
      return this.workerRunner({
        issue,
        queueEntry,
        workflow,
        cpbRoot: this.cpbRoot,
        hubRoot: this.hubRoot,
      });
    }

    const worker = new ProjectWorker({
      projectId: issue.project,
      once: true,
      workflow,
      cpbRoot: this.cpbRoot,
      hubRoot: this.hubRoot,
      workerId: process.env.CPB_WORKER_ID || `multi-evolve-${process.pid}`,
    });
    const run = await worker.run();
    if (run?.result) return run.result;
    if (run?.idle) {
      return { ok: false, code: 1, error: "project-worker found no pending queue entry", stdout: "", stderr: "" };
    }
    return { ok: false, code: 1, error: "project-worker returned no result", stdout: "", stderr: "" };
  }

  async executeIssue(issue, { workflow = "standard" } = {}) {
    let queueEntry;
    try {
      queueEntry = await hubEnqueue(this.hubRoot, {
        projectId: issue.project,
        sourcePath: issue.sourcePath,
        sessionId: process.env.CPB_SESSION_ID || null,
        workerId: process.env.CPB_WORKER_ID || null,
        executionBoundary: process.env.CPB_EXECUTION_BOUNDARY || "source",
        priority: issue.priority || "P2",
        description: issue.description,
        type: "candidate",
        metadata: {
          issueId: issue.id || null,
          source: "multi-evolve",
          workflow,
        },
      });
    } catch (err) {
      return { ok: false, code: 1, error: `hub queue enqueue: ${err.message}`, stdout: "", stderr: "" };
    }

    try {
      return await this.runProjectWorker(issue, { workflow, queueEntry });
    } catch (err) {
      return { ok: false, code: 1, error: `project-worker: ${err.message}`, stdout: "", stderr: "" };
    }
  }

  async completeIssueAndSync(issue, result) {
    await completeIssue(issue.sourcePath, issue.project, issue.id || issue.description, result);
    if (!this.hubRoot) return;
    await syncBacklogResult(this.hubRoot, {
      projectId: issue.project,
      description: issue.description,
      result: {
        ...result,
        backlogIssueId: issue.id || null,
      },
    }).catch(() => {});
  }

  async runOnce(opts = {}) {
    await this.init(opts);
    if (opts.scan) await this.scanAll(opts);
    const queue = new CrossProjectPriorityQueue(this.projects, this.hubRoot);
    const candidates = await queue.candidates();
    const next = candidates[0] || null;
    if (opts.dryRun || !next) {
      const response = { dryRun: Boolean(opts.dryRun), projects: await this.status(), candidates, next };
      if (this.hubRoot) {
        try { response.hubQueue = await hubQueueStatus(this.hubRoot); } catch { /* non-blocking */ }
      }
      return response;
    }
    const identity = next.id || next.description;
    const claimed = await claimIssue(next.sourcePath, next.project, identity);
    if (!claimed) {
      return { skipped: true, reason: "issue_not_pending", next };
    }
    const issue = { ...next, ...claimed.issue, sourcePath: next.sourcePath };
    await appendHistory(issue.sourcePath, issue.project, { action: "execute_started", issue: issue.description });
    const result = await this.executeIssue(issue, { workflow: opts.workflow || "standard" });
    await this.completeIssueAndSync(issue, result);
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
    let scanFailures = 0;

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
            scanFailures++;
            if (error instanceof RateLimitError) {
              project.rateLimitedUntil = error.untilTs;
              rateLimitedSkipped++;
            }
            await appendHistory(project.sourcePath, project.id, {
              action: "scan_failed",
              error: error.message,
              rateLimited: error instanceof RateLimitError,
              rateLimitedUntil: error instanceof RateLimitError ? error.untilTs : null,
              round: totalRounds,
            });
          }
        }
      }

      const queue = new CrossProjectPriorityQueue(this.projects, this.hubRoot);
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
      await this.completeIssueAndSync(issue, result);
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
      scanFailures,
      stopped: this._stopRequested,
    };
  }

  async runGuardedRepair(opts = {}) {
    const {
      maxRounds = 0,
      intervalMs = 0,
      scan = false,
      allowlist = [],
      noCleanCheck = false,
      maxIssues = 0,
    } = opts;

    this._stopRequested = false;
    await this.init(opts);

    let budget = createBudget({ maxIssues });
    let totalRounds = 0;
    let issuesExecuted = 0;
    let policyBlocked = 0;
    const policyOpts = { allowlist, requireCleanWorktree: !noCleanCheck };

    while (!this._stopRequested) {
      if (maxRounds > 0 && totalRounds >= maxRounds) break;

      if (scan) {
        for (const project of this.projects) {
          if (project.rateLimitedUntil && Date.now() < project.rateLimitedUntil) continue;
          try {
            await this.scanProject(project, opts);
          } catch {
            // Rate-limited or transient scans should not stop a guarded repair pass.
          }
        }
      }

      const queue = new CrossProjectPriorityQueue(this.projects, this.hubRoot);
      const next = await queue.dequeue();
      if (!next) break;
      totalRounds++;

      const policy = checkPolicy(next, policyOpts);
      if (!policy.allowed) {
        policyBlocked++;
        await updateIssueStatus(next.sourcePath, next.project, next.id || next.description, "policy_blocked", {
          reasons: policy.reasons,
        });
        await appendHistory(next.sourcePath, next.project, {
          action: "guarded_blocked",
          round: totalRounds,
          issue: next.description,
          reasons: policy.reasons,
        });
        continue;
      }

      const budgetCheck = consume(budget);
      if (!budgetCheck.ok) {
        budget = closeBudget(budgetCheck.budget, "budget_exhausted");
        await appendHistory(next.sourcePath, next.project, {
          action: "guarded_budget_exhausted",
          round: totalRounds,
          budget,
        });
        break;
      }
      budget = budgetCheck.budget;

      const identity = next.id || next.description;
      const claimed = await claimIssue(next.sourcePath, next.project, identity);
      if (!claimed) continue;

      const issue = { ...next, ...claimed.issue, sourcePath: next.sourcePath };
      await appendHistory(issue.sourcePath, issue.project, {
        action: "guarded_execute",
        round: totalRounds,
        issue: issue.description,
      });

      const result = await this.executeIssue(issue, { workflow: opts.workflow || "standard" });
      await this.completeIssueAndSync(issue, result);
      issuesExecuted++;

      if (intervalMs > 0 && !this._stopRequested && (maxRounds === 0 || totalRounds < maxRounds)) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    budget = closeBudget(budget, this._stopRequested ? "signal" : "backlog_empty");
    return {
      mode: "guarded_repair",
      totalRounds,
      issuesExecuted,
      policyBlocked,
      budget,
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
  const controller = new MultiEvolveController(CPB_ROOT, { localAcpPool: opts.localAcpPool });

  const onSignal = (sig) => {
    process.stderr.write(`[multi-evolve] ${sig} received, stopping after current round\n`);
    controller.requestStop();
  };

  if (opts.guardedRepair) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const result = await controller.runGuardedRepair({
      maxRounds: opts.maxRounds,
      intervalMs: opts.intervalMs,
      scan: opts.scan,
      allowlist: opts.allowlist,
      noCleanCheck: opts.noCleanCheck,
      maxIssues: opts.maxIssues,
      project: opts.project,
      agent: opts.agent,
      timeoutMs: opts.timeoutMs,
      workflow: opts.workflow,
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (opts.continuous) {
    const execute = opts.once;
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
