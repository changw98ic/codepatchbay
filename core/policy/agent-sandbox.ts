import type { LooseRecord } from "../../shared/types.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const VALID_MODES = new Set(["off", "best-effort", "required", "strict"]);
type EnvRecord = Record<string, string | undefined>;
type ProbeFn = (command: string) => boolean;
type SandboxOptions = {
  cwd?: string;
  platform?: NodeJS.Platform;
  probe?: ProbeFn;
};
type AgentSandboxProvider = "custom" | "sandbox-exec" | "bwrap" | null;
type AgentSandboxPolicy = LooseRecord & {
  mode: string;
  enabled: boolean;
  provider: AgentSandboxProvider;
  command?: string;
  args?: string[];
  network: "allow" | "deny";
  subprocess: "allow" | "deny";
  readRoots: string[];
  writeRoots: string[];
  reason?: string;
};
type BuildAgentSandboxOptions = SandboxOptions & {
  env?: EnvRecord;
};
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
  // Codex managed-policy file. Grant this exact read-only path instead of
  // exposing /etc broadly; current Codex checks it during startup even when
  // no repository command has run yet.
  "/etc/codex/requirements.toml",
  // Minimal resolver/TLS bootstrap files needed by outbound provider HTTPS.
  // Keep these exact so required mode does not gain broad /etc access.
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/ssl/cert.pem",
  "/etc/ssl/openssl.cnf",
  "/private/etc/hosts",
  "/private/etc/resolv.conf",
  "/private/etc/ssl/cert.pem",
  "/private/etc/ssl/openssl.cnf",
  "/private/var/run/mDNSResponder",
  "/var/run/mDNSResponder",
]) as readonly string[];

function splitList(value?: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvArgs(value?: string) {
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

function commandExists(command: string, probe: ProbeFn = defaultProbe) {
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

function normalizedMode(env: EnvRecord = {}) {
  if (env.CPB_AGENT_SANDBOX_INHERITED === "1") return "off";
  const requested = String(
    env.CPB_AGENT_SANDBOX ||
    env.CPB_AGENT_SANDBOX_MODE ||
    "required"
  ).trim().toLowerCase();
  if (!VALID_MODES.has(requested)) {
    throw new Error(`CPB_AGENT_SANDBOX_INVALID_MODE: ${JSON.stringify(requested)}`);
  }
  return requested;
}

function normalizedAccess(value: string | undefined, fallback: "allow" | "deny", name: string): "allow" | "deny" {
  const requested = String(value || fallback).trim().toLowerCase();
  if (requested !== "allow" && requested !== "deny") {
    throw new Error(`${name}_INVALID: ${JSON.stringify(requested)}`);
  }
  return requested;
}

function sandboxLiteral(value: string) {
  return JSON.stringify(path.resolve(String(value)));
}

function uniqueExistingRoots(values: Array<string | undefined>, cwd: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  };
  for (const value of values) {
    if (!value) continue;
    const absolute = path.resolve(cwd || process.cwd(), String(value));
    add(absolute);
    let resolved = absolute;
    if (existsSync(absolute)) {
      try {
        resolved = realpathSync(absolute);
      } catch {}
    }
    add(resolved);
  }
  return out;
}

function uniqueRoots(values: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  };
  for (const value of values) {
    if (!value) continue;
    const absolute = path.resolve(String(value));
    add(absolute);
    let resolved = absolute;
    if (existsSync(absolute)) {
      try {
        resolved = realpathSync(absolute);
      } catch {}
    }
    add(resolved);
  }
  return out;
}

function ancestorDirectories(values: string[]) {
  const ancestors = new Set<string>();
  for (const value of values) {
    let current = path.dirname(value);
    while (current && !ancestors.has(current)) {
      ancestors.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...ancestors];
}

function writeRootFromPattern(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const star = trimmed.indexOf("*");
  const root = star >= 0 ? trimmed.slice(0, star) : trimmed;
  const withoutTrailingSlash = root.replace(/[\\/]+$/, "");
  if (!withoutTrailingSlash) return "";
  return withoutTrailingSlash;
}

function writeRootsFromAllowList(value?: string) {
  return splitList(value)
    .map(writeRootFromPattern)
    .filter(Boolean);
}

function agentHomeWriteRootCandidates(value?: string) {
  if (!value) return [];
  const absolute = path.resolve(String(value));
  const parts = absolute.split(path.sep);
  const markerIndex = parts.lastIndexOf("agent-homes");
  if (markerIndex < 0) return [];
  const root = parts.slice(0, markerIndex + 1).join(path.sep) || path.sep;
  const roots = [root, absolute];
  if (parts.length > markerIndex + 1) {
    roots.push(parts.slice(0, markerIndex + 2).join(path.sep) || path.sep);
  }
  return roots;
}

function isolatedAgentHomeRoots(env: EnvRecord = {}) {
  return uniqueRoots([
    env.HOME,
    env.CODEX_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
  ].flatMap(agentHomeWriteRootCandidates));
}

function runtimeScopedWriteRoots(env: EnvRecord = {}) {
  const runtimeRoot = env.CPB_PROJECT_RUNTIME_ROOT;
  if (!runtimeRoot) return [];
  const root = path.resolve(runtimeRoot);
  return [
    path.join(root, "agent-homes"),
    path.join(root, "acp-audit"),
  ];
}

function executableReadRoots(command: string, env: EnvRecord = {}, cwd = process.cwd()) {
  const commandText = String(command || "");
  if (!commandText) return [];

  const candidates: string[] = [];
  if (commandText.includes("/") || path.isAbsolute(commandText)) {
    candidates.push(path.resolve(cwd, commandText));
  } else {
    for (const dir of String(env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.resolve(cwd, dir, commandText);
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }

  const roots: string[] = [];
  for (const candidate of candidates) {
    roots.push(path.dirname(candidate));
    if (existsSync(candidate)) {
      try {
        const realCandidate = realpathSync(candidate);
        roots.push(path.dirname(realCandidate));
        roots.push(...nodePackageDependencyReadRoots(realCandidate));
      } catch {}
    }
  }
  return uniqueRoots(roots);
}

function packageRootForEntrypoint(entrypoint: string) {
  let current = path.dirname(entrypoint);
  for (let depth = 0; depth < 32; depth += 1) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function ancestorNodeModulesRoots(packageRoot: string) {
  const roots: string[] = [];
  let current = packageRoot;
  for (let depth = 0; depth < 32; depth += 1) {
    if (path.basename(current) === "node_modules") roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function validPackageName(value: string) {
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(value);
}

/**
 * Node CLI launchers frequently import platform binaries from declared
 * optional dependencies located beside the launcher package. Grant read
 * access only to the package itself and exact manifest-declared dependency
 * package roots; never expose the whole global node_modules tree.
 */
function nodePackageDependencyReadRoots(entrypoint: string) {
  const root = packageRootForEntrypoint(entrypoint);
  if (!root) return [];

  const roots: string[] = [];
  const queue = [root];
  const visited = new Set<string>();
  while (queue.length > 0 && visited.size < 64) {
    const packageRoot = queue.shift()!;
    let canonicalRoot = packageRoot;
    try { canonicalRoot = realpathSync(packageRoot); } catch {}
    if (visited.has(canonicalRoot)) continue;
    visited.add(canonicalRoot);
    roots.push(canonicalRoot);

    let manifest: LooseRecord;
    try {
      manifest = JSON.parse(readFileSync(path.join(canonicalRoot, "package.json"), "utf8")) as LooseRecord;
    } catch {
      continue;
    }
    const dependencyNames = new Set<string>();
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      const dependencies = manifest[field];
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
      for (const name of Object.keys(dependencies)) {
        if (validPackageName(name)) dependencyNames.add(name);
      }
    }

    const nodeModulesRoots = [
      path.join(canonicalRoot, "node_modules"),
      ...ancestorNodeModulesRoots(canonicalRoot),
    ];
    for (const name of dependencyNames) {
      const dependencyRoot = nodeModulesRoots
        .map((nodeModulesRoot) => path.join(nodeModulesRoot, name))
        .find((candidate) => existsSync(path.join(candidate, "package.json")));
      if (dependencyRoot) queue.push(dependencyRoot);
    }
  }
  return roots;
}

function argumentReadRoots(args: string[] = [], cwd = process.cwd()) {
  const roots: string[] = [];
  for (const arg of args) {
    const value = String(arg || "");
    if (!value || !value.includes(path.sep)) continue;
    const candidate = path.resolve(cwd, value);
    if (!existsSync(candidate)) continue;
    roots.push(candidate);
    roots.push(path.dirname(candidate));
    try {
      const real = realpathSync(candidate);
      roots.push(real);
      roots.push(path.dirname(real));
    } catch {}
  }
  return uniqueRoots(roots);
}

function withExecutableReadRoots(policy: AgentSandboxPolicy, command: string, args: string[], env: EnvRecord, cwd: string) {
  if (!policy.enabled || policy.provider === "custom") return policy;
  const readRoots = uniqueRoots([
    ...policy.readRoots,
    ...executableReadRoots(command, env, cwd),
    ...argumentReadRoots(args, cwd),
  ]);
  return { ...policy, readRoots };
}

export function resolveAgentSandboxPolicy(env: EnvRecord = {}, { cwd = process.cwd(), platform = process.platform, probe = defaultProbe }: SandboxOptions = {}): AgentSandboxPolicy {
  const mode = normalizedMode(env);
  const strict = mode === "strict";
  // ACP providers require outbound network access to reach their model API.
  // Filesystem/process isolation remains enforced in required mode; strict is
  // the explicit offline profile and continues to deny network by default.
  const network = normalizedAccess(env.CPB_AGENT_SANDBOX_NETWORK, strict ? "deny" : "allow", "CPB_AGENT_SANDBOX_NETWORK");
  const subprocess = normalizedAccess(env.CPB_AGENT_SANDBOX_PROCESS, strict ? "deny" : "allow", "CPB_AGENT_SANDBOX_PROCESS");
  const writeAllowRoots = writeRootsFromAllowList(env.CPB_ACP_WRITE_ALLOW);
  const explicitWriteRoots = [
    ...writeAllowRoots,
    ...splitList(env.CPB_AGENT_SANDBOX_ALLOW_WRITE),
  ];
  const scopedWriteAllow = writeAllowRoots.length > 0;
  const agentHomeWriteRoots = uniqueRoots([
    ...isolatedAgentHomeRoots(env),
    ...runtimeScopedWriteRoots(env),
  ]);

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
    ...explicitWriteRoots,
  ], cwd);

  const writeRoots = uniqueExistingRoots([
    ...(scopedWriteAllow ? [] : [cwd]),
    env.TMPDIR,
    env.TEMP,
    env.TMP,
    ...agentHomeWriteRoots,
    ...explicitWriteRoots,
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

function sandboxExecProfile(policy: AgentSandboxPolicy) {
  const boundedReadRoots = uniqueRoots([...SYSTEM_READ_ROOTS, ...policy.readRoots]);
  const readRoots = [
    ...ancestorDirectories(boundedReadRoots).map((root: string) => `(literal ${sandboxLiteral(root)})`),
    ...boundedReadRoots.map((root: string) => `(subpath ${sandboxLiteral(root)})`),
  ];
  const writeRoots = policy.writeRoots.map((root: string) => `(subpath ${sandboxLiteral(root)})`);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    policy.subprocess === "deny" ? "(deny process-exec*)" : "",
    policy.network === "deny" ? "(deny network*)" : "(allow network*)",
    // Native TLS root discovery on macOS is brokered by trustd/securityd.
    // Permit only these exact service lookups; broad mach access would punch
    // through the process boundary enforced by the sandbox.
    '(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.securityd") (global-name "com.apple.mDNSResponder") (global-name "com.apple.SystemConfiguration.configd"))',
    "(allow sysctl-read)",
    readRoots.length > 0 ? `(allow file-read* ${readRoots.join(" ")})` : "",
    // Node opens /dev/null for child stdio when a provider uses
    // `stdio: "ignore"`. Without this narrow device exception macOS returns
    // EPERM from spawn even though the policy allows subprocesses.
    '(allow file-write* (literal "/dev/null"))',
    writeRoots.length > 0 ? `(allow file-write* ${writeRoots.join(" ")})` : "",
  ].filter(Boolean).join("\n");
}

function rootCoversPath(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function bwrapArgs(policy: AgentSandboxPolicy, command: string, args: string[], cwd: string) {
  const bargs = ["--die-with-parent"];
  const writeRootSet = new Set(policy.writeRoots);
  if (policy.network === "deny") bargs.push("--unshare-net");
  bargs.push("--proc", "/proc", "--dev", "/dev");
  const systemReadRoots = SYSTEM_READ_ROOTS.filter((root) => root !== "/dev" && !writeRootSet.has(root));
  for (const root of systemReadRoots) {
    bargs.push("--ro-bind-try", root, root);
  }

  // A system or writable root already exposes all of its descendants. Avoid
  // duplicate and nested bind mounts: they add no access and make launch
  // success depend on how the host's user-namespace mount policy handles
  // redundant mounts (notably hardened bwrap/AppArmor configurations).
  const coveredRoots = ["/proc", "/dev", ...systemReadRoots, ...policy.writeRoots];
  for (const root of policy.readRoots) {
    if (coveredRoots.some((coveredRoot) => rootCoversPath(coveredRoot, root))) continue;
    bargs.push("--ro-bind-try", root, root);
    coveredRoots.push(root);
  }
  for (const root of policy.writeRoots) bargs.push("--bind-try", root, root);
  bargs.push("--chdir", cwd || process.cwd(), command, ...args);
  return bargs;
}

export function buildAgentSandboxLaunch(command: string, args: string[] = [], options: BuildAgentSandboxOptions = {}) {
  const env = options.env || {};
  const cwd = options.cwd || process.cwd();
  const policy = withExecutableReadRoots(
    resolveAgentSandboxPolicy(env, options),
    command,
    args,
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
