/**
 * Workspace resolver.
 *
 * Selects and loads the appropriate backend based on workspace config.
 * All backends expose the same interface: prepare, teardown, status, healthCheck,
 * resolveSpawnOptions, wrapCommand.
 */

import * as localBackend from "./local-backend.js";
import * as dockerBackend from "./docker-backend.js";
import * as sshBackend from "./ssh-backend.js";
import * as devcontainerBackend from "./devcontainer-backend.js";

const BACKENDS = {
  local: localBackend,
  docker: dockerBackend,
  ssh: sshBackend,
  devcontainer: devcontainerBackend,
};

export function getBackend(type) {
  const backend = BACKENDS[type];
  if (!backend) throw new Error(`unknown workspace backend: ${type}`);
  return backend;
}

export function supportedBackendTypes() {
  return Object.keys(BACKENDS);
}

export async function resolveBackend(config) {
  const type = config?.type || "local";
  return getBackend(type);
}

export async function healthCheckAll() {
  const results = {};
  for (const [type, backend] of Object.entries(BACKENDS)) {
    try {
      results[type] = await backend.healthCheck();
    } catch (err) {
      results[type] = { available: false, backendType: type, error: err.message };
    }
  }
  return results;
}
