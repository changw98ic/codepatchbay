import { recordValue, type LooseRecord } from "../../shared/types.js";
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

function splitCommand(commandLine: string) {
  const parts = String(commandLine || "").trim().split(/\s+/).filter(Boolean);
  return { command: parts[0], args: parts.slice(1) };
}

function redact(value: unknown) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text;
}

async function defaultRunCommand(command: string, args: string[] = []) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    const err = recordValue(error);
    return { ok: false, stdout: err.stdout || "", stderr: err.stderr || "", error };
  }
}

export function listAuthProviders() {
  const agentProviders = listSetupAgents({ includeOptional: false })
    .map(recordValue)
    .filter((agent) => ["codex", "claude", "opencode"].includes(String(agent.id)))
    .map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      kind: "agent",
      auth: recordValue(agent.auth),
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

function errorCode(error: unknown) {
  const err = recordValue(error);
  return err.code ?? null;
}

function exitCode(error: unknown) {
  const err = recordValue(error);
  return Number.isInteger(err.code) ? err.code : null;
}

function errorKind(error: unknown) {
  const err = recordValue(error);
  if (Object.keys(err).length === 0) return "unknown";
  if (err.code === "ENOENT") return "missing";
  if (err.code === "ETIMEDOUT" || err.timedOut || err.killed) return "timeout";
  return "error";
}

function providerResult(provider: LooseRecord, probe: LooseRecord | null | undefined, statusCommand: string) {
  const auth = recordValue(provider.auth);
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
      methods: auth.methods || [],
      connectCommand: auth.connectCommand || null,
      evidence: { ...evidence, kind: "ok", exitCode: 0, code: null },
    };
  }

  return {
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    status: evidence.kind === "missing" ? "missing" : "unknown",
    methods: auth.methods || [],
    connectCommand: auth.connectCommand || null,
    evidence,
  };
}

function skippedProvider(provider: LooseRecord) {
  const auth = recordValue(provider.auth);
  return {
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    status: "skipped",
    methods: auth.methods || [],
    connectCommand: auth.connectCommand || null,
    evidence: { reason: "No provider-native status command is configured." },
  };
}

async function checkProvider(provider: LooseRecord, runCommand: (command: string, args: string[]) => Promise<LooseRecord>) {
  const auth = recordValue(provider.auth);
  const statusCommand = typeof auth.statusCommand === "string" ? auth.statusCommand : "";
  if (!statusCommand) return skippedProvider(provider);

  const parsed = splitCommand(statusCommand);
  let probe;
  try {
    probe = await runCommand(parsed.command, parsed.args);
  } catch (error) {
    probe = { ok: false, stdout: "", stderr: "", error };
  }
  return providerResult(provider, probe, statusCommand);
}

export async function getAuthStatus({
  providers = listAuthProviders(),
  runCommand = defaultRunCommand,
} = {}) {
  const providerList = Array.isArray(providers) ? providers.map(recordValue) : [];
  const entries = await Promise.all(providerList.map(async (provider) => {
    return [provider.id, await checkProvider(provider, runCommand)];
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    providers: Object.fromEntries(entries),
  };
}
