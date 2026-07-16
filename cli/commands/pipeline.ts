import type { LooseRecord } from "../../shared/types.js";
import path from "node:path";
import { readFile } from "node:fs/promises";

export function buildAgentMetadata({
  agent,
  planAgent,
  executeAgent,
  verifyAgent,
  reviewAgent,
  planVariant,
  executeVariant,
  verifyVariant,
  reviewVariant,
}) {
  const result: LooseRecord = {};
  const roles = [
    ["planner", planAgent, planVariant],
    ["executor", executeAgent, executeVariant],
    ["verifier", verifyAgent, verifyVariant],
    ["reviewer", reviewAgent, reviewVariant],
  ];
  let hasAny = false;
  for (const [role, roleAgent, roleVariant] of roles) {
    const effectiveAgent = roleAgent || agent;
    if (effectiveAgent || roleVariant) {
      hasAny = true;
      result[role] = {
        agent: effectiveAgent || null,
        variant: roleVariant || undefined,
      };
    }
  }
  return hasAny ? result : undefined;
}

function parseCommonFlags(args: string[]) {
  let workflow = "standard";
  let planMode = "auto";
  let triageMode = null;
  let workflowExplicit = false;
  let planModeExplicit = false;
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
  let issueNumber = "";
  let issueUrl = "";
  let repo = "";
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workflow" && args[i + 1]) {
      workflow = args[++i];
      workflowExplicit = true;
    } else if (arg === "--plan-mode" && args[i + 1]) {
      planMode = args[++i];
      planModeExplicit = true;
    } else if (arg === "--triage" && args[i + 1]) {
      triageMode = args[++i];
    } else if (arg === "--retries" && args[i + 1]) {
      retries = parseInt(args[++i], 10) || 3;
    } else if (arg === "--agent" && args[i + 1]) {
      agent = args[++i];
    } else if (arg === "--model" && args[i + 1]) {
      model = args[++i];
    } else if (arg === "--plan-agent" && args[i + 1]) {
      planAgent = args[++i];
    } else if (arg === "--execute-agent" && args[i + 1]) {
      executeAgent = args[++i];
    } else if (arg === "--verify-agent" && args[i + 1]) {
      verifyAgent = args[++i];
    } else if (arg === "--review-agent" && args[i + 1]) {
      reviewAgent = args[++i];
    } else if (arg === "--plan-variant" && args[i + 1]) {
      planVariant = args[++i];
    } else if (arg === "--execute-variant" && args[i + 1]) {
      executeVariant = args[++i];
    } else if (arg === "--verify-variant" && args[i + 1]) {
      verifyVariant = args[++i];
    } else if (arg === "--review-variant" && args[i + 1]) {
      reviewVariant = args[++i];
    } else if (arg === "--issue-number" && args[i + 1]) {
      issueNumber = args[++i];
    } else if (arg === "--issue-url" && args[i + 1]) {
      issueUrl = args[++i];
    } else if (arg === "--repo" && args[i + 1]) {
      repo = args[++i];
    } else {
      positional.push(arg);
    }
  }

  return {
    positional,
    workflow,
    planMode,
    triageMode,
    workflowExplicit,
    planModeExplicit,
    retries,
    agent,
    model,
    planAgent,
    executeAgent,
    verifyAgent,
    reviewAgent,
    planVariant,
    executeVariant,
    verifyVariant,
    reviewVariant,
    issueNumber,
    issueUrl,
    repo,
  };
}

/**
 * Pipeline / Run command — unified entry point.
 *
 * cpb pipeline <project> "<task>" [retries]  [--flags...]
 * cpb run "<task>" [--project <id>] [--flags...]
 *
 * Both resolve to the same enqueue call. "run" mode auto-detects project
 * from cwd/package.json when --project is not specified.
 */
export async function run(args, { cpbRoot, executorRoot, command }: LooseRecord = {}) {
  const isRunMode = command === "run" || args[0] === "--project" || args[0]?.startsWith('"') || args[0]?.startsWith("'") || !args[0]?.match(/^[a-zA-Z0-9-]+$/);

  // Detect: if --project flag is present, treat as run mode
  const hasProjectFlag = args.includes("--project");
  const effectiveRunMode = isRunMode || hasProjectFlag;

  if (args.includes("--help") || args.includes("-h")) {
    if (effectiveRunMode) {
      console.log(`Usage: cpb run "<task>" [--project <id>] [--workflow <name>] [--plan-mode <mode>] [flags]

Enqueue a task through the plan -> execute -> verify pipeline.
Auto-detects project from cwd, package.json, or directory name.

Options:
  --project <id>       Target project ID
  --workflow <n>       Workflow name (default: standard)
  --plan-mode <mode>   auto|none|light|full|parent (default: auto)
  --triage <mode>      auto|rules|acp|none
  --retries <n>        Max pipeline retries (default: 3)
  --agent <name>       Agent for all phases
  --model <profile>    Model profile
  --help               Show this help`);
    } else {
      console.log(`Usage: cpb pipeline [--interactive] <project> "<task>" [retries] [flags]

Full plan -> execute -> verify pipeline.

Options:
  --plan-mode <mode>   auto|none|light|full|parent (default: auto)
  --workflow <n>       Workflow name (default: standard)
  --triage <mode>      auto|rules|acp|none
  --agent <name>       Agent for all phases
  --model <profile>    Model profile
  --issue-number <num> Link to GitHub issue
  --issue-url <url>    Link to GitHub issue URL
  --repo <owner/repo>  GitHub repository
  --help               Show this help`);
    }
    return 0;
  }

  const parsed = parseCommonFlags(args);
  let project: string;
  let task: string;

  if (effectiveRunMode) {
    // run mode: task is positional, project is --project flag or auto-detected
    task = parsed.positional.join(" ").trim();
    if (!task) {
      console.error("Usage: cpb run \"<task>\" [--project <id>]");
      return 1;
    }
    project = parsed.positional.find((_, i) => args.indexOf("--project") >= 0 && args[args.indexOf("--project") + 1]) || "";
    // Extract --project value
    const projectFlagIdx = args.indexOf("--project");
    project = projectFlagIdx >= 0 && args[projectFlagIdx + 1] ? args[projectFlagIdx + 1] : "";

    if (!project) {
      // Auto-detect project from cwd
      try {
        const { resolveHubRoot, loadRegistry } = await import("../../server/services/hub/hub-registry.js");
        const hubRoot = resolveHubRoot(cpbRoot);
        const registry = await loadRegistry(hubRoot);
        const cwd = path.resolve(process.cwd());
        for (const [id, proj] of Object.entries(registry.projects || {}) as Array<[string, LooseRecord]>) {
          const src = proj.sourcePath && path.resolve(proj.sourcePath);
          if (src === cwd || cwd.startsWith(src + path.sep)) {
            project = id;
            break;
          }
        }
      } catch {}

      if (!project) {
        try {
          const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
          if (pkg.name) project = pkg.name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "");
        } catch {}
      }

      if (!project) {
        project = path.basename(process.cwd()).replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "");
      }
    }
  } else {
    // pipeline mode: project is first positional, task is second
    project = parsed.positional[0];
    task = parsed.positional.slice(1).join(" ").trim();
    if (!project || !task) {
      console.error("Usage: cpb pipeline <project> \"<task>\" [retries]");
      return 1;
    }
  }

  const resolvedCpbRoot = cpbRoot || process.env.CPB_ROOT || process.cwd();
  const hubRoot = process.env.CPB_HUB_ROOT || path.join(process.env.HOME || ".", ".cpb");

  const { resolveTaskRoute } = await import("../../core/workflow/auto-route.js");
  const route = resolveTaskRoute({
    task,
    workflow: parsed.workflow,
    planMode: parsed.planMode,
    triageMode: parsed.triageMode,
    workflowExplicit: parsed.workflowExplicit,
    planModeExplicit: parsed.planModeExplicit,
    actor: "cli",
  } as LooseRecord);

  const { enqueue } = await import(path.join(executorRoot, "server", "services", "hub", "hub-queue.js"));
  const { getProject } = await import(path.join(executorRoot, "server", "services", "hub", "hub-registry.js"));

  let registered;
  try { registered = await getProject(hubRoot, project); } catch { registered = null; }

  const entry = await enqueue(hubRoot, {
    projectId: project,
    sourcePath: registered?.sourcePath || null,
    priority: "P2",
    description: task,
    type: "cli_pipeline",
    metadata: {
      source: "cli",
      workflow: route.workflow,
      planMode: route.planMode,
      triageMode: parsed.triageMode,
      routeDecision: route.decision || undefined,
      actor: "cli",
      autoFinalize: true,
      agent: parsed.agent || undefined,
      model: parsed.model || undefined,
      maxRetries: parsed.retries,
      issueNumber: parsed.issueNumber ? Number(parsed.issueNumber) : null,
      issueUrl: parsed.issueUrl || null,
      repo: parsed.repo || registered?.github?.fullName || null,
      issueTitle: task,
      requestedAt: new Date().toISOString(),
      agents: buildAgentMetadata({
        agent: parsed.agent,
        planAgent: parsed.planAgent,
        executeAgent: parsed.executeAgent,
        verifyAgent: parsed.verifyAgent,
        reviewAgent: parsed.reviewAgent,
        planVariant: parsed.planVariant,
        executeVariant: parsed.executeVariant,
        verifyVariant: parsed.verifyVariant,
        reviewVariant: parsed.reviewVariant,
      }),
    },
  });

  console.log(`Enqueued ${entry.id} (project=${project})`);
  return 0;
}
