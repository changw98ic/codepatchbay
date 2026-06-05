import { spawn } from "node:child_process";
import path from "node:path";
import { buildChildEnv } from "../../core/policy/child-env.js";

export async function runEvolveMultiCli(args, { cpbRoot, executorRoot, env = process.env } = {}) {
  const root = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const execRoot = path.resolve(executorRoot || env.CPB_EXECUTOR_ROOT || root);
  const child = spawn(process.execPath, [path.join(execRoot, "runtime", "evolve", "multi-evolve.js"), ...args], {
    stdio: "inherit",
    env: buildChildEnv(env, {
      CPB_ROOT: root,
      CPB_EXECUTOR_ROOT: execRoot,
      CPB_HUB_ROOT: env.CPB_HUB_ROOT || "",
    }),
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(Number.isInteger(code) ? code : 1));
  });
}
