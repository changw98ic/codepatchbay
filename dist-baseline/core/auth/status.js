import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listSetupAgents } from "../setup/agent-catalog.js";
const SCHEMA_VERSION = 1;
const execFileAsync = promisify(execFile);
const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
    /\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY)[A-Z0-9_]*=[^\s]+/gi,
    /([?&](?:token|secret|key|signature)=)[^&\s"']+/gi,
];
function splitCommand(commandLine) {
    const parts = String(commandLine || "").trim().split(/\s+/).filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
}
function redact(value) {
    let text = String(value ?? "");
    for (const pattern of SECRET_PATTERNS) {
        text = text.replace(pattern, "[REDACTED]");
    }
    return text;
}
async function defaultRunCommand(command, args = []) {
    try {
        const result = await execFileAsync(command, args, {
            timeout: 5_000,
            maxBuffer: 1024 * 1024,
        });
        return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
    }
    catch (error) {
        return { ok: false, stdout: error.stdout || "", stderr: error.stderr || "", error };
    }
}
export function listAuthProviders() {
    const agentProviders = listSetupAgents({ includeOptional: false })
        .filter((agent) => ["codex", "claude", "opencode"].includes(agent.id))
        .map((agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        kind: "agent",
        auth: agent.auth || {},
    }));
    return [
        ...agentProviders,
        {
            id: "github",
            displayName: "GitHub",
            kind: "github",
            auth: {
                methods: ["gh"],
                connectCommand: "cpb github connect",
                statusCommand: "gh auth status",
            },
        },
    ];
}
function errorCode(error) {
    if (!error)
        return null;
    return error.code ?? null;
}
function exitCode(error) {
    if (!error)
        return null;
    return Number.isInteger(error.code) ? error.code : null;
}
function errorKind(error) {
    if (!error)
        return "unknown";
    if (error.code === "ENOENT")
        return "missing";
    if (error.code === "ETIMEDOUT" || error.timedOut || error.killed)
        return "timeout";
    return "error";
}
function providerResult(provider, probe, statusCommand) {
    const parsed = splitCommand(statusCommand);
    const evidence = {
        command: redact([parsed.command, ...parsed.args].join(" ")),
        exitCode: exitCode(probe?.error),
        code: errorCode(probe?.error),
        kind: errorKind(probe?.error),
    };
    if (probe?.ok) {
        return {
            id: provider.id,
            displayName: provider.displayName,
            kind: provider.kind,
            status: "connected",
            methods: provider.auth?.methods || [],
            connectCommand: provider.auth?.connectCommand || null,
            evidence: { ...evidence, kind: "ok", exitCode: 0, code: null },
        };
    }
    return {
        id: provider.id,
        displayName: provider.displayName,
        kind: provider.kind,
        status: evidence.kind === "missing" ? "missing" : "unknown",
        methods: provider.auth?.methods || [],
        connectCommand: provider.auth?.connectCommand || null,
        evidence,
    };
}
function skippedProvider(provider) {
    return {
        id: provider.id,
        displayName: provider.displayName,
        kind: provider.kind,
        status: "skipped",
        methods: provider.auth?.methods || [],
        connectCommand: provider.auth?.connectCommand || null,
        evidence: { reason: "No provider-native status command is configured." },
    };
}
async function checkProvider(provider, runCommand) {
    const statusCommand = provider.auth?.statusCommand;
    if (!statusCommand)
        return skippedProvider(provider);
    const parsed = splitCommand(statusCommand);
    let probe;
    try {
        probe = await runCommand(parsed.command, parsed.args);
    }
    catch (error) {
        probe = { ok: false, stdout: "", stderr: "", error };
    }
    return providerResult(provider, probe, statusCommand);
}
export async function getAuthStatus({ providers = listAuthProviders(), runCommand = defaultRunCommand, } = {}) {
    const entries = await Promise.all(providers.map(async (provider) => {
        return [provider.id, await checkProvider(provider, runCommand)];
    }));
    return {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        providers: Object.fromEntries(entries),
    };
}
