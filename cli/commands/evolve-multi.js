import path from "node:path";
import { buildChildEnv } from "../../core/policy/child-env.js";

export async function run(args, { cpbRoot, executorRoot }) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [path.join(executorRoot, "bridges", "multi-evolve.mjs"), ...args], {
    stdio: "inherit",
    env: buildChildEnv(process.env, {
      CPB_ROOT: cpbRoot,
      CPB_EXECUTOR_ROOT: executorRoot,
      CPB_HUB_ROOT: process.env.CPB_HUB_ROOT || "",
    }),
  });
  await new Promise((resolve) => child.on("close", resolve));
}
