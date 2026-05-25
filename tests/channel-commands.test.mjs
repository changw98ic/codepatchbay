import { createHmac, generateKeyPairSync, sign as signMessage } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { channelRoutes } from "../server/routes/channels.js";
import { createChannelQueueJob, listCandidates } from "../server/services/event-source.js";
import { listQueue } from "../server/services/hub-queue.js";
import { createJob, failJob, FAILURE_CODES, getJob } from "../server/services/job-store.js";
import { readEvents } from "../server/services/event-store.js";
import { CHANNEL_COMMAND_HELP, parseChannelCommand } from "../server/services/channel-commands.js";
import {
  parseSlackInteractiveAction,
  parseSlackSlashCommand,
  verifySlackSignature,
} from "../server/services/channel-slack.js";
import {
  parseDiscordInteraction,
  verifyDiscordSignature,
} from "../server/services/channel-discord.js";
import {
  readChannelPolicyEvents,
} from "../server/services/channel-policy.js";

const DISCORD_VECTOR = {
  publicKey: "3e9ec34321874728d02aa46b151aa62c6f4aa179202b1b2e4e09830b1acdca70",
  timestamp: "1779638400",
  body: "{\"type\":2,\"data\":{\"name\":\"cpb\",\"options\":[{\"name\":\"command\",\"value\":\"run frontend \\\"fix login redirect\\\"\"}]},\"member\":{\"user\":{\"id\":\"U123\",\"username\":\"alice\"}},\"channel_id\":\"C123\",\"guild_id\":\"G123\"}",
  signature: "82d7c04d95ec4ae968772dc3e76bf526e4f35134ff88b39694f1ea22ac49b635166a6be71c02ea0e1edf360a880ba6d965423cfcf5b91aab6939dc7e5d29d005",
};
const DISCORD_TOKEN_VECTOR = {
  publicKey: "dfbcf64bb7b725208a4452f8e5ea980716a3c630fef1ce40372b812ca9fd30ef",
  timestamp: "1779638401",
  body: "{\"type\":2,\"token\":\"discord-token-secret\",\"data\":{\"name\":\"cpb\",\"options\":[{\"name\":\"command\",\"value\":\"run frontend \\\"fix login redirect\\\"\"}]},\"member\":{\"user\":{\"id\":\"U123\",\"username\":\"alice\"}},\"channel_id\":\"C123\",\"guild_id\":\"G123\"}",
  signature: "53114e5fac056b39983e2d5f22c607f152b6ebaee807c32fc5f74773407c0ca4ede78d47bfb17ecfc2e0efa410ad494c8e3c3311c588f2e5d9bf66831eb50d08",
};

function createDiscordSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyHex = Buffer.from(publicDer).subarray(-32).toString("hex");
  return {
    publicKey: publicKeyHex,
    command(commandText, extra = {}) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        type: 2,
        data: {
          name: "cpb",
          options: [{ name: "command", value: commandText }],
        },
        member: { user: { id: "U456", username: "bob" } },
        channel_id: "C456",
        guild_id: "G456",
        ...extra,
      });
      const signature = signMessage(null, Buffer.from(`${timestamp}${body}`, "utf8"), privateKey).toString("hex");
      return { body, timestamp, signature };
    },
  };
}

function slackSignature(secret, timestamp, rawBody) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

function slackBody(params) {
  return new URLSearchParams(params).toString();
}

async function buildChannelApp(cpbRoot, routeOptions = {}) {
  const app = Fastify({ logger: false });
  const hubRoot = routeOptions.hubRoot || cpbRoot;
  app.addHook("onRequest", (req, _reply, done) => {
    req.cpbRoot = cpbRoot;
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(channelRoutes, { prefix: "/api", ...routeOptions });
  return app;
}

function assertCommandShape(command) {
  for (const field of ["project", "job", "issue", "task", "workflow", "planMode", "triage"]) {
    assert.ok(Object.hasOwn(command, field), `missing ${field}`);
  }
}

describe("channel command parser", () => {
  it("parses run commands with project, workflow, and quoted task text", () => {
    const command = parseChannelCommand('/cpb run frontend --workflow strict "fix login redirect"');

    assert.equal(command.ok, true);
    assert.equal(command.type, "run");
    assert.equal(command.project, "frontend");
    assert.equal(command.job, null);
    assert.equal(command.issue, null);
    assert.equal(command.task, "fix login redirect");
    assert.equal(command.workflow, "strict");
    assert.equal(command.planMode, null);
    assert.equal(command.triage, null);
    assertCommandShape(command);
  });

  it("parses requested routing options without making them effective yet", () => {
    const command = parseChannelCommand('/cpb run frontend --workflow direct --plan-mode none --triage rules "fix auth token docs"');

    assert.equal(command.ok, true);
    assert.equal(command.workflow, "direct");
    assert.equal(command.planMode, "none");
    assert.equal(command.triage, "rules");
    assert.equal(command.task, "fix auth token docs");
  });

  it("parses issue, status, approve, cancel, retry, and logs commands into typed payloads", () => {
    const issue = parseChannelCommand("/cpb issue frontend 123");
    const status = parseChannelCommand("/cpb status job-20260524-153011-a13f9c");
    const approve = parseChannelCommand("/cpb approve job-20260524-153011-a13f9c");
    const cancel = parseChannelCommand("/cpb cancel job-20260524-153011-a13f9c");
    const retry = parseChannelCommand("/cpb retry job-20260524-153011-a13f9c");
    const logs = parseChannelCommand("/cpb logs job-20260524-153011-a13f9c");

    assert.deepEqual(issue, {
      ok: true,
      type: "issue",
      command: "issue",
      project: "frontend",
      job: null,
      issue: 123,
      task: null,
      workflow: "standard",
      planMode: null,
      triage: null,
      workflowRequested: false,
      planModeRequested: false,
      triageRequested: false,
    });
    assert.equal(status.type, "status");
    assert.equal(status.job, "job-20260524-153011-a13f9c");
    assert.equal(status.project, null);
    assert.equal(status.workflow, null);
    assertCommandShape(status);
    assert.equal(approve.type, "approve");
    assert.equal(approve.job, "job-20260524-153011-a13f9c");
    assertCommandShape(approve);
    assert.equal(cancel.type, "cancel");
    assert.equal(cancel.job, "job-20260524-153011-a13f9c");
    assertCommandShape(cancel);
    assert.equal(retry.type, "retry");
    assert.equal(retry.job, "job-20260524-153011-a13f9c");
    assertCommandShape(retry);
    assert.equal(logs.type, "logs");
    assert.equal(logs.job, "job-20260524-153011-a13f9c");
    assertCommandShape(logs);
  });

  it("rejects secret-like channel input with the shared secret policy", () => {
    const command = parseChannelCommand("/cpb run frontend OPENAI_API_KEY=sk-test-secret-value");

    assert.equal(command.ok, false);
    assert.equal(command.code, "SECRET_INPUT_REJECTED");
    assert.match(command.guidance, /Do not paste API keys/i);
    assert.equal(command.detection.pattern, "credential_assignment");
    assert.doesNotMatch(JSON.stringify(command), /sk-test-secret-value/);
  });

  it("returns help text for unknown or malformed cpb commands", () => {
    const unknown = parseChannelCommand("/cpb dance frontend");
    const malformed = parseChannelCommand("/cpb run frontend");

    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, "UNKNOWN_COMMAND");
    assert.equal(unknown.help, CHANNEL_COMMAND_HELP);
    assert.match(unknown.help, /\/cpb run <project> <task>/);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.code, "INVALID_COMMAND");
    assert.match(malformed.help, /\/cpb issue <project> <number>/);
  });
});

describe("Slack channel command skeleton", () => {
  it("verifies Slack request signatures against the raw form body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "command=%2Fcpb&text=run+frontend+fix+login";
    const valid = slackSignature("slack-signing-secret", timestamp, rawBody);

    assert.equal(verifySlackSignature({
      signingSecret: "slack-signing-secret",
      timestamp,
      signature: valid,
      rawBody,
    }).ok, true);

    const invalid = verifySlackSignature({
      signingSecret: "slack-signing-secret",
      timestamp,
      signature: slackSignature("wrong-secret", timestamp, rawBody),
      rawBody,
    });
    assert.equal(invalid.ok, false);
    assert.match(invalid.reason, /signature/i);
  });

  it("maps Slack slash-command payloads through the shared parser", () => {
    const result = parseSlackSlashCommand({
      command: "/cpb",
      text: 'run frontend --workflow strict "fix login redirect"',
      user_id: "U123",
      channel_id: "C123",
      team_id: "T123",
    });

    assert.equal(result.ok, true);
    assert.equal(result.channel, "slack");
    assert.equal(result.actor.userId, "U123");
    assert.equal(result.command.type, "run");
    assert.equal(result.command.project, "frontend");
    assert.equal(result.command.task, "fix login redirect");
    assert.equal(result.command.workflow, "strict");
  });

  it("exposes a signed dry-run slash-command endpoint and rejects invalid signatures", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-slack-route-"));
    const app = await buildChannelApp(cpbRoot, {
      slackSigningSecret: "slack-signing-secret",
      slackDryRun: true,
    });
    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = "command=%2Fcpb&text=status+job-20260524-153011-a13f9c&user_id=U123&channel_id=C123&team_id=T123";
      const valid = await app.inject({
        method: "POST",
        url: "/api/channels/slack/commands",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("slack-signing-secret", timestamp, rawBody),
        },
        payload: rawBody,
      });
      const invalid = await app.inject({
        method: "POST",
        url: "/api/channels/slack/commands",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("wrong-secret", timestamp, rawBody),
        },
        payload: rawBody,
      });

      assert.equal(valid.statusCode, 200);
      const parsed = JSON.parse(valid.body);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.dryRun, true);
      assert.equal(parsed.parsed.command.type, "status");
      assert.equal(parsed.parsed.command.job, "job-20260524-153011-a13f9c");
      assert.equal(invalid.statusCode, 401);
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("creates a candidate and Hub Queue entry for signed Slack run commands without pre-creating a job", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-slack-run-"));
    const hubRoot = path.join(cpbRoot, "hub");
    const app = await buildChannelApp(cpbRoot, {
      slackSigningSecret: "slack-signing-secret",
      hubRoot,
    });
    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = slackBody({
        command: "/cpb",
        text: 'run frontend --workflow strict "fix login redirect"',
        user_id: "U123",
        channel_id: "C123",
        team_id: "T123",
        trigger_id: "trigger-run-1",
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/channels/slack/commands",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("slack-signing-secret", timestamp, rawBody),
        },
        payload: rawBody,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, true);
      assert.equal(body.action, "queued");
      assert.equal(body.job, null);
      assert.match(body.queueEntry.id, /^q-/);
      assert.equal(body.queueEntry.status, "pending");
      assert.equal(body.queueEntry.projectId, "frontend");
      assert.equal(body.queueEntry.description, "fix login redirect");
      assert.equal(body.queueEntry.metadata.source, "slack");
      assert.equal(body.queueEntry.metadata.workflow, "strict");
      assert.equal(body.candidateEntry.source, "slack");
      assert.equal(body.actions.cancel.command, `/cpb cancel ${body.queueEntry.id}`);

      const candidates = await listCandidates(cpbRoot, { source: "slack" });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, "queued");
      assert.equal(candidates[0].payload.task, "fix login redirect");

      const queued = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(queued.length, 1);
      assert.equal(queued[0].id, body.queueEntry.id);
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("supports Slack status and cancel for queued q-id entries before a job exists", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-slack-queue-actions-"));
    const hubRoot = path.join(cpbRoot, "hub");
    const app = await buildChannelApp(cpbRoot, {
      slackSigningSecret: "slack-signing-secret",
      hubRoot,
    });
    try {
      async function slackCommand(text) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const rawBody = slackBody({
          command: "/cpb",
          text,
          user_id: "U123",
          user_name: "alice",
          channel_id: "C123",
          team_id: "T123",
        });
        return app.inject({
          method: "POST",
          url: "/api/channels/slack/commands",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": slackSignature("slack-signing-secret", timestamp, rawBody),
          },
          payload: rawBody,
        });
      }

      const queued = JSON.parse((await slackCommand('run frontend "fix login redirect"')).body);
      const queueId = queued.queueEntry.id;

      const status = await slackCommand(`status ${queueId}`);
      assert.equal(status.statusCode, 200);
      const statusBody = JSON.parse(status.body);
      assert.equal(statusBody.ok, true);
      assert.equal(statusBody.action, "status");
      assert.equal(statusBody.status.queueEntryId, queueId);
      assert.equal(statusBody.status.project, "frontend");
      assert.equal(statusBody.status.status, "pending");
      assert.equal(statusBody.actions.cancel.command, `/cpb cancel ${queueId}`);

      const cancel = await slackCommand(`cancel ${queueId}`);
      assert.equal(cancel.statusCode, 200);
      const cancelBody = JSON.parse(cancel.body);
      assert.equal(cancelBody.ok, true);
      assert.equal(cancelBody.action, "cancelled");
      assert.equal(cancelBody.queueEntry.id, queueId);
      assert.equal(cancelBody.queueEntry.status, "cancelled");

      const entries = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, "cancelled");
      assert.match(entries[0].metadata.cancelReason, /Slack/);
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("supports Slack retry for cancelled queued q-id entries before a job exists", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-slack-queue-retry-"));
    const hubRoot = path.join(cpbRoot, "hub");
    const app = await buildChannelApp(cpbRoot, {
      slackSigningSecret: "slack-signing-secret",
      hubRoot,
    });
    try {
      async function slackCommand(text) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const rawBody = slackBody({
          command: "/cpb",
          text,
          user_id: "U123",
          user_name: "alice",
          channel_id: "C123",
          team_id: "T123",
        });
        return app.inject({
          method: "POST",
          url: "/api/channels/slack/commands",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": slackSignature("slack-signing-secret", timestamp, rawBody),
          },
          payload: rawBody,
        });
      }

      const queued = JSON.parse((await slackCommand('run frontend "fix login redirect"')).body);
      const queueId = queued.queueEntry.id;
      await slackCommand(`cancel ${queueId}`);

      const retry = await slackCommand(`retry ${queueId}`);
      assert.equal(retry.statusCode, 200);
      const retryBody = JSON.parse(retry.body);
      assert.equal(retryBody.ok, true);
      assert.equal(retryBody.action, "retried");
      assert.equal(retryBody.queueEntry.id, queueId);
      assert.equal(retryBody.queueEntry.status, "pending");
      assert.equal(retryBody.status.status, "pending");
      assert.equal(retryBody.actions.cancel.command, `/cpb cancel ${queueId}`);

      const entries = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, "pending");
      assert.equal(entries[0].metadata.retryReason, "Retried from Slack by U123");
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("lets the project worker claim channel-created Hub Queue entries before any job exists", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-channel-worker-"));
    const hubRoot = path.join(cpbRoot, "hub");
    const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-channel-source-"));
    try {
      const result = await createChannelQueueJob(
        cpbRoot,
        { type: "run", project: "frontend", task: "fix login redirect", workflow: "strict" },
        {
          channel: "slack",
          actor: "U123",
          channelId: "C123",
          commandText: "/cpb run frontend --workflow strict \"fix login redirect\"",
        },
        { hubRoot, sourcePath },
      );
      assert.equal(result.job, null);

      const { ProjectWorker } = await import("../runtime/worker/project-worker.js");
      let captured = null;
      const worker = new ProjectWorker({
        cpbRoot,
        hubRoot,
        pool: true,
        once: true,
        workerId: "worker-channel-test",
        agentHealthFn: async () => ({ codex: true, claude: true, checks: {} }),
        getProjectFn: async () => null,
        runPipelineFn: async (entry, entrySourcePath, _dispatchId, projectId, worktree) => {
          captured = { entry, entrySourcePath, projectId, worktree };
          return { ok: true, job: null };
        },
      });

      const run = await worker.run();
      assert.equal(run.entry.id, result.queueEntry.id);
      assert.equal(captured.projectId, "frontend");
      assert.equal(captured.entry.description, "fix login redirect");
      assert.equal(captured.entry.metadata.workflow, "strict");
      assert.equal(captured.entrySourcePath, sourcePath);
      assert.equal(captured.worktree.useWorktree, true);

      const queued = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(queued[0].status, "completed");
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
      await rm(sourcePath, { recursive: true, force: true });
    }
  });

  it("returns a job projection for signed Slack status commands with action metadata", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-slack-status-"));
    const app = await buildChannelApp(cpbRoot, {
      slackSigningSecret: "slack-signing-secret",
    });
    try {
      const job = await createJob(cpbRoot, {
        project: "frontend",
        task: "Fix login redirect",
        workflow: "standard",
        jobId: "job-20260524-153011-a13f9c",
        sourceContext: { type: "slack", channelId: "C123", actor: "U123" },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = slackBody({
        command: "/cpb",
        text: `status ${job.jobId}`,
        user_id: "U123",
        channel_id: "C123",
        team_id: "T123",
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/channels/slack/commands",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("slack-signing-secret", timestamp, rawBody),
        },
        payload: rawBody,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, true);
      assert.equal(body.action, "status");
      assert.equal(body.status.jobId, job.jobId);
      assert.equal(body.status.project, "frontend");
      assert.equal(body.status.status, "running");
      assert.equal(body.actions.viewRun.label, "View Run");
      assert.equal(body.actions.cancel.command, `/cpb cancel ${job.jobId}`);
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("maps Slack interactive button payloads to job actions", () => {
    const parsed = parseSlackInteractiveAction({
      type: "block_actions",
      user: { id: "U123", username: "alice" },
      team: { id: "T123" },
      channel: { id: "C123" },
      actions: [
        {
          action_id: "cpb:retry",
          value: JSON.stringify({ action: "retry", job: "job-20260524-153011-a13f9c" }),
        },
      ],
    });

    assert.equal(parsed.ok, true);
    assert.equal(parsed.channel, "slack");
    assert.equal(parsed.actor.userId, "U123");
    assert.equal(parsed.action.type, "retry");
    assert.equal(parsed.action.job, "job-20260524-153011-a13f9c");
  });

  it("records approval actors and uses the existing cancel path for signed Slack actions", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-slack-actions-"));
    const app = await buildChannelApp(cpbRoot, {
      slackSigningSecret: "slack-signing-secret",
    });
    try {
      const approvedJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Approve plan",
        workflow: "strict",
        jobId: "job-approve-action",
      });
      const cancelledJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Cancel run",
        workflow: "standard",
        jobId: "job-cancel-action",
      });

      const approvePayload = {
        type: "block_actions",
        user: { id: "U123", username: "alice" },
        team: { id: "T123" },
        channel: { id: "C123" },
        actions: [{ action_id: "cpb:approve", value: approvedJob.jobId }],
      };
      const cancelPayload = {
        type: "block_actions",
        user: { id: "U456", username: "bob" },
        team: { id: "T123" },
        channel: { id: "C123" },
        actions: [{ action_id: "cpb:cancel", value: cancelledJob.jobId }],
      };

      const timestamp = String(Math.floor(Date.now() / 1000));
      const approveBody = slackBody({ payload: JSON.stringify(approvePayload) });
      const cancelBody = slackBody({ payload: JSON.stringify(cancelPayload) });
      const approve = await app.inject({
        method: "POST",
        url: "/api/channels/slack/actions",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("slack-signing-secret", timestamp, approveBody),
        },
        payload: approveBody,
      });
      const cancel = await app.inject({
        method: "POST",
        url: "/api/channels/slack/actions",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("slack-signing-secret", timestamp, cancelBody),
        },
        payload: cancelBody,
      });

      assert.equal(approve.statusCode, 200);
      const approveResult = JSON.parse(approve.body);
      assert.equal(approveResult.ok, true);
      assert.equal(approveResult.action, "approved");
      assert.equal(approveResult.actor.userId, "U123");
      assert.match(approveResult.approvedAt, /^\d{4}-\d{2}-\d{2}T/);

      const approvalEvents = (await readEvents(cpbRoot, "frontend", approvedJob.jobId))
        .filter((event) => event.type === "job_approved");
      assert.equal(approvalEvents.length, 1);
      assert.equal(approvalEvents[0].actor.userId, "U123");
      assert.match(approvalEvents[0].ts, /^\d{4}-\d{2}-\d{2}T/);

      assert.equal(cancel.statusCode, 200);
      const cancelResult = JSON.parse(cancel.body);
      assert.equal(cancelResult.ok, true);
      assert.equal(cancelResult.action, "cancelled");
      const cancelled = await getJob(cpbRoot, "frontend", cancelledJob.jobId);
      assert.equal(cancelled.status, "cancelled");
      assert.match(cancelled.cancelReason, /Slack/);
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("retries failed jobs from signed Slack retry actions", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-slack-retry-"));
    const app = await buildChannelApp(cpbRoot, {
      slackSigningSecret: "slack-signing-secret",
    });
    try {
      const failed = await createJob(cpbRoot, {
        project: "frontend",
        task: "Retry run",
        workflow: "standard",
        jobId: "job-retry-action",
      });
      await failJob(cpbRoot, "frontend", failed.jobId, {
        reason: "verifier failed",
        code: FAILURE_CODES.RECOVERABLE,
        phase: "execute",
        retryable: true,
      });

      const payload = {
        type: "block_actions",
        user: { id: "U123", username: "alice" },
        team: { id: "T123" },
        channel: { id: "C123" },
        actions: [
          {
            action_id: "cpb:retry",
            value: JSON.stringify({ action: "retry", job: failed.jobId }),
          },
        ],
      };
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = slackBody({ payload: JSON.stringify(payload) });
      const response = await app.inject({
        method: "POST",
        url: "/api/channels/slack/actions",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("slack-signing-secret", timestamp, rawBody),
        },
        payload: rawBody,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, true);
      assert.equal(body.action, "retried");
      assert.equal(body.recoveryOf, failed.jobId);
      assert.notEqual(body.job.jobId, failed.jobId);
      assert.equal(body.actions.viewRun.label, "View Run");

      const recovery = await getJob(cpbRoot, "frontend", body.job.jobId);
      assert.equal(recovery.recoveryOf, failed.jobId);
      assert.equal(recovery.sourceContext, null);
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("wires Slack slash issue, approve, cancel, retry, and logs commands", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-slack-expanded-"));
    const app = await buildChannelApp(cpbRoot, {
      slackSigningSecret: "slack-signing-secret",
    });
    try {
      const approveJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Approve slash",
        workflow: "standard",
        jobId: "job-slash-approve",
      });
      const cancelJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Cancel slash",
        workflow: "standard",
        jobId: "job-slash-cancel",
      });
      const retryJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Retry slash",
        workflow: "standard",
        jobId: "job-slash-retry",
      });
      await failJob(cpbRoot, "frontend", retryJob.jobId, {
        reason: "recoverable",
        code: FAILURE_CODES.RECOVERABLE,
        phase: "execute",
        retryable: true,
      });

      async function slackCommand(text) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const rawBody = slackBody({
          command: "/cpb",
          text,
          user_id: "U123",
          user_name: "alice",
          channel_id: "C123",
          team_id: "T123",
        });
        return app.inject({
          method: "POST",
          url: "/api/channels/slack/commands",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": slackSignature("slack-signing-secret", timestamp, rawBody),
          },
          payload: rawBody,
        });
      }

      const issue = await slackCommand("issue frontend 42");
      const approve = await slackCommand(`approve ${approveJob.jobId}`);
      const cancel = await slackCommand(`cancel ${cancelJob.jobId}`);
      const retry = await slackCommand(`retry ${retryJob.jobId}`);
      const logs = await slackCommand(`logs ${approveJob.jobId}`);

      assert.equal(issue.statusCode, 200);
      const issueBody = JSON.parse(issue.body);
      assert.equal(issueBody.ok, true);
      assert.equal(issueBody.action, "queued");
      assert.equal(issueBody.job, null);
      assert.equal(issueBody.queueEntry.projectId, "frontend");
      assert.equal(issueBody.queueEntry.description, "GitHub issue #42");
      assert.equal(issueBody.queueEntry.metadata.issueNumber, 42);
      assert.equal(issueBody.candidateEntry.payload.issueNumber, 42);

      assert.equal(approve.statusCode, 200);
      assert.equal(JSON.parse(approve.body).action, "approved");
      const approvalEvents = (await readEvents(cpbRoot, "frontend", approveJob.jobId))
        .filter((event) => event.type === "job_approved");
      assert.equal(approvalEvents.length, 1);
      assert.equal(approvalEvents[0].actor.userId, "U123");

      assert.equal(cancel.statusCode, 200);
      assert.equal((await getJob(cpbRoot, "frontend", cancelJob.jobId)).status, "cancelled");

      assert.equal(retry.statusCode, 200);
      const retryBody = JSON.parse(retry.body);
      assert.equal(retryBody.action, "retried");
      assert.notEqual(retryBody.job.jobId, retryJob.jobId);

      assert.equal(logs.statusCode, 200);
      const logsBody = JSON.parse(logs.body);
      assert.equal(logsBody.action, "logs");
      assert.equal(logsBody.events.length >= 1, true);
      assert.equal(logsBody.events[0].type, "job_created");
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("Discord channel command skeleton", () => {
  it("verifies Discord Ed25519 signatures against a fixed request vector", () => {
    const valid = verifyDiscordSignature({
      publicKey: DISCORD_VECTOR.publicKey,
      timestamp: DISCORD_VECTOR.timestamp,
      signature: DISCORD_VECTOR.signature,
      rawBody: DISCORD_VECTOR.body,
    });
    const invalid = verifyDiscordSignature({
      publicKey: DISCORD_VECTOR.publicKey,
      timestamp: DISCORD_VECTOR.timestamp,
      signature: "00".repeat(64),
      rawBody: DISCORD_VECTOR.body,
    });

    assert.equal(valid.ok, true);
    assert.equal(invalid.ok, false);
    assert.match(invalid.reason, /signature/i);
  });

  it("maps Discord run and status interactions through the shared parser", () => {
    const run = parseDiscordInteraction(JSON.parse(DISCORD_VECTOR.body));
    const status = parseDiscordInteraction({
      type: 2,
      data: {
        name: "cpb",
        options: [{ name: "command", value: "status job-20260524-153011-a13f9c" }],
      },
      user: { id: "U456", username: "bob" },
      channel_id: "C456",
      guild_id: "G456",
    });

    assert.equal(run.ok, true);
    assert.equal(run.channel, "discord");
    assert.equal(run.actor.userId, "U123");
    assert.equal(run.command.type, "run");
    assert.equal(run.command.project, "frontend");
    assert.equal(run.command.task, "fix login redirect");
    assert.equal(status.command.type, "status");
    assert.equal(status.command.job, "job-20260524-153011-a13f9c");
  });

  it("exposes a signed dry-run interaction endpoint without storing Discord tokens", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-discord-route-"));
    const app = await buildChannelApp(cpbRoot, {
      discordPublicKey: DISCORD_TOKEN_VECTOR.publicKey,
      discordDryRun: true,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/channels/discord/interactions",
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": DISCORD_TOKEN_VECTOR.signature,
          "x-signature-timestamp": DISCORD_TOKEN_VECTOR.timestamp,
        },
        payload: DISCORD_TOKEN_VECTOR.body,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, true);
      assert.equal(body.dryRun, true);
      assert.equal(body.parsed.command.type, "run");
      assert.doesNotMatch(response.body, /discord-token-secret/);
      assert.deepEqual(await readdir(cpbRoot), []);
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("queues signed Discord run interactions through the shared channel queue", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-discord-queue-"));
    const app = await buildChannelApp(cpbRoot, {
      discordPublicKey: DISCORD_VECTOR.publicKey,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/channels/discord/interactions",
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": DISCORD_VECTOR.signature,
          "x-signature-timestamp": DISCORD_VECTOR.timestamp,
        },
        payload: DISCORD_VECTOR.body,
      });

      assert.equal(response.statusCode, 202);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, true);
      assert.equal(body.channel, "discord");
      assert.equal(body.action, "queued");
      assert.equal(body.job, null);
      assert.equal(body.queueEntry.projectId, "frontend");
      assert.match(body.queueEntry.id, /^q-/);

      const candidates = await listCandidates(cpbRoot, { source: "discord" });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, "queued");
      assert.equal(candidates[0].payload.task, "fix login redirect");
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("supports Discord status, cancel, and retry for queued q-id entries before a job exists", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-discord-queue-actions-"));
    const hubRoot = path.join(cpbRoot, "hub");
    const signer = createDiscordSigner();
    const app = await buildChannelApp(cpbRoot, {
      discordPublicKey: signer.publicKey,
      hubRoot,
    });
    try {
      async function discordCommand(text) {
        const signed = signer.command(text);
        return app.inject({
          method: "POST",
          url: "/api/channels/discord/interactions",
          headers: {
            "content-type": "application/json",
            "x-signature-ed25519": signed.signature,
            "x-signature-timestamp": signed.timestamp,
          },
          payload: signed.body,
        });
      }

      const queued = JSON.parse((await discordCommand('run frontend "fix login redirect"')).body);
      const queueId = queued.queueEntry.id;

      const status = await discordCommand(`status ${queueId}`);
      assert.equal(status.statusCode, 200);
      const statusBody = JSON.parse(status.body);
      assert.equal(statusBody.ok, true);
      assert.equal(statusBody.action, "status");
      assert.equal(statusBody.status.queueEntryId, queueId);
      assert.equal(statusBody.status.status, "pending");

      const cancel = await discordCommand(`cancel ${queueId}`);
      assert.equal(cancel.statusCode, 200);
      const cancelBody = JSON.parse(cancel.body);
      assert.equal(cancelBody.ok, true);
      assert.equal(cancelBody.action, "cancelled");
      assert.equal(cancelBody.queueEntry.status, "cancelled");
      assert.match(cancelBody.queueEntry.metadata.cancelReason, /Discord/);

      const retry = await discordCommand(`retry ${queueId}`);
      assert.equal(retry.statusCode, 200);
      const retryBody = JSON.parse(retry.body);
      assert.equal(retryBody.ok, true);
      assert.equal(retryBody.action, "retried");
      assert.equal(retryBody.queueEntry.status, "pending");
      assert.equal(retryBody.queueEntry.metadata.retryReason, "Retried from Discord by U456");

      const entries = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, "pending");
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("wires Discord approve, cancel, retry, and logs commands for jobs", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-discord-job-actions-"));
    const signer = createDiscordSigner();
    const app = await buildChannelApp(cpbRoot, {
      discordPublicKey: signer.publicKey,
    });
    try {
      const approveJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Approve discord",
        workflow: "standard",
        jobId: "job-discord-approve",
      });
      const cancelJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Cancel discord",
        workflow: "standard",
        jobId: "job-discord-cancel",
      });
      const retryJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Retry discord",
        workflow: "standard",
        jobId: "job-discord-retry",
      });
      await failJob(cpbRoot, "frontend", retryJob.jobId, {
        reason: "recoverable",
        code: FAILURE_CODES.RECOVERABLE,
        phase: "execute",
        retryable: true,
      });

      async function discordCommand(text) {
        const signed = signer.command(text);
        return app.inject({
          method: "POST",
          url: "/api/channels/discord/interactions",
          headers: {
            "content-type": "application/json",
            "x-signature-ed25519": signed.signature,
            "x-signature-timestamp": signed.timestamp,
          },
          payload: signed.body,
        });
      }

      const approve = await discordCommand(`approve ${approveJob.jobId}`);
      const cancel = await discordCommand(`cancel ${cancelJob.jobId}`);
      const retry = await discordCommand(`retry ${retryJob.jobId}`);
      const logs = await discordCommand(`logs ${approveJob.jobId}`);

      assert.equal(approve.statusCode, 200);
      assert.equal(JSON.parse(approve.body).action, "approved");
      const approvalEvents = (await readEvents(cpbRoot, "frontend", approveJob.jobId))
        .filter((event) => event.type === "job_approved");
      assert.equal(approvalEvents.length, 1);
      assert.equal(approvalEvents[0].actor.userId, "U456");

      assert.equal(cancel.statusCode, 200);
      assert.equal((await getJob(cpbRoot, "frontend", cancelJob.jobId)).status, "cancelled");

      assert.equal(retry.statusCode, 200);
      const retryBody = JSON.parse(retry.body);
      assert.equal(retryBody.action, "retried");
      assert.notEqual(retryBody.job.jobId, retryJob.jobId);
      assert.equal(retryBody.recoveryOf, retryJob.jobId);

      assert.equal(logs.statusCode, 200);
      const logsBody = JSON.parse(logs.body);
      assert.equal(logsBody.action, "logs");
      assert.equal(logsBody.events[0].type, "job_created");
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("Feishu and DingTalk unified channel queue", () => {
  it("queues Feishu /cpb run commands without spawning pipelines directly", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-feishu-queue-"));
    const app = await buildChannelApp(cpbRoot);
    try {
      await writeFile(path.join(cpbRoot, "channels.json"), JSON.stringify({
        channels: { feishu: { enabled: true, verificationToken: "feishu-token" } },
      }), "utf8");

      const response = await app.inject({
        method: "POST",
        url: "/api/channels/feishu",
        headers: { "content-type": "application/json" },
        payload: {
          token: "feishu-token",
          event: {
            message: {
              chat_id: "chat-1",
              sender: { id: "user-1" },
              content: JSON.stringify({ text: '/cpb run frontend "fix login redirect"' }),
            },
          },
        },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, true);
      assert.equal(body.channel, "feishu");
      assert.equal(body.action, "queued");
      assert.equal(body.job, null);
      assert.equal(body.queueEntry.projectId, "frontend");
      assert.equal(body.queueEntry.metadata.source, "feishu");

      const candidates = await listCandidates(cpbRoot, { source: "feishu" });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, "queued");
      assert.equal(candidates[0].payload.task, "fix login redirect");
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("queues DingTalk /cpb run commands through the shared parser and policy path", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-dingtalk-queue-"));
    const app = await buildChannelApp(cpbRoot, {
      channelPolicy: {
        default: "allow",
        rules: [{ effect: "allow", channel: "dingtalk", project: "frontend", actions: ["run"] }],
      },
    });
    try {
      await writeFile(path.join(cpbRoot, "channels.json"), JSON.stringify({
        channels: { dingtalk: { enabled: true, outgoingToken: "ding-token" } },
      }), "utf8");

      const response = await app.inject({
        method: "POST",
        url: "/api/channels/dingtalk",
        headers: {
          "content-type": "application/json",
          "x-dingtalk-signature": "ignored,ding-token",
        },
        payload: { text: { content: '/cpb run frontend "fix login redirect"' }, senderId: "user-1", conversationId: "chat-1" },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, true);
      assert.equal(body.channel, "dingtalk");
      assert.equal(body.action, "queued");
      assert.equal(body.job, null);
      assert.equal(body.queueEntry.projectId, "frontend");
      assert.equal(body.queueEntry.metadata.source, "dingtalk");

      const candidates = await listCandidates(cpbRoot, { source: "dingtalk" });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, "queued");
      assert.equal(candidates[0].payload.task, "fix login redirect");
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("channel permission policy", () => {
  const statusOnlyPolicy = {
    default: "deny",
    rules: [
      {
        effect: "allow",
        channel: "slack",
        project: "frontend",
        channelId: "C123",
        userId: "U123",
        actions: ["status"],
      },
    ],
  };

  it("denies unauthorized Slack run commands and audit logs the decision", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-channel-policy-run-"));
    const app = await buildChannelApp(cpbRoot, {
      slackSigningSecret: "slack-signing-secret",
      channelPolicy: statusOnlyPolicy,
    });
    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = slackBody({
        command: "/cpb",
        text: 'run frontend "fix login redirect"',
        user_id: "U123",
        channel_id: "C123",
        team_id: "T123",
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/channels/slack/commands",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("slack-signing-secret", timestamp, rawBody),
        },
        payload: rawBody,
      });

      assert.equal(response.statusCode, 403);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, false);
      assert.equal(body.code, "CHANNEL_POLICY_DENIED");
      assert.match(body.reason, /not allowed/i);

      const audit = await readChannelPolicyEvents(cpbRoot);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].allowed, false);
      assert.equal(audit[0].request.action, "run");
      assert.equal(audit[0].request.project, "frontend");
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("allows read-only Slack status while denying approve and cancel actions", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-channel-policy-status-"));
    const app = await buildChannelApp(cpbRoot, {
      slackSigningSecret: "slack-signing-secret",
      channelPolicy: statusOnlyPolicy,
    });
    try {
      const statusJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Status job",
        workflow: "standard",
        jobId: "job-policy-status",
      });
      const approveJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Approve job",
        workflow: "standard",
        jobId: "job-policy-approve",
      });
      const cancelJob = await createJob(cpbRoot, {
        project: "frontend",
        task: "Cancel job",
        workflow: "standard",
        jobId: "job-policy-cancel",
      });

      const timestamp = String(Math.floor(Date.now() / 1000));
      const statusBody = slackBody({
        command: "/cpb",
        text: `status ${statusJob.jobId}`,
        user_id: "U123",
        channel_id: "C123",
        team_id: "T123",
      });
      const approveBody = slackBody({
        payload: JSON.stringify({
          type: "block_actions",
          user: { id: "U123", username: "alice" },
          team: { id: "T123" },
          channel: { id: "C123" },
          actions: [{ action_id: "cpb:approve", value: approveJob.jobId }],
        }),
      });
      const cancelBody = slackBody({
        payload: JSON.stringify({
          type: "block_actions",
          user: { id: "U123", username: "alice" },
          team: { id: "T123" },
          channel: { id: "C123" },
          actions: [{ action_id: "cpb:cancel", value: cancelJob.jobId }],
        }),
      });

      const status = await app.inject({
        method: "POST",
        url: "/api/channels/slack/commands",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("slack-signing-secret", timestamp, statusBody),
        },
        payload: statusBody,
      });
      const approve = await app.inject({
        method: "POST",
        url: "/api/channels/slack/actions",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("slack-signing-secret", timestamp, approveBody),
        },
        payload: approveBody,
      });
      const cancel = await app.inject({
        method: "POST",
        url: "/api/channels/slack/actions",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature("slack-signing-secret", timestamp, cancelBody),
        },
        payload: cancelBody,
      });

      assert.equal(status.statusCode, 200);
      assert.equal(JSON.parse(status.body).status.jobId, statusJob.jobId);
      assert.equal(approve.statusCode, 403);
      assert.equal(JSON.parse(approve.body).code, "CHANNEL_POLICY_DENIED");
      assert.equal(cancel.statusCode, 403);
      assert.equal(JSON.parse(cancel.body).code, "CHANNEL_POLICY_DENIED");
      assert.equal((await getJob(cpbRoot, "frontend", cancelJob.jobId)).status, "running");

      const audit = await readChannelPolicyEvents(cpbRoot);
      assert.deepEqual(audit.map((event) => [event.request.action, event.allowed]), [
        ["status", true],
        ["approve", false],
        ["cancel", false],
      ]);
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("denies unauthorized Discord run interactions and audit logs the decision", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-channel-policy-discord-"));
    const app = await buildChannelApp(cpbRoot, {
      discordPublicKey: DISCORD_VECTOR.publicKey,
      discordDryRun: true,
      channelPolicy: {
        default: "deny",
        rules: [
          {
            effect: "allow",
            channel: "discord",
            project: "frontend",
            channelId: "C123",
            userId: "U123",
            actions: ["status"],
          },
        ],
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/channels/discord/interactions",
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": DISCORD_VECTOR.signature,
          "x-signature-timestamp": DISCORD_VECTOR.timestamp,
        },
        payload: DISCORD_VECTOR.body,
      });

      assert.equal(response.statusCode, 403);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, false);
      assert.equal(body.code, "CHANNEL_POLICY_DENIED");
      assert.match(body.reason, /not allowed/i);

      const audit = await readChannelPolicyEvents(cpbRoot);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].allowed, false);
      assert.equal(audit[0].request.channel, "discord");
      assert.equal(audit[0].request.action, "run");
      assert.equal(audit[0].request.project, "frontend");
    } finally {
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});
