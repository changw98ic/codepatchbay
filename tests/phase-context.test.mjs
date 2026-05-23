import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildPhaseContextPacket } from "../server/services/phase-context.js";
import { appendEvent } from "../server/services/event-store.js";

describe("phase-context", () => {
  let tmpDir;
  let wikiDir;
  let eventsDir;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cpb-test-phase-ctx-${Date.now()}`);
    wikiDir = path.join(tmpDir, "wiki", "projects", "test-proj");
    eventsDir = path.join(tmpDir, "cpb-task", "events", "test-proj");
    const inboxDir = path.join(wikiDir, "inbox");
    const outputsDir = path.join(wikiDir, "outputs");
    await mkdir(inboxDir, { recursive: true });
    await mkdir(outputsDir, { recursive: true });
    await mkdir(eventsDir, { recursive: true });

    // Write project.json with sourcePath
    await writeFile(
      path.join(wikiDir, "project.json"),
      JSON.stringify({ sourcePath: tmpDir }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function seedJob(cpbRoot, project, jobId, { task, workflow, phases } = {}) {
    const ts = new Date().toISOString();
    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created",
      jobId,
      project,
      task: task || "test task description",
      workflow: workflow || "standard",
      ts,
    });

    if (phases) {
      for (const p of phases) {
        await appendEvent(cpbRoot, project, jobId, {
          type: "phase_started",
          jobId,
          project,
          phase: p.phase,
          attempt: 1,
          ts,
        });
        await appendEvent(cpbRoot, project, jobId, {
          type: "phase_completed",
          jobId,
          project,
          phase: p.phase,
          artifact: p.artifact || "",
          ts,
        });
      }
    }
  }

  it("packet contains locator fields, event log path, wiki paths, source path, artifacts map, completed phases, job status", async () => {
    const jobId = "job-20260523-120000-abc123";
    await seedJob(tmpDir, "test-proj", jobId, {
      task: "add dark mode",
      phases: [{ phase: "plan", artifact: "plan-001.md" }],
    });

    const packet = await buildPhaseContextPacket(
      tmpDir,
      "test-proj",
      jobId,
      "execute",
    );

    // Schema version
    assert.equal(packet.schemaVersion, 1);
    assert.equal(packet.project, "test-proj");
    assert.equal(packet.jobId, jobId);
    assert.equal(packet.phase, "execute");

    // Locators present
    assert.ok(packet.locators);
    assert.ok(packet.locators.wikiDir);
    assert.ok(packet.locators.inboxDir);
    assert.ok(packet.locators.outputsDir);
    assert.ok(packet.locators.eventLogPath);
    assert.ok(packet.locators.sourcePath);
    assert.equal(packet.locators.project, "test-proj");
    assert.equal(packet.locators.jobId, jobId);

    // Task and workflow
    assert.equal(packet.task, "add dark mode");
    assert.equal(packet.workflow, "standard");

    // Artifacts as id/path map (no content bodies)
    assert.ok(packet.artifacts);
    assert.equal(packet.artifacts.plan, "plan-001.md");

    // Completed phases
    assert.deepEqual(packet.completedPhases, ["plan"]);

    // Source context
    assert.ok(packet.sourceContext);

    // Job status from locators
    assert.ok(packet.locators.jobStatus);
  });

  it("packet does NOT contain full plan/deliverable markdown bodies", async () => {
    const jobId = "job-20260523-120100-def456";

    // Write a plan file with markdown body
    const planContent = "# Plan\n\n## Step 1\nDo the thing\n## Step 2\nVerify it";
    await writeFile(
      path.join(wikiDir, "inbox", "plan-002.md"),
      planContent,
    );

    await seedJob(tmpDir, "test-proj", jobId, {
      task: "refactor auth",
      phases: [{ phase: "plan", artifact: "plan-002.md" }],
    });

    const packet = await buildPhaseContextPacket(
      tmpDir,
      "test-proj",
      jobId,
      "execute",
    );

    // Serialize to detect embedded content
    const serialized = JSON.stringify(packet);

    // The plan markdown body must NOT appear in the packet
    assert.ok(
      !serialized.includes("## Step 1"),
      "packet should not embed plan markdown content",
    );
    assert.ok(
      !serialized.includes("Do the thing"),
      "packet should not embed plan markdown content",
    );

    // But the artifact reference should exist
    assert.equal(packet.artifacts.plan, "plan-002.md");
  });

  it("packet includes budget with maxBytes and actualBytes where actualBytes <= maxBytes", async () => {
    const jobId = "job-20260523-120200-ghi789";
    await seedJob(tmpDir, "test-proj", jobId, {
      task: "optimize queries",
    });

    const packet = await buildPhaseContextPacket(
      tmpDir,
      "test-proj",
      jobId,
      "plan",
    );

    assert.ok(packet.budget);
    assert.equal(packet.budget.maxBytes, 8192);
    assert.equal(typeof packet.budget.actualBytes, "number");
    assert.ok(
      packet.budget.actualBytes <= packet.budget.maxBytes,
      `actualBytes (${packet.budget.actualBytes}) must be <= maxBytes (${packet.budget.maxBytes})`,
    );
    assert.equal(typeof packet.budget.clipped, "boolean");
  });

  it("packet includes readInstructions as array of strings", async () => {
    const jobId = "job-20260523-120300-jkl012";
    await seedJob(tmpDir, "test-proj", jobId, {
      task: "add logging",
      phases: [{ phase: "plan", artifact: "plan-003.md" }],
    });

    const packet = await buildPhaseContextPacket(
      tmpDir,
      "test-proj",
      jobId,
      "execute",
    );

    assert.ok(Array.isArray(packet.readInstructions));
    assert.ok(packet.readInstructions.length > 0, "should have at least one read instruction");

    // Every instruction must be a string
    for (const instr of packet.readInstructions) {
      assert.equal(typeof instr, "string");
      assert.ok(instr.length > 0, "instruction should not be empty");
    }

    // Should reference event log path
    const hasEventLogInstr = packet.readInstructions.some((i) =>
      i.includes("event log") || i.includes("event-log") || i.includes(".jsonl"),
    );
    assert.ok(hasEventLogInstr, "readInstructions should reference the event log");

    // Should reference source code
    const hasSourceInstr = packet.readInstructions.some((i) =>
      i.includes("Source code root"),
    );
    assert.ok(hasSourceInstr, "readInstructions should reference source code root");
  });

  it("budget clipping works: when maxBytes is small, index summary is dropped but locators remain", async () => {
    const jobId = "job-20260523-120400-mno345";
    await seedJob(tmpDir, "test-proj", jobId, {
      task: "tiny budget test",
    });

    // Use a very small budget to force clipping
    const packet = await buildPhaseContextPacket(
      tmpDir,
      "test-proj",
      jobId,
      "plan",
      { maxBytes: 512 },
    );

    // Core fields must survive clipping
    assert.ok(packet.locators, "locators must survive clipping");
    assert.ok(packet.jobId, "jobId must survive clipping");
    assert.equal(packet.project, "test-proj");
    assert.equal(packet.phase, "plan");
    assert.ok(packet.task, "task must survive clipping");
    assert.ok(
      Array.isArray(packet.readInstructions),
      "readInstructions must survive clipping",
    );
    assert.ok(
      Array.isArray(packet.completedPhases),
      "completedPhases must survive clipping",
    );

    // Index summary should be null when budget is tight
    assert.ok(
      packet.indexSummary === null || packet.indexSummary === "",
      "index summary should be dropped under tight budget",
    );

    // Budget tracking
    assert.ok(packet.budget);
    assert.equal(packet.budget.maxBytes, 512);
    assert.equal(typeof packet.budget.actualBytes, "number");
    // actualBytes may exceed maxBytes for mandatory fields — that's expected
    // The key invariant is that optional sections are dropped
  });

  it("respects CPB_PHASE_CONTEXT_MAX_BYTES env var", async () => {
    const jobId = "job-20260523-120500-pqr678";
    await seedJob(tmpDir, "test-proj", jobId);

    const originalEnv = process.env.CPB_PHASE_CONTEXT_MAX_BYTES;
    process.env.CPB_PHASE_CONTEXT_MAX_BYTES = "2048";
    try {
      const packet = await buildPhaseContextPacket(
        tmpDir,
        "test-proj",
        jobId,
        "plan",
      );
      assert.equal(packet.budget.maxBytes, 2048);
    } finally {
      if (originalEnv !== undefined) {
        process.env.CPB_PHASE_CONTEXT_MAX_BYTES = originalEnv;
      } else {
        delete process.env.CPB_PHASE_CONTEXT_MAX_BYTES;
      }
    }
  });

  it("options.maxBytes overrides env var", async () => {
    const jobId = "job-20260523-120600-stu901";
    await seedJob(tmpDir, "test-proj", jobId);

    const originalEnv = process.env.CPB_PHASE_CONTEXT_MAX_BYTES;
    process.env.CPB_PHASE_CONTEXT_MAX_BYTES = "2048";
    try {
      const packet = await buildPhaseContextPacket(
        tmpDir,
        "test-proj",
        jobId,
        "plan",
        { maxBytes: 4096 },
      );
      assert.equal(packet.budget.maxBytes, 4096);
    } finally {
      if (originalEnv !== undefined) {
        process.env.CPB_PHASE_CONTEXT_MAX_BYTES = originalEnv;
      } else {
        delete process.env.CPB_PHASE_CONTEXT_MAX_BYTES;
      }
    }
  });
});
