import path from "node:path";

export function runtimeDataRoot(cpbRoot) {
  return path.join(path.resolve(cpbRoot), "cpb-task");
}

export function runtimeDataPath(cpbRoot, ...parts) {
  return path.join(runtimeDataRoot(cpbRoot), ...parts);
}

