import { listAuthProviders } from "./status.js";
const SCHEMA_VERSION = 1;
export function getAuthConnectInstructions(providerId) {
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
        }
        else {
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
        guidance: [
            "Use the provider-native command to authenticate.",
            "Do not paste API keys, OAuth tokens, or provider secrets into CLI, GitHub comments, Slack, or Discord.",
        ].join(" "),
    };
}
