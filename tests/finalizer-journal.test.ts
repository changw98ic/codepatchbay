import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendEvent,
  eventStreamCursorForRecords,
  readEvents,
  withEventLockTestHooksForTests,
} from "../server/services/event/event-store.js";
import {
  appendFinalizerJournal,
  finalizerJournalClaimId,
  finalizerJournalDigest,
  finalizerJournalFinalizationId,
  finalizerJournalJobId,
  finalizerJournalPrEventId,
  readFinalizerJournal,
  type FinalizerJournalRecord,
} from "../server/services/finalizer-journal.js";

function initialRecord(): FinalizerJournalRecord {
  const record: FinalizerJournalRecord = {
    schema: "cpb.finalizer-mutation-receipt.v1",
    finalizationId: "0".repeat(64),
    generation: 1,
    project: "flow",
    entryId: "entry-stable",
    originJobId: "job-origin",
    mode: "remote",
    stage: "claimed",
    repository: "example/disposable",
    issueNumber: 17,
    capabilityDigest: "2".repeat(64),
    principal: { kind: "github_app", stableId: "41", login: "cpb-test[bot]", authorId: "91" },
    claim: {
      claimId: "1".repeat(64),
      claimGeneration: 1,
      ownerDigest: "3".repeat(64),
    },
    source: { branch: "main", head: "4".repeat(40) },
    capsule: { path: "/durable/finalizer.bundle", sha256: "5".repeat(64), bytes: 128 },
    commit: "6".repeat(40),
    tree: "7".repeat(40),
    preRemoteHead: "4".repeat(40),
    targetBranch: "main",
    receipts: {},
  };
  record.finalizationId = finalizerJournalFinalizationId(record);
  record.claim.claimId = finalizerJournalClaimId({
    finalizationId: record.finalizationId,
    ownerDigest: String(record.claim.ownerDigest),
    claimGeneration: Number(record.claim.claimGeneration),
  });
  return record;
}

function prInitialRecord(): FinalizerJournalRecord {
  const record: FinalizerJournalRecord = {
    ...initialRecord(),
    finalizationId: "0".repeat(64),
    mode: "pr",
    preRemoteHead: null,
    targetBranch: "cpb/job-origin",
    receipts: {
      prPlan: {
        repo: "example/disposable",
        head: "cpb/job-origin",
        base: "main",
        title: "[cpb] exact PR generation",
        body: "Exact body\n",
        draft: true,
        eventJobId: "job-origin",
      },
    },
  };
  record.finalizationId = finalizerJournalFinalizationId(record);
  return record;
}

function verificationBinding(record: FinalizerJournalRecord) {
  return {
    repository: record.repository,
    repositoryId: "repository-node-id",
    issueNumber: record.issueNumber,
    capabilityDigest: record.capabilityDigest,
  };
}

test("finalizer journal key is stable across worker attempt job ids", () => {
  const first = finalizerJournalJobId("flow", "entry-stable");
  const retry = finalizerJournalJobId("flow", "entry-stable");
  assert.equal(first, retry);
  assert.notEqual(first, finalizerJournalJobId("flow", "entry-other"));
  assert.doesNotMatch(first, /job-a1|job-a2/);
});

test("finalizer journal CAS permits exactly one fenced takeover", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-finalizer-journal-"));
  const dataRoot = path.join(cpbRoot, "data");
  const leaseContexts: Record<string, unknown>[] = [];
  const assertMutationLease = async (context: Record<string, unknown>) => {
    leaseContexts.push(context);
    return true;
  };
  try {
    let snapshot = await readFinalizerJournal(cpbRoot, "flow", "entry-stable", { dataRoot });
    const initial = initialRecord();
    await assert.rejects(
      () => appendFinalizerJournal(cpbRoot, "flow", "entry-stable", {
        ...initial,
        claim: {
          ...initial.claim,
          takeover: {
            kind: "owner-dead",
            previousClaimId: "8".repeat(64),
            evidenceId: "9".repeat(64),
            observedAt: "2026-07-22T00:00:00.000Z",
          },
        },
      }, {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
      }),
      /not the next generation/,
    );
    await assert.rejects(
      () => appendFinalizerJournal(cpbRoot, "flow", "entry-stable", {
        ...initial,
        claim: {
          ...initial.claim,
          claimId: finalizerJournalClaimId({
            finalizationId: initial.finalizationId,
            ownerDigest: String(initial.claim.ownerDigest),
            claimGeneration: 2,
          }),
          claimGeneration: 2,
          takeover: {
            kind: "owner-dead",
            previousClaimId: "8".repeat(64),
            evidenceId: "9".repeat(64),
            observedAt: "2026-07-22T00:00:00.000Z",
          },
        },
      }, {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
      }),
      /not the next generation/,
    );
    snapshot = await appendFinalizerJournal(cpbRoot, "flow", "entry-stable", initial, {
      dataRoot,
      expected: snapshot,
      assertMutationLease,
    });
    assert.equal(snapshot.record?.generation, 1);
    assert.equal(snapshot.record?.principal.authorId, "91");

    await assert.rejects(
      () => appendFinalizerJournal(cpbRoot, "flow", "entry-stable", {
        ...initial,
        generation: 2,
        claim: {
          claimId: initial.claim.claimId,
          claimGeneration: 2,
          ownerDigest: "8".repeat(64),
          takeover: {
            kind: "explicit-handoff",
            previousClaimId: initial.claim.claimId,
            evidenceId: "a".repeat(64),
            observedAt: "2026-07-22T00:00:00.000Z",
          },
        },
      }, {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
      }),
      /invalid finalizer journal candidate/,
    );

    const contender = (owner: string, evidenceId: string): FinalizerJournalRecord => {
      const ownerDigest = owner.repeat(64);
      const claimGeneration = 2;
      return {
        ...initial,
        generation: 2,
        claim: {
          claimId: finalizerJournalClaimId({
            finalizationId: initial.finalizationId,
            ownerDigest,
            claimGeneration,
          }),
          claimGeneration,
          ownerDigest,
          takeover: {
            kind: "explicit-handoff",
            previousClaimId: initial.claim.claimId,
            evidenceId: evidenceId === "handoff-left" ? "a".repeat(64) : "b".repeat(64),
            observedAt: "2026-07-22T00:00:00.000Z",
          },
        },
      };
    };
    await assert.rejects(
      () => appendFinalizerJournal(cpbRoot, "flow", "entry-stable", {
        ...contender("7", "handoff-left"),
        stage: "repository.push.intent",
      }, {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
      }),
      /not the next generation/,
    );
    const [left, right] = await Promise.all([
      appendFinalizerJournal(cpbRoot, "flow", "entry-stable", contender("8", "handoff-left"), {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
      }),
      appendFinalizerJournal(cpbRoot, "flow", "entry-stable", contender("9", "handoff-right"), {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
      }),
    ]);
    const observed = await readFinalizerJournal(cpbRoot, "flow", "entry-stable", { dataRoot });
    assert.equal(observed.record?.generation, 2);
    assert.ok([
      finalizerJournalDigest(left.record),
      finalizerJournalDigest(right.record),
    ].includes(finalizerJournalDigest(observed.record)));
    assert.equal(
      [left, right].filter((candidate) => (
        finalizerJournalDigest(candidate.record) === finalizerJournalDigest(observed.record)
      )).length,
      2,
      "both callers must observe the single CAS winner instead of divergent claims",
    );
    assert.deepEqual(leaseContexts.map((context) => context.operation), [
      "journal.claim",
      "journal.claim",
      "journal.claim",
    ]);
    assert.deepEqual(leaseContexts.map((context) => context.originJobId), [
      "job-origin",
      "job-origin",
      "job-origin",
    ]);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("finalizer journal rejects receipt mutation and stage skipping", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-finalizer-transition-"));
  const dataRoot = path.join(cpbRoot, "data");
  const assertMutationLease = async () => true;
  try {
    let snapshot = await readFinalizerJournal(cpbRoot, "flow", "entry-stable", { dataRoot });
    const initial = initialRecord();
    snapshot = await appendFinalizerJournal(cpbRoot, "flow", "entry-stable", initial, {
      dataRoot,
      expected: snapshot,
      assertMutationLease,
    });
    await assert.rejects(
      () => appendFinalizerJournal(cpbRoot, "flow", "entry-stable", {
        ...initial,
        generation: 2,
        stage: "issue.close.intent",
      }, {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
      }),
      /not the next generation/,
    );

    const pushIntent: FinalizerJournalRecord = {
      ...initial,
      generation: 2,
      stage: "repository.push.intent",
    };
    snapshot = await appendFinalizerJournal(cpbRoot, "flow", "entry-stable", pushIntent, {
      dataRoot,
      expected: snapshot,
      assertMutationLease,
    });
    const pushReceipt = {
      operation: "repository.push",
      attempted: true,
      committed: true,
      observedAt: "2026-07-22T00:00:01.000Z",
      eventId: "a".repeat(64),
      repository: initial.repository,
      issueNumber: initial.issueNumber,
      commit: initial.commit,
      tree: initial.tree,
      targetBranch: initial.targetBranch,
      preRemoteHead: initial.preRemoteHead,
      verification: {
        operation: "repository.push",
        committed: true,
        principal: initial.principal,
        evidence: {
          repository: initial.repository,
          repositoryId: "repository-node-id",
          issueNumber: initial.issueNumber,
          capabilityDigest: initial.capabilityDigest,
          targetBranch: initial.targetBranch,
          expectedRef: "refs/heads/main",
          actualRef: "refs/heads/main",
          expectedCommit: initial.commit,
          actualCommit: initial.commit,
        },
      },
    };
    const invalidPushReceipts = [
      { ...pushReceipt, targetBranch: "attacker" },
      { ...pushReceipt, verification: { ...pushReceipt.verification, evidence: null } },
      {
        ...pushReceipt,
        verification: {
          ...pushReceipt.verification,
          principal: { ...initial.principal, stableId: "attacker" },
        },
      },
      {
        ...pushReceipt,
        verification: {
          ...pushReceipt.verification,
          evidence: { ...pushReceipt.verification.evidence, repository: "attacker/foreign" },
        },
      },
      {
        ...pushReceipt,
        verification: {
          ...pushReceipt.verification,
          evidence: { ...pushReceipt.verification.evidence, capabilityDigest: "f".repeat(64) },
        },
      },
      {
        ...pushReceipt,
        verification: {
          ...pushReceipt.verification,
          evidence: { ...pushReceipt.verification.evidence, actualRef: "refs/heads/attacker" },
        },
      },
    ];
    for (const invalidPush of invalidPushReceipts) {
      await assert.rejects(
        () => appendFinalizerJournal(cpbRoot, "flow", "entry-stable", {
          ...pushIntent,
          generation: 3,
          stage: "repository.push.receipt",
          receipts: { push: invalidPush },
        }, {
          dataRoot,
          expected: snapshot,
          assertMutationLease,
        }),
        /not the next generation/,
      );
    }
    snapshot = await appendFinalizerJournal(cpbRoot, "flow", "entry-stable", {
      ...pushIntent,
      generation: 3,
      stage: "repository.push.receipt",
      receipts: { push: pushReceipt },
    }, {
      dataRoot,
      expected: snapshot,
      assertMutationLease,
    });
    await assert.rejects(
      () => appendFinalizerJournal(cpbRoot, "flow", "entry-stable", {
        ...pushIntent,
        generation: 4,
        stage: "issue.close.intent",
        receipts: {},
      }, {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
      }),
      /not the next generation/,
    );
    const issueCloseIntent: FinalizerJournalRecord = {
      ...initial,
      generation: 4,
      stage: "issue.close.intent",
      receipts: { push: pushReceipt },
    };
    snapshot = await appendFinalizerJournal(cpbRoot, "flow", "entry-stable", issueCloseIntent, {
      dataRoot,
      expected: snapshot,
      assertMutationLease,
    });
    const issueClose = {
      operation: "issue.close",
      attempted: true,
      committed: true,
      observedAt: "2026-07-22T00:00:02.000Z",
      eventId: "b".repeat(64),
      repository: initial.repository,
      issueNumber: initial.issueNumber,
      commit: initial.commit,
      verification: {
        operation: "issue.close",
        committed: true,
        principal: initial.principal,
        evidence: {
          ...verificationBinding(initial),
          number: initial.issueNumber,
          state: "OPEN",
          url: `https://github.com/${initial.repository}/issues/${initial.issueNumber}`,
        },
      },
    };
    await assert.rejects(
      () => appendFinalizerJournal(cpbRoot, "flow", "entry-stable", {
        ...issueCloseIntent,
        generation: 5,
        stage: "issue.close.receipt",
        receipts: { push: pushReceipt, issueClose },
      }, {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
      }),
      /not the next generation/,
    );
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

for (const failurePoint of ["file", "parent"] as const) {
  test(`finalizer journal fails closed when ${failurePoint} durability is ambiguous`, async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), `cpb-finalizer-journal-${failurePoint}-`));
    const dataRoot = path.join(cpbRoot, "data");
    try {
      const snapshot = await readFinalizerJournal(cpbRoot, "flow", "entry-stable", { dataRoot });
      const injected = Object.assign(new Error(`injected ${failurePoint} sync failure`), { code: "EIO" });
      await assert.rejects(
        withEventLockTestHooksForTests(
          failurePoint === "file"
            ? {
                beforeEventFileSync: ({ operation }) => {
                  if (operation === "append") throw injected;
                },
              }
            : { beforeEventParentSync: () => { throw injected; } },
          () => appendFinalizerJournal(cpbRoot, "flow", "entry-stable", initialRecord(), {
            dataRoot,
            expected: snapshot,
            assertMutationLease: async () => true,
          }),
        ),
        (error: Error & { code?: string; committed?: boolean | null }) => {
          assert.equal(error.code, "EVENT_APPEND_DURABILITY_AMBIGUOUS");
          assert.equal(error.committed, null);
          return true;
        },
      );
      const readableButUnauthoritative = await readFinalizerJournal(cpbRoot, "flow", "entry-stable", { dataRoot });
      assert.equal(readableButUnauthoritative.record?.generation, 1);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
}

test("finalizer PR event receipt requires one exact origin-stream event and its prefix cursor", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-finalizer-pr-event-"));
  const dataRoot = path.join(cpbRoot, "data");
  const record = prInitialRecord();
  const plan = record.receipts.prPlan as Record<string, unknown>;
  const prNumber = 23;
  const prUrl = `${`https://github.com/${record.repository}`}/pull/${prNumber}`;
  const eventId = finalizerJournalPrEventId(record.finalizationId);
  const assertMutationLease = async () => true;
  try {
    let snapshot = await readFinalizerJournal(cpbRoot, record.project, record.entryId, { dataRoot });
    const append = async (next: FinalizerJournalRecord) => {
      snapshot = await appendFinalizerJournal(cpbRoot, record.project, record.entryId, next, {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
      });
    };
    await append(record);
    const branchIntent = {
      operation: "repository.push",
      repository: record.repository,
      issueNumber: record.issueNumber,
      commit: record.commit,
      targetBranch: record.targetBranch,
      pullRequestPlan: plan,
    };
    await append({
      ...record,
      generation: 2,
      stage: "pull_request.push.intent",
      receipts: { ...record.receipts, branchPushIntent: branchIntent },
    });
    const branchPush = {
      operation: "pull_request.push",
      attempted: true,
      committed: true,
      observedAt: "2026-07-22T00:00:01.000Z",
      eventId: "8".repeat(64),
      repository: record.repository,
      issueNumber: record.issueNumber,
      commit: record.commit,
      tree: record.tree,
      targetBranch: record.targetBranch,
      preRemoteHead: null,
      verification: {
        operation: "repository.push",
        committed: true,
        principal: record.principal,
        evidence: {
          ...verificationBinding(record),
          targetBranch: record.targetBranch,
          expectedRef: `refs/heads/${record.targetBranch}`,
          actualRef: `refs/heads/${record.targetBranch}`,
          expectedCommit: record.commit,
          actualCommit: record.commit,
        },
      },
    };
    await append({
      ...record,
      generation: 3,
      stage: "pull_request.push.receipt",
      receipts: { ...record.receipts, branchPushIntent: branchIntent, branchPush },
    });
    const pullRequestCreateIntent = {
      operation: "pull_request.create",
      repository: record.repository,
      issueNumber: record.issueNumber,
      headBranch: record.targetBranch,
      baseBranch: record.source.branch,
      commit: record.commit,
      title: plan.title,
      body: plan.body,
      draft: true,
      authorLogin: record.principal.login,
      authorId: record.principal.authorId,
    };
    await append({
      ...record,
      generation: 4,
      stage: "pull_request.create.intent",
      receipts: {
        ...record.receipts,
        branchPushIntent: branchIntent,
        branchPush,
        pullRequestCreateIntent,
      },
    });
    const pullRequestCreate = {
      operation: "pull_request.create",
      attempted: true,
      committed: true,
      observedAt: "2026-07-22T00:00:02.000Z",
      eventId: "9".repeat(64),
      ...pullRequestCreateIntent,
      prUrl,
      prNumber,
      verification: {
        operation: "pull_request.create",
        committed: true,
        principal: record.principal,
        evidence: {
          ...verificationBinding(record),
          matchCount: 1,
          pullRequest: {
            number: prNumber,
            state: "OPEN",
            draft: true,
            title: plan.title,
            bodyMatches: true,
            bodyLength: String(plan.body).length,
            url: prUrl,
            authorLogin: record.principal.login,
            authorId: record.principal.authorId,
            headBranch: record.targetBranch,
            headSha: record.commit,
            headRepository: record.repository,
            baseBranch: record.source.branch,
            baseRepository: record.repository,
            exactGeneration: true,
          },
        },
      },
    };
    await append({
      ...record,
      generation: 5,
      stage: "pull_request.create.receipt",
      receipts: {
        ...record.receipts,
        branchPushIntent: branchIntent,
        branchPush,
        pullRequestCreateIntent,
        pullRequestCreate,
      },
    });
    const prEventIntent = { jobId: record.originJobId, prUrl, prNumber, eventId };
    await append({
      ...record,
      generation: 6,
      stage: "pr_opened.publish.intent",
      receipts: {
        ...record.receipts,
        branchPushIntent: branchIntent,
        branchPush,
        pullRequestCreateIntent,
        pullRequestCreate,
        prEventIntent,
      },
    });
    const exactEvent = {
      type: "pr_opened",
      project: record.project,
      jobId: record.originJobId,
      finalizationId: record.finalizationId,
      eventId,
      prUrl,
      prNumber,
      ts: "2026-07-22T00:00:03.000Z",
    };
    await appendEvent(cpbRoot, record.project, record.originJobId, exactEvent, { dataRoot });
    const originEvents = await readEvents(cpbRoot, record.project, record.originJobId, { dataRoot });
    const prEvent = {
      operation: "pr_opened.publish",
      attempted: true,
      committed: true,
      observedAt: "2026-07-22T00:00:04.000Z",
      eventId,
      jobId: record.originJobId,
      finalizationId: record.finalizationId,
      prUrl,
      prNumber,
      eventRecordDigest: finalizerJournalDigest({
        type: "pr_opened",
        project: record.project,
        jobId: record.originJobId,
        finalizationId: record.finalizationId,
        eventId,
        prUrl,
        prNumber,
      }),
      eventStreamCursor: eventStreamCursorForRecords(originEvents),
    };
    await append({
      ...record,
      generation: 7,
      stage: "pr_opened.publish.receipt",
      receipts: {
        ...record.receipts,
        branchPushIntent: branchIntent,
        branchPush,
        pullRequestCreateIntent,
        pullRequestCreate,
        prEventIntent,
        prEvent,
      },
    });
    assert.equal(snapshot.invalidReason, null);
    assert.equal(snapshot.record?.stage, "pr_opened.publish.receipt");

    await appendEvent(cpbRoot, record.project, record.originJobId, {
      ...exactEvent,
      prUrl: `${prUrl}?conflict=1`,
      ts: "2026-07-22T00:00:05.000Z",
    }, { dataRoot });
    const invalid = await readFinalizerJournal(cpbRoot, record.project, record.entryId, { dataRoot });
    assert.equal(invalid.record, null);
    assert.match(String(invalid.invalidReason), /one exact bound event/);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});
