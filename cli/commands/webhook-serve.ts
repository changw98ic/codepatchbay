import { createServer } from "node:http";
import { resolveHubRoot } from "../../server/services/hub/hub-registry.js";
import { handleGithubWebhook } from "../../server/services/github/webhook-handler.js";

export async function run(args, { cpbRoot }) {
  const hubRoot = resolveHubRoot(cpbRoot);
  const port = parseInt(process.env.CPB_WEBHOOK_PORT || args[0] || "3457", 10);
  const host = process.env.CPB_WEBHOOK_HOST || "127.0.0.1";

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/github/webhook") {
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks);

    const headers: Record<string, any> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = value;
    }

    try {
      const result = await handleGithubWebhook({
        rawBody,
        headers,
        hubRoot,
        cpbRoot,
      });

      res.writeHead(result.statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (err: any) {
      console.error(`[webhook] error: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal server error" }));
    }
  });

  server.listen(port, host, () => {
    console.log(`GitHub webhook listening on http://${host}:${port}/github/webhook`);
  });

  const shutdown = () => {
    console.log("\n[webhook] shutting down...");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
