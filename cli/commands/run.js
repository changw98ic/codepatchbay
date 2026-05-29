import { readFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  return `Usage: cpb run "<task>" [--project <id>] [--workflow <name>] [--plan-mode <mode>] [--triage <mode>]

Run a task through the plan -> execute -> verify pipeline.

If --project is omitted, infers the project from the current working
directory (Hub registry match or package.json name).

Options:
  --project <id>       Target project ID
  --workflow <n>       Workflow name (default: standard)
  --plan-mode <mode>   Plan mode: auto, none, light, full, parent (default: auto)
  --triage <mode>      Triage mode: auto, rules, acp, none
  --retries <n>        Max pipeline retries (default: 3)
  --help               Show this help`;
}

export async function run(args, { cpbRoot, executorRoot }) {
  const positional = [];
  let projectId;
  let retries = 3;
  let workflow = "standard";
  let planMode = "auto";
  let triageMode = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return 0;
    }
    if (arg === "--project") {
      projectId = args[++i];
      if (!projectId) {
        console.error("Error: --project requires a value");
        return 1;
      }
    } else if (arg === "--workflow") {
      workflow = args[++i];
      if (!workflow) {
        console.error("Error: --workflow requires a value");
        return 1;
      }
    } else if (arg === "--plan-mode") {
      planMode = args[++i];
      if (!planMode) {
        console.error("Error: --plan-mode requires a value");
        return 1;
      }
      if (!["auto", "none", "light", "full", "parent"].includes(planMode)) {
        console.error(`Error: invalid --plan-mode '${planMode}'`);
        return 1;
      }
    } else if (arg === "--triage") {
      triageMode = args[++i];
      if (!triageMode) {
        console.error("Error: --triage requires a value");
        return 1;
      }
      if (!["auto", "rules", "acp", "none"].includes(triageMode)) {
        console.error(`Error: invalid --triage '${triageMode}'`);
        return 1;
      }
    } else if (arg === "--retries") {
      retries = args[++i];
      if (!retries) {
        console.error("Error: --retries requires a value");
        return 1;
      }
    } else {
      positional.push(arg);
    }
  }

  const task = positional.join(" ").trim();
  if (!task) {
    console.error(usage());
    return 1;
  }

  if (!projectId) {
    // Try Hub registry match on cwd
    try {
      const { resolveHubRoot, loadRegistry } = await import("../../server/services/hub-registry.js");
      const hubRoot = resolveHubRoot(cpbRoot);
      const registry = await loadRegistry(hubRoot);
      const cwd = path.resolve(process.cwd());
      for (const [id, proj] of Object.entries(registry.projects || {})) {
        const src = proj.sourcePath && path.resolve(proj.sourcePath);
        if (src === cwd || cwd.startsWith(src + path.sep)) {
          projectId = id;
          break;
        }
      }
    } catch {}

    // Fallback: package.json name from cwd
    if (!projectId) {
      try {
        const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
        if (pkg.name) {
          projectId = pkg.name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "");
        }
      } catch {}
    }

    // Fallback: directory basename
    if (!projectId) {
      projectId = path.basename(process.cwd()).replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    }
  }

  const { runPipeline } = await import("../../bridges/engine-bridge.js");
  return runPipeline({
    project: projectId,
    task,
    workflow,
    planMode,
    triageMode,
    maxRetries: Number.parseInt(String(retries), 10) || 3,
    cpbRoot,
    executorRoot,
  });
}
