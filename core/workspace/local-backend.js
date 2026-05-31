/**
 * Local workspace backend.
 *
 * Passthrough to the host filesystem. This is the default backend
 * and represents current CPB behavior — phases run directly on the host.
 */

import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workspacePrepareResult, workspaceTeardownResult, workspaceStatusResult } from "./workspace-contract.js";

export async function prepare(config, { sourcePath } = {}) {
  const cwd = config.cwd || sourcePath || process.cwd();

  try {
    await access(cwd, constants.R_OK | constants.W_OK);
  } catch {
    return workspacePrepareResult("error", {
      backendType: "local",
      cwd,
      meta: { error: `workspace directory not accessible: ${cwd}` },
    });
  }

  return workspacePrepareResult("ready", {
    backendType: "local",
    cwd,
    env: config.env || {},
    spawnOptions: { cwd },
    meta: { hostname: os.hostname() },
  });
}

export async function teardown(_config, _prepared) {
  return workspaceTeardownResult("cleaned");
}

export async function status(config, { sourcePath } = {}) {
  const cwd = config.cwd || sourcePath || process.cwd();

  try {
    await access(cwd, constants.R_OK);
    return workspaceStatusResult("ready", {
      backendType: "local",
      details: { cwd, accessible: true },
    });
  } catch {
    return workspaceStatusResult("error", {
      backendType: "local",
      details: { cwd, accessible: false, error: "directory not accessible" },
    });
  }
}

export async function healthCheck() {
  return { available: true, backendType: "local" };
}

export function resolveSpawnOptions(prepared, command, args) {
  return {
    cwd: prepared.cwd,
    env: { ...process.env, ...prepared.env },
    stdio: ["ignore", "pipe", "pipe"],
  };
}

export function wrapCommand(_prepared, command, args) {
  return { command, args };
}
