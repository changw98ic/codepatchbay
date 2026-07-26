import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  MERGE_CLASSIFICATION,
  appendHistory,
  checkPolicy,
  classifyCategory,
  claimIssue,
  completeIssue,
  loadBacklog,
  loadProjectState,
  popIssue,
  pushIssues,
  runResearch,
  saveProjectState,
  summarizeMergeFiles,
} from "../server/services/evolve/evolve.js";
import { withDurableDirectoryLock } from "../core/runtime/durable-directory-lock.js";
import { tempRoot } from "./helpers.js";

type SavedState = {
  round?: number;
  status?: string;
  updatedAt?: string;
};

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function setupResearchFixture(root: string, acpClientSource: string) {
  const cpbRoot = path.join(root, "cpb");
  const executorRoot = path.join(root, "executor");
  const sourcePath = path.join(root, "project-source");
  const wikiDir = path.join(cpbRoot, "wiki", "projects", "flow");
  const inboxDir = path.join(wikiDir, "inbox");
  const acpDir = path.join(executorRoot, "server", "services", "acp");
  await mkdir(inboxDir, { recursive: true });
  await mkdir(acpDir, { recursive: true });
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(wikiDir, "project.json"), JSON.stringify({ sourcePath }, null, 2), "utf8");
  await writeFile(path.join(acpDir, "acp-client.js"), acpClientSource, "utf8");
  await writeFile(path.join(executorRoot, "server", "services", "merge-research.js"), `
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const codex = await readFile(valueAfter("--codex"), "utf8");
const claude = await readFile(valueAfter("--claude"), "utf8");
await writeFile(valueAfter("--output"), [
  "# Research",
  "",
  "Codex:",
  codex.trim(),
  "",
  "Claude:",
  claude.trim(),
  "",
].join("\\n"), "utf8");
`, "utf8");
  return { cpbRoot, executorRoot, wikiDir, inboxDir };
}

async function waitForPidReports(pidFile: string, expected: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await pathExists(pidFile)) {
      const lines = (await readFile(pidFile, "utf8")).trim().split("\n").filter(Boolean);
      if (lines.length >= expected) return lines.map((line) => JSON.parse(line) as { parent: number; grandchild: number });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${expected} pid reports`);
}

function pidIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForDead(pids: number[]) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !pidIsAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const alive = pids.filter(pidIsAlive);
  throw new Error(`expected pids to be dead: ${alive.join(", ")}`);
}

async function waitForFileContaining(filePath: string, pattern: RegExp) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await pathExists(filePath)) {
      const content = await readFile(filePath, "utf8");
      if (pattern.test(content)) return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${filePath} to match ${pattern}`);
}

test("evolve policy classifies safe and high-risk issues without requiring a git repo", () => {
  const allowed = checkPolicy(
    { project: "flow", description: "Fix a README typo" },
    { allowlist: ["flow"], requireCleanWorktree: false },
  );
  assert.deepEqual(allowed, { allowed: true, reasons: [] });
  assert.equal(classifyCategory({ title: "Fix flaky test", labels: ["CI"] }), "test-fix");

  const blocked = checkPolicy(
    { project: "ops", description: "Rotate api token in auth flow" },
    { allowlist: ["flow"], requireCleanWorktree: false },
  );
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes("not in allowlist")));
  assert.ok(blocked.reasons.some((reason) => reason.includes("secrets or credentials")));
});

test("merge file summary separates shared-state and human-reviewed files", () => {
  const summary = summarizeMergeFiles([
    "src/app.ts",
    "wiki/projects/flow/state.json",
    "AGENTS.md",
    "schemas/public.schema.json",
  ]);

  assert.deepEqual(summary.counts, {
    [MERGE_CLASSIFICATION.SHARED_STATE]: 1,
    [MERGE_CLASSIFICATION.NEEDS_HUMAN]: 2,
    [MERGE_CLASSIFICATION.RESOLVABLE_CODE]: 1,
  });
  assert.deepEqual(summary.entries.map((entry) => entry.file), [
    "AGENTS.md",
    "schemas/public.schema.json",
    "src/app.ts",
    "wiki/projects/flow/state.json",
  ]);
});

test("evolve backlog preserves priority, claims, completion detail, and history", async () => {
  const root = await tempRoot("cpb-evolve-service");
  const projectRoot = path.join(root, "project");
  const options = { dataRoot: path.join(root, "data") };

  const state: SavedState = await saveProjectState(projectRoot, "flow", { round: 2, status: "running" }, options);
  assert.equal(state.round, 2);
  assert.equal(state.status, "running");
  assert.ok(state.updatedAt);
  assert.deepEqual(await loadProjectState(projectRoot, "flow", options), state);

  const pushed = await pushIssues(projectRoot, "flow", [
    { id: "slow", description: "Low priority", priority: "P2" },
    { id: "urgent", description: "High priority", priority: "P0" },
    { id: "urgent", description: "Duplicate", priority: "P0" },
  ], options);
  assert.equal(pushed.added, 2);
  assert.equal(pushed.total, 2);

  const popped = await popIssue(projectRoot, "flow", options);
  assert.equal(popped?.issue.id, "urgent");
  assert.equal(popped?.issue.status, "in_progress");

  const claimed = await claimIssue(projectRoot, "flow", "slow", options);
  assert.equal(claimed?.issue.id, "slow");
  assert.equal(claimed?.issue.status, "in_progress");
  assert.ok(claimed?.issue.claimedAt);

  const completed = await completeIssue(projectRoot, "flow", "slow", { ok: true, code: 0 }, options);
  assert.equal(completed?.issue.status, "completed");
  assert.equal(completed?.issue.detail.exitCode, 0);
  assert.equal(completed?.issue.detail.error, null);
  assert.ok(completed?.issue.detail.completedAt);

  const backlog = await loadBacklog(projectRoot, "flow", options);
  assert.deepEqual(backlog.map((issue) => [issue.id, issue.status]), [
    ["slow", "completed"],
    ["urgent", "in_progress"],
  ]);

  await appendHistory(projectRoot, "flow", { type: "completed", issueId: "slow" }, options);
  const historyPath = path.join(options.dataRoot, "evolve", "flow", "history.jsonl");
  const history = (await readFile(historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(history.length, 1);
  assert.equal(history[0].project, "flow");
  assert.equal(history[0].type, "completed");
  assert.ok(history[0].timestamp);
});

test("evolve state fails closed on corrupt JSON", async () => {
  const root = await tempRoot("cpb-evolve-state-corrupt");
  const projectRoot = path.join(root, "project");
  const options = { dataRoot: path.join(root, "data") };
  const stateFile = path.join(options.dataRoot, "evolve", "flow", "state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, "{not-json\n", "utf8");

  await assert.rejects(
    loadProjectState(projectRoot, "flow", options),
    { code: "EVOLVE_STATE_INVALID" },
  );
});

test("evolve state rejects a symlink without reading its target", async () => {
  const root = await tempRoot("cpb-evolve-state-symlink");
  const projectRoot = path.join(root, "project");
  const options = { dataRoot: path.join(root, "data") };
  const stateFile = path.join(options.dataRoot, "evolve", "flow", "state.json");
  const target = path.join(root, "outside-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(target, `${JSON.stringify({ round: 99, status: "outside" })}\n`, "utf8");
  await symlink(target, stateFile);

  await assert.rejects(loadProjectState(projectRoot, "flow", options), { code: "EVOLVE_STATE_UNSAFE" });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { round: 99, status: "outside" });
});

test("evolve state rejects an oversized sparse file before parsing", async () => {
  const root = await tempRoot("cpb-evolve-state-oversized");
  const projectRoot = path.join(root, "project");
  const options = { dataRoot: path.join(root, "data") };
  const stateFile = path.join(options.dataRoot, "evolve", "flow", "state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, "{}\n", "utf8");
  await truncate(stateFile, 16 * 1024 * 1024 + 1);

  await assert.rejects(loadProjectState(projectRoot, "flow", options), { code: "EVOLVE_STATE_TOO_LARGE" });
});

test("evolve history appends are serialized without lost records", async () => {
  const root = await tempRoot("cpb-evolve-history-concurrent");
  const projectRoot = path.join(root, "project");
  const options = { dataRoot: path.join(root, "data") };
  await Promise.all(Array.from({ length: 12 }, (_, index) => (
    appendHistory(projectRoot, "flow", { type: "concurrent", index }, options)
  )));

  const historyPath = path.join(options.dataRoot, "evolve", "flow", "history.jsonl");
  const entries = (await readFile(historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 12);
  assert.deepEqual(entries.map((entry) => entry.index).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index));
});

test("runResearch writes merged research artifact and log on success", async () => {
  const root = await tempRoot("cpb-evolve-research-success");
  const { cpbRoot, executorRoot, wikiDir, inboxDir } = await setupResearchFixture(root, `
const agent = process.argv[process.argv.indexOf("--agent") + 1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(agent + " researched " + input.includes("structured analysis") + "\\n");
});
`);

  await runResearch({ project: "flow", task: "map cancellation behavior", executorRoot, cpbRoot });

  const artifacts = (await readdir(inboxDir)).filter((file) => file.startsWith("research-") && file.endsWith(".md"));
  assert.deepEqual(artifacts, ["research-001.md"]);
  const artifact = await readFile(path.join(inboxDir, "research-001.md"), "utf8");
  assert.match(artifact, /Codex:/);
  assert.match(artifact, /codex researched true/);
  assert.match(artifact, /Claude:/);
  assert.match(artifact, /claude researched true/);

  const log = await readFile(path.join(wikiDir, "log.md"), "utf8");
  assert.match(log, /research \| dual \| research-001 for: map cancellation behavior \| FULL/);
});

test("runResearch abort tears down ACP child trees before artifact or log", async () => {
  const root = await tempRoot("cpb-evolve-research-abort");
  const pidFile = path.join(root, "pids.jsonl");
  const { cpbRoot, executorRoot, wikiDir, inboxDir } = await setupResearchFixture(root, `
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const agent = process.argv[process.argv.indexOf("--agent") + 1];
const pidFile = ${JSON.stringify(pidFile)};
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  detached: true,
  stdio: "ignore",
});
appendFileSync(pidFile, JSON.stringify({ agent, parent: process.pid, grandchild: grandchild.pid }) + "\\n");
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  const ac = new AbortController();

  const pending = runResearch({ project: "flow", task: "abort hanging providers", executorRoot, cpbRoot, signal: ac.signal });
  const reports = await waitForPidReports(pidFile, 2);
  ac.abort();
  await assert.rejects(pending, { name: "AbortError" });

  const pids = reports.flatMap((report) => [report.parent, report.grandchild]);
  await waitForDead(pids);

  const artifacts = (await readdir(inboxDir)).filter((file) => file.startsWith("research-") && file.endsWith(".md"));
  assert.deepEqual(artifacts, []);
  assert.equal(await pathExists(path.join(wikiDir, "log.md")), false);
});

test("runResearch abort after publication preserves the research artifact and existing log", async () => {
  const root = await tempRoot("cpb-evolve-research-post-merge-abort");
  const { cpbRoot, executorRoot, wikiDir, inboxDir } = await setupResearchFixture(root, `
const agent = process.argv[process.argv.indexOf("--agent") + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(agent + " finished\\n");
});
`);
  const logFile = path.join(wikiDir, "log.md");
  const existingLog = "- **2026-01-01T00:00:00.000Z** | existing entry\\n";
  await writeFile(logFile, existingLog, "utf8");
  const logLock = path.join(wikiDir, ".cpb-log.lock");
  let lockEnteredResolve!: () => void;
  const lockEntered = new Promise<void>((resolve) => { lockEnteredResolve = resolve; });
  let releaseLockResolve!: () => void;
  const releaseLock = new Promise<void>((resolve) => { releaseLockResolve = resolve; });
  const lockHolder = withDurableDirectoryLock(logLock, async () => {
    lockEnteredResolve();
    await releaseLock;
  });
  await lockEntered;
  const ac = new AbortController();

  const pending = runResearch({ project: "flow", task: "abort after merge", executorRoot, cpbRoot, signal: ac.signal });
  const artifactPath = path.join(inboxDir, "research-001.md");
  await waitForFileContaining(artifactPath, /Codex:/);
  ac.abort();
  releaseLockResolve();

  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as Error).name, "AbortError");
    assert.equal((error as { committed?: unknown }).committed, true);
    assert.deepEqual((error as { recoveryPaths?: unknown }).recoveryPaths, {
      publishedResearch: artifactPath,
    });
    return true;
  });
  await lockHolder;
  assert.deepEqual((await readdir(inboxDir)).filter((file) => file.startsWith("research-")), ["research-001.md"]);
  assert.match(await readFile(artifactPath, "utf8"), /Codex:/);
  assert.equal(await readFile(logFile, "utf8"), existingLog);
});

test("evolve atomic publication preserves its exact temporary generation when rename fails", async () => {
  const root = await tempRoot("cpb-evolve-atomic-recovery");
  const projectRoot = path.join(root, "project");
  const options = { dataRoot: path.join(root, "data") };
  const parent = path.join(options.dataRoot, "evolve", "flow");
  const destination = path.join(parent, "state.json");
  await mkdir(destination, { recursive: true });

  let caught: unknown = null;
  try {
    await saveProjectState(projectRoot, "flow", { round: 3, status: "running" }, options);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal((caught as { committed?: unknown }).committed, false);
  assert.equal((caught as { temporaryPreserved?: unknown }).temporaryPreserved, true);
  const temporary = String((caught as { recoveryPaths?: { temporary?: unknown } }).recoveryPaths?.temporary || "");
  assert.ok(temporary.startsWith(`${parent}${path.sep}.state.json.`));
  assert.match(await readFile(temporary, "utf8"), /"round": 3/);
  assert.equal((await readdir(destination)).length, 0);
});
