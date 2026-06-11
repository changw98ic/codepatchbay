#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HOME = os.homedir();
const PROJECT_ID = process.env.CPB_FLOW_PROJECT || "flow";
const REPO_ROOT = process.env.CPB_FLOW_REPO || "/Users/chengwen/dev/flow";
const CPB_ROOT = process.env.CPB_HUB_ROOT || process.env.CPB_ROOT || path.join(HOME, ".cpb");
const STATE_DIR = process.env.CPB_FLOW_CRON_STATE || path.join(CPB_ROOT, "automation", "flow-cron");
const QUEUE_FILE = path.join(CPB_ROOT, "queue", "queue.json");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOCK_FILE = path.join(STATE_DIR, "run.lock");
const REVIEW_SCHEMA_FILE = path.join(STATE_DIR, "review-schema.json");
const LOG_DIR = path.join(STATE_DIR, "logs");
const REVIEW_DIR = path.join(STATE_DIR, "reviews");
const REJECT_DIR = path.join(STATE_DIR, "rejects");
const LOCK_TTL_MS = 6 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = Number(process.env.CPB_FLOW_CRON_COMMAND_TIMEOUT_MS || 30 * 60 * 1000);
const MAX_RETRIES_PER_TASK = Number(process.env.CPB_FLOW_CRON_MAX_RETRIES_PER_TASK || 1);

type AnyRecord = Record<string, any>;
type QueueEntry = AnyRecord;
type CronOptions = AnyRecord;
type CommandResult = {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  error: any;
};

const BIN = {
  node: process.execPath,
  codex: process.env.CODEX_BIN || "/Users/chengwen/.npm-global/bin/codex",
  cpb: process.env.CPB_BIN || "/Users/chengwen/.nvm/versions/node/v24.4.1/bin/cpb",
  gh: process.env.GH_BIN || "/opt/homebrew/bin/gh",
  git: process.env.GIT_BIN || "/usr/bin/git",
};

const ENV = {
  ...process.env,
  PATH: [
    path.dirname(BIN.node),
    path.dirname(BIN.cpb),
    path.dirname(BIN.codex),
    path.dirname(BIN.gh),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":"),
};

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  return [
    "Usage: node scripts/cpb-flow-cron.js [--bootstrap-existing|--process-existing|--dry-run]",
    "",
    "Default mode processes new completed CPB queue entries for project flow.",
    "--bootstrap-existing marks current completed entries as already seen.",
    "--process-existing allows processing completed entries already present before install.",
  ].join("\n");
}

function parseArgs(argv: string[]): CronOptions {
  const out = { bootstrapExisting: false, processExisting: false, dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === "--bootstrap-existing") out.bootstrapExisting = true;
    else if (arg === "--process-existing") out.processExisting = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

async function ensureRuntimeDirs() {
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.mkdir(REVIEW_DIR, { recursive: true });
  await fsp.mkdir(REJECT_DIR, { recursive: true });
}

async function readJson(file: string, fallback: any = null): Promise<any> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT" && fallback !== null) return fallback;
    throw err;
  }
}

async function writeJsonAtomic(file: string, value: any): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

async function appendRunLog(line: string): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  await fsp.appendFile(path.join(LOG_DIR, `${stamp}.log`), `${nowIso()} ${line}\n`);
  console.log(line);
}

function defaultState(): AnyRecord {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    createdAt: nowIso(),
    baselineAt: null,
    processed: {},
    taskLastProcessed: {},
    runs: [],
  };
}

async function loadState(): Promise<AnyRecord> {
  return readJson(STATE_FILE, defaultState());
}

async function acquireLock() {
  await fsp.mkdir(STATE_DIR, { recursive: true });
  try {
    const handle = await fsp.open(LOCK_FILE, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: nowIso() }));
    return async () => {
      await handle.close().catch(() => {});
      await fsp.rm(LOCK_FILE, { force: true }).catch(() => {});
    };
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    const stat = await fsp.stat(LOCK_FILE).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
      await fsp.rm(LOCK_FILE, { force: true });
      return acquireLock();
    }
    return null;
  }
}

function runFile(cmd: string, args: string[], options: AnyRecord = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd: options.cwd || REPO_ROOT,
      env: { ...ENV, ...(options.env || {}) },
      timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const err = error as any;
      resolve({
        code: Number.isInteger(err?.code) ? err.code : 0,
        signal: err?.signal || null,
        stdout: stdout || "",
        stderr: stderr || "",
        error,
      });
    });
  });
}

async function runStrict(cmd: string, args: string[], options: AnyRecord = {}): Promise<CommandResult> {
  const result = await runFile(cmd, args, options);
  if (result.code !== 0 || result.signal) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`${path.basename(cmd)} ${args.join(" ")} failed (${result.signal || result.code}): ${detail}`);
  }
  return result;
}

async function writeReviewSchema() {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "summary", "findings", "confidence"],
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      summary: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "file", "line", "title", "body"],
          properties: {
            severity: { type: "string", enum: ["blocker", "high", "medium", "low"] },
            file: { type: "string" },
            line: { type: "integer", minimum: 0 },
            title: { type: "string" },
            body: { type: "string" },
          },
        },
      },
    },
  };
  await writeJsonAtomic(REVIEW_SCHEMA_FILE, schema);
}

async function loadQueue(): Promise<QueueEntry[]> {
  const raw = await readJson(QUEUE_FILE);
  return Array.isArray(raw) ? raw : raw.entries || raw.items || [];
}

function jobIdToQueueId(jobId: any): string | null {
  if (!jobId || typeof jobId !== "string") return null;
  return jobId.replace(/^job-/, "").replace(/-a\d+$/, "");
}

function rootQueueId(entry: QueueEntry, byId: Map<string, QueueEntry>): string {
  let current = entry;
  const seen = new Set();
  while (current?.metadata?.retryJobId) {
    const nextId = jobIdToQueueId(current.metadata.retryJobId);
    if (!nextId || seen.has(nextId)) break;
    seen.add(nextId);
    current = byId.get(nextId) || { id: nextId };
  }
  return current?.id || entry.id;
}

function taskKeyFor(entry: QueueEntry, byId: Map<string, QueueEntry>): string {
  const sourceContext = entry.metadata?.sourceContext || {};
  const explicit = [
    sourceContext.taskId,
    sourceContext.sddTask?.id,
    sourceContext.planGroupId,
    sourceContext.issueUrl,
    sourceContext.issueNumber && sourceContext.repo ? `${sourceContext.repo}#${sourceContext.issueNumber}` : null,
    entry.metadata?.taskId,
    entry.metadata?.issueUrl,
  ].find(Boolean);
  return explicit ? `task:${explicit}` : `root:${rootQueueId(entry, byId)}`;
}

function completedTs(entry: QueueEntry): string {
  return entry.completedAt || entry.updatedAt || entry.createdAt || "";
}

function compareEntryTime(a: QueueEntry, b: QueueEntry): number {
  return completedTs(a).localeCompare(completedTs(b));
}

function selectCandidates(
  entries: QueueEntry[],
  state: AnyRecord,
  options: CronOptions,
  byId = new Map<string, QueueEntry>(entries.map((entry) => [entry.id, entry])),
): Array<{ taskKey: string; entry: QueueEntry }> {
  const completed = entries
    .filter((entry) => entry.projectId === PROJECT_ID && entry.status === "completed")
    .sort(compareEntryTime);

  const latestByTask = new Map<string, QueueEntry>();
  for (const entry of completed) {
    if (!options.processExisting && state.processed[entry.id]) continue;
    const taskKey = taskKeyFor(entry, byId);
    const lastProcessed = state.taskLastProcessed[taskKey];
    if (!options.processExisting && lastProcessed && completedTs(entry) <= lastProcessed) continue;
    const previous = latestByTask.get(taskKey);
    if (!previous || compareEntryTime(previous, entry) <= 0) {
      latestByTask.set(taskKey, entry);
    }
  }
  return [...latestByTask.entries()].map(([taskKey, entry]) => ({ taskKey, entry }));
}

async function bootstrapExisting(entries: QueueEntry[], state: AnyRecord): Promise<number> {
  const byId = new Map<string, QueueEntry>(entries.map((entry) => [entry.id, entry]));
  let count = 0;
  for (const entry of entries) {
    if (entry.projectId !== PROJECT_ID || entry.status !== "completed") continue;
    const taskKey = taskKeyFor(entry, byId);
    state.processed[entry.id] ||= {
      status: "baseline",
      taskKey,
      completedAt: completedTs(entry),
      recordedAt: nowIso(),
      reason: "completed before cron install",
    };
    const ts = completedTs(entry);
    if (!state.taskLastProcessed[taskKey] || state.taskLastProcessed[taskKey] < ts) {
      state.taskLastProcessed[taskKey] = ts;
    }
    count += 1;
  }
  state.baselineAt = nowIso();
  await writeJsonAtomic(STATE_FILE, state);
  return count;
}

async function latestAttempt(entry: QueueEntry): Promise<AnyRecord | null> {
  const attemptsRoot = path.join(CPB_ROOT, "assignments", `a-${entry.id}`, "attempts");
  const names = await fsp.readdir(attemptsRoot).catch(() => []);
  const attempts = names
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(b) - Number(a));
  for (const name of attempts) {
    const attemptDir = path.join(attemptsRoot, name);
    const result = await readJson(path.join(attemptDir, "result.json"), null).catch(() => null);
    const worktree = await readJson(path.join(attemptDir, "worktree.json"), null).catch(() => null);
    if (result?.status === "completed" || result?.jobResult?.status === "completed") {
      return { attempt: Number(name), attemptDir, result, worktree };
    }
  }
  return null;
}

function jobIdFor(entry: QueueEntry, attempt: AnyRecord | null): string {
  return attempt?.result?.jobResult?.jobId || `job-${entry.id}`;
}

function retryTargetJobIdFor(entry: QueueEntry, attempt: AnyRecord | null, byId = new Map<string, QueueEntry>()): string {
  let targetJobId = stripAttemptSuffix(entry?.metadata?.retryJobId);
  if (!targetJobId) return jobIdFor(entry, attempt);

  const seen = new Set();
  while (targetJobId) {
    const targetQueueId = jobIdToQueueId(targetJobId);
    if (!targetQueueId || seen.has(targetQueueId)) break;
    seen.add(targetQueueId);

    const targetEntry = byId.get(targetQueueId);
    const nextTargetJobId = stripAttemptSuffix(targetEntry?.metadata?.retryJobId);
    if (!nextTargetJobId) break;
    targetJobId = nextTargetJobId;
  }

  return targetJobId;
}

async function gitOutput(args: string[], cwd: string, options: AnyRecord = {}): Promise<string> {
  const result = await runStrict(BIN.git, args, { cwd, ...options });
  return result.stdout.trim();
}

function stripAttemptSuffix(jobId: any): any {
  return typeof jobId === "string" ? jobId.replace(/-a\d+$/, "") : jobId;
}

function candidateWorktreePaths(entry: QueueEntry, attempt: AnyRecord | null): string[] {
  const candidates: string[] = [];
  const add = (value: any) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  add(attempt?.worktree?.worktreePath);

  const retryJobId = stripAttemptSuffix(entry?.metadata?.retryJobId);
  if (retryJobId) {
    add(path.join(CPB_ROOT, "worktrees", `${retryJobId}-pipeline`));
    add(path.join(CPB_ROOT, "worktrees", retryJobId));
  }

  const jobId = stripAttemptSuffix(jobIdFor(entry, attempt));
  if (jobId) {
    add(path.join(CPB_ROOT, "worktrees", `${jobId}-pipeline`));
    add(path.join(CPB_ROOT, "worktrees", jobId));
  }

  return candidates;
}

async function resolveWorktreePath(entry: QueueEntry, attempt: AnyRecord | null): Promise<string> {
  const candidates = candidateWorktreePaths(entry, attempt);
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const result = await runFile(BIN.git, ["rev-parse", "--is-inside-work-tree"], { cwd: candidate });
    if (result.code === 0) return candidate;
  }
  throw new Error(`missing worktree for ${entry.id}: checked ${candidates.join(", ") || "none"}`);
}

async function ensureMergeableWorktree(entry: QueueEntry, attempt: AnyRecord | null): Promise<AnyRecord> {
  const worktreePath = await resolveWorktreePath(entry, attempt);
  await runFile(BIN.git, ["fetch", "origin", "main", "--quiet"], { cwd: worktreePath, timeout: 5 * 60 * 1000 });

  const actualBranch = await gitOutput(["branch", "--show-current"], worktreePath);
  const branch = actualBranch
    || attempt?.worktree?.worktreeBranch
    || `cpb/${jobIdFor(entry, attempt)}-reviewed`;

  const status = await gitOutput(["status", "--short"], worktreePath);
  if (status) {
    await runStrict(BIN.git, [
      "add", "--all", "--",
      ".",
      ":(exclude)node_modules",
      ":(exclude)node_modules/**",
      ":(exclude).cpb",
      ":(exclude).cpb/**",
      ":(exclude)cpb-task/state",
      ":(exclude)cpb-task/state/**",
      ":(exclude)cpb-task/worktrees",
      ":(exclude)cpb-task/worktrees/**",
      ":(exclude)*.tgz",
      ":(exclude)coverage",
      ":(exclude)coverage/**",
    ], { cwd: worktreePath });

    const staged = await runFile(BIN.git, ["diff", "--cached", "--quiet"], { cwd: worktreePath });
    if (staged.code !== 0) {
      const jobId = jobIdFor(entry, attempt);
      await runStrict(BIN.git, ["commit", "-m", commitMessage(entry, jobId)], { cwd: worktreePath });
    }
  }

  const diff = await runFile(BIN.git, ["diff", "--quiet", "origin/main...HEAD"], { cwd: worktreePath });
  if (diff.code === 0) {
    throw new Error(`no mergeable committed changes for ${entry.id}`);
  }
  return { worktreePath, branch };
}

function commitMessage(entry: QueueEntry, jobId: string): string {
  return [
    `Preserve reviewed CPB job ${jobId}`,
    "",
    `Cron review accepted queue entry ${entry.id} for project ${PROJECT_ID}.`,
    "This commit captures completed isolated worktree changes before PR handoff.",
    "",
    "Constraint: Generated by scripts/cpb-flow-cron.js after CPB completion",
    "Confidence: medium",
    "Scope-risk: moderate",
    "Directive: Verify CPB artifacts before amending this branch",
    "Tested: CPB phase verifier passed before cron review",
    "Not-tested: Full repository suite inside cron",
  ].join("\n");
}

async function runAdversarialReview(entry: QueueEntry, attempt: AnyRecord | null, mergeable: AnyRecord): Promise<AnyRecord> {
  await writeReviewSchema();
  const jobId = jobIdFor(entry, attempt);
  const outDir = path.join(REVIEW_DIR, entry.id);
  await fsp.mkdir(outDir, { recursive: true });
  const outputFile = path.join(outDir, "review.json");
  const promptFile = path.join(outDir, "prompt.md");
  const verdictPath = attempt?.result?.jobResult?.phaseResults
    ?.find((phase) => phase.phase === "verify")
    ?.artifact?.path || null;
  const deliverablePath = attempt?.result?.jobResult?.phaseResults
    ?.find((phase) => phase.phase === "execute")
    ?.artifact?.path || null;
  const prompt = [
    "You are an adversarial review subagent for a completed CPB task.",
    "Review only. Do not modify files.",
    "",
    `Project: ${PROJECT_ID}`,
    `Queue entry: ${entry.id}`,
    `Job id: ${jobId}`,
    `Worktree: ${mergeable.worktreePath}`,
    `Branch: ${mergeable.branch}`,
    `Deliverable artifact: ${deliverablePath || "unknown"}`,
    `Verifier artifact: ${verdictPath || "unknown"}`,
    "",
    "Inspect `git diff origin/main...HEAD` and the CPB artifacts if present.",
    "Return JSON matching the schema. Use verdict=fail for any correctness, test, merge, safety, or missing-evidence blocker.",
    "Use verdict=pass only when the change is fit to open and merge after merge-preview.",
  ].join("\n");
  await fsp.writeFile(promptFile, `${prompt}\n`);

  const result = await runFile(BIN.codex, [
    "exec",
    "--cd", mergeable.worktreePath,
    "--add-dir", CPB_ROOT,
    "--sandbox", "read-only",
    "--ask-for-approval", "never",
    "--output-schema", REVIEW_SCHEMA_FILE,
    "-o", outputFile,
    prompt,
  ], { cwd: mergeable.worktreePath, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 });

  if (result.code !== 0 || result.signal) {
    await fsp.writeFile(path.join(outDir, "codex.stderr.txt"), result.stderr || "");
    await fsp.writeFile(path.join(outDir, "codex.stdout.txt"), result.stdout || "");
    throw new Error(`codex review failed for ${entry.id}: ${result.stderr.trim() || result.stdout.trim() || result.signal || result.code}`);
  }

  const raw = await fsp.readFile(outputFile, "utf8");
  const review = JSON.parse(raw);
  const blocking = review.findings?.filter((finding) => ["blocker", "high", "medium"].includes(finding.severity)) || [];
  if (review.verdict !== "pass" || blocking.length > 0) {
    const titles = blocking.map((finding) => `${finding.severity}: ${finding.title}`).join("; ");
    throw new Error(`review rejected ${entry.id}: ${review.summary}${titles ? ` (${titles})` : ""}`);
  }
  return { review, outputFile };
}

async function runMergePreview(entry: QueueEntry, mergeable: AnyRecord): Promise<AnyRecord> {
  const result = await runFile(BIN.cpb, [
    "merge-preview",
    PROJECT_ID,
    mergeable.worktreePath,
    "--base",
    "origin/main",
    "--json",
  ], { cwd: REPO_ROOT, timeout: 10 * 60 * 1000 });
  const outDir = path.join(REVIEW_DIR, entry.id);
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "merge-preview.stdout.json"), result.stdout || "");
  await fsp.writeFile(path.join(outDir, "merge-preview.stderr.txt"), result.stderr || "");
  if (result.code !== 0 || result.signal) {
    throw new Error(`merge-preview rejected ${entry.id}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const preview = JSON.parse(result.stdout);
  if (!preview.safeForSteward) {
    throw new Error(`merge-preview safeForSteward=false for ${entry.id}`);
  }
  return preview;
}

function prBody(entry: QueueEntry, attempt: AnyRecord | null, review: AnyRecord, preview: AnyRecord): string {
  const jobId = jobIdFor(entry, attempt);
  const resultPath = attempt?.attemptDir ? path.join(attempt.attemptDir, "result.json") : null;
  return [
    `Automated CPB cron handoff for ${PROJECT_ID}.`,
    "",
    `Queue entry: ${entry.id}`,
    `Job id: ${jobId}`,
    `Task key: ${entry.__taskKey || "unknown"}`,
    resultPath ? `Attempt result: ${resultPath}` : null,
    "",
    "Review:",
    review.summary,
    "",
    "Merge preview:",
    `safeForSteward=${preview.safeForSteward}`,
    `mergeStatus=${preview.mergeStatus}`,
    `changedFiles=${preview.changedFiles?.length ?? 0}`,
    "",
    "Tested:",
    "- CPB verifier completed before cron review",
    "- Codex adversarial review returned pass",
    "- cpb merge-preview returned safeForSteward=true",
  ].filter(Boolean).join("\n");
}

async function openAndMergePr(entry: QueueEntry, attempt: AnyRecord | null, mergeable: AnyRecord, review: AnyRecord, preview: AnyRecord): Promise<AnyRecord> {
  const repo = (await runStrict(BIN.gh, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: REPO_ROOT })).stdout.trim();
  await runStrict(BIN.git, ["push", "origin", `HEAD:refs/heads/${mergeable.branch}`], { cwd: mergeable.worktreePath, timeout: 15 * 60 * 1000 });

  const existingRaw = await runStrict(BIN.gh, [
    "pr", "list",
    "--repo", repo,
    "--head", mergeable.branch,
    "--state", "open",
    "--json", "number,url",
    "--limit", "1",
  ], { cwd: REPO_ROOT });
  const existing = JSON.parse(existingRaw.stdout || "[]");

  let prUrl = existing[0]?.url || null;
  if (!prUrl) {
    const title = `CPB ${PROJECT_ID}: ${jobIdFor(entry, attempt)}`;
    const bodyFile = path.join(REVIEW_DIR, entry.id, "pr-body.md");
    await fsp.writeFile(bodyFile, `${prBody(entry, attempt, review, preview)}\n`);
    const created = await runStrict(BIN.gh, [
      "pr", "create",
      "--repo", repo,
      "--base", "main",
      "--head", mergeable.branch,
      "--title", title,
      "--body-file", bodyFile,
    ], { cwd: mergeable.worktreePath, timeout: 10 * 60 * 1000 });
    prUrl = created.stdout.trim().split(/\s+/).find((part) => part.startsWith("http")) || created.stdout.trim();
  }

  let mergeMode = "merged";
  let merge = await runFile(BIN.gh, ["pr", "merge", prUrl, "--squash", "--delete-branch"], { cwd: REPO_ROOT, timeout: 15 * 60 * 1000 });
  if (merge.code !== 0 || merge.signal) {
    merge = await runFile(BIN.gh, ["pr", "merge", prUrl, "--squash", "--auto", "--delete-branch"], { cwd: REPO_ROOT, timeout: 10 * 60 * 1000 });
    mergeMode = "auto_merge_enabled";
  }
  if (merge.code !== 0 || merge.signal) {
    throw new Error(`PR merge failed for ${entry.id}: ${merge.stderr.trim() || merge.stdout.trim() || merge.signal || merge.code}`);
  }
  return { prUrl, mergeMode, mergeOutput: merge.stdout.trim() || merge.stderr.trim() };
}

function failureClass(reason: string): string {
  if (/missing worktree/i.test(reason)) return "missing_worktree";
  if (/no completed assignment attempt/i.test(reason)) return "missing_assignment_attempt";
  if (/no mergeable committed changes/i.test(reason)) return "no_mergeable_changes";
  if (/merge-preview/i.test(reason)) return "merge_preview_rejected";
  if (/review rejected/i.test(reason)) return "adversarial_review_failed";
  if (/codex review failed/i.test(reason)) return "adversarial_review_unavailable";
  return "unknown";
}

function isRetryableRejection(reason: string): boolean {
  const cls = failureClass(reason);
  return !["missing_worktree", "missing_assignment_attempt", "no_mergeable_changes"].includes(cls);
}

function retryCountForTask(state: AnyRecord, taskKey: string, cls: string): number {
  return Object.values(state.processed || {}).filter((record) => {
    const item = record as AnyRecord;
    return (
      item?.taskKey === taskKey
      && item?.failureClass === cls
      && item?.retryQueued
    );
  }).length;
}

async function rejectAndRetry(
  entry: QueueEntry,
  attempt: AnyRecord | null,
  taskKey: string,
  reason: string,
  state: AnyRecord,
  options: CronOptions,
  byId: Map<string, QueueEntry>,
): Promise<AnyRecord> {
  const jobId = jobIdFor(entry, attempt);
  const retryTargetJobId = retryTargetJobIdFor(entry, attempt, byId);
  const cls = failureClass(reason);
  const retryable = isRetryableRejection(reason);
  const retryCount = retryCountForTask(state, taskKey, cls);
  const rejectRecord = {
    queueEntryId: entry.id,
    taskKey,
    jobId,
    projectId: PROJECT_ID,
    rejectedAt: nowIso(),
    reason,
    failureClass: cls,
    retryable,
    retryCount,
    retryBudget: MAX_RETRIES_PER_TASK,
  };
  await writeJsonAtomic(path.join(REJECT_DIR, `${entry.id}.json`), rejectRecord);
  if (!retryable) {
    return {
      retryQueued: false,
      retryQueueId: null,
      retryable: false,
      failureClass: cls,
      retrySuppressedReason: "non_retryable_review_evidence_failure",
    };
  }
  if (retryCount >= MAX_RETRIES_PER_TASK) {
    return {
      retryQueued: false,
      retryQueueId: null,
      retryable: true,
      failureClass: cls,
      retrySuppressedReason: `retry_budget_exhausted:${retryCount}/${MAX_RETRIES_PER_TASK}`,
    };
  }
  if (options.dryRun) {
    return { retryQueued: false, retryQueueId: null, retryable, failureClass: cls, dryRun: true };
  }
  const retry = await runStrict(BIN.cpb, ["retry", PROJECT_ID, retryTargetJobId], { cwd: REPO_ROOT, timeout: 5 * 60 * 1000 });
  const retryQueueId = retry.stdout.match(/Enqueued retry\s+(\S+)/)?.[1] || null;
  return { retryQueued: true, retryQueueId, retryable, failureClass: cls, output: retry.stdout.trim() };
}

async function processEntry(entry: QueueEntry, taskKey: string, state: AnyRecord, options: CronOptions, byId: Map<string, QueueEntry>): Promise<void> {
  entry.__taskKey = taskKey;
  await appendRunLog(`processing ${entry.id} taskKey=${taskKey}`);
  const attempt = await latestAttempt(entry);
  try {
    if (!attempt) throw new Error(`no completed assignment attempt found for ${entry.id}`);
    const mergeable = await ensureMergeableWorktree(entry, attempt);
    const { review, outputFile } = await runAdversarialReview(entry, attempt, mergeable);
    const preview = await runMergePreview(entry, mergeable);
    if (options.dryRun) {
      state.processed[entry.id] = {
        status: "dry_run_pass",
        taskKey,
        jobId: jobIdFor(entry, attempt),
        completedAt: completedTs(entry),
        reviewedAt: nowIso(),
        reviewPath: outputFile,
      };
    } else {
      const merged = await openAndMergePr(entry, attempt, mergeable, review, preview);
      state.processed[entry.id] = {
        status: merged.mergeMode,
        taskKey,
        jobId: jobIdFor(entry, attempt),
        completedAt: completedTs(entry),
        reviewedAt: nowIso(),
        prUrl: merged.prUrl,
        mergeOutput: merged.mergeOutput,
        reviewPath: outputFile,
      };
    }
    state.taskLastProcessed[taskKey] = completedTs(entry);
    await writeJsonAtomic(STATE_FILE, state);
    await appendRunLog(`accepted ${entry.id} status=${state.processed[entry.id].status}`);
  } catch (err) {
    const error = err as Error;
    const retry: AnyRecord = await rejectAndRetry(entry, attempt, taskKey, error.message, state, options, byId).catch((retryErr) => ({
      retryQueued: false,
      retryQueueId: null,
      retryError: retryErr.message,
      retryable: true,
      failureClass: failureClass(error.message),
    }));
    state.processed[entry.id] = {
      status: retry.retryQueued ? "rejected_retry_enqueued" : "rejected_no_retry",
      taskKey,
      jobId: jobIdFor(entry, attempt),
      completedAt: completedTs(entry),
      rejectedAt: nowIso(),
      reason: error.message,
      failureClass: retry.failureClass,
      retryable: retry.retryable,
      retryQueued: retry.retryQueued,
      retryQueueId: retry.retryQueueId,
      retryError: retry.retryError || null,
      retrySuppressedReason: retry.retrySuppressedReason || null,
      dryRun: Boolean(options.dryRun),
    };
    state.taskLastProcessed[taskKey] = completedTs(entry);
    await writeJsonAtomic(STATE_FILE, state);
    await appendRunLog(`rejected ${entry.id} status=${state.processed[entry.id].status} retryQueueId=${retry.retryQueueId || "none"} reason=${error.message}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  await ensureRuntimeDirs();
  const state = await loadState();
  const entries = await loadQueue();
  const byId = new Map<string, QueueEntry>(entries.map((entry) => [entry.id, entry]));

  if (options.bootstrapExisting) {
    const count = await bootstrapExisting(entries, state);
    await appendRunLog(`bootstrap_existing completed count=${count}`);
    return;
  }

  const releaseLock = await acquireLock();
  if (!releaseLock) {
    await appendRunLog("skip: another run is active");
    return;
  }

  const runStartedAt = nowIso();
  try {
    const candidates = selectCandidates(entries, state, options, byId);
    await appendRunLog(`run started candidates=${candidates.length} processExisting=${options.processExisting} dryRun=${options.dryRun}`);
    for (const { taskKey, entry } of candidates) {
      await processEntry(entry, taskKey, state, options, byId);
    }
    state.runs.push({ startedAt: runStartedAt, finishedAt: nowIso(), candidates: candidates.length, dryRun: options.dryRun });
    state.runs = state.runs.slice(-50);
    await writeJsonAtomic(STATE_FILE, state);
    await appendRunLog("run finished");
  } finally {
    await releaseLock();
  }
}

main().catch(async (err) => {
  const error = err as Error;
  await ensureRuntimeDirs().catch(() => {});
  await appendRunLog(`fatal: ${error.stack || error.message}`).catch(() => {});
  process.exitCode = 1;
});
