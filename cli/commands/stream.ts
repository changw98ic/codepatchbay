// cpb stream [--port PORT] [--host HOST]
// Starts the CPB streaming data server for real-time event monitoring

export async function run(args: string[], { cpbRoot, executorRoot }: { cpbRoot: string; executorRoot: string }) {
  if (args.includes("--help")) {
    console.log("Usage: cpb stream [--port PORT] [--host HOST]");
    console.log("Start the CPB streaming data server for real-time event monitoring.");
    console.log("");
    console.log("Options:");
    console.log("  --port PORT   TCP port (default: 9741)");
    console.log("  --host HOST   Bind address (default: 127.0.0.1)");
    return 0;
  }

  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : 9741;
  const hostIdx = args.indexOf("--host");
  const host = hostIdx >= 0 && args[hostIdx + 1] ? args[hostIdx + 1] : "127.0.0.1";

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error(`Error: invalid port "${args[portIdx + 1]}"`);
    return 1;
  }

  // Resolve hub root
  const { resolveHubRoot } = await import("../../server/services/hub/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);

  // Start stream server (includes wiki watcher internally)
  const { startStreamServer } = await import("../../server/services/stream/index.js");
  const { server, close } = await startStreamServer({ port, host, cpbRoot, hubRoot });

  console.log(`CPB stream server listening on ${host}:${port}`);
  console.log(`SSE endpoint:  http://${host}:${port}/stream`);
  console.log(`Jobs API:      http://${host}:${port}/jobs`);
  console.log("Press Ctrl+C to stop");

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive — server.listen is non-blocking for the event loop
  return new Promise<number>(() => {});
}
