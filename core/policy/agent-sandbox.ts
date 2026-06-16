import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const VALID_MODES = new Set(["off", "best-effort", "required", "strict"]);
type StringRecord = Record<string, any>;
const SYSTEM_READ_ROOTS = Object.freeze([
  "/bin",
  "/lib",
  "/lib64",
  "/sbin",
  "/usr",
  "/System",
  "/Library",
  "/opt/homebrew",
  "/dev",
]);

function splitList(value: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvArgs(value: string) {
  if (!value) return [];
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("CPB_AGENT_SANDBOX_ARGS must be a JSON array when JSON is used");
    return parsed.map(String);
  }
  return text.split(/\s+/).filter(Boolean);
}

function commandExists(command: string, probe = defaultProbe) {
  return Boolean(probe(command));
}

function defaultProbe(command: string) {
  const result = spawnSync(command, [], {
    stdio: "ignore",
    timeout: 1000,
  });
  if ((result.error as { code?: string } | undefined)?.code === "ENOENT") return false;
  return true;
}

function normalizedMode(env: StringRecord = {}) {
  const requested = String(
    env.CPB_AGENT_SANDBOX ||
    env.CPB_AGENT_SANDBOX_MODE ||
    (env.CPB_AGENT_SANDBOX_COMMAND ? "required" : "off")
  ).trim().toLowerCase();
  return VALID_MODES.has(requested) ? requested : "off";
}

function sandboxLiteral(value: string) {
  return JSON.stringify(path.resolve(String(value)));
}

function uniqueExistingRoots(values: string[], cwd: string) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(cwd || process.cwd(), String(value));
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

function uniqueRoots(values: string[]) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(String(value));
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

function executableReadRoots(command: string, env: StringRecord = {}, cwd = process.cwd()) {
  const commandText = String(command || "");
  if (!commandText) return [];

  const candidates = [];
  if (commandText.includes("/") || path.isAbsolute(commandText)) {
    candidates.push(path.resolve(cwd, commandText));
  } else {
    for (const dir of String(env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.resolve(cwd, dir, commandText);
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }

  const roots = [];
  for (const candidate of candidates) {
    roots.push(path.dirname(candidate));
    if (existsSync(candidate)) {
      try {
        roots.push(path.dirname(realpathSync(candidate)));
      } catch {}
    }
  }
  return uniqueRoots(roots);
}

function withExecutableReadRoots(policy: Record<string, any>, command: string, env: StringRecord, cwd: string) {
  if (!policy.enabled || policy.provider === "custom") return policy;
  const readRoots = uniqueRoots([
    ...policy.readRoots,
    ...executableReadRoots(command, env, cwd),
  ]);
  return { ...policy, readRoots };
}

export function resolveAgentSandboxPolicy(env: StringRecord = {}, { cwd = process.cwd(), platform = process.platform, probe = defaultProbe }: StringRecord = {}) {
  const mode = normalizedMode(env);
  const strict = mode === "strict";
  const network = String(env.CPB_AGENT_SANDBOX_NETWORK || (strict ? "deny" : "allow")).toLowerCase() === "deny"
    ? "deny"
    : "allow";
  const subprocess = String(env.CPB_AGENT_SANDBOX_PROCESS || (strict ? "deny" : "allow")).toLowerCase() === "deny"
    ? "deny"
    : "allow";

  const readRoots = uniqueExistingRoots([
    cwd,
    env.TMPDIR,
    env.TEMP,
    env.TMP,
    env.CODEX_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    ...splitList(env.CPB_AGENT_SANDBOX_ALLOW_READ),
    ...splitList(env.CPB_AGENT_SANDBOX_ALLOW_WRITE),
  ], cwd);

  const writeRoots = uniqueExistingRoots([
    cwd,
    env.TMPDIR,
    env.TEMP,
    env.TMP,
    ...splitList(env.CPB_AGENT_SANDBOX_ALLOW_WRITE),
  ], cwd);

  const customCommand = env.CPB_AGENT_SANDBOX_COMMAND || null;
  if (mode === "off") {
    return { mode, enabled: false, provider: null, network, subprocess, readRoots, writeRoots };
  }

  if (customCommand) {
    return {
      mode,
      enabled: true,
      provider: "custom",
      command: customCommand,
      args: parseEnvArgs(env.CPB_AGENT_SANDBOX_ARGS),
      network,
      subprocess,
      readRoots,
      writeRoots,
    };
  }

  if (platform === "darwin" && commandExists("sandbox-exec", probe)) {
    return { mode, enabled: true, provider: "sandbox-exec", network, subprocess, readRoots, writeRoots };
  }

  if (platform === "linux" && commandExists("bwrap", probe)) {
    if (subprocess === "deny") {
      return {
        mode,
        enabled: false,
        provider: null,
        network,
        subprocess,
        readRoots,
        writeRoots,
        reason: "Linux bwrap sandbox does not enforce subprocess denial; configure CPB_AGENT_SANDBOX_COMMAND for strict process policy",
      };
    }
    return { mode, enabled: true, provider: "bwrap", network, subprocess, readRoots, writeRoots };
  }

  return {
    mode,
    enabled: false,
    provider: null,
    network,
    subprocess,
    readRoots,
    writeRoots,
    reason: `no supported agent sandbox provider for platform ${platform}`,
  };
}

function sandboxExecProfile(policy: Record<string, any>) {
  const readRoots = [...SYSTEM_READ_ROOTS, ...policy.readRoots].map((root: string) => `(subpath ${sandboxLiteral(root)})`);
  const writeRoots = policy.writeRoots.map((root: string) => `(subpath ${sandboxLiteral(root)})`);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    policy.subprocess === "deny" ? "(deny process-exec*)" : "",
    policy.network === "deny" ? "(deny network*)" : "(allow network*)",
    "(allow sysctl-read)",
    `(allow file-read* ${readRoots.join(" ")})`,
    writeRoots.length > 0 ? `(allow file-write* ${writeRoots.join(" ")})` : "",
  ].filter(Boolean).join("\n");
}

function bwrapArgs(policy: Record<string, any>, command: string, args: string[], cwd: string) {
  const bargs = ["--die-with-parent"];
  const writeRootSet = new Set(policy.writeRoots);
  if (policy.network === "deny") bargs.push("--unshare-net");
  bargs.push("--proc", "/proc", "--dev", "/dev");
  for (const root of SYSTEM_READ_ROOTS) {
    if (root === "/dev") continue;
    if (writeRootSet.has(root)) continue;
    bargs.push("--ro-bind-try", root, root);
  }
  for (const root of policy.readRoots) {
    if (writeRootSet.has(root)) continue;
    bargs.push("--ro-bind-try", root, root);
  }
  for (const root of policy.writeRoots) bargs.push("--bind-try", root, root);
  bargs.push("--chdir", cwd || process.cwd(), command, ...args);
  return bargs;
}

export function buildAgentSandboxLaunch(command: string, args: string[] = [], options: StringRecord = {}) {
  const env = options.env || {};
  const cwd = options.cwd || process.cwd();
  const policy = withExecutableReadRoots(
    resolveAgentSandboxPolicy(env, options),
    command,
    env,
    cwd,
  );
  if (!policy.enabled) {
    if (policy.mode === "required" || policy.mode === "strict") {
      throw new Error(`CPB_AGENT_SANDBOX_REQUIRED: ${policy.reason || "agent sandbox is required but unavailable"}`);
    }
    return { command, args, sandbox: policy };
  }

  if (policy.provider === "custom") {
    return {
      command: policy.command,
      args: [...policy.args, command, ...args],
      sandbox: policy,
    };
  }

  if (policy.provider === "sandbox-exec") {
    return {
      command: "sandbox-exec",
      args: ["-p", sandboxExecProfile(policy), command, ...args],
      sandbox: policy,
    };
  }

  if (policy.provider === "bwrap") {
    return {
      command: "bwrap",
      args: bwrapArgs(policy, command, args, cwd),
      sandbox: policy,
    };
  }

  throw new Error(`CPB_AGENT_SANDBOX_REQUIRED: unsupported sandbox provider ${policy.provider}`);
}
