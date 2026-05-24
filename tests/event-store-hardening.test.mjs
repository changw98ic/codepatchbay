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

  // --- D47: Audit export ---

  it("D47: buildJobAuditExport is deterministic and redacts secrets", async () => {
    const { eventFileFor } = await import("../server/services/event-store.js");
    const { buildJobAuditExport, writeJobAuditExport } = await import("../server/services/audit-export.js");
    const project = "audit-export";
    const jobId = "job-audit-d47";
    const cpbRoot = tmpDir;

    const eventFile = eventFileFor(cpbRoot, project, jobId, { dataRoot: tmpDir });
    await mkdir(path.dirname(eventFile), { recursive: true });
    const rawEvents = [
      {
        type: "job_created", jobId, project, task: "audit export test",
        githubToken: "ghp_1234567890abcdef",
        ts: "2026-05-25T00:00:00.000Z",
      },
      {
        type: "phase_completed", jobId, project, phase: "plan", artifact: "plan-001.md", agent: "codex",
        ts: "2026-05-25T00:01:00.000Z",
      },
      {
        type: "phase_completed", jobId, project, phase: "execute", artifact: "deliverable-missing.md", agent: "claude",
        ts: "2026-05-25T00:02:00.000Z",
      },
      {
        type: "phase_activity", jobId, project, phase: "execute",
        message: "configuring api key sk-test-secret-value for deployment",
        ts: "2026-05-25T00:02:30.000Z",
      },
      {
        type: "phase_completed", jobId, project, phase: "verify", artifact: "verdict-001.md", agent: "codex",
        ts: "2026-05-25T00:03:00.000Z",
      },
      {
        type: "pr_opened", jobId, project,
        prNumber: 42,
        prUrl: "https://github.com/org/repo/pull/42",
        artifact: "pr-001.md",
        ts: "2026-05-25T00:04:00.000Z",
      },
    ];
    await writeFile(eventFile, `${rawEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    // Write a plan artifact file so it resolves as present
    const wikiInbox = path.join(tmpDir, "wiki", "projects", project, "inbox");
    const wikiOutputs = path.join(tmpDir, "wiki", "projects", project, "outputs");
    await mkdir(wikiInbox, { recursive: true });
    await mkdir(wikiOutputs, { recursive: true });
    await writeFile(path.join(wikiInbox, "plan-001.md"), "# Plan\n", "utf8");
    // No deliverable-missing.md — intentional broken ref
    await writeFile(path.join(wikiOutputs, "verdict-001.md"), JSON.stringify({
      status: "pass",
      confidence: 0.91,
      reason: "Verified without leaking sk-test-secret-value.",
      blocking: [],
    }), "utf8");

    // Determinism: two calls must produce identical output
    const pkg1 = await buildJobAuditExport(cpbRoot, project, jobId, { dataRoot: tmpDir });
    const pkg2 = await buildJobAuditExport(cpbRoot, project, jobId, { dataRoot: tmpDir });
    assert.deepStrictEqual(pkg1, pkg2);

    // Package structure
    assert.ok(Array.isArray(pkg1.eventLog), "package must contain eventLog array");
    assert.equal(pkg1.schemaVersion, 1);
    assert.equal(pkg1.project, project);
    assert.equal(pkg1.jobId, jobId);
    assert.ok(pkg1.artifactIndex, "package must contain artifactIndex");
    assert.ok(pkg1.verdict, "package must contain verdict");
    assert.ok(pkg1.pr, "package must contain pr metadata");
    assert.equal(pkg1.pr.number, 42);
    assert.equal(pkg1.verdict.status, "pass");
    assert.equal(pkg1.verdict.confidence, 0.91);

    // Secret redaction in returned package
    const serialized = JSON.stringify(pkg1);
    assert.doesNotMatch(serialized, /sk-test-secret-value/, "sk-test secret must be redacted");
    assert.doesNotMatch(serialized, /ghp_[A-Za-z0-9]/, "GitHub token pattern must be redacted");

    // Missing artifact → brokenReferences
    assert.ok(
      Array.isArray(pkg1.artifactIndex.brokenReferences),
      "artifactIndex must have brokenReferences array",
    );
    assert.ok(
      pkg1.artifactIndex.brokenReferences.some((ref) => JSON.stringify(ref).includes("deliverable-missing.md")),
      "missing execute artifact must appear in brokenReferences",
    );

    // writeJobAuditExport writes a file with redacted content
    const exportDir = path.join(tmpDir, "audit-export-out");
    await mkdir(exportDir, { recursive: true });
    const exportPath = await writeJobAuditExport(exportDir, {
      ...pkg1,
      unsafeNote: "do not leak sk-write-secret-value",
    });
    const fileContent = await import("node:fs/promises").then((fs) => fs.readFile(exportPath, "utf8"));
    assert.match(path.basename(exportPath), /^audit-export-job-audit-d47-audit\.json$/);
    assert.doesNotMatch(fileContent, /sk-test-secret-value/, "written export must redact secrets");
    assert.doesNotMatch(fileContent, /sk-write-secret-value/, "writeJobAuditExport must redact before writing");
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
