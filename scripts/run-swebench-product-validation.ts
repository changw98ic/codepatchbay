#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registerProject } from "../server/services/hub/hub-registry.js";
import { writeJsonAtomic } from "../shared/fs-utils.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import type { LooseRecord } from "../shared/types.js";

type SweBenchRecord = LooseRecord & {
  benchmarkInstanceId?: string;
  representativeRepository?: string;
  baseCommit?: string;
  datasetRowRef?: string;
  evidenceBundleRef?: string;
};

export type ProductValidationPlanMode = "full" | "light";
export type ProductValidationAgents = {
  planner: string;
  executor: string;
  verifier: string;
  adversarial_verifier: string;
};

type CliOptions = {
  instance: string | null;
  agent: string;
  agents: ProductValidationAgents;
  timeoutMs: number;
  keepTemp: boolean;
  outputDir: string;
  planMode: ProductValidationPlanMode;
};

type CommandResult = {
  command: string;
  args: string[];
  cwd: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  errorMessage?: string | null;
};

type CodeGraphEvidence = {
  init: {
    code: number | null;
    stdoutTail: string;
    stderrTail: string;
  };
  statusCommand: {
    code: number | null;
    stdoutTail: string;
    stderrTail: string;
  };
};

type SweBenchVerificationCommands = {
  failToPass: string[];
  passToPass: string[];
  notes: string[];
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_ROOT = path.resolve(import.meta.dirname, "..");
const PRODUCT_EVIDENCE_FILE = process.env.CPB_SWEBENCH_PRODUCT_EVIDENCE_FILE
  ? path.resolve(process.env.CPB_SWEBENCH_PRODUCT_EVIDENCE_FILE)
  : path.join(REPO_ROOT, "docs", "product", "cpb-flagship-product-validation.json");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "docs", "product", "evidence", "swe-bench-real-runs");
export const DEFAULT_PRODUCT_VALIDATION_AGENTS: ProductValidationAgents = {
  planner: "codex",
  executor: "claude-glm",
  verifier: "claude-mimo",
  adversarial_verifier: "claude-mimo",
};

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] || null;
}

function parsePlanMode(value: string | null): ProductValidationPlanMode {
  if (value === null || value === "full") return "full";
  if (value === "light") return "light";
  throw new Error(`--plan-mode must be "full" or "light", got ${value}`);
}

export function resolveProductValidationAgents(args: string[]): ProductValidationAgents {
  const singleAgent = argValue(args, "--agent");
  if (singleAgent) {
    return {
      planner: singleAgent,
      executor: singleAgent,
      verifier: singleAgent,
      adversarial_verifier: singleAgent,
    };
  }
  return {
    planner: argValue(args, "--planner-agent") || DEFAULT_PRODUCT_VALIDATION_AGENTS.planner,
    executor: argValue(args, "--executor-agent") || DEFAULT_PRODUCT_VALIDATION_AGENTS.executor,
    verifier: argValue(args, "--verifier-agent") || DEFAULT_PRODUCT_VALIDATION_AGENTS.verifier,
    adversarial_verifier: argValue(args, "--adversarial-agent") || DEFAULT_PRODUCT_VALIDATION_AGENTS.adversarial_verifier,
  };
}

function summarizeAgents(agents: ProductValidationAgents) {
  return [...new Set([agents.planner, agents.executor, agents.verifier, agents.adversarial_verifier])].join("+");
}

function agentNames(agents: ProductValidationAgents) {
  return [agents.planner, agents.executor, agents.verifier, agents.adversarial_verifier];
}

function shouldPrintHelp(argv: string[]) {
  return argv.includes("--help") || argv.includes("-h");
}

function printUsage() {
  console.log(`Usage: node dist/scripts/run-swebench-product-validation.js [options]

Options:
  --instance <id>       SWE-bench Verified instance id to run.
  --agent <name>        Single real agent override for all phases.
  --planner-agent <n>   Planner agent. Defaults to codex.
  --executor-agent <n>  Executor agent. Defaults to claude-glm.
  --verifier-agent <n>  Verifier agent. Defaults to claude-mimo.
  --adversarial-agent <n> Adversarial verifier agent. Defaults to claude-mimo.
  --timeout-ms <ms>     Managed worker timeout. Defaults to 1800000.
  --keep-temp           Keep temporary source, hub, and cpb directories.
  --output-dir <dir>    Directory for the evidence bundle.
  --plan-mode <mode>    full or light. Defaults to full.
  -h, --help            Show this help.
`);
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const agents = resolveProductValidationAgents(args);
  return {
    instance: argValue(args, "--instance"),
    agent: summarizeAgents(agents),
    agents,
    timeoutMs: Number.parseInt(argValue(args, "--timeout-ms") || "1800000", 10),
    keepTemp: args.includes("--keep-temp"),
    outputDir: path.resolve(argValue(args, "--output-dir") || DEFAULT_OUTPUT_DIR),
    planMode: parsePlanMode(argValue(args, "--plan-mode")),
  };
}

function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stringArrayFromJson(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value !== "string" || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [value];
  }
}

function safeId(value: string) {
  return value
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "sample";
}

async function readJson(filePath: string): Promise<LooseRecord> {
  return JSON.parse(await readFile(filePath, "utf8")) as LooseRecord;
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readTextTail(filePath: string, limit = 8000) {
  try {
    return (await readFile(filePath, "utf8")).slice(-limit);
  } catch {
    return null;
  }
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs = 300000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ command, args, cwd, code, signal, stdout, stderr });
    });
  });
}

async function runRequired(command: string, args: string[], cwd: string, timeoutMs?: number) {
  const result = await runCommand(command, args, cwd, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function scopedPathVariants(targetPath: string) {
  const resolved = path.resolve(targetPath);
  const variants = new Set([resolved]);
  if (resolved.startsWith("/var/")) variants.add(`/private${resolved}`);
  if (resolved.startsWith("/private/var/")) variants.add(resolved.replace(/^\/private/, ""));
  return [...variants];
}

async function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupScopedCodegraphDaemons(worktreePath: string) {
  const variants = scopedPathVariants(worktreePath);
  const result = await runCommand("ps", ["-axo", "pid=,command="], REPO_ROOT, 30000).catch(() => null);
  const lines = result?.stdout.split("\n") || [];
  const matches = lines
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number.parseInt(match[1], 10), command: match[2] };
    })
    .filter((entry): entry is { pid: number; command: string } => Boolean(entry))
    .filter((entry) => entry.command.includes("codegraph"))
    .filter((entry) => entry.command.includes("serve"))
    .filter((entry) => entry.command.includes("--mcp"))
    .filter((entry) => variants.some((variant) => entry.command.includes(variant)));

  for (const entry of matches) {
    try { process.kill(entry.pid, "SIGTERM"); } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  const killed: number[] = [];
  for (const entry of matches) {
    if (await processAlive(entry.pid)) {
      try {
        process.kill(entry.pid, "SIGKILL");
        killed.push(entry.pid);
      } catch {}
    } else {
      killed.push(entry.pid);
    }
  }

  return {
    worktreePath,
    matchedPids: matches.map((entry) => entry.pid),
    killedPids: killed,
  };
}

async function fetchDatasetRow(record: SweBenchRecord) {
  const ref = stringValue(record.datasetRowRef);
  if (!ref) throw new Error(`record ${record.benchmarkInstanceId} is missing datasetRowRef`);
  const response = await fetch(ref);
  if (!response.ok) throw new Error(`failed to fetch ${ref}: ${response.status} ${response.statusText}`);
  const payload = await response.json() as LooseRecord;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const first = rows[0];
  if (!isRecord(first) || !isRecord(first.row)) {
    throw new Error(`dataset row ref did not return a row: ${ref}`);
  }
  return {
    rowIndex: first.row_idx,
    row: first.row as LooseRecord,
  };
}

async function cloneAtCommit({ repo, baseCommit, targetDir }: { repo: string; baseCommit: string; targetDir: string }) {
  await mkdir(targetDir, { recursive: true });
  await runRequired("git", ["init"], targetDir);
  await runRequired("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], targetDir);
  await runRequired("git", ["fetch", "--depth=1", "origin", baseCommit], targetDir, 600000);
  await runRequired("git", ["checkout", "--detach", "FETCH_HEAD"], targetDir);
}

async function initCodeGraph(sourcePath: string): Promise<CodeGraphEvidence> {
  const init = await runRequired("codegraph", ["init", sourcePath], REPO_ROOT, 600000);
  const status = await runRequired("codegraph", ["status", sourcePath], REPO_ROOT, 120000);
  return {
    init: {
      code: init.code,
      stdoutTail: init.stdout.slice(-4000),
      stderrTail: init.stderr.slice(-4000),
    },
    statusCommand: {
      code: status.code,
      stdoutTail: status.stdout.slice(-4000),
      stderrTail: status.stderr.slice(-4000),
    },
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function parenthesizedTestTarget(testName: string) {
  const match = testName.match(/\(([^)]+)\)\s*$/);
  return match?.[1]?.trim() || "";
}

function isDjangoDottedTestTarget(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value);
}

function dottedTestGroup(testName: string) {
  const trimmed = testName.trim();
  const parenthesized = parenthesizedTestTarget(trimmed);
  if (parenthesized) return isDjangoDottedTestTarget(parenthesized) ? parenthesized : "";
  const parts = trimmed.split(".").filter(Boolean);
  const last = parts.at(-1) || "";
  if (parts.length > 1 && /^test/i.test(last)) {
    const group = parts.slice(0, -1).join(".");
    return isDjangoDottedTestTarget(group) ? group : "";
  }
  return isDjangoDottedTestTarget(trimmed) ? trimmed : "";
}

function djangoCommandTarget(testName: string) {
  const trimmed = testName.trim();
  const parenthesized = parenthesizedTestTarget(trimmed);
  if (parenthesized) {
    if (!isDjangoDottedTestTarget(parenthesized)) return "";
    const methodText = trimmed.slice(0, trimmed.lastIndexOf("(")).trim();
    const methodName = methodText.split(/\s+/).filter(Boolean).at(-1) || "";
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(methodName) && /^test/i.test(methodName)) {
      return `${parenthesized}.${methodName}`;
    }
    return parenthesized;
  }
  return isDjangoDottedTestTarget(trimmed) ? trimmed : "";
}

function djangoRuntestsCommand(tests: string[], limit?: number) {
  const targets = uniqueStrings(tests.map(djangoCommandTarget));
  const scopedTargets = typeof limit === "number" ? targets.slice(0, limit) : targets;
  if (scopedTargets.length === 0) return null;
  return `PYTHONPATH=. python3 tests/runtests.py ${scopedTargets.join(" ")}`;
}

function djangoDiagnosticCommand(tests: string[], limit = 4) {
  const groups = uniqueStrings(tests.map(dottedTestGroup).filter(Boolean)).slice(0, limit);
  if (groups.length === 0) return null;
  return `PYTHONPATH=. python3 tests/runtests.py ${groups.join(" ")}`;
}

function pytestCommand(tests: string[], limit?: number) {
  const targets = uniqueStrings(tests);
  const scopedTargets = typeof limit === "number" ? targets.slice(0, limit) : targets;
  if (scopedTargets.length === 0) return null;
  return `python3 -m pytest -q ${scopedTargets.join(" ")}`;
}

function pytestDiagnosticTarget(testName: string) {
  const trimmed = testName.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("::").filter(Boolean);
  if (parts.length >= 3) return `${parts[0]}::${parts[1]}`;
  if (parts.length >= 2) return parts[0];
  return trimmed;
}

function pytestDiagnosticCommand(tests: string[], limit = 4) {
  const targets = uniqueStrings(tests.map(pytestDiagnosticTarget).filter(Boolean)).slice(0, limit);
  if (targets.length === 0) return null;
  return `python3 -m pytest -q ${targets.join(" ")}`;
}

export function deriveSweBenchDiagnosticCommands(row: LooseRecord, record: SweBenchRecord): string[] {
  const failToPass = stringArrayFromJson(row.FAIL_TO_PASS);
  const command = record.representativeRepository === "django/django"
    ? djangoDiagnosticCommand(failToPass)
    : pytestDiagnosticCommand(failToPass);
  return uniqueStrings([command].filter((item): item is string => Boolean(item)));
}

export function deriveSweBenchVerificationCommands(
  row: LooseRecord,
  record: SweBenchRecord,
): SweBenchVerificationCommands {
  const failToPass = stringArrayFromJson(row.FAIL_TO_PASS);
  const passToPass = stringArrayFromJson(row.PASS_TO_PASS);
  const notes = [
    "Before changing implementation code, add or update a minimal real in-repo regression test that reproduces the issue and fails before the implementation change and passes after the fix.",
    "Use the exact canonical FAIL_TO_PASS command for failing-before and passing-after regression evidence; do not create a smaller direct regression command.",
    "Do not satisfy this by editing fakes, fixtures, snapshots, or generated test doubles.",
    "Treat SWE-bench FAIL_TO_PASS/PASS_TO_PASS test names as verification targets and external oracle targets in addition to your own regression test, not as a substitute for creating local coverage.",
    "Do not replace these canonical commands with broad package, app, full-suite, or self-invented test commands; canonical command results remain the acceptance ledger evidence.",
    "Run the exact canonical commands when recording SWE-bench acceptance evidence. Do not split, shorten, pipe, redirect, wrap, tail, or otherwise transform the canonical evidence commands.",
    "Use bounded code inspection or explicitly allowed diagnostics to prove the real problem path and bypass candidates; these diagnostics can supplement but never replace canonical acceptance evidence.",
    "If an exact canonical command fails, record that failure as evidence and fix the implementation; do not invent smaller replacement commands.",
  ];
  if (record.representativeRepository !== "django/django") {
    return {
      failToPass: uniqueStrings([pytestCommand(failToPass)].filter((item): item is string => Boolean(item))),
      passToPass: uniqueStrings([pytestCommand(passToPass, 4)].filter((item): item is string => Boolean(item))),
      notes,
    };
  }

  return {
    failToPass: uniqueStrings([djangoRuntestsCommand(failToPass)].filter((item): item is string => Boolean(item))),
    passToPass: uniqueStrings([djangoRuntestsCommand(passToPass, 4)].filter((item): item is string => Boolean(item))),
    notes: [
      "Django test commands must run from the repository root with PYTHONPATH=. and tests/runtests.py.",
      "Do not shorten the command path or omit the environment prefix.",
      ...notes,
    ],
  };
}

export function buildTask(row: LooseRecord, record: SweBenchRecord) {
  // The solver receives the same task surface as an ordinary CPB job. Dataset
  // identity, oracle tests, and scorer data stay outside the solving path.
  void record;
  return stringValue(row.problem_statement).trim();
}

async function writeAssignment({
  hubRoot,
  workerId,
  sourcePath,
  record,
  row,
  agents,
  planMode,
}: {
  hubRoot: string;
  workerId: string;
  sourcePath: string;
  record: SweBenchRecord;
  row: LooseRecord;
  agents: ProductValidationAgents;
  planMode: ProductValidationPlanMode;
}) {
  const projectId = safeId(`swebench-${record.benchmarkInstanceId}`);
  const assignmentId = safeId(`a-${record.benchmarkInstanceId}`);
  const entryId = safeId(record.benchmarkInstanceId || "swebench");
  const jobId = `job-${entryId}`;
  const attemptToken = `attempt-${entryId}-001`;
  const task = buildTask(row, record);
  const project = await registerProject(hubRoot, {
    id: projectId,
    name: projectId,
    sourcePath,
    metadata: {
      productValidation: true,
      benchmarkDataset: "SWE-bench/SWE-bench_Verified",
      benchmarkInstanceId: record.benchmarkInstanceId,
    },
  });

  const attemptDir = path.join(hubRoot, "assignments", assignmentId, "attempts", "001");
  await mkdir(path.join(attemptDir, "control"), { recursive: true });
  await writeJson(path.join(attemptDir, "attempt.json"), {
    assignmentId,
    attempt: 1,
    entryId,
    projectId,
    workerId,
    status: "assigned",
    attemptToken,
    createdAt: new Date().toISOString(),
  });
  await writeJson(path.join(hubRoot, "workers", "inbox", workerId, `${assignmentId}.json`), {
    assignmentId,
    entryId,
    projectId,
    workerId,
    task,
    sourcePath,
    workflow: "standard",
    planMode,
    sourceContext: {
      benchmarkDataset: "SWE-bench/SWE-bench_Verified",
      benchmarkInstanceId: record.benchmarkInstanceId,
      benchmarkRepository: record.representativeRepository,
      benchmarkBaseCommit: record.baseCommit,
      issueNumber: null,
      productValidation: {
        validationMode: "swe-bench-verified",
        benchmarkInstanceId: record.benchmarkInstanceId,
        planMode,
        agents,
      },
    },
    metadata: {
      autoFinalize: true,
      finalizeMode: "dry-run",
      agents: {
        planner: agents.planner,
        executor: agents.executor,
        verifier: agents.verifier,
        adversarial_verifier: agents.adversarial_verifier,
      },
      productValidation: {
        validationMode: "swe-bench-verified",
        benchmarkInstanceId: record.benchmarkInstanceId,
        planMode,
        agents,
      },
    },
    attempt: 1,
    attemptToken,
    orchestratorEpoch: 1,
  });
  return { project, projectId, assignmentId, entryId, attemptDir };
}

export async function runManagedWorker({
  workerId,
  hubRoot,
  cpbRoot,
  assignmentId,
  phaseAgents,
  timeoutMs,
  distRoot = DIST_ROOT,
  extraEnv = {},
}: {
  workerId: string;
  hubRoot: string;
  cpbRoot: string;
  assignmentId: string;
  phaseAgents: ProductValidationAgents;
  timeoutMs: number;
  distRoot?: string;
  extraEnv?: NodeJS.ProcessEnv;
}) {
  const workerScript = path.join(distRoot, "runtime", "worker", "managed-worker.js");
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(process.execPath, [
      workerScript,
      "--worker-id", workerId,
      "--hub-root", hubRoot,
      "--cpb-root", cpbRoot,
      "--once",
    ], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...extraEnv,
        CPB_ROOT: cpbRoot,
        CPB_HUB_ROOT: hubRoot,
        CPB_EXECUTOR_ROOT: REPO_ROOT,
        CPB_PROJECT_ROOTS: path.dirname(hubRoot),
        CPB_WORKER_DISPATCH_ENABLED: "0",
        CPB_ACP_USE_MANAGED_POOL: "0",
        CPB_ACP_PERSISTENT_PROCESS: "0",
        CPB_DYNAMIC_VERIFIER_AGENT: phaseAgents.verifier,
        CPB_PRODUCT_VALIDATION_KEEP_WORKTREE: "1",
        CPB_ACP_TIMEOUT_MS: String(timeoutMs),
        CPB_ACP_IDLE_TIMEOUT_MS: process.env.CPB_ACP_IDLE_TIMEOUT_MS || String(Math.min(timeoutMs, 600_000)),
        CPB_ACP_PHASE_TIMEOUT_MS: String(timeoutMs),
        CPB_ACP_POOL_TIMEOUT_MS: String(timeoutMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      void (async () => {
        try {
          const store = new AssignmentStore(hubRoot);
          await store.init();
          await store.writeCancel(assignmentId, 1, `product validation timed out after ${timeoutMs}ms`);
        } catch (error) {
          stderr += `\n[product-validation] failed to request worker cancellation: ${error instanceof Error ? error.message : String(error)}\n`;
        }
      })();
      setTimeout(() => {
        if (timedOut && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (timedOut && child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, 5_000).unref();
        }
      }, 30_000).unref();
    }, timeoutMs + 30000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command: process.execPath,
        args: [workerScript],
        cwd: REPO_ROOT,
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command: process.execPath,
        args: [workerScript],
        cwd: REPO_ROOT,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        errorMessage: timedOut ? `managed worker timed out after ${timeoutMs}ms` : null,
      });
    });
  });
}

function summarizeJobResult(result: LooseRecord | null) {
  const jobResult = isRecord(result?.jobResult) ? result.jobResult : {};
  const finalizeResult = isRecord(result?.finalizeResult) ? result.finalizeResult : null;
  const phaseResults = Array.isArray(jobResult.phaseResults)
    ? jobResult.phaseResults.map((phase) => isRecord(phase) ? phase.phase : null)
    : [];
  const failure = isRecord(jobResult.failure) ? jobResult.failure : {};
  const failurePhase = typeof failure.phase === "string" ? failure.phase : null;
  return {
    assignmentStatus: result?.status || null,
    jobStatus: jobResult.status || null,
    jobId: jobResult.jobId || null,
    phases: phaseResults.length > 0 ? phaseResults : (failurePhase ? [failurePhase] : []),
    completionGate: jobResult.completionGate || jobResult.completionGateResult || null,
    finalizeResult,
  };
}

async function main() {
  if (shouldPrintHelp(process.argv)) {
    printUsage();
    return;
  }

  const options = parseArgs(process.argv);
  const evidence = await readJson(PRODUCT_EVIDENCE_FILE);
  const records = Array.isArray(evidence.records) ? evidence.records.filter(isRecord) as SweBenchRecord[] : [];
  const record = records.find((item) => item.validationMode === "swe-bench-verified" && (
    options.instance ? item.benchmarkInstanceId === options.instance : true
  ));
  if (!record) {
    throw new Error(`No SWE-bench Verified record found${options.instance ? ` for ${options.instance}` : ""}`);
  }
  if (agentNames(options.agents).includes("fake-acp")) {
    throw new Error("Refusing to run product validation with fake-acp. Use a real agent such as codex or claude.");
  }
  const previousIndexOnly = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
  process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = "1";

  const { rowIndex, row } = await fetchDatasetRow(record);
  const problemHash = createHash("sha256").update(stringValue(row.problem_statement)).digest("hex");
  if (problemHash !== record.problemStatementSha256) {
    throw new Error(`problem statement hash mismatch for ${record.benchmarkInstanceId}: ${problemHash}`);
  }

  const tmpRoot = path.join(os.tmpdir(), `cpb-swebench-${safeId(record.benchmarkInstanceId || "sample")}-${Date.now()}`);
  await mkdir(tmpRoot, { recursive: true });
  const hubRoot = path.join(tmpRoot, "hub");
  const cpbRoot = path.join(tmpRoot, "cpb");
  const sourcePath = path.join(tmpRoot, "source");
  const workerId = "w-swebench";
  let bundlePath: string | null = null;
  let codegraphEvidence: CodeGraphEvidence | null = null;
  const failToPassTests = stringArrayFromJson(row.FAIL_TO_PASS);
  const passToPassTests = stringArrayFromJson(row.PASS_TO_PASS);

  try {
    await new AssignmentStore(hubRoot).init();
    await cloneAtCommit({
      repo: stringValue(record.representativeRepository),
      baseCommit: stringValue(record.baseCommit),
      targetDir: sourcePath,
    });
    codegraphEvidence = await initCodeGraph(sourcePath);
    const assignment = await writeAssignment({
      hubRoot,
      workerId,
      sourcePath,
      record,
      row,
      agents: options.agents,
      planMode: options.planMode,
    });
    const worker = await runManagedWorker({
      workerId,
      hubRoot,
      cpbRoot,
      assignmentId: assignment.assignmentId,
      phaseAgents: options.agents,
      timeoutMs: options.timeoutMs,
    });
    const resultPath = path.join(assignment.attemptDir, "result.json");
    const heartbeatPath = path.join(assignment.attemptDir, "heartbeat.json");
    const eventLogPath = path.join(hubRoot, "projects", assignment.projectId, "events", assignment.projectId, `job-${assignment.entryId}.jsonl`);
    const acpAuditPath = path.join(hubRoot, "projects", assignment.projectId, "acp-audit", assignment.projectId, `job-${assignment.entryId}.jsonl`);
    const worktreePath = path.join(hubRoot, "worktrees", `job-${assignment.entryId}-pipeline`);
    const codegraphDaemonCleanup = await cleanupScopedCodegraphDaemons(worktreePath);
    const result = await readJson(resultPath).catch(() => null);
    const heartbeat = await readJson(heartbeatPath).catch(() => null);
    const worktreeStatus = await runCommand("git", ["status", "--short"], worktreePath, 120000).catch((error: unknown) => ({
      command: "git",
      args: ["status", "--short"],
      cwd: worktreePath,
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      errorMessage: error instanceof Error ? error.message : String(error),
    } satisfies CommandResult));
    const worktreeDiffStat = await runCommand("git", ["diff", "--stat"], worktreePath, 120000).catch((error: unknown) => ({
      command: "git",
      args: ["diff", "--stat"],
      cwd: worktreePath,
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      errorMessage: error instanceof Error ? error.message : String(error),
    } satisfies CommandResult));
    const summary = summarizeJobResult(result);
    const bundle = {
      schemaVersion: 1,
      validationMode: "swe-bench-verified-real-run",
      validatedAt: new Date().toISOString(),
      agent: options.agent,
      agents: options.agents,
      planMode: options.planMode,
      source: {
        dataset: "SWE-bench/SWE-bench_Verified",
        split: "test",
        datasetRowRef: record.datasetRowRef,
        rowIndex,
      },
      sample: {
        instanceId: record.benchmarkInstanceId,
        repository: record.representativeRepository,
        baseCommit: record.baseCommit,
        problemStatementSha256: problemHash,
        failToPassTests: failToPassTests.length,
        passToPassTests: passToPassTests.length,
      },
      cpbRun: {
        hubRoot,
        cpbRoot,
        sourcePath,
        codegraph: codegraphEvidence,
        codegraphIndexOnlyAccepted: true,
        capabilityMapConfidence: assignment.project.metadata?.capabilityMapConfidence || null,
        projectRuntimeRoot: assignment.project.projectRuntimeRoot,
        resultPath,
        workerExitCode: worker.code,
        workerSignal: worker.signal,
        workerTimedOut: worker.timedOut || false,
        workerErrorMessage: worker.errorMessage || null,
        codegraphDaemonCleanup,
        stdoutTail: worker.stdout.slice(-4000),
        stderrTail: worker.stderr.slice(-4000),
        heartbeat,
        eventLogTail: await readTextTail(eventLogPath),
        acpAuditTail: await readTextTail(acpAuditPath),
        worktreeStatus: {
          code: worktreeStatus.code,
          stdout: worktreeStatus.stdout,
          stderrTail: worktreeStatus.stderr.slice(-2000),
          errorMessage: worktreeStatus.errorMessage || null,
        },
        worktreeDiffStat: {
          code: worktreeDiffStat.code,
          stdout: worktreeDiffStat.stdout,
          stderrTail: worktreeDiffStat.stderr.slice(-2000),
          errorMessage: worktreeDiffStat.errorMessage || null,
        },
        summary,
      },
    };
    bundlePath = path.join(options.outputDir, `${safeId(record.benchmarkInstanceId || "sample")}-real-run.json`);
    await writeJsonAtomic(bundlePath, bundle);
    console.log(`Wrote SWE-bench product validation evidence: ${path.relative(REPO_ROOT, bundlePath)}`);
    console.log(JSON.stringify(summary, null, 2));
    if (worker.code !== 0 || worker.timedOut || summary.jobStatus !== "completed") {
      process.exitCode = 1;
    }
  } finally {
    if (options.keepTemp) {
      console.error(`[keep-temp] ${tmpRoot}`);
    } else {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (previousIndexOnly === undefined) delete process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
    else process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = previousIndexOnly;
  }

  if (!bundlePath) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
