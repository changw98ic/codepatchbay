import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { channelRoutes } from "../server/routes/channels.js";
import { CHANNEL_COMMAND_HELP, parseChannelCommand } from "../server/services/channel-commands.js";
import {
  parseSlackSlashCommand,
  verifySlackSignature,
} from "../server/services/channel-slack.js";

function slackSignature(secret, timestamp, rawBody) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

async function buildChannelApp(cpbRoot, routeOptions = {}) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", (req, _reply, done) => {
    req.cpbRoot = cpbRoot;
    done();
  });
  await app.register(channelRoutes, { prefix: "/api", ...routeOptions });
  return app;
}

function assertCommandShape(command) {
  for (const field of ["project", "job", "issue", "task", "workflow"]) {
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
    assertCommandShape(command);
  });

  it("parses issue, status, approve, and cancel commands into typed payloads", () => {
    const issue = parseChannelCommand("/cpb issue frontend 123");
    const status = parseChannelCommand("/cpb status job-20260524-153011-a13f9c");
    const approve = parseChannelCommand("/cpb approve job-20260524-153011-a13f9c");
    const cancel = parseChannelCommand("/cpb cancel job-20260524-153011-a13f9c");

    assert.deepEqual(issue, {
      ok: true,
      type: "issue",
      command: "issue",
      project: "frontend",
      job: null,
      issue: 123,
      task: null,
      workflow: "standard",
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
});
