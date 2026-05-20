import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { enqueue, updateEntry } from "../server/services/hub-queue.js";
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

    const ledger = await buildTaskLedger({ cpbRoot, hubRoot });

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

    const ledger = await buildTaskLedger({ cpbRoot, hubRoot });

    assert.equal(ledger.summary.archived, 1);
    assert.equal(ledger.tasks[0].status, "archived");
    assert.equal(ledger.tasks[0].human.nextAction, "Do not retry this item directly; follow the replacement task links.");
    assert.equal(ledger.tasks[0].agent.status.finalDisposition, "superseded_by_split_issues");
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
  }
});
