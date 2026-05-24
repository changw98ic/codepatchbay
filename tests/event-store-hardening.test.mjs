import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("event-store hardening", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-es-test-"));
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  // --- concurrent append ---

  it("concurrent appendEvent does not lose events", async () => {
    const { appendEvent, readEvents } = await import("../server/services/event-store.js");
    const project = "conc-test";
    const jobId = "job-conc-001";
    const cpbRoot = tmpDir;

    // Seed a job_created event first so the file exists
    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created",
      jobId,
      project,
      task: "concurrent test",
      ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    // Fire 25 phase_activity events concurrently
    const N = 25;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        appendEvent(cpbRoot, project, jobId, {
          type: "phase_activity",
          jobId,
          project,
          message: `activity-${i}`,
          ts: new Date().toISOString(),
        }, { dataRoot: tmpDir })
      );
    }
    await Promise.all(promises);

    const events = await readEvents(cpbRoot, project, jobId, { dataRoot: tmpDir });
    // 1 job_created + 25 phase_activity
    assert.equal(events.length, N + 1, `expected ${N + 1} events, got ${events.length}`);

    const activityEvents = events.filter((e) => e.type === "phase_activity");
    const messages = new Set(activityEvents.map((e) => e.message));
    assert.equal(messages.size, N, "each activity message must appear exactly once");
  });

  // --- corrupt JSONL: read-only vs repair ---

  it("readEventsReadOnly throws on malformed JSONL tail", async () => {
    const { readEventsReadOnly, eventFileFor } = await import("../server/services/event-store.js");
    const project = "corrupt-ro";
    const jobId = "job-corrupt-ro";
    const cpbRoot = tmpDir;

    // Write a valid event + a corrupt trailing line (no trailing newline)
    const file = eventFileFor(cpbRoot, project, jobId, { dataRoot: tmpDir });
    await mkdir(path.dirname(file), { recursive: true });
    const validLine = JSON.stringify({ type: "job_created", jobId, project, task: "x", ts: new Date().toISOString() });
    await writeFile(file, validLine + "\n{corrupt-bad-json\n", "utf8");

    await assert.rejects(
      () => readEventsReadOnly(cpbRoot, project, jobId, { dataRoot: tmpDir }),
      /malformed event JSON/
    );
  });

  it("readEvents auto-truncates corrupt tail and returns valid events", async () => {
    const { readEvents, eventFileFor } = await import("../server/services/event-store.js");
    const project = "corrupt-rw";
    const jobId = "job-corrupt-rw";
    const cpbRoot = tmpDir;

    const file = eventFileFor(cpbRoot, project, jobId, { dataRoot: tmpDir });
    await mkdir(path.dirname(file), { recursive: true });
    const validLine = JSON.stringify({ type: "job_created", jobId, project, task: "x", ts: new Date().toISOString() });
    // Valid line + newline + corrupt line WITHOUT trailing newline
    // (auto-truncate only fires on incomplete last line, i.e. no trailing \n)
    await writeFile(file, validLine + "\n{corrupt-bad-json", "utf8");

    // readEvents should auto-truncate the corrupt tail and return the valid event
    const events = await readEvents(cpbRoot, project, jobId, { dataRoot: tmpDir });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "job_created");
  });

  it("appendEvent rejects malformed sealed-check history instead of appending", async () => {
    const { appendEvent, eventFileFor } = await import("../server/services/event-store.js");
    const project = "corrupt-mid-append";
    const jobId = "job-corrupt-mid-append";
    const cpbRoot = tmpDir;

    const file = eventFileFor(cpbRoot, project, jobId, { dataRoot: tmpDir });
    await mkdir(path.dirname(file), { recursive: true });
    const validLine = JSON.stringify({ type: "job_created", jobId, project, task: "x", ts: new Date().toISOString() });
    await writeFile(file, `${validLine}\n{bad-json-with-trailing-newline\n`, "utf8");

    await assert.rejects(
      () => appendEvent(cpbRoot, project, jobId, {
        type: "phase_started",
        jobId,
        project,
        phase: "plan",
        ts: new Date().toISOString(),
      }, { dataRoot: tmpDir }),
      /malformed event JSON/
    );
  });

  it("repairEventFile truncates corrupt tail", async () => {
    const { repairEventFile, readEventsReadOnly, eventFileFor } = await import("../server/services/event-store.js");
    const project = "corrupt-repair";
    const jobId = "job-corrupt-repair";
    const cpbRoot = tmpDir;

    const file = eventFileFor(cpbRoot, project, jobId, { dataRoot: tmpDir });
    await mkdir(path.dirname(file), { recursive: true });
    const validLine = JSON.stringify({ type: "job_created", jobId, project, task: "x", ts: new Date().toISOString() });
    // Corrupt last line WITHOUT trailing newline — repairFile only processes these
    await writeFile(file, validLine + "\n{corrupt}", "utf8");

    const result = await repairEventFile(cpbRoot, project, jobId, { dataRoot: tmpDir });
    assert.equal(result.repaired, true);
    assert.ok(result.removedBytes > 0, "should have removed corrupt bytes");

    // After repair, readEventsReadOnly should succeed
    const events = await readEventsReadOnly(cpbRoot, project, jobId, { dataRoot: tmpDir });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "job_created");
  });

  // --- terminal seal ---

  it("terminal seal rejects business mutation after job_completed", async () => {
    const { appendEvent, readEvents } = await import("../server/services/event-store.js");
    const project = "seal-test";
    const jobId = "job-seal-001";
    const cpbRoot = tmpDir;

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created", jobId, project, task: "seal test", ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_completed", jobId, project, ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    // phase_started is NOT in POST_TERMINAL_ALLOWED → must be rejected
    await assert.rejects(
      () => appendEvent(cpbRoot, project, jobId, {
        type: "phase_started", jobId, project, phase: "plan", ts: new Date().toISOString(),
      }, { dataRoot: tmpDir }),
      /terminal job event log is sealed/
    );
  });

  it("terminal seal allows post-terminal diagnostic events", async () => {
    const { appendEvent, readEvents } = await import("../server/services/event-store.js");
    const project = "seal-allow";
    const jobId = "job-seal-allow";
    const cpbRoot = tmpDir;

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created", jobId, project, task: "seal allow", ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_failed", jobId, project, reason: "boom", code: "FATAL", ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    // phase_activity IS in POST_TERMINAL_ALLOWED
    const result = await appendEvent(cpbRoot, project, jobId, {
      type: "phase_activity", jobId, project, message: "post-terminal diagnostic", ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });
    assert.equal(result.type, "phase_activity");

    // finalizer_result IS in POST_TERMINAL_ALLOWED
    const finResult = await appendEvent(cpbRoot, project, jobId, {
      type: "finalizer_result", jobId, project, result: { ok: true }, ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });
    assert.equal(finResult.type, "finalizer_result");

    const events = await readEvents(cpbRoot, project, jobId, { dataRoot: tmpDir });
    // job_created + job_failed + phase_activity + finalizer_result
    assert.equal(events.length, 4);
  });

  // --- secret blocking ---

  it("secret-like artifact path is blocked", async () => {
    const { appendEvent, readEvents } = await import("../server/services/event-store.js");
    const project = "secret-path";
    const jobId = "job-secret-path";
    const cpbRoot = tmpDir;

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created", jobId, project, task: "secret test", ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    // .env is a secret path
    const result = await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      project,
      phase: "execute",
      artifact: ".env",
      ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    assert.equal(result.type, "secret_blocked");
    assert.ok(result.reason.includes("secret-like"), `unexpected reason: ${result.reason}`);

    const events = await readEvents(cpbRoot, project, jobId, { dataRoot: tmpDir });
    const blocked = events.find((e) => e.type === "secret_blocked");
    assert.ok(blocked, "secret_blocked event must be persisted");
    // The original phase_completed with .env artifact must NOT appear
    const leaked = events.find((e) => e.type === "phase_completed" && e.artifact === ".env");
    assert.equal(leaked, undefined, "original secret artifact event must not be persisted");
  });

  it("secret-like artifact content is blocked", async () => {
    const { appendEvent, readEvents } = await import("../server/services/event-store.js");
    const project = "secret-content";
    const jobId = "job-secret-content";
    const cpbRoot = tmpDir;

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created", jobId, project, task: "secret content test", ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    // Content contains a private key pattern
    const result = await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      project,
      phase: "execute",
      artifact: "deploy-config.yaml",
      content: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    assert.equal(result.type, "secret_blocked");

    const events = await readEvents(cpbRoot, project, jobId, { dataRoot: tmpDir });
    const leaked = events.find((e) => e.type === "phase_completed" && e.artifact === "deploy-config.yaml");
    assert.equal(leaked, undefined, "original event with secret content must not be persisted");
  });

  it("secret-like content in output field is blocked", async () => {
    const { appendEvent, readEvents } = await import("../server/services/event-store.js");
    const project = "secret-output";
    const jobId = "job-secret-output";
    const cpbRoot = tmpDir;

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created", jobId, project, task: "secret output test", ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    // Content with an AWS access key pattern in output field
    const result = await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      project,
      phase: "verify",
      artifact: "terraform-output.txt",
      output: "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    assert.equal(result.type, "secret_blocked");

    const events = await readEvents(cpbRoot, project, jobId, { dataRoot: tmpDir });
    const leaked = events.find((e) => e.type === "phase_completed" && e.artifact === "terraform-output.txt");
    assert.equal(leaked, undefined);
  });

  it("secret input rejection event stores redacted evidence", async () => {
    const { appendEvent, readEvents } = await import("../server/services/event-store.js");
    const { makeSecretInputRejectedEvent } = await import("../server/services/secret-policy.js");
    const project = "secret-input";
    const jobId = "job-secret-input";
    const cpbRoot = tmpDir;

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created", jobId, project, task: "secret input test", ts: new Date().toISOString(),
    }, { dataRoot: tmpDir });

    const result = await appendEvent(cpbRoot, project, jobId, makeSecretInputRejectedEvent({
      source: "cli",
      input: "cpb auth connect codex OPENAI_API_KEY=sk-test-secret-value",
    }), { dataRoot: tmpDir });

    assert.equal(result.type, "secret_input_rejected");
    assert.equal(result.reason, "raw secret input rejected");

    const events = await readEvents(cpbRoot, project, jobId, { dataRoot: tmpDir });
    const rejected = events.find((event) => event.type === "secret_input_rejected");
    assert.ok(rejected, "secret_input_rejected event must be persisted");
    const serialized = JSON.stringify(rejected);
    assert.match(serialized, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(serialized, /sk-test-secret-value/);
  });
});
