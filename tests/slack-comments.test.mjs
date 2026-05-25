import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("Slack terminal status comments", () => {
  it("posts a terminal Slack status once and records an audit event", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-slack-comment-"));
    try {
      const { createJob, completeJob } = await import("../server/services/job-store.js");
      const { readEvents } = await import("../server/services/event-store.js");
      const { postSlackStatusComment } = await import("../server/services/slack-comments.js");

      const job = await createJob(cpbRoot, {
        project: "frontend",
        task: "Fix login redirect",
        workflow: "standard",
        sourceContext: {
          type: "slack",
          channel: "slack",
          channelId: "C123",
          channelName: "triage",
        },
      });
      const completed = await completeJob(cpbRoot, "frontend", job.jobId);
      const posts = [];

      const first = await postSlackStatusComment({
        cpbRoot,
        project: "frontend",
        job: completed,
        postMessage: async (request) => {
          posts.push(request);
          return { ok: true, channel: request.channel, ts: "123.456" };
        },
      });
      const second = await postSlackStatusComment({
        cpbRoot,
        project: "frontend",
        job: completed,
        postMessage: async (request) => {
          posts.push(request);
          return { ok: true, channel: request.channel, ts: "123.789" };
        },
      });

      assert.equal(first.status, "posted");
      assert.equal(second.status, "duplicate");
      assert.equal(posts.length, 1);
      assert.equal(posts[0].channel, "C123");
      assert.match(posts[0].text, /Verified patch ready/);
      assert.match(posts[0].text, new RegExp(job.jobId));

      const events = await readEvents(cpbRoot, "frontend", job.jobId);
      const posted = events.filter((event) => event.type === "slack_message_posted");
      assert.equal(posted.length, 1);
      assert.equal(posted[0].messageKind, "terminal-status");
      assert.equal(posted[0].channel, "C123");
      assert.ok(posted[0].bodyHash);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("queue workers notify Slack-linked jobs on terminal status", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-slack-worker-"));
    try {
      const { createJob, completeJob } = await import("../server/services/job-store.js");
      const { ProjectWorker } = await import("../runtime/worker/project-worker.js");

      const job = await createJob(cpbRoot, {
        project: "frontend",
        task: "Fix checkout",
        workflow: "standard",
        sourceContext: {
          type: "slack",
          channel: "slack",
          channelId: "C999",
        },
      });
      await completeJob(cpbRoot, "frontend", job.jobId);

      const notifications = [];
      const worker = new ProjectWorker({
        cpbRoot,
        hubRoot: path.join(cpbRoot, "hub"),
        projectId: "frontend",
        slackNotifierFn: async (request) => {
          notifications.push(request);
          return { status: "posted" };
        },
      });

      const result = await worker.notifyTerminalStatus(
        { projectId: "frontend" },
        { ok: true, jobId: job.jobId },
      );

      assert.equal(result.status, "posted");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].project, "frontend");
      assert.equal(notifications[0].job.jobId, job.jobId);
      assert.equal(notifications[0].job.sourceContext.channelId, "C999");
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});
