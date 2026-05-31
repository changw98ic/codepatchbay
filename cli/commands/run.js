import { readFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  return `Usage: cpb run "<task>" [--project <id>] [--workflow <name>] [--plan-mode <mode>] [--triage <mode>]

Enqueue a task through the plan -> execute -> verify pipeline.
The Hub worker will claim and execute it.

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
  let workflow = "standard";
  let planMode = "auto";
  let triageMode = null;
  let retries = 3;
  let agent = "";
  let model = "";
  let planAgent = "";
  let executeAgent = "";
  let verifyAgent = "";
  let reviewAgent = "";
  let planVariant = "";
  let executeVariant = "";
  let verifyVariant = "";
  let reviewVariant = "";

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
    } else if (arg === "--plan-mode") {
      planMode = args[++i];
      if (planMode && !["auto", "none", "light", "full", "parent"].includes(planMode)) {
        console.error(`Error: invalid --plan-mode '${planMode}'`);
        return 1;
      }
    } else if (arg === "--triage") {
      triageMode = args[++i];
    } else if (arg === "--retries") {
      retries = args[++i];
    } else if (arg === "--agent") {
      agent = args[++i];
    } else if (arg === "--model") {
      model = args[++i];
    } else if (arg === "--plan-agent") {
      planAgent = args[++i];
    } else if (arg === "--execute-agent") {
      executeAgent = args[++i];
    } else if (arg === "--verify-agent") {
      verifyAgent = args[++i];
    } else if (arg === "--review-agent") {
      reviewAgent = args[++i];
    } else if (arg === "--plan-variant") {
      planVariant = args[++i];
    } else if (arg === "--execute-variant") {
      executeVariant = args[++i];
    } else if (arg === "--verify-variant") {
      verifyVariant = args[++i];
    } else if (arg === "--review-variant") {
      reviewVariant = args[++i];
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

    if (!projectId) {
      try {
        const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
        if (pkg.name) projectId = pkg.name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "");
      } catch {}
    }

    if (!projectId) {
      projectId = path.basename(process.cwd()).replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    }
  }

  const resolvedCpbRoot = cpbRoot || process.env.CPB_ROOT || process.cwd();
  const hubRoot = process.env.CPB_HUB_ROOT || path.join(process.env.HOME || ".", ".cpb");

  const { enqueue } = await import(path.join(executorRoot, "server", "services", "hub-queue.js"));
  const { getProject } = await import(path.join(executorRoot, "server", "services", "hub-registry.js"));

  let registered;
  try { registered = await getProject(hubRoot, projectId); } catch { registered = null; }

  const entry = await enqueue(hubRoot, {
    projectId,
    sourcePath: registered?.sourcePath || null,
    priority: "P2",
    description: task,
    type: "cli_pipeline",
    metadata: {
      source: "cli",
      workflow,
      planMode,
      triageMode,
      maxRetries: Number.parseInt(String(retries), 10) || 3,
      actor: "cli",
      autoFinalize: true,
      agent: agent || undefined,
      model: model || undefined,
      requestedAt: new Date().toISOString(),
      agents: {
        planner: { agent: planAgent || agent, variant: planVariant },
        executor: { agent: executeAgent || agent, variant: executeVariant },
        verifier: { agent: verifyAgent || agent, variant: verifyVariant },
        reviewer: { agent: reviewAgent || agent, variant: reviewVariant },
      },
    },
  });

  console.log(`Enqueued ${entry.id} (project=${projectId})`);
  return 0;
}
