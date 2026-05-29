import { HubOrchestrator } from "../../server/orchestrator/hub-orchestrator.js";
import { resolveHubRoot } from "../../server/services/hub-registry.js";

export async function run(args, ctx) {
  return handleHubOrchCommand(args, ctx);
}

async function handleHubOrchCommand(args) {
  const subcommand = args[0];
  const cpbRoot = process.env.CPB_ROOT || process.cwd();
  const hubRoot = resolveHubRoot(cpbRoot);

  switch (subcommand) {
    case "start":
      return startOrchestrator(cpbRoot, hubRoot);
    case "status":
      return showStatus(hubRoot);
    case "stop":
      return stopOrchestrator(hubRoot);
    case "workers":
      return listWorkers(hubRoot);
    case "assignments":
      return listAssignments(hubRoot);
    default:
      console.log(`Usage: cpb hub-orch <start|status|stop|workers|assignments>`);
      return 1;
  }
}

async function startOrchestrator(cpbRoot, hubRoot) {
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot);

  // Graceful shutdown on signals
  const shutdown = async (signal) => {
    process.stderr.write(`\n[hub-orch] received ${signal}, stopping...\n`);
    await orchestrator.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await orchestrator.start();
  console.log("Hub Orchestrator started");
  const status = await orchestrator.status();
  console.log(JSON.stringify(status, null, 2));

  // Block until stop() is called — keeps process alive (P0-4 fix)
  await orchestrator.waitUntilStopped();
  return 0;
}

async function showStatus(hubRoot) {
  const cpbRoot = process.env.CPB_ROOT || process.cwd();
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot);
  const status = await orchestrator.status();
  console.log(JSON.stringify(status, null, 2));
  return 0;
}

async function stopOrchestrator(hubRoot) {
  const cpbRoot = process.env.CPB_ROOT || process.cwd();
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot);
  await orchestrator.stop();
  console.log("Hub Orchestrator stopped");
  return 0;
}

async function listWorkers(hubRoot) {
  const { WorkerStore } = await import("../../server/orchestrator/worker-store.js");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workers = await store.listWorkers();
  if (workers.length === 0) {
    console.log("No workers registered");
    return 0;
  }
  for (const w of workers) {
    console.log(`${w.workerId}  ${w.status}  project=${w.projectId || "-"}  assignment=${w.currentAssignmentId || "-"}`);
  }
  return 0;
}

async function listAssignments(hubRoot) {
  const { AssignmentStore } = await import("../../server/orchestrator/assignment-store.js");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const assignments = await store.listAssignments();
  if (assignments.length === 0) {
    console.log("No assignments");
    return 0;
  }
  for (const a of assignments) {
    console.log(`${a.assignmentId}  ${a.status}  project=${a.projectId}  entry=${a.entryId}`);
  }
  return 0;
}
