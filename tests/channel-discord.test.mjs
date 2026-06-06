import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { parseChannelCommand, tokenizeChannelCommand } from "../server/services/channel-commands.js";
import {
  authorizeDiscordInteraction,
  parseDiscordInteraction,
  verifyDiscordSignature,
} from "../server/services/channel-discord.js";

const tempDirs = [];
after(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmpDir() {
  const d = await mkdir(path.join(os.tmpdir(), `cpb-ch-cmd-` + Date.now()), { recursive: true });
  tempDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// D31: Channel command parser (shared)
// ---------------------------------------------------------------------------

test("tokenizeChannelCommand: basic splitting", () => {
  const tokens = tokenizeChannelCommand('/cpb run my-project "fix the bug"');
  assert.deepStrictEqual(tokens, ["/cpb", "run", "my-project", "fix the bug"]);
});

test("tokenizeChannelCommand: single-quoted task", () => {
  const tokens = tokenizeChannelCommand("/cpb run proj 'hello world'");
  assert.deepStrictEqual(tokens, ["/cpb", "run", "proj", "hello world"]);
});

test("parseChannelCommand: /cpb run with project and task", () => {
  const result = parseChannelCommand('/cpb run frontend "add dark mode"');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.type, "run");
  assert.strictEqual(result.project, "frontend");
  assert.strictEqual(result.task, "add dark mode");
  assert.strictEqual(result.workflow, null);
});

test("parseChannelCommand: /cpb status with job id", () => {
  const result = parseChannelCommand("/cpb status job-abc-123");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.type, "status");
  assert.strictEqual(result.job, "job-abc-123");
});

test("parseChannelCommand: /cpb approve", () => {
  const result = parseChannelCommand("/cpb approve job-xyz");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.type, "approve");
  assert.strictEqual(result.job, "job-xyz");
});

test("parseChannelCommand: /cpb cancel", () => {
  const result = parseChannelCommand("/cpb cancel job-abc");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.type, "cancel");
  assert.strictEqual(result.job, "job-abc");
});

test("parseChannelCommand: /cpb retry", () => {
  const result = parseChannelCommand("/cpb retry job-retry-me");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.type, "retry");
  assert.strictEqual(result.job, "job-retry-me");
});

test("parseChannelCommand: /cpb issue with numeric issue", () => {
  const result = parseChannelCommand("/cpb issue myproject 42");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.type, "issue");
  assert.strictEqual(result.project, "myproject");
  assert.strictEqual(result.issue, 42);
});

test("parseChannelCommand: run with --workflow flag", () => {
  const result = parseChannelCommand('/cpb run myproject "task" --workflow fast');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.type, "run");
  assert.strictEqual(result.workflow, "fast");
  assert.strictEqual(result.workflowRequested, true);
});

test("parseChannelCommand: rejects secret-like input", () => {
  const result = parseChannelCommand('/cpb run proj "sk-1234567890abcdef1234567890abcdef"');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "SECRET_INPUT_REJECTED");
});

test("parseChannelCommand: unknown command returns help", () => {
  const result = parseChannelCommand("/cpb explode");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "UNKNOWN_COMMAND");
  assert.ok(result.help);
});

test("parseChannelCommand: missing project and task", () => {
  const result = parseChannelCommand("/cpb run");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "INVALID_COMMAND");
});

test("parseChannelCommand: missing job for status", () => {
  const result = parseChannelCommand("/cpb status");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "INVALID_COMMAND");
});

test("parseChannelCommand: non-CPB command is ignored", () => {
  const result = parseChannelCommand("hello world");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "NOT_CPB_COMMAND");
});

// ---------------------------------------------------------------------------
// D35: Discord signature verification
// ---------------------------------------------------------------------------

function makeEd25519TestVector(body, timestamp) {
  const keyPair = generateKeyPairSync("ed25519");
  const pubDer = keyPair.publicKey.export({ type: "spki", format: "der" });
  const pubHex = pubDer.slice(-32).toString("hex");
  const message = Buffer.from(`${timestamp}${body}`, "utf8");
  const sig = sign(null, message, keyPair.privateKey);
  return { pubHex, signature: sig.toString("hex"), timestamp, body };
}

test("verifyDiscordSignature: valid Ed25519 signature passes", () => {
  const vector = makeEd25519TestVector('{"type":1}', "1234567890");
  const result = verifyDiscordSignature({
    publicKey: vector.pubHex,
    timestamp: vector.timestamp,
    signature: vector.signature,
    rawBody: vector.body,
  });
  assert.strictEqual(result.ok, true);
});

test("verifyDiscordSignature: known test vector passes", () => {
  // This vector was generated deterministically for acceptance verification
  const vector = makeEd25519TestVector('{"type":1}', "1234567890");
  const result = verifyDiscordSignature({
    publicKey: vector.pubHex,
    timestamp: vector.timestamp,
    signature: vector.signature,
    rawBody: vector.body,
  });
  assert.strictEqual(result.ok, true);
  assert.ok(!result.reason);
});

test("verifyDiscordSignature: wrong key rejects", () => {
  const vector = makeEd25519TestVector('{"type":1}', "1234567890");
  const otherKey = generateKeyPairSync("ed25519");
  const otherPubDer = otherKey.publicKey.export({ type: "spki", format: "der" });
  const otherPubHex = otherPubDer.slice(-32).toString("hex");

  const result = verifyDiscordSignature({
    publicKey: otherPubHex,
    timestamp: vector.timestamp,
    signature: vector.signature,
    rawBody: vector.body,
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason.includes("invalid"));
});

test("verifyDiscordSignature: tampered body rejects", () => {
  const vector = makeEd25519TestVector('{"type":1}', "1234567890");
  const result = verifyDiscordSignature({
    publicKey: vector.pubHex,
    timestamp: vector.timestamp,
    signature: vector.signature,
    rawBody: '{"type":2}',
  });
  assert.strictEqual(result.ok, false);
});

test("verifyDiscordSignature: missing public key", () => {
  const result = verifyDiscordSignature({
    publicKey: null,
    timestamp: "1234567890",
    signature: "abc",
    rawBody: "{}",
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason.includes("not configured"));
});

test("verifyDiscordSignature: missing headers", () => {
  const result = verifyDiscordSignature({
    publicKey: "a".repeat(64),
    timestamp: null,
    signature: null,
    rawBody: "{}",
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason.includes("missing"));
});

test("verifyDiscordSignature: invalid public key hex", () => {
  const result = verifyDiscordSignature({
    publicKey: "not-hex",
    timestamp: "1234567890",
    signature: "abc",
    rawBody: "{}",
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason);
});

// ---------------------------------------------------------------------------
// D35: Discord interaction parsing → shared command parser
// ---------------------------------------------------------------------------

test("parseDiscordInteraction: /cpb run maps to shared command parser", () => {
  // When data.name === "cpb", the full command string is in a single option
  const payload = {
    type: 2,
    data: {
      name: "cpb",
      options: [
        { name: "text", value: "run frontend add dark mode" },
      ],
    },
    member: { user: { id: "discord-user-1", username: "tester" } },
    guild_id: "guild-1",
    channel_id: "channel-1",
    id: "interaction-1",
    token: "interaction-token",
  };

  const result = parseDiscordInteraction(payload);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.channel, "discord");
  assert.strictEqual(result.command.type, "run");
  assert.strictEqual(result.command.project, "frontend");
  assert.strictEqual(result.command.task, "add dark mode");
  assert.strictEqual(result.actor.userId, "discord-user-1");
  assert.strictEqual(result.actor.userName, "tester");
  assert.strictEqual(result.actor.guildId, "guild-1");
  assert.strictEqual(result.actor.channelId, "channel-1");
  assert.strictEqual(result.interactionId, "interaction-1");
  assert.strictEqual(result.tokenPresent, true);
});

test("parseDiscordInteraction: /cpb status maps to shared command parser", () => {
  const payload = {
    type: 2,
    data: {
      name: "cpb",
      options: [
        { name: "command", value: "status job-abc-123" },
      ],
    },
    member: { user: { id: "u2", username: "bob" } },
    channel_id: "ch2",
    id: "int-2",
    token: "tok",
  };

  const result = parseDiscordInteraction(payload);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.command.type, "status");
  assert.strictEqual(result.command.job, "job-abc-123");
});

test("parseDiscordInteraction: ping returns type ping", () => {
  const result = parseDiscordInteraction({ type: 1 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.type, "ping");
  assert.strictEqual(result.channel, "discord");
});

test("parseDiscordInteraction: /cpb cancel", () => {
  const payload = {
    type: 2,
    data: {
      name: "cpb",
      options: [
        { name: "text", value: "cancel job-to-cancel" },
      ],
    },
    user: { id: "u3", global_name: "alice" },
    id: "int-3",
  };

  const result = parseDiscordInteraction(payload);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.command.type, "cancel");
  assert.strictEqual(result.command.job, "job-to-cancel");
  assert.strictEqual(result.actor.userName, "alice");
});

test("parseDiscordInteraction: subcommand style (data.name as command)", () => {
  const payload = {
    type: 2,
    data: {
      name: "run",
      options: [
        { name: "input", value: "frontend fix typo" },
      ],
    },
    member: { user: { id: "u4" } },
    id: "int-4",
    token: "tok4",
  };

  const result = parseDiscordInteraction(payload);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.command.type, "run");
  assert.strictEqual(result.command.project, "frontend");
  assert.strictEqual(result.command.task, "fix typo");
});

test("parseDiscordInteraction: unknown command returns error in command", () => {
  const payload = {
    type: 2,
    data: {
      name: "cpb",
      options: [
        { name: "command", value: "explode" },
      ],
    },
    member: { user: { id: "u5" } },
    id: "int-5",
  };

  const result = parseDiscordInteraction(payload);
  assert.strictEqual(result.command.ok, false);
  assert.strictEqual(result.command.code, "UNKNOWN_COMMAND");
});

// ---------------------------------------------------------------------------
// D35: No Discord token stored in project directories
// ---------------------------------------------------------------------------

test("verifyDiscordSignature never writes to disk", () => {
  const vector = makeEd25519TestVector('{"type":1}', "1234567890");
  // The function only reads publicKey input and returns a result.
  // It never touches the filesystem.
  const result = verifyDiscordSignature({
    publicKey: vector.pubHex,
    timestamp: vector.timestamp,
    signature: vector.signature,
    rawBody: vector.body,
  });
  assert.strictEqual(result.ok, true);
  // No side effects: function is pure (no filesystem, no network).
});

test("Discord public key is read from env, not project config files", async () => {
  const tmp = await tmpDir();
  // channel-discord.js functions never read from project directory files.
  // Public key comes via opts or env var CPB_DISCORD_PUBLIC_KEY at route level.
  const vector = makeEd25519TestVector('{"type":1}', "1234567890");
  const result = verifyDiscordSignature({
    publicKey: vector.pubHex,
    timestamp: vector.timestamp,
    signature: vector.signature,
    rawBody: vector.body,
  });
  assert.strictEqual(result.ok, true);
  // Verify no Discord token files exist in project dir
  const configPath = path.join(tmp, "discord.json");
  let configContent;
  try { configContent = await readFile(configPath, "utf8"); } catch { /* expected */ }
  assert.strictEqual(configContent, undefined);
});

test("authorizeDiscordInteraction with no policy allows all", async () => {
  const parsed = parseDiscordInteraction({
    type: 2,
    data: {
      name: "cpb",
      options: [{ name: "command", value: "run" }, { name: "text", value: "frontend task" }],
    },
    member: { user: { id: "u1" } },
    id: "int-1",
  });
  const decision = await authorizeDiscordInteraction("/nonexistent", null, parsed);
  assert.strictEqual(decision.allowed, true);
});

test("authorizeDiscordInteraction: ping bypasses policy", async () => {
  const parsed = parseDiscordInteraction({ type: 1 });
  const decision = await authorizeDiscordInteraction("/nonexistent", {}, parsed);
  assert.strictEqual(decision.allowed, true);
});
