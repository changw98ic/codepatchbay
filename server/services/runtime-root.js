import path from "node:path";

export function runtimeDataRoot(flowRoot) {
  return path.join(path.resolve(flowRoot), "flow-task");
}

export function runtimeDataPath(flowRoot, ...parts) {
  return path.join(runtimeDataRoot(flowRoot), ...parts);
}

