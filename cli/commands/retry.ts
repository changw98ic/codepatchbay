import path from "node:path";

export async function run(args: string[], { executorRoot }: { cpbRoot?: string; executorRoot: string }) {
  let agent = "";
  let fresh = false;
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) {
      agent = args[++i];
    } else if (args[i] === "--fresh") {
      fresh = true;
    } else {
      filtered.push(args[i]);
    }
  }
  const project = filtered[0];
  const jobId = filtered[1];
  if (!project || !jobId) {
    console.error("Usage: cpb retry <project> <job-id> [--agent <name>] [--fresh]");
    process.exit(1);
  }

  const hubRoot = process.env.CPB_HUB_ROOT || path.join(process.env.HOME || ".", ".cpb");
  const { enqueue } = await import(path.join(executorRoot, "server", "services", "hub-queue.js"));

  const entry = await enqueue(hubRoot, {
    projectId: project,
    priority: "P1",
    description: `Retry job ${jobId}`,
    type: "cli_retry",
    metadata: {
      source: "cli",
      retryJobId: jobId,
      retryAgent: agent || undefined,
      forceFreshSession: fresh || undefined,
      actor: "cli",
      requestedAt: new Date().toISOString(),
    },
  });

  console.log(`Enqueued retry ${(entry as { id: string }).id} for job ${jobId} (project=${project})`);
  return 0;
}
