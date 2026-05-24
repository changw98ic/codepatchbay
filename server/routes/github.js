import {
  loadGithubAppConfig,
  resolveGithubWebhookSecret,
  verifyGithubWebhookSignature,
} from "../services/github-app.js";

function rawBodyBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(JSON.stringify(body ?? {}), "utf8");
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export async function githubRoutes(fastify) {
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  fastify.post("/github/webhook", async (req, reply) => {
    const rawBody = rawBodyBuffer(req.body);
    let config;
    let secret;
    try {
      config = await loadGithubAppConfig(req.cpbHubRoot);
      secret = resolveGithubWebhookSecret(config);
    } catch {
      return reply.code(401).send({ error: "invalid GitHub webhook signature" });
    }

    const signature = headerValue(req.headers, "x-hub-signature-256");
    const valid = verifyGithubWebhookSignature({ signature, rawBody, secret });
    if (!valid) {
      return reply.code(401).send({ error: "invalid GitHub webhook signature" });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "invalid JSON payload" });
    }

    return reply.code(202).send({
      accepted: true,
      event: headerValue(req.headers, "x-github-event") || null,
      delivery: headerValue(req.headers, "x-github-delivery") || null,
      action: payload.action || null,
    });
  });
}
