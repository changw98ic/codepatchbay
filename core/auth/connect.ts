// @ts-nocheck
import { listAuthProviders } from "./status.js";

const SCHEMA_VERSION = 1;
const DEFAULT_BASE_URL = "http://127.0.0.1:3456";

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function getAuthConnectInstructions(providerId, { baseUrl = DEFAULT_BASE_URL } = {}) {
  const provider = listAuthProviders().find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`Unknown auth provider: ${providerId}`);
  }

  const providerNativeCommand = provider.auth?.connectCommand || null;
  let providerNative = null;
  if (providerNativeCommand) {
    const trimmed = providerNativeCommand.trim();
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace > 0) {
      providerNative = {
        command: trimmed.slice(0, firstSpace),
        args: trimmed.slice(firstSpace + 1).split(/\s+/).filter(Boolean),
      };
    } else {
      providerNative = { command: trimmed, args: [] };
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: {
      id: provider.id,
      displayName: provider.displayName,
      kind: provider.kind,
    },
    methods: provider.auth?.methods || [],
    providerNativeCommand,
    providerNative,
    localSetupUrl: `${normalizeBaseUrl(baseUrl)}/setup/auth/${provider.id}`,
    guidance: [
      "Use the provider-native command or open the local setup URL on this machine.",
      "Do not paste API keys, OAuth tokens, or provider secrets into CLI, GitHub comments, Slack, or Discord.",
    ].join(" "),
  };
}
