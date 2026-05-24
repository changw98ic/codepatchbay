import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CHANNEL_COMMAND_HELP, parseChannelCommand } from "../server/services/channel-commands.js";

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
