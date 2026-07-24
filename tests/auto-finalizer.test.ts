import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { finalizeSuccessfulQueueEntry } from "../server/services/auto-finalizer.js";
import {
  appendEvent,
  readEvents,
  withEventLockTestHooksForTests,
} from "../server/services/event/event-store.js";
import { finalizerCapabilityDigest } from "../server/services/finalizer-contract.js";
import { getJob } from "../server/services/job/job-store.js";
import { recordValue, type LooseRecord } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);
const validatedCandidates = new Map<string, Record<string, unknown>>();

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

async function rememberValidatedCandidate(sourcePath: string, worktreePath: string) {
  const baseSha = (await git(sourcePath, ["rev-parse", "HEAD"])).stdout.trim().toLowerCase();
  const headSha = (await git(worktreePath, ["rev-parse", "HEAD"])).stdout.trim().toLowerCase();
  const treeHash = (await git(worktreePath, ["rev-parse", "HEAD^{tree}"])).stdout.trim().toLowerCase();
  const changedFiles = (await git(worktreePath, ["diff", "--name-only", baseSha, headSha])).stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const identityHash = `sha256:${createHash("sha256")
    .update(JSON.stringify({ baseSha, headSha, treeHash, changedFiles }))
    .digest("hex")}`;
  validatedCandidates.set(worktreePath, {
    identityMatch: true,
    baseSha,
    headSha,
    treeHash,
    identityHash,
    validatedCandidateIdentityHash: identityHash,
    changedFiles,
    cleanReplay: {
      cleanApply: true,
      baseSha,
      expectedTreeHash: treeHash,
      actualTreeHash: treeHash,
    },
  });
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
  await git(sourcePath, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  await writeFile(path.join(sourcePath, "README.md"), "# Fixture\n", "utf8");
  await git(sourcePath, ["add", "README.md"]);
  await git(sourcePath, ["commit", "-m", "Initial fixture"]);
  await git(sourcePath, ["worktree", "add", "-b", "cpb/job-finalizer", worktreePath]);
  await writeFile(path.join(worktreePath, "README.md"), "# Fixture\n\nChanged by CPB.\n", "utf8");
  await git(worktreePath, ["add", "README.md"]);
  await git(worktreePath, ["commit", "-m", "Change fixture"]);
  await rememberValidatedCandidate(sourcePath, worktreePath);

  return { root, cpbRoot, hubRoot, dataRoot, sourcePath, worktreePath };
}

function liveFinalizerAuthority(fixture: Awaited<ReturnType<typeof setupGitFixture>>) {
  return {
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    transportPrincipal: testTransportPrincipal(),
    mutationFence: {
      assignmentId: "assignment-finalizer-test",
      entryId: "entry-finalizer",
      attemptToken: "attempt-token-finalizer-test",
      orchestratorEpoch: 1,
      workerId: "worker-finalizer-test",
      workerIncarnation: "worker-incarnation-finalizer-test",
      processIdentity: {
        pid: process.pid,
        startTimeTicks: "1",
      },
    },
    assertMutationLease: async () => true,
  };
}

function testTransportPrincipal() {
  return {
    kind: "gh_user" as const,
    stableId: "91",
    login: "cpb-bot",
    authorId: "91",
  };
}

function committedRemoteVerification(
  request: Record<string, any>,
  capability: ReturnType<typeof remoteCapability>,
  committed: boolean,
) {
  const common = {
    repository: capability.repository,
    repositoryId: capability.repositoryId,
    issueNumber: capability.issueNumber,
    capabilityDigest: finalizerCapabilityDigest(capability),
  };
  if (request.operation === "repository.push") {
    return {
      operation: request.operation,
      committed,
      principal: testTransportPrincipal(),
      evidence: {
        ...common,
        targetBranch: request.targetBranch,
        expectedRef: `refs/heads/${request.targetBranch}`,
        actualRef: `refs/heads/${request.targetBranch}`,
        expectedCommit: request.commit,
        actualCommit: committed ? request.commit : "f".repeat(40),
      },
    };
  }
  return {
    operation: request.operation,
    committed,
    principal: testTransportPrincipal(),
    evidence: {
      ...common,
      number: capability.issueNumber,
      state: committed ? "CLOSED" : "OPEN",
      url: `https://github.com/${capability.repository}/issues/${capability.issueNumber}`,
    },
  };
}

async function setupProtectedDiffFixture() {
  const fixture = await setupGitFixture();
  await writeFile(path.join(fixture.worktreePath, "auth.ts"), "export const auth = true;\n", "utf8");
  await git(fixture.worktreePath, ["add", "auth.ts"]);
  await git(fixture.worktreePath, ["commit", "-m", "Touch protected auth file"]);
  await rememberValidatedCandidate(fixture.sourcePath, fixture.worktreePath);
  return fixture;
}

type SeedJobEventsOptions = {
  cpbRoot: string;
  dataRoot: string;
  project?: string;
  jobId?: string;
  worktreePath: string;
  worktreeBranch?: string;
  verdictStatus?: string;
  completionGate?: boolean;
};

async function seedJobEvents({
  cpbRoot,
  dataRoot,
  project = "proj",
  jobId = "job-finalizer",
  worktreePath,
  worktreeBranch = "cpb/job-finalizer",
  verdictStatus = "pass",
  completionGate = true,
}: SeedJobEventsOptions) {
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

type EntryOverrides = Record<string, unknown> & { metadata?: Record<string, unknown> };

function issueEntry(overrides: EntryOverrides = {}) {
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

function completedJob(worktreePath: string, overrides: Record<string, unknown> = {}) {
  const candidateValidation = validatedCandidates.get(worktreePath);
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
    ...(candidateValidation ? {
      completionGate: {
        outcome: "complete",
        completionReport: { candidateValidation },
      },
    } : {}),
    ...overrides,
  };
}

function remoteCapability() {
  return {
    schema: "cpb.github-remote-capability.v1",
    repository: "owner/repo",
    repositoryId: "R_owner_repo",
    defaultBranch: "main",
    markerPath: ".cpb-disposable-target.json",
    markerSha: "a".repeat(40),
    issueNumber: 42,
    automationLabel: "cpb-e2e",
    allowedBranchPrefix: "cpb/",
    permissions: {
      repositoryPush: true,
      pullRequestCreate: true,
      pullRequestMerge: true,
      issueClose: true,
    },
  };
}

function remoteMarker(capability = remoteCapability()) {
  return {
    schemaVersion: 1,
    purpose: "codepatchbay-release-rehearsal",
    repository: capability.repository,
    disposable: true,
    allowCodePatchBayE2E: true,
    allowedIssueNumbers: [capability.issueNumber],
    allowedAutomationLabels: [capability.automationLabel],
    allowedBranchPrefix: capability.allowedBranchPrefix,
    allowRepositoryPush: true,
    allowDraftPullRequests: true,
    allowPullRequestMerge: true,
    allowIssueClose: true,
  };
}

function githubAuthorityResult(
  args: string[],
  {
    capability = remoteCapability(),
    markerSha = capability.markerSha,
    issueState = "OPEN",
    refSha = "b".repeat(40),
    pullRequestNumber = 7,
    pullRequestTitle = "[cpb] Fix issue with evidence",
    pullRequestBody = "",
    pullRequestAuthor = { login: "cpb-bot", id: 91 },
  }: {
    capability?: ReturnType<typeof remoteCapability>;
    markerSha?: string;
    issueState?: string;
    refSha?: string;
    pullRequestNumber?: number;
    pullRequestTitle?: string;
    pullRequestBody?: string;
    pullRequestAuthor?: { login: string; id: number };
  } = {},
) {
  if (args[0] === "repo" && args[1] === "view") {
    return {
      stdout: JSON.stringify({
        id: capability.repositoryId,
        nameWithOwner: capability.repository,
        defaultBranchRef: { name: capability.defaultBranch },
      }),
    };
  }
  if (args[0] === "api" && String(args[1]).includes("/contents/")) {
    return {
      stdout: JSON.stringify({
        path: capability.markerPath,
        sha: markerSha,
        content: Buffer.from(JSON.stringify(remoteMarker(capability)), "utf8").toString("base64"),
      }),
    };
  }
  if (args[0] === "api" && args[1] === "user") {
    return { stdout: JSON.stringify(pullRequestAuthor) };
  }
  if (args[0] === "api" && String(args[1]).includes("/git/ref/heads/")) {
    const encodedBranch = String(args[1]).split("/git/ref/heads/")[1] || "main";
    return {
      stdout: JSON.stringify({
        ref: `refs/heads/${decodeURIComponent(encodedBranch).replace(/%2F/gi, "/")}`,
        object: { sha: refSha },
      }),
    };
  }
  if (args[0] === "issue" && args[1] === "view") {
    return {
      stdout: JSON.stringify({
        number: capability.issueNumber,
        state: issueState,
        labels: [{ name: capability.automationLabel }],
        url: `https://github.com/${capability.repository}/issues/${capability.issueNumber}`,
      }),
    };
  }
  const apiTarget = args[0] === "api" ? String(args[args.length - 1]) : "";
  if (apiTarget.includes(`/repos/${capability.repository}/pulls`) || apiTarget.includes(`repos/${capability.repository}/pulls`)) {
    const pullRequest = {
      number: pullRequestNumber,
      state: "open",
      draft: true,
      title: pullRequestTitle,
      body: pullRequestBody,
      html_url: `https://github.com/${capability.repository}/pull/${pullRequestNumber}`,
      user: pullRequestAuthor,
      head: {
        ref: "cpb/job-finalizer",
        sha: refSha,
        repo: { full_name: capability.repository },
      },
      base: {
        ref: capability.defaultBranch,
        repo: { full_name: capability.repository },
      },
    };
    return {
      stdout: JSON.stringify(args.includes("--slurp") ? [[pullRequest]] : pullRequest),
    };
  }
  if (args[0] === "pr" && args[1] === "view") {
    return {
      stdout: JSON.stringify({
        number: pullRequestNumber,
        state: "OPEN",
        isDraft: true,
        headRefName: "cpb/job-finalizer",
        baseRefName: capability.defaultBranch,
        headRefOid: refSha,
        title: "[cpb] Fix issue with evidence",
        url: `https://github.com/${capability.repository}/pull/${pullRequestNumber}`,
        mergedAt: null,
        mergeCommit: null,
      }),
    };
  }
  throw new Error(`unexpected gh command: ${args.join(" ")}`);
}

test("live PR and remote finalizers require a capability without metadata opt-in and perform zero remote writes", async () => {
  const fixture = await setupGitFixture();
  let remoteWrites = 0;

  for (const mode of ["remote", "pr"] as const) {
    const result: any = await finalizeSuccessfulQueueEntry({
      entry: issueEntry(),
      job: completedJob(fixture.worktreePath),
      sourcePath: fixture.sourcePath,
      mode,
      allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
      runCommand: async (command, args, options) => {
        if (command === "gh" || (command === "git" && args[0] === "push")) remoteWrites += 1;
        return execFileAsync(command, args, options);
      },
      issueCloser: async () => {
        remoteWrites += 1;
        return { ok: true, state: "CLOSED" };
      },
      createPullRequest: async () => {
        remoteWrites += 1;
        return { url: "https://github.com/owner/repo/pull/7", number: 7 };
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.code, "REMOTE_CAPABILITY_MISSING");
    assert.equal(result.committed, false);
  }

  assert.equal(remoteWrites, 0);
});

test("remote finalizer rejects conflicting canonical capability generations with zero remote writes", async () => {
  const fixture = await setupGitFixture();
  let remoteWrites = 0;
  const replacedCapability = {
    ...remoteCapability(),
    markerSha: "b".repeat(40),
  };

  const result: any = await finalizeSuccessfulQueueEntry({
    entry: issueEntry({ metadata: { remoteCapability: remoteCapability() } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: replacedCapability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "remote",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh" || (command === "git" && args[0] === "push")) remoteWrites += 1;
      return execFileAsync(command, args, options);
    },
    issueCloser: async () => {
      remoteWrites += 1;
      return { ok: true, state: "CLOSED" };
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "REMOTE_CAPABILITY_CONFLICT");
  assert.equal(result.committed, false);
  assert.equal(remoteWrites, 0);
});

test("remote finalizer rejects a stale marker before push with zero remote writes", async () => {
  const fixture = await setupGitFixture();
  let remoteWrites = 0;
  const localMutations: string[] = [];
  const capability = remoteCapability();

  const result: any = await finalizeSuccessfulQueueEntry({
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "remote",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") {
        return githubAuthorityResult(args, { capability, markerSha: "b".repeat(40) });
      }
      if (command === "git" && args[0] === "commit") localMutations.push(args[0]);
      if (command === "git" && args[0] === "add"
        && !(options?.env as NodeJS.ProcessEnv | undefined)?.GIT_INDEX_FILE) {
        localMutations.push(args[0]);
      }
      if (command === "git" && args[0] === "push") {
        remoteWrites += 1;
        return { stdout: "", stderr: "" };
      }
      return execFileAsync(command, args, options);
    },
    issueCloser: async () => {
      remoteWrites += 1;
      return { ok: true, state: "CLOSED" };
    },
  });

  assert.equal(result.code, "REMOTE_FINALIZE_FAILED");
  assert.equal(result.operation, "repository.push");
  assert.equal(result.committed, false);
  assert.equal(result.remoteWrites?.push?.attempted, false);
  assert.equal(remoteWrites, 0);
  assert.deepEqual(localMutations, []);
});

test("remote finalizer recovers committed push truth after a fulfilled non-zero transport result", async () => {
  const fixture = await setupGitFixture();
  const sourceHead = (await git(fixture.sourcePath, ["rev-parse", "HEAD"])).stdout.trim();
  const commit = (await git(fixture.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  let closeCalls = 0;
  let issueClosed = false;
  const capability = remoteCapability();

  const result: any = await finalizeSuccessfulQueueEntry({
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "remote",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") {
        return githubAuthorityResult(args, {
          capability,
          refSha: commit,
          issueState: issueClosed ? "CLOSED" : "OPEN",
        });
      }
      if (command === "git" && args[0] === "push") {
        return { stdout: "", stderr: "remote rejected after request", status: 1 };
      }
      return execFileAsync(command, args, options);
    },
    issueCloser: async () => {
      closeCalls += 1;
      issueClosed = true;
      return { ok: true, state: "CLOSED" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "finalized");
  assert.equal(result.pushed, true);
  assert.equal(result.closed, true);
  assert.equal(closeCalls, 1);
  assert.match(result.remoteWrites?.push?.verification?.evidence?.transportWarning?.message || "", /remote rejected/);
  assert.notEqual((await git(fixture.sourcePath, ["rev-parse", "HEAD"])).stdout.trim(), sourceHead);
});

test("remote finalizer reads back a committed issue close and redacts hostile throw or ok=false evidence", async () => {
  for (const variant of ["throw", "ok-false"] as const) {
    const fixture = await setupGitFixture();
    const capability = remoteCapability();
    const commit = (await git(fixture.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    const pushToken = `opaque-close-${variant}-token`;
    const apiKey = `sk-close-${variant}-secret-value`;
    const cookie = `session-close-${variant}-cookie`;
    let issueClosed = false;

    const result: any = await finalizeSuccessfulQueueEntry({
      entry: issueEntry({ metadata: { remoteCapability: capability } }),
      job: completedJob(fixture.worktreePath, {
        sourceContext: {
          type: "github_issue",
          repo: "owner/repo",
          issueNumber: 42,
          remoteCapability: capability,
        },
      }),
      sourcePath: fixture.sourcePath,
      mode: "remote",
      allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
      pushToken,
      runCommand: async (command, args, options) => {
        if (command === "gh") {
          return githubAuthorityResult(args, {
            capability,
            refSha: commit,
            issueState: issueClosed ? "CLOSED" : "OPEN",
          });
        }
        if (command === "git" && args[0] === "push") return { stdout: "", stderr: "" };
        return execFileAsync(command, args, options);
      },
      issueCloser: async () => {
        issueClosed = true;
        if (variant === "throw") {
          throw Object.assign(new Error(
            `close reply lost ${pushToken} api_key=${apiKey} cookie=${cookie}`,
          ), { code: "ECONNRESET" });
        }
        return {
          ok: false,
          code: "TRANSPORT_FAILED",
          stderr: `${pushToken} api_key=${apiKey} cookie=${cookie}`,
          headers: { cookie, authorization: `Bearer ${pushToken}` },
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.equal(result.closed, true);
    assert.equal(result.remoteWrites?.issueClose?.committed, true);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(pushToken));
    assert.doesNotMatch(serialized, new RegExp(apiKey));
    assert.doesNotMatch(serialized, new RegExp(cookie));
    assert.match(serialized, /\[REDACTED\]/);
  }
});

test("remote finalizer preserves pushed and closed truth when local ff-only synchronization fails", async () => {
  const fixture = await setupGitFixture();
  const capability = remoteCapability();
  const commit = (await git(fixture.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  const sourceHead = (await git(fixture.sourcePath, ["rev-parse", "HEAD"])).stdout.trim();
  let issueClosed = false;

  const result: any = await finalizeSuccessfulQueueEntry({
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "remote",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") {
        return githubAuthorityResult(args, {
          capability,
          refSha: commit,
          issueState: issueClosed ? "CLOSED" : "OPEN",
        });
      }
      if (command === "git" && args[0] === "push") return { stdout: "", stderr: "" };
      if (command === "git" && args[0] === "merge") {
        return { stdout: "", stderr: "local successor prevented ff-only merge", status: 1 };
      }
      return execFileAsync(command, args, options);
    },
    issueCloser: async () => {
      issueClosed = true;
      return { ok: true, state: "CLOSED" };
    },
  });

  assert.equal(result.code, "LOCAL_SOURCE_SYNC_FAILED");
  assert.equal(result.pushed, true);
  assert.equal(result.closed, true);
  assert.equal(result.localSynced, false);
  assert.equal(result.remoteWrites?.push?.committed, true);
  assert.equal(result.remoteWrites?.issueClose?.committed, true);
  assert.equal((await git(fixture.sourcePath, ["rev-parse", "HEAD"])).stdout.trim(), sourceHead);
});

test("remote finalizer revalidates before each write through one bound transport", async () => {
  const fixture = await setupGitFixture();
  const sourceHead = (await git(fixture.sourcePath, ["rev-parse", "HEAD"])).stdout.trim();
  const order: string[] = [];
  const capability = remoteCapability();
  const commit = (await git(fixture.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  let issueClosed = false;

  const result: any = await finalizeSuccessfulQueueEntry({
    entry: issueEntry({
      metadata: {
        remoteCapability: capability,
      },
    }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        issueTitle: "Fix issue with evidence",
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "remote",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") {
        return githubAuthorityResult(args, {
          capability,
          issueState: issueClosed ? "CLOSED" : "OPEN",
          refSha: commit,
        });
      }
      if (command === "git" && args[0] === "push") {
        order.push("push.write");
        return { stdout: "", stderr: "" };
      }
      return execFileAsync(command, args, options);
    },
    remoteAuthorityValidator: async (request) => {
      order.push(`${request.operation}.authorize`);
      return { principal: testTransportPrincipal() };
    },
    remoteCommitVerifier: async (request) => {
      order.push(`${request.operation}.verify`);
      return committedRemoteVerification(
        request as Record<string, any>,
        capability,
        request.operation === "repository.push" || issueClosed,
      );
    },
    issueCloser: async () => {
      order.push("issue.close.write");
      issueClosed = true;
      return { ok: true, state: "CLOSED" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "finalized");
  assert.equal(result.pushed, true);
  assert.equal(result.closed, true);
  assert.equal(result.remoteWrites?.issueClose?.verification?.committed, true);
  assert.deepEqual(order, [
    "repository.push.authorize",
    "push.write",
    "repository.push.verify",
    "issue.close.authorize",
    "issue.close.write",
    "issue.close.verify",
  ]);
  assert.notEqual((await git(fixture.sourcePath, ["rev-parse", "HEAD"])).stdout.trim(), sourceHead);
});

test("hostile injected authority hooks cannot mutate the trusted target or verifier request", async () => {
  const fixture = await setupGitFixture();
  const capability = remoteCapability();
  const commit = (await git(fixture.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  let issueClosed = false;
  let pushWrites = 0;
  const ghCommands: string[] = [];

  const mutateRequest = (request: any) => {
    request.repository = "attacker/foreign";
    request.issueNumber = 999;
    request.targetBranch = "attacker-branch";
    request.commit = "f".repeat(40);
    request.capability.repository = "attacker/foreign";
    request.capability.issueNumber = 999;
    request.capability.markerSha = "e".repeat(40);
    request.capability.permissions.repositoryPush = false;
  };

  const result: any = await finalizeSuccessfulQueueEntry({
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "remote",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") {
        ghCommands.push(args.join(" "));
        return githubAuthorityResult(args, {
          capability,
          refSha: commit,
          issueState: issueClosed ? "CLOSED" : "OPEN",
        });
      }
      if (command === "git" && args[0] === "push") {
        pushWrites += 1;
        assert.equal(args[1], "https://github.com/owner/repo.git");
        assert.equal(args[2], `${commit}:refs/heads/main`);
        return { stdout: "", stderr: "" };
      }
      return execFileAsync(command, args, options);
    },
    remoteAuthorityValidator: async (request) => {
      mutateRequest(request);
      return { principal: testTransportPrincipal() };
    },
    remoteCommitVerifier: async (request) => {
      const verification = committedRemoteVerification(request as Record<string, any>, capability, true);
      mutateRequest(request);
      return verification;
    },
    issueCloser: async () => {
      issueClosed = true;
      return { ok: true, state: "CLOSED" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(pushWrites, 1);
  assert.equal(ghCommands.some((command) => command.includes("attacker/foreign") || command.includes("999")), false);
});

test("remote finalizer detects a replaced marker before issue close and performs zero close writes", async () => {
  const fixture = await setupGitFixture();
  const capability = remoteCapability();
  const commit = (await git(fixture.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  let markerChecks = 0;
  let pushWrites = 0;
  let closeWrites = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "remote",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") {
        if (args[0] === "api" && String(args[1]).includes("/contents/")) markerChecks += 1;
        return githubAuthorityResult(args, {
          capability,
          markerSha: markerChecks >= 2 ? "b".repeat(40) : capability.markerSha,
          refSha: commit,
        });
      }
      if (command === "git" && args[0] === "push") {
        pushWrites += 1;
        return { stdout: "", stderr: "" };
      }
      return execFileAsync(command, args, options);
    },
    issueCloser: async () => {
      closeWrites += 1;
      return { ok: true, state: "CLOSED" };
    },
  });

  assert.equal(result.code, "REMOTE_FINALIZE_FAILED");
  assert.equal(result.operation, "issue.close");
  assert.equal(result.pushed, true);
  assert.equal(result.closed, false);
  assert.equal(result.committed, false);
  assert.equal(pushWrites, 1);
  assert.equal(closeWrites, 0);
  assert.equal(result.remoteWrites?.issueClose?.attempted, false);
});

test("remote finalizer rejects a replaced git target after authority validation with zero remote writes", async () => {
  const fixture = await setupGitFixture();
  const capability = remoteCapability();
  await git(fixture.worktreePath, ["remote", "set-url", "origin", "https://github.com/attacker/repo.git"]);
  let remoteWrites = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "remote",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") return githubAuthorityResult(args, { capability });
      if (command === "git" && args[0] === "push") {
        remoteWrites += 1;
        return { stdout: "", stderr: "" };
      }
      return execFileAsync(command, args, options);
    },
    issueCloser: async () => {
      remoteWrites += 1;
      return { ok: true, state: "CLOSED" };
    },
  });

  assert.equal(result.code, "REMOTE_FINALIZE_FAILED");
  assert.equal(result.operation, "repository.push");
  assert.equal(result.committed, false);
  assert.equal(remoteWrites, 0);
});

test("remote finalizer rejects an ambiguous multi-push remote with zero remote writes", async () => {
  const fixture = await setupGitFixture();
  const capability = remoteCapability();
  await git(fixture.worktreePath, ["remote", "set-url", "--push", "origin", "https://github.com/owner/repo.git"]);
  await git(fixture.worktreePath, ["remote", "set-url", "--add", "--push", "origin", "https://github.com/attacker/repo.git"]);
  let remoteWrites = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "remote",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") return githubAuthorityResult(args, { capability });
      if (command === "git" && args[0] === "push") {
        remoteWrites += 1;
        return { stdout: "", stderr: "" };
      }
      return execFileAsync(command, args, options);
    },
    issueCloser: async () => {
      remoteWrites += 1;
      return { ok: true, state: "CLOSED" };
    },
  });

  assert.equal(result.code, "REMOTE_FINALIZE_FAILED");
  assert.equal(result.operation, "repository.push");
  assert.equal(result.committed, false);
  assert.equal(remoteWrites, 0);
});

test("remote finalizer blocks source-local insteadOf rewrites before exposing a token or pushing", async () => {
  const fixture = await setupGitFixture();
  const capability = remoteCapability();
  await git(fixture.worktreePath, [
    "config",
    "url.ssh://attacker.invalid/.insteadOf",
    "https://github.com/",
  ]);
  const token = "github_pat_must_not_reach_rewritten_transport";
  let remoteWrites = 0;
  let tokenObserved = false;

  const result: any = await finalizeSuccessfulQueueEntry({
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "remote",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    pushToken: token,
    runCommand: async (command, args, options) => {
      if (command === "gh") return githubAuthorityResult(args, { capability });
      if (JSON.stringify(options?.env || {}).includes(token)) tokenObserved = true;
      if (command === "git" && args[0] === "push") remoteWrites += 1;
      return execFileAsync(command, args, options);
    },
    issueCloser: async () => {
      remoteWrites += 1;
      return { ok: true, state: "CLOSED" };
    },
  });

  assert.equal(result.code, "REMOTE_FINALIZE_FAILED");
  assert.equal(result.operation, "repository.push");
  assert.equal(result.committed, false);
  assert.equal(remoteWrites, 0);
  assert.equal(tokenObserved, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});

test("live PR finalizer rejects a stale marker before branch push or PR creation", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture });
  const capability = remoteCapability();
  let pushWrites = 0;
  let createWrites = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        issueTitle: "Fix issue with evidence",
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "pr",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") {
        return githubAuthorityResult(args, { capability, markerSha: "b".repeat(40) });
      }
      if (command === "git" && args[0] === "push") pushWrites += 1;
      return execFileAsync(command, args, options);
    },
    createPullRequest: async () => {
      createWrites += 1;
      return { url: "https://github.com/owner/repo/pull/7", number: 7 };
    },
  });

  assert.equal(result.code, "PR_FINALIZE_FAILED");
  assert.equal(result.pr?.status, "blocked.pr");
  assert.equal(result.pr?.evidence?.committed, false);
  assert.equal(pushWrites, 0);
  assert.equal(createWrites, 0);
});

test("live PR finalizer revalidates after branch push and blocks PR creation when the marker is replaced", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture });
  const capability = remoteCapability();
  const commit = (await git(fixture.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  let markerChecks = 0;
  let pushWrites = 0;
  let createWrites = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        issueTitle: "Fix issue with evidence",
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "pr",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") {
        if (args[0] === "api" && String(args[1]).includes("/contents/")) markerChecks += 1;
        return githubAuthorityResult(args, {
          capability,
          markerSha: markerChecks >= 2 ? "b".repeat(40) : capability.markerSha,
          refSha: commit,
        });
      }
      if (command === "git" && args[0] === "push") {
        pushWrites += 1;
        return { stdout: "", stderr: "" };
      }
      return execFileAsync(command, args, options);
    },
    createPullRequest: async () => {
      createWrites += 1;
      return { url: "https://github.com/owner/repo/pull/7", number: 7 };
    },
  });

  assert.equal(result.code, "PR_FINALIZE_FAILED");
  assert.equal(result.pr?.status, "blocked.pr");
  assert.equal(result.pr?.evidence?.committed, false);
  assert.equal(pushWrites, 1);
  assert.equal(createWrites, 0);
});

test("live PR finalizer recovers the exact created draft after the transport throws", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture });
  const capability = remoteCapability();
  const commit = (await git(fixture.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  let createdRequest: Record<string, unknown> | null = null;
  let pushWrites = 0;

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        issueTitle: "Fix issue with evidence",
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "pr",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command, args, options) => {
      if (command === "gh") {
        return githubAuthorityResult(args, {
          capability,
          refSha: commit,
          pullRequestNumber: 77,
          pullRequestTitle: "[cpb] Fix issue with evidence",
          pullRequestBody: String(createdRequest?.body || ""),
        });
      }
      if (command === "git" && args[0] === "push") {
        pushWrites += 1;
        return { stdout: "", stderr: "" };
      }
      return execFileAsync(command, args, options);
    },
    createPullRequest: async (request) => {
      createdRequest = request as Record<string, unknown>;
      throw new Error("connection reset after GitHub committed the draft");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "pr.opened");
  assert.equal(result.prNumber, 77);
  assert.equal(result.pr?.response?.recoveredByExactGenerationDiscovery, true);
  assert.equal(result.pr?.remoteWrites?.pullRequestCreate?.committed, true);
  assert.equal(pushWrites, 1);
  const events = await readEvents(fixture.cpbRoot, "proj", "job-finalizer", { dataRoot: fixture.dataRoot });
  assert.equal(events.some((event) => event.type === "pr_opened" && event.prNumber === 77), true);
});

test("live PR finalizer preserves remote truth when pr_opened event and audit persistence fail", async () => {
  for (const auditAlsoFails of [false, true]) {
    const fixture = await setupGitFixture();
    await seedJobEvents({ ...fixture });
    const capability = remoteCapability();
    const commit = (await git(fixture.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    const pushToken = `opaque-event-${auditAlsoFails ? "audit" : "single"}-token`;
    let createdRequest: Record<string, unknown> | null = null;
    let pushWrites = 0;
    let createWrites = 0;
    let appendOpens = 0;

    const result: any = await withEventLockTestHooksForTests({
      afterAppendOpen({ filePath }) {
        if (path.basename(filePath) !== "job-finalizer.jsonl") return;
        appendOpens += 1;
        if (appendOpens === 1 || auditAlsoFails) {
          throw new Error(`event persistence failed ${pushToken}`);
        }
      },
    }, () => finalizeSuccessfulQueueEntry({
      cpbRoot: fixture.cpbRoot,
      hubRoot: fixture.hubRoot,
      dataRoot: fixture.dataRoot,
      project: "proj",
      entry: issueEntry({ metadata: { remoteCapability: capability } }),
      job: completedJob(fixture.worktreePath, {
        sourceContext: {
          type: "github_issue",
          repo: "owner/repo",
          issueNumber: 42,
          issueTitle: "Fix issue with evidence",
          remoteCapability: capability,
        },
      }),
      sourcePath: fixture.sourcePath,
      mode: "pr",
      allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
      pushToken,
      runCommand: async (command, args, options) => {
        if (command === "gh") {
          return githubAuthorityResult(args, {
            capability,
            refSha: commit,
            pullRequestNumber: 88,
            pullRequestTitle: "[cpb] Fix issue with evidence",
            pullRequestBody: String(createdRequest?.body || ""),
          });
        }
        if (command === "git" && args[0] === "push") {
          pushWrites += 1;
          return { stdout: "", stderr: "" };
        }
        return execFileAsync(command, args, options);
      },
      createPullRequest: async (request) => {
        createWrites += 1;
        createdRequest = request as Record<string, unknown>;
        return { url: "https://github.com/owner/repo/pull/88", number: 88 };
      },
    }));

    assert.equal(pushWrites, 1);
    assert.equal(createWrites, 1);
    assert.equal(result.pushed, true);
    assert.equal(result.committed, true);
    assert.equal(result.eventRecorded, false);
    assert.equal(result.remoteWrites?.branchPush?.committed, true);
    assert.equal(result.remoteWrites?.pullRequestCreate?.committed, true);
    assert.equal(result.prUrl, "https://github.com/owner/repo/pull/88");
    assert.equal(result.prNumber, 88);
    if (auditAlsoFails) {
      assert.equal(result.code, "FINALIZER_AUDIT_RECORD_FAILED");
      assert.equal(result.auditRecordFailed, true);
      assert.equal(result.finalizerResult?.code, "PR_EVENT_RECORD_FAILED");
    } else {
      assert.equal(result.code, "PR_EVENT_RECORD_FAILED");
    }
    assert.doesNotMatch(JSON.stringify(result), new RegExp(pushToken));
    assert.match(JSON.stringify(result), /\[REDACTED\]/);
  }
});

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
    runCommand: async (command: string, args: string[], opts: Record<string, unknown>) => {
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
  assert.equal(gitCalls.some((call) => call[0] === "git" && ["commit", "push", "update-ref"].includes(call[1])), false);
});

test("finalizeSuccessfulQueueEntry records dry-run PR finalizer result for audit projections", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture });

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

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry-run");

  const events = await readEvents(fixture.cpbRoot, "proj", "job-finalizer", { dataRoot: fixture.dataRoot });
  const finalizerEvents = events.filter((event) => event.type === "finalizer_result");
  const finalizerResult = recordValue(finalizerEvents[0].result);
  const finalizerPr = recordValue(finalizerResult.pr);

  assert.equal(finalizerEvents.length, 1);
  assert.equal(finalizerResult.ok, true);
  assert.equal(finalizerResult.status, "dry-run");
  assert.equal(finalizerResult.mode, "dry-run");
  assert.equal(finalizerPr.status, "dry-run");

  const projected = await getJob(fixture.cpbRoot, "proj", "job-finalizer", { dataRoot: fixture.dataRoot });
  assert.equal(projected?.finalizer?.ok, true);
  assert.equal(projected?.finalizer?.status, "dry-run");
  assert.equal(projected?.finalizer?.mode, "dry-run");
});

test("finalizeSuccessfulQueueEntry blocks dry-run PR when finalizer audit recording fails", async () => {
  const fixture = await setupGitFixture();
  await seedJobEvents({ ...fixture });

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry(),
    job: completedJob(fixture.worktreePath),
    sourcePath: fixture.sourcePath,
    mode: "dry-run",
    recordFinalizerResult: async () => {
      throw new Error("event store unavailable");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "FINALIZER_AUDIT_RECORD_FAILED");
  assert.match(result.error || "", /event store unavailable/);
  assert.equal(result.finalizerResult?.ok, true);
  assert.equal(result.finalizerResult?.status, "dry-run");
  assert.equal(result.finalizerResult?.mode, "dry-run");
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
    runCommand: async (command: string, args: string[], opts: Record<string, unknown>) => {
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
    gitCalls.some((call) => call[0] === "git" && ["commit", "push", "update-ref", "merge", "stash"].includes(call[1])),
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
    runCommand: async (command: string, args: string[], opts: Record<string, unknown>) => {
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
  const capability = remoteCapability();

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "pr",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command: string, args: string[], opts: Record<string, unknown>) => {
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
  const capability = remoteCapability();

  const result: any = await finalizeSuccessfulQueueEntry({
    cpbRoot: fixture.cpbRoot,
    hubRoot: fixture.hubRoot,
    dataRoot: fixture.dataRoot,
    project: "proj",
    entry: issueEntry({ metadata: { remoteCapability: capability } }),
    job: completedJob(fixture.worktreePath, {
      sourceContext: {
        type: "github_issue",
        repo: "owner/repo",
        issueNumber: 42,
        remoteCapability: capability,
      },
    }),
    sourcePath: fixture.sourcePath,
    mode: "pr",
    allowLiveFinalize: true,
      ...liveFinalizerAuthority(fixture),
    runCommand: async (command: string, args: string[], opts: Record<string, unknown>) => {
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
