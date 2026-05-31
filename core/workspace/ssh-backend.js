/**
 * SSH workspace backend.
 *
 * Executes phases on a remote host via SSH.
 * Uses ssh/scp from the system PATH.
 */

import { spawn } from "node:child_process";
import { workspacePrepareResult, workspaceTeardownResult, workspaceStatusResult } from "./workspace-contract.js";

function runSSH(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

function sshTarget(config) {
  let target = "";
  if (config.user) target += `${config.user}@`;
  target += config.host;
  return target;
}

function buildSSHArgs(config) {
  const args = [];
  if (config.port) args.push("-p", String(config.port));
  if (config.identityFile) args.push("-i", config.identityFile);
  if (config.strictHostKeyChecking === false) {
    args.push("-o", "StrictHostKeyChecking=no");
  }
  if (config.connectTimeout) {
    args.push("-o", `ConnectTimeout=${config.connectTimeout}`);
  }
  if (config.sshConfig) args.push("-F", config.sshConfig);
  return args;
}

export async function prepare(config) {
  if (!config.host) {
    return workspacePrepareResult("error", {
      backendType: "ssh",
      meta: { error: "ssh backend requires 'host'" },
    });
  }

  if (!config.workspacePath) {
    return workspacePrepareResult("error", {
      backendType: "ssh",
      meta: { error: "ssh backend requires 'workspacePath'" },
    });
  }

  const target = sshTarget(config);
  const sshArgs = buildSSHArgs(config);

  // Verify connectivity
  const probe = await runSSH([...sshArgs, target, "echo", "ok"]);
  if (probe.code !== 0) {
    return workspacePrepareResult("error", {
      backendType: "ssh",
      meta: { error: `SSH connection failed: ${probe.stderr}`, host: config.host },
    });
  }

  // Ensure workspace directory exists
  await runSSH([
    ...sshArgs, target,
    "mkdir", "-p", config.workspacePath,
  ]).catch(() => {});

  return workspacePrepareResult("ready", {
    backendType: "ssh",
    cwd: config.workspacePath,
    env: config.env || {},
    spawnOptions: {
      target,
      sshArgs,
      workspacePath: config.workspacePath,
    },
    meta: { host: config.host, user: config.user || null, port: config.port || 22 },
  });
}

export async function teardown(_config, _prepared) {
  // SSH connections are stateless per-command — nothing to clean up.
  return workspaceTeardownResult("cleaned", { note: "SSH connections are per-command, no teardown needed" });
}

export async function status(config) {
  if (!config.host) {
    return workspaceStatusResult("error", {
      backendType: "ssh",
      details: { error: "missing host" },
    });
  }

  const target = sshTarget(config);
  const sshArgs = buildSSHArgs(config);
  const probe = await runSSH([...sshArgs, target, "echo", "ok"]);

  return workspaceStatusResult(probe.code === 0 ? "ready" : "unreachable", {
    backendType: "ssh",
    details: {
      host: config.host,
      user: config.user || null,
      port: config.port || 22,
      workspacePath: config.workspacePath || null,
    },
  });
}

export async function healthCheck() {
  const result = await runSSH(["-V"]).catch(() => null);
  // ssh -V writes to stderr
  return {
    available: result !== null,
    backendType: "ssh",
  };
}

export function resolveSpawnOptions(prepared, command, args) {
  return {
    env: { ...process.env, ...prepared.env },
    stdio: ["ignore", "pipe", "pipe"],
  };
}

export function wrapCommand(prepared, command, args) {
  const { target, sshArgs, workspacePath } = prepared.spawnOptions;
  return {
    command: "ssh",
    args: [...sshArgs, target, "cd", workspacePath, "&&", command, ...args],
  };
}
