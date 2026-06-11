import assert from "node:assert/strict";
import { test } from "node:test";

import {
  channelPolicyRequest,
  enforceChannelPolicy,
  evaluateChannelPolicy,
  readChannelPolicyEvents,
} from "../server/services/channel-policy.js";
import { tempRoot } from "./helpers.js";

test("channel policy deny wins over allow and default deny blocks unmatched writes", () => {
  const policy = {
    enabled: true,
    default: "deny",
    allow: [{ channel: "slack", action: ["run", "status"], project: "proj" }],
    deny: [{ channel: "slack", action: "run", userId: "blocked" }],
  };
  assert.equal(evaluateChannelPolicy(policy, { channel: "slack", action: "run", project: "proj", userId: "blocked" }).allowed, false);
  assert.equal(evaluateChannelPolicy(policy, { channel: "slack", action: "status", project: "proj", userId: "blocked" }).allowed, true);
  assert.equal(evaluateChannelPolicy(policy, { channel: "slack", action: "cancel", project: "proj", userId: "ok" }).allowed, false);
});

test("channel policy supports wildcard read-only access with write restrictions", () => {
  const policy = {
    enabled: true,
    default: "deny",
    rules: [
      { channel: "discord", action: ["status", "logs"], project: "*", userId: "viewer", effect: "allow" },
      { channel: "discord", action: ["run", "approve", "cancel", "retry"], project: "prod", userId: "operator", effect: "allow" },
    ],
  };
  assert.equal(evaluateChannelPolicy(policy, { channel: "discord", action: "logs", project: "any", userId: "viewer" }).allowed, true);
  assert.equal(evaluateChannelPolicy(policy, { channel: "discord", action: "run", project: "any", userId: "viewer" }).allowed, false);
  assert.equal(evaluateChannelPolicy(policy, { channel: "discord", action: "run", project: "prod", userId: "operator" }).allowed, true);
});

test("channelPolicyRequest maps actor id and channel id", () => {
  const request = channelPolicyRequest({
    channel: "github",
    action: "approve",
    project: "proj",
    job: "q-123",
    actor: { id: "alice", channelId: "owner/repo" },
  });
  assert.equal(request.userId, "alice");
  assert.equal(request.channelId, "owner/repo");
  assert.equal(request.job, "q-123");
});

test("enforceChannelPolicy writes audit events in order", async () => {
  const cpbRoot = await tempRoot("cpb-channel-policy-audit");
  await enforceChannelPolicy(cpbRoot, { enabled: true, default: "allow" }, { channel: "slack", action: "status" });
  await enforceChannelPolicy(cpbRoot, { enabled: true, default: "deny" }, { channel: "slack", action: "cancel" });
  const events = await readChannelPolicyEvents(cpbRoot);
  assert.equal(events.length, 2);
  assert.equal(events[0].allowed, true);
  assert.equal(events[1].allowed, false);
  assert.equal(events[1].request.action, "cancel");
});
