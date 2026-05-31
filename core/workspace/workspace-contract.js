/**
 * Workspace contract types and validation.
 *
 * A workspace is an isolated execution environment where agent phases run.
 * Backends (local, docker, ssh, devcontainer) implement the same interface.
 */

const BACKEND_TYPES = new Set(["local", "docker", "ssh", "devcontainer"]);

export function isValidBackendType(type) {
  return BACKEND_TYPES.has(type);
}

export function validateWorkspaceConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object") {
    return { valid: false, errors: ["config must be an object"] };
  }

  if (!isValidBackendType(config.type)) {
    errors.push(`invalid backend type: ${config.type} (expected: local, docker, ssh, devcontainer)`);
  }

  if (!config.id || typeof config.id !== "string") {
    errors.push("config.id is required");
  }

  if (!config.projectId || typeof config.projectId !== "string") {
    errors.push("config.projectId is required");
  }

  // Backend-specific validation
  if (config.type === "docker") {
    if (!config.image && !config.dockerfile) {
      errors.push("docker backend requires 'image' or 'dockerfile'");
    }
  }

  if (config.type === "ssh") {
    if (!config.host) errors.push("ssh backend requires 'host'");
    if (!config.workspacePath) errors.push("ssh backend requires 'workspacePath'");
  }

  if (config.type === "devcontainer") {
    if (!config.configPath && !config.image) {
      errors.push("devcontainer backend requires 'configPath' or 'image'");
    }
  }

  return { valid: errors.length === 0, errors };
}

export function workspacePrepareResult(status, data = {}) {
  return {
    status,
    backendType: data.backendType,
    cwd: data.cwd || null,
    env: data.env || {},
    spawnOptions: data.spawnOptions || {},
    meta: data.meta || {},
    preparedAt: new Date().toISOString(),
  };
}

export function workspaceTeardownResult(status, data = {}) {
  return {
    status,
    cleanedAt: new Date().toISOString(),
    ...data,
  };
}

export function workspaceStatusResult(status, data = {}) {
  return {
    status,
    backendType: data.backendType,
    ready: status === "ready",
    details: data.details || {},
    checkedAt: new Date().toISOString(),
  };
}

export const WORKSPACE_EVENTS = {
  PREPARING: "workspace:preparing",
  PREPARED: "workspace:prepared",
  TEARDOWN: "workspace:teardown",
  FAILED: "workspace:failed",
  STATUS_CHECK: "workspace:status_check",
};
