import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildPhaseLocator, locatorEnvelope } from "../server/services/phase-locator.js";
import { buildPhaseContextPacket } from "../server/services/phase-context.js";
import { appendEvent } from "../server/services/event-store.js";

describe("phase-locator-contract", () => {
  let tmpDir;
  let wikiDir;
  let eventsDir;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cpb-test-locator-${Date.now()}`);
    wikiDir = path.join(tmpDir, "wiki", "projects", "test-proj");
    eventsDir = path.join(tmpDir, "cpb-task", "events", "test-proj");
    const inboxDir = path.join(wikiDir, "inbox");
    const outputsDir = path.join(wikiDir, "outputs");
    await mkdir(inboxDir, { recursive: true });
    await mkdir(outputsDir, { recursive: true });
    await mkdir(eventsDir, { recursive: true });

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
      task: task || "test task",
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

  describe("buildPhaseLocator", () => {
    it("returns locator with correct directory paths", async () => {
      const jobId = "job-20260523-loc001-aaaa";
      await seedJob(tmpDir, "test-proj", jobId, {
        task: "locator path test",
      });

      const locator = await buildPhaseLocator(tmpDir, "test-proj", jobId, "plan");

      // Core identity
      assert.equal(locator.project, "test-proj");
      assert.equal(locator.jobId, jobId);
      assert.equal(locator.phase, "plan");

      // Directory paths
      assert.equal(locator.cpbRoot, path.resolve(tmpDir));
      assert.ok(locator.wikiDir.endsWith(path.join("wiki", "projects", "test-proj")));
      assert.ok(locator.inboxDir.endsWith(path.join("inbox")));
      assert.ok(locator.outputsDir.endsWith(path.join("outputs")));

      // Event log path
      assert.ok(locator.eventLogPath, "should have eventLogPath");
      assert.ok(
        locator.eventLogPath.endsWith(`${jobId}.jsonl`),
        `eventLogPath should end with jobId.jsonl, got: ${locator.eventLogPath}`,
      );
    });

    it("derives prevPhase and prevArtifact for execute", async () => {
      const jobId = "job-20260523-loc002-bbbb";
      await seedJob(tmpDir, "test-proj", jobId, {
        task: "prev artifact test",
        phases: [{ phase: "plan", artifact: "plan-042.md" }],
      });

      const locator = await buildPhaseLocator(tmpDir, "test-proj", jobId, "execute");

      assert.equal(locator.prevPhase, "plan");
      assert.equal(locator.prevArtifact, "plan-042.md");
      assert.ok(locator.prevArtifactPath, "should resolve prevArtifactPath");
      assert.ok(
        locator.prevArtifactPath.includes("plan-042.md"),
        "prevArtifactPath should contain the artifact filename",
      );
    });

    it("populates artifacts from event log", async () => {
      const jobId = "job-20260523-loc003-cccc";
      await seedJob(tmpDir, "test-proj", jobId, {
        task: "artifact map test",
        phases: [
          { phase: "plan", artifact: "plan-099.md" },
          { phase: "execute", artifact: "deliverable-099.md" },
        ],
      });

      const locator = await buildPhaseLocator(tmpDir, "test-proj", jobId, "verify");

      assert.equal(locator.artifacts.plan, "plan-099.md");
      assert.equal(locator.artifacts.execute, "deliverable-099.md");
    });

    it("populates completedPhases from event log", async () => {
      const jobId = "job-20260523-loc004-dddd";
      await seedJob(tmpDir, "test-proj", jobId, {
        task: "completed phases test",
        phases: [
          { phase: "plan", artifact: "plan-100.md" },
          { phase: "execute", artifact: "deliverable-100.md" },
        ],
      });

      const locator = await buildPhaseLocator(tmpDir, "test-proj", jobId, "verify");

      assert.deepEqual(locator.completedPhases, ["plan", "execute"]);
    });
  });

  describe("locatorEnvelope", () => {
    it("serializes locator to a flat envelope with all expected keys", async () => {
      const jobId = "job-20260523-loc005-eeee";
      await seedJob(tmpDir, "test-proj", jobId, {
        task: "envelope test",
      });

      const locator = await buildPhaseLocator(tmpDir, "test-proj", jobId, "plan");
      const envelope = locatorEnvelope(locator);

      // Required keys
      assert.equal(envelope.project, "test-proj");
      assert.equal(envelope.jobId, jobId);
      assert.equal(envelope.phase, "plan");
      assert.ok(envelope.cpbRoot);
      assert.ok(envelope.stateRoot);
      assert.ok(envelope.wikiDir);
      assert.ok(envelope.inboxDir);
      assert.ok(envelope.outputsDir);
      assert.ok(envelope.eventLogPath);

      // Artifacts and completedPhases are present (even if empty)
      assert.ok(envelope.artifacts);
      assert.ok(Array.isArray(envelope.completedPhases));
    });
  });

  describe("buildPhaseContextPacket (locator-first contract)", () => {
    it("packet contains jobId in serialized form", async () => {
      const jobId = "job-20260523-ctx001-ffff";
      await seedJob(tmpDir, "test-proj", jobId, {
        task: "job id presence test",
      });

      const packet = await buildPhaseContextPacket(tmpDir, "test-proj", jobId, "plan");

      assert.equal(packet.jobId, jobId);

      const serialized = JSON.stringify(packet);
      assert.ok(
        serialized.includes(jobId),
        "serialized packet must contain jobId string",
      );
    });

    it("packet contains locator paths like eventLogPath", async () => {
      const jobId = "job-20260523-ctx002-gggg";
      await seedJob(tmpDir, "test-proj", jobId, {
        task: "locator paths test",
      });

      const packet = await buildPhaseContextPacket(tmpDir, "test-proj", jobId, "plan");

      // eventLogPath present in locators
      assert.ok(packet.locators.eventLogPath, "locators must have eventLogPath");
      assert.ok(
        packet.locators.eventLogPath.endsWith(`${jobId}.jsonl`),
        "eventLogPath must end with jobId.jsonl",
      );

      // wikiDir present
      assert.ok(packet.locators.wikiDir);

      // inboxDir and outputsDir present
      assert.ok(packet.locators.inboxDir);
      assert.ok(packet.locators.outputsDir);
    });

    it("artifacts map has IDs/paths but no content bodies", async () => {
      const jobId = "job-20260523-ctx003-hhhh";

      // Write a plan file with real markdown content
      const planContent = "# Plan\n\n## Step 1\nDo important work\n## Acceptance\nAll tests pass";
      await writeFile(path.join(wikiDir, "inbox", "plan-555.md"), planContent);

      await seedJob(tmpDir, "test-proj", jobId, {
        task: "no content bodies test",
        phases: [{ phase: "plan", artifact: "plan-555.md" }],
      });

      const packet = await buildPhaseContextPacket(tmpDir, "test-proj", jobId, "execute");

      // Artifact reference must exist
      assert.equal(packet.artifacts.plan, "plan-555.md");

      // But the markdown body must NOT be embedded anywhere in the packet
      const serialized = JSON.stringify(packet);
      assert.ok(
        !serialized.includes("## Step 1"),
        "packet must not embed plan markdown body",
      );
      assert.ok(
        !serialized.includes("Do important work"),
        "packet must not embed plan content text",
      );
      assert.ok(
        !serialized.includes("All tests pass"),
        "packet must not embed plan acceptance text",
      );
    });

    it("readInstructions reference locator paths, not content", async () => {
      const jobId = "job-20260523-ctx004-iiii";
      await seedJob(tmpDir, "test-proj", jobId, {
        task: "read instructions test",
        phases: [{ phase: "plan", artifact: "plan-777.md" }],
      });

      const packet = await buildPhaseContextPacket(tmpDir, "test-proj", jobId, "execute");

      assert.ok(Array.isArray(packet.readInstructions));
      assert.ok(packet.readInstructions.length > 0);

      // At least one instruction should reference the event log path
      const hasEventLog = packet.readInstructions.some((i) =>
        i.includes(packet.locators.eventLogPath),
      );
      assert.ok(hasEventLog, "readInstructions must reference eventLogPath");

      // At least one instruction should reference the plan artifact
      const hasPlanRead = packet.readInstructions.some((i) =>
        i.includes("plan-777"),
      );
      assert.ok(hasPlanRead, "readInstructions must reference plan artifact");
    });

    it("completedPhases includes execute after execute phase_completed event", async () => {
      const jobId = "job-20260523-ctx005-jjjj";
      await seedJob(tmpDir, "test-proj", jobId, {
        task: "completed execute test",
        phases: [
          { phase: "plan", artifact: "plan-888.md" },
          { phase: "execute", artifact: "deliverable-888.md" },
        ],
      });

      const packet = await buildPhaseContextPacket(tmpDir, "test-proj", jobId, "verify");

      assert.deepEqual(packet.completedPhases, ["plan", "execute"]);
    });

    it("packet schema is stable: required keys present regardless of phase", async () => {
      const jobId = "job-20260523-ctx006-kkkk";
      await seedJob(tmpDir, "test-proj", jobId, {
        task: "schema stability test",
      });

      for (const phase of ["plan", "execute", "verify"]) {
        const packet = await buildPhaseContextPacket(tmpDir, "test-proj", jobId, phase);

        // Mandatory skeleton keys
        assert.equal(packet.schemaVersion, 1, `phase=${phase}: schemaVersion`);
        assert.equal(packet.project, "test-proj", `phase=${phase}: project`);
        assert.equal(packet.jobId, jobId, `phase=${phase}: jobId`);
        assert.equal(packet.phase, phase, `phase=${phase}: phase`);
        assert.ok(packet.locators, `phase=${phase}: locators`);
        assert.ok(packet.artifacts, `phase=${phase}: artifacts`);
        assert.ok(Array.isArray(packet.completedPhases), `phase=${phase}: completedPhases`);
        assert.ok(packet.budget, `phase=${phase}: budget`);
        assert.ok(Array.isArray(packet.readInstructions), `phase=${phase}: readInstructions`);
      }
    });
  });
});
