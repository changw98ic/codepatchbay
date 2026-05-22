import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { enqueue, updateEntry } from "../server/services/hub-queue.js";
import { readGithubIssues, syncGithubIssuesFromGh } from "../server/services/github-issues.js";
import { buildTaskLedger } from "../server/services/task-ledger.js";

async function writeIssueCache(hubRoot, issues) {
  const dir = path.join(hubRoot, "github");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "issues.json"), `${JSON.stringify({ issues }, null, 2)}\n`, "utf8");
}

test("buildTaskLedger merges GitHub issue source with queued execution state", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-ledger-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-ledger-hub-"));

  try {
    await writeIssueCache(hubRoot, [
      {
        repository: "changw98ic/codepatchbay",
        number: 20,
        title: "P0.8a: Add CPB version and runtime identity report",
        state: "OPEN",
        url: "https://github.com/changw98ic/codepatchbay/issues/20",
        labels: ["enhancement", "cpb-queued"],
        body: "## Goal\n\nExpose a machine-readable CPB identity report.\n\n## Acceptance\n\n- Prints version.",
        createdAt: "2026-05-20T06:00:00.000Z",
        updatedAt: "2026-05-20T06:40:00.000Z",
      },
      {
        repository: "changw98ic/codepatchbay",
        number: 15,
        title: "Add context budget reporting for composed prompt layers",
        state: "OPEN",
        url: "https://github.com/changw98ic/codepatchbay/issues/15",
        labels: ["enhancement", "cpb-queued"],
        body: "## Goal\n\nShow prompt context budgets.",
        createdAt: "2026-05-20T05:00:00.000Z",
        updatedAt: "2026-05-20T05:30:00.000Z",
      },
    ]);

    const queued = await enqueue(hubRoot, {
      projectId: "flow",
      sourcePath: "/repo/flow",
      priority: "P1",
      description: "P0.8a: Add CPB version and runtime identity report",
      executionBoundary: "worktree",
      metadata: {
        repo: "changw98ic/codepatchbay",
        source: "github_issue",
        issueNumber: 20,
        issueUrl: "https://github.com/changw98ic/codepatchbay/issues/20",
        issueTitle: "P0.8a: Add CPB version and runtime identity report",
      },
    });

    const ledger = await buildTaskLedger({ cpbRoot, hubRoot, includeQueueOnly: true, includeArchived: true });

    assert.equal(ledger.summary.total, 2);
    assert.equal(ledger.summary.ready, 1);
    assert.equal(ledger.summary.open, 1);
    assert.equal(ledger.summary.bySource.github, 2);

    const ready = ledger.tasks.find((task) => task.id === "github:changw98ic/codepatchbay#20");
    assert.equal(ready.status, "ready");
    assert.equal(ready.progress.label, "Ready to run");
    assert.equal(ready.agent.execution.queueEntryId, queued.id);
    assert.equal(ready.human.source, "GitHub issue #20");
    assert.match(ready.human.summary, /Expose a machine-readable/);
    assert.match(ready.agent.objective, /## Goal/);

    const sourceOnly = ledger.tasks.find((task) => task.id === "github:changw98ic/codepatchbay#15");
    assert.equal(sourceOnly.status, "open");
    assert.equal(sourceOnly.progress.label, "Open, not queued");
    assert.equal(sourceOnly.agent.execution.queueEntryId, null);
    assert.match(sourceOnly.human.nextAction, /Import or queue/);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
  }
});

test("buildTaskLedger marks superseded queue entries as archived", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-ledger-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-ledger-hub-"));

  try {
    const old = await enqueue(hubRoot, {
      projectId: "flow",
      sourcePath: "/repo/flow",
      description: "Old P0.8 task",
    });
    await updateEntry(hubRoot, old.id, {
      status: "completed",
      metadata: {
        finalDisposition: "superseded_by_split_issues",
        supersededByIssues: ["https://github.com/changw98ic/codepatchbay/issues/20"],
      },
    });

    const ledger = await buildTaskLedger({ cpbRoot, hubRoot, includeQueueOnly: true, includeArchived: true });

    assert.equal(ledger.summary.archived, 1);
    assert.equal(ledger.tasks[0].status, "archived");
    assert.equal(ledger.tasks[0].human.nextAction, "Do not retry this item directly; follow the replacement task links.");
    assert.equal(ledger.tasks[0].agent.status.finalDisposition, "superseded_by_split_issues");
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
  }
});

test("buildTaskLedger deduplicates retries for the same GitHub issue", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-ledger-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-ledger-hub-"));

  try {
    await writeIssueCache(hubRoot, [
      {
        repository: "changw98ic/codepatchbay",
        number: 29,
        title: "Fix retry accounting",
        state: "OPEN",
        url: "https://github.com/changw98ic/codepatchbay/issues/29",
        labels: ["P1"],
        body: "## Goal\n\nKeep one task row per GitHub issue.",
      },
    ]);

    const first = await enqueue(hubRoot, {
      projectId: "flow",
      description: "Fix retry accounting",
      metadata: {
        repo: "changw98ic/codepatchbay",
        issueNumber: 29,
      },
    });
    await updateEntry(hubRoot, first.id, { status: "failed" });

    const retry = await enqueue(hubRoot, {
      projectId: "flow",
      description: "Fix retry accounting",
      metadata: {
        repo: "changw98ic/codepatchbay",
        issueNumber: 29,
      },
    });
    await updateEntry(hubRoot, retry.id, {
      status: "in_progress",
      claimedBy: "worker-1",
      workerId: "worker-1",
    });

    const ledger = await buildTaskLedger({ cpbRoot, hubRoot });

    assert.equal(ledger.summary.total, 1);
    assert.equal(ledger.summary.running, 1);
    assert.equal(ledger.tasks.length, 1);
    assert.equal(ledger.tasks[0].id, "github:changw98ic/codepatchbay#29");
    assert.equal(ledger.tasks[0].status, "running");
    assert.equal(ledger.tasks[0].agent.execution.queueEntryId, retry.id);
    assert.equal(ledger.tasks[0].agent.evidence.filter((item) => item.kind === "queue").length, 2);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
  }
});

test("buildTaskLedger defaults to the active GitHub issue list", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-ledger-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-ledger-hub-"));

  try {
    await writeIssueCache(hubRoot, [
      {
        repository: "changw98ic/codepatchbay",
        number: 31,
        title: "Open issue",
        state: "OPEN",
      },
      {
        repository: "changw98ic/codepatchbay",
        number: 32,
        title: "Closed issue",
        state: "CLOSED",
      },
    ]);

    const closedIssueHistory = await enqueue(hubRoot, {
      projectId: "flow",
      description: "Closed issue",
      metadata: { repo: "changw98ic/codepatchbay", issueNumber: 32 },
    });
    await updateEntry(hubRoot, closedIssueHistory.id, { status: "completed" });

    const queueOnlyHistory = await enqueue(hubRoot, {
      projectId: "flow",
      description: "Historical queue item",
    });
    await updateEntry(hubRoot, queueOnlyHistory.id, { status: "failed" });

    await enqueue(hubRoot, {
      projectId: "flow",
      description: "Pending queue-only task",
    });

    const archived = await enqueue(hubRoot, {
      projectId: "flow",
      description: "Superseded task",
    });
    await updateEntry(hubRoot, archived.id, {
      status: "completed",
      metadata: { finalDisposition: "superseded_by_split_issues" },
    });

    const ledger = await buildTaskLedger({ cpbRoot, hubRoot });

    assert.equal(ledger.summary.total, 1);
    assert.equal(ledger.summary.open, 1);
    assert.ok(ledger.tasks.find((task) => task.id === "github:changw98ic/codepatchbay#31"));
    assert.equal(ledger.tasks.find((task) => task.title === "Closed issue"), undefined);
    assert.equal(ledger.tasks.find((task) => task.title === "Historical queue item"), undefined);
    assert.equal(ledger.tasks.find((task) => task.title === "Pending queue-only task"), undefined);
    assert.equal(ledger.tasks.find((task) => task.agent.status.finalDisposition === "superseded_by_split_issues"), undefined);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
  }
});

test("syncGithubIssuesFromGh refreshes the local GitHub issue cache", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-ledger-hub-"));
  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push([cmd, args]);
    if (args[0] === "repo") return { stdout: "changw98ic/codepatchbay\n" };
    return {
      stdout: JSON.stringify([
        {
          number: 75,
          title: "Fail CPB execution when plan artifact is empty",
          state: "OPEN",
          url: "https://github.com/changw98ic/codepatchbay/issues/75",
          labels: [{ name: "P1" }],
          body: "## Goal\n\nFail empty plans.",
          createdAt: "2026-05-22T00:00:00Z",
          updatedAt: "2026-05-22T01:00:00Z",
        },
      ]),
    };
  };

  try {
    const result = await syncGithubIssuesFromGh(hubRoot, {
      projectId: "flow",
      state: "open",
      execFile,
    });
    const issues = await readGithubIssues(hubRoot);

    assert.equal(result.repo, "changw98ic/codepatchbay");
    assert.equal(result.count, 1);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].number, 75);
    assert.deepEqual(issues[0].labels, ["P1"]);
    assert.ok(calls.some(([, args]) => args.includes("--state") && args.includes("open")));
  } finally {
    await rm(hubRoot, { recursive: true, force: true });
  }
});
