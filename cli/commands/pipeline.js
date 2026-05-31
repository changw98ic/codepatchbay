import path from "node:path";
import { buildAgentMetadata } from "./run.js";

export async function run(args, { cpbRoot, executorRoot }) {
  const interactive = args[0] === "--interactive";
  if (interactive) args.shift();

  let planMode = "auto";
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
  let workflow = "standard";
  let issueNumber = "";
  let issueUrl = "";
  let repo = "";

  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--plan-mode" && args[i + 1]) {
      planMode = args[++i];
    } else if (args[i] === "--agent" && args[i + 1]) {
      agent = args[++i];
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === "--workflow" && args[i + 1]) {
      workflow = args[++i];
    } else if (args[i] === "--issue-number" && args[i + 1]) {
      issueNumber = args[++i];
    } else if (args[i] === "--issue-url" && args[i + 1]) {
      issueUrl = args[++i];
    } else if (args[i] === "--repo" && args[i + 1]) {
      repo = args[++i];
    } else if (args[i] === "--plan-agent" && args[i + 1]) {
      planAgent = args[++i];
    } else if (args[i] === "--execute-agent" && args[i + 1]) {
      executeAgent = args[++i];
    } else if (args[i] === "--verify-agent" && args[i + 1]) {
      verifyAgent = args[++i];
    } else if (args[i] === "--review-agent" && args[i + 1]) {
      reviewAgent = args[++i];
    } else if (args[i] === "--plan-variant" && args[i + 1]) {
      planVariant = args[++i];
    } else if (args[i] === "--execute-variant" && args[i + 1]) {
      executeVariant = args[++i];
    } else if (args[i] === "--verify-variant" && args[i + 1]) {
      verifyVariant = args[++i];
    } else if (args[i] === "--review-variant" && args[i + 1]) {
      reviewVariant = args[++i];
    } else {
      filtered.push(args[i]);
    }
  }

  const project = filtered[0];
  const task = filtered[1];
  const retries = parseInt(filtered[2] || "3", 10);

  if (!project || !task) {
    console.error(
      "Usage: cpb pipeline [--interactive] [--plan-mode auto|none|light|full|parent] " +
        "[--agent <name>] [--model <profile>] [--workflow standard|issue] " +
        "[--issue-number <num>] [--issue-url <url>] [--repo <owner/repo>] " +
        "<project> '<task>' [retries]"
    );
    process.exit(1);
  }

  if (interactive) {
    console.error("Interactive mode not yet implemented in Node CLI");
    process.exit(1);
  }

  const resolvedCpbRoot = cpbRoot || process.env.CPB_ROOT || process.cwd();
  const hubRoot =
    process.env.CPB_HUB_ROOT || path.join(process.env.HOME || ".", ".cpb");

  const { enqueue } = await import(
    path.join(executorRoot, "server", "services", "hub-queue.js")
  );
  const { getProject } = await import(
    path.join(executorRoot, "server", "services", "hub-registry.js")
  );

  let registered;
  try {
    registered = await getProject(hubRoot, project);
  } catch {
    registered = null;
  }

  const entry = await enqueue(hubRoot, {
    projectId: project,
    sourcePath: registered?.sourcePath || null,
    priority: "P2",
    description: task,
    type: "cli_pipeline",
    metadata: {
      source: "cli",
      workflow,
      planMode,
      actor: "cli",
      autoFinalize: true,
      agent: agent || undefined,
      model: model || undefined,
      issueNumber: issueNumber ? Number(issueNumber) : null,
      issueUrl: issueUrl || null,
      repo: repo || registered?.github?.fullName || null,
      issueTitle: task,
      requestedAt: new Date().toISOString(),
      agents: buildAgentMetadata({
        agent,
        planAgent,
        executeAgent,
        verifyAgent,
        reviewAgent,
        planVariant,
        executeVariant,
        verifyVariant,
        reviewVariant,
      }),
    },
  });

  console.log(`Enqueued ${entry.id} (project=${project})`);
  return 0;
}
