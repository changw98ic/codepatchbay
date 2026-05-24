import { createPublicKey, verify } from "node:crypto";
import { parseChannelCommand } from "./channel-commands.js";
import { channelPolicyRequest, enforceChannelPolicy } from "./channel-policy.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawBodyText(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody.toString("utf8");
  return String(rawBody ?? "");
}

function discordPublicKeyFromHex(publicKeyHex) {
  if (!/^[a-f0-9]{64}$/i.test(String(publicKeyHex || ""))) {
    throw new Error("invalid Discord public key");
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
}

export function verifyDiscordSignature({
  publicKey,
  timestamp,
  signature,
  rawBody,
} = {}) {
  if (!publicKey) return { ok: false, reason: "Discord public key is not configured" };
  if (!timestamp || !signature) return { ok: false, reason: "missing Discord signature headers" };

  try {
    const key = discordPublicKeyFromHex(publicKey);
    const message = Buffer.from(`${timestamp}${rawBodyText(rawBody)}`, "utf8");
    const signatureBytes = Buffer.from(signature, "hex");
    const ok = verify(null, message, key, signatureBytes);
    return ok ? { ok: true } : { ok: false, reason: "invalid Discord signature" };
  } catch (error) {
    return { ok: false, reason: error.message || "invalid Discord signature" };
  }
}

function optionValue(options = [], names = []) {
  const wanted = new Set(names);
  const found = options.find((option) => wanted.has(option.name));
  return found?.value ?? null;
}

export function parseDiscordInteraction(payload = {}) {
  if (payload.type === 1) {
    return { ok: true, channel: "discord", type: "ping" };
  }

  const data = payload.data || {};
  const commandText = data.name === "cpb"
    ? ["/cpb", optionValue(data.options, ["command", "text", "input"]) || ""].join(" ").trim()
    : ["/cpb", data.name || "", optionValue(data.options, ["command", "text", "input"]) || ""].join(" ").trim();
  const command = parseChannelCommand(commandText);
  const user = payload.member?.user || payload.user || {};

  return {
    ok: command.ok,
    channel: "discord",
    actor: {
      userId: user.id || null,
      userName: user.username || user.global_name || null,
      guildId: payload.guild_id || null,
      channelId: payload.channel_id || null,
    },
    command,
    interactionId: payload.id || null,
    tokenPresent: Boolean(payload.token),
  };
}

export async function authorizeDiscordInteraction(cpbRoot, policy, parsed) {
  if (!policy || parsed?.type === "ping") return { allowed: true, reason: "channel policy not configured" };
  const command = parsed?.command;
  const request = channelPolicyRequest({
    channel: "discord",
    action: command?.type || null,
    project: command?.project || null,
    job: command?.job || null,
    actor: parsed?.actor,
  });
  return enforceChannelPolicy(cpbRoot, policy, request);
}
