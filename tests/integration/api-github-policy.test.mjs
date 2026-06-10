import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { test } from "node:test";

import { githubRoutes } from "../../server/routes/github.js";
import { hubRoutes } from "../../server/routes/hub.js";
import { inboxRoutes } from "../../server/routes/inbox.js";
import { reviewRoutes } from "../../server/routes/review.js";
import { taskRoutes } from "../../server/routes/tasks.js";
import { parseChannelCommand } from "../../server/services/channel-commands.js";
import { evaluateChannelPolicy } from "../../server/services/channel-policy.js";
import { appendEvent } from "../../server/services/event-store.js";
import { saveGithubAppConfig } from "../../server/services/github-app.js";
import { createJob, completeJob } from "../../server/services/job-store.js";
import { readProjectIndex, writeProjectIndex } from "../../server/services/project-index.js";
import { createSession, getSession, updateSession } from "../../server/services/review-session.js";
import { enqueue, listQueue, updateEntry } from "../../server/services/hub-queue.js";
import { registerProject, updateProject } from "../../server/services/hub-registry.js";
import { tempRoot, writeJson } from "../helpers.mjs";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "CPB Test",
  GIT_AUTHOR_EMAIL: "cpb-test@example.invalid",
  GIT_COMMITTER_NAME: "CPB Test",
  GIT_COMMITTER_EMAIL: "cpb-test@example.invalid",
};

async function makeApp(route, { cpbRoot, hubRoot, opts = {} }) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate("notifBroadcast", async () => {});
  app.addHook("onRequest", (req, _reply, done) => {
    req.cpbRoot = cpbRoot;
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(route, opts);
  await app.ready();
  return app;
}

async function git(cwd, args) {
  const result = await execFile("git", args, { cwd, env: gitEnv, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return result.stdout.trim();
}

async function makeGitRepo(prefix = "cpb-api-git") {
  const sourcePath = await tempRoot(prefix);
  await git(sourcePath, ["init"]);
  await git(sourcePath, ["config", "user.name", "CPB Test"]);
  await git(sourcePath, ["config", "user.email", "cpb-test@example.invalid"]);
  await writeFile(path.join(sourcePath, "README.md"), "# Fixture\n", "utf8");
  await git(sourcePath, ["add", "README.md"]);
  await git(sourcePath, ["commit", "-m", "initial"]);
  return sourcePath;
}

function bodyOf(response) {
  return JSON.parse(response.body);
}

function highConfidenceCapabilityMetadata() {
  return {
    capabilityMapConfidence: "high",
    project_capability_map: {
      confidence: "high",
      coreModules: ["README.md"],
      testSurfaces: [],
    },
  };
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

test("hub routes gate stale index claims and reject disabled dispatch records", async () => {
  const cpbRoot = await tempRoot("cpb-api-hub-cpb");
  const hubRoot = await tempRoot("cpb-api-hub");
  const sourcePath = await makeGitRepo("cpb-api-hub-source");
  const oldHead = await git(sourcePath, ["rev-parse", "HEAD"]);
  await registerProject(hubRoot, {
    id: "proj",
    sourcePath,
    skipCodeGraphGate: true,
    metadata: highConfidenceCapabilityMetadata(),
  });
  await writeProjectIndex(hubRoot, cpbRoot, "proj", {
    state: "merged_indexed",
    branch: await git(sourcePath, ["branch", "--show-current"]),
    gitHead: oldHead,
    indexedFrom: "test",
    timestamp: new Date().toISOString(),
  });
  await writeFile(path.join(sourcePath, "README.md"), "# Fixture\n\nnew line\n", "utf8");
  await git(sourcePath, ["add", "README.md"]);
  await git(sourcePath, ["commit", "-m", "drift"]);

  const entry = await enqueue(hubRoot, {
    projectId: "proj",
    sourcePath,
    description: "claim me",
    metadata: { issueNumber: 5, repo: "owner/repo" },
  });
  const app = await makeApp(hubRoutes, { cpbRoot, hubRoot });

  const claim = await app.inject({
    method: "POST",
    url: "/hub/queue/claim",
    payload: { workerId: "w-api" },
  });
  assert.equal(claim.statusCode, 200);
  const claimBody = bodyOf(claim);
  assert.equal(claimBody.claimed, false);
  assert.equal(claimBody.reason, "project-index-stale");
  assert.equal(claimBody.blockedEntryId, entry.id);
  const queueEntry = (await listQueue(hubRoot)).find((item) => item.id === entry.id);
  assert.equal(queueEntry.status, "pending");
  assert.equal(queueEntry.workerId, null);
  const projectIndex = await readProjectIndex(hubRoot, cpbRoot, "proj");
  assert.equal(projectIndex.state, "stale");

  const disabled = await app.inject({
    method: "POST",
    url: "/hub/dispatches/record",
    payload: { projectId: "proj", sourcePath },
  });
  assert.equal(disabled.statusCode, 400);
  assert.match(bodyOf(disabled).message, /dispatch recording is not enabled/);
  await app.close();
});

test("task pipeline route validates project, task, and ACP lane before queueing", async () => {
  const cpbRoot = await tempRoot("cpb-api-task-cpb");
  const hubRoot = await tempRoot("cpb-api-task-hub");
  const sourcePath = await tempRoot("cpb-api-task-source");
  await registerProject(hubRoot, { id: "proj", sourcePath, skipCodeGraphGate: true });
  const app = await makeApp(taskRoutes, { cpbRoot, hubRoot });

  assert.equal((await app.inject({ method: "POST", url: "/tasks/bad_name/pipeline", payload: { task: "x" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/tasks/proj/pipeline", payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/tasks/missing/pipeline", payload: { task: "x" } })).statusCode, 404);
  const uiLane = await app.inject({
    method: "POST",
    url: "/tasks/proj/pipeline",
    payload: { task: "use a browser", acpProfile: "ui" },
  });
  assert.equal(uiLane.statusCode, 400);
  assert.match(bodyOf(uiLane).message, /ui profile requires/);

  const valid = await app.inject({
    method: "POST",
    url: "/tasks/proj/pipeline",
    payload: {
      task: "ship it",
      acpProfile: "headless",
      issueNumber: 5,
      repo: "owner/repo",
      agents: { executor: "fake-acp" },
    },
  });
  assert.equal(valid.statusCode, 200);
  const body = bodyOf(valid);
  assert.equal(body.queued, true);
  assert.equal(body.entry.projectId, "proj");
  assert.equal(body.entry.metadata.issueNumber, 5);
  assert.deepEqual(body.entry.metadata.agents.executor, { agent: "fake-acp", variant: null });

  const simple = bodyOf(await app.inject({
    method: "POST",
    url: "/tasks/proj/pipeline",
    payload: {
      task: "Update README docs wording",
      acpProfile: "headless",
    },
  }));
  assert.equal(simple.entry.metadata.workflow, "direct");
  assert.equal(simple.entry.metadata.planMode, "light");
  assert.equal(simple.entry.metadata.routeDecision.workflow, "direct");
  await app.close();
});

test("inbox route aggregates jobs, queue entries, and reviews with filters and project summaries", async () => {
  const cpbRoot = await tempRoot("cpb-api-inbox-cpb");
  const hubRoot = await tempRoot("cpb-api-inbox-hub");
  await createJob(cpbRoot, {
    project: "proj-job",
    task: "completed job",
    workflow: "standard",
    jobId: "job-api-inbox",
  });
  await appendEvent(cpbRoot, "proj-job", "job-api-inbox", {
    type: "riskmap_generated",
    jobId: "job-api-inbox",
    project: "proj-job",
    phase: "prepare_task",
    riskLevel: "high",
    verificationDepth: "strict",
    adversarialRequired: true,
    riskMap: {
      riskLevel: "high",
      domains: ["provider_pool"],
      verificationDepth: "strict",
      adversarialRequired: true,
    },
    ts: new Date().toISOString(),
  });
  await completeJob(cpbRoot, "proj-job", "job-api-inbox");
  const queueEntry = await enqueue(hubRoot, {
    projectId: "proj-queue",
    description: "queued item",
    priority: "P1",
  });
  await updateEntry(hubRoot, queueEntry.id, { status: "scheduled" });
  const review = await createSession(cpbRoot, { project: "proj-review", intent: "review item" });
  await updateSession(cpbRoot, review.sessionId, { status: "user_review" }, { skipTransitionCheck: true });
  const app = await makeApp(inboxRoutes, { cpbRoot, hubRoot });

  const all = bodyOf(await app.inject({ method: "GET", url: "/inbox?limit=20" }));
  assert.equal(all.total, 3);
  assert.deepEqual(new Set(all.items.map((item) => item.type)), new Set(["pipeline", "queued", "review"]));
  assert.deepEqual(all.projects, ["proj-job", "proj-queue", "proj-review"]);
  assert.equal(all.items[0].priority, "P0");
  const jobRow = all.items.find((item) => item.id === "job-api-inbox");
  assert.equal(jobRow.riskLevel, "high");
  assert.equal(jobRow.verificationDepth, "strict");
  assert.equal(jobRow.adversarialRequired, true);

  const filtered = bodyOf(await app.inject({ method: "GET", url: "/inbox?type=queued&status=queued" }));
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, queueEntry.id);
  assert.equal(filtered.items[0].status, "queued");

  const summaries = bodyOf(await app.inject({ method: "GET", url: "/inbox/projects" }));
  const reviewSummary = summaries.projects.find((project) => project.name === "proj-review");
  assert.equal(reviewSummary.counts.blocked, 1);

  const rejectMissingFeedback = await app.inject({
    method: "POST",
    url: `/inbox/${queueEntry.id}/review-bundle/reject`,
    payload: {},
  });
  assert.equal(rejectMissingFeedback.statusCode, 400);
  assert.match(bodyOf(rejectMissingFeedback).error, /feedback required/);
  await app.close();
});

test("review routes are idempotent and update queue, cleanup, merge success, and merge failure state", async () => {
  const cpbRoot = await tempRoot("cpb-api-review-cpb");
  const hubRoot = await tempRoot("cpb-api-review-hub");
  const sourcePath = await makeGitRepo("cpb-api-review-source");
  await registerProject(hubRoot, { id: "proj", sourcePath, skipCodeGraphGate: true });
  await writeJson(path.join(cpbRoot, "wiki", "projects", "proj", "project.json"), { sourcePath });
  const app = await makeApp(reviewRoutes, { cpbRoot, hubRoot, opts: { executorRoot: repoRoot, startRunner: false } });

  const created = bodyOf(await app.inject({
    method: "POST",
    url: "/review",
    payload: { project: "proj", intent: "review this change" },
  }));
  const startOne = await app.inject({ method: "POST", url: `/review/${created.sessionId}/start`, headers: { "idempotency-key": "same" } });
  const startTwo = await app.inject({ method: "POST", url: `/review/${created.sessionId}/start`, headers: { "idempotency-key": "same" } });
  const startConflict = await app.inject({ method: "POST", url: `/review/${created.sessionId}/start`, headers: { "idempotency-key": "different" } });
  assert.equal(startOne.statusCode, 200);
  assert.equal(startTwo.statusCode, 200);
  assert.equal(startConflict.statusCode, 409);

  const approvalSession = await createSession(cpbRoot, { project: "proj", intent: "approved review" });
  await updateSession(cpbRoot, approvalSession.sessionId, { status: "user_review" }, { skipTransitionCheck: true });
  const approve = bodyOf(await app.inject({ method: "POST", url: `/review/${approvalSession.sessionId}/approve` }));
  assert.equal(approve.dispatched, true);
  assert.equal((await getSession(cpbRoot, approvalSession.sessionId)).status, "dispatched");
  assert.ok((await listQueue(hubRoot)).some((entry) => entry.id === approve.taskId));
  const autoApprove = bodyOf(await app.inject({ method: "POST", url: `/review/${approvalSession.sessionId}/auto-approve` }));
  assert.equal(autoApprove.note, "already_dispatched");

  const rejectSession = await createSession(cpbRoot, { project: "proj", intent: "reject review" });
  const rejectWorktree = await tempRoot("cpb-api-review-reject-wt");
  await updateSession(cpbRoot, rejectSession.sessionId, {
    status: "user_review",
    worktreePath: rejectWorktree,
  }, { skipTransitionCheck: true });
  const reject = bodyOf(await app.inject({ method: "POST", url: `/review/${rejectSession.sessionId}/reject` }));
  assert.equal(reject.status, "expired");
  assert.equal(existsSync(rejectWorktree), false);

  const successJobId = "job-review-success";
  const baseBranch = await git(sourcePath, ["branch", "--show-current"]);
  await git(sourcePath, ["checkout", "-b", `cpb/${successJobId}-pipeline`]);
  await writeFile(path.join(sourcePath, "feature.txt"), "success\n", "utf8");
  await git(sourcePath, ["add", "feature.txt"]);
  await git(sourcePath, ["commit", "-m", "feature"]);
  await git(sourcePath, ["checkout", baseBranch]);
  const acceptSuccess = await createSession(cpbRoot, { project: "proj", intent: "accept success" });
  const successWorktree = await tempRoot("cpb-api-review-success-wt");
  await updateSession(cpbRoot, acceptSuccess.sessionId, {
    status: "user_review",
    jobId: successJobId,
    worktreePath: successWorktree,
  }, { skipTransitionCheck: true });
  const accepted = bodyOf(await app.inject({ method: "POST", url: `/review/${acceptSuccess.sessionId}/accept` }));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.merged, true);
  assert.equal((await getSession(cpbRoot, acceptSuccess.sessionId)).status, "completed");
  let projectIndex = await readProjectIndex(hubRoot, cpbRoot, "proj");
  assert.equal(projectIndex.state, "indexed");
  assert.equal(projectIndex.indexedFrom, `merge:${successJobId}`);

  const failureSession = await createSession(cpbRoot, { project: "proj", intent: "accept failure" });
  const failureWorktree = await tempRoot("cpb-api-review-failure-wt");
  await updateSession(cpbRoot, failureSession.sessionId, {
    status: "user_review",
    jobId: "job-review-missing-branch",
    worktreePath: failureWorktree,
  }, { skipTransitionCheck: true });
  const failedAccept = bodyOf(await app.inject({ method: "POST", url: `/review/${failureSession.sessionId}/accept` }));
  assert.equal(failedAccept.accepted, true);
  assert.equal(failedAccept.mergeFailed, true);
  assert.equal((await getSession(cpbRoot, failureSession.sessionId)).status, "merge_failed");
  projectIndex = await readProjectIndex(hubRoot, cpbRoot, "proj");
  assert.equal(projectIndex.state, "failed");
  assert.equal(projectIndex.indexedFrom, "merge:job-review-missing-branch");

  await app.close();
});

test("GitHub webhook route rejects bad inputs, returns 202 for unsupported/unregistered events, and gates approve permissions", async () => {
  const cpbRoot = await tempRoot("cpb-api-github-cpb");
  const hubRoot = await tempRoot("cpb-api-github-hub");
  const sourcePath = await tempRoot("cpb-api-github-source");
  const secret = await configureGithubWebhook(hubRoot);
  const app = await makeApp(githubRoutes, { cpbRoot, hubRoot, opts: { githubDryRun: true } });

  const goodRaw = JSON.stringify(issuePayload());
  const badSig = await app.inject({
    method: "POST",
    url: "/github/webhook",
    headers: { ...signedHeaders(goodRaw, secret), "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
    payload: goodRaw,
  });
  assert.equal(badSig.statusCode, 401);

  const invalidRaw = "{bad-json";
  const badJson = await app.inject({
    method: "POST",
    url: "/github/webhook",
    headers: signedHeaders(invalidRaw, secret),
    payload: invalidRaw,
  });
  assert.equal(badJson.statusCode, 400);

  const unregistered = await app.inject({
    method: "POST",
    url: "/github/webhook",
    headers: signedHeaders(goodRaw, secret, "issues"),
    payload: goodRaw,
  });
  assert.equal(unregistered.statusCode, 202);
  assert.equal(bodyOf(unregistered).accepted, true);
  assert.deepEqual(await listQueue(hubRoot), []);

  await registerProject(hubRoot, { id: "proj", sourcePath, skipCodeGraphGate: true });
  await updateProject(hubRoot, "proj", { github: { fullName: "owner/repo", triggers: [{ event: "issues.labeled", label: "cpb", workflow: "standard" }] } });
  const unsupported = await app.inject({
    method: "POST",
    url: "/github/webhook",
    headers: signedHeaders(JSON.stringify({ repository: { full_name: "owner/repo" }, action: "created" }), secret, "ping"),
    payload: JSON.stringify({ repository: { full_name: "owner/repo" }, action: "created" }),
  });
  assert.equal(unsupported.statusCode, 202);
  assert.equal(bodyOf(unsupported).normalized.status, "ignored");

  const approval = await enqueue(hubRoot, {
    projectId: "proj",
    sourcePath,
    description: "waiting for approval",
    metadata: { repo: "owner/repo", issueNumber: 5 },
  });
  await updateEntry(hubRoot, approval.id, { status: "waiting.approval" });

  const contributor = JSON.stringify(commentPayload({ body: `/cpb approve ${approval.id}`, association: "CONTRIBUTOR" }));
  const deniedAuthor = await app.inject({
    method: "POST",
    url: "/github/webhook",
    headers: signedHeaders(contributor, secret, "issue_comment"),
    payload: contributor,
  });
  assert.equal(deniedAuthor.statusCode, 403);
  assert.match(bodyOf(deniedAuthor).error, /collaborators/);

  await updateEntry(hubRoot, approval.id, { status: "waiting.approval", metadata: { repo: "owner/other", issueNumber: 5 } });
  const member = JSON.stringify(commentPayload({ body: `/cpb approve ${approval.id}`, association: "MEMBER" }));
  const deniedRepo = await app.inject({ method: "POST", url: "/github/webhook", headers: signedHeaders(member, secret, "issue_comment"), payload: member });
  assert.equal(deniedRepo.statusCode, 403);
  assert.match(bodyOf(deniedRepo).error, /repo/);

  await updateEntry(hubRoot, approval.id, { status: "waiting.approval", metadata: { repo: "owner/repo", issueNumber: 99 } });
  const deniedIssue = await app.inject({ method: "POST", url: "/github/webhook", headers: signedHeaders(member, secret, "issue_comment"), payload: member });
  assert.equal(deniedIssue.statusCode, 403);
  assert.match(bodyOf(deniedIssue).error, /issue/);

  await updateEntry(hubRoot, approval.id, { status: "waiting.approval", metadata: { repo: "owner/repo", issueNumber: 5 } });
  const policyApp = await makeApp(githubRoutes, {
    cpbRoot,
    hubRoot,
    opts: {
      githubDryRun: true,
      channelPolicy: {
        enabled: true,
        default: "deny",
        allow: [{ channel: "github", action: "status", project: "proj" }],
      },
    },
  });
  const deniedPolicy = await policyApp.inject({ method: "POST", url: "/github/webhook", headers: signedHeaders(member, secret, "issue_comment"), payload: member });
  assert.equal(deniedPolicy.statusCode, 403);
  assert.equal(bodyOf(deniedPolicy).code, "CHANNEL_POLICY_DENIED");
  assert.match(bodyOf(deniedPolicy).error, /not allowed/);
  await policyApp.close();

  const approved = await app.inject({ method: "POST", url: "/github/webhook", headers: signedHeaders(member, secret, "issue_comment"), payload: member });
  assert.equal(approved.statusCode, 202);
  assert.equal(bodyOf(approved).commandHandled, "approve");
  assert.equal(bodyOf(approved).approved.queueEntryId, approval.id);

  await app.close();
});

test("channel policy deny wins over allow, default deny applies, and secret commands do not enqueue", async () => {
  const hubRoot = await tempRoot("cpb-api-policy-hub");
  const policy = {
    enabled: true,
    default: "deny",
    allow: [{ channel: "slack", project: "proj", action: "run" }],
    deny: [{ channel: "slack", project: "proj", action: "run", userId: "bad-user" }],
  };

  assert.equal(evaluateChannelPolicy(policy, {
    channel: "slack",
    project: "proj",
    action: "run",
    userId: "bad-user",
  }).allowed, false);
  assert.equal(evaluateChannelPolicy(policy, {
    channel: "slack",
    project: "proj",
    action: "run",
    userId: "good-user",
  }).allowed, true);
  assert.equal(evaluateChannelPolicy(policy, {
    channel: "discord",
    project: "proj",
    action: "run",
    userId: "good-user",
  }).allowed, false);

  const before = await listQueue(hubRoot);
  const parsed = parseChannelCommand("/cpb run proj rotate OPENAI_API_KEY=sk-1234567890abcdef");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "SECRET_INPUT_REJECTED");
  assert.deepEqual(await listQueue(hubRoot), before);

  const cpbRoot = await tempRoot("cpb-api-secret-events");
  await appendEvent(cpbRoot, "proj", "job-secret-route", {
    type: "phase_result",
    jobId: "job-secret-route",
    project: "proj",
    phase: "execute",
    status: "passed",
    artifact: "artifact.md",
    body: "Bearer sk-1234567890abcdef",
    ts: new Date().toISOString(),
  });
  await rm(cpbRoot, { recursive: true, force: true });
});
