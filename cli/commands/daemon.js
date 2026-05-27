#!/usr/bin/env node

function usage() {
  return [
    "Usage: cpb daemon <start|status|stop> [--workers N] [--json]",
    "",
    "Commands:",
    "  start     Start the queue worker daemon",
    "  status    Show daemon status",
    "  stop      Stop the queue worker daemon",
    "",
    "Options:",
    "  --workers N   Number of parallel workers (default: 1)",
    "  --json        Machine-readable output",
  ].join("\n");
}

export async function run(args = [], { cpbRoot, executorRoot } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const json = args.includes("--json");
  const sub = args.find((arg) => !arg.startsWith("--")) || "status";
  const workersIdx = args.indexOf("--workers");
  const workers = workersIdx >= 0 ? Number(args[workersIdx + 1]) || 1 : 1;
  const { startDaemon, statusDaemon, stopDaemon } = await import("../../server/services/queue-daemon.js");

  let result;
  if (sub === "start") {
    result = await startDaemon({ cpbRoot, executorRoot, workers });
  } else if (sub === "status") {
    result = await statusDaemon({ cpbRoot });
  } else if (sub === "stop") {
    result = await stopDaemon({ cpbRoot });
  } else {
    console.error(usage());
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (sub === "status") {
    const pids = result.state?.pids || (result.pid ? [result.pid] : []);
    console.log(`Queue daemon: ${result.status}${pids.length ? ` (pids: ${pids.join(", ")})` : ""}${result.state?.workers ? ` workers: ${result.state.workers}` : ""}`);
  } else {
    const pids = result.state?.pids || (result.pid ? [result.pid] : []);
    console.log(`Queue daemon ${result.status}${pids.length ? ` (pids: ${pids.join(", ")})` : ""}${result.state?.workers ? ` (${result.state.workers} workers)` : ""}`);
  }
  return 0;
}
