// Re-export from core/paths.js — path resolution is pure logic, belongs in core.
// This file exists for backward compatibility with existing imports.
export {
  runtimeDataRoot,
  runtimeDataPath,
  cpbHome,
  defaultProjectRuntimeRoot,
  projectRuntimeRoot,
  projectRuntimePath,
  resolveDataRoot,
  dataPath,
} from "../../core/paths.js";
