import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";

import { createJob, startPhase, completePhase, failJob, getJob } from "../server/services/job-store.js";
import { appendEvent } from "../server/services/event-store.js";
import { jobToPipelineState, jobToQueueRow } from "../server/services/job-projection.js";
import { buildPhaseContextPacket } from "../server/services/phase-context.js";
import { buildBudgetReport } from "../server/services/prompt-budget.js";
import { evaluatePermissionDecision } from "../server/services/permission-matrix.js";
import { createSession, startSessionResearch, noteReviewAcpCall, assertReviewBudget } from "../server/services/review-session.js";
import { writeInboxMessage, listInboxMessages, ackInboxMessage, completeInboxMessage } from "../server/services/inbox-mail.js";
import { buildChainSnapshot, analyzeChainSnapshot } from "../server/services/observer.js";
import { acquireLease } from "../server/services/lease-manager.js";
import { buildExecutorPrompt } from "../server/services/prompt-builder.js";
import { buildRetryInputFromVerdict } from "../core/workflow/verdict.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

describe("pipeline-contract", () => {
  let tmpDir;
  let wikiDir;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cpb-contract-${Date.now()}-${process.pid}`);
    wikiDir = path.join(tmpDir, "wiki", "projects", "test-proj");
    const inbox = path.join(wikiDir, "inbox");
    const outputs = path.join(wikiDir, "outputs");
    await mkdir(inbox, { recursive: true });
    await mkdir(outputs, { recursive: true });

    await writeFile(
      path.join(wikiDir, "project.json"),
      JSON.stringify({ sourcePath: tmpDir }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("Test 1: Full job lifecycle — plan -> execute -> verify", () => {
    it("creates a job, progresses through plan/execute/verify, context packets reflect state", async () => {
      // Create job
      const job = await createJob(tmpDir, {
        project: "test-proj",
        task: "implement dark mode toggle",
      });
      assert.ok(job.jobId);
      assert.equal(job.project, "test-proj");
      assert.equal(job.task, "implement dark mode toggle");
      assert.equal(job.status, "running");

      // Plan phase
      await startPhase(tmpDir, "test-proj", job.jobId, { phase: "plan", leaseId: "lease-plan-001" });
      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "phase_activity",
        jobId: job.jobId,
        project: "test-proj",
        message: "planning dark mode",
        ts: new Date().toISOString(),
      });
      await completePhase(tmpDir, "test-proj", job.jobId, {
        phase: "plan",
        artifact: "plan-dark-mode.md",
      });

      // Build context packet for execute phase
      const executePacket = await buildPhaseContextPacket(
        tmpDir, "test-proj", job.jobId, "execute",
      );

      // Verify packet structure
      assert.equal(executePacket.schemaVersion, 1);
      assert.equal(executePacket.project, "test-proj");
      assert.equal(executePacket.jobId, job.jobId);
      assert.equal(executePacket.phase, "execute");

      // Locators present, not null
      assert.ok(executePacket.locators);
      assert.ok(executePacket.locators.inboxDir);
      assert.ok(executePacket.locators.outputsDir);
      assert.ok(executePacket.locators.eventLogPath);
      assert.ok(executePacket.locators.sourcePath);

      // No embedded content bodies — only references
      const serialized = JSON.stringify(executePacket);
      assert.ok(!serialized.includes("## Step"), "packet should not embed plan markdown bodies");

      // Budget metadata present
      assert.ok(executePacket.budget);
      assert.equal(typeof executePacket.budget.maxBytes, "number");
      assert.equal(typeof executePacket.budget.actualBytes, "number");
      assert.equal(typeof executePacket.budget.clipped, "boolean");

      // completedPhases includes plan
      assert.deepEqual(executePacket.completedPhases, ["plan"]);

      // Artifacts reference plan artifact
      assert.equal(executePacket.artifacts.plan, "plan-dark-mode.md");

      // readInstructions present
      assert.ok(Array.isArray(executePacket.readInstructions));
      assert.ok(executePacket.readInstructions.length > 0);

      // Budget report with packet sections
      const sections = [
        { name: "locators", content: JSON.stringify(executePacket.locators), required: true },
        { name: "task", content: executePacket.task || "", required: true },
      ];
      const report = buildBudgetReport(sections, executePacket.budget.maxBytes);
      assert.ok(report.sections.length >= 2);
      for (const s of report.sections) {
        if (s.required) {
          assert.ok(s.included, `required section "${s.name}" must be included`);
        }
      }

      // Execute phase
      await startPhase(tmpDir, "test-proj", job.jobId, { phase: "execute" });
      await completePhase(tmpDir, "test-proj", job.jobId, {
        phase: "execute",
        artifact: "deliverable-dark-mode.md",
      });

      // Build context packet for verify phase
      const verifyPacket = await buildPhaseContextPacket(
        tmpDir, "test-proj", job.jobId, "verify",
      );

      // completedPhases includes plan and execute
      assert.ok(verifyPacket.completedPhases.includes("plan"), "verify packet should include plan in completedPhases");
      assert.ok(verifyPacket.completedPhases.includes("execute"), "verify packet should include execute in completedPhases");

      // Verify phase
      await startPhase(tmpDir, "test-proj", job.jobId, { phase: "verify" });
      await completePhase(tmpDir, "test-proj", job.jobId, {
        phase: "verify",
        artifact: "verdict-dark-mode.md",
      });

      // Final state: all phases complete
      assert.ok(verifyPacket.artifacts);
      assert.equal(verifyPacket.artifacts.plan, "plan-dark-mode.md");
      assert.equal(verifyPacket.artifacts.execute, "deliverable-dark-mode.md");
    });
  });

  describe("Test 2: Permission decisions across phases", () => {
    it("planner reading source is allowed", () => {
      const result = evaluatePermissionDecision(
        "planner", "plan", "read",
        "/some/project/src/main.js",
        tmpDir, "test-proj",
      );
      assert.equal(result.allowed, true);
      assert.equal(result.classification, "allow");
      assert.equal(result.action, "read");
      assert.equal(result.role, "planner");
      assert.equal(result.phase, "plan");
    });

    it("executor writing to wiki system is infra_block", () => {
      // Executor cannot write to wiki/system — that's on the denied list
      const systemPath = path.join(tmpDir, "wiki", "system", "config.md");
      const result = evaluatePermissionDecision(
        "executor", "execute", "write",
        systemPath,
        tmpDir, "test-proj",
        { sourcePath: tmpDir },
      );
      assert.equal(result.allowed, false);
      assert.equal(result.classification, "infra_block");
      assert.equal(result.action, "write");
      assert.equal(result.role, "executor");
      assert.ok(result.reason);
      assert.ok(result.recoveryGuidance);
      assert.equal(result.observable, true);
    });

    it("verifier reading source is allowed", () => {
      const result = evaluatePermissionDecision(
        "verifier", "verify", "read",
        "/some/project/src/main.js",
        tmpDir, "test-proj",
      );
      assert.equal(result.allowed, true);
      assert.equal(result.classification, "allow");
      assert.equal(result.action, "read");
    });

    it("unknown action is denied with reason", () => {
      const result = evaluatePermissionDecision(
        "executor", "execute", "delete",
        "/some/file",
        tmpDir, "test-proj",
      );
      assert.equal(result.allowed, false);
      assert.equal(result.classification, "deny");
      assert.ok(result.reason.includes("unknown action"));
      assert.ok(result.recoveryGuidance);
    });

    it("reading secret paths is denied for all roles", () => {
      const result = evaluatePermissionDecision(
        "planner", "plan", "read",
        "/project/.env.production",
        tmpDir, "test-proj",
      );
      assert.equal(result.allowed, false);
      assert.equal(result.classification, "deny");
      assert.ok(result.reason.includes("secret"));
    });

    it("verifier writing to inbox is infra_block", () => {
      const inboxPath = path.join(tmpDir, "wiki", "projects", "test-proj", "inbox", "rogue.md");
      const result = evaluatePermissionDecision(
        "verifier", "verify", "write",
        inboxPath,
        tmpDir, "test-proj",
      );
      assert.equal(result.allowed, false);
      assert.equal(result.classification, "infra_block");
    });
  });

  describe("Test 3: Review session with budget enforcement", () => {
    it("full session lifecycle with idempotent research and budget enforcement", async () => {
      // Create session
      const session = await createSession(tmpDir, {
        project: "test-proj",
        intent: "review code quality",
      });
      assert.ok(session.sessionId);
      assert.equal(session.project, "test-proj");
      assert.equal(session.status, "idle");
      assert.ok(session.budget);
      assert.equal(session.budget.usedAcpCalls, 0);

      // Start research with a key — succeeds
      const started = await startSessionResearch(tmpDir, session.sessionId, "research-key-abc");
      assert.equal(started.status, "researching");
      assert.equal(started.idempotency.startKey, "research-key-abc");

      // Same key again — idempotent
      const idempotent = await startSessionResearch(tmpDir, session.sessionId, "research-key-abc");
      assert.equal(idempotent.status, "researching");
      assert.equal(idempotent.idempotency.startKey, "research-key-abc");

      // Note ACP calls
      await noteReviewAcpCall(tmpDir, session.sessionId, { agent: "codex", promptBytes: 1024 });
      await noteReviewAcpCall(tmpDir, session.sessionId, { agent: "claude", promptBytes: 2048 });
      await noteReviewAcpCall(tmpDir, session.sessionId, { agent: "codex", promptBytes: 512 });

      // Budget should pass (3 < maxAcpCalls)
      const afterCalls = await noteReviewAcpCall(tmpDir, session.sessionId, { agent: "codex", promptBytes: 100 });
      assert.equal(afterCalls.budget.usedAcpCalls, 4);
      assert.doesNotThrow(() => assertReviewBudget(afterCalls));

      // Exhaust budget: manually create a session at budget limit
      const atLimit = {
        ...afterCalls,
        budget: { ...afterCalls.budget, usedAcpCalls: afterCalls.budget.maxAcpCalls },
      };
      assert.throws(
        () => assertReviewBudget(atLimit),
        (err) => err.message.includes("budget exhausted") && err.message.includes("usedAcpCalls"),
        "should throw budget exhausted for usedAcpCalls >= maxAcpCalls",
      );
    });

    it("different startKey after first research throws idempotency conflict", async () => {
      const session = await createSession(tmpDir, {
        project: "test-proj",
        intent: "test conflict",
      });
      await startSessionResearch(tmpDir, session.sessionId, "key-one");

      await assert.rejects(
        () => startSessionResearch(tmpDir, session.sessionId, "key-two"),
        (err) => err.message.includes("idempotency conflict"),
        "different key should throw idempotency conflict",
      );
    });
  });

  describe("Test 4: InboxMail message lifecycle", () => {
    it("write, list, ack, complete, filter messages", async () => {
      // Write first message
      const msg1 = await writeInboxMessage(tmpDir, "test-proj", {
        type: "plan",
        from: "codex",
        to: "claude",
        content: "## Plan for feature X\n\nStep 1: Do stuff",
      });
      assert.ok(msg1.id);
      assert.equal(msg1.type, "plan");
      assert.equal(msg1.status, "pending");
      assert.equal(msg1.project, "test-proj");

      // Write second message
      const msg2 = await writeInboxMessage(tmpDir, "test-proj", {
        type: "feedback",
        from: "verifier",
        to: "claude",
        content: "## Feedback\n\nImprove error handling",
      });
      assert.ok(msg2.id);
      assert.notEqual(msg1.id, msg2.id);

      // List messages — should have 2
      const all = await listInboxMessages(tmpDir, "test-proj");
      assert.equal(all.length, 2);

      // Ack first message
      const acked = await ackInboxMessage(tmpDir, "test-proj", msg1.id, { owner: "claude-agent" });
      assert.equal(acked.status, "acknowledged");
      assert.equal(acked.owner, "claude-agent");

      // Complete first message
      const completed = await completeInboxMessage(tmpDir, "test-proj", msg1.id);
      assert.equal(completed.status, "completed");

      // Filter by status: pending only — only second remains
      const pending = await listInboxMessages(tmpDir, "test-proj", { status: "pending" });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].id, msg2.id);

      // Filter by type
      const feedbackMsgs = await listInboxMessages(tmpDir, "test-proj", { type: "feedback" });
      assert.equal(feedbackMsgs.length, 1);
      assert.equal(feedbackMsgs[0].type, "feedback");
    });

    it("ack on already-completed message throws invalid transition", async () => {
      const msg = await writeInboxMessage(tmpDir, "test-proj", {
        type: "plan",
        content: "test",
      });
      await ackInboxMessage(tmpDir, "test-proj", msg.id);
      await completeInboxMessage(tmpDir, "test-proj", msg.id);

      await assert.rejects(
        () => ackInboxMessage(tmpDir, "test-proj", msg.id),
        (err) => err.message.includes("invalid transition"),
        "ack on completed should fail",
      );
    });

    it("complete on pending (without ack) throws invalid transition", async () => {
      const msg = await writeInboxMessage(tmpDir, "test-proj", {
        type: "plan",
        content: "skip ack",
      });

      await assert.rejects(
        () => completeInboxMessage(tmpDir, "test-proj", msg.id),
        (err) => err.message.includes("invalid transition"),
        "complete on pending should fail",
      );
    });
  });

  describe("Test 5: Observer chain analysis", () => {
    it("builds snapshot and analyzes a running job", async () => {
      // Create a job and progress through plan
      const job = await createJob(tmpDir, {
        project: "test-proj",
        task: "observer test task",
      });

      // Acquire lease for plan phase
      const lease = await acquireLease(tmpDir, {
        leaseId: `lease-${job.jobId}-plan`,
        jobId: job.jobId,
        phase: "plan",
        ttlMs: 120_000,
      });

      await startPhase(tmpDir, "test-proj", job.jobId, {
        phase: "plan",
        leaseId: lease.leaseId,
      });
      await completePhase(tmpDir, "test-proj", job.jobId, {
        phase: "plan",
        artifact: "plan-observer.md",
      });

      // Start execute phase with active lease
      const execLease = await acquireLease(tmpDir, {
        leaseId: `lease-${job.jobId}-exec`,
        jobId: job.jobId,
        phase: "execute",
        ttlMs: 120_000,
      });
      await startPhase(tmpDir, "test-proj", job.jobId, {
        phase: "execute",
        leaseId: execLease.leaseId,
      });

      // Record some activity
      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "phase_activity",
        jobId: job.jobId,
        project: "test-proj",
        message: "executing task",
        ts: new Date().toISOString(),
      });

      // Build chain snapshot
      const snapshot = await buildChainSnapshot({
        cpbRoot: tmpDir,
        hubRoot: tmpDir,
        project: "test-proj",
        jobId: job.jobId,
      });

      // Verify snapshot fields
      assert.ok(snapshot.job, "snapshot should have job");
      assert.equal(snapshot.job.jobId, job.jobId);
      assert.ok(snapshot.timestamp);
      assert.ok(Array.isArray(snapshot.eventTail));

      // Analyze snapshot
      const analysis = analyzeChainSnapshot(snapshot);

      // Should recommend continue or wait for actively running job
      assert.ok(
        ["continue", "wait"].includes(analysis.recommendation),
        `expected continue or wait, got: ${analysis.recommendation}`,
      );
      assert.ok(Array.isArray(analysis.reasons));
      assert.ok(analysis.reasons.length > 0);
      assert.ok(analysis.details);
      assert.equal(analysis.details.jobId, job.jobId);
    });
  });

  describe("Test 6: Recovery scenario", () => {
    it("failed job triggers recover_as_new_job recommendation", async () => {
      const job = await createJob(tmpDir, {
        project: "test-proj",
        task: "recovery test task",
      });

      await startPhase(tmpDir, "test-proj", job.jobId, { phase: "plan" });
      await failJob(tmpDir, "test-proj", job.jobId, {
        reason: "plan phase crashed",
        code: "RECOVERABLE",
        phase: "plan",
      });

      // Build snapshot for the failed job
      const snapshot = await buildChainSnapshot({
        cpbRoot: tmpDir,
        hubRoot: tmpDir,
        project: "test-proj",
        jobId: job.jobId,
      });

      assert.ok(snapshot.job);
      assert.equal(snapshot.job.status, "failed");

      const analysis = analyzeChainSnapshot(snapshot);
      assert.equal(analysis.recommendation, "recover_as_new_job");
      assert.ok(analysis.reasons.some((r) => r.includes("terminal") || r.includes("failed")));
    });
  });

  describe("Test 7: Prompt budget contract", () => {
    it("required sections always included, optional dropped when over budget", () => {
      const locatorsContent = '{"inboxDir":"/a/b","outputsDir":"/a/c","eventLogPath":"/a/e.jsonl"}';
      const taskContent = "Implement dark mode toggle for the settings page";
      const indexContent = "A".repeat(500); // Large optional section
      const eventsContent = "B".repeat(500); // Large optional section

      const sections = [
        { name: "locators", content: locatorsContent, required: true },
        { name: "task", content: taskContent, required: true },
        { name: "index", content: indexContent, required: false },
        { name: "events", content: eventsContent, required: false },
      ];

      // Set maxBytes between required total and (required + one optional)
      // This way required sections exceed budget but are forced in, optional are dropped
      const reqBytes = Buffer.byteLength(locatorsContent, "utf8") + Buffer.byteLength(taskContent, "utf8");
      const maxBytes = reqBytes - 1; // required exceeds budget → clipped=true, optional dropped
      const report = buildBudgetReport(sections, maxBytes);

      // Required sections always included
      const locatorsEntry = report.sections.find((s) => s.name === "locators");
      const taskEntry = report.sections.find((s) => s.name === "task");
      assert.ok(locatorsEntry.included, "locators must be included (required)");
      assert.ok(locatorsEntry.required);
      assert.ok(taskEntry.included, "task must be included (required)");
      assert.ok(taskEntry.required);

      // Optional sections dropped
      const indexEntry = report.sections.find((s) => s.name === "index");
      const eventsEntry = report.sections.find((s) => s.name === "events");
      assert.ok(!indexEntry.included, "index should be dropped (optional, no budget)");
      assert.ok(!eventsEntry.included, "events should be dropped (optional, no budget)");

      // Clipped flag true
      assert.equal(report.clipped, true, "report should be clipped");

      // totalBytes reflects only included sections
      assert.equal(
        report.totalBytes,
        locatorsEntry.bytes + taskEntry.bytes,
        "totalBytes should only count included sections",
      );
    });

    it("all sections included when budget is sufficient", () => {
      const sections = [
        { name: "locators", content: "short", required: true },
        { name: "task", content: "small task", required: true },
        { name: "index", content: "some index data", required: false },
        { name: "events", content: "some event data", required: false },
      ];

      const report = buildBudgetReport(sections, 10000);

      for (const s of report.sections) {
        assert.ok(s.included, `section "${s.name}" should be included when budget is sufficient`);
      }
      assert.equal(report.clipped, false);
    });

    it("optional section included if it fits after required", () => {
      const req1 = "X".repeat(100);
      const opt1 = "Y".repeat(50);
      const opt2 = "Z".repeat(200);

      const sections = [
        { name: "req1", content: req1, required: true },
        { name: "opt1", content: opt1, required: false },
        { name: "opt2", content: opt2, required: false },
      ];

      // Budget fits req1 + opt1 but not opt2
      const maxBytes = Buffer.byteLength(req1) + Buffer.byteLength(opt1) + 10;
      const report = buildBudgetReport(sections, maxBytes);

      const req1Entry = report.sections.find((s) => s.name === "req1");
      const opt1Entry = report.sections.find((s) => s.name === "opt1");
      const opt2Entry = report.sections.find((s) => s.name === "opt2");

      assert.ok(req1Entry.included);
      assert.ok(opt1Entry.included, "opt1 should fit");
      assert.ok(!opt2Entry.included, "opt2 should not fit");
    });
  });

  describe("Test 8: DAG node projection in pipeline state", () => {
    it("includes pending DAG nodes from the workflow definition before they emit events", async () => {
      const workflow = `projection-pending-${process.pid}`;
      const { registerDagWorkflow } = await import("../core/workflow/definition.js");
      registerDagWorkflow(workflow, {
        nodes: [
          { id: "plan", phase: "plan", dependsOn: [] },
          { id: "exec-a", phase: "execute", dependsOn: ["plan"] },
          { id: "exec-b", phase: "execute", dependsOn: ["plan"] },
          { id: "verify", phase: "verify", dependsOn: ["exec-a", "exec-b"] },
        ],
        maxConcurrentNodes: 2,
      });

      const job = await createJob(tmpDir, {
        project: "test-proj",
        task: "show pending DAG nodes",
        workflow,
      });
      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "dag_node_started",
        jobId: job.jobId,
        project: "test-proj",
        nodeId: "plan",
        phase: "plan",
        ts: "2026-01-01T00:00:00Z",
      });
      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "dag_node_completed",
        jobId: job.jobId,
        project: "test-proj",
        nodeId: "plan",
        phase: "plan",
        ts: "2026-01-01T00:01:00Z",
      });

      const current = await getJob(tmpDir, "test-proj", job.jobId);
      const state = jobToPipelineState(current);

      assert.deepEqual(state.nodes.map((node) => node.id), ["plan", "exec-a", "exec-b", "verify"]);
      assert.equal(state.nodes.find((node) => node.id === "plan").status, "completed");
      assert.equal(state.nodes.find((node) => node.id === "exec-a").status, "pending");
      assert.equal(state.nodes.find((node) => node.id === "exec-b").status, "pending");
      assert.equal(state.nodes.find((node) => node.id === "verify").status, "pending");
    });

    it("exposes DAG node states for UI/API consumers without duplicate completed nodes", async () => {
      const job = await createJob(tmpDir, {
        project: "test-proj",
        task: "ship DAG visibility",
      });

      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "dag_node_started",
        jobId: job.jobId,
        project: "test-proj",
        nodeId: "plan",
        phase: "plan",
        attempt: 1,
        ts: "2026-01-01T00:00:00Z",
      });
      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "dag_node_completed",
        jobId: job.jobId,
        project: "test-proj",
        nodeId: "plan",
        phase: "plan",
        artifact: "plan-001",
        ts: "2026-01-01T00:01:00Z",
      });
      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "dag_node_started",
        jobId: job.jobId,
        project: "test-proj",
        nodeId: "execute",
        phase: "execute",
        attempt: 1,
        ts: "2026-01-01T00:02:00Z",
      });
      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "dag_node_completed",
        jobId: job.jobId,
        project: "test-proj",
        nodeId: "execute",
        phase: "execute",
        artifact: "deliverable-001",
        ts: "2026-01-01T00:03:00Z",
      });
      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "dag_node_started",
        jobId: job.jobId,
        project: "test-proj",
        nodeId: "verify",
        phase: "verify",
        attempt: 1,
        ts: "2026-01-01T00:04:00Z",
      });
      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "dag_node_failed",
        jobId: job.jobId,
        project: "test-proj",
        nodeId: "verify",
        phase: "verify",
        reason: "quality failed",
        ts: "2026-01-01T00:05:00Z",
      });
      await appendEvent(tmpDir, "test-proj", job.jobId, {
        type: "dag_node_retrying",
        jobId: job.jobId,
        project: "test-proj",
        nodeId: "execute",
        phase: "execute",
        reason: "reactivated by verify",
        attempt: 2,
        ts: "2026-01-01T00:06:00Z",
      });

      const current = await getJob(tmpDir, "test-proj", job.jobId);
      const state = jobToPipelineState(current);

      assert.deepEqual(state.completedNodes, ["plan"]);
      assert.deepEqual(state.runningNodes, []);
      assert.equal(state.nodes.length, 3);

      const plan = state.nodes.find((node) => node.id === "plan");
      const execute = state.nodes.find((node) => node.id === "execute");
      const verify = state.nodes.find((node) => node.id === "verify");

      assert.equal(plan.status, "completed");
      assert.equal(plan.artifact, "plan-001");
      assert.equal(plan.durationMs, 60_000);
      assert.equal(execute.status, "retrying");
      assert.equal(execute.attempt, 2);
      assert.equal(execute.reason, "reactivated by verify");
      assert.equal(verify.status, "failed");
      assert.equal(verify.reason, "quality failed");
    });
  });

  describe("Test 9: Default worktree policy", () => {
    async function createRepo(name) {
      const repo = path.join(tmpDir, name);
      await mkdir(repo, { recursive: true });
      await git(repo, ["init", "-b", "main"]);
      await git(repo, ["config", "user.email", "tests@example.invalid"]);
      await git(repo, ["config", "user.name", "Tests"]);
      await writeFile(path.join(repo, "README.md"), `${name}\n`, "utf8");
      await git(repo, ["add", "README.md"]);
      await git(repo, ["commit", "-m", "initial"]);
      return repo;
    }

    async function withWorktreeEnv(fn) {
      const saved = {
        CPB_USE_WORKTREE: process.env.CPB_USE_WORKTREE,
        CPB_PROJECT_RUNTIME_ROOT: process.env.CPB_PROJECT_RUNTIME_ROOT,
        CPB_PROJECT_PATH_OVERRIDE: process.env.CPB_PROJECT_PATH_OVERRIDE,
        CPB_ACP_CWD: process.env.CPB_ACP_CWD,
      };
      try {
        delete process.env.CPB_USE_WORKTREE;
        process.env.CPB_PROJECT_RUNTIME_ROOT = tmpDir;
        return await fn();
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }

    it("creates an isolated worktree by default and records branch metadata", async () => {
      const sourceRepo = await createRepo("source-default-worktree");
      const projectDir = path.join(tmpDir, "wiki", "projects", "test-proj");
      await writeFile(
        path.join(projectDir, "project.json"),
        JSON.stringify({ sourcePath: sourceRepo }),
        "utf8",
      );
      const { runPipeline } = await import("../bridges/run-pipeline.mjs");

      await withWorktreeEnv(async () => {
        const code = await runPipeline({
          project: "test-proj",
          task: "default worktree policy",
          workflow: "blocked",
          jobIdOverride: "job-default-worktree",
          sourcePath: sourceRepo,
          executorRoot: repoRoot,
          cpbRoot: tmpDir,
        });
        assert.equal(code, 0);
      });

      const job = await getJob(tmpDir, "test-proj", "job-default-worktree", { dataRoot: tmpDir });
      assert.equal(job.jobId, "job-default-worktree");
      assert.ok(job.worktree, "job should record the created worktree path");
      assert.match(job.worktree, /job-default-worktree-pipeline$/);
      assert.equal(job.worktreeBaseBranch, "main");
      assert.equal(job.worktreeBranch, "cpb/job-default-worktree-pipeline");
    });

    it("honors project policy opt-out and keeps legacy jobs readable without worktree metadata", async () => {
      const sourceRepo = await createRepo("source-worktree-off");
      const projectDir = path.join(tmpDir, "wiki", "projects", "test-proj");
      await writeFile(
        path.join(projectDir, "project.json"),
        JSON.stringify({ sourcePath: sourceRepo, policy: { useWorktree: false } }),
        "utf8",
      );
      const { runPipeline } = await import("../bridges/run-pipeline.mjs");

      await withWorktreeEnv(async () => {
        const code = await runPipeline({
          project: "test-proj",
          task: "worktree opt out",
          workflow: "blocked",
          jobIdOverride: "job-worktree-off",
          sourcePath: sourceRepo,
          executorRoot: repoRoot,
          cpbRoot: tmpDir,
        });
        assert.equal(code, 0);
      });

      const optedOut = await getJob(tmpDir, "test-proj", "job-worktree-off", { dataRoot: tmpDir });
      assert.equal(optedOut.jobId, "job-worktree-off");
      assert.equal(optedOut.worktree, null);
      assert.equal(optedOut.worktreeBaseBranch, null);

      const legacy = await createJob(tmpDir, {
        project: "test-proj",
        task: "legacy no worktree metadata",
        jobId: "job-legacy-no-worktree",
      });
      assert.equal(legacy.worktree, null);
      assert.equal(legacy.worktreeBaseBranch, null);
    });
  });

  describe("Test 10: Retry reason normalization", () => {
    it("turns a failing verifier envelope into concise executor retry input", () => {
      const retryInput = buildRetryInputFromVerdict({
        status: "fail",
        reason: "Missing regression coverage for expired-token redirects.",
        blocking: [
          {
            criterion: "Expired token redirect is covered by tests",
            evidence: "npm test did not include an expired-token redirect case.",
            file: "tests/auth.test.ts",
            fix_hint: "Add a regression test that asserts expired tokens redirect to /login.",
          },
          {
            criterion: "Redirect code handles expired tokens",
            evidence: "src/auth/redirect.ts only checks missing tokens.",
            file: "src/auth/redirect.ts",
            fix_hint: "Treat expired tokens the same as missing tokens before redirecting.",
          },
        ],
        fix_scope: ["src/auth/redirect.ts", "tests/auth.test.ts"],
      }, {
        retryCount: 2,
        previousVerdictId: "verdict-007",
        previousVerdictPath: "/tmp/cpb/verdict-007.md",
      });

      assert.equal(retryInput.shouldRetry, true);
      assert.equal(retryInput.retryCount, 2);
      assert.equal(retryInput.previousVerdictId, "verdict-007");
      assert.deepEqual(retryInput.repairScope, ["src/auth/redirect.ts", "tests/auth.test.ts"]);
      assert.equal(retryInput.failingChecks.length, 2);
      assert.match(retryInput.failingChecks[0], /Expired token redirect is covered by tests/);
      assert.match(retryInput.failingChecks[0], /tests\/auth\.test\.ts/);
      assert.match(retryInput.prompt, /Retry 2/);
      assert.match(retryInput.prompt, /verdict-007/);
      assert.match(retryInput.prompt, /Missing regression coverage/);
      assert.match(retryInput.prompt, /Expected repair scope/);
      assert.match(retryInput.prompt, /src\/auth\/redirect\.ts/);
    });

    it("does not create retry input for a PASS verdict", () => {
      const retryInput = buildRetryInputFromVerdict({
        status: "pass",
        reason: "All checks passed.",
        blocking: [],
        fix_scope: [],
      }, {
        retryCount: 1,
        previousVerdictId: "verdict-pass",
      });

      assert.equal(retryInput.shouldRetry, false);
      assert.deepEqual(retryInput.failingChecks, []);
      assert.deepEqual(retryInput.repairScope, []);
      assert.equal(retryInput.prompt, "");
    });

    it("includes normalized retry input in the executor prompt when a verdict file is provided", async () => {
      const planId = "007";
      const deliverableFile = path.join(wikiDir, "outputs", "deliverable-008.md");
      const verdictFile = path.join(wikiDir, "outputs", "verdict-007.md");
      await writeFile(path.join(wikiDir, "inbox", `plan-${planId}.md`), "# Plan\n\nFix expired-token redirect.\n", "utf8");
      await writeFile(verdictFile, JSON.stringify({
        status: "fail",
        confidence: 0.8,
        layers: {
          fast: { status: "fail", detail: "Focused auth tests missed expired-token redirect coverage." },
          changed: { status: "fail", detail: "Changed auth redirect path was not covered." },
          regression: { status: "skipped", detail: "Skipped after focused failure." },
          acceptance: { status: "fail", detail: "Expired token acceptance criterion is unmet." },
        },
        blocking: [
          {
            criterion: "Expired token redirect is covered by tests",
            evidence: "No test asserts expired tokens redirect to /login.",
            file: "tests/auth.test.ts",
            fix_hint: "Add a focused regression test.",
          },
        ],
        diff_summary: "2 files changed",
        task_goal: "Fix expired-token redirect.",
        executor_summary: "Implemented missing-token redirect only.",
        reason: "Expired-token redirect remains unverified.",
        fix_scope: ["src/auth/redirect.ts", "tests/auth.test.ts"],
      }), "utf8");

      const prompt = await buildExecutorPrompt(repoRoot, tmpDir, "test-proj", planId, deliverableFile, verdictFile);

      assert.match(prompt, /Previous Verification Failure/);
      assert.match(prompt, /Retry 1/);
      assert.match(prompt, /Expired token redirect is covered by tests/);
      assert.match(prompt, /Expected repair scope/);
      assert.match(prompt, /src\/auth\/redirect\.ts/);
      assert.match(prompt, /tests\/auth\.test\.ts/);
    });
  });

  describe("Test 11: Queue dashboard projection", () => {
    it("projects source, workflow, phase, retry count, and next human action from event-log state", async () => {
      const jobId = "job-queue-projection-001";
      await appendEvent(tmpDir, "test-proj", jobId, {
        type: "job_created",
        jobId,
        project: "test-proj",
        task: "fix login redirect",
        workflow: "strict",
        sourceContext: {
          type: "github_issue",
          issueNumber: 123,
          repo: "org/frontend",
        },
        ts: "2026-05-24T00:00:00Z",
      });
      await appendEvent(tmpDir, "test-proj", jobId, {
        type: "dag_node_started",
        jobId,
        project: "test-proj",
        nodeId: "execute",
        phase: "execute",
        attempt: 1,
        ts: "2026-05-24T00:01:00Z",
      });
      await appendEvent(tmpDir, "test-proj", jobId, {
        type: "dag_node_retrying",
        jobId,
        project: "test-proj",
        nodeId: "execute",
        phase: "execute",
        attempt: 2,
        retryCount: 1,
        reason: "reactivated by verify",
        ts: "2026-05-24T00:02:00Z",
      });
      await appendEvent(tmpDir, "test-proj", jobId, {
        type: "job_redirect_requested",
        jobId,
        project: "test-proj",
        instructions: "Narrow the change to auth redirect tests.",
        reason: "manual correction",
        redirectEventId: "redirect-1",
        ts: "2026-05-24T00:03:00Z",
      });

      const job = await getJob(tmpDir, "test-proj", jobId);
      const row = jobToQueueRow(job);

      assert.equal(row.status, "running");
      assert.equal(row.workflow, "strict");
      assert.equal(row.currentPhase, "execute");
      assert.equal(row.retryCount, 1);
      assert.equal(row.source.type, "github_issue");
      assert.equal(row.source.label, "GitHub issue #123");
      assert.equal(row.source.repo, "org/frontend");
      assert.equal(row.nextHumanAction.kind, "redirect");
      assert.match(row.nextHumanAction.label, /Review redirect/);
    });

    it("distinguishes passed and PR-opened terminal states from event-log state", async () => {
      const passedJobId = "job-queue-passed-001";
      await appendEvent(tmpDir, "test-proj", passedJobId, {
        type: "job_created",
        jobId: passedJobId,
        project: "test-proj",
        task: "passed job",
        workflow: "standard",
        ts: "2026-05-24T01:00:00Z",
      });
      await appendEvent(tmpDir, "test-proj", passedJobId, {
        type: "job_completed",
        jobId: passedJobId,
        project: "test-proj",
        ts: "2026-05-24T01:01:00Z",
      });

      const prJobId = "job-queue-pr-001";
      await appendEvent(tmpDir, "test-proj", prJobId, {
        type: "job_created",
        jobId: prJobId,
        project: "test-proj",
        task: "pr job",
        workflow: "standard",
        ts: "2026-05-24T02:00:00Z",
      });
      await appendEvent(tmpDir, "test-proj", prJobId, {
        type: "job_completed",
        jobId: prJobId,
        project: "test-proj",
        ts: "2026-05-24T02:01:00Z",
      });
      await appendEvent(tmpDir, "test-proj", prJobId, {
        type: "pr_opened",
        jobId: prJobId,
        project: "test-proj",
        prUrl: "https://github.com/org/repo/pull/456",
        prNumber: 456,
        artifact: "pr-456.md",
        ts: "2026-05-24T02:02:00Z",
      });

      assert.equal(jobToQueueRow(await getJob(tmpDir, "test-proj", passedJobId)).status, "passed");
      const prRow = jobToQueueRow(await getJob(tmpDir, "test-proj", prJobId));
      assert.equal(prRow.status, "pr-opened");
      assert.equal(prRow.pr.url, "https://github.com/org/repo/pull/456");
      assert.equal(prRow.nextHumanAction.kind, "review_pr");
    });
  });
});
