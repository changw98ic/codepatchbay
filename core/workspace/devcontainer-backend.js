/**
 * Devcontainer workspace backend.
 *
 * Builds on Docker, using devcontainer.json for configuration.
 * Supports both Dockerfile and image-based devcontainers.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { workspacePrepareResult, workspaceTeardownResult, workspaceStatusResult } from "./workspace-contract.js";

const DEVCENTER_FILENAME = ".devcontainer.json";
const DEVCENTER_DIR = ".devcontainer";

async function readDevcontainerConfig(sourcePath, configPath) {
  // Try explicit path first
  if (configPath) {
    const resolved = path.resolve(sourcePath, configPath);
    try {
      const raw = await readFile(resolved, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // Try .devcontainer/devcontainer.json
  try {
    const raw = await readFile(
      path.join(sourcePath, DEVCENTER_DIR, "devcontainer.json"),
      "utf8",
    );
    return JSON.parse(raw);
  } catch {}

  // Try .devcontainer.json
  try {
    const raw = await readFile(
      path.join(sourcePath, DEVCENTER_FILENAME),
      "utf8",
    );
    return JSON.parse(raw);
  } catch {}

  return null;
}

function resolveImage(dcConfig, fallbackImage) {
  // devcontainer.json image field
  if (dcConfig?.image) return dcConfig.image;

  // Check for dockerFile or dockerComposeFile
  // For now, if no image, use the fallback
  return fallbackImage || "node:20-bookworm";
}

function resolveWorkspaceFolder(dcConfig) {
  if (dcConfig?.workspaceFolder) return dcConfig.workspaceFolder;
  if (dcConfig?.workspaceMount) {
    const parts = dcConfig.workspaceMount.split(",");
    for (const part of parts) {
      if (part.startsWith("destination=")) return part.slice("destination=".length);
    }
  }
  return "/workspace";
}

function resolveContainerEnv(dcConfig) {
  const env = {};
  if (dcConfig?.containerEnv) {
    Object.assign(env, dcConfig.containerEnv);
  }
  if (dcConfig?.remoteEnv) {
    Object.assign(env, dcConfig.remoteEnv);
  }
  return env;
}

// Delegate to docker-backend for actual container management.
// We use dynamic import to avoid circular dependency issues.

async function getDockerBackend() {
  return import("./docker-backend.js");
}

export async function prepare(config, { sourcePath } = {}) {
  const projectPath = sourcePath || config.sourcePath;
  if (!projectPath) {
    return workspacePrepareResult("error", {
      backendType: "devcontainer",
      meta: { error: "devcontainer backend requires sourcePath" },
    });
  }

  const dcConfig = await readDevcontainerConfig(projectPath, config.configPath);
  if (!dcConfig && !config.image) {
    return workspacePrepareResult("error", {
      backendType: "devcontainer",
      meta: { error: `no devcontainer.json found in ${projectPath} and no image specified` },
    });
  }

  const image = resolveImage(dcConfig, config.image);
  const workdir = config.workdir || resolveWorkspaceFolder(dcConfig);
  const dcEnv = resolveContainerEnv(dcConfig);

  // Build a docker-compatible config
  const dockerConfig = {
    id: config.id,
    projectId: config.projectId,
    type: "docker",
    image,
    workdir,
    sourcePath: projectPath,
    env: { ...dcEnv, ...(config.env || {}) },
    memory: config.memory,
    cpus: config.cpus,
    networkMode: config.networkMode,
  };

  const docker = await getDockerBackend();
  const result = await docker.prepare(dockerConfig, { sourcePath: projectPath });

  // Override backendType in the result
  if (result.status === "ready") {
    result.backendType = "devcontainer";
    result.meta.devcontainer = dcConfig ? true : false;
    result.meta.image = image;
  }

  return result;
}

export async function teardown(config, prepared) {
  const docker = await getDockerBackend();

  const dockerConfig = {
    id: config.id,
    projectId: config.projectId,
    keepContainer: config.keepContainer,
  };

  const result = await docker.teardown(dockerConfig, prepared);
  result.backendType = "devcontainer";
  return result;
}

export async function status(config) {
  const docker = await getDockerBackend();

  const dockerConfig = {
    id: config.id,
    projectId: config.projectId,
  };

  const result = await docker.status(dockerConfig);
  result.backendType = "devcontainer";
  return result;
}

export async function healthCheck() {
  const docker = await getDockerBackend();
  const result = await docker.healthCheck();
  result.backendType = "devcontainer";
  return result;
}

export function resolveSpawnOptions(prepared, command, args) {
  // Same as docker — commands execute inside the container
  return {
    cwd: prepared.cwd,
    env: { ...process.env, ...prepared.env },
    stdio: ["ignore", "pipe", "pipe"],
  };
}

export function wrapCommand(prepared, command, args) {
  const name = prepared.spawnOptions?.containerName;
  if (!name) throw new Error("devcontainer backend: no container name in prepared state");

  return {
    command: "docker",
    args: ["exec", name, command, ...args],
  };
}
