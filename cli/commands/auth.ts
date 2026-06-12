#!/usr/bin/env node
import { assertNoSecretInput } from "../../server/services/secret-policy.js";

function usage() {
  return [
    "Usage: cpb auth <command>",
    "",
    "Commands:",
    "  status [--json]    Report provider-native auth availability without reading tokens",
    "  connect <provider> [--json]  Show local-only provider login instructions",
  ].join("\n");
}

function rejectSecretArgs(args) {
  assertNoSecretInput(args);
}

export function parseAuthCommand(args = []) {
  rejectSecretArgs(args);
  const json = args.includes("--json");
  const filtered = args.filter((arg) => arg !== "--json");
  const command = filtered[0];

  if (command === "status") return { command, json };
  if (command === "connect") {
    return { command, providerId: filtered[1], json };
  }
  return { command: command || null, json };
}

function formatHuman(status) {
  const lines = ["CodePatchBay Auth", ""];
  for (const provider of Object.values(status.providers) as Array<Record<string, any>>) {
    lines.push(`${provider.id}: ${provider.status}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatConnectHuman(instructions) {
  return [
    `Connect ${instructions.provider.displayName}`,
    "",
    `Provider command: ${instructions.providerNativeCommand || "not available"}`,
    "",
    instructions.guidance,
    "",
  ].join("\n");
}

export async function run(args = []) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  let parsed;
  try {
    parsed = parseAuthCommand(args);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (parsed.command === "status") {
    const { getAuthStatus } = await import("../../core/auth/status.js");
    const status = await getAuthStatus();

    if (parsed.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(formatHuman(status));
    }
    return 0;
  }

  if (parsed.command === "connect") {
    if (!parsed.providerId) {
      console.error("Usage: cpb auth connect <provider> [--json]");
      return 1;
    }
    const { getAuthConnectInstructions } = await import("../../core/auth/connect.js");
    const instructions = getAuthConnectInstructions(parsed.providerId);
    if (parsed.json) {
      console.log(JSON.stringify(instructions, null, 2));
    } else {
      console.log(formatConnectHuman(instructions));
    }
    return 0;
  }

  {
    console.error(usage());
    return 1;
  }
}
