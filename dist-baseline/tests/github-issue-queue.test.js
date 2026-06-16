import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { normalizeGithubWebhookEvent } from "../server/services/github/github-adapter.js";
import { matchGithubTrigger } from "../server/services/github/github-adapter.js";
import { createGithubIssueQueueJob } from "../server/services/event/event-source.js";
import { createJob, getJobByQueueEntryId } from "../server/services/job/job-store.js";
import { enqueue } from "../server/services/hub/hub-queue.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { tempRoot } from "./helpers.js";
function makeIssuePayload(overrides = {}) {
    return {
        action: "labeled",
        issue: {
            number: 42,
            title: "Fix login bug",
            body: "Users cannot log in when password contains special chars",
            html_url: "https://github.com/acme/app/issues/42",
            state: "open",
            labels: [{ name: "cpb" }, { name: "bug" }],
            ...overrides.issue,
        },
        label: { name: "cpb" },
        repository: { full_name: "acme/app" },
        sender: { login: "alice" },
        ...overrides,
    };
}
function makeCommentPayload(overrides = {}) {
    return {
        action: "created",
        issue: {
            number: 7,
            title: "Add dark mode",
            body: "We need dark mode support",
            html_url: "https://github.com/acme/app/issues/7",
            state: "open",
            labels: [],
            ...overrides.issue,
        },
        comment: {
            body: "/cpb run",
            author_association: "MEMBER",
            ...overrides.comment,
        },
        repository: { full_name: "acme/app" },
        sender: { login: "bob" },
        ...overrides,
    };
}
function makeNormalizedEvent(payload, projectId = "test-project") {
    return normalizeGithubWebhookEvent({
        event: payload.action === "created" && payload.comment ? "issue_comment" : "issues",
        delivery: `del-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        payload,
        projectId,
    });
}
async function makeTestRoots() {
    const cpbRoot = await tempRoot("cpb-d25-cpb");
    const hubRoot = await tempRoot("cpb-d25-hub");
    return { cpbRoot, hubRoot };
}
async function registerTestProject(hubRoot, projectId = "flow") {
    const sourcePath = await tempRoot(`cpb-d25-src-${projectId}`);
    return await registerProject(hubRoot, {
        id: projectId,
        sourcePath,
        skipCodeGraphGate: true,
    });
}
// Acceptance 1: Queue entry preserves issue number, repo, title, body, source URL, actor, and workflow.
test("queue entry preserves issue number, repo, title, body, source URL, actor, and workflow", async (t) => {
    const { cpbRoot, hubRoot } = await makeTestRoots();
    const payload = makeIssuePayload();
    const normalized = makeNormalizedEvent(payload, "flow");
    const match = matchGithubTrigger(normalized);
    assert.ok(match.matched, "event should match trigger rule");
    const result = await createGithubIssueQueueJob(cpbRoot, normalized, match, {
        hubRoot,
        enqueueFn: (root, input) => enqueue(root, input),
    });
    assert.equal(result.status, "created");
    const entry = result.queueEntry;
    assert.ok(entry, "queue entry should exist");
    const meta = entry.metadata;
    assert.equal(meta.issueNumber, 42, "issueNumber preserved");
    assert.equal(meta.repo, "acme/app", "repo preserved");
    assert.equal(meta.issueTitle, "Fix login bug", "title preserved");
    assert.equal(meta.issueBody, "Users cannot log in when password contains special chars", "body preserved");
    assert.equal(meta.issueUrl, "https://github.com/acme/app/issues/42", "source URL preserved");
    assert.equal(meta.actor, "alice", "actor preserved");
    assert.ok(typeof meta.workflow === "string" && meta.workflow.length > 0, "workflow preserved");
});
// Acceptance 2: Duplicate webhook deliveries are idempotent.
test("duplicate webhook delivery is idempotent", async (t) => {
    const { cpbRoot, hubRoot } = await makeTestRoots();
    await registerTestProject(hubRoot, "flow");
    const payload = makeIssuePayload();
    const normalized = makeNormalizedEvent(payload, "flow");
    const match = matchGithubTrigger(normalized);
    assert.ok(match.matched);
    const first = await createGithubIssueQueueJob(cpbRoot, normalized, match, {
        hubRoot,
        enqueueFn: (root, input) => enqueue(root, input),
    });
    assert.equal(first.status, "created", "first delivery creates entry");
    assert.ok(first.job, "first delivery creates job");
    // Same delivery ID — simulates webhook retry
    const second = await createGithubIssueQueueJob(cpbRoot, normalized, match, {
        hubRoot,
        enqueueFn: (root, input) => enqueue(root, input),
    });
    assert.equal(second.status, "duplicate", "second delivery returns duplicate");
    assert.equal(second.queueEntry, null, "no new queue entry for duplicate");
});
// Acceptance 3: Created job links back to queue entry.
test("createGithubIssueQueueJob creates a job-store job linked to queue entry", async (t) => {
    const { cpbRoot, hubRoot } = await makeTestRoots();
    const project = await registerTestProject(hubRoot, "flow");
    const payload = makeIssuePayload();
    const normalized = makeNormalizedEvent(payload, "flow");
    const match = matchGithubTrigger(normalized);
    assert.ok(match.matched);
    const result = await createGithubIssueQueueJob(cpbRoot, normalized, match, {
        hubRoot,
        enqueueFn: (root, input) => enqueue(root, input),
    });
    assert.equal(result.status, "created");
    const queueEntryId = result.queueEntry.id;
    const job = result.job;
    assert.ok(job, "job should be created");
    assert.ok(job.jobId, "job should have a jobId");
    assert.equal(job.queueEntryId, queueEntryId, "job.queueEntryId links to queue entry");
    // Verify lookup by queue entry ID
    const found = await getJobByQueueEntryId(cpbRoot, "flow", queueEntryId, { dataRoot: project.projectRuntimeRoot });
    assert.ok(found, "should find job by queue entry ID");
    assert.equal(found.jobId, job.jobId, "found job matches");
    assert.equal(existsSync(path.join(project.projectRuntimeRoot, "events", "flow", `${job.jobId}.jsonl`)), true, "job event should be written under the registered project runtime root");
    assert.equal(existsSync(path.join(cpbRoot, "cpb-task", "events", "flow", `${job.jobId}.jsonl`)), false, "immediate job creation must not write legacy runtime events");
});
// createJob idempotency: creating job with same queueEntryId returns existing
test("createJob with same queueEntryId returns existing job (idempotent)", async (t) => {
    const { cpbRoot, hubRoot } = await makeTestRoots();
    const project = await registerTestProject(hubRoot, "flow");
    const queueEntryId = "q-test-idempotent-001";
    const first = await createJob(cpbRoot, {
        project: "flow",
        task: "First task",
        workflow: "standard",
        queueEntryId,
        dataRoot: project.projectRuntimeRoot,
    });
    assert.ok(first.jobId);
    const second = await createJob(cpbRoot, {
        project: "flow",
        task: "Second task — should be ignored",
        workflow: "standard",
        queueEntryId,
        dataRoot: project.projectRuntimeRoot,
    });
    assert.equal(second.jobId, first.jobId, "same job returned for duplicate queueEntryId");
    assert.equal(second.task, first.task, "original task preserved");
});
test("getJobByQueueEntryId returns null for missing queue entry ID", async () => {
    const cpbRoot = await tempRoot("cpb-d25-missing");
    const found = await getJobByQueueEntryId(cpbRoot, "flow", "q-nonexistent");
    assert.equal(found, null);
});
// Additional: issue comment command triggers queue entry with job
test("issue comment /cpb run creates queue entry and job", async (t) => {
    const { cpbRoot, hubRoot } = await makeTestRoots();
    await registerTestProject(hubRoot, "flow");
    const payload = makeCommentPayload();
    const normalized = makeNormalizedEvent(payload, "flow");
    const match = matchGithubTrigger(normalized);
    assert.ok(match.matched, "comment should match /cpb run trigger");
    const result = await createGithubIssueQueueJob(cpbRoot, normalized, match, {
        hubRoot,
        enqueueFn: (root, input) => enqueue(root, input),
    });
    assert.equal(result.status, "created");
    const meta = result.queueEntry.metadata;
    assert.equal(meta.issueNumber, 7);
    assert.equal(meta.repo, "acme/app");
    assert.equal(meta.actor, "bob");
    assert.equal(meta.commandText, "/cpb run");
    assert.ok(result.job, "job created for comment trigger");
    assert.equal(result.job.queueEntryId, result.queueEntry.id);
});
// Validation error tests
test("createGithubIssueQueueJob rejects non-ok event", async (t) => {
    const cpbRoot = await tempRoot("cpb-d25-err");
    await assert.rejects(() => createGithubIssueQueueJob(cpbRoot, { status: "ignored" }, { matched: true }), { message: /must be normalized/ });
});
test("createGithubIssueQueueJob rejects non-matching event", async (t) => {
    const cpbRoot = await tempRoot("cpb-d25-err2");
    await assert.rejects(() => createGithubIssueQueueJob(cpbRoot, { status: "ok", projectId: "flow" }, { matched: false }), { message: /did not match/ });
});
test("createGithubIssueQueueJob rejects missing project ID", async (t) => {
    const cpbRoot = await tempRoot("cpb-d25-err3");
    await assert.rejects(() => createGithubIssueQueueJob(cpbRoot, { status: "ok" }, { matched: true }), { message: /missing project id/ });
});
