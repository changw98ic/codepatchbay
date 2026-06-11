// Server-facing runtime path facade over core/paths.js.
// Keep the exported surface explicit so boundary checks can reason about it.
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
