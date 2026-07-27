import type { LooseRecord } from "../../shared/types.js";
import path from "node:path";

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

export function parseCommonFlags(args: string[]) {
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
  let project = "";
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
    } else if (arg === "--project" && args[i + 1]) {
      project = args[++i];
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
    project,
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
 * Pipeline command.
 *
 * cpb pipeline <project> "<task>" [--flags...]
 */
export async function run(args, { cpbRoot, executorRoot }: LooseRecord = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: cpb pipeline <project> "<task>" [flags]

Full plan -> execute -> verify pipeline.

Options:
  --plan-mode <mode>   auto|none|light|full|parent (default: auto)
  --workflow <n>       Workflow name (default: standard)
  --triage <mode>      auto|rules|acp|none
  --agent <name>       Agent for all phases
  --plan-agent <name>  Agent for the planning phase
  --execute-agent <name> Agent for the execution phase
  --verify-agent <name> Agent for the verification phase
  --review-agent <name> Agent for the review phase
  --retries <n>        Max pipeline retries (default: 3)
  --model <profile>    Model profile
  --issue-number <num> Link to GitHub issue
  --issue-url <url>    Link to GitHub issue URL
  --repo <owner/repo>  GitHub repository
  --help               Show this help`);
    return 0;
  }

  const parsed = parseCommonFlags(args);
  if (parsed.project) {
    console.error("Usage: cpb pipeline <project> \"<task>\" [--retries <n>]");
    return 1;
  }
  const project = parsed.positional[0];
  const task = parsed.positional.slice(1).join(" ").trim();
  if (!project || !task) {
    console.error("Usage: cpb pipeline <project> \"<task>\" [--retries <n>]");
    return 1;
  }

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
