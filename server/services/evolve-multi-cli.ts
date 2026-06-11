import { spawn } from "node:child_process";
import path from "node:path";
import { buildChildEnv } from "../../core/policy/child-env.js";
import { isWorkflowName } from "../../core/workflow/definition.js";
import { getProject, resolveHubRoot } from "./hub-registry.js";

function valueAfter(args: string[], index: number, flag: string) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function parseProjectRuntimeHints(args: string[], env: NodeJS.ProcessEnv) {
  const parsed: { project: string | null; workflow: string } = {
    project: null,
    workflow: env.CPB_MULTI_EVOLVE_WORKFLOW || "standard",
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project") {
      parsed.project = valueAfter(args, i, arg);
      i += 1;
    } else if (arg === "--workflow") {
      parsed.workflow = valueAfter(args, i, arg);
      i += 1;
    }
  }
  if (!isWorkflowName(parsed.workflow)) {
    throw new Error(`invalid workflow: ${parsed.workflow}`);
  }
  return parsed;
}

export async function runEvolveMultiCli(args: string[], { cpbRoot, executorRoot, env = process.env }: { cpbRoot?: string; executorRoot?: string; env?: NodeJS.ProcessEnv } = {}) {
  const root = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const execRoot = path.resolve(executorRoot || env.CPB_EXECUTOR_ROOT || root);
  const parsed = parseProjectRuntimeHints(args, env);
  const childEnv: Record<string, string | undefined> = {
    CPB_ROOT: root,
    CPB_EXECUTOR_ROOT: execRoot,
    CPB_HUB_ROOT: env.CPB_HUB_ROOT || "",
  };
  if (parsed.project) {
    const hubRoot = resolveHubRoot(root);
    const project = await getProject(hubRoot, parsed.project);
    if (!project?.projectRuntimeRoot) {
      throw new Error(`project runtime root required for project '${parsed.project}'`);
    }
    childEnv.CPB_PROJECT_RUNTIME_ROOT = project.projectRuntimeRoot;
  }
  const child = spawn(process.execPath, [path.join(execRoot, "runtime", "evolve", "multi-evolve.js"), ...args], {
    stdio: "inherit",
    env: buildChildEnv(env, childEnv),
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(Number.isInteger(code) ? code : 1));
  });
}
