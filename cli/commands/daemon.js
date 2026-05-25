#!/usr/bin/env node

function usage() {
  return [
    "Usage: cpb daemon <start|status|stop> [--json]",
    "",
    "Commands:",
    "  start     Start the queue worker daemon",
    "  status    Show daemon status",
    "  stop      Stop the queue worker daemon",
  ].join("\n");
}

export async function run(args = [], { cpbRoot, executorRoot } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const json = args.includes("--json");
  const sub = args.find((arg) => !arg.startsWith("--")) || "status";
  const { startDaemon, statusDaemon, stopDaemon } = await import("../../server/services/queue-daemon.js");

  let result;
  if (sub === "start") {
    result = await startDaemon({ cpbRoot, executorRoot });
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
    console.log(`Queue daemon: ${result.status}${result.pid ? ` (pid ${result.pid})` : ""}`);
  } else {
    console.log(`Queue daemon ${result.status}${result.pid ? ` (pid ${result.pid})` : ""}`);
  }
  return 0;
}
