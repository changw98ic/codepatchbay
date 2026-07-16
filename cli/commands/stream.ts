// cpb stream [--port PORT] [--host HOST] [--token TOKEN] [--origin ORIGIN] [--allow-insecure-http]
// Starts the CPB streaming data server for real-time event monitoring

function optionValues(args: string[], name: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return null;
    values.push(value);
    index++;
  }
  return values;
}

export async function run(args: string[], { cpbRoot, executorRoot }: { cpbRoot: string; executorRoot: string }) {
  if (args.includes("--help")) {
    console.log("Usage: cpb stream [--port PORT] [--host HOST] [--token TOKEN] [--origin ORIGIN] [--allow-insecure-http] [--allow-anonymous-dev]");
    console.log("Start the CPB streaming data server for real-time event monitoring.");
    console.log("");
    console.log("Options:");
    console.log("  --port PORT     TCP port (default: 9741)");
    console.log("  --host HOST     Bind address (default: 127.0.0.1)");
    console.log("  --token TOKEN   Bearer token (32+ bytes); prefer CPB_STREAM_BEARER_TOKEN to avoid shell history");
    console.log("  --origin ORIGIN Allowed CORS origin; repeat for multiple origins");
    console.log("  --allow-insecure-http  Permit cleartext HTTP on a non-loopback host (secured networks only)");
    console.log("  --allow-anonymous-dev  Permit unauthenticated loopback access for local development only");
    console.log("");
    console.log("Environment:");
    console.log("  CPB_STREAM_BEARER_TOKEN   Bearer token for authenticated access");
    console.log("  CPB_STREAM_ALLOWED_ORIGINS  Comma-separated allowed CORS origins");
    console.log("  CPB_STREAM_ALLOW_INSECURE_HTTP=1  Same opt-in as --allow-insecure-http");
    console.log("  CPB_STREAM_ALLOW_ANONYMOUS_DEV=1  Same opt-in as --allow-anonymous-dev");
    return 0;
  }

  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : 9741;
  const hostIdx = args.indexOf("--host");
  const host = hostIdx >= 0 && args[hostIdx + 1] ? args[hostIdx + 1] : "127.0.0.1";
  const tokenValues = optionValues(args, "--token");
  const originValues = optionValues(args, "--origin");

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error(`Error: invalid port "${args[portIdx + 1]}"`);
    return 1;
  }
  if (tokenValues === null) {
    console.error("Error: --token requires a value");
    return 1;
  }
  if (originValues === null) {
    console.error("Error: --origin requires a value");
    return 1;
  }

  const bearerToken = tokenValues[0]
    || process.env.CPB_STREAM_BEARER_TOKEN
    || process.env.CPB_STREAM_TOKEN
    || "";
  const envOrigins = String(process.env.CPB_STREAM_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedOrigins = [...new Set([...originValues, ...envOrigins])];
  const allowInsecureHttp = args.includes("--allow-insecure-http")
    || process.env.CPB_STREAM_ALLOW_INSECURE_HTTP === "1";
  const allowAnonymousDev = args.includes("--allow-anonymous-dev")
    || process.env.CPB_STREAM_ALLOW_ANONYMOUS_DEV === "1";

  // Resolve hub root
  const { resolveHubRoot } = await import("../../server/services/hub/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);

  // Start stream server (includes wiki watcher internally)
  const { startStreamServer } = await import("../../server/services/stream/index.js");
  const { server, close } = await startStreamServer({
    port,
    host,
    cpbRoot,
    hubRoot,
    bearerToken,
    allowedOrigins,
    allowInsecureHttp,
    allowAnonymousDev,
  });

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
