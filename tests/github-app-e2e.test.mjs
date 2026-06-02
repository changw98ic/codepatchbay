import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Fastify from "fastify";
import { createHmac } from "node:crypto";

import { githubRoutes } from "../server/routes/github.js";
import { loadQueue } from "../server/services/hub-queue.js";

function webhookSignature(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function buildGithubApp(cpbRoot, hubRoot, routeOptions = {}) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", (req, _reply, done) => {
    req.cpbRoot = cpbRoot;
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(githubRoutes, { prefix: "/api", ...routeOptions });
  return app;
}

async function initHub(hubRoot, projectId, repoFullName) {
  await mkdir(path.join(hubRoot, "github"), { recursive: true });
  await mkdir(path.join(hubRoot, "queue"), { recursive: true });
  await mkdir(path.join(hubRoot, "source"), { recursive: true });
  await mkdir(path.join(hubRoot, "runtime"), { recursive: true });

  // Project registry
  const registry = {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {
      [projectId]: {
        id: projectId,
        name: projectId,
        sourcePath: path.join(hubRoot, "source"),
        projectRuntimeRoot: path.join(hubRoot, "runtime"),
        github: {
          fullName: repoFullName,
          triggers: [
            { event: "issues.labeled", label: "cpb", workflow: "standard" },
          ],
        },
      },
    },
  };
  await writeFile(path.join(hubRoot, "projects.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  // GitHub App config
  const appConfig = {
    schemaVersion: 1,
    appId: "123456",
    installationId: "78901234",
    webhookSecretRef: "env:CPB_GITHUB_WEBHOOK_SECRET",
    privateKeyRef: null,
    permissions: { issues: "write", contents: "write", pullRequests: "write" },
  };
  await writeFile(path.join(hubRoot, "github", "app.json"), `${JSON.stringify(appConfig, null, 2)}\n`, "utf8");
}

const secret = "test-webhook-secret";
const projectId = "test-project";
const repo = "test-owner/test-repo";

describe("GitHub App webhook E2E", () => {
  let tmpDir;
  let hubRoot;
  let cpbRoot;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-github-e2e-"));
    hubRoot = path.join(tmpDir, "hub");
    cpbRoot = path.join(tmpDir, "cpb");
    process.env.CPB_GITHUB_WEBHOOK_SECRET = secret;
    await initHub(hubRoot, projectId, repo);
  });

  after(async () => {
    delete process.env.CPB_GITHUB_WEBHOOK_SECRET;
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("webhook creates queue entry and posts queued comment via mock transport", async () => {
    const postedComments = [];
    const mockPostComment = async (req) => {
      postedComments.push(req);
      return { id: 1, html_url: `https://github.com/${req.repo}/issues/${req.issueNumber}#issuecomment-1` };
    };

    const app = await buildGithubApp(cpbRoot, hubRoot, {
      githubPostComment: mockPostComment,
    });

    const payload = {
      action: "labeled",
      label: { name: "cpb" },
      issue: { number: 42, title: "Fix the thing" },
      repository: { full_name: repo },
      sender: { login: "alice" },
    };
    const body = JSON.stringify(payload);

    const res = await app.inject({
      method: "POST",
      url: "/api/github/webhook",
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "test-delivery-1",
        "x-hub-signature-256": webhookSignature(secret, body),
        "content-type": "application/json",
      },
      payload: body,
    });

    assert.equal(res.statusCode, 202);
    const json = JSON.parse(res.payload);
    assert.equal(json.accepted, true);
    assert.ok(json.hubQueue, "hubQueue should be present");
    assert.ok(json.hubQueue.id, "queue entry should have id");

    // Verify queue entry exists
    const queue = await loadQueue(hubRoot);
    const entry = queue.entries.find((e) => e.id === json.hubQueue.id);
    assert.ok(entry, "queue entry should exist");
    assert.equal(entry.projectId, projectId);
    assert.equal(entry.status, "pending");
    assert.equal(entry.metadata?.issueNumber, 42);
    assert.equal(entry.metadata?.repo, repo);

    // Verify mock comment was posted
    assert.equal(postedComments.length, 1);
    assert.equal(postedComments[0].issueNumber, 42);
    assert.ok(postedComments[0].body.includes("CodePatchBay queued this issue"));

    await app.close();
  });

});
