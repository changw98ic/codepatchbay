import { createHmac, timingSafeEqual } from "node:crypto";
import { parseChannelCommand } from "./channel-commands.js";

const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

function rawBodyText(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody.toString("utf8");
  return String(rawBody ?? "");
}

function expectedSlackSignature(signingSecret, timestamp, rawBody) {
  const base = `v0:${timestamp}:${rawBodyText(rawBody)}`;
  return `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
}

function signaturesMatch(expected, actual) {
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifySlackSignature({
  signingSecret,
  timestamp,
  signature,
  rawBody,
  nowMs = Date.now(),
  toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
} = {}) {
  if (!signingSecret) return { ok: false, reason: "Slack signing secret is not configured" };
  if (!timestamp || !signature) return { ok: false, reason: "missing Slack signature headers" };

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return { ok: false, reason: "invalid Slack timestamp" };

  const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - timestampSeconds);
  if (ageSeconds > toleranceSeconds) return { ok: false, reason: "stale Slack request timestamp" };

  const expected = expectedSlackSignature(signingSecret, timestamp, rawBody);
  if (!signaturesMatch(expected, signature)) return { ok: false, reason: "invalid Slack signature" };
  return { ok: true };
}

export function parseSlackFormBody(rawBody) {
  const params = new URLSearchParams(rawBodyText(rawBody));
  return Object.fromEntries(params.entries());
}

export function parseSlackSlashCommand(payload = {}) {
  const commandText = [payload.command || "/cpb", payload.text || ""]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const command = parseChannelCommand(commandText);
  return {
    ok: command.ok,
    channel: "slack",
    actor: {
      userId: payload.user_id || null,
      userName: payload.user_name || null,
      teamId: payload.team_id || null,
      channelId: payload.channel_id || null,
      channelName: payload.channel_name || null,
    },
    command,
    responseUrlPresent: Boolean(payload.response_url),
  };
}
