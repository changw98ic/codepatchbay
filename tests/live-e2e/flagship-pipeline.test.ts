import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { run as runPipeline } from "../../cli/commands/pipeline.js";
import { ensureLocalCodeIndex } from "../../core/indexing/local-code-index/index.js";
import { HubOrchestrator } from "../../server/orchestrator/hub-orchestrator.js";
import { registerProject } from "../../server/services/hub/hub-registry.js";
import { listQueue } from "../../server/services/hub/hub-queue.js";
import { AssignmentStore } from "../../shared/orchestrator/assignment-store.js";
import {
  assertLivePipelineCompleted,
  buildLivePipelineDiagnostics,
  resolveLiveWorktreeEvidence,
} from "./diagnostics.js";

const execFile = promisify(execFileCallback);
const artifactRoot = path.resolve(import.meta.dirname, "../..");
const sourceRoot = path.resolve(artifactRoot, "..");
const timeoutValue = Number(process.env.CPB_LIVE_E2E_PIPELINE_TIMEOUT_MS);
const pipelineTimeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0
  ? timeoutValue
  : 15 * 60 * 1000;
const keepRuntimeOnFailure = process.env.CPB_LIVE_E2E_KEEP_RUNTIME === "1";
const liveE2eEnabled = process.env.CPB_LIVE_E2E === "1";

const configuredAgents = (process.env.CPB_LIVE_E2E_PIPELINE_AGENTS || "codex")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (configuredAgents.some((agent) => /fake|stub|mock/i.test(agent))) {
  throw new Error("CPB_LIVE_E2E_PIPELINE_AGENTS must contain real provider agents only");
}

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

async function runGit(args: string[], cwd: string) {
  await execFile("git", args, {
    cwd,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function createDisposableRepository(root: string) {
  const sourcePath = path.join(root, "source");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({
    name: "cpb-live-pipeline-fixture",
    private: true,
    version: "1.0.0",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(sourcePath, "target.txt"), "not yet verified\n", "utf8");
  await runGit(["init", "-q"], sourcePath);
  await runGit(["config", "user.name", "CodePatchBay Live E2E"], sourcePath);
  await runGit(["config", "user.email", "codepatchbay-live-e2e@invalid.example"], sourcePath);
  await runGit(["add", "--all"], sourcePath);
  await runGit(["commit", "-q", "-m", "Create live pipeline fixture"], sourcePath);
  return sourcePath;
}

async function readJson(filePath: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(filePath, "utf8")) as JsonRecord;
}

async function waitForTerminal(
  hubRoot: string,
  projectId: string,
  assignmentStore: AssignmentStore,
  assignmentId: string,
) {
  const deadline = Date.now() + pipelineTimeoutMs;
  let latestEntry: JsonRecord | null = null;
  let latestAssignment: JsonRecord | null = null;
  while (Date.now() < deadline) {
    latestEntry = (await listQueue(hubRoot, { projectId })
      .then((entries) => entries.find((entry) => entry.id))) as JsonRecord | undefined || null;
    latestAssignment = await assignmentStore.getAssignment(assignmentId) as JsonRecord | null;
    const queueStatus = stringValue(latestEntry?.status);
    const assignmentStatus = stringValue(latestAssignment?.status);
    if (queueStatus === "completed" && assignmentStatus === "completed") {
      return { entry: latestEntry, assignment: latestAssignment, timedOut: false };
    }
    if (["failed", "blocked", "cancelled"].includes(queueStatus || "")
      || ["failed", "blocked", "cancelled"].includes(assignmentStatus || "")) {
      return { entry: latestEntry, assignment: latestAssignment, timedOut: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { entry: latestEntry, assignment: latestAssignment, timedOut: true };
}

function phaseNames(jobResult: JsonRecord) {
  return Array.isArray(jobResult.phaseResults)
    ? jobResult.phaseResults
      .map((value) => stringValue(recordValue(value).phase))
      .filter((value): value is string => Boolean(value))
    : [];
}

function eventTypes(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => recordValue(JSON.parse(line)).type)
    .map((value) => String(value || ""));
}

function preserveEnvironment(keys: string[]) {
  const previous = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function writeRunRecord(record: JsonRecord) {
  const directory = path.join(sourceRoot, "tests", "evidence", "live-e2e");
  await mkdir(directory, { recursive: true });
  const provider = String(record.provider || "provider").replace(/[^A-Za-z0-9._-]/g, "-");
  const runId = String(record.runId || randomUUID()).replace(/[^A-Za-z0-9._-]/g, "-");
  const filePath = path.join(directory, `${provider}-${runId}.json`);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

for (const provider of configuredAgents) {
  test(`real ${provider} provider completes the queue-to-finalizer pipeline`, {
    timeout: pipelineTimeoutMs + 60_000,
    skip: liveE2eEnabled ? false : "run npm run test:live to enable real-provider E2E",
  }, async () => {
    const runId = `${Date.now()}-${randomUUID()}`;
    const actualTemporaryRoot = await mkdtemp(path.join(tmpdir(), `cpb-live-pipeline-${provider}-`));
    const cpbRoot = path.join(actualTemporaryRoot, "cpb");
    const hubRoot = path.join(actualTemporaryRoot, "hub");
    const projectId = `live-pipeline-${provider}`;
    const sourcePath = await createDisposableRepository(actualTemporaryRoot);
    const expected = `cpb-live-pipeline:${provider}:${runId}\n`;
    const task = [
      "This is a real CodePatchBay release verification task.",
      "In the isolated managed worktree, modify only target.txt.",
      `Replace the complete UTF-8 content with exactly this one line: ${expected.trimEnd()}`,
      "Keep the final newline. Do not modify package.json or any other file.",
      "Use your real file-editing tool during the execute phase and finish only after the file is written.",
      "Only the execute phase may edit files. Checklist, review, verify, and finalizer phases must be read-only and must not attempt remediation edits.",
    ].join("\n");
    const environmentKeys = [
      "CPB_ROOT",
      "CPB_EXECUTOR_ROOT",
      "CPB_HUB_ROOT",
      "CPB_PROJECT_ROOTS",
      "CPB_WORKER_DISPATCH_ENABLED",
      "CPB_CHECKLIST_DECOMPOSE",
      "CPB_ACP_USE_MANAGED_POOL",
      "CPB_ACP_PERSISTENT_PROCESS",
      "CPB_ACP_TIMEOUT_MS",
      "CPB_ACP_POOL_TIMEOUT_MS",
      "CPB_ACP_PHASE_TIMEOUT_MS",
      "CPB_ACP_IDLE_TIMEOUT_MS",
      "CPB_AGENT_ISOLATE_HOME",
      "CPB_AGENT_SANDBOX",
      "CPB_AGENT_SANDBOX_NETWORK",
      "CPB_AGENT_SANDBOX_PROCESS",
      "CPB_ACP_PERMISSION",
      "CPB_ACP_TERMINAL",
      "CPB_PROCESS_IDENTITY_MODE",
    ];
    const restoreEnvironment = preserveEnvironment(environmentKeys);
    const runtimeEnvironment = {
      CPB_ROOT: cpbRoot,
      CPB_EXECUTOR_ROOT: artifactRoot,
      CPB_HUB_ROOT: hubRoot,
      CPB_PROJECT_ROOTS: actualTemporaryRoot,
      CPB_WORKER_DISPATCH_ENABLED: "1",
      CPB_CHECKLIST_DECOMPOSE: "1",
      CPB_ACP_USE_MANAGED_POOL: "0",
      CPB_ACP_PERSISTENT_PROCESS: "0",
      CPB_ACP_TIMEOUT_MS: String(pipelineTimeoutMs),
      CPB_ACP_POOL_TIMEOUT_MS: String(pipelineTimeoutMs),
      CPB_ACP_PHASE_TIMEOUT_MS: String(pipelineTimeoutMs),
      CPB_ACP_IDLE_TIMEOUT_MS: String(Math.min(pipelineTimeoutMs, 5 * 60 * 1000)),
      CPB_AGENT_ISOLATE_HOME: "1",
      CPB_AGENT_SANDBOX: "required",
      CPB_AGENT_SANDBOX_NETWORK: "allow",
      CPB_AGENT_SANDBOX_PROCESS: "allow",
      CPB_ACP_PERMISSION: "allow",
      CPB_ACP_TERMINAL: "allow",
      CPB_PROCESS_IDENTITY_MODE: "required",
    };
    Object.assign(process.env, runtimeEnvironment);

    let orchestrator: HubOrchestrator | null = null;
    let projectRuntimeRoot = "";
    let queueEntry: JsonRecord | null = null;
    let assignment: JsonRecord | null = null;
    let workerEvidence: JsonRecord[] = [];
    let result: JsonRecord | null = null;
    let recordPath: string | null = null;
    let record: JsonRecord = {
      schemaVersion: 1,
      kind: "cpb-real-live-pipeline-e2e",
      runId,
      recordedAt: new Date().toISOString(),
      provider,
      realProviderRequired: true,
      fakeProvider: false,
      queue: { status: "not_started" },
      assignment: { status: "not_started" },
      result: { status: "not_written" },
      phases: [],
      evidence: {},
    };

    try {
      await mkdir(cpbRoot, { recursive: true });
      await mkdir(hubRoot, { recursive: true });
      const index = await ensureLocalCodeIndex({ sourcePath, cpbRoot });
      assert.equal(index.available, true, "the live fixture must have a real local code index");
      const project = await registerProject(hubRoot, {
        id: projectId,
        name: projectId,
        sourcePath,
        cpbRoot,
      });
      projectRuntimeRoot = String(project.projectRuntimeRoot || "");
      assert.ok(projectRuntimeRoot, "registered project did not receive a runtime root");

      await runPipeline([
        "--workflow", "standard",
        "--plan-mode", "none",
        "--agent", provider,
        projectId,
        task,
      ], { cpbRoot, executorRoot: artifactRoot });

      const initialEntries = await listQueue(hubRoot, { projectId });
      assert.equal(initialEntries.length, 1, "pipeline must create exactly one queue entry");
      queueEntry = initialEntries[0] as JsonRecord;
      const entryId = String(queueEntry.id);
      const assignmentId = `a-${entryId}`;
      const assignmentStore = new AssignmentStore(hubRoot);
      await assignmentStore.init();

      orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: artifactRoot });
      await orchestrator.start();
      const terminal = await waitForTerminal(hubRoot, projectId, assignmentStore, assignmentId);
      queueEntry = terminal.entry;
      assignment = terminal.assignment;
      workerEvidence = await orchestrator.workerSupervisor.workers.listWorkers() as JsonRecord[];
      assertLivePipelineCompleted({
        queue: queueEntry,
        assignment,
        workers: workerEvidence,
        timedOut: terminal.timedOut,
        timeoutMs: pipelineTimeoutMs,
      });

      const attemptDir = path.join(hubRoot, "assignments", assignmentId, "attempts", "001");
      const resultPath = path.join(attemptDir, "result.json");
      result = await readJson(resultPath);
      const jobResult = recordValue(result.jobResult || result);
      const jobId = stringValue(jobResult.jobId) || `job-${entryId}`;
      const eventPath = path.join(projectRuntimeRoot, "events", projectId, `${jobId}.jsonl`);
      const events = await readFile(eventPath, "utf8");
      const types = eventTypes(events);
      const phases = phaseNames(jobResult);
      const outputDirectory = path.join(projectRuntimeRoot, "wiki", "outputs");
      const checklistArtifacts = (await readdir(outputDirectory))
        .filter((name) => /^acceptance-checklist-.*\.md$/.test(name));
      const worktreeEvidence = resolveLiveWorktreeEvidence(result);
      const editedContent = await readFile(path.join(worktreeEvidence.path, "target.txt"), "utf8");

      record = {
        ...record,
        ok: true,
        queue: {
          id: queueEntry?.id || null,
          status: queueEntry?.status || null,
          projectId,
        },
        assignment: {
          assignmentId,
          status: assignment?.status || null,
          attempt: 1,
          workerId: assignment?.workerId || null,
        },
        result: {
          status: result.status || null,
          jobStatus: jobResult.status || null,
          jobId,
        },
        phases,
        evidence: {
          checklistArtifact: checklistArtifacts[0] || null,
          executeEvent: types.find((type) => type.includes("execute")) || null,
          verifyEvent: types.find((type) => type.includes("verify")) || null,
          finalizerEvent: types.find((type) => type === "audit_finalized") || null,
          eventCount: types.length,
          finalizer: result.finalization || result.finalizeResult || jobResult.finalizeResult || jobResult.finalizer || null,
          finalizationStatus: recordValue(result.finalization).status || null,
          worktreePath: worktreeEvidence.path,
          worktreeCleanup: {
            disposition: worktreeEvidence.cleanup.disposition,
            cleanupVerified: worktreeEvidence.cleanup.cleanupVerified,
            canonicalPathRemoved: worktreeEvidence.cleanup.canonicalPathRemoved,
            quarantinePreserved: worktreeEvidence.cleanup.quarantinePreserved,
          },
          editedFile: editedContent === expected ? "target.txt" : null,
        },
      };
      assert.equal(queueEntry?.status, "completed", "queue did not complete");
      assert.equal(assignment?.status, "completed", "assignment did not complete");
      assert.equal(result.status, "completed", "managed worker result did not complete");
      assert.ok(phases.includes("execute"), `real job did not execute: ${JSON.stringify(phases)}`);
      assert.ok(phases.includes("verify"), `real job did not verify: ${JSON.stringify(phases)}`);
      assert.ok(
        checklistArtifacts.length > 0,
        "acceptance checklist artifact was not recorded",
      );
      assert.ok(
        types.includes("audit_finalized") && recordValue(result.finalization).ok === true,
        "finalizer result was not recorded",
      );
      assert.equal(editedContent, expected, "the real provider did not make the requested isolated edit");
    } catch (error) {
      const embeddedDiagnostics = recordValue(recordValue(error).diagnostics);
      const diagnostics = Object.keys(embeddedDiagnostics).length > 0
        ? embeddedDiagnostics
        : buildLivePipelineDiagnostics({ queue: queueEntry, assignment, workers: workerEvidence });
      record = {
        ...record,
        ok: false,
        failure: {
          message: error instanceof Error ? error.message : String(error),
          code: error && typeof error === "object" && "code" in error ? String(error.code || "") : null,
        },
        queue: {
          ...(recordValue(record.queue)),
          ...(recordValue(diagnostics.queue)),
          status: recordValue(diagnostics.queue).status
            || queueEntry?.status
            || recordValue(record.queue).status
            || null,
        },
        assignment: {
          ...(recordValue(record.assignment)),
          ...(recordValue(diagnostics.assignment)),
          status: recordValue(diagnostics.assignment).status
            || assignment?.status
            || recordValue(record.assignment).status
            || null,
        },
        workers: Array.isArray(diagnostics.workers) ? diagnostics.workers : [],
        result: {
          ...(recordValue(record.result)),
          status: result?.status || recordValue(record.result).status || null,
        },
      };
      throw error;
    } finally {
      let orchestratorStopped = orchestrator === null;
      let cleanupError: unknown = null;
      let finalWorkers: JsonRecord[] = [];
      if (orchestrator) {
        try {
          await orchestrator.stop();
          orchestratorStopped = true;
        } catch (error) {
          cleanupError = error;
        }
        try {
          const workers = await orchestrator.workerSupervisor.workers.listWorkers();
          for (const worker of workers) {
            if (worker.status !== "exited" && worker.status !== "exhausted") {
              await orchestrator.workerSupervisor.stopWorker(String(worker.workerId), "live_e2e_complete");
            }
          }
          finalWorkers = await orchestrator.workerSupervisor.workers.listWorkers() as JsonRecord[];
        } catch (error) {
          cleanupError ||= error;
        }
      }
      const runtimeRetained = keepRuntimeOnFailure && !record.ok;
      let temporaryRootRemoved = false;
      if (runtimeRetained) {
        process.stderr.write(`Live E2E runtime retained: ${actualTemporaryRoot}\n`);
      } else {
        try {
          await rm(actualTemporaryRoot, { recursive: true, force: true });
          temporaryRootRemoved = true;
        } catch (error) {
          cleanupError ||= error;
        }
      }
      restoreEnvironment();
      record = {
        ...record,
        completedAt: new Date().toISOString(),
        evidence: {
          ...recordValue(record.evidence),
          cleanup: {
            orchestratorStopped,
            runtimeRetained,
            temporaryRootRemoved,
            workers: finalWorkers.map((worker) => ({
              workerId: worker.workerId || null,
              status: worker.status || null,
            })),
            error: cleanupError instanceof Error ? cleanupError.message : cleanupError ? String(cleanupError) : null,
          },
        },
      };
      try {
        recordPath = await writeRunRecord(record);
      } catch (error) {
        if (record.ok) throw error;
      }
      if (recordPath) process.stderr.write(`Live E2E record: ${recordPath}\n`);
      if (cleanupError && record.ok) throw cleanupError;
    }
  });
}
