import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  writeInboxMessage,
  listInboxMessages,
  readInboxMessage,
  ackInboxMessage,
  completeInboxMessage,
} from "../server/services/inbox-mail.js";

describe("inbox-mail", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cpb-test-inbox-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a message, reads it back, verifies all frontmatter fields", async () => {
    const msg = await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      jobId: "job-123",
      phase: "plan",
      from: "planner",
      to: "executor",
      locator: { eventLogPath: "/abs/path/events.jsonl" },
      content: "# Plan message content\n\nDo the thing.",
    });

    assert.ok(msg.id);
    assert.ok(msg.id.startsWith("msg-"));
    assert.equal(msg.schema, "cpb.inbox-mail.v1");
    assert.equal(msg.type, "plan");
    assert.equal(msg.project, "test-proj");
    assert.equal(msg.jobId, "job-123");
    assert.equal(msg.phase, "plan");
    assert.equal(msg.from, "planner");
    assert.equal(msg.to, "executor");
    assert.equal(msg.status, "pending");
    assert.equal(msg.owner, "");
    assert.ok(msg.createdAt);
    assert.ok(msg.updatedAt);

    const full = await readInboxMessage(tmpDir, "test-proj", msg.id);
    assert.ok(full);
    assert.equal(full.id, msg.id);
    assert.equal(full.type, "plan");
    assert.equal(full.project, "test-proj");
    assert.equal(full.jobId, "job-123");
    assert.equal(full.from, "planner");
    assert.equal(full.to, "executor");
    assert.equal(full.status, "pending");
    assert.ok(full.content.includes("Plan message content"));
  });

  it("lists messages and filters by type, status, to", async () => {
    await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      from: "planner",
      to: "executor",
      content: "# Plan A",
    });
    await writeInboxMessage(tmpDir, "test-proj", {
      type: "notify",
      from: "system",
      to: "planner",
      content: "# Notify B",
    });
    await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      from: "planner",
      to: "reviewer",
      content: "# Plan C",
    });

    const all = await listInboxMessages(tmpDir, "test-proj");
    assert.equal(all.length, 3);

    const plans = await listInboxMessages(tmpDir, "test-proj", { type: "plan" });
    assert.equal(plans.length, 2);

    const toExec = await listInboxMessages(tmpDir, "test-proj", { to: "executor" });
    assert.equal(toExec.length, 1);
    assert.equal(toExec[0].to, "executor");

    const pending = await listInboxMessages(tmpDir, "test-proj", { status: "pending" });
    assert.equal(pending.length, 3);
  });

  it("acks a message, verifies status and owner", async () => {
    const msg = await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      from: "planner",
      to: "executor",
      content: "# Plan",
    });

    const acked = await ackInboxMessage(tmpDir, "test-proj", msg.id, { owner: "executor" });
    assert.ok(acked);
    assert.equal(acked.status, "acknowledged");
    assert.equal(acked.owner, "executor");

    const full = await readInboxMessage(tmpDir, "test-proj", msg.id);
    assert.equal(full.status, "acknowledged");
    assert.equal(full.owner, "executor");
  });

  it("completes a message, verifies status changed", async () => {
    const msg = await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      from: "planner",
      to: "executor",
      content: "# Plan",
    });

    await ackInboxMessage(tmpDir, "test-proj", msg.id, { owner: "executor" });
    const completed = await completeInboxMessage(tmpDir, "test-proj", msg.id);

    assert.ok(completed);
    assert.equal(completed.status, "completed");

    const full = await readInboxMessage(tmpDir, "test-proj", msg.id);
    assert.equal(full.status, "completed");
  });

  it("writes two messages, list returns both in creation order", async () => {
    const first = await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      from: "planner",
      to: "executor",
      content: "# First",
    });
    const second = await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      from: "planner",
      to: "executor",
      content: "# Second",
    });

    const all = await listInboxMessages(tmpDir, "test-proj");
    assert.equal(all.length, 2);
    assert.equal(all[0].id, first.id);
    assert.equal(all[1].id, second.id);
  });

  it("reads non-existent message returns null", async () => {
    const result = await readInboxMessage(tmpDir, "test-proj", "msg-nonexistent");
    assert.equal(result, null);
  });

  it("lists with non-matching filter returns empty", async () => {
    await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      from: "planner",
      to: "executor",
      content: "# Plan",
    });

    const results = await listInboxMessages(tmpDir, "test-proj", { type: "notify" });
    assert.equal(results.length, 0);
  });

  it("rejects invalid transition: pending -> completed", async () => {
    const msg = await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      from: "planner",
      to: "executor",
      content: "# Plan",
    });

    await assert.rejects(
      () => completeInboxMessage(tmpDir, "test-proj", msg.id),
      { message: /invalid transition/ },
    );
  });

  it("rejects double ack", async () => {
    const msg = await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      from: "planner",
      to: "executor",
      content: "# Plan",
    });

    await ackInboxMessage(tmpDir, "test-proj", msg.id, { owner: "executor" });

    await assert.rejects(
      () => ackInboxMessage(tmpDir, "test-proj", msg.id, { owner: "other" }),
      { message: /invalid transition/ },
    );
  });

  it("ack on non-existent message returns null", async () => {
    const result = await ackInboxMessage(tmpDir, "test-proj", "msg-nope", { owner: "x" });
    assert.equal(result, null);
  });

  it("complete on non-existent message returns null", async () => {
    const result = await completeInboxMessage(tmpDir, "test-proj", "msg-nope");
    assert.equal(result, null);
  });

  it("filters by jobId", async () => {
    await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      jobId: "job-001",
      from: "planner",
      to: "executor",
      content: "# Plan A",
    });
    await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      jobId: "job-002",
      from: "planner",
      to: "executor",
      content: "# Plan B",
    });

    const filtered = await listInboxMessages(tmpDir, "test-proj", { jobId: "job-001" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].jobId, "job-001");
  });

  it("list on non-existent project returns empty", async () => {
    const results = await listInboxMessages(tmpDir, "no-such-proj");
    assert.equal(results.length, 0);
  });

  it("rejects path traversal in message id", async () => {
    const result = await readInboxMessage(tmpDir, "test-proj", "../secret");
    assert.equal(result, null);
    const ackResult = await ackInboxMessage(tmpDir, "test-proj", "../secret", { owner: "x" });
    assert.equal(ackResult, null);
    const completeResult = await completeInboxMessage(tmpDir, "test-proj", "../../../etc/passwd");
    assert.equal(completeResult, null);
  });

  it("locator frontmatter round-trips correctly", async () => {
    const msg = await writeInboxMessage(tmpDir, "test-proj", {
      type: "plan",
      from: "planner",
      to: "executor",
      jobId: "job-123",
      locator: { eventLogPath: "/abs/path/events/job-123.jsonl", wikiPath: "/abs/wiki" },
      content: "# Plan",
    });

    const read = await readInboxMessage(tmpDir, "test-proj", msg.id);
    assert.deepEqual(read.locator, { eventLogPath: "/abs/path/events/job-123.jsonl", wikiPath: "/abs/wiki" });
  });
});
