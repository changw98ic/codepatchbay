/**
 * Docker workspace backend.
 *
 * Manages container lifecycle for isolated phase execution.
 * Uses the Docker CLI (requires docker in PATH).
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { workspacePrepareResult, workspaceTeardownResult, workspaceStatusResult } from "./workspace-contract.js";

const DEFAULT_IMAGE = "node:20-bookworm";
const DEFAULT_WORKDIR = "/workspace";
const LABEL = "cpb.workspace";

function runDocker(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
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

function containerName(config) {
  return `cpb-${config.projectId}-${config.id}`;
}

function buildEnvFlags(env = {}) {
  const flags = [];
  for (const [key, value] of Object.entries(env)) {
    flags.push("-e", `${key}=${value}`);
  }
  return flags;
}

export async function prepare(config, { sourcePath } = {}) {
  const name = containerName(config);
  const image = config.image || DEFAULT_IMAGE;
  const workdir = config.workdir || DEFAULT_WORKDIR;
  const mountSource = sourcePath || config.sourcePath;

  if (!mountSource) {
    return workspacePrepareResult("error", {
      backendType: "docker",
      meta: { error: "docker backend requires sourcePath for volume mount" },
    });
  }

  const mountTarget = workdir;

  // Build docker run args
  const args = [
    "run", "-d",
    "--name", name,
    "--label", `${LABEL}=${config.id}`,
    "-w", mountTarget,
    "-v", `${path.resolve(mountSource)}:${mountTarget}`,
    ...buildEnvFlags(config.env || {}),
  ];

  // Resource limits
  if (config.memory) args.push("--memory", config.memory);
  if (config.cpus) args.push("--cpus", String(config.cpus));
  if (config.networkMode) args.push("--network", config.networkMode);

  // Keep container alive
  args.push(image, "sleep", "infinity");

  // Check if container already exists
  const inspectResult = await runDocker(["inspect", name]).catch(() => null);
  if (inspectResult && inspectResult.code === 0) {
    // Container exists — check if running
    try {
      const info = JSON.parse(inspectResult.stdout);
      if (info[0]?.State?.Running) {
        return workspacePrepareResult("ready", {
          backendType: "docker",
          cwd: mountTarget,
          env: config.env || {},
          spawnOptions: { containerName: name, cwd: mountTarget },
          meta: { containerId: info[0].Id, image, reused: true },
        });
      }
      // Start stopped container
      await runDocker(["start", name]);
      return workspacePrepareResult("ready", {
        backendType: "docker",
        cwd: mountTarget,
        env: config.env || {},
        spawnOptions: { containerName: name, cwd: mountTarget },
        meta: { image, reused: true },
      });
    } catch {}
  }

  const result = await runDocker(args);
  if (result.code !== 0) {
    return workspacePrepareResult("error", {
      backendType: "docker",
      meta: { error: `docker run failed: ${result.stderr}`, image },
    });
  }

  return workspacePrepareResult("ready", {
    backendType: "docker",
    cwd: mountTarget,
    env: config.env || {},
    spawnOptions: { containerName: name, cwd: mountTarget },
    meta: { containerId: result.stdout.trim(), image, reused: false },
  });
}

export async function teardown(config, _prepared) {
  const name = containerName(config);
  const remove = config.keepContainer ? false : true;

  if (remove) {
    await runDocker(["stop", "-t", "5", name]).catch(() => {});
    await runDocker(["rm", "-f", name]).catch(() => {});
  }

  return workspaceTeardownResult("cleaned", {
    containerRemoved: remove,
    containerName: name,
  });
}

export async function status(config) {
  const name = containerName(config);

  const inspectResult = await runDocker(["inspect", name]).catch(() => null);
  if (!inspectResult || inspectResult.code !== 0) {
    return workspaceStatusResult("not_created", {
      backendType: "docker",
      details: { containerName: name },
    });
  }

  try {
    const info = JSON.parse(inspectResult.stdout)[0];
    const running = info.State?.Running === true;
    return workspaceStatusResult(running ? "ready" : "stopped", {
      backendType: "docker",
      details: {
        containerName: name,
        containerId: info.Id,
        image: info.Config?.Image,
        running,
        status: info.State?.Status,
        startedAt: info.State?.StartedAt,
      },
    });
  } catch {
    return workspaceStatusResult("error", {
      backendType: "docker",
      details: { containerName: name, error: "failed to parse docker inspect output" },
    });
  }
}

export async function healthCheck() {
  const result = await runDocker(["version", "--format", "{{.Client.Version}}"]);
  if (result.code !== 0) {
    return { available: false, backendType: "docker", error: "docker not available" };
  }
  return { available: true, backendType: "docker", version: result.stdout.trim() };
}

export function resolveSpawnOptions(prepared, command, args) {
  const name = prepared.spawnOptions?.containerName;
  if (!name) throw new Error("docker backend: no container name in prepared state");

  return {
    cwd: prepared.cwd,
    env: { ...process.env, ...prepared.env },
    stdio: ["ignore", "pipe", "pipe"],
  };
}

export function wrapCommand(prepared, command, args) {
  const name = prepared.spawnOptions?.containerName;
  if (!name) throw new Error("docker backend: no container name in prepared state");

  return {
    command: "docker",
    args: ["exec", name, command, ...args],
  };
}
