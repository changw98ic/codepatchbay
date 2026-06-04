import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  createIsolatedWorktreeWithRetry,
  finalizeAndWriteSuccessfulResult,
} from "../runtime/worker/managed-worker.js";
import { readJson, tempRoot, writeJson } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workerScript = path.join(repoRoot, "runtime", "worker", "managed-worker.js");
const testAgentScript = path.join(repoRoot, "bridges", "test-acp-agent.mjs");

function jsonEnvelope(data) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

async function waitFor(assertion, { timeoutMs = 8_000, intervalMs = 50 } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await assertion();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error("condition timed out");
}

function spawnWorker({ workerId, hubRoot, cpbRoot, env = {}, timeoutMs = 20_000, once = true }) {
  const args = [
    workerScript,
    "--worker-id", workerId,
    "--hub-root", hubRoot,
    "--cpb-root", cpbRoot,
  ];
  if (once) args.push("--once");
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_ACP_USE_MANAGED_POOL: "0",
      CPB_ACP_PERSISTENT_PROCESS: "0",
      CPB_ACP_TIMEOUT_MS: "30000",
      CPB_ACP_PHASE_TIMEOUT_MS: "30000",
      CPB_ACP_POOL_TIMEOUT_MS: "30000",
      CPB_PHASE_RETRY_MAX: "0",
      CPB_PHASE_CORRECTION_MAX: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`managed worker timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });

  return { child, done, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function listJsonFiles(dir) {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function writeWorkerScenario(root) {
  const scenarioPath = path.join(root, "scenario.json");
  await writeJson(scenarioPath, {
    responses: [
      {
        name: "plan",
        matchRegex: "software planning agent",
        output: jsonEnvelope({
          status: "ok",
          planMarkdown: [
            "## Analysis",
            "- Exercise managed worker with fake ACP.",
            "",
            "## Files to modify",
            "- README.md",
            "",
            "## Implementation Steps",
            "1. Keep the fixture source stable.",
            "",
            "## Testing",
            "- Worker lifecycle test",
            "",
            "## Risks",
            "- Fixture only.",
          ].join("\n"),
        }),
      },
      {
        name: "execute",
        matchRegex: "software execution agent",
        output: jsonEnvelope({
          status: "ok",
          summary: "Fake ACP completed the managed worker fixture and referenced README.md.",
          tests: ["tests/managed-worker.test.mjs"],
          risks: ["No source edits are expected."],
        }),
      },
      {
        name: "verify",
        matchRegex: "software verification agent",
        output: jsonEnvelope({
          status: "ok",
          verdict: "pass",
          reason: "Managed worker fake ACP fixture passed.",
          details: "Plan, execute, and verify completed through the registered fake-acp provider.",
          confidence: 1,
        }),
      },
    ],
  });
  return scenarioPath;
}

async function writeValidAssignment({
  hubRoot,
  workerId,
  sourcePath,
  metadata = {},
  assignmentId = "a-managed-success",
  entryId = "managed-success",
  task = "managed worker fake ACP success",
  workflow = "standard",
  planMode = "full",
  attemptToken = "attempt-token-1",
} = {}) {
  const attemptDir = path.join(hubRoot, "assignments", assignmentId, "attempts", "001");
  await mkdir(path.join(attemptDir, "control"), { recursive: true });
  await writeJson(path.join(attemptDir, "attempt.json"), {
    assignmentId,
    attempt: 1,
    entryId,
    projectId: "proj",
    workerId,
    status: "assigned",
    attemptToken,
    createdAt: new Date().toISOString(),
  });
  await writeJson(path.join(hubRoot, "workers", "inbox", workerId, `${assignmentId}.json`), {
    assignmentId,
    entryId,
    projectId: "proj",
    task,
    sourcePath,
    workflow,
    planMode,
    sourceContext: { issueNumber: 9 },
    metadata: {
      agents: {
        planner: "fake-acp",
        executor: "fake-acp",
        verifier: "fake-acp",
      },
      ...metadata,
    },
    attempt: 1,
    attemptToken,
    orchestratorEpoch: 7,
  });
  return { assignmentId, attemptDir };
}

test("createIsolatedWorktreeWithRetry refuses source checkout and cleans failed worktree state", async () => {
  const hubRoot = await tempRoot("cpb-managed-worktree");
  const sourcePath = await tempRoot("cpb-managed-source");
  const gitCalls = [];
  const removedPaths = [];

  await assert.rejects(
    createIsolatedWorktreeWithRetry({
      hubRoot,
      sourcePath,
      entryId: "entry1",
      maxAttempts: 1,
      retryDelayMs: 0,
      create: async () => ({ path: sourcePath, branch: "cpb/job-entry1-pipeline" }),
      runGit: async (command, args, opts) => {
        gitCalls.push({ command, args, cwd: opts.cwd });
        return { stdout: "", stderr: "" };
      },
      removePath: async (target, opts) => {
        removedPaths.push({ target, opts });
      },
    }),
    (err) => {
      assert.equal(err.code, "WORKTREE_UNAVAILABLE");
      assert.match(err.message, /refusing to run against source checkout/);
      return true;
    },
  );

  assert.equal(gitCalls[0].command, "git");
  assert.deepEqual(gitCalls[0].args.slice(0, 3), ["worktree", "remove", "--force"]);
  assert.equal(gitCalls[0].cwd, sourcePath);
  assert.equal(removedPaths.length, 1);
  assert.match(removedPaths[0].target, /job-entry1-pipeline$/);
});

test("finalizeAndWriteSuccessfulResult persists attempt token and job result", async () => {
  const attemptDir = await tempRoot("cpb-managed-result");
  let written = null;

  const finalizeResult = await finalizeAndWriteSuccessfulResult({
    cpbRoot: await tempRoot("cpb-managed-cpb"),
    hubRoot: await tempRoot("cpb-managed-hub"),
    assignment: {
      assignmentId: "a-result",
      entryId: "result",
      projectId: "proj",
      attemptToken: "tok-result",
      metadata: {},
    },
    attemptDir,
    assignmentId: "a-result",
    attemptNum: 2,
    jobId: "job-result",
    result: { status: "completed", jobId: "job-result", phaseResults: [] },
    worktreeInfo: { path: "/tmp/not-used", branch: "cpb/not-used" },
    writeResult: async (file, value) => { written = { file, value }; return true; },
  });

  assert.equal(finalizeResult, null);
  assert.equal(written.file, path.join(attemptDir, "result.json"));
  assert.equal(written.value.assignmentId, "a-result");
  assert.equal(written.value.attempt, 2);
  assert.equal(written.value.attemptToken, "tok-result");
  assert.equal(written.value.status, "completed");
  assert.equal(written.value.jobResult.jobId, "job-result");
});

test("managed worker atomically claims and removes malformed inbox payloads", async () => {
  const hubRoot = await tempRoot("cpb-managed-bad-inbox");
  const cpbRoot = await tempRoot("cpb-managed-bad-cpb");
  const workerId = "w-bad";
  const inboxDir = path.join(hubRoot, "workers", "inbox", workerId);
  await mkdir(inboxDir, { recursive: true });
  await writeFile(path.join(inboxDir, "bad-json.json"), "{bad", "utf8");
  await writeJson(path.join(inboxDir, "bad-attempt.json"), {
    assignmentId: "a-bad-attempt",
    attempt: 0,
    attemptToken: "tok",
  });
  await writeJson(path.join(inboxDir, "missing-token.json"), {
    assignmentId: "a-missing-token",
    attempt: 1,
  });

  const worker = spawnWorker({ workerId, hubRoot, cpbRoot, timeoutMs: 10_000 });
  let stopped = null;
  try {
    await waitFor(async () => {
      const pending = await listJsonFiles(inboxDir);
      const processing = await listJsonFiles(path.join(inboxDir, "processing"));
      return pending.length === 0 && processing.length === 0;
    }, { timeoutMs: 20_000 });
  } finally {
    worker.child.kill("SIGTERM");
    stopped = await worker.done.catch((err) => ({ error: err }));
  }

  assert.ok(stopped.code === 0 || stopped.signal === "SIGTERM", `unexpected exit: ${JSON.stringify(stopped)}`);
  assert.match(worker.stderr, /malformed inbox file/);
  assert.match(worker.stderr, /invalid attempt/);
  assert.match(worker.stderr, /missing attemptToken/);
  const registry = await readJson(path.join(hubRoot, "workers", "registry", `worker-${workerId}.json`));
  assert.match(registry.status, /^(ready|exited)$/);
});

test("managed worker writes accepted, heartbeat, result, and cleans worktree and registry after fake ACP run", async () => {
  const root = await tempRoot("cpb-managed-success");
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  const workerId = "w-success";
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# Managed Worker Fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "managed-worker-fixture", private: true }, null, 2)}\n`, "utf8");
  const scenarioPath = await writeWorkerScenario(root);
  const transcriptPath = path.join(root, "transcript.jsonl");
  const { assignmentId, attemptDir } = await writeValidAssignment({ hubRoot, workerId, sourcePath });

  const worker = spawnWorker({
    workerId,
    hubRoot,
    cpbRoot,
    env: {
      CPB_ROOT: cpbRoot,
      CPB_HUB_ROOT: hubRoot,
      CPB_EXECUTOR_ROOT: repoRoot,
      CPB_PROJECT_ROOTS: root,
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgentScript,
        "--scenario-file", scenarioPath,
        "--transcript-file", transcriptPath,
      ]),
    },
    timeoutMs: 60_000,
  });

  const finished = await worker.done;
  assert.equal(finished.code, 0, finished.stderr);

  const accepted = await readJson(path.join(attemptDir, "accepted.json"));
  assert.equal(accepted.workerId, workerId);
  assert.equal(accepted.assignmentId, assignmentId);
  assert.equal(accepted.attemptToken, "attempt-token-1");
  assert.equal(accepted.executionBoundary, "worktree");
  assert.equal(accepted.sourcePath, sourcePath);

  const heartbeat = await readJson(path.join(attemptDir, "heartbeat.json"));
  assert.equal(heartbeat.workerId, workerId);
  assert.equal(heartbeat.status, "running");
  assert.equal(heartbeat.executionBoundary, "worktree");

  const worktree = await readJson(path.join(attemptDir, "worktree.json"));
  assert.equal(worktree.sourcePath, sourcePath);
  assert.equal(worktree.executionBoundary, "worktree");
  assert.notEqual(path.resolve(worktree.worktreePath), path.resolve(sourcePath));
  assert.match(path.relative(path.join(hubRoot, "worktrees"), worktree.worktreePath), /^job-managed-success-pipeline/);

  const result = await readJson(path.join(attemptDir, "result.json"));
  assert.equal(result.assignmentId, assignmentId);
  assert.equal(result.attemptToken, "attempt-token-1");
  assert.equal(result.status, "completed");
  assert.equal(result.jobResult.status, "completed");
  assert.deepEqual(result.jobResult.phaseResults.map((phase) => phase.phase), ["plan", "execute", "verify"]);

  const registry = await readJson(path.join(hubRoot, "workers", "registry", `worker-${workerId}.json`));
  assert.equal(registry.status, "ready");
  assert.equal(registry.currentAssignmentId, null);
  assert.deepEqual(await listJsonFiles(path.join(hubRoot, "workers", "inbox", workerId)), []);
  assert.deepEqual(await listJsonFiles(path.join(hubRoot, "workers", "inbox", workerId, "processing")), []);
  assert.equal(existsSync(worktree.worktreePath), false);

  const transcript = await readFile(transcriptPath, "utf8");
  assert.match(transcript, /software planning agent/);
  assert.match(transcript, /software execution agent/);
  assert.match(transcript, /software verification agent/);

  await rm(root, { recursive: true, force: true });
});

test("managed worker releases persistent ACP provider resources between assignments", async () => {
  const root = await tempRoot("cpb-managed-persistent");
  const hubRoot = path.join(root, "hub");
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  const workerId = "w-persistent";
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# Managed Worker Persistent Fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "managed-worker-persistent", private: true }, null, 2)}\n`, "utf8");
  const scenarioPath = await writeWorkerScenario(root);
  const transcriptPath = path.join(root, "persistent-transcript.jsonl");

  const first = await writeValidAssignment({
    hubRoot,
    workerId,
    sourcePath,
    assignmentId: "a-managed-persistent-one",
    entryId: "managed-persistent-one",
    workflow: "direct",
    planMode: "light",
    attemptToken: "attempt-token-one",
    metadata: { agents: { executor: "fake-acp" } },
  });
  const second = await writeValidAssignment({
    hubRoot,
    workerId,
    sourcePath,
    assignmentId: "a-managed-persistent-two",
    entryId: "managed-persistent-two",
    workflow: "direct",
    planMode: "light",
    attemptToken: "attempt-token-two",
    metadata: { agents: { executor: "fake-acp" } },
  });

  const worker = spawnWorker({
    workerId,
    hubRoot,
    cpbRoot,
    once: false,
    env: {
      CPB_ROOT: cpbRoot,
      CPB_HUB_ROOT: hubRoot,
      CPB_EXECUTOR_ROOT: repoRoot,
      CPB_PROJECT_ROOTS: root,
      CPB_ACP_PERSISTENT_PROCESS: "1",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgentScript,
        "--scenario-file", scenarioPath,
        "--transcript-file", transcriptPath,
      ]),
    },
    timeoutMs: 80_000,
  });

  try {
    const firstResult = await waitFor(async () => readJson(path.join(first.attemptDir, "result.json")), { timeoutMs: 70_000 });
    const secondResult = await waitFor(async () => readJson(path.join(second.attemptDir, "result.json")), { timeoutMs: 70_000 });

    assert.equal(firstResult.status, "completed");
    assert.equal(secondResult.status, "completed");
    assert.deepEqual(firstResult.jobResult.phaseResults.map((phase) => phase.phase), ["execute"]);
    assert.deepEqual(secondResult.jobResult.phaseResults.map((phase) => phase.phase), ["execute"]);

    const transcript = (await readFile(transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(transcript.filter((event) => event.event === "initialize").length, 2);
    assert.equal(transcript.filter((event) => event.event === "session/new").length, 2);
    assert.equal(transcript.filter((event) => event.event === "session/close").length, 2);
    assert.equal(transcript.filter((event) => event.event === "session/prompt").length, 2);

    const firstAuditFile = firstResult.jobResult.phaseResults[0].diagnostics.acpAuditFile;
    const secondAuditFile = secondResult.jobResult.phaseResults[0].diagnostics.acpAuditFile;
    const firstAudit = (await readFile(firstAuditFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const secondAudit = (await readFile(secondAuditFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(firstAudit.some((event) => event.event === "agent_launch"));
    assert.ok(firstAudit.every((event) => event.jobId === "job-managed-persistent-one"));
    assert.ok(secondAudit.some((event) => event.event === "session_new"));
    assert.ok(secondAudit.every((event) => event.jobId === "job-managed-persistent-two"));
  } finally {
    worker.child.kill("SIGTERM");
    await worker.done.catch(() => null);
  }
});
