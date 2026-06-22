import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { finalizeSuccessfulQueueEntry } from "../server/services/auto-finalizer.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

async function writePassVerdict(root: string, status = "pass") {
  const verdictPath = path.join(root, `verdict-${status}.json`);
  await writeFile(
    verdictPath,
    [
      "```json",
      JSON.stringify({
        status,
        reason: `${status} verdict for finalizer test`,
        tests: ["node --test tests/auto-finalizer.test.ts"],
      }, null, 2),
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  return verdictPath;
}

async function setupGitFixture() {
  const root = await tempRoot("cpb-auto-finalizer");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  const sourcePath = path.join(root, "source");
  const worktreePath = path.join(root, "worktree");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });

  await git(sourcePath, ["init"]);
  await git(sourcePath, ["config", "user.email", "cpb@example.test"]);
  await git(sourcePath, ["config", "user.name", "CodePatchBay Test"]);
  await git(sourcePath, ["branch", "-M", "main"]);
  await writeFile(path.join(sourcePath, "README.md"), "# Fixture\n", "utf8");
  await git(sourcePath, ["add", "README.md"]);
  await git(sourcePath, ["commit", "-m", "Initial fixture"]);
  await git(sourcePath, ["worktree", "add", "-b", "cpb/job-finalizer", worktreePath]);
  await writeFile(path.join(worktreePath, "README.md"), "# Fixture\n\nChanged by CPB.\n", "utf8");
  await git(worktreePath, ["add", "README.md"]);
  await git(worktreePath, ["commit", "-m", "Change fixture"]);

  return { root, cpbRoot, hubRoot, dataRoot, sourcePath, worktreePath };
}

async function setupProtectedDiffFixture() {
  const fixture = await setupGitFixture();
  await writeFile(path.join(fixture.worktreePath, "auth.ts"), "export const auth = true;\n", "utf8");
  await git(fixture.worktreePath, ["add", "auth.ts"]);
  await git(fixture.worktreePath, ["commit", "-m", "Touch protected auth file"]);
  return fixture;
}

async function seedJobEvents({
  cpbRoot,
  dataRoot,
  project = "proj",
  jobId = "job-finalizer",
  worktreePath,
  worktreeBranch = "cpb/job-finalizer",
  verdictStatus = "pass",
  completionGate = true,
}: Record<string, any>) {
  const verdictPath = await writePassVerdict(cpbRoot, verdictStatus);
  const eventOptions = { dataRoot };
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task: "Fix issue with evidence",
    sourceContext: {
      type: "github_issue",
      repo: "owner/repo",
      issueNumber: 42,
      issueTitle: "Fix issue with evidence",
    },
    ts: "2026-06-22T00:00:00.000Z",
  }, eventOptions);
  await appendEvent(cpbRoot, project, jobId, {
    type: "worktree_created",
    jobId,
    project,
    worktree: worktreePath,
    branch: worktreeBranch,
    baseBranch: "main",
    ts: "2026-06-22T00:00:01.000Z",
  }, eventOptions);
  await appendEvent(cpbRoot, project, jobId, {
    type: "artifact_created",
    jobId,
    project,
    phase: "verify",
    kind: "verdict",
    artifactKind: "verdict",
    artifact: verdictPath,
    ts: "2026-06-22T00:00:02.000Z",
  }, eventOptions);
  if (completionGate) {
    await appendEvent(cpbRoot, project, jobId, {
      type: "completion_gate_evaluated",
      jobId,
      project,
      outcome: "complete",
      reason: "all required evidence passed",
      missingGates: [],
      checklistOutcome: "complete",
      ts: "2026-06-22T00:00:03.000Z",
    }, eventOptions);
  }
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_completed",
    jobId,
    project,
    ts: "2026-06-22T00:00:04.000Z",
  }, eventOptions);
}

function issueEntry(overrides: Record<string, any> = {}) {
  const { metadata: metadataOverrides = {}, ...rest } = overrides;
  return {
    id: "entry-finalizer",
    projectId: "proj",
    description: "Fix issue with evidence",
    metadata: {
      autoFinalize: true,
      repo: "owner/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/owner/repo/issues/42",
      ...metadataOverrides,
    },
    ...rest,
  };
}

function completedJob(worktreePath: string, overrides: Record<string, any> = {}) {
  return {
    status: "completed",
    jobId: "job-finalizer",
    project: "proj",
    worktree: worktreePath,
    worktreeBranch: "cpb/job-finalizer",
    worktreeBaseBranch: "main",
    task: "Fix issue with evidence",
    sourceContext: {
      type: "github_issue",
      repo: "owner/repo",
      issueNumber: 42,
      issueTitle: "Fix issue with evidence",
    },
    ...overrides,
  };
}

test("finalizeSuccessfulQueueEntry dry-run builds draft PR request from materialized PASS evidence without live side effects", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture });
  const gitCalls: string[][] = [];
  let createPullRequestCalls = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry(),
    job: completedJob(fixture.worktreePath),
    sourcePath: fixture.sourcePath,
    mode: "dry-run",
    runCommand: async (command: string, args: string[], opts: Record<string, any>) => {
      gitCalls.push([command, ...args]);
      return execFileAsync(command, args, opts);
    },
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      throw new Error("dry-run must not call createPullRequest");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry-run");
  assert.equal(result.mode, "dry-run");
  assert.equal(result.pr?.status, "dry-run");
  assert.equal(result.pr?.posted, false);
  assert.equal(result.pr?.request?.repo, "owner/repo");
  assert.equal(result.pr?.request?.head, "cpb/job-finalizer");
  assert.equal(result.pr?.request?.base, "main");
  assert.match(result.pr?.request?.body || "", /CodePatchBay/);
  assert.equal(createPullRequestCalls, 0);
  assert.equal(gitCalls.some((call) => call[0] === "git" && ["add", "commit", "push"].includes(call[1])), false);
});

test("finalizeSuccessfulQueueEntry defaults to dry-run without live merge or PR side effects", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture });
  const gitCalls: string[][] = [];
  let createPullRequestCalls = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry(),
    job: completedJob(fixture.worktreePath),
    sourcePath: fixture.sourcePath,
    runCommand: async (command: string, args: string[], opts: Record<string, any>) => {
      gitCalls.push([command, ...args]);
      return execFileAsync(command, args, opts);
    },
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      throw new Error("implicit dry-run must not create a pull request");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry-run");
  assert.equal(result.mode, "dry-run");
  assert.equal(result.pr?.status, "dry-run");
  assert.equal(createPullRequestCalls, 0);
  assert.equal(
    gitCalls.some((call) => call[0] === "git" && ["add", "commit", "push", "merge", "stash"].includes(call[1])),
    false,
  );
});

test("finalizeSuccessfulQueueEntry blocks dry-run PR preview without materialized completion gate", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture, completionGate: false });
  let createPullRequestCalls = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry(),
    job: completedJob(fixture.worktreePath),
    sourcePath: fixture.sourcePath,
    mode: "dry-run",
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      throw new Error("missing completion gate must not create a pull request");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "COMPLETION_GATE_NOT_COMPLETE");
  assert.equal(createPullRequestCalls, 0);
});

test("finalizeSuccessfulQueueEntry blocks dry-run PR preview when materialized verdict is not PASS", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture, verdictStatus: "fail" });

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry(),
    job: completedJob(fixture.worktreePath),
    sourcePath: fixture.sourcePath,
    mode: "dry-run",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "VERDICT_NOT_PASS");
});

test("finalizeSuccessfulQueueEntry dry-run rejects dirty source without git stash mutation", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture });
  await writeFile(path.join(fixture.sourcePath, "local-note.txt"), "operator local change\n", "utf8");
  const gitCalls: string[][] = [];

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry(),
    job: completedJob(fixture.worktreePath),
    sourcePath: fixture.sourcePath,
    mode: "dry-run",
    runCommand: async (command: string, args: string[], opts: Record<string, any>) => {
      gitCalls.push([command, ...args]);
      return execFileAsync(command, args, opts);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "SOURCE_NOT_CLEAN");
  assert.equal(gitCalls.some((call) => call[0] === "git" && call[1] === "stash"), false);
  const status = await git(fixture.sourcePath, ["status", "--porcelain"]);
  assert.match(status.stdout, /local-note\.txt/);
});

test("finalizeSuccessfulQueueEntry live PR rejects dirty source without git stash mutation", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture });
  await writeFile(path.join(fixture.sourcePath, "local-note.txt"), "operator local change\n", "utf8");
  const gitCalls: string[][] = [];
  let createPullRequestCalls = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry(),
    job: completedJob(fixture.worktreePath),
    sourcePath: fixture.sourcePath,
    mode: "pr",
    allowLiveFinalize: true,
    runCommand: async (command: string, args: string[], opts: Record<string, any>) => {
      gitCalls.push([command, ...args]);
      return execFileAsync(command, args, opts);
    },
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      throw new Error("dirty source must not create a pull request");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "SOURCE_NOT_CLEAN");
  assert.equal(createPullRequestCalls, 0);
  assert.equal(gitCalls.some((call) => call[0] === "git" && call[1] === "stash"), false);
  const status = await git(fixture.sourcePath, ["status", "--porcelain"]);
  assert.match(status.stdout, /local-note\.txt/);
});

test("finalizeSuccessfulQueueEntry live PR rejects uncommitted worktree changes after evidence", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture });
  await writeFile(path.join(fixture.worktreePath, "post-gate.txt"), "not covered by completion evidence\n", "utf8");
  const gitCalls: string[][] = [];
  let createPullRequestCalls = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry(),
    job: completedJob(fixture.worktreePath),
    sourcePath: fixture.sourcePath,
    mode: "pr",
    allowLiveFinalize: true,
    runCommand: async (command: string, args: string[], opts: Record<string, any>) => {
      gitCalls.push([command, ...args]);
      return execFileAsync(command, args, opts);
    },
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      throw new Error("uncommitted worktree changes must not create a pull request");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "WORKTREE_NOT_CLEAN_FOR_LIVE_PR");
  assert.deepEqual(result.uncommittedFiles, ["post-gate.txt"]);
  assert.equal(createPullRequestCalls, 0);
  assert.equal(gitCalls.some((call) => call[0] === "git" && ["add", "commit", "push"].includes(call[1])), false);
});

test("finalizeSuccessfulQueueEntry dry-run reports protected diff without queue requeue mutation", async () => {
  const fixture = await setupProtectedDiffFixture();
  await seedJobEvents({ ...fixture });

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry({
      metadata: {
        workflow: "standard",
        planMode: "light",
      },
    }),
    job: completedJob(fixture.worktreePath, { planMode: "light" }),
    sourcePath: fixture.sourcePath,
    mode: "dry-run",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "ROUTE_PROTECTED_DIFF");
  assert.equal(result.requeuedQueueEntryId, null);
  assert.equal(result.dryRun, true);
  await assert.rejects(readdir(path.join(fixture.hubRoot, "queue")), { code: "ENOENT" });
});
