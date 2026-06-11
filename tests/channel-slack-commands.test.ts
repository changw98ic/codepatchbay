import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { parseChannelCommand } from "../server/services/channel/channel-commands.js";
import { parseSlackInteractiveAction, parseSlackSlashCommand, slackActionMetadata, slackQueueActionMetadata } from "../server/services/channel/channel-platforms.js";
import { handleSlackInteractiveAction, handleSlackSlashCommand } from "../server/services/channel/channel-platforms.js";
import { createChannelQueueJob } from "../server/services/event/event-source.js";
import { handleChannelCommand, queueEntryStatus } from "../server/services/channel/channel-platforms.js";
import { createJob, failJob, getJob } from "../server/services/job/job-store.js";
import { enqueue, listQueue } from "../server/services/hub/hub-queue.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { appendEvent, readEvents } from "../server/services/event/event-store.js";
import { tempRoot } from "./helpers.js";

async function makeRoots(prefix = "cpb-chan") {
  const cpbRoot = await tempRoot(prefix);
  const hubRoot = path.join(cpbRoot, "hub");
  await mkdir(hubRoot, { recursive: true });
  return { cpbRoot, hubRoot };
}

test("parseChannelCommand: /cpb run frontend task", () => {
  const cmd = parseChannelCommand("/cpb run frontend add dark mode");
  assert.equal(cmd.ok, true);
  assert.equal(cmd.type, "run");
  assert.equal(cmd.project, "frontend");
  assert.equal(cmd.task, "add dark mode");
});

test("parseChannelCommand: /cpb status job-abc123", () => {
  const cmd = parseSlackSlashCommand({
    command: "/cpb",
    text: "status job-abc123",
    user_id: "U123",
    user_name: "tester",
    team_id: "T1",
    channel_id: "C1",
    channel_name: "dev",
  });
  assert.equal(cmd.ok, true);
  assert.equal(cmd.command.type, "status");
  assert.equal(cmd.command.job, "job-abc123");
  assert.equal(cmd.actor.userId, "U123");
  assert.equal(cmd.channel, "slack");
});

test("parseSlackSlashCommand: /cpb run frontend task", () => {
  const parsed = parseSlackSlashCommand({
    command: "/cpb",
    text: "run frontend add dark mode",
    user_id: "U1",
    user_name: "alice",
    team_id: "T1",
    channel_id: "C1",
    channel_name: "dev",
    trigger_id: "trigger-1",
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.channel, "slack");
  assert.equal(parsed.command.type, "run");
  assert.equal(parsed.command.project, "frontend");
  assert.equal(parsed.command.task, "add dark mode");
  assert.equal(parsed.triggerId, "trigger-1");
  assert.equal(parsed.actor.userId, "U1");
});

test("createChannelQueueJob: creates queue entry and job for run command", async () => {
  const { cpbRoot, hubRoot } = await makeRoots("cpb-run-job");
  const sourcePath = await tempRoot("cpb-run-job-src");
  const project = await registerProject(hubRoot, {
    id: "frontend",
    sourcePath,
    skipCodeGraphGate: true,
  });
  const command = parseChannelCommand("/cpb run frontend add dark mode");

  const result = await createChannelQueueJob(cpbRoot, command, {
    channel: "slack",
    actor: "U1",
    actorName: "alice",
    teamId: "T1",
    channelId: "C1",
    channelName: "dev",
  }, { hubRoot });

  assert.equal(result.status, "created", "status should be created");
  assert.ok(result.queueEntry, "queue entry should exist");
  assert.equal(result.queueEntry.projectId, "frontend");
  assert.equal(result.queueEntry.description, "add dark mode");
  assert.ok(result.job, "job should exist");
  assert.equal(result.job.project, "frontend");
  assert.equal(result.job.task, "add dark mode");
  assert.equal(result.job.status, "running");
  assert.equal(result.job.queueEntryId, result.queueEntry.id);
  assert.ok(
    await getJob(cpbRoot, "frontend", result.job.jobId, { dataRoot: project.projectRuntimeRoot }),
    "job should be readable from the registered project runtime root",
  );
  assert.equal(
    existsSync(path.join(cpbRoot, "cpb-task", "events", "frontend", `${result.job.jobId}.jsonl`)),
    false,
    "immediate channel job creation must not write legacy runtime events",
  );
});

test("createChannelQueueJob: issue command does not create job", async () => {
  const { cpbRoot, hubRoot } = await makeRoots("cpb-issue-nojob");
  const command = parseChannelCommand("/cpb issue frontend 42");

  const result = await createChannelQueueJob(cpbRoot, command, {
    channel: "slack",
    actor: "U1",
  }, { hubRoot });

  assert.equal(result.status, "created");
  assert.ok(result.queueEntry);
  assert.equal(result.job, null, "issue command should not create a job");
});

test("handleSlackSlashCommand: run returns View Run and Cancel actions", async () => {
  const { cpbRoot, hubRoot } = await makeRoots("cpb-run-actions");
  const sourcePath = await tempRoot("cpb-run-actions-src");
  await registerProject(hubRoot, {
    id: "frontend",
    sourcePath,
    skipCodeGraphGate: true,
  });
  const parsed = parseSlackSlashCommand({
    command: "/cpb",
    text: "run frontend add dark mode",
    user_id: "U1",
    user_name: "alice",
    team_id: "T1",
    channel_id: "C1",
    channel_name: "dev",
  });

  const result = await handleSlackSlashCommand(cpbRoot, parsed, { hubRoot }) as Record<string, any>;

  assert.equal(result.ok, true);
  assert.equal(result.channel, "slack");
  assert.equal(result.action, "queued");
  assert.ok(result.job, "response should include job");
  assert.ok(result.actions, "response should include actions");
  assert.ok(result.actions.viewRun, "should include View Run action");
  assert.equal(result.actions.viewRun.type, "link");
  assert.equal(result.actions.viewRun.label, "View Run");
  assert.ok(result.actions.cancel, "should include Cancel action");
  assert.equal(result.actions.cancel.type, "command");
  assert.equal(result.actions.cancel.label, "Cancel");
  assert.match(result.actions.cancel.command, /\/cpb cancel/);
});

test("handleSlackSlashCommand: status returns current projection for job", async () => {
  const { cpbRoot, hubRoot } = await makeRoots("cpb-status-proj");
  const sourcePath = await tempRoot("cpb-status-proj-src");
  const project = await registerProject(hubRoot, {
    id: "frontend",
    sourcePath,
    skipCodeGraphGate: true,
  });

  // Create a job first
  const job = await createJob(cpbRoot, {
    project: "frontend",
    task: "test task",
    workflow: "standard",
    dataRoot: project.projectRuntimeRoot,
  });

  const parsed = parseSlackSlashCommand({
    command: "/cpb",
    text: `status ${job.jobId}`,
    user_id: "U1",
    user_name: "alice",
    team_id: "T1",
    channel_id: "C1",
    channel_name: "dev",
  });

  const result = await handleSlackSlashCommand(cpbRoot, parsed, { hubRoot }) as Record<string, any>;

  assert.equal(result.ok, true);
  assert.equal(result.action, "status");
  assert.ok(result.status, "should include status projection");
  assert.equal(result.status.jobId, job.jobId);
  assert.equal(result.status.project, "frontend");
  assert.equal(result.status.task, "test task");
  assert.ok(result.actions, "should include actions");
  assert.ok(result.actions.viewRun, "should include View Run action");
  assert.ok(result.actions.cancel, "should include Cancel action");
});

test("handleSlackSlashCommand: cross-root job actions keep project runtime root strict", async () => {
  const { cpbRoot, hubRoot } = await makeRoots("cpb-cross-root-actions");
  const sourcePath = path.join(cpbRoot, "workspace");
  const dataRoot = path.join(hubRoot, "projects", "frontend");
  await mkdir(sourcePath, { recursive: true });
  await registerProject(hubRoot, {
    id: "frontend",
    name: "frontend",
    sourcePath,
    cpbRoot,
    projectRuntimeRoot: dataRoot,
    skipCodeGraphGate: true,
  });

  const jobId = "job-20260611-010203-cross";
  await createJob(cpbRoot, {
    project: "frontend",
    task: "project-root task",
    workflow: "standard",
    jobId,
    dataRoot,
  });
  await appendEvent(cpbRoot, "frontend", jobId, {
    type: "phase_activity",
    project: "frontend",
    jobId,
    message: "legacy event must not leak into channel logs",
    ts: "2026-06-11T01:02:04.000Z",
  }, { legacyOnly: true });

  const logsParsed = parseSlackSlashCommand({
    command: "/cpb",
    text: `logs ${jobId}`,
    user_id: "U1",
    user_name: "alice",
    team_id: "T1",
    channel_id: "C1",
    channel_name: "dev",
  });
  const logs = await handleSlackSlashCommand(cpbRoot, logsParsed, { hubRoot }) as Record<string, any>;

  assert.equal(logs.ok, true);
  assert.equal(logs.action, "logs");
  assert.equal(logs.events.some((event: Record<string, any>) => event.message === "legacy event must not leak into channel logs"), false);

  const cancelParsed = parseSlackSlashCommand({
    command: "/cpb",
    text: `cancel ${jobId}`,
    user_id: "U1",
    user_name: "alice",
    team_id: "T1",
    channel_id: "C1",
    channel_name: "dev",
  });
  const cancelled = await handleSlackSlashCommand(cpbRoot, cancelParsed, { hubRoot }) as Record<string, any>;

  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.action, "cancelled");
  assert.equal((await getJob(cpbRoot, "frontend", jobId, { dataRoot })).status, "cancelled");
  assert.equal((await readEvents(cpbRoot, "frontend", jobId, { dataRoot, includeLegacyFallback: false }))
    .some((event: Record<string, any>) => event.type === "job_cancelled"), true);
});

test("handleSlackSlashCommand: cross-root retry creates recovery in project runtime root", async () => {
  const { cpbRoot, hubRoot } = await makeRoots("cpb-cross-root-retry");
  const sourcePath = path.join(cpbRoot, "workspace");
  const dataRoot = path.join(hubRoot, "projects", "frontend");
  await mkdir(sourcePath, { recursive: true });
  await registerProject(hubRoot, {
    id: "frontend",
    name: "frontend",
    sourcePath,
    cpbRoot,
    projectRuntimeRoot: dataRoot,
    skipCodeGraphGate: true,
  });

  const job = await createJob(cpbRoot, {
    project: "frontend",
    task: "retry me",
    workflow: "standard",
    jobId: "job-20260611-020304-retry",
    dataRoot,
  });
  await failJob(cpbRoot, "frontend", job.jobId, {
    reason: "test failure",
    code: "RECOVERABLE",
    phase: "plan",
    dataRoot,
  });

  const retryParsed = parseSlackSlashCommand({
    command: "/cpb",
    text: `retry ${job.jobId}`,
    user_id: "U1",
    user_name: "alice",
    team_id: "T1",
    channel_id: "C1",
    channel_name: "dev",
  });
  const retried = await handleSlackSlashCommand(cpbRoot, retryParsed, { hubRoot }) as Record<string, any>;

  assert.equal(retried.ok, true);
  assert.equal(retried.action, "retried");
  assert.equal(retried.recoveryOf, job.jobId);
  assert.equal((await getJob(cpbRoot, "frontend", retried.job.jobId, { dataRoot })).sourceContext.previousFailure.jobId, job.jobId);
  assert.deepEqual(await readEvents(cpbRoot, "frontend", retried.job.jobId, { legacyOnly: true }), []);
});

test("handleSlackInteractiveAction: cross-root job actions keep project runtime root strict", async () => {
  const { cpbRoot, hubRoot } = await makeRoots("cpb-slack-action-cross-root");
  const sourcePath = path.join(cpbRoot, "workspace");
  const dataRoot = path.join(hubRoot, "projects", "frontend");
  await mkdir(sourcePath, { recursive: true });
  await registerProject(hubRoot, {
    id: "frontend",
    name: "frontend",
    sourcePath,
    cpbRoot,
    projectRuntimeRoot: dataRoot,
    skipCodeGraphGate: true,
  });

  const cancelJobId = "job-20260611-030405-action-cancel";
  await createJob(cpbRoot, {
    project: "frontend",
    task: "cancel from Slack action",
    workflow: "standard",
    jobId: cancelJobId,
    dataRoot,
  });
  await appendEvent(cpbRoot, "frontend", cancelJobId, {
    type: "phase_activity",
    project: "frontend",
    jobId: cancelJobId,
    message: "legacy event must stay isolated",
    ts: "2026-06-11T03:04:06.000Z",
  }, { legacyOnly: true });

  const cancelParsed = parseSlackInteractiveAction({
    user: { id: "U1", username: "alice" },
    team: { id: "T1" },
    channel: { id: "C1", name: "dev" },
    actions: [{
      action_id: "cpb.cancel",
      value: JSON.stringify({ action: "cancel", job: cancelJobId }),
    }],
  });
  const cancelled = await handleSlackInteractiveAction(cpbRoot, cancelParsed, { hubRoot }) as Record<string, any>;

  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.action, "cancelled");
  assert.equal((await getJob(cpbRoot, "frontend", cancelJobId, { dataRoot })).status, "cancelled");
  assert.equal((await readEvents(cpbRoot, "frontend", cancelJobId, { dataRoot, includeLegacyFallback: false }))
    .some((event: Record<string, any>) => event.type === "job_cancelled"), true);

  const retryJobId = "job-20260611-040506-action-retry";
  const retrySource = await createJob(cpbRoot, {
    project: "frontend",
    task: "retry from Slack action",
    workflow: "standard",
    jobId: retryJobId,
    dataRoot,
  });
  await failJob(cpbRoot, "frontend", retrySource.jobId, {
    reason: "test failure",
    code: "RECOVERABLE",
    phase: "plan",
    dataRoot,
  });

  const retryParsed = parseSlackInteractiveAction({
    user: { id: "U1", username: "alice" },
    team: { id: "T1" },
    channel: { id: "C1", name: "dev" },
    actions: [{
      action_id: "cpb.retry",
      value: JSON.stringify({ action: "retry", job: retrySource.jobId }),
    }],
  });
  const retried = await handleSlackInteractiveAction(cpbRoot, retryParsed, { hubRoot }) as Record<string, any>;

  assert.equal(retried.ok, true);
  assert.equal(retried.action, "retried");
  assert.equal(retried.recoveryOf, retrySource.jobId);
  assert.equal((await getJob(cpbRoot, "frontend", retried.job.jobId, { dataRoot })).sourceContext.previousFailure.jobId, retrySource.jobId);
  assert.deepEqual(await readEvents(cpbRoot, "frontend", retried.job.jobId, { legacyOnly: true }), []);
});

test("handleSlackSlashCommand: status falls back to queue entry", async () => {
  const { cpbRoot, hubRoot } = await makeRoots("cpb-status-q");

  // Create a queue entry only (no job)
  const entry = await enqueue(hubRoot, {
    projectId: "frontend",
    description: "queue-only task",
    type: "test",
    metadata: { workflow: "standard" },
  });

  const parsed = parseSlackSlashCommand({
    command: "/cpb",
    text: `status ${entry.id}`,
    user_id: "U1",
    user_name: "alice",
    team_id: "T1",
    channel_id: "C1",
    channel_name: "dev",
  });

  const result = await handleSlackSlashCommand(cpbRoot, parsed, { hubRoot }) as Record<string, any>;

  assert.equal(result.ok, true);
  assert.equal(result.action, "status");
  assert.ok(result.status, "should include queue entry status");
  assert.equal(result.status.queueEntryId, entry.id);
  assert.equal(result.status.project, "frontend");
});

test("handleSlackSlashCommand: status returns error for unknown job", async () => {
  const { cpbRoot, hubRoot } = await makeRoots("cpb-status-unk");

  const parsed = parseSlackSlashCommand({
    command: "/cpb",
    text: "status job-nonexistent",
    user_id: "U1",
    user_name: "alice",
    team_id: "T1",
    channel_id: "C1",
    channel_name: "dev",
  });

  const result = await handleSlackSlashCommand(cpbRoot, parsed, { hubRoot }) as Record<string, any>;

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("job not found"));
});

test("slackActionMetadata returns View Run and Cancel", () => {
  const meta = slackActionMetadata("job-123");
  assert.equal(meta.viewRun.type, "link");
  assert.equal(meta.viewRun.label, "View Run");
  assert.equal(meta.viewRun.url, "/jobs/job-123");
  assert.equal(meta.viewRun.value, "job-123");
  assert.equal(meta.cancel.type, "command");
  assert.equal(meta.cancel.label, "Cancel");
  assert.equal(meta.cancel.command, "/cpb cancel job-123");
  assert.equal(meta.cancel.value, "job-123");
});

test("slackQueueActionMetadata returns Status, Cancel, Retry", () => {
  const meta = slackQueueActionMetadata("q-abc");
  assert.equal(meta.status.type, "command");
  assert.equal(meta.status.label, "Status");
  assert.equal(meta.cancel.type, "command");
  assert.equal(meta.cancel.label, "Cancel");
  assert.equal(meta.retry.type, "command");
  assert.equal(meta.retry.label, "Retry");
});
