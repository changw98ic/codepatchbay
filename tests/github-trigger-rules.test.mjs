import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { test } from "node:test";

import { githubRoutes } from "../server/routes/github.js";
import { matchGithubTrigger } from "../server/services/github-triggers.js";
import { DEFAULT_GITHUB_TRIGGERS } from "../server/services/hub-registry.js";
import { normalizeGithubWebhookEvent } from "../server/services/github-events.js";
import { saveGithubAppConfig } from "../server/services/github-app.js";
import { registerProject, updateProject } from "../server/services/hub-registry.js";
import { listQueue } from "../server/services/hub-queue.js";
import { tempRoot } from "./helpers.mjs";

const execFile = promisify(execFileCb);

async function makeGithubApp(hubRoot, cpbRoot, opts = {}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate("notifBroadcast", async () => {});
  app.addHook("onRequest", (req, _reply, done) => {
    req.cpbRoot = cpbRoot;
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(githubRoutes, opts);
  await app.ready();
  return app;
}

async function git(cwd, args) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "CPB Test",
    GIT_AUTHOR_EMAIL: "cpb-test@example.invalid",
    GIT_COMMITTER_NAME: "CPB Test",
    GIT_COMMITTER_EMAIL: "cpb-test@example.invalid",
  };
  const result = await execFile("git", args, { cwd, env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return result.stdout.trim();
}

async function makeGitRepo(prefix = "cpb-gh-gw") {
  const sourcePath = await tempRoot(prefix);
  await git(sourcePath, ["init"]);
  await git(sourcePath, ["config", "user.name", "CPB Test"]);
  await git(sourcePath, ["config", "user.email", "cpb-test@example.invalid"]);
  await writeFile(path.join(sourcePath, "README.md"), "# Fixture\n", "utf8");
  await git(sourcePath, ["add", "README.md"]);
  await git(sourcePath, ["commit", "-m", "initial"]);
  return sourcePath;
}

function signedHeaders(body, secret, event = "issues") {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  return {
    "content-type": "application/json",
    "x-hub-signature-256": `sha256=${signature}`,
    "x-github-event": event,
    "x-github-delivery": `delivery-${Math.random().toString(36).slice(2)}`,
  };
}

async function configureGithubWebhook(hubRoot, secret = "webhook-secret") {
  process.env.CPB_TEST_WEBHOOK_SECRET = secret;
  await saveGithubAppConfig(hubRoot, {
    appId: "123",
    webhookSecretRef: "env:CPB_TEST_WEBHOOK_SECRET",
  });
  return secret;
}

function issuePayload({ repo = "owner/repo", action = "labeled", labels = ["cpb"], label = "cpb" } = {}) {
  return {
    action,
    repository: { full_name: repo },
    sender: { login: "octo" },
    label: label ? { name: label } : null,
    issue: {
      number: 5,
      title: "Fix the thing",
      body: "Issue body",
      html_url: `https://github.com/${repo}/issues/5`,
      labels: labels.map((name) => ({ name })),
      author_association: "OWNER",
    },
  };
}

function commentPayload({ repo = "owner/repo", issueNumber = 5, body, association = "MEMBER" } = {}) {
  return {
    action: "created",
    repository: { full_name: repo },
    sender: { login: "reviewer" },
    issue: {
      number: issueNumber,
      title: "Fix the thing",
      body: "Issue body",
      html_url: `https://github.com/${repo}/issues/${issueNumber}`,
      labels: [],
      author_association: "OWNER",
    },
    comment: {
      body,
      html_url: `https://github.com/${repo}/issues/${issueNumber}#issuecomment-1`,
      author_association: association,
    },
  };
}

// --- D24: Trigger Rule Matcher unit tests ---

test("issues.labeled with label cpb matches standard workflow", () => {
  const event = normalizeGithubWebhookEvent({
    event: "issues",
    delivery: "del-1",
    projectId: "proj",
    payload: {
      action: "labeled",
      repository: { full_name: "owner/repo" },
      sender: { login: "octo" },
      label: { name: "cpb" },
      issue: {
        number: 5, title: "Fix the thing", body: "Issue body",
        html_url: "https://github.com/owner/repo/issues/5",
        labels: [{ name: "cpb" }], author_association: "OWNER",
      },
    },
  });
  const result = matchGithubTrigger(event, DEFAULT_GITHUB_TRIGGERS);

  assert.equal(result.matched, true);
  assert.equal(result.workflow, "standard");
  assert.equal(result.rule.label, "cpb");
  assert.match(result.reason, /label/);
});

test("issue_comment.created with /cpb run matches standard workflow", () => {
  const event = normalizeGithubWebhookEvent({
    event: "issue_comment",
    delivery: "del-2",
    projectId: "proj",
    payload: {
      action: "created",
      repository: { full_name: "owner/repo" },
      sender: { login: "reviewer" },
      issue: {
        number: 5, title: "Fix the thing", body: "Issue body",
        html_url: "https://github.com/owner/repo/issues/5",
        labels: [], author_association: "OWNER",
      },
      comment: {
        body: "/cpb run",
        html_url: "https://github.com/owner/repo/issues/5#issuecomment-1",
        author_association: "MEMBER",
      },
    },
  });
  const result = matchGithubTrigger(event, DEFAULT_GITHUB_TRIGGERS);

  assert.equal(result.matched, true);
  assert.equal(result.workflow, "standard");
  assert.equal(result.rule.command, "/cpb run");
  assert.match(result.reason, /command/);
});

test("non-matching label does not queue a job", () => {
  const event = normalizeGithubWebhookEvent({
    event: "issues",
    delivery: "del-3",
    projectId: "proj",
    payload: {
      action: "labeled",
      repository: { full_name: "owner/repo" },
      sender: { login: "octo" },
      label: { name: "bug" },
      issue: {
        number: 5, title: "Fix", body: "",
        html_url: "https://github.com/owner/repo/issues/5",
        labels: [{ name: "bug" }], author_association: "OWNER",
      },
    },
  });
  const result = matchGithubTrigger(event, DEFAULT_GITHUB_TRIGGERS);
  assert.equal(result.matched, false);
  assert.equal(result.workflow, null);
});

test("non-matching comment does not queue a job", () => {
  const event = normalizeGithubWebhookEvent({
    event: "issue_comment",
    delivery: "del-4",
    projectId: "proj",
    payload: {
      action: "created",
      repository: { full_name: "owner/repo" },
      sender: { login: "reviewer" },
      issue: {
        number: 5, title: "Fix", body: "",
        html_url: "https://github.com/owner/repo/issues/5",
        labels: [], author_association: "OWNER",
      },
      comment: {
        body: "looks good to me",
        html_url: "https://github.com/owner/repo/issues/5#issuecomment-2",
        author_association: "MEMBER",
      },
    },
  });
  const result = matchGithubTrigger(event, DEFAULT_GITHUB_TRIGGERS);
  assert.equal(result.matched, false);
  assert.equal(result.workflow, null);
});

test("planMode is returned at top level from matchGithubTrigger", () => {
  const rulesWithPlanMode = [
    { event: "issues.labeled", label: "sdd", workflow: "sdd-standard", planMode: "parent" },
  ];
  const event = normalizeGithubWebhookEvent({
    event: "issues",
    delivery: "del-5",
    projectId: "proj",
    payload: {
      action: "labeled",
      repository: { full_name: "owner/repo" },
      sender: { login: "octo" },
      label: { name: "sdd" },
      issue: {
        number: 10, title: "SDD task", body: "",
        html_url: "https://github.com/owner/repo/issues/10",
        labels: [{ name: "sdd" }], author_association: "OWNER",
      },
    },
  });
  const result = matchGithubTrigger(event, rulesWithPlanMode);
  assert.equal(result.matched, true);
  assert.equal(result.planMode, "parent");
});

test("planMode is null when rule has no planMode", () => {
  const event = normalizeGithubWebhookEvent({
    event: "issues",
    delivery: "del-6",
    projectId: "proj",
    payload: {
      action: "labeled",
      repository: { full_name: "owner/repo" },
      sender: { login: "octo" },
      label: { name: "cpb" },
      issue: {
        number: 5, title: "Fix", body: "",
        html_url: "https://github.com/owner/repo/issues/5",
        labels: [{ name: "cpb" }], author_association: "OWNER",
      },
    },
  });
  const result = matchGithubTrigger(event, DEFAULT_GITHUB_TRIGGERS);
  assert.equal(result.matched, true);
  assert.equal(result.planMode, null);
});

// --- D24: Route integration — /cpb run comment reaches trigger matcher ---

test("/cpb run comment webhook queues a job through trigger matching", async () => {
  const cpbRoot = await tempRoot("cpb-d24-run-cpb");
  const hubRoot = await tempRoot("cpb-d24-run-hub");
  const sourcePath = await makeGitRepo("cpb-d24-run-src");
  const secret = await configureGithubWebhook(hubRoot);
  await registerProject(hubRoot, { id: "proj", sourcePath, skipCodeGraphGate: true });
  await updateProject(hubRoot, "proj", {
    github: { fullName: "owner/repo", triggers: [{ event: "issue_comment.created", command: "/cpb run", workflow: "standard" }] },
  });
  const app = await makeGithubApp(hubRoot, cpbRoot, { githubDryRun: true });

  const raw = JSON.stringify(commentPayload({ body: "/cpb run" }));
  const response = await app.inject({
    method: "POST",
    url: "/github/webhook",
    headers: signedHeaders(raw, secret, "issue_comment"),
    payload: raw,
  });

  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 202);
  assert.equal(body.match?.matched, true, "/cpb run comment should match trigger rule");
  assert.equal(body.match?.workflow, "standard");
  assert.ok(body.queue, "should have a queue result");

  const queue = await listQueue(hubRoot);
  const entry = queue.find((e) => e.projectId === "proj");
  assert.ok(entry, "should have queued a hub entry for the project");
  assert.equal(entry.metadata?.commandText, "/cpb run");

  await app.close();
});

test("non-matching comment webhook does not queue a job", async () => {
  const cpbRoot = await tempRoot("cpb-d24-nocmdp-cpb");
  const hubRoot = await tempRoot("cpb-d24-nocmdp-hub");
  const sourcePath = await makeGitRepo("cpb-d24-nocmdp-src");
  const secret = await configureGithubWebhook(hubRoot);
  await registerProject(hubRoot, { id: "proj2", sourcePath, skipCodeGraphGate: true });
  await updateProject(hubRoot, "proj2", {
    github: { fullName: "owner/repo", triggers: DEFAULT_GITHUB_TRIGGERS },
  });
  const app = await makeGithubApp(hubRoot, cpbRoot, { githubDryRun: true });

  const before = await listQueue(hubRoot);
  const raw = JSON.stringify(commentPayload({ body: "just a regular comment" }));
  const response = await app.inject({
    method: "POST",
    url: "/github/webhook",
    headers: signedHeaders(raw, secret, "issue_comment"),
    payload: raw,
  });

  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 202);
  assert.equal(body.match?.matched, false, "regular comment should not match any trigger");

  const after = await listQueue(hubRoot);
  assert.equal(after.length, before.length, "no new queue entries should be created");

  await app.close();
});

test("issues.labeled with cpb webhook queues a job", async () => {
  const cpbRoot = await tempRoot("cpb-d24-label-cpb");
  const hubRoot = await tempRoot("cpb-d24-label-hub");
  const sourcePath = await makeGitRepo("cpb-d24-label-src");
  const secret = await configureGithubWebhook(hubRoot);
  await registerProject(hubRoot, { id: "proj3", sourcePath, skipCodeGraphGate: true });
  await updateProject(hubRoot, "proj3", {
    github: { fullName: "owner/repo", triggers: [{ event: "issues.labeled", label: "cpb", workflow: "standard" }] },
  });
  const app = await makeGithubApp(hubRoot, cpbRoot, { githubDryRun: true });

  const raw = JSON.stringify(issuePayload({ label: "cpb", labels: ["cpb"] }));
  const response = await app.inject({
    method: "POST",
    url: "/github/webhook",
    headers: signedHeaders(raw, secret, "issues"),
    payload: raw,
  });

  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 202);
  assert.equal(body.match?.matched, true, "cpb label should match trigger rule");
  assert.equal(body.match?.workflow, "standard");

  const queue = await listQueue(hubRoot);
  const entry = queue.find((e) => e.projectId === "proj3");
  assert.ok(entry, "should have queued a hub entry");
  assert.equal(entry.metadata?.issueNumber, 5);
  assert.equal(entry.metadata?.triggerReason, "matched label cpb");

  await app.close();
});

test("issues.labeled with non-cpb label webhook does not queue", async () => {
  const cpbRoot = await tempRoot("cpb-d24-nolbl-cpb");
  const hubRoot = await tempRoot("cpb-d24-nolbl-hub");
  const sourcePath = await makeGitRepo("cpb-d24-nolbl-src");
  const secret = await configureGithubWebhook(hubRoot);
  await registerProject(hubRoot, { id: "proj4", sourcePath, skipCodeGraphGate: true });
  await updateProject(hubRoot, "proj4", {
    github: { fullName: "owner/repo", triggers: [{ event: "issues.labeled", label: "cpb", workflow: "standard" }] },
  });
  const app = await makeGithubApp(hubRoot, cpbRoot, { githubDryRun: true });

  const before = await listQueue(hubRoot);
  const raw = JSON.stringify(issuePayload({ label: "bug", labels: ["bug"] }));
  const response = await app.inject({
    method: "POST",
    url: "/github/webhook",
    headers: signedHeaders(raw, secret, "issues"),
    payload: raw,
  });

  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 202);
  assert.equal(body.match?.matched, false, "bug label should not match cpb trigger");

  const after = await listQueue(hubRoot);
  assert.equal(after.length, before.length, "no new queue entries");

  await app.close();
});
