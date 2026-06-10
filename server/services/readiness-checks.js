import { execFile } from "node:child_process";
import {
  access,
  constants as fsConstants,
  lstat,
  readdir,
  readFile,
  mkdir,
  rm,
  stat as statFs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { redactSecrets } from "./diagnostics-bundle.js";
import { listJobs } from "./job-store.js";
import { hubStatus, loadRegistry, resolveHubRoot } from "./hub-registry.js";
import { readHubLiveness } from "./hub-runtime.js";
import { readLease, isLeaseStale } from "./lease-manager.js";
import { runtimeDataPath } from "./runtime-root.js";
import { WorkerStore } from "../../shared/orchestrator/worker-store.js";

import { sanitizeProviderReason } from "./acp-pool.js";
import { scanHubPollution } from "./project-pollution.js";
import {
  buildAgentSandboxLaunch,
  resolveAgentSandboxPolicy,
} from "../../core/policy/agent-sandbox.js";
import {
  resolveReleaseStoreRoot,
  listReleases,
  inspectCurrentRelease,
  supportedStateFormatVersions,
} from "./release-store.js";
import { executorMetadata } from "./executor-root.js";
import * as agentRegistry from "../../core/agents/registry.js";
import { listSetupAgents } from "../../core/setup/agent-catalog.js";
import { detectSetupEnvironment } from "../../core/setup/detect.js";

const execFileAsync = promisify(execFile);
const SUBPROCESS_TIMEOUT_MS = 5_000;
const MIN_NODE_MAJOR = 18;
const DISK_WARN_BYTES = 100 * 1024 * 1024;
const HUB_WORKER_TTL = 120_000;

// --- Result model ---

function makeCheck(id, category, status, severity, message, { details, remediation } = {}) {
  const check = { id, category, status, severity, message };
  if (details !== undefined) check.details = details;
  if (remediation !== undefined) check.remediation = remediation;
  return check;
}

function ok(id, category, message, opts) {
  return makeCheck(id, category, "ok", "info", message, opts);
}

function warn(id, category, message, opts) {
  return makeCheck(id, category, "warn", "important", message, opts);
}

function error(id, category, message, opts) {
  return makeCheck(id, category, "error", "critical", message, opts);
}

function skipped(id, category, message, opts) {
  return makeCheck(id, category, "skipped", "info", message, opts);
}

export function deriveSummary(checks) {
  const counts = { ok: 0, warn: 0, error: 0, skipped: 0 };
  for (const check of checks) counts[check.status]++;
  return { ...counts, success: counts.error === 0 };
}

function statusForCategories(checks, categories) {
  const selected = checks.filter((check) => categories.includes(check.category));
  if (selected.length === 0) return "skipped";
  if (selected.some((check) => check.status === "error")) return "fail";
  if (selected.some((check) => check.status === "warn")) return "warn";
  if (selected.every((check) => check.status === "skipped")) return "skipped";
  return "pass";
}

function evidenceForCategories(checks, categories) {
  const selected = checks.filter((check) => categories.includes(check.category));
  return {
    checks: selected.map((check) => ({
      id: check.id,
      category: check.category,
      status: check.status,
      severity: check.severity,
    })),
  };
}

export function deriveReadinessLevels(checks = []) {
  const normalizedChecks = Array.isArray(checks) ? checks : [];
  const levels = [
    {
      level: 0,
      id: "repo-package",
      name: "Repo/package usable",
      status: statusForCategories(normalizedChecks, ["toolchain", "disk"]),
      evidence: evidenceForCategories(normalizedChecks, ["toolchain", "disk"]),
      recommendedAction: null,
    },
    {
      level: 1,
      id: "tests-build",
      name: "Node tests, web tests, and web build",
      status: "skipped",
      evidence: { reason: "doctor does not run long test/build gates" },
      recommendedAction: "Run: cpb health-check or npm test && npm --workspace codepatchbay-web test -- --run && npm run build:web",
    },
    {
      level: 2,
      id: "hub-runtime",
      name: "Hub runtime, registry, jobs, workers, and leases",
      status: statusForCategories(normalizedChecks, ["hub", "registry", "jobs", "workers", "leases"]),
      evidence: evidenceForCategories(normalizedChecks, ["hub", "registry", "jobs", "workers", "leases"]),
      recommendedAction: null,
    },
    {
      level: 3,
      id: "fake-acp-smoke",
      name: "Fake ACP pipeline smoke",
      status: "skipped",
      evidence: { reason: "doctor does not launch pipeline smoke" },
      recommendedAction: "Run: cpb health-check --skip-http --skip-tests --skip-build --fake-acp-smoke",
    },
    {
      level: 4,
      id: "real-provider-smoke",
      name: "Optional real ACP provider smoke",
      status: "skipped",
      optional: true,
      evidence: { reason: "real provider smoke is opt-in to avoid accidental provider spend or rate limits" },
      recommendedAction: "Run the live provider smoke explicitly when provider credentials and budget are available.",
    },
  ];

  let currentLevel = -1;
  for (const level of levels) {
    if (level.optional) continue;
    if (level.status !== "pass") break;
    currentLevel = level.level;
  }

  return {
    currentLevel,
    targetLevel: 3,
    levels,
  };
}

// --- Individual checks ---

async function checkNode() {
  const ver = process.version;
  const major = parseInt(ver.slice(1).split(".")[0], 10);
  if (major < MIN_NODE_MAJOR) {
    return error("node-version", "toolchain", `Node.js ${ver} is below minimum v${MIN_NODE_MAJOR}`, {
      remediation: `Install Node.js v${MIN_NODE_MAJOR} or later.`,
    });
  }
  return ok("node-version", "toolchain", `Node.js ${ver}`);
}

async function checkNpm() {
  try {
    const { stdout } = await execFileAsync("npm", ["--version"], { timeout: SUBPROCESS_TIMEOUT_MS });
    return ok("npm-version", "toolchain", `npm ${stdout.trim()}`);
  } catch {
    return warn("npm-version", "toolchain", "npm not found", {
      remediation: "Install npm (usually bundled with Node.js).",
    });
  }
}

async function checkGit() {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { timeout: SUBPROCESS_TIMEOUT_MS });
    const ver = stdout.trim().replace("git version ", "");
    return ok("git-version", "toolchain", `Git ${ver}`);
  } catch {
    return error("git-version", "toolchain", "Git not found", {
      remediation: "Install Git.",
    });
  }
}

async function findExistingDiskProbePath(targetPath, statFn = statFs) {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      const info = await statFn(current);
      return typeof info.isDirectory === "function" && !info.isDirectory()
        ? path.dirname(current)
        : current;
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

export async function checkDiskSpace(dirPath, label, { execFileFn = execFileAsync, statFn = statFs } = {}) {
  const id = `disk-${label}`;
  try {
    const resolved = path.resolve(dirPath);
    const probePath = await findExistingDiskProbePath(resolved, statFn);
    const { stdout } = await execFileFn("df", ["-k", probePath], { timeout: SUBPROCESS_TIMEOUT_MS });
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return skipped(id, "disk", `Cannot parse df output for ${label}`);
    const parts = lines[lines.length - 1].split(/\s+/);
    const freeKb = parseInt(parts[3], 10);
    if (Number.isNaN(freeKb)) return skipped(id, "disk", `Cannot parse free space for ${label}`);
    const freeBytes = freeKb * 1024;
    if (freeBytes < DISK_WARN_BYTES) {
      return warn(id, "disk", `Low disk space (${label}): ${(freeBytes / 1024 / 1024).toFixed(0)} MB free`, {
        details: { path: resolved, freeBytes },
        remediation: `Free at least ${DISK_WARN_BYTES / 1024 / 1024} MB on the ${label} volume.`,
      });
    }
    return ok(id, "disk", `${label}: ${(freeBytes / 1024 / 1024).toFixed(0)} MB free`);
  } catch {
    return skipped(id, "disk", `Cannot check disk space for ${label}`);
  }
}

async function checkAcpAdapter(adapterName, command, args, { npxPkg, stability } = {}) {
  const id = `acp-adapter-${adapterName}`;

  let stdout;
  try {
    const result = await execFileAsync(command, [...args], { timeout: SUBPROCESS_TIMEOUT_MS });
    stdout = result.stdout || "";
  } catch (e) {
    // Discovered agents: info only (non-blocking)
    if (stability === "discovered") {
      return skipped(id, "acp", `${adapterName} not available (auto-discovered)`, {
        details: { command, error: e.message },
      });
    }
    // Experimental agents degrade to warning, stable agents are errors
    if (stability === "experimental") {
      return warn(id, "acp", `${adapterName} adapter not found (experimental)`, {
        details: { command, fallback: npxPkg ? `npx -y ${npxPkg}` : undefined, error: e.message },
        remediation: npxPkg ? `Install adapter: npx -y ${npxPkg}` : undefined,
      });
    }
    return error(id, "acp", `${adapterName} adapter not found`, {
      details: { command, fallback: npxPkg ? `npx -y ${npxPkg}` : undefined, error: e.message },
      remediation: npxPkg ? `Install adapter: npx -y ${npxPkg}` : undefined,
    });
  }

  // Try to extract version from --help output or run --version
  let version;
  try {
    const verResult = await execFileAsync(command, ["--version"], { timeout: SUBPROCESS_TIMEOUT_MS });
    version = (verResult.stdout || "").trim();
  } catch {}
  if (!version) {
    const verMatch = stdout.match(/version[:\s]+([0-9]+\.[0-9]+\.[0-9]+)/i);
    version = verMatch ? verMatch[1] : undefined;
  }

  const msg = version
    ? `${adapterName} adapter available (v${version})`
    : `${adapterName} adapter available`;
  return ok(id, "acp", msg, { details: version ? { version } : undefined });
}

function preferredInstallMethod(agent, setupSnapshot) {
  const methods = Object.keys(agent.install || {});
  if (methods.includes("brew") && setupSnapshot?.tools?.brew?.installed) return "brew";
  if (methods.includes("npm") && setupSnapshot?.tools?.npm?.installed) return "npm";
  return methods[0] || "manual";
}

export function buildSetupReadinessChecks(setupSnapshot = {}, catalog = []) {
  const checks = [];
  for (const agent of catalog) {
    const probe = setupSnapshot.agents?.[agent.id] || { installed: false, status: "missing" };
    if (probe.installed) {
      checks.push(ok(`setup-agent-${agent.id}`, "setup", `${agent.displayName} installed`, {
        details: {
          agentId: agent.id,
          binary: agent.binary,
          version: probe.version || null,
          status: probe.status || "installed",
        },
      }));
      continue;
    }

    const method = preferredInstallMethod(agent, setupSnapshot);
    checks.push(warn(`setup-agent-${agent.id}`, "setup", `${agent.displayName} not installed`, {
      details: {
        agentId: agent.id,
        binary: agent.binary,
        recommended: Boolean(agent.recommended),
        status: probe.status || "missing",
        error: probe.error || null,
      },
      remediation: `Run: cpb agents install ${agent.id} --method ${method}`,
    }));
  }
  return checks;
}

async function checkHubLiveness(hubRoot) {
  try {
    const liveness = await readHubLiveness(hubRoot);
    if (liveness.alive) {
      return ok("hub-liveness", "hub", `Hub alive (pid: ${liveness.pid})`, {
        details: { pid: liveness.pid, startedAt: liveness.startedAt, version: liveness.version },
      });
    }
    const reason = liveness.reason || "unknown";
    const messages = {
      "no-hub-json": "Hub not started (no hub.json found)",
      "process-gone": `Hub process gone (pid: ${liveness.pid})`,
      "shutdown": `Hub shut down (pid: ${liveness.pid})`,
    };
    return warn("hub-liveness", "hub", messages[reason] || `Hub not alive: ${reason}`, {
      details: liveness,
      remediation: "Run: cpb hub start",
    });
  } catch (e) {
    return error("hub-liveness", "hub", `Hub liveness check failed: ${e.message}`);
  }
}

async function checkHubWritability(hubRoot) {
  const probeDir = path.join(path.resolve(hubRoot), "state");
  const probeFile = path.join(probeDir, `.readiness-probe-${process.pid}`);
  try {
    await mkdir(probeDir, { recursive: true });
    await writeFile(probeFile, "probe", "utf8");
    await readFile(probeFile, "utf8");
    await rm(probeFile, { force: true });
    return ok("hub-writability", "hub", "Hub state directory writable");
  } catch (e) {
    try { await rm(probeFile, { force: true }); } catch {}
    return error("hub-writability", "hub", "Hub state directory not writable", {
      details: { path: probeDir, error: e.message },
      remediation: `Ensure write permissions on ${probeDir}`,
    });
  }
}

async function checkRegistryConsistency(hubRoot) {
  try {
    const registry = await loadRegistry(hubRoot);
    const projects = Object.values(registry.projects);
    const issues = [];
    for (const project of projects) {
      if (!project.id) {
        issues.push({ project: "unknown", issue: "missing id" });
      } else if (!project.sourcePath) {
        issues.push({ project: project.id, issue: "missing sourcePath" });
      }
    }
    if (issues.length > 0) {
      return warn("registry-consistency", "registry", `${issues.length} registry issue(s)`, {
        details: issues,
        remediation: "Run: cpb hub projects to inspect, or restart workers.",
      });
    }
    return ok("registry-consistency", "registry", `${projects.length} project(s) registered`);
  } catch (e) {
    return error("registry-consistency", "registry", `Registry read failed: ${e.message}`);
  }
}

async function checkStaleJobs(cpbRoot) {
  try {
    const allJobs = await listJobs(cpbRoot);
    const terminalStates = ["completed", "failed", "blocked", "cancelled"];
    const running = allJobs.filter((j) => !terminalStates.includes(j.status));
    if (running.length === 0) return ok("stale-jobs", "jobs", "No running jobs");

    const stale = [];
    const missingLeases = [];
    for (const job of running) {
      if (!job.leaseId) {
        stale.push({ jobId: job.jobId, project: job.project, phase: job.currentPhase, issue: "no lease" });
        continue;
      }
      try {
        const lease = await readLease(cpbRoot, job.leaseId);
        if (lease === null) {
          missingLeases.push({ jobId: job.jobId, project: job.project, leaseId: job.leaseId, issue: "lease file missing" });
        } else if (isLeaseStale(lease)) {
          stale.push({ jobId: job.jobId, project: job.project, phase: job.currentPhase, issue: "expired lease" });
        }
      } catch {
        stale.push({ jobId: job.jobId, project: job.project, phase: job.currentPhase, issue: "lease read error" });
      }
    }
    const allIssues = [...stale, ...missingLeases];
    if (allIssues.length > 0) {
      return warn("stale-jobs", "jobs", `${allIssues.length} stale job(s) (${stale.length} stale, ${missingLeases.length} missing lease)`, {
        details: allIssues,
        remediation: "Run: cpb recover <project> <jobId> or cpb jobs reconcile",
      });
    }
    return ok("stale-jobs", "jobs", `${running.length} running job(s), all leases active`);
  } catch (e) {
    return warn("stale-jobs", "jobs", `Cannot check stale jobs: ${e.message}`);
  }
}

async function checkOrphanLeases(cpbRoot) {
  try {
    const leasesDir = runtimeDataPath(cpbRoot, "leases");
    let files;
    try {
      files = await readdir(leasesDir);
    } catch {
      return ok("orphan-leases", "leases", "No leases directory");
    }
    const leaseFiles = files.filter((f) => f.endsWith(".json"));
    if (leaseFiles.length === 0) return ok("orphan-leases", "leases", "No lease files");

    const allJobs = await listJobs(cpbRoot);
    const jobLeaseIds = new Set(allJobs.map((j) => j.leaseId).filter(Boolean));
    const orphans = [];
    for (const f of leaseFiles) {
      const leaseId = f.replace(".json", "");
      if (!jobLeaseIds.has(leaseId)) {
        orphans.push({ leaseId });
      }
    }
    if (orphans.length > 0) {
      return warn("orphan-leases", "leases", `${orphans.length} orphan lease(s) not tied to any job`, {
        details: orphans,
        remediation: "Run: cpb gc to clean up orphan leases from completed jobs.",
      });
    }
    return ok("orphan-leases", "leases", `${leaseFiles.length} lease(s), all tied to jobs`);
  } catch (e) {
    return warn("orphan-leases", "leases", `Cannot check orphan leases: ${e.message}`);
  }
}

async function checkStaleWorkers(hubRoot) {
  try {
    const workerStore = new WorkerStore(hubRoot);
    const workers = await workerStore.listWorkers();
    const stale = [];
    const now = Date.now();
    for (const worker of workers) {
      if (worker.status === "exited") continue;
      const lastSeenAt = worker.lastHeartbeatAt || worker.startedAt;
      const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
      if (!Number.isFinite(lastSeenMs) || now - lastSeenMs > HUB_WORKER_TTL) {
        stale.push({ workerId: worker.workerId, status: worker.status, lastSeenAt: lastSeenAt || null });
      }
    }
    if (stale.length > 0) {
      return warn("stale-workers", "workers", `${stale.length} stale worker(s)`, {
        details: stale,
        remediation: "Stale workers self-recover on next heartbeat. Check worker process health.",
      });
    }
    return ok("stale-workers", "workers", "No stale workers");
  } catch (e) {
    return warn("stale-workers", "workers", `Cannot check stale workers: ${e.message}`);
  }
}

async function checkProviderBackoff(hubRoot) {
  try {
    const rateLimitsPath = path.join(path.resolve(hubRoot), "providers", "rate-limits.json");
    let limits;
    try {
      const raw = await readFile(rateLimitsPath, "utf8");
      limits = JSON.parse(raw);
    } catch {
      return ok("provider-backoff", "provider", "No active provider backoff");
    }

    const active = [];
    const now = Date.now();
    for (const [agent, info] of Object.entries(limits)) {
      if (!info || typeof info !== "object") continue;
      const untilTs = Date.parse(info.untilTs);
      if (Number.isFinite(untilTs) && untilTs > now) {
        active.push({
          agent,
          untilTs: info.untilTs,
          reason: sanitizeProviderReason(info.reason || ""),
        });
      }
    }
    if (active.length > 0) {
      return warn("provider-backoff", "provider", `${active.length} provider(s) in rate-limit backoff`, {
        details: active,
        remediation: "Wait for rate limit to expire, or reduce request frequency.",
      });
    }
    return ok("provider-backoff", "provider", "No active provider backoff");
  } catch (e) {
    return warn("provider-backoff", "provider", `Cannot check provider backoff: ${e.message}`);
  }
}

async function checkHubProjectPollution(hubRoot) {
  try {
    const { candidates, orphanRuntimeDirs } = await scanHubPollution(hubRoot);
    const all = [...candidates, ...orphanRuntimeDirs];
    if (all.length === 0) {
      return ok("hub-project-pollution", "registry", "No test/fixture pollution detected");
    }
    const details = all.map((entry) => ({
      projectId: entry.projectId,
      sourcePath: entry.sourcePath,
      projectRuntimeRoot: entry.projectRuntimeRoot,
      runtimeDir: entry.runtimeDir,
      reasons: entry.reasons,
    }));
    return warn("hub-project-pollution", "registry", `${all.length} test/fixture/orphan pollution candidate(s) detected`, {
      details,
      remediation: "Run: cpb jobs cleanup --dry-run to review, then cpb jobs cleanup to remove.",
    });
  } catch (e) {
    return warn("hub-project-pollution", "registry", `Cannot check project pollution: ${e.message}`);
  }
}

export function buildAgentSandboxReadinessChecks({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  probe,
} = {}) {
  let policy;
  try {
    policy = resolveAgentSandboxPolicy(env, { cwd, platform, probe });
  } catch (e) {
    return [error("agent-sandbox-posture", "sandbox", `Agent sandbox policy invalid: ${e.message}`, {
      details: { error: e.message },
      remediation: "Fix CPB_AGENT_SANDBOX_* environment variables.",
    })];
  }

  const details = {
    mode: policy.mode,
    enabled: policy.enabled,
    provider: policy.provider,
    network: policy.network,
    subprocess: policy.subprocess,
    reason: policy.reason || null,
  };

  if (policy.enabled && (policy.mode === "required" || policy.mode === "strict")) {
    return [ok("agent-sandbox-posture", "sandbox", `Agent sandbox ${policy.mode} via ${policy.provider}`, { details })];
  }

  if (policy.mode === "required" || policy.mode === "strict") {
    return [error("agent-sandbox-posture", "sandbox", `Agent sandbox ${policy.mode} is not enforceable`, {
      details,
      remediation: policy.reason || "Install a supported sandbox provider or configure CPB_AGENT_SANDBOX_COMMAND.",
    })];
  }

  if (policy.enabled) {
    return [warn("agent-sandbox-posture", "sandbox", `Agent sandbox ${policy.mode} via ${policy.provider} is not fail-closed`, {
      details,
      remediation: "Use CPB_AGENT_SANDBOX=required or CPB_AGENT_SANDBOX=strict for fail-closed enforcement.",
    })];
  }

  return [warn("agent-sandbox-posture", "sandbox", "Agent process sandbox is off", {
    details,
    remediation: "Set CPB_AGENT_SANDBOX=required or CPB_AGENT_SANDBOX=strict, and configure CPB_AGENT_SANDBOX_COMMAND if no built-in provider fits this host.",
  })];
}

export async function runAgentSandboxSelfTestCheck({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  probe,
  timeout = SUBPROCESS_TIMEOUT_MS,
} = {}) {
  if (!["1", "true", "yes"].includes(String(env.CPB_AGENT_SANDBOX_SELF_TEST || "").toLowerCase())) {
    return skipped("agent-sandbox-self-test", "sandbox", "Agent sandbox live self-test not requested", {
      details: { reason: "set CPB_AGENT_SANDBOX_SELF_TEST=1 to run" },
      remediation: "Run with CPB_AGENT_SANDBOX_SELF_TEST=1 after configuring CPB_AGENT_SANDBOX=required or strict.",
    });
  }

  let policy;
  try {
    policy = resolveAgentSandboxPolicy(env, { cwd, platform, probe });
  } catch (e) {
    return error("agent-sandbox-self-test", "sandbox", `Agent sandbox live self-test cannot resolve policy: ${e.message}`, {
      details: { error: e.message },
      remediation: "Fix CPB_AGENT_SANDBOX_* environment variables.",
    });
  }

  if (!policy.enabled) {
    const failClosedRequested = policy.mode === "required" || policy.mode === "strict";
    const make = failClosedRequested ? error : warn;
    const message = failClosedRequested
      ? "Agent sandbox live self-test unavailable because sandbox is not enforceable"
      : "Agent sandbox live self-test skipped because sandbox is not enabled";
    return make("agent-sandbox-self-test", "sandbox", message, {
      details: {
        mode: policy.mode,
        reason: policy.reason || null,
      },
      remediation: "Set CPB_AGENT_SANDBOX=required or strict and ensure a supported provider is available.",
    });
  }

  let launch;
  try {
    launch = buildAgentSandboxLaunch(
      process.execPath,
      ["-e", "process.stdout.write('cpb-agent-sandbox-self-test')"],
      { env, cwd, platform, probe },
    );
  } catch (e) {
    return error("agent-sandbox-self-test", "sandbox", `Agent sandbox live self-test could not launch: ${e.message}`, {
      details: {
        mode: policy.mode,
        provider: policy.provider,
        error: e.message,
      },
      remediation: "Install/configure a sandbox provider or use CPB_AGENT_SANDBOX_COMMAND.",
    });
  }

  try {
    const result = await execFileAsync(launch.command, launch.args, {
      cwd,
      env,
      timeout,
    });
    const stdout = String(result.stdout || "");
    if (!stdout.includes("cpb-agent-sandbox-self-test")) {
      return error("agent-sandbox-self-test", "sandbox", "Agent sandbox live self-test produced unexpected output", {
        details: {
          mode: launch.sandbox.mode,
          provider: launch.sandbox.provider,
          stdout,
        },
        remediation: "Inspect the configured sandbox wrapper and provider command execution path.",
      });
    }
    return ok("agent-sandbox-self-test", "sandbox", `Agent sandbox live self-test passed via ${launch.sandbox.provider}`, {
      details: {
        mode: launch.sandbox.mode,
        provider: launch.sandbox.provider,
        command: launch.command,
        exitCode: 0,
      },
    });
  } catch (e) {
    return error("agent-sandbox-self-test", "sandbox", `Agent sandbox live self-test failed: ${e.message}`, {
      details: {
        mode: launch.sandbox?.mode || policy.mode,
        provider: launch.sandbox?.provider || policy.provider,
        command: launch.command,
        exitCode: e.code ?? null,
        signal: e.signal ?? null,
        stderr: e.stderr ? String(e.stderr) : undefined,
      },
      remediation: "Run cpb doctor with the same CPB_AGENT_SANDBOX_* env and inspect the sandbox provider/wrapper logs.",
    });
  }
}

// --- Orchestrator ---

async function checkServerDeps(cpbRoot) {
  const nmPath = path.join(path.resolve(cpbRoot), "server", "node_modules");
  try {
    await access(nmPath, fsConstants.R_OK);
    return ok("server-deps", "toolchain", "Server dependencies installed");
  } catch {
    return warn("server-deps", "toolchain", "Server dependencies not installed", {
      remediation: "Run: cd server && npm install",
    });
  }
}

async function checkGithubReadiness(hubRoot) {
  const checks = [];
  try {
    const { resolveGithubTransport } = await import("./github-api.js");
    const { loadGithubAppConfig, resolveGithubWebhookSecret } = await import("./github-app.js");
    const { listProjects } = await import("./hub-registry.js");

    // App config
    let config = null;
    try {
      config = await loadGithubAppConfig(hubRoot);
      checks.push(ok("github-app-config", "github", `GitHub App ${config.appId} configured`));
      if (config.installationId) {
        checks.push(ok("github-app-installation", "github", `Installation ${config.installationId} configured`));
      } else {
        checks.push(warn("github-app-installation", "github", "GitHub App installation id missing"));
      }
      if (config.privateKeyRef) {
        checks.push(ok("github-app-private-key", "github", `Private key configured (${config.privateKeyRef.split(":")[0]}:*)`));
      } else {
        checks.push(warn("github-app-private-key", "github", "No private key — outbound transport will use gh CLI"));
      }
    } catch {
      checks.push(error("github-app-config", "github", "GitHub App config missing or invalid"));
    }

    // Webhook secret
    if (config?.webhookSecretRef) {
      try {
        resolveGithubWebhookSecret(config);
        checks.push(ok("github-webhook-secret", "github", "Webhook secret available"));
      } catch {
        checks.push(error("github-webhook-secret", "github", "GitHub webhook secret unavailable"));
      }
    } else {
      checks.push(warn("github-webhook-secret", "github", "No webhook secret configured"));
    }

    // Transport
    try {
      const transport = await resolveGithubTransport(hubRoot);
      if (transport.mode === "api") {
        checks.push(ok("github-transport", "github", "Transport: api"));
      } else if (transport.mode === "gh") {
        const reason = transport.diagnostics?.find((d) => d.level === "info")?.message || "gh CLI fallback";
        checks.push(warn("github-transport", "github", `Transport: gh (${reason})`));
      } else {
        checks.push(error("github-transport", "github", "GitHub outbound transport unavailable"));
      }
    } catch (e) {
      checks.push(error("github-transport", "github", `GitHub transport check failed: ${e.message}`));
    }

    // Repo bindings
    try {
      const projects = await listProjects(hubRoot, { enabledOnly: true });
      const bound = projects.filter((p) => p.github?.fullName);
      if (bound.length > 0) {
        checks.push(ok("github-repo-bindings", "github", `${bound.length} repo(s) bound`));
      } else {
        checks.push(warn("github-repo-bindings", "github", "No repos bound to GitHub"));
      }
    } catch {
      checks.push(warn("github-repo-bindings", "github", "Could not check repo bindings"));
    }
  } catch (e) {
    checks.push(error("github-readiness", "github", `GitHub readiness check failed: ${e.message}`));
  }
  return checks;
}

export async function runReadinessChecks({ cpbRoot, hubRoot, adapterOverrides, env = process.env } = {}) {
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const resolvedHubRoot = path.resolve(hubRoot || resolveHubRoot(resolvedCpbRoot));
  let setup = null;
  let setupChecks = [];
  try {
    setup = await detectSetupEnvironment();
    setupChecks = buildSetupReadinessChecks(setup, listSetupAgents());
  } catch (e) {
    setup = { schemaVersion: 1, error: e.message };
    setupChecks = [warn("setup-readiness", "setup", `Setup readiness unavailable: ${e.message}`)];
  }

  // Resolve adapter checks from registry
  let adapterChecks = [];
  try {
    await agentRegistry.loadRegistry();
    const agents = agentRegistry.listAgents();
    for (const d of agents) {
      const override = adapterOverrides?.[d.name];
      const command = override?.command || d.command;
      const args = override?.args || (d.args?.length ? d.args : ["--help"]);
      const npxPkg = d.fallbackCommand === "npx" && d.fallbackArgs?.length
        ? d.fallbackArgs.find((a) => !a.startsWith("-"))
        : undefined;
      adapterChecks.push(
        checkAcpAdapter(d.name, command, args, {
          npxPkg,
          stability: d.stability,
        }),
      );
    }
  } catch {
    // Registry unavailable, fall back to hardcoded ACP adapters
    const codexAdapter = adapterOverrides?.codex || { command: "codex-acp", args: ["--help"] };
    const claudeAdapter = adapterOverrides?.claude || { command: "claude-agent-acp", args: ["--help"] };
    const reasonixAdapter = adapterOverrides?.reasonix || { command: "reasonix", args: ["acp"] };
    adapterChecks = [
      checkAcpAdapter("codex", codexAdapter.command, codexAdapter.args, { npxPkg: "@zed-industries/codex-acp" }),
      checkAcpAdapter("claude", claudeAdapter.command, claudeAdapter.args, { npxPkg: "@agentclientprotocol/claude-agent-acp" }),
      checkAcpAdapter("reasonix", reasonixAdapter.command, reasonixAdapter.args, { stability: "discovered" }),
    ];
  }

  const sandboxChecks = buildAgentSandboxReadinessChecks({ env, cwd: resolvedCpbRoot });

  const [githubChecks, sandboxSelfTestCheck, ...results] = await Promise.all([
    checkGithubReadiness(resolvedHubRoot),
    runAgentSandboxSelfTestCheck({ env, cwd: resolvedCpbRoot }),
    checkNode(),
    checkNpm(),
    checkGit(),
    checkServerDeps(resolvedCpbRoot),
    checkDiskSpace(resolvedCpbRoot, "project"),
    checkDiskSpace(resolvedHubRoot, "hub"),
    ...adapterChecks,
    checkHubLiveness(resolvedHubRoot),
    checkHubWritability(resolvedHubRoot),
    checkRegistryConsistency(resolvedHubRoot),
    checkStaleJobs(resolvedCpbRoot),
    checkStaleWorkers(resolvedHubRoot),
    checkOrphanLeases(resolvedCpbRoot),
    checkProviderBackoff(resolvedHubRoot),
    checkHubProjectPollution(resolvedHubRoot),
  ]);

  const checks = [...results, ...sandboxChecks, sandboxSelfTestCheck, ...setupChecks, ...githubChecks];
  const summary = deriveSummary(checks);

  // Collect per-project runtime roots
  let projectRuntimeRoots = {};
  try {
    const registry = await loadRegistry(resolvedHubRoot);
    for (const project of Object.values(registry.projects)) {
      if (project.projectRuntimeRoot) {
        projectRuntimeRoots[project.id] = project.projectRuntimeRoot;
      }
    }
  } catch {}

  return {
    command: "cpb doctor",
    generatedAt: new Date().toISOString(),
    roots: {
      executorRoot: resolvedCpbRoot,
      hubRoot: resolvedHubRoot,
      projectRuntimeRoots,
    },
    setup,
    summary,
    checks,
  };
}

// --- Release doctor checks ---

function okR(id, message, opts) {
  return { id, status: "ok", message, ...opts };
}

function warnR(id, message, { guidance, ...rest } = {}) {
  return { id, status: "warn", message, guidance, ...rest };
}

function failR(id, message, { guidance, ...rest } = {}) {
  return { id, status: "fail", message, guidance, ...rest };
}

async function checkReleaseCurrentMetadata({ env }) {
  const selection = await inspectCurrentRelease({ env });
  if (!selection) {
    return warnR("release.current_metadata", "No release selected", {
      guidance: "Run: cpb release use <release-id> to select a release.",
    });
  }
  if (!selection.metadata) {
    return warnR("release.current_metadata", `Release '${selection.selector?.releaseId || "unknown"}' selected but metadata is unreadable`, {
      guidance: "Release directory may be corrupt. Reinstall with: cpb release install",
    });
  }
  const m = selection.metadata;
  const missing = [];
  if (!m.releaseId) missing.push("releaseId");
  if (!m.installedPath) missing.push("installedPath");
  if (!m.codeVersion) missing.push("codeVersion");
  if (!m.stateFormatVersions) missing.push("stateFormatVersions");
  if (missing.length > 0) {
    return warnR("release.current_metadata", `Current release metadata missing fields: ${missing.join(", ")}`, {
      guidance: "Release manifest may be incomplete. Reinstall with: cpb release install",
      details: { releaseId: m.releaseId, missing },
    });
  }

  const storeRoot = resolveReleaseStoreRoot({ env });
  const resolvedInstalled = path.resolve(m.installedPath);
  if (!resolvedInstalled.startsWith(storeRoot + path.sep) && resolvedInstalled !== storeRoot) {
    return failR("release.current_metadata", `Current release '${m.releaseId}' is outside the managed release root`, {
      guidance: "Use releases installed under the managed root. Reinstall with: cpb release install",
      details: { installedPath: m.installedPath, releaseStoreRoot: storeRoot },
    });
  }

  return okR("release.current_metadata", `Current release: ${m.releaseId} v${m.codeVersion}`, {
    details: { releaseId: m.releaseId, codeVersion: m.codeVersion },
  });
}

async function checkReleaseExecutorRoot({ env }) {
  const executorRoot = env.CPB_EXECUTOR_ROOT ? path.resolve(env.CPB_EXECUTOR_ROOT) : null;
  if (!executorRoot) {
    return warnR("release.executor_root", "CPB_EXECUTOR_ROOT not set", {
      guidance: "Set CPB_EXECUTOR_ROOT or run from the CPB install directory.",
    });
  }
  let meta;
  try {
    meta = await executorMetadata(executorRoot);
  } catch (err) {
    return failR("release.executor_root", `Executor root invalid: ${err.message}`, {
      guidance: "Ensure CPB_EXECUTOR_ROOT points to a valid CPB installation with required files.",
    });
  }
  const selection = await inspectCurrentRelease({ env });
  if (selection?.metadata?.releaseId && meta.releaseId) {
    if (selection.metadata.releaseId !== meta.releaseId) {
      return warnR("release.executor_root", `Executor root release '${meta.releaseId}' differs from selected release '${selection.metadata.releaseId}'`, {
        guidance: "Run: cpb release use <release-id> to align, or restart with the correct CPB_EXECUTOR_ROOT.",
        details: { executorReleaseId: meta.releaseId, selectedReleaseId: selection.metadata.releaseId },
      });
    }
  }
  return okR("release.executor_root", `Executor root: ${executorRoot} (release: ${meta.releaseId || "dev"})`);
}

async function checkReleaseRuntimeRoot({ env }) {
  const executorRoot = env.CPB_EXECUTOR_ROOT ? path.resolve(env.CPB_EXECUTOR_ROOT) : null;
  if (!executorRoot) {
    return warnR("release.runtime_root", "Cannot check runtime root without CPB_EXECUTOR_ROOT", {
      guidance: "Set CPB_EXECUTOR_ROOT or run from the CPB install directory.",
    });
  }
  try {
    const { runtimeDataRoot } = await import("./runtime-root.js");
    const rtRoot = runtimeDataRoot(executorRoot);
    await readdir(rtRoot);
    return okR("release.runtime_root", `Runtime root readable: ${rtRoot}`);
  } catch {
    return warnR("release.runtime_root", "Runtime root not yet initialized", {
      guidance: "Runtime data will be created on first use. No action needed if this is a fresh install.",
    });
  }
}

async function checkReleaseStateFormat({ env }) {
  const selection = await inspectCurrentRelease({ env });
  if (!selection?.metadata?.stateFormatVersions) {
    return warnR("release.state_format", "No release selected or metadata missing stateFormatVersions", {
      guidance: "Select a release with: cpb release use <release-id>",
    });
  }
  const supported = await supportedStateFormatVersions();
  const mismatches = [];
  for (const [key, version] of Object.entries(selection.metadata.stateFormatVersions)) {
    if (!supported[key]?.includes(version)) {
      mismatches.push({ key, version, supported: supported[key] || [] });
    }
  }
  if (mismatches.length > 0) {
    return failR("release.state_format", `State format mismatch: ${mismatches.map(m => `${m.key}=${m.version}`).join(", ")}`, {
      guidance: "Upgrade the release or migrate runtime data to match the current state format.",
      details: mismatches,
    });
  }
  return okR("release.state_format", "State format versions compatible");
}

async function checkReleaseLauncherHealth({ env }) {
  const cpbHome = env.CPB_HOME || path.join(env.HOME || "/tmp", ".cpb");
  const binLink = path.join(cpbHome, "bin", "cpb");
  let target;
  try {
    const { realpath } = await import("node:fs/promises");
    target = await realpath(binLink);
  } catch {
    return warnR("release.launcher_health", "No launcher binary found", {
      guidance: "Install launcher with: cpb install-bin",
    });
  }
  const selection = await inspectCurrentRelease({ env });
  if (selection?.metadata?.installedPath && target) {
    const releaseDir = path.resolve(selection.metadata.installedPath);
    if (!target.startsWith(releaseDir + path.sep) && target !== path.join(releaseDir, "cpb")) {
      return warnR("release.launcher_health", `Launcher points to '${target}', outside current release '${selection.metadata.releaseId}'`, {
        guidance: "Reinstall launcher for current release: cpb install-bin",
        details: { launcherTarget: target, currentReleasePath: releaseDir },
      });
    }
  }
  return okR("release.launcher_health", `Launcher resolves to: ${target}`);
}

async function checkReleaseJobPinning({ env, cpbRoot }) {
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const selection = await inspectCurrentRelease({ env });
  const currentReleaseId = selection?.metadata?.releaseId || null;
  if (!currentReleaseId) {
    return okR("release.job_pinning", "No current release selected, skipping pin check");
  }
  try {
    const allJobs = await listJobs(resolvedCpbRoot);
    const issues = [];
    for (const job of allJobs) {
      const jobReleaseId = job.executor?.releaseId
        || job.lineage?.executorSelection?.selectedReleaseId
        || job.lineage?.executorSelection?.parentReleaseId
        || null;
      if (!jobReleaseId) continue;
      if (jobReleaseId !== currentReleaseId) {
        const terminal = ["completed", "failed", "blocked", "cancelled"].includes(job.status);
        issues.push({
          jobId: job.jobId,
          status: job.status,
          jobReleaseId,
          currentReleaseId,
          severity: terminal ? "info" : "warn",
        });
      }
    }
    if (issues.length === 0) {
      return okR("release.job_pinning", "All jobs reference the current release");
    }
    const active = issues.filter(i => i.severity === "warn");
    if (active.length > 0) {
      return warnR("release.job_pinning", `${active.length} active job(s) pinned to a different release`, {
        guidance: "Active jobs may depend on the old release. Wait for them to complete or recover with: cpb retry --use-current-executor",
        details: active,
      });
    }
    return okR("release.job_pinning", `${issues.length} completed job(s) used older releases (no action needed)`, {
      details: issues,
    });
  } catch (err) {
    return warnR("release.job_pinning", `Cannot check job pinning: ${err.message}`);
  }
}

export async function runReleaseDoctorChecks({ cpbRoot, env = process.env } = {}) {
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const checks = await Promise.all([
    checkReleaseCurrentMetadata({ env }),
    checkReleaseExecutorRoot({ env }),
    checkReleaseRuntimeRoot({ env }),
    checkReleaseStateFormat({ env }),
    checkReleaseLauncherHealth({ env }),
    checkReleaseJobPinning({ env, cpbRoot: resolvedCpbRoot }),
  ]);

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status]++;
  summary.success = summary.fail === 0;

  return {
    command: "cpb release doctor",
    generatedAt: new Date().toISOString(),
    summary,
    checks,
  };
}

export function formatReleaseDoctorHuman(result) {
  const { summary, checks } = result;
  const lines = [];
  lines.push(`${BOLD}Release Doctor${NC}`);
  lines.push("");
  for (const check of checks) {
    const color = STATUS_COLOR[check.status === "fail" ? "error" : check.status === "warn" ? "warn" : "ok"];
    const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗";
    let line = `  ${color}${icon}${NC} ${check.id}: ${check.message}`;
    if (check.guidance) line += ` ${color}→ ${check.guidance}${NC}`;
    lines.push(line);
  }
  lines.push("");
  if (summary.success) {
    if (summary.warn > 0) {
      lines.push(`  ${STATUS_COLOR.warn}${summary.warn} warning(s)${NC}, ${summary.ok} passed.`);
    } else {
      lines.push(`  ${STATUS_COLOR.ok}All release checks passed.${NC}`);
    }
  } else {
    lines.push(`  ${STATUS_COLOR.error}${summary.fail} failure(s)${NC}, ${summary.warn} warning(s), ${summary.ok} passed.`);
  }
  return lines.join("\n");
}

export function formatReleaseDoctorJson(result) {
  return JSON.stringify(result, null, 2);
}

// --- Output formatters ---

const CATEGORY_ORDER = ["toolchain", "disk", "setup", "sandbox", "acp", "hub", "registry", "jobs", "workers", "leases", "provider"];
const CATEGORY_LABELS = {
  toolchain: "Toolchain",
  disk: "Disk",
  setup: "Setup",
  sandbox: "Agent Sandbox",
  acp: "ACP Adapters",
  hub: "Hub",
  registry: "Registry",
  jobs: "Jobs",
  workers: "Workers",
  leases: "Leases",
  provider: "Provider",
};

const STATUS_ICON = { ok: "✓", warn: "!", error: "✗", skipped: "-" };
const STATUS_COLOR = {
  ok: "\x1b[0;32m",
  warn: "\x1b[1;33m",
  error: "\x1b[0;31m",
  skipped: "\x1b[0;36m",
};
const NC = "\x1b[0m";
const BOLD = "\x1b[1m";

export function formatReadinessHuman(result) {
  const redacted = redactSecrets(result);
  const { summary, checks } = redacted;
  const lines = [];

  lines.push(`${BOLD}CodePatchbay Doctor${NC}`);

  const byCategory = new Map();
  for (const check of checks) {
    if (!byCategory.has(check.category)) byCategory.set(check.category, []);
    byCategory.get(check.category).push(check);
  }

  for (const cat of CATEGORY_ORDER) {
    const catChecks = byCategory.get(cat);
    if (!catChecks) continue;
    lines.push("");
    lines.push(`  ${BOLD}${CATEGORY_LABELS[cat] || cat}:${NC}`);
    for (const check of catChecks) {
      const color = STATUS_COLOR[check.status];
      const icon = STATUS_ICON[check.status];
      let line = `    ${color}${icon}${NC} ${check.message}`;
      if (check.remediation) line += ` ${color}→ ${check.remediation}${NC}`;
      lines.push(line);
    }
  }

  lines.push("");
  if (summary.success) {
    if (summary.warn > 0) {
      lines.push(`  ${STATUS_COLOR.warn}${summary.warn} warning(s)${NC}, ${summary.ok} passed, ${summary.skipped} skipped.`);
    } else {
      lines.push(`  ${STATUS_COLOR.ok}All checks passed.${NC}`);
    }
  } else {
    lines.push(`  ${STATUS_COLOR.error}${summary.error} error(s)${NC}, ${summary.warn} warning(s), ${summary.ok} passed.`);
  }

  return lines.join("\n");
}

export function formatReadinessJson(result) {
  const redacted = redactSecrets(result);
  const normalized = {
    ...redacted,
    readiness: redacted.readiness ?? deriveReadinessLevels(redacted.checks || []),
    checks: (redacted.checks || []).map((check) => ({
      ...check,
      evidence: check.evidence ?? check.details ?? { message: check.message },
      recommendedAction: check.recommendedAction ?? check.remediation ?? null,
    })),
  };
  return JSON.stringify(normalized, null, 2);
}
