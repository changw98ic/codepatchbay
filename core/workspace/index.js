/**
 * Workspace module barrel export.
 *
 * This is the public API for the workspace subsystem.
 * Import from here to access all workspace functionality.
 */

export {
  isValidBackendType,
  validateWorkspaceConfig,
  workspacePrepareResult,
  workspaceTeardownResult,
  workspaceStatusResult,
  WORKSPACE_EVENTS,
} from "./workspace-contract.js";

export {
  defaultWorkspaceConfig,
  workspaceConfigPath,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  resolveWorkspaceConfig,
  mergeWorkspaceEnv,
} from "./workspace-config.js";

export {
  getBackend,
  supportedBackendTypes,
  resolveBackend,
  healthCheckAll,
} from "./workspace-resolver.js";
