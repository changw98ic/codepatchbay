import assert from "node:assert/strict";
import { test } from "node:test";

import { autoEnqueueSyncedIssues, matchAutomationRule, isExcluded, issueToNormalizedEvent } from "../server/services/hub/hub-queue.js";
import { writeGithubIssues } from "../server/services/github/github-issues.js";
import { registerProject, bindProjectGithub, updateProject } from "../server/services/hub/hub-registry.js";
import { enqueue } from "../server/services/hub/hub-queue.js";
import { tempRoot } from "./helpers.js";

const FIXTURE_ISSUES = [
  {
    number: 10,
    title: "Fix auth timeout",
    body: "Auth requests time out after 5s",
    state: "OPEN",
    url: "https://github.com/acme/app/issues/10",
    labels: ["bug", "cpb-auto"],
  },
  {
    number: 11,
    title: "Update docs",
    body: "Documentation needs updating",
    state: "OPEN",
    url: "https://github.com/acme/app/issues/11",
    labels: ["docs"],
  },
  {
    number: 12,
    title: "Critical perf issue",
    body: "Page load takes 30s",
    state: "OPEN",
    url: "https://github.com/acme/app/issues/12",
    labels: ["cpb-auto", "p0"],
  },
  {
    number: 13,
    title: "Closed task",
    body: "Already done",
    state: "CLOSED",
    url: "https://github.com/acme/app/issues/13",
    labels: ["cpb-auto"],
  },
];

test("matchAutomationRule matches by label", () => {
  const rules = [{ match: { labels: ["cpb-auto"] }, action: { workflow: "standard" } }];
  const issue = { labels: ["bug", "cpb-auto"], title: "Fix thing" };
  const matched = matchAutomationRule(issue, rules);
  assert.ok(matched);
});

test("matchAutomationRule returns null when labels mismatch", () => {
  const rules = [{ match: { labels: ["cpb-auto"] }, action: { workflow: "standard" } }];
  const issue = { labels: ["bug"], title: "Fix thing" };
  assert.equal(matchAutomationRule(issue, rules), null);
});

test("matchAutomationRule matches by title pattern", () => {
  const rules = [{ match: { titlePattern: "^Fix" }, action: { workflow: "standard" } }];
  const issue = { labels: [], title: "Fix the login flow" };
  assert.ok(matchAutomationRule(issue, rules));
});

test("isExcluded returns true for excluded labels", () => {
  assert.ok(isExcluded({ labels: ["wontfix"] }, { labels: ["wontfix"] }));
});

test("isExcluded returns false when no exclusion matches", () => {
  assert.ok(!isExcluded({ labels: ["bug"] }, { labels: ["wontfix"] }));
});

test("issueToNormalizedEvent preserves issue data", () => {
  const issue = {
    number: 42,
    title: "Fix crash",
    body: "App crashes on start",
    url: "https://github.com/acme/app/issues/42",
    labels: ["bug"],
  };
  const project = { id: "my-project", github: { fullName: "acme/app" } };
  const event = issueToNormalizedEvent(issue, project);
  assert.equal(event.status, "ok");
  assert.equal(event.issueNumber, 42);
  assert.equal(event.repo, "acme/app");
  assert.equal(event.projectId, "my-project");
  assert.equal(event.title, "Fix crash");
  assert.equal(event.body, "App crashes on start");
  assert.equal(event.url, "https://github.com/acme/app/issues/42");
  assert.deepEqual(event.labels, ["bug"]);
});

async function setupProjectWithAutomation(hubRoot, cpbRoot, projectId, automationConfig) {
  await registerProject(hubRoot, { id: projectId, sourcePath: cpbRoot, skipCodeGraphGate: true });
  await bindProjectGithub(hubRoot, projectId, "acme/app");
  await updateProject(hubRoot, projectId, {
    github: {
      fullName: "acme/app",
      automation: automationConfig,
    },
  });
}

test("autoEnqueueSyncedIssues enqueues matching open issues", async (t) => {
  const hubRoot = await tempRoot("cpb-proactive-hub");
  const cpbRoot = await tempRoot("cpb-proactive-cpb");

  await setupProjectWithAutomation(hubRoot, cpbRoot, "test-proj", {
    enabled: true,
    rules: [
      { match: { labels: ["cpb-auto"] }, action: { workflow: "standard" } },
    ],
  });

  await writeGithubIssues(hubRoot, {
    repo: "acme/app",
    projectId: "test-proj",
    issues: FIXTURE_ISSUES,
  });

  const result = await autoEnqueueSyncedIssues(hubRoot, cpbRoot, "test-proj", {
    createJobFn: async (_cpbRoot, event, match, opts) => {
      return { status: "created", event, match };
    },
  });

  // Issues #10 and #12 have cpb-auto and are OPEN; #11 has no cpb-auto; #13 is CLOSED
  assert.equal(result.enqueued, 2, "should enqueue 2 matching open issues");
  assert.ok(result.total >= 3);
});

test("autoEnqueueSyncedIssues exact selection never scans a second matching issue into the queue", async () => {
  const hubRoot = await tempRoot("cpb-proactive-exact-hub");
  const cpbRoot = await tempRoot("cpb-proactive-exact-cpb");

  await setupProjectWithAutomation(hubRoot, cpbRoot, "exact-proj", {
    enabled: true,
    rules: [
      { match: { labels: ["cpb-auto"] }, action: { workflow: "standard" } },
    ],
  });
  await writeGithubIssues(hubRoot, {
    repo: "acme/app",
    projectId: "exact-proj",
    issues: FIXTURE_ISSUES,
  });

  const selected: number[] = [];
  const remoteCapability = {
    schema: "cpb.github-remote-capability.v1",
    repository: "acme/app",
    repositoryId: "R_acme",
    defaultBranch: "main",
    markerPath: ".cpb-disposable-target.json",
    markerSha: "a".repeat(40),
    issueNumber: 10,
    automationLabel: "cpb-auto",
    allowedBranchPrefix: "cpb-release-rehearsal/",
    permissions: {
      repositoryPush: true,
      pullRequestCreate: true,
      pullRequestMerge: true,
      issueClose: true,
    },
  };
  let observedCapability: unknown = null;
  const result = await autoEnqueueSyncedIssues(hubRoot, cpbRoot, "exact-proj", {
    exactIssueNumber: 10,
    remoteCapability,
    createJobFn: async (_cpbRoot, event) => {
      selected.push(Number((event as { issueNumber?: number }).issueNumber));
      observedCapability = (event as { remoteCapability?: unknown }).remoteCapability;
      return { status: "created" };
    },
  });

  assert.deepEqual(selected, [10]);
  assert.equal(result.enqueued, 1);
  assert.equal(result.total, 1);
  assert.equal(result.scannedTotal, 3);
  assert.equal(result.exactIssueNumber, 10);
  assert.deepEqual(observedCapability, remoteCapability);
});

test("autoEnqueueSyncedIssues exact selection fails closed when the issue is absent", async () => {
  const hubRoot = await tempRoot("cpb-proactive-exact-missing-hub");
  const cpbRoot = await tempRoot("cpb-proactive-exact-missing-cpb");

  await setupProjectWithAutomation(hubRoot, cpbRoot, "exact-missing", {
    enabled: true,
    rules: [
      { match: { labels: ["cpb-auto"] }, action: { workflow: "standard" } },
    ],
  });
  await writeGithubIssues(hubRoot, {
    repo: "acme/app",
    projectId: "exact-missing",
    issues: FIXTURE_ISSUES,
  });

  let createCalls = 0;
  const result = await autoEnqueueSyncedIssues(hubRoot, cpbRoot, "exact-missing", {
    exactIssueNumber: 999,
    createJobFn: async () => {
      createCalls += 1;
    },
  });
  assert.match(String(result.error), /Exact issue #999/);
  assert.equal(result.enqueued, 0);
  assert.equal(createCalls, 0);
});

test("autoEnqueueSyncedIssues exact selection does not disguise queue creation failure as a skip", async () => {
  const hubRoot = await tempRoot("cpb-proactive-exact-failure-hub");
  const cpbRoot = await tempRoot("cpb-proactive-exact-failure-cpb");

  await setupProjectWithAutomation(hubRoot, cpbRoot, "exact-failure", {
    enabled: true,
    rules: [
      { match: { labels: ["cpb-auto"] }, action: { workflow: "standard" } },
    ],
  });
  await writeGithubIssues(hubRoot, {
    repo: "acme/app",
    projectId: "exact-failure",
    issues: FIXTURE_ISSUES,
  });

  const primary = new Error("queue publication failed");
  await assert.rejects(
    autoEnqueueSyncedIssues(hubRoot, cpbRoot, "exact-failure", {
      exactIssueNumber: 10,
      createJobFn: async () => {
        throw primary;
      },
    }),
    (error) => error === primary,
  );
});

test("autoEnqueueSyncedIssues skips when automation disabled", async (t) => {
  const hubRoot = await tempRoot("cpb-proactive-no-auto");
  const cpbRoot = await tempRoot("cpb-proactive-no-auto-cpb");

  await registerProject(hubRoot, { id: "no-auto", sourcePath: cpbRoot, skipCodeGraphGate: true });
  await bindProjectGithub(hubRoot, "no-auto", "acme/app");

  await writeGithubIssues(hubRoot, {
    repo: "acme/app",
    projectId: "no-auto",
    issues: FIXTURE_ISSUES,
  });

  const result = await autoEnqueueSyncedIssues(hubRoot, cpbRoot, "no-auto");
  assert.equal(result.enqueued, 0);
  assert.equal(result.reason, "automation not enabled");
});

test("autoEnqueueSyncedIssues dry-run reports matched without enqueuing", async (t) => {
  const hubRoot = await tempRoot("cpb-proactive-dry");
  const cpbRoot = await tempRoot("cpb-proactive-dry-cpb");

  await setupProjectWithAutomation(hubRoot, cpbRoot, "dry-proj", {
    enabled: true,
    rules: [
      { match: { labels: ["cpb-auto"] }, action: { workflow: "standard" } },
    ],
  });

  await writeGithubIssues(hubRoot, {
    repo: "acme/app",
    projectId: "dry-proj",
    issues: FIXTURE_ISSUES,
  });

  const result = await autoEnqueueSyncedIssues(hubRoot, cpbRoot, "dry-proj", { dryRun: true });
  assert.equal(result.enqueued, 2);
  assert.ok(result.matched);
  assert.equal(result.matched.length, 2);
});

test("autoEnqueueSyncedIssues skips excluded issues", async (t) => {
  const hubRoot = await tempRoot("cpb-proactive-exc");
  const cpbRoot = await tempRoot("cpb-proactive-exc-cpb");

  const issuesWithExcluded = [
    ...FIXTURE_ISSUES,
    {
      number: 14,
      title: "Wontfix task",
      body: "Excluded",
      state: "OPEN",
      url: "https://github.com/acme/app/issues/14",
      labels: ["cpb-auto", "wontfix"],
    },
  ];

  await setupProjectWithAutomation(hubRoot, cpbRoot, "exc-proj", {
    enabled: true,
    exclude: { labels: ["wontfix"] },
    rules: [
      { match: { labels: ["cpb-auto"] }, action: { workflow: "standard" } },
    ],
  });

  await writeGithubIssues(hubRoot, {
    repo: "acme/app",
    projectId: "exc-proj",
    issues: issuesWithExcluded,
  });

  const result = await autoEnqueueSyncedIssues(hubRoot, cpbRoot, "exc-proj", {
    createJobFn: async () => ({ status: "created" }),
  });

  assert.equal(result.enqueued, 2, "should only enqueue non-excluded issues");
});
